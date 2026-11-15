'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { probeMedia, scanDuration, explainFailure, declaredDuration } = require('../src/core/ffmpeg/probe');

const real = locateTools();
const skip = !real.ffmpeg || !real.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bf-probe-')); }
function makeVideo(file, seconds = 6) {
  execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=10:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-shortest', '-pix_fmt', 'yuv420p', file], { windowsHide: true });
}
/** Matroska/WebM escrito em "pipe": o cabeçalho fica sem a duração (como uma gravação que nunca foi finalizada). */
function makeStreamed(source, file, container) {
  const codec = container === 'webm' ? ['-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libvorbis'] : ['-c', 'copy'];
  const out = execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', source, ...codec, '-f', container, 'pipe:1'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  fs.writeFileSync(file, out);
}

const NO_LEAK = /Command failed|ffprobe(\.exe)?\s+-v|moov atom|Invalid data|No such file|Permission denied|\bwhile\b|\bfound\b|\.mp4/i;

test('explainFailure: cada causa vira português com solução, sem linha de comando, e o texto cru fica em details.raw', () => {
  const stderr = (text) => Object.assign(new Error('Command failed: C:\\x\\ffprobe.exe -v error ... \n' + text), { stderr: text });
  const cases = [
    [stderr('[mov,mp4 @ 000001] moov atom not found\nC:\\v\\a.mp4: Invalid data found when processing input\n'), /não parece ser um vídeo válido ou está incompleto.*Espere a gravação ou o download terminar/s],
    [stderr('C:\\v\\pasta.mp4: Permission denied\n'), /pasta ou o acesso foi negado.*permissão/s],
    [stderr('C:\\v\\sumiu.mp4: No such file or directory\n'), /não foi encontrado.*movido, renomeado ou apagado/s],
    [Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }), /não foi possível executar o ffprobe.*Verificar de novo/s],
    [Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }), /demorou mais de 30 s.*tente de novo/s],
    [stderr('algo que nunca vimos\n'), /ffprobe não reconheceu o conteúdo.*tente de novo/s],
    [new SyntaxError('Unexpected token v in JSON'), /ffprobe não reconheceu o conteúdo/]
  ];
  for (const [err, expected] of cases) {
    const e = explainFailure(err);
    assert.equal(e.code, 'PROBE_FAILED');
    assert.match(e.message, /^Não foi possível ler o vídeo: /);
    assert.match(e.message, expected);
    assert.doesNotMatch(e.message, NO_LEAK, `vazou texto técnico: ${e.message}`);
    assert.equal(typeof e.details.raw, 'string');
  }
  assert.match(explainFailure(stderr('C:\\v\\a.mp4: Invalid data found\n')).details.raw, /Invalid data found/);
});

test('declaredDuration: contêiner, depois fluxos (campo ou tag DURATION), senão desconhecida', () => {
  assert.deepEqual(declaredDuration({ format: { duration: '12.5' }, streams: [] }), { seconds: 12.5, source: 'format' });
  assert.deepEqual(declaredDuration({ format: { duration: 'N/A' }, streams: [{ duration: '8.2' }, { duration: '9.75' }] }), { seconds: 9.75, source: 'stream' });
  assert.deepEqual(declaredDuration({ format: {}, streams: [{ tags: { DURATION: '00:01:02.500000000' } }] }), { seconds: 62.5, source: 'stream' });
  assert.deepEqual(declaredDuration({ format: {}, streams: [{}] }), { seconds: 0, source: 'unknown' });
  assert.deepEqual(declaredDuration({ format: { duration: 'N/A' } }), { seconds: 0, source: 'unknown' });
});

test('ffprobe que devolve lixo vira erro em português (nada de SyntaxError cru)', async () => {
  // o próprio node.exe como "ffprobe": responde "-v" imprimindo a versão, que não é JSON
  await assert.rejects(() => probeMedia(process.execPath, __filename), (err) => {
    assert.equal(err.code, 'PROBE_FAILED');
    assert.match(err.message, /^Não foi possível ler o vídeo: /);
    assert.doesNotMatch(err.message, /JSON|Unexpected/);
    return true;
  });
  await assert.rejects(() => probeMedia(path.join(os.tmpdir(), 'nao-existe', 'ffprobe.exe'), __filename), (err) => {
    assert.equal(err.code, 'PROBE_FAILED');
    assert.match(err.message, /não foi possível executar o ffprobe/);
    return true;
  });
});

test('arquivos inválidos: vazio, texto, mp4 truncado, pasta e inexistente dão causa e solução, nunca a linha de comando', { skip }, async () => {
  const dir = tmp();
  try {
    const good = path.join(dir, 'ok.mp4');
    makeVideo(good);
    const files = {
      vazio: [path.join(dir, 'vazio.mp4'), () => fs.writeFileSync(path.join(dir, 'vazio.mp4'), ''), /não parece ser um vídeo válido ou está incompleto/],
      texto: [path.join(dir, 'texto.mp4'), () => fs.writeFileSync(path.join(dir, 'texto.mp4'), 'isto não é um vídeo'), /não parece ser um vídeo válido ou está incompleto/],
      truncado: [path.join(dir, 'truncado.mp4'), () => fs.writeFileSync(path.join(dir, 'truncado.mp4'), fs.readFileSync(good).subarray(0, 4000)), /incompleto.*gravação que ainda não terminou/s],
      pasta: [path.join(dir, 'pasta.mp4'), () => fs.mkdirSync(path.join(dir, 'pasta.mp4')), /pasta ou o acesso foi negado/],
      inexistente: [path.join(dir, 'sumiu.mp4'), () => {}, /não foi encontrado/]
    };
    for (const [name, [file, make, expected]] of Object.entries(files)) {
      make();
      await assert.rejects(() => probeMedia(real.ffprobe, file), (err) => {
        assert.equal(err.code, 'PROBE_FAILED', name);
        assert.match(err.message, /^Não foi possível ler o vídeo: /, name);
        assert.match(err.message, expected, name);
        assert.doesNotMatch(err.message, NO_LEAK, `${name}: ${err.message}`);
        assert.ok(err.details && err.details.raw, `${name}: o texto técnico fica em details.raw`);
        return true;
      });
    }
    // áudio sem imagem
    const wav = path.join(dir, 'so-audio.wav');
    execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=2', wav], { windowsHide: true });
    await assert.rejects(() => probeMedia(real.ffprobe, wav), (err) => {
      assert.equal(err.code, 'NO_VIDEO');
      assert.match(err.message, /não contém vídeo.*Escolha um arquivo de vídeo/);
      return true;
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MKV e WebM sem duração no cabeçalho: a duração vem da leitura dos pacotes (antes ficava 0 e o vídeo era inutilizável)', { skip }, async () => {
  const dir = tmp();
  try {
    const good = path.join(dir, 'ok.mp4');
    makeVideo(good, 6);
    const mkv = path.join(dir, 'sem-duracao.mkv');
    const webm = path.join(dir, 'sem-duracao.webm');
    makeStreamed(good, mkv, 'matroska');
    makeStreamed(good, webm, 'webm');
    for (const file of [mkv, webm]) {
      const raw = JSON.parse(execFileSync(real.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', file], { encoding: 'utf8', windowsHide: true }));
      assert.ok(!(Number(raw.format.duration) > 0), `${path.basename(file)} deveria vir sem duração no cabeçalho (ffprobe: ${raw.format.duration})`);

      const without = await probeMedia(real.ffprobe, file, { scan: false });
      assert.deepEqual([without.duration, without.durationSource], [0, 'unknown'], 'sem a leitura dos pacotes continua desconhecida');

      const info = await probeMedia(real.ffprobe, file);
      assert.equal(info.durationSource, 'scan', path.basename(file));
      assert.ok(Math.abs(info.duration - 6) < 0.4, `${path.basename(file)}: duração ${info.duration}`);
      assert.deepEqual([info.width, info.height, info.hasAudio], [320, 180, true]);
    }
    // arquivo normal: duração do contêiner, sem ler o arquivo todo
    const normal = await probeMedia(real.ffprobe, good);
    assert.equal(normal.durationSource, 'format');
    assert.ok(Math.abs(normal.duration - 6) < 0.3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanDuration: tempo esgotado ou arquivo sem vídeo devolve 0 (desconhecida), e o resultado bom fica em memória', { skip }, async () => {
  const dir = tmp();
  try {
    const good = path.join(dir, 'ok.mp4');
    makeVideo(good, 5);
    const mkv = path.join(dir, 'a.mkv');
    makeStreamed(good, mkv, 'matroska');
    assert.equal(await scanDuration(real.ffprobe, mkv, { timeoutMs: 1 }), 0, 'prazo estourado: não chuta um valor parcial');
    const probed = await probeMedia(real.ffprobe, mkv, { scanTimeoutMs: 1 });
    assert.deepEqual([probed.duration, probed.durationSource], [0, 'unknown']);

    const first = await scanDuration(real.ffprobe, mkv);
    assert.ok(Math.abs(first - 5) < 0.4, `duração ${first}`);
    // segunda chamada: do cache (mesmo com um ffprobe que não existe, não executa nada)
    assert.equal(await scanDuration(path.join(dir, 'nao-existe.exe'), mkv), first);

    const wav = path.join(dir, 'so-audio.wav');
    execFileSync(real.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', wav], { windowsHide: true });
    assert.equal(await scanDuration(real.ffprobe, wav), 0, 'sem pacotes de vídeo');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
