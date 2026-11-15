'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const enc = require('../src/core/export/encoders');
const { preflight } = require('../src/core/export/qc');
const { listBuiltinProfiles } = require('../src/core/export/profiles');
const fx = require('./export-fixtures');
const fakes = require('./sources-fakes');

const { tools, skipMedia } = fx;
const skipFake = skipMedia || fakes.fakeExeSkipReason();

const ok = { available: true };
const no = (reason) => ({ available: false, reason });
const detection = (over = {}) => ({ software: { h264: true, h265: true }, nvenc: { h264: ok, h265: ok }, ...over });
const pair = (args, flag) => args[args.indexOf(flag) + 1];

test('argumentos: bitrate alvo com teto (maxrate) e janela (bufsize), yuv420p e hvc1 só no H.265', () => {
  for (const kind of ['software', 'nvenc']) {
    for (const codec of ['h264', 'h265']) {
      const a = enc.buildEncoderArgs({ codec, kind, bitrateKbps: 10000 });
      assert.equal(pair(a, '-c:v'), enc.encoderName(codec, kind));
      assert.equal(pair(a, '-b:v'), '10000k');
      assert.equal(pair(a, '-maxrate'), '12000k');
      assert.equal(pair(a, '-bufsize'), '20000k');
      assert.equal(pair(a, '-pix_fmt'), 'yuv420p');
      assert.equal(a.includes('-tag:v'), codec === 'h265');
      if (codec === 'h265') assert.equal(pair(a, '-tag:v'), 'hvc1');
    }
  }
  const nv = enc.buildEncoderArgs({ codec: 'h264', kind: 'nvenc', bitrateKbps: 8000 });
  assert.deepEqual([pair(nv, '-rc'), pair(nv, '-preset'), pair(nv, '-tune')], ['vbr', 'p5', 'hq']);
  assert.equal(pair(enc.buildEncoderArgs({ codec: 'h264', kind: 'software', bitrateKbps: 8000 }), '-preset'), 'medium');
  assert.equal(pair(enc.buildEncoderArgs({ codec: 'h265', kind: 'software', bitrateKbps: 8000 }), '-x265-params'), 'log-level=error');
  assert.throws(() => enc.buildEncoderArgs({ codec: 'vp9', kind: 'software', bitrateKbps: 1 }));
});

test('chooseEncoder: auto prefere a placa; software nunca usa a placa; NVENC pedido sem placa cai para software e avisa', () => {
  assert.deepEqual(enc.chooseEncoder(detection(), 'h264', 'auto'), { kind: 'nvenc', name: 'h264_nvenc' });
  assert.deepEqual(enc.chooseEncoder(detection(), 'h265', 'software'), { kind: 'software', name: 'libx265' });
  assert.deepEqual(enc.chooseEncoder(detection(), 'h265', 'nvenc'), { kind: 'nvenc', name: 'hevc_nvenc' });
  // sem placa
  const noHw = detection({ nvenc: { h264: no('sem driver'), h265: no('sem driver') } });
  assert.deepEqual(enc.chooseEncoder(noHw, 'h264', 'auto'), { kind: 'software', name: 'libx264' }, 'auto cai para software em silêncio');
  const asked = enc.chooseEncoder(noHw, 'h264', 'nvenc');
  assert.equal(asked.kind, 'software');
  assert.equal(asked.warning.code, 'ENCODER_FALLBACK');
  assert.match(asked.warning.message, /sem driver.*software/);
  // só a placa tem o codec
  const onlyHw = detection({ software: { h264: true, h265: false } });
  assert.equal(enc.chooseEncoder(onlyHw, 'h265', 'auto').kind, 'nvenc');
  assert.equal(enc.chooseEncoder(onlyHw, 'h265', 'software').kind, null);
  // nada serve
  const none = detection({ software: { h264: false, h265: false }, nvenc: { h264: no('x'), h265: no('x') } });
  assert.equal(enc.chooseEncoder(none, 'h264', 'auto').kind, null);
  assert.equal(enc.chooseEncoder(none, 'h264', 'nvenc').kind, null);
});

test('ffmpeg ausente: a detecção diz que nada está disponível, sem executar nada', async () => {
  const d = await enc.detectEncoders({ ffmpeg: null });
  assert.deepEqual([d.software.h264, d.nvenc.h264.available], [false, false]);
  assert.equal(enc.getCachedEncoders(null), null);
});

test('tryEncode: um codificador inexistente falha de verdade e explica o motivo', { skip: skipMedia }, async () => {
  const res = await enc.tryEncode(tools.ffmpeg, 'codificador_que_nao_existe');
  assert.equal(res.ok, false);
  assert.match(res.reason, /codificador_que_nao_existe|Unknown encoder|not found/i);
  const sw = await enc.tryEncode(tools.ffmpeg, 'libx264');
  assert.deepEqual(sw, { ok: true });
});

test('detecção real: software confirmado, NVENC testado com mini-encode e guardado por 24 h em disco', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    enc.configure({ cacheDir: dir });
    enc.resetCache();
    const t0 = Date.parse('2026-01-01T12:00:00Z');
    const first = await enc.detectEncoders({ ffmpeg: tools.ffmpeg, now: () => t0 });
    assert.equal(first.cached, false);
    assert.deepEqual(first.software, { h264: true, h265: true });
    assert.equal(typeof first.nvenc.h264.available, 'boolean');
    if (!first.nvenc.h264.available) assert.equal(typeof first.nvenc.h264.reason, 'string');
    assert.ok(enc.listFfmpegEncoders(tools.ffmpeg).has('libx264'));

    const file = path.join(dir, 'encoders.json');
    assert.ok(fs.existsSync(file));
    assert.deepEqual(fs.readdirSync(dir), ['encoders.json'], 'gravação atômica');
    // dentro de 24 h: cache; depois de 24 h: refaz
    const later = await enc.detectEncoders({ ffmpeg: tools.ffmpeg, now: () => t0 + 23 * 3600 * 1000 });
    assert.equal(later.cached, true);
    assert.equal(later.checkedAt, first.checkedAt);
    enc.forgetMemory();
    const fromDisk = await enc.detectEncoders({ ffmpeg: tools.ffmpeg, now: () => t0 + 23 * 3600 * 1000 });
    assert.equal(fromDisk.cached, true, 'sobrevive à memória: veio do arquivo');
    const expired = await enc.detectEncoders({ ffmpeg: tools.ffmpeg, now: () => t0 + 25 * 3600 * 1000 });
    assert.equal(expired.cached, false);
    assert.equal(expired.checkedAt, new Date(t0 + 25 * 3600 * 1000).toISOString());
    // force ignora o cache
    assert.equal((await enc.detectEncoders({ ffmpeg: tools.ffmpeg, force: true })).cached, false);
    // chamadas simultâneas dividem a mesma detecção
    enc.resetCache();
    const [a, b] = await Promise.all([enc.detectEncoders({ ffmpeg: tools.ffmpeg }), enc.detectEncoders({ ffmpeg: tools.ffmpeg })]);
    assert.equal(a.checkedAt, b.checkedAt);
  } finally {
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});

test('cache corrompido no disco é ignorado (a detecção refaz sem quebrar)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    enc.configure({ cacheDir: dir });
    enc.forgetMemory();
    fs.writeFileSync(path.join(dir, 'encoders.json'), '{ quebrado');
    const d = await enc.detectEncoders({ ffmpeg: tools.ffmpeg });
    assert.equal(d.cached, false);
    assert.equal(d.software.h264, true);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'encoders.json'), 'utf8')), 'o arquivo foi reescrito íntegro');
  } finally {
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});

// ---------- motivo da falha do NVENC: em português, sem a linha crua do ffmpeg ----------

test('motivo da falha do codificador: português curto para cada causa conhecida; texto cru e endereços de memória nunca aparecem', () => {
  // trechos REAIS de stderr (ffmpeg 2026-02-09, h264_nvenc/hevc_nvenc, GTX 1650)
  const noDevice = [
    '[h264_nvenc @ 000002077e8ece40] No capable devices found',
    '[vost#0:0/h264_nvenc @ 000002077e8ec4c0] [enc:h264_nvenc @ 000002077e849700] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.',
    '[out#0/null @ 000002077e891d00] Nothing was written into output file, because at least one of its streams received no packets.'
  ].join('\n');
  const tiny = '[hevc_nvenc @ 000001ba8b639d80] InitializeEncoder failed: invalid param (8): Frame dimensions are less than the minimum supported value.\n[out#0/null @ 000001ba8b636fc0] Nothing was written into output file, because at least one of its streams received no packets.';
  const cases = [
    [noDevice, 'h264_nvenc', false, /placa NVIDIA compatível/],
    [noDevice, 'h264_nvenc', true, /não aceitou este corte.*resolução/],
    [tiny, 'hevc_nvenc', false, /não aceita este tamanho de vídeo/],
    ['[h264_nvenc @ 0000] Cannot load nvcuda.dll\n[h264_nvenc @ 0000] OpenEncodeSessionEx failed', 'h264_nvenc', false, /driver da placa NVIDIA/],
    ['[h264_nvenc @ 0000] OpenEncodeSessionEx failed: out of memory (10)', 'h264_nvenc', false, /sem memória livre/],
    ['[h264_nvenc @ 0000] OpenEncodeSessionEx failed: unsupported device (2)', 'h264_nvenc', false, /recusou iniciar/],
    ["[vost#0:0 @ 0000] Unknown encoder 'h264_nvenc'\nError selecting an encoder", 'h264_nvenc', false, /não tem o codificador h264_nvenc/],
    // só a última linha de um erro desconhecido: texto genérico em português
    ['[out#0/null @ 00000226bc751d00] Nothing was written into output file, because at least one of its streams received no packets.', 'h264_nvenc', false, /não conseguiu iniciar a codificação/],
    ['', 'h264_nvenc', false, /não conseguiu iniciar a codificação/]
  ];
  for (const [stderr, encoder, job, expected] of cases) {
    const reason = enc.describeEncoderFailure(stderr, { encoder, job });
    assert.match(reason, expected, stderr.slice(0, 60));
    assert.doesNotMatch(reason, /@|\[|Nothing was written|packets|Error while opening|capable devices/i, `texto cru vazou: ${reason}`);
    assert.ok(!reason.endsWith('.'), 'cabe dentro de parênteses');
  }
});

/** Runner de teste: o mini-encode do NVENC roda numa placa que não existe (-gpu 9); o resto roda normal. */
const gpu9Runner = (file, args, opts, cb) => {
  if (args.includes('h264_nvenc') || args.includes('hevc_nvenc')) {
    const at = args.indexOf('-b:v');
    return execFile(file, [...args.slice(0, at), '-gpu', '9', ...args.slice(at)], opts, cb);
  }
  return execFile(file, args, opts, cb);
};

test('tryEncode com a placa inexistente (-gpu 9): o motivo é em português e o texto cru fica só em detail', { skip: skipMedia }, async () => {
  if (!enc.listFfmpegEncoders(tools.ffmpeg).has('h264_nvenc')) return; // este ffmpeg nem tem NVENC (o motivo "não foi compilado" vem da própria lista)
  const res = await enc.tryEncode(tools.ffmpeg, 'h264_nvenc', gpu9Runner);
  assert.equal(res.ok, false);
  assert.match(res.reason, /placa NVIDIA/);
  assert.doesNotMatch(res.reason, /@|\[|Nothing was written|packets/i, `motivo: ${res.reason}`);
  assert.match(res.detail, /capable devices|Nothing was written|Error|encoder/i, 'o detalhe técnico guarda o texto do ffmpeg');
});

test('detecção: um NVENC que falha traz o motivo em português (é isso que a tela, o QC e o aviso de queda mostram)', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    enc.configure({ cacheDir: dir });
    enc.resetCache();
    const d = await enc.detectEncoders({ ffmpeg: tools.ffmpeg, force: true, runner: gpu9Runner });
    for (const codec of ['h264', 'h265']) {
      const nv = d.nvenc[codec];
      if (nv.available || /compilado/.test(nv.reason)) continue; // ffmpeg sem NVENC
      assert.match(nv.reason, /placa NVIDIA/);
      assert.doesNotMatch(nv.reason, /@|\[|Nothing was written|packets/i, nv.reason);
      assert.equal(typeof nv.detail, 'string');
    }
    const asked = enc.chooseEncoder(d, 'h264', 'nvenc');
    if (asked.warning) assert.doesNotMatch(asked.warning.message, /@|\[|Nothing was written|packets/i, asked.warning.message);
  } finally {
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});

// ---------- falha momentânea de `ffmpeg -encoders` não pode ficar guardada ----------

/** ffmpeg de verdade (lançador .exe) que, enquanto existir "falha.flag" ao lado dele, falha em `-encoders` como um antivírus ou um disco ocupado faria. */
function makeFlakyFfmpeg(dir) {
  process.env.BF_FAKE_NODE = process.execPath;
  process.env.BF_REAL_FFMPEG = tools.ffmpeg;
  return fakes.makeFakeExe(path.join(dir, 'bin'), 'ffmpeg', String.raw`
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args.includes('-encoders') && fs.existsSync(path.join(__dirname, 'falha.flag'))) { process.stderr.write('simulado: arquivo bloqueado\n'); process.exit(1); }
const r = spawnSync(process.env.BF_REAL_FFMPEG, args, { stdio: 'inherit', maxBuffer: 1 << 26 });
process.exit(r.status === null ? 1 : r.status);
`);
}

test('`ffmpeg -encoders` que falha uma vez NÃO fica em cache por 24 h: nada vai para a memória nem para o disco e "Testar de novo" recupera', { skip: skipFake, timeout: 240000 }, async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    const cacheDir = path.join(dir, 'cache');
    enc.configure({ cacheDir });
    enc.resetCache();
    const flaky = makeFlakyFfmpeg(dir);
    const flag = path.join(dir, 'bin', 'falha.flag');
    fs.writeFileSync(flag, '1');

    // 1) a consulta falha: a lista vem vazia e marcada como falha; o resultado é verdadeiro (mini-encode) e NÃO é guardado
    assert.equal(enc.encoderListing(flaky).ok, false);
    assert.equal(enc.listFfmpegEncoders(flaky).size, 0);
    const first = await enc.detectEncoders({ ffmpeg: flaky });
    assert.deepEqual(first.software, { h264: true, h265: true }, 'sem a lista, o software é conferido por um mini-encode de verdade (não "indisponível")');
    assert.equal(enc.getCachedEncoders(flaky), null, 'nada em memória para 24 h');
    assert.equal(fs.existsSync(path.join(cacheDir, 'encoders.json')), false, 'nada em disco para 24 h');
    assert.notEqual(enc.chooseEncoder(first, 'h264', 'auto').kind, null, 'o app continua conseguindo exportar');

    // 2) o QC síncrono não bloqueia o corte à toa só porque a lista não pôde ser lida agora
    const dirJob = path.join(dir, 'job');
    fs.mkdirSync(dirJob);
    const src = path.join(dirJob, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 320, height: 180, fps: 5, seconds: 2 });
    const job = {
      id: 'j', sourcePath: src, sourceInfo: { width: 320, height: 180, fps: 5, duration: 2, hasAudio: true }, cut: { id: 'c', title: 't', start: 0, end: 1 },
      profile: { ...listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264'), encoder: 'software' }, framing: null, outputDir: path.join(dirJob, 'Cortes'), baseName: 'saida', onConflict: 'ask'
    };
    assert.deepEqual(preflight(job, { tools: { ffmpeg: flaky } }).errors, [], 'falha momentânea da lista não vira CODEC_UNSUPPORTED');

    // 3) a falha passa; "Testar a placa de novo" (force) esquece a falha recente e passa a valer o resultado completo, guardado
    fs.rmSync(flag);
    const forced = await enc.detectEncoders({ ffmpeg: flaky, force: true });
    assert.equal(forced.cached, false);
    assert.equal(enc.encoderListing(flaky).ok, true);
    assert.ok(enc.listFfmpegEncoders(flaky).has('libx264'));
    assert.ok(enc.getCachedEncoders(flaky), 'agora sim o resultado completo fica guardado');
    assert.ok(fs.existsSync(path.join(cacheDir, 'encoders.json')));
    assert.equal((await enc.detectEncoders({ ffmpeg: flaky })).cached, true);

    // 4) sem o force, a falha recente também expira sozinha (resultado negativo tem validade curta)
    enc.resetCache();
    fs.writeFileSync(flag, '1');
    const t0 = Date.now();
    assert.equal(enc.encoderListing(flaky, () => t0).ok, false);
    fs.rmSync(flag);
    assert.equal(enc.encoderListing(flaky, () => t0 + 1000).ok, false, 'dentro da validade curta a consulta não é repetida');
    assert.equal(enc.encoderListing(flaky, () => t0 + enc.NEGATIVE_TTL_MS + 1).ok, true, 'passada a validade curta, a lista é lida de novo');
  } finally {
    delete process.env.BF_REAL_FFMPEG;
    delete process.env.BF_FAKE_NODE;
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});

test('um "ffmpeg" que não responde a `-encoders` (nem codifica) não envenena o cache: nada é gravado e o QC não acusa codec', async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    const cacheDir = path.join(dir, 'cache');
    enc.configure({ cacheDir });
    enc.resetCache();
    const broken = process.execPath; // roda, mas não é um ffmpeg: `-encoders` falha
    const d = await enc.detectEncoders({ ffmpeg: broken });
    assert.deepEqual([d.software.h264, d.nvenc.h264.available], [false, false]);
    assert.equal(enc.getCachedEncoders(broken), null);
    assert.equal(fs.existsSync(path.join(cacheDir, 'encoders.json')), false, 'o resultado vazio não foi para o disco');
    assert.equal(enc.encoderListing(broken).ok, false);
    const qc = preflight({
      id: 'j', sourcePath: process.execPath, sourceInfo: { width: 320, height: 180, fps: 5, duration: 100, hasAudio: true }, cut: { id: 'c', title: 't', start: 0, end: 1 },
      profile: { ...listBuiltinProfiles()[0] }, framing: null, outputDir: path.join(dir, 'Cortes'), baseName: 'saida'
    }, { tools: { ffmpeg: broken } });
    assert.ok(!qc.errors.some((e) => e.code === 'CODEC_UNSUPPORTED'), JSON.stringify(qc.errors));
  } finally {
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});

test('cache de 24 h com "nenhum codificador" (resultado de uma consulta que falhou, guardado por versões antigas) não é confiável: a detecção refaz', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-export-enc-');
  try {
    enc.configure({ cacheDir: dir });
    enc.resetCache();
    const real = await enc.detectEncoders({ ffmpeg: tools.ffmpeg });
    const file = path.join(dir, 'encoders.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [key] = Object.keys(data.entries);
    const none = { reason: 'este ffmpeg não foi compilado com NVENC' };
    data.entries[key] = { ...data.entries[key], checkedAt: new Date().toISOString(), software: { h264: false, h265: false }, nvenc: { h264: { available: false, ...none }, h265: { available: false, ...none } } };
    fs.writeFileSync(file, JSON.stringify(data));
    enc.forgetMemory();
    assert.equal(enc.getCachedEncoders(tools.ffmpeg), null, 'o resultado vazio guardado não vale como cache');
    const again = await enc.detectEncoders({ ffmpeg: tools.ffmpeg });
    assert.equal(again.cached, false, 'refeito de verdade');
    assert.deepEqual(again.software, real.software);
    assert.notEqual(enc.chooseEncoder(again, 'h264', 'auto').kind, null);
  } finally {
    enc.resetCache();
    enc.configure({ cacheDir: null });
    enc.forgetMemory();
    fx.cleanup(dir);
  }
});
