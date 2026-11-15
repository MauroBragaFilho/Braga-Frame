'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { WaveformService, slicePeaks, poolMax, encode, decode, sanitizeHint, MASTER_PPS, MAX_HINT_SEC } = require('../src/core/review/waveform');

const real = locateTools();
const skip = !real.ffmpeg ? 'ffmpeg não encontrado' : false;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-review-wf-')); }

/**
 * Vídeo de verdade (MP4 H.264 + AAC) cujo áudio é silêncio com dois "bipes" de 1 kHz em instantes
 * conhecidos: de 2,0 a 2,5 s e de 7,0 a 8,0 s (amplitude 0,8: o gerador `sine` sai em 1/8, daí o ganho 6,4). Duração 12 s.
 */
function makeBeepVideo(file, { audio = true } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=12'];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=12', '-af', "volume='6.4*(between(t,2,2.5)+between(t,7,8))':eval=frame", '-c:a', 'aac');
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-shortest', file);
  execFileSync(real.ffmpeg, args, { windowsHide: true });
}

/**
 * Vídeo de 10 s cujo ÁUDIO só começa em ~2,976 s (start_time do stream, como numa gravação com o áudio atrasado) e dura ~1,02 s:
 * no player o som está em ~3,0 a ~4,0 s. O PCM do ffmpeg, sozinho, começaria na primeira amostra (em 0 s).
 */
function makeDelayedAudioVideo(file) {
  execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=10',
    '-itsoffset', '3', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=1', '-af', 'volume=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { windowsHide: true });
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

test('slicePeaks: reduz por máximo, respeita o trecho e nunca passa do que existe', () => {
  const peaks = new Uint8Array(1000); // 10 s a 100 picos/s
  peaks[250] = 200; peaks[251] = 50;
  const all = slicePeaks({ peaks, pps: 100 }, 10);
  assert.equal(all.buckets, 10);
  assert.equal(all.peaks[2], 200, 'o pico de 2,5 s cai na coluna de 2 a 3 s');
  assert.equal(all.peaks[0], 0);
  assert.ok(Math.abs(all.secPerBucket - 1) < 1e-9);
  const part = slicePeaks({ peaks, pps: 100 }, 5, 2, 3);
  assert.deepEqual([part.start, part.end, part.buckets], [2, 3, 5]);
  assert.equal(Math.max(...part.peaks), 200);
  // mais colunas do que amostras: devolve só as que existem
  assert.equal(slicePeaks({ peaks, pps: 100 }, 5000).buckets, 1000);
  // fora do áudio: vazio, sem erro
  assert.deepEqual(slicePeaks({ peaks, pps: 100 }, 10, 50, 60).peaks, []);
  assert.equal(slicePeaks({ peaks: new Uint8Array(0), pps: 100 }, 10).buckets, 0);
});

test('poolMax, encode e decode do cache binário', () => {
  const pooled = poolMax(Uint8Array.from([1, 9, 3, 4, 2, 8, 7]), 3);
  assert.deepEqual([...pooled], [9, 8, 7]);
  const buf = encode(Uint8Array.from([5, 6, 7]), 33.3);
  const back = decode(buf);
  assert.deepEqual([back.pps, [...back.peaks]], [33.3, [5, 6, 7]]);
  assert.equal(decode(buf.subarray(0, buf.length - 1)), null, 'truncado');
  assert.equal(decode(Buffer.from('lixo')), null);
  const wrong = Buffer.from(buf); wrong.write('XXXX', 0, 'ascii');
  assert.equal(decode(wrong), null, 'assinatura errada');
});

test('forma de onda REAL: os picos aparecem nos instantes exatos do áudio sintético', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'bipes.mp4');
    makeBeepVideo(video);
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir: path.join(dir, 'cache') });
    const progress = [];
    const res = await svc.peaks({ sourcePath: video, buckets: 120, durationHint: 12, onProgress: (p) => progress.push(p) });
    assert.ok(Math.abs(res.duration - 12) < 0.2, `duração do áudio ${res.duration}`);
    assert.equal(res.cached, false);
    assert.equal(res.partial, false);
    assert.equal(res.buckets, 120);
    const at = (t0, t1) => res.peaks.slice(Math.round(t0 * 10), Math.round(t1 * 10));
    // bipes: 2,0-2,5 s e 7,0-8,0 s (com folga de uma coluna de 0,1 s por causa do codec)
    assert.ok(avg(at(2.1, 2.4)) > 160, `bipe 1: ${avg(at(2.1, 2.4))}`);
    assert.ok(avg(at(7.1, 7.9)) > 160, `bipe 2: ${avg(at(7.1, 7.9))}`);
    // silêncio entre eles e depois
    assert.ok(Math.max(...at(0.2, 1.8)) < 12, `silêncio inicial: ${Math.max(...at(0.2, 1.8))}`);
    assert.ok(Math.max(...at(3.2, 6.8)) < 12, `silêncio do meio: ${Math.max(...at(3.2, 6.8))}`);
    assert.ok(Math.max(...at(8.6, 11.6)) < 12, `silêncio final: ${Math.max(...at(8.6, 11.6))}`);
    assert.ok(progress.length > 0 && progress.at(-1) === 1 && progress.every((p) => p >= 0 && p <= 1));

    // zoom: o mesmo bipe visto de perto (1,9 a 2,6 s em 70 colunas de 10 ms)
    const zoom = await svc.peaks({ sourcePath: video, buckets: 70, start: 1.9, end: 2.6 });
    assert.equal(zoom.cached, true, 'segunda leitura vem do cache, sem rodar o ffmpeg de novo');
    assert.deepEqual([zoom.start, zoom.end], [1.9, 2.6]);
    const rise = zoom.peaks.findIndex((v) => v > 100);
    const fall = zoom.peaks.length - 1 - [...zoom.peaks].reverse().findIndex((v) => v > 100);
    assert.ok(Math.abs(1.9 + rise * 0.01 - 2.0) < 0.08, `início do bipe em ${1.9 + rise * 0.01}`);
    assert.ok(Math.abs(1.9 + (fall + 1) * 0.01 - 2.5) < 0.08, `fim do bipe em ${1.9 + (fall + 1) * 0.01}`);

    // o cache está no disco, no formato do app, e sobrevive a um serviço novo
    const files = fs.readdirSync(path.join(dir, 'cache')).filter((f) => f.endsWith('.bfwf'));
    assert.equal(files.length, 1);
    assert.ok(!fs.readdirSync(path.join(dir, 'cache')).some((f) => f.endsWith('.tmp')));
    const again = await new WaveformService({ getFfmpeg: () => null, cacheDir: path.join(dir, 'cache') }).peaks({ sourcePath: video, buckets: 120 });
    assert.equal(again.cached, true, 'com o cache, nem precisa de ffmpeg');
    assert.deepEqual(again.peaks, res.peaks);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('áudio que começa depois do vídeo: a onda cai no eixo do player (o começo vira silêncio), não adiantada pelo atraso', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'atrasado.mp4');
    makeDelayedAudioVideo(video);
    const start = Number(execFileSync(real.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=start_time', '-of', 'csv=p=0', video], { encoding: 'utf8', windowsHide: true }).trim());
    assert.ok(start > 2.9 && start < 3.1, `o arquivo de teste tem áudio atrasado (start_time ${start})`);
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir: path.join(dir, 'cache') });
    const res = await svc.peaks({ sourcePath: video, buckets: 100, durationHint: 10 });
    const loud = res.peaks.map((v, i) => [v, res.start + i * res.secPerBucket]).filter(([v]) => v > 100);
    assert.ok(loud.length > 0, 'achou o trecho alto');
    const first = loud[0][1];
    const last = loud.at(-1)[1] + res.secPerBucket;
    assert.ok(Math.abs(first - start) < 0.1, `o som começa em ${first.toFixed(3)} s (no player: ${start.toFixed(3)} s)`);
    assert.ok(Math.abs(last - (start + 1.02)) < 0.12, `e termina em ${last.toFixed(3)} s`);
    assert.ok(Math.max(...res.peaks.slice(0, Math.floor(2.5 / res.secPerBucket))) < 12, 'o começo, antes do áudio, é silêncio');
    assert.ok(res.duration > 3.9, `a onda cobre o atraso (${res.duration} s)`);
    // o cache guarda a onda já alinhada
    const again = await new WaveformService({ getFfmpeg: () => null, cacheDir: path.join(dir, 'cache') }).peaks({ sourcePath: video, buckets: 100 });
    assert.equal(again.cached, true);
    assert.deepEqual(again.peaks, res.peaks);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('durationHint absurdo (cabeçalho de duração corrompido) é ignorado: nada de RangeError nem de ffmpeg órfão', { skip }, async () => {
  assert.equal(sanitizeHint(12.5), 12.5);
  for (const bad of [1e13, -3, 0, NaN, Infinity, 'abc', null, undefined, MAX_HINT_SEC + 1]) assert.equal(sanitizeHint(bad), undefined, String(bad));
  assert.equal(sanitizeHint(MAX_HINT_SEC), MAX_HINT_SEC);
  const dir = tmp();
  try {
    const video = path.join(dir, 'bipes.mp4');
    makeBeepVideo(video);
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir: path.join(dir, 'cache') });
    const progress = [];
    const huge = await svc.peaks({ sourcePath: video, buckets: 120, durationHint: 1e13, onProgress: (p) => progress.push(p) });
    assert.ok(Math.abs(huge.duration - 12) < 0.2);
    assert.ok(Math.max(...huge.peaks.slice(21, 25)) > 160, 'o bipe de 2 s está lá');
    assert.ok(progress.every((p) => p >= 0 && p <= 1), 'o progresso não usa a dica absurda');
    assert.equal(svc.inflight.size, 0, 'o cálculo terminou e saiu da lista (o filho do ffmpeg foi até o fim)');
    // mesmo resultado sem dica nenhuma
    fs.rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'cache'));
    const plain = await svc.peaks({ sourcePath: video, buckets: 120 });
    assert.deepEqual(huge.peaks, plain.peaks);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache de formato antigo (sem o alinhamento do áudio) é descartado e refeito', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'v.mp4');
    makeBeepVideo(video);
    const cacheDir = path.join(dir, 'cache');
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir });
    await svc.peaks({ sourcePath: video, buckets: 10 });
    const [file] = fs.readdirSync(cacheDir);
    const old = fs.readFileSync(path.join(cacheDir, file));
    old.write('BFW1', 0, 'ascii'); // como era antes: mesma estrutura, outra assinatura
    fs.writeFileSync(path.join(cacheDir, file), old);
    assert.equal(decode(old), null);
    const redo = await svc.peaks({ sourcePath: video, buckets: 10 });
    assert.equal(redo.cached, false, 'o cache antigo não vale: o áudio pode ter ficado sem o alinhamento');
    assert.equal(fs.readFileSync(path.join(cacheDir, file)).toString('ascii', 0, 4), 'BFW2');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cache corrompido é refeito; mudar o vídeo gera outro cache', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'v.mp4');
    makeBeepVideo(video);
    const cacheDir = path.join(dir, 'cache');
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir });
    await svc.peaks({ sourcePath: video, buckets: 10 });
    const [file] = fs.readdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, file), 'estragado');
    const redo = await svc.peaks({ sourcePath: video, buckets: 10 });
    assert.equal(redo.cached, false);
    assert.ok(Math.max(...redo.peaks) > 100);
    // outro conteúdo no mesmo caminho: chave diferente
    fs.writeFileSync(video, 'x');
    const other = path.join(dir, 'w.mp4');
    makeBeepVideo(other);
    fs.copyFileSync(other, video);
    fs.utimesSync(video, new Date(), new Date(Date.now() + 5000));
    await svc.peaks({ sourcePath: video, buckets: 10 });
    assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.bfwf')).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('erros claros: sem áudio, arquivo ausente, sem ffmpeg', { skip }, async () => {
  const dir = tmp();
  try {
    const mute = path.join(dir, 'mudo.mp4');
    makeBeepVideo(mute, { audio: false });
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir: path.join(dir, 'cache') });
    await assert.rejects(svc.peaks({ sourcePath: mute, buckets: 10 }), (err) => err.code === 'NO_AUDIO' && /não tem faixa de áudio/.test(err.message) && /continua funcionando/.test(err.message));
    await assert.rejects(svc.peaks({ sourcePath: path.join(dir, 'nao-existe.mp4'), buckets: 10 }), (err) => err.code === 'INPUT_MISSING' && /não foi encontrado/.test(err.message));
    const noTool = new WaveformService({ getFfmpeg: () => null, cacheDir: path.join(dir, 'cache2') });
    await assert.rejects(noTool.peaks({ sourcePath: mute, buckets: 10 }), (err) => err.code === 'NO_FFMPEG' && /Instale o FFmpeg/.test(err.message));
    const garbage = path.join(dir, 'texto.mp4');
    fs.writeFileSync(garbage, 'isto não é um vídeo');
    await assert.rejects(svc.peaks({ sourcePath: garbage, buckets: 10 }), (err) => ['WAVEFORM_FAILED', 'NO_AUDIO'].includes(err.code));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'cache')).filter((f) => f.endsWith('.bfwf')), [], 'falha não deixa cache');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cancelar mata o ffmpeg e quem esperava recebe CANCELLED; pedidos iguais dividem o mesmo cálculo', { skip }, async () => {
  const dir = tmp();
  try {
    const video = path.join(dir, 'longo.mp4');
    makeBeepVideo(video);
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir: path.join(dir, 'cache') });
    const waiting = svc.peaks({ sourcePath: video, buckets: 10 });
    const second = svc.peaks({ sourcePath: video, buckets: 20 });
    assert.equal(svc.inflight.size, 1, 'um só cálculo para os dois pedidos');
    assert.equal(svc.cancel(video), true);
    await assert.rejects(waiting, (err) => err.code === 'CANCELLED');
    await assert.rejects(second, (err) => err.code === 'CANCELLED');
    assert.equal(svc.inflight.size, 0);
    assert.equal(svc.cancel(video), false);
    // depois de cancelar, dá para pedir de novo
    const ok = await svc.peaks({ sourcePath: video, buckets: 10 });
    assert.ok(ok.buckets > 0);
    // dois pedidos juntos que terminam: mesmo resultado
    const [x, y] = await Promise.all([svc.peaks({ sourcePath: video, buckets: 5 }), svc.peaks({ sourcePath: video, buckets: 5 })]);
    assert.deepEqual(x.peaks, y.peaks);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('o cache do app é podado (guarda só os mais recentes)', { skip }, async () => {
  const dir = tmp();
  try {
    const cacheDir = path.join(dir, 'cache');
    const svc = new WaveformService({ getFfmpeg: () => real.ffmpeg, cacheDir, maxCacheFiles: 2 });
    for (let i = 0; i < 3; i++) {
      const file = path.join(dir, `v${i}.mp4`);
      makeBeepVideo(file);
      await svc.peaks({ sourcePath: file, buckets: 5 });
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.bfwf')).length, 2);
    assert.equal(MASTER_PPS, 100);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
