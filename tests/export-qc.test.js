'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { preflight, plannedOutput } = require('../src/core/export/qc');
const { listBuiltinProfiles } = require('../src/core/export/profiles');
const encoders = require('../src/core/export/encoders');
const optional = require('../src/core/export/optional');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;
const VERTICAL = listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264');
const ALL_ENCODERS = new Set(['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc']);
const codes = (list) => list.map((x) => x.code).sort();

/** Fonte pequena de verdade no disco; o `sourceInfo` do Job (4K) é o que o QC usa para medir ampliação. */
async function withJob(fn) {
  const dir = fx.tmpDir('bf-export-qc-');
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 320, height: 180, fps: 5, seconds: 2 });
    const job = {
      id: 'j', sourcePath: src, sourceInfo: { width: 3840, height: 2160, fps: 30, duration: 600, hasAudio: true },
      cut: { id: 'c', title: 'Meu corte', start: 10, end: 40 }, profile: { ...VERTICAL }, framing: null,
      outputDir: path.join(dir, 'Cortes'), baseName: 'saida', onConflict: 'ask'
    };
    return await fn(job, dir);
  } finally { fx.cleanup(dir); }
}

const check = (job, extra = {}) => preflight(job, { tools, encoderNames: ALL_ENCODERS, ...extra });

test('trabalho sem problemas: nenhum erro e nenhum aviso (forma do relatório do contrato)', { skip: skipMedia }, () => withJob((job) => {
  const r = check(job);
  assert.deepEqual(r, { errors: [], warnings: [] });
  assert.ok(!fs.existsSync(job.outputDir), 'o QC não cria a pasta de destino');
  assert.deepEqual(fs.readdirSync(path.dirname(job.outputDir)).sort(), ['fonte.mp4'], 'nem deixa arquivos de teste');
}));

test('erros bloqueiam o trabalho e trazem causa e solução (código, mensagem e solução em texto)', { skip: skipMedia }, () => withJob((job, dir) => {
  const cases = [
    ['NO_FFMPEG', { ...job }, { tools: {} }],
    ['INVALID_PROFILE', { ...job, profile: { ...VERTICAL, width: 1081, bitrateKbps: 1 } }],
    ['INPUT_MISSING', { ...job, sourcePath: path.join(dir, 'sumiu.mp4') }],
    ['INPUT_MISSING', { ...job, sourcePath: dir }],
    ['INVALID_RANGE', { ...job, cut: { ...job.cut, start: 40, end: 10 } }],
    ['INVALID_RANGE', { ...job, cut: { ...job.cut, start: -1, end: 10 } }],
    ['INVALID_RANGE', { ...job, cut: { ...job.cut, start: 590, end: 700 } }],
    ['OUTPUT_NOT_WRITABLE', { ...job, outputDir: '' }],
    ['INVALID_JOB', null]
  ];
  for (const [code, j, extra] of cases) {
    const r = check(j, extra);
    const found = r.errors.find((e) => e.code === code);
    assert.ok(found, `${code}: ${JSON.stringify(r)}`);
    assert.ok(typeof found.message === 'string' && found.message.length > 15, `${code}: mensagem`);
    assert.ok(typeof found.solution === 'string' && found.solution.length > 15, `${code}: solução`);
  }
  // pasta de destino que é um arquivo
  fs.writeFileSync(path.join(dir, 'arquivo'), 'x');
  assert.ok(check({ ...job, outputDir: path.join(dir, 'arquivo', 'Cortes') }).errors.some((e) => e.code === 'OUTPUT_NOT_WRITABLE'));
  // o destino seria o próprio vídeo
  const same = check({ ...job, outputDir: dir, baseName: 'fonte' });
  assert.ok(same.errors.some((e) => e.code === 'OUTPUT_IS_SOURCE'));
}));

test('fim do corte depois do vídeo dá erro com os tempos; dentro da tolerância passa', { skip: skipMedia }, () => withJob((job) => {
  const bad = check({ ...job, cut: { ...job.cut, start: 595, end: 601 } });
  assert.match(bad.errors[0].message, /termina em 10:01\.0.*fim do vídeo \(10:00\.0\)/);
  assert.deepEqual(check({ ...job, cut: { ...job.cut, start: 595, end: 600.2 } }).errors, []);
}));

test('espaço em disco: erro só se claramente insuficiente; aviso quando está apertado (disco real e simulado)', { skip: skipMedia }, () => withJob((job) => {
  // 150 Mbps durante 1e7 s ≈ 190 TB: não cabe em disco nenhum
  const huge = check({ ...job, profile: { ...VERTICAL, bitrateKbps: 150000 }, sourceInfo: { ...job.sourceInfo, duration: 1e7 }, cut: { ...job.cut, start: 0, end: 1e7 } });
  const e = huge.errors.find((x) => x.code === 'NO_DISK_SPACE');
  assert.ok(e && /TB|GB/.test(e.message) && /Libere espaço/.test(e.solution), JSON.stringify(huge.errors));
  // simulado: 10 Mbps x 30 s ≈ 40 MB
  const need = ((10000 + 192) * 1000 / 8) * 30 * 1.05;
  assert.ok(check(job, { statfs: () => ({ bavail: Math.floor(need * 0.9), bsize: 1 }) }).errors.some((x) => x.code === 'NO_DISK_SPACE'));
  const tight = check(job, { statfs: () => ({ bavail: Math.floor(need * 1.2), bsize: 1 }) });
  assert.deepEqual(tight.errors, []);
  assert.deepEqual(codes(tight.warnings), ['LOW_DISK']);
  assert.deepEqual(check(job, { statfs: () => ({ bavail: Math.floor(need * 3), bsize: 1 }) }), { errors: [], warnings: [] });
  // sistema que não informa o espaço: não bloqueia
  assert.deepEqual(check(job, { statfs: () => { throw new Error('não suportado'); } }).errors, []);
}));

test('codec e codificador: erro se o FFmpeg não consegue gerar; aviso na queda do NVENC', { skip: skipMedia }, () => withJob(async (job) => {
  const noX265 = new Set(['libx264']);
  const h265 = { ...job, profile: { ...VERTICAL, codec: 'h265', encoder: 'software' } };
  const bad = check(h265, { encoderNames: noX265 });
  assert.equal(bad.errors[0].code, 'CODEC_UNSUPPORTED');
  assert.match(bad.errors[0].message, /libx265/);
  assert.match(bad.errors[0].solution, /build "full"/);
  assert.equal(check({ ...h265, profile: { ...h265.profile, encoder: 'auto' } }, { encoderNames: noX265 }).errors[0].code, 'CODEC_UNSUPPORTED');
  // auto com NVENC disponível mas sem software: segue
  assert.deepEqual(check({ ...h265, profile: { ...h265.profile, encoder: 'auto' } }, { encoderNames: new Set(['hevc_nvenc']) }).errors, []);
  // NVENC pedido e a detecção guardada diz que não funciona: aviso, não erro
  const cacheDir = path.join(path.dirname(job.outputDir), 'cache');
  try {
    encoders.configure({ cacheDir });
    encoders.resetCache();
    encoders.forgetMemory();
    await encoders.detectEncoders({ ffmpeg: tools.ffmpeg, force: true });
    const file = path.join(cacheDir, 'encoders.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [key] = Object.keys(data.entries);
    data.entries[key].nvenc.h264 = { available: false, reason: 'driver antigo' };
    fs.writeFileSync(file, JSON.stringify(data));
    encoders.forgetMemory();
    const r = check({ ...job, profile: { ...VERTICAL, encoder: 'nvenc' } });
    assert.deepEqual(r.errors, []);
    const w = r.warnings.find((x) => x.code === 'ENCODER_FALLBACK');
    assert.ok(w && /driver antigo/.test(w.message) && /software/.test(w.message));
  } finally {
    encoders.resetCache();
    encoders.configure({ cacheDir: null });
    encoders.forgetMemory();
  }
}));

test('avisos informativos: sem áudio, ampliação, H.265, bitrate, corte longo, resolução e nome repetido', { skip: skipMedia }, () => withJob((job) => {
  const info = (w, h, extra = {}) => ({ ...job.sourceInfo, width: w, height: h, ...extra });
  assert.deepEqual(codes(check({ ...job, sourceInfo: info(3840, 2160, { hasAudio: false }) }).warnings), ['NO_AUDIO']);

  const up = check({ ...job, sourceInfo: info(1280, 720) });
  assert.deepEqual(codes(up.warnings), ['UPSCALE']);
  assert.match(up.warnings[0].message, /1280×720.*ampliada 2,7×.*1080×1920/);
  // o enquadramento muda a conta: blur mostra a imagem inteira (não amplia); zoom amplia mais
  assert.deepEqual(check({ ...job, sourceInfo: info(1280, 720), framing: { mode: 'blur' } }).warnings, []);
  assert.deepEqual(codes(check({ ...job, sourceInfo: info(3840, 2160), framing: { zoom: 3 } }).warnings), ['UPSCALE']);
  // ajuste do próprio corte também entra na conta
  assert.deepEqual(codes(check({ ...job, sourceInfo: info(3840, 2160), cut: { ...job.cut, framing: { zoom: 3 } } }).warnings), ['UPSCALE']);

  const hevc = check({ ...job, profile: { ...VERTICAL, codec: 'h265' } });
  assert.deepEqual(codes(hevc.warnings), ['HEVC_COMPAT']);
  assert.equal(hevc.errors.length, 0, 'aviso nunca bloqueia');

  // bitrate: 10 Mbps é pouco para 4K H.264 vertical; 150 Mbps é demais para 1080p
  const p4k = listBuiltinProfiles().find((p) => p.id === 'vertical-2160-h264');
  const low = check({ ...job, profile: p4k }); // 9:16 em 4K a partir de uma fonte 16:9 de 4K também amplia (1,8x)
  assert.deepEqual(codes(low.warnings), ['BITRATE_LOW', 'UPSCALE']);
  assert.match(low.warnings.find((w) => w.code === 'BITRATE_LOW').message, /10 Mbps.*pelo menos \d+ Mbps/);
  assert.deepEqual(codes(check({ ...job, profile: { ...VERTICAL, bitrateKbps: 150000 } }).warnings), ['BITRATE_HIGH']);
  assert.deepEqual(check({ ...job, profile: { ...VERTICAL, bitrateKbps: 12000 } }).warnings, []);
  assert.deepEqual(codes(check({ ...job, profile: { ...VERTICAL, bitrateKbps: 10000, fps: 120 } }).warnings), ['BITRATE_LOW'], 'fps alto pede mais bitrate');

  const long = check({ ...job, cut: { ...job.cut, start: 0, end: 200 } });
  assert.deepEqual(codes(long.warnings), ['LONG_CUT']);
  assert.match(long.warnings[0].message, /3:20\.0.*3 minutos/);
  assert.deepEqual(check({ ...job, cut: { ...job.cut, start: 0, end: 180 } }).warnings, []);

  assert.deepEqual(codes(check({ ...job, profile: { ...VERTICAL, width: 4320, height: 7680, bitrateKbps: 100000 } }).warnings), ['RES_COMPAT', 'UPSCALE'].sort());
}));

test('nome conflitante é só um aviso informativo (a decisão é da fila); .part não conta como resultado', { skip: skipMedia }, () => withJob((job) => {
  fs.mkdirSync(job.outputDir, { recursive: true });
  assert.deepEqual(check(job).warnings, []);
  fs.writeFileSync(path.join(job.outputDir, 'saida.mp4.part'), 'x');
  assert.deepEqual(check(job).warnings, []);
  fs.writeFileSync(plannedOutput(job), 'x');
  const r = check(job);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(codes(r.warnings), ['NAME_CONFLICT']);
  assert.match(r.warnings[0].message, /saida\.mp4.*a fila vai perguntar/);
  // o nome é o que seria gravado de fato (caracteres proibidos trocados)
  assert.equal(path.basename(plannedOutput({ ...job, baseName: 'a:b' })), 'a_b.mp4');
}));

test('legendas e áudio: avisos dos módulos reais e dos módulos ausentes', { skip: skipMedia }, () => withJob((job) => {
  try {
    const realBurn = optional.burnIn();
    const withSub = { ...job, cut: { ...job.cut, subtitles: { enabled: true, mode: 'both', cues: [{ start: 1, end: 3, text: 'oi', needsReview: true }] } } };
    if (realBurn.module) {
      const r = check(withSub);
      assert.ok(r.warnings.some((w) => w.code === 'SUBTITLES_WARNING' && /revisão/.test(w.message)), JSON.stringify(r.warnings));
      assert.ok(!r.errors.some((e) => e.code === 'CODEC_UNSUPPORTED'), 'este ffmpeg tem libass');
    }
    optional._setOverrides({ burnIn: { module: { subtitleWarnings: () => [], detectBurnInSupport: () => ({ supported: false, reason: 'Sem libass.' }) } } });
    const noAss = check(withSub);
    assert.equal(noAss.errors[0].code, 'CODEC_UNSUPPORTED');
    assert.equal(noAss.errors[0].message, 'Sem libass.');
    assert.match(noAss.errors[0].solution, /arquivo separado/);
    const sidecarOnly = check({ ...withSub, cut: { ...withSub.cut, subtitles: { ...withSub.cut.subtitles, mode: 'sidecar' } } });
    assert.deepEqual(sidecarOnly.errors, [], 'legenda só em arquivo separado não precisa do libass');

    optional._setOverrides({ burnIn: { module: null }, audioFilter: { module: null } });
    const missing = check({ ...withSub, cut: { ...withSub.cut, audio: { gainDb: 3 } } });
    assert.deepEqual(codes(missing.warnings), ['AUDIO_UNAVAILABLE', 'SUBTITLES_UNAVAILABLE']);
    assert.deepEqual(missing.errors, []);
    optional._setOverrides(null);
    const realAudio = optional.audioFilter();
    if (realAudio.module) {
      const limited = check({ ...job, cut: { ...job.cut, audio: { fadeInSec: 100 } } });
      assert.ok(limited.warnings.some((w) => w.code === 'FADE_IN_LIMITED'));
    }
    // legenda e áudio no padrão: nada a dizer
    assert.deepEqual(check({ ...job, cut: { ...job.cut, audio: { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 }, subtitles: { enabled: false } } }).warnings, []);
  } finally { optional._setOverrides(null); }
}));

test('usa o disco de verdade (statfs) e a gravação de teste não deixa rastro', { skip: skipMedia }, () => withJob((job) => {
  const target = path.join(os.tmpdir(), `bf-qc-novo-${process.pid}`, 'a', 'b');
  try {
    const r = check({ ...job, outputDir: target });
    assert.deepEqual(r.errors, []);
    assert.ok(!fs.existsSync(path.dirname(path.dirname(target))), 'pastas que não existiam continuam sem existir');
  } finally { fs.rmSync(path.join(os.tmpdir(), `bf-qc-novo-${process.pid}`), { recursive: true, force: true }); }
}));

// ---------- fonte com várias faixas de áudio e HDR: avisos que nunca bloqueiam ----------

test('várias faixas de áudio: aviso AUDIO_TRACKS (só a primeira entra no corte); uma faixa ou sem áudio não avisa isso', { skip: skipMedia }, () => withJob((job) => {
  const withInfo = (extra) => ({ ...job, sourceInfo: { ...job.sourceInfo, width: 1080, height: 1920, ...extra } });
  const r = check(withInfo({ audioTracks: 2 }));
  assert.deepEqual(r.errors, [], 'aviso nunca bloqueia');
  assert.deepEqual(codes(r.warnings), ['AUDIO_TRACKS']);
  assert.match(r.warnings[0].message, /2 faixas de áudio.*só a primeira entra.*outra faixa.*sem eles.*junte as faixas antes/);
  assert.match(check(withInfo({ audioTracks: 4 })).warnings[0].message, /4 faixas de áudio/);
  assert.deepEqual(check(withInfo({ audioTracks: 1 })).warnings, []);
  assert.deepEqual(check(withInfo({})).warnings, []);
  assert.deepEqual(codes(check(withInfo({ audioTracks: 3, hasAudio: false })).warnings), ['NO_AUDIO'], 'sem áudio não há o que avisar das faixas');
}));

test('fonte HDR: aviso HDR_SOURCE (o app não faz tone mapping), sem bloquear', { skip: skipMedia }, () => withJob((job) => {
  const r = check({ ...job, sourceInfo: { ...job.sourceInfo, width: 1080, height: 1920, hdr: true } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(codes(r.warnings), ['HDR_SOURCE']);
  assert.match(r.warnings[0].message, /HDR.*tone mapping.*cores.*apagadas/);
  assert.deepEqual(check({ ...job, sourceInfo: { ...job.sourceInfo, width: 1080, height: 1920, hdr: false } }).warnings, []);
}));

test('arquivos reais: o probe conta as faixas de áudio e lê a curva de cor; o aviso chega pelo Job montado a partir dele', { skip: skipMedia }, async () => {
  const { buildJobs } = require('../src/core/export/jobs');
  const dir = fx.tmpDir('bf-export-qc-');
  try {
    // OBS com mix e microfone em faixas separadas: vídeo + 2 faixas de áudio
    const multi = path.join(dir, 'obs.mkv');
    fx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=3', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', multi]);
    // vídeo marcado como HDR10 (PQ / BT.2020)
    const hdr = path.join(dir, 'hdr.mp4');
    fx.ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=10:d=2', '-vf', 'setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', hdr]);
    // vídeo comum
    const plain = path.join(dir, 'comum.mp4');
    fx.makeCodedSource(plain, { width: 320, height: 180, fps: 5, seconds: 2 });

    const info = { multi: await fx.probe(multi), hdr: await fx.probe(hdr), plain: await fx.probe(plain) };
    assert.equal(info.multi.audioTracks, 2);
    assert.equal(info.plain.audioTracks, 1);
    assert.equal(info.hdr.audioTracks, 0);
    assert.equal(info.hdr.colorTransfer, 'smpte2084');
    assert.notEqual(info.plain.colorTransfer, 'smpte2084');

    const checkFile = (file, probed) => {
      const project = { id: 'p', source: { path: file, duration: probed.duration, width: probed.width, height: probed.height }, cuts: [{ id: 'c', title: 'x', start: 0.2, end: 1.2, status: 'approved' }] };
      const { jobs } = buildJobs({ project, info: probed, cutIds: ['c'], profile: { ...VERTICAL, width: 360, height: 640, kind: 'custom', bitrateKbps: 2000 }, outputDir: path.join(dir, 'Cortes') });
      return preflight(jobs[0], { tools, encoderNames: ALL_ENCODERS });
    };
    const multiReport = checkFile(multi, info.multi);
    assert.deepEqual(multiReport.errors, []);
    assert.ok(multiReport.warnings.some((w) => w.code === 'AUDIO_TRACKS' && /2 faixas/.test(w.message)), JSON.stringify(multiReport.warnings));
    const hdrReport = checkFile(hdr, info.hdr);
    assert.deepEqual(hdrReport.errors, []);
    assert.ok(hdrReport.warnings.some((w) => w.code === 'HDR_SOURCE'), JSON.stringify(hdrReport.warnings));
    assert.ok(!checkFile(plain, info.plain).warnings.some((w) => ['AUDIO_TRACKS', 'HDR_SOURCE'].includes(w.code)), 'vídeo comum não ganha esses avisos');
  } finally { fx.cleanup(dir); }
});

// ---------- medidas ajustadas que deixam de ser 9:16 ----------

test('perfil vertical com medidas fora de 9:16 (ex.: 1920×1080 ajustado nos Detalhes) avisa NOT_9X16; perfis próprios e embutidos não', { skip: skipMedia }, () => withJob((job) => {
  const fromProfile = (profile) => check({ ...job, sourceInfo: { ...job.sourceInfo, width: 3840, height: 2160 }, profile });
  const wide = fromProfile({ ...VERTICAL, width: 1920, height: 1080, name: 'Personalizado (1920×1080)' });
  assert.deepEqual(wide.errors, [], 'aviso nunca bloqueia');
  const w = wide.warnings.find((x) => x.code === 'NOT_9X16');
  assert.ok(w, JSON.stringify(wide.warnings));
  assert.match(w.message, /1920×1080.*não são 9:16.*padrão do produto.*mudou de propósito/);
  assert.ok(fromProfile({ ...VERTICAL, width: 1080, height: 1350 }).warnings.some((x) => x.code === 'NOT_9X16'), '4:5 também não é 9:16');
  // o 9:16 de verdade (e as escalas dele) não avisa; perfil próprio (kind custom) é escolha do usuário
  for (const [width, height] of [[1080, 1920], [720, 1280], [1440, 2560], [2160, 3840], [540, 960]]) {
    assert.ok(!fromProfile({ ...VERTICAL, width, height }).warnings.some((x) => x.code === 'NOT_9X16'), `${width}×${height}`);
  }
  assert.ok(!fromProfile({ ...VERTICAL, kind: 'custom', width: 1080, height: 1350 }).warnings.some((x) => x.code === 'NOT_9X16'));
  // o horizontal embutido é 16:9 e não avisa; um horizontal que virou quadrado avisa NOT_16X9
  const horizontal = listBuiltinProfiles().find((p) => p.id === 'horizontal-1080-h264');
  assert.ok(!fromProfile(horizontal).warnings.some((x) => ['NOT_9X16', 'NOT_16X9'].includes(x.code)));
  const square = fromProfile({ ...horizontal, width: 1080, height: 1080 }).warnings.find((x) => x.code === 'NOT_16X9');
  assert.ok(square && /1080×1080.*não são 16:9/.test(square.message));
}));
