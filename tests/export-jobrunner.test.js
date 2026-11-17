'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runExportJob, ExportError, classifyFailure, RECOVERABLE_CODES, NON_RECOVERABLE_CODES } = require('../src/core/export/jobRunner');
const { listBuiltinProfiles } = require('../src/core/export/profiles');
const encoders = require('../src/core/export/encoders');
const optional = require('../src/core/export/optional');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;
const VERTICAL = listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264');
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual}, esperado ${expected} (±${tol})`);

/** Ordem dos átomos de primeiro nível de um MP4 (faststart = moov antes de mdat). */
function topLevelAtoms(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const atoms = [];
    let pos = 0;
    const head = Buffer.alloc(16);
    while (pos + 8 <= size) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len === 0) len = size - pos;
      atoms.push(type);
      if (len < 8) break;
      pos += len;
    }
    return atoms;
  } finally { fs.closeSync(fd); }
}

function makeJob(dir, src, over = {}) {
  return {
    id: 'job-teste', projectId: 'p1', projectTitle: 'teste', sourcePath: src,
    sourceInfo: { width: 1280, height: 720, fps: 10, duration: 4, hasAudio: true },
    cut: { id: 'c1', title: 'Corte de teste', start: 0.5, end: 2.5 },
    profile: { ...VERTICAL, encoder: 'software' }, framing: null,
    outputDir: path.join(dir, 'saida'), baseName: 'corte', onConflict: 'fail', createdAt: new Date().toISOString(),
    ...over
  };
}

async function withSource(fn, opts) {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1280, height: 720, fps: 10, seconds: 4, ...opts });
    return await fn(dir, src);
  } finally { fx.cleanup(dir); }
}

const run = (job, extra = {}) => runExportJob(job, { tools, ...extra });
const noPartIn = (dir) => !fs.existsSync(dir) || fs.readdirSync(dir).every((f) => !f.endsWith('.part'));

// ---------- todos os perfis ----------

test('todos os perfis embutidos geram arquivo com dimensões, codec, tag, faststart e áudio corretos', { skip: skipMedia }, () => withSource(async (dir, src) => {
  for (const profile of listBuiltinProfiles()) {
    const progress = [];
    const job = makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0.5, end: 1.5 }, baseName: profile.id });
    const res = await run(job, { onProgress: (p) => progress.push(p) });
    assert.equal(res.output, path.join(dir, 'saida', `${profile.id}.mp4`));
    assert.equal(res.skipped, false);
    const data = fx.probeStreams(res.output);
    const video = data.streams.find((s) => s.codec_type === 'video');
    const audio = data.streams.find((s) => s.codec_type === 'audio');
    assert.deepEqual([video.width, video.height], [profile.width, profile.height], profile.id);
    assert.equal(video.codec_name, profile.codec === 'h265' ? 'hevc' : 'h264', profile.id);
    assert.equal(video.pix_fmt, 'yuv420p');
    if (profile.codec === 'h265') assert.equal(video.codec_tag_string, 'hvc1', `${profile.id}: tag hvc1`);
    assert.equal(video.sample_aspect_ratio === undefined || video.sample_aspect_ratio === '1:1', true, 'pixel quadrado');
    assert.equal(audio.codec_name, 'aac');
    near(Number(data.format.duration), 1, 0.25, `${profile.id}: duração`);
    const atoms = topLevelAtoms(res.output);
    assert.ok(atoms.indexOf('moov') < atoms.indexOf('mdat'), `${profile.id}: faststart (${atoms})`);
    assert.ok(progress.length >= 2 && progress[0] === 0 && progress[progress.length - 1] === 1, `${profile.id}: progresso de 0 a 1`);
    assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), 'progresso nunca recua');
  }
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));

test('software: libx264 e libx265 explícitos (inclusive 4K) e o resultado informa o codificador usado', { skip: skipMedia }, () => withSource(async (dir, src) => {
  for (const id of ['vertical-1080-h264', 'vertical-1080-h265', 'horizontal-1080-h264', 'horizontal-1080-h265', 'vertical-2160-h264']) {
    const profile = { ...listBuiltinProfiles().find((p) => p.id === id), encoder: 'software' };
    const res = await run(makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0.5, end: 1.3 }, baseName: `sw-${id}` }));
    assert.deepEqual(res.encoder, { kind: 'software', name: profile.codec === 'h265' ? 'libx265' : 'libx264' }, id);
    const info = await fx.probe(res.output);
    assert.deepEqual([info.width, info.height], [profile.width, profile.height], id);
    assert.deepEqual(res.warnings, [], `${id}: sem avisos`);
  }
}));

test('NVENC (se a placa existir): H.264 e H.265 de verdade pela GPU; senão cai para software e avisa', { skip: skipMedia }, (t) => withSource(async (dir, src) => {
  const detection = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
  for (const codec of ['h264', 'h265']) {
    const profile = { ...VERTICAL, id: `v-${codec}`, codec, encoder: 'nvenc' };
    const res = await run(makeJob(dir, src, { profile, baseName: `nvenc-${codec}` }));
    const video = fx.probeStreams(res.output).streams.find((s) => s.codec_type === 'video');
    assert.equal(video.codec_name, codec === 'h265' ? 'hevc' : 'h264');
    if (detection.nvenc[codec].available) {
      assert.deepEqual(res.encoder, { kind: 'nvenc', name: codec === 'h265' ? 'hevc_nvenc' : 'h264_nvenc' }, `a placa existe mas o trabalho caiu para software: ${JSON.stringify(res.warnings)}`);
      assert.deepEqual(res.warnings, []);
      if (codec === 'h265') assert.equal(video.codec_tag_string, 'hvc1');
    } else {
      assert.equal(res.encoder.kind, 'software');
      assert.ok(res.warnings.some((w) => w.code === 'ENCODER_FALLBACK'), 'avisou a queda para software');
    }
  }
  if (!detection.nvenc.h264.available && !detection.nvenc.h265.available) t.diagnostic('NVENC indisponível nesta máquina: só a queda para software foi verificada');
}));

test('NVENC que falha na hora de exportar (resolução acima do limite da placa) refaz por software e AVISA', { skip: skipMedia }, (t) => withSource(async (dir, src) => {
  const detection = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
  if (!detection.nvenc.h264.available) { t.diagnostic('sem NVENC: caso não se aplica'); return; }
  // 5000x5000 passa do limite de 4096 do H.264 por hardware, mas o libx264 aceita
  const profile = { ...VERTICAL, id: 'enorme', width: 5000, height: 5000, encoder: 'nvenc', kind: 'custom' };
  const res = await run(makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0.5, end: 1 }, baseName: 'enorme' }));
  assert.equal(res.encoder.kind, 'software', 'terminou por software');
  const w = res.warnings.find((x) => x.code === 'ENCODER_FALLBACK');
  assert.ok(w && /NVENC/.test(w.message) && /software/.test(w.message), 'avisou a queda');
  const info = await fx.probe(res.output);
  assert.deepEqual([info.width, info.height], [5000, 5000]);
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));

test('cache de 24 h: NVENC "indisponível" guardado faz o NVENC pedido cair para software com aviso, sem testar de novo', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const cacheDir = path.join(dir, 'cache');
  try {
    encoders.configure({ cacheDir });
    encoders.resetCache();
    const first = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
    assert.equal(first.cached, false);
    const file = path.join(cacheDir, 'encoders.json');
    assert.ok(fs.existsSync(file), 'resultado gravado em disco');
    // adultera o arquivo: NVENC indisponível, verificado agora
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [key] = Object.keys(data.entries);
    data.entries[key].nvenc = { h264: { available: false, reason: 'teste' }, h265: { available: false, reason: 'teste' } };
    data.entries[key].checkedAt = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(data));
    encoders.forgetMemory();
    const second = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
    assert.equal(second.cached, true, 'veio do cache de 24 h');
    assert.equal(second.nvenc.h264.reason, 'teste');
    const res = await run(makeJob(dir, src, { profile: { ...VERTICAL, encoder: 'nvenc' }, baseName: 'cache' }));
    assert.equal(res.encoder.kind, 'software');
    assert.ok(res.warnings.some((w) => w.code === 'ENCODER_FALLBACK' && /teste/.test(w.message)));
    // 'auto' usa software em silêncio (não pediu a placa)
    const auto = await run(makeJob(dir, src, { profile: { ...VERTICAL, encoder: 'auto' }, baseName: 'cache-auto' }));
    assert.equal(auto.encoder.kind, 'software');
    assert.deepEqual(auto.warnings, []);
    // cache com mais de 24 h é ignorado: a detecção roda de novo e o NVENC volta a valer
    data.entries[key].checkedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(data));
    encoders.forgetMemory();
    const third = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
    assert.equal(third.cached, false, 'cache vencido foi refeito');
    assert.notEqual(third.nvenc.h264.reason, 'teste');
  } finally {
    encoders.resetCache();
    encoders.configure({ cacheDir: null });
    encoders.forgetMemory();
  }
}));

test('bitrate alvo: o arquivo fica perto do pedido (maxrate/bufsize coerentes) em software e na GPU', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir();
  try {
    const src = path.join(dir, 'ruido.mp4');
    fx.makeNoiseSource(src, { seconds: 6 });
    const detection = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
    const cases = [['software', 'h264'], ['software', 'h265']];
    if (detection.nvenc.h264.available) cases.push(['nvenc', 'h264']);
    for (const [encoder, codec] of cases) {
      const measured = [];
      for (const kbps of [2500, 6000]) {
        const profile = { ...VERTICAL, id: 'br', width: 720, height: 1280, codec, encoder, bitrateKbps: kbps, kind: 'custom' };
        const res = await run(makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0, end: 5 }, baseName: `br-${encoder}-${codec}-${kbps}`, sourceInfo: { width: 1280, height: 720, fps: 10, duration: 6, hasAudio: true } }));
        const data = fx.probeStreams(res.output);
        const bytes = fs.statSync(res.output).size;
        const videoKbps = ((bytes * 8) / 5 / 1000) - 192; // desconta o áudio
        // NVENC estoura mais que o x264/x265 em ruído puro de poucos segundos (o controle de taxa da placa converge devagar)
        const top = encoder === 'nvenc' ? 1.65 : 1.35;
        assert.ok(videoKbps > kbps * 0.5 && videoKbps < kbps * top, `${encoder}/${codec}/${kbps}: ficou em ${videoKbps.toFixed(0)} kbps`);
        assert.equal(data.streams.find((s) => s.codec_type === 'video').height, 1280);
        measured.push(videoKbps);
      }
      const ratio = measured[1] / measured[0];
      assert.ok(ratio > 1.6 && ratio < 3.2, `${encoder}/${codec}: o bitrate acompanha o pedido (6000/2500 deu ${ratio.toFixed(2)}x)`);
    }
  } finally { fx.cleanup(dir); }
});

// ---------- enquadramento no arquivo exportado ----------

test('o enquadramento do Job chega ao arquivo: focusX do corte, stack e blur aparecem de fato no vídeo exportado', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const base = { cut: { id: 'c', title: 't', start: 0.5, end: 1.5 } };
  const left = await run(makeJob(dir, src, { ...base, framing: { mode: 'center', focusX: 0 }, baseName: 'esq' }));
  const right = await run(makeJob(dir, src, { ...base, framing: { mode: 'center', focusX: 1 }, baseName: 'dir' }));
  const fl = fx.decodeFile(left.output, 1080, 1920);
  const fr = fx.decodeFile(right.output, 1080, 1920);
  near(fx.avg(fl, 4, 960, 0), 0, 12, 'focusX 0');
  near(fx.avg(fr, 1075, 960, 0), 255, 12, 'focusX 1');
  assert.ok(fx.avg(fr, 4, 960, 0) - fx.avg(fl, 4, 960, 0) > 140, 'recortes diferentes');

  // ajuste do corte vence o padrão do projeto (job.framing) e o job não altera nada
  const cut = { id: 'c', title: 't', start: 0.5, end: 1.5, framing: { focusX: 0 } };
  const snapshot = JSON.stringify(cut);
  const over = await run(makeJob(dir, src, { cut, framing: { mode: 'center', focusX: 1 }, baseName: 'cut-wins' }));
  near(fx.avg(fx.decodeFile(over.output, 1080, 1920), 4, 960, 0), 0, 12, 'corte vence o padrão do projeto');
  assert.equal(JSON.stringify(cut), snapshot, 'o corte do Job não foi alterado');

  const stack = await run(makeJob(dir, src, { ...base, framing: { mode: 'stack', stack: { webcamRect: { x: 0, y: 0, w: 0.25, h: 0.3 }, gameRect: { x: 0.5, y: 0, w: 0.5, h: 1 }, webcamHeightPct: 30, webcamPosition: 'bottom' } }, baseName: 'stack' }));
  const fs2 = fx.decodeFile(stack.output, 1080, 1920);
  assert.ok(fx.avg(fs2, 4, 400, 0) > 120, 'gameplay (metade direita da fonte) em cima');
  assert.ok(fx.avg(fs2, 4, 1700, 0) < 20, 'webcam (canto esquerdo da fonte) embaixo');

  const blur = await run(makeJob(dir, src, { ...base, framing: { mode: 'blur' }, baseName: 'blur' }));
  const fb = fx.decodeFile(blur.output, 1080, 1920);
  near(fx.avg(fb, 4, 960, 0), 0, 14, 'blur: gameplay inteira (esquerda)');
  near(fx.avg(fb, 1075, 960, 0), 255, 14, 'blur: gameplay inteira (direita)');
}));

// ---------- cancelamento ----------

test('cancelar pelo signal mata o ffmpeg, limpa o .part e não deixa resultado', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const profile = { ...VERTICAL, id: 'pesado', width: 2160, height: 3840, codec: 'h265', encoder: 'software', bitrateKbps: 20000 };
  const controller = new AbortController();
  let pid = null;
  const job = makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0, end: 3.9 }, baseName: 'cancelado' });
  const outDir = path.join(dir, 'saida');
  const promise = run(job, { signal: controller.signal, onStart: (x) => { pid = x.pid; } });
  // espera o ffmpeg criar o .part e então cancela
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !(fs.existsSync(outDir) && fs.readdirSync(outDir).some((f) => f.endsWith('.part')))) await new Promise((r) => setTimeout(r, 50));
  assert.ok(pid, 'o ffmpeg iniciou');
  assert.ok(fs.readdirSync(outDir).some((f) => f === 'cancelado.mp4.part'), 'o .part existe durante a exportação e o resultado final não');
  assert.ok(!fs.existsSync(path.join(outDir, 'cancelado.mp4')), 'o .part nunca vira resultado');
  controller.abort();
  await assert.rejects(promise, (err) => err instanceof ExportError && err.code === 'CANCELLED' && err.recoverable === false);
  assert.deepEqual(fs.readdirSync(outDir), [], 'nada sobrou (nem .part, nem resultado)');
  const gone = Date.now() + 5000;
  while (Date.now() < gone && fx.isAlive(pid)) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fx.isAlive(pid), false, 'o processo do ffmpeg terminou');
}));

test('cancelar antes de começar não cria nada', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(makeJob(dir, src), { signal: controller.signal }), { code: 'CANCELLED' });
  assert.ok(!fs.existsSync(path.join(dir, 'saida')), 'nem a pasta de destino foi criada');
}));

// ---------- conflito de nome ----------

test('onConflict fail: OUTPUT_EXISTS e o arquivo existente fica intacto', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'corte.mp4'), 'ORIGINAL');
  for (const mode of ['fail', 'ask', undefined]) {
    await assert.rejects(run(makeJob(dir, src, { onConflict: mode })), (err) => err.code === 'OUTPUT_EXISTS' && err.recoverable === false && /Já existe um arquivo/.test(err.message));
  }
  assert.equal(fs.readFileSync(path.join(out, 'corte.mp4'), 'utf8'), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(out), ['corte.mp4']);
}));

test('onConflict rename: "nome (2).mp4", "(3)"… e o original fica intacto', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'corte.mp4'), 'ORIGINAL');
  const a = await run(makeJob(dir, src, { onConflict: 'rename' }));
  const b = await run(makeJob(dir, src, { onConflict: 'rename' }));
  assert.equal(path.basename(a.output), 'corte (2).mp4');
  assert.equal(path.basename(b.output), 'corte (3).mp4');
  assert.equal(fs.readFileSync(path.join(out, 'corte.mp4'), 'utf8'), 'ORIGINAL');
  assert.ok(noPartIn(out));
  assert.equal((await fx.probe(a.output)).width, 1080);
}));

test('onConflict skip: não roda o ffmpeg, devolve skipped e não toca no arquivo', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'corte.mp4'), 'ORIGINAL');
  let started = false;
  const res = await run(makeJob(dir, src, { onConflict: 'skip' }), { onStart: () => { started = true; } });
  assert.equal(res.skipped, true);
  assert.equal(res.output, path.join(out, 'corte.mp4'));
  assert.equal(started, false);
  assert.equal(res.warnings[0].code, 'SKIPPED');
  assert.deepEqual(fs.readdirSync(out), ['corte.mp4']);
  assert.equal(fs.readFileSync(path.join(out, 'corte.mp4'), 'utf8'), 'ORIGINAL');
  // skip sem conflito exporta normalmente
  fs.rmSync(path.join(out, 'corte.mp4'));
  const normal = await run(makeJob(dir, src, { onConflict: 'skip' }));
  assert.equal(normal.skipped, false);
}));

test('onConflict replace: o original só é trocado, de forma atômica, depois do sucesso', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const out = path.join(dir, 'saida');
  const final = path.join(out, 'corte.mp4');
  fs.mkdirSync(out);
  fs.writeFileSync(final, 'ORIGINAL');
  const during = [];
  const res = await run(makeJob(dir, src, { onConflict: 'replace' }), {
    onProgress: () => during.push({ content: fs.readFileSync(final, 'utf8').slice(0, 8), part: fs.existsSync(`${final}.part`) })
  });
  assert.equal(res.output, final);
  assert.ok(during.length > 0);
  assert.ok(during.slice(0, -1).every((d) => d.content === 'ORIGINAL'), 'durante a exportação o original continua lá');
  assert.ok(during.some((d) => d.part), 'a gravação acontece no .part');
  assert.equal((await fx.probe(final)).width, 1080, 'depois do sucesso o arquivo é o novo');
  assert.deepEqual(fs.readdirSync(out), ['corte.mp4']);
}));

test('replace com falha NÃO apaga o original', { skip: skipMedia }, () => withSource(async (dir) => {
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'corte.mp4'), 'ORIGINAL');
  const broken = path.join(dir, 'quebrado.mp4');
  fs.writeFileSync(broken, 'isto não é um vídeo');
  await assert.rejects(run(makeJob(dir, broken, { onConflict: 'replace' })), (err) => err.code === 'INPUT_MISSING' && /não pôde ser lido/.test(err.message) && typeof err.details.stderr === 'string');
  assert.equal(fs.readFileSync(path.join(out, 'corte.mp4'), 'utf8'), 'ORIGINAL');
  assert.deepEqual(fs.readdirSync(out), ['corte.mp4'], 'sem .part');
}));

test('um .part sobrado de execução interrompida é descartado; nunca vira resultado', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const out = path.join(dir, 'saida');
  fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'corte.mp4.part'), 'SOBRA');
  const res = await run(makeJob(dir, src));
  assert.equal(path.basename(res.output), 'corte.mp4');
  assert.deepEqual(fs.readdirSync(out), ['corte.mp4']);
  assert.notEqual(fs.readFileSync(res.output).slice(0, 5).toString(), 'SOBRA');
}));

test('dois trabalhos ao mesmo tempo com o mesmo nome nunca gravam no mesmo arquivo', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const [a, b] = await Promise.all([
    run(makeJob(dir, src, { onConflict: 'rename' })),
    run(makeJob(dir, src, { onConflict: 'rename' }))
  ]);
  assert.deepEqual([path.basename(a.output), path.basename(b.output)].sort(), ['corte (2).mp4', 'corte.mp4']);
  assert.equal((await fx.probe(a.output)).height, 1920);
  assert.equal((await fx.probe(b.output)).height, 1920);
  const [c, d] = await Promise.allSettled([run(makeJob(dir, src, { baseName: 'outro', onConflict: 'fail' })), run(makeJob(dir, src, { baseName: 'outro', onConflict: 'fail' }))]);
  assert.deepEqual([c.status, d.status].sort(), ['fulfilled', 'rejected']);
  assert.equal((c.status === 'rejected' ? c : d).reason.code, 'OUTPUT_EXISTS');
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));

test('nunca escreve por cima do próprio vídeo de origem (nem com replace)', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const before = fs.readFileSync(src);
  await assert.rejects(run(makeJob(dir, src, { outputDir: dir, baseName: 'fonte', onConflict: 'replace' })), { code: 'OUTPUT_EXISTS' });
  assert.ok(fs.readFileSync(src).equals(before));
  assert.ok(noPartIn(dir));
}));

test('nome do arquivo com caracteres proibidos e acentos é limpo; pasta de destino é criada', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const res = await run(makeJob(dir, src, { outputDir: path.join(dir, 'a', 'b', 'Cortes'), baseName: 'Clutch: "épico" <1>/2?' }));
  assert.equal(path.basename(res.output), 'Clutch_ _épico_ _1__2_.mp4');
  assert.ok(fs.existsSync(res.output));
}));

// ---------- erros ----------

test('erros claros e classificados: perfil, intervalo, entrada, ffmpeg e pasta de destino', { skip: skipMedia }, () => withSource(async (dir, src) => {
  await assert.rejects(run(makeJob(dir, src, { profile: { ...VERTICAL, width: 1081 } })), (e) => e.code === 'INVALID_PROFILE' && /par/.test(e.message) && !e.recoverable);
  await assert.rejects(run(makeJob(dir, src, { cut: { start: 5, end: 2 } })), { code: 'INVALID_RANGE' });
  await assert.rejects(run(makeJob(dir, src, { cut: { start: 1, end: 99 } })), (e) => e.code === 'INVALID_RANGE' && /depois do fim/.test(e.message));
  await assert.rejects(run(makeJob(dir, path.join(dir, 'nao-existe.mp4'))), { code: 'INPUT_MISSING' });
  await assert.rejects(runExportJob(makeJob(dir, src), { tools: {} }), (e) => e.code === 'NO_FFMPEG' && /Instale o FFmpeg/.test(e.message) && typeof e.details.solution === 'string');
  await assert.rejects(runExportJob(makeJob(dir, src), { tools: { ffmpeg: path.join(dir, 'sem-ffmpeg.exe') } }), (e) => e.code === 'FFMPEG_START_FAILED' && e.recoverable === true);
  // pasta de destino impossível: já existe um ARQUIVO com o nome da pasta
  fs.writeFileSync(path.join(dir, 'arquivo'), 'x');
  await assert.rejects(run(makeJob(dir, src, { outputDir: path.join(dir, 'arquivo', 'dentro') })), (e) => e.code === 'OUTPUT_NOT_WRITABLE' && typeof e.details.solution === 'string');
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));

test('classificação dos erros do ffmpeg: recuperáveis (tentar de novo) e não recuperáveis', () => {
  const cases = [
    [{ code: 1, stderr: 'av_interleaved_write_frame(): No space left on device' }, 'NO_DISK_SPACE'],
    [{ code: 1, stderr: 'Error opening output file: Permission denied' }, 'IO_BUSY'],
    [{ code: 1, stderr: 'The process cannot access the file because it is being used by another process.' }, 'IO_BUSY'],
    [{ code: 1, stderr: 'Error writing trailer: Input/output error' }, 'DISK_TRANSIENT'],
    [{ code: 1, stderr: 'Unknown encoder \'libx265\'' }, 'CODEC_UNSUPPORTED'],
    [{ code: 1, stderr: 'No such filter: \'subtitles\'' }, 'CODEC_UNSUPPORTED'],
    [{ code: 1, stderr: 'x.mp4: Invalid data found when processing input' }, 'INPUT_MISSING'],
    [{ code: 3221225477, stderr: '' }, 'FFMPEG_CRASH'],
    [{ code: null, signal: 'SIGSEGV', stderr: '' }, 'FFMPEG_CRASH'],
    [{ code: 1, stderr: 'algo que ninguém previu' }, 'FFMPEG_FAILED'],
    // saídas REAIS do ffmpeg no Windows (AVERROR lido sem sinal): falha comum, não queda
    [{ code: 4294967274, stderr: '[fc#0 @ 0000] Error binding filtergraph inputs/outputs: Invalid argument' }, 'FFMPEG_FAILED'],
    [{ code: 3015096584, stderr: 'Error : Filter not found' }, 'FFMPEG_FAILED'],
    [{ code: 255, stderr: '' }, 'FFMPEG_FAILED'],
    // quedas de verdade do Windows (exceções do sistema), inclusive no formato com sinal
    [{ code: 3221226505, stderr: '' }, 'FFMPEG_CRASH'],
    [{ code: -1073741819, stderr: '' }, 'FFMPEG_CRASH']
  ];
  for (const [input, expected] of cases) {
    const err = classifyFailure(input);
    assert.ok(err instanceof ExportError);
    assert.equal(err.code, expected, JSON.stringify(input));
    assert.equal(err.recoverable, RECOVERABLE_CODES.includes(expected));
    assert.ok(err.message.length > 20, 'mensagem explica');
    assert.equal(typeof err.details.stderr, 'string', 'guarda o final do stderr');
  }
  for (const code of RECOVERABLE_CODES) assert.ok(!NON_RECOVERABLE_CODES.includes(code));
  assert.deepEqual([...RECOVERABLE_CODES].sort(), ['DISK_TRANSIENT', 'FFMPEG_CRASH', 'FFMPEG_START_FAILED', 'IO_BUSY']);
  const long = classifyFailure({ code: 1, stderr: 'x'.repeat(10) });
  assert.ok(long.details.exitCode === 1);
});

// ---------- legendas e áudio (módulos reais dos outros recursos) ----------

test('legendas reais (burnIn): queimadas no vídeo, SRT ao lado, sem sobrescrever o que já existe', { skip: skipMedia }, async (t) => {
  const real = optional.burnIn();
  if (!real.module) { t.skip('módulo de legendas ainda não existe'); return; }
  await withSource(async (dir, src) => {
    const cut = {
      id: 'c', title: 'Com legenda', start: 0.5, end: 2.5,
      subtitles: { enabled: true, mode: 'both', sidecarFormat: 'srt', cues: [{ start: 0.2, end: 1.8, text: 'Olá, mundo!' }], style: { position: 'center', fontSize: 120, background: 'box', backgroundOpacity: 1 } }
    };
    const plain = await run(makeJob(dir, src, { cut: { ...cut, subtitles: null }, baseName: 'sem' }));
    const withSub = await run(makeJob(dir, src, { cut, baseName: 'com' }), { tmpDir: path.join(dir, 'tmp-job') });
    // legenda queimada: o centro do quadro (caixa preta com texto branco) é bem diferente do vídeo sem legenda
    const a = fx.decodeFile(plain.output, 1080, 1920, { ss: 0.8 });
    const b = fx.decodeFile(withSub.output, 1080, 1920, { ss: 0.8 });
    let diff = 0;
    for (let y = 800; y < 1120; y += 4) for (let x = 100; x < 980; x += 4) diff += Math.abs(fx.pixel(a, x, y)[0] - fx.pixel(b, x, y)[0]);
    assert.ok(diff > 20000, `a legenda mudou o miolo do quadro (diferença ${diff})`);
    // arquivo separado ao lado, com o nome do vídeo
    const srt = path.join(dir, 'saida', 'com.srt');
    assert.ok(fs.existsSync(srt), 'SRT ao lado do vídeo');
    assert.match(fs.readFileSync(srt, 'utf8'), /Olá, mundo!/);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'saida')).sort(), ['com.mp4', 'com.srt', 'sem.mp4']);

    // já existe um SRT diferente ao lado: é mantido e o usuário é avisado
    fs.writeFileSync(path.join(dir, 'saida', 'outro.srt'), 'SOU DO USUARIO');
    const again = await run(makeJob(dir, src, { cut, baseName: 'outro' }));
    assert.equal(fs.readFileSync(path.join(dir, 'saida', 'outro.srt'), 'utf8'), 'SOU DO USUARIO');
    assert.ok(again.warnings.some((w) => w.code === 'SIDECAR_EXISTS'));
  });
});

test('áudio real (audioFilter): mudo zera o som; ganho muda o volume; fades e limites viram avisos', { skip: skipMedia }, async (t) => {
  const real = optional.audioFilter();
  if (!real.module) { t.skip('módulo de áudio ainda não existe'); return; }
  const meanVolume = (file) => {
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr);
    return m ? (m[1] === '-inf' ? -120 : Number(m[1])) : null;
  };
  await withSource(async (dir, src) => {
    const base = { id: 'c', title: 't', start: 0.5, end: 2.5 };
    const normal = await run(makeJob(dir, src, { cut: base, baseName: 'normal' }));
    const muted = await run(makeJob(dir, src, { cut: { ...base, audio: { mute: true } }, baseName: 'mudo' }));
    const loud = await run(makeJob(dir, src, { cut: { ...base, audio: { gainDb: 6 } }, baseName: 'alto' }));
    const quiet = await run(makeJob(dir, src, { cut: { ...base, audio: { gainDb: -12 } }, baseName: 'baixo' }));
    const faded = await run(makeJob(dir, src, { cut: { ...base, audio: { fadeInSec: 0.8, fadeOutSec: 0.8 } }, baseName: 'fade' }));
    const vNormal = meanVolume(normal.output);
    assert.ok(vNormal < -5 && vNormal > -40, `áudio normal audível (${vNormal} dB)`);
    assert.ok(meanVolume(muted.output) < -60, 'mudo: silêncio');
    near(meanVolume(loud.output) - vNormal, 6, 2, 'ganho +6 dB');
    near(meanVolume(quiet.output) - vNormal, -12, 2, 'ganho -12 dB');
    assert.ok(meanVolume(faded.output) < vNormal - 0.8, 'fades tiram energia média');
    // limite do módulo (fade maior que metade do corte) volta como aviso, não como erro
    const limited = await run(makeJob(dir, src, { cut: { ...base, audio: { fadeInSec: 5 } }, baseName: 'limitado' }));
    assert.ok(limited.warnings.some((w) => w.code === 'FADE_IN_LIMITED'), JSON.stringify(limited.warnings));
  });
});

test('módulos de outros recursos ausentes ou quebrados: avisa (ausente) ou falha com explicação (quebrado)', { skip: skipMedia }, () => withSource(async (dir, src) => {
  try {
    const cut = {
      id: 'c', title: 't', start: 0.5, end: 1.5,
      audio: { gainDb: 6 }, subtitles: { enabled: true, mode: 'burn', cues: [{ start: 0, end: 1, text: 'x' }] }
    };
    optional._setOverrides({ audioFilter: { module: null }, burnIn: { module: null } });
    const res = await run(makeJob(dir, src, { cut, baseName: 'ausentes' }));
    assert.deepEqual(res.warnings.map((w) => w.code).sort(), ['AUDIO_UNAVAILABLE', 'SUBTITLES_UNAVAILABLE']);
    assert.ok(fs.existsSync(res.output), 'segue sem os módulos e avisa');

    optional._setOverrides({ burnIn: { module: { prepareBurnIn: () => { throw new Error('arquivo de fala corrompido'); } } } });
    await assert.rejects(run(makeJob(dir, src, { cut, baseName: 'quebrado1' })), (e) => e.code === 'SUBTITLES_FAILED' && /corrompido/.test(e.message) && typeof e.details.solution === 'string');
    optional._setOverrides({ burnIn: { module: { prepareBurnIn: () => { const e = new Error('Este FFmpeg não tem o filtro de legendas (libass).'); e.code = 'BURNIN_UNSUPPORTED'; throw e; } } } });
    await assert.rejects(run(makeJob(dir, src, { cut, baseName: 'quebrado2' })), { code: 'CODEC_UNSUPPORTED' });
    optional._setOverrides({ burnIn: null, audioFilter: { module: { buildAudioFilter: () => { throw new Error('ajuste inválido'); } } } });
    await assert.rejects(run(makeJob(dir, src, { cut: { ...cut, subtitles: null }, baseName: 'quebrado3' })), { code: 'AUDIO_FAILED' });

    // contrato: o módulo recebe o corte, a pasta temporária e o tamanho do quadro JÁ enquadrado; o filtro entra no vídeo
    const seen = {};
    optional._setOverrides({
      audioFilter: { module: { buildAudioFilter: (audio, opts) => { seen.audio = [audio, opts]; return 'volume=0'; } } },
      burnIn: { module: { prepareBurnIn: (c, opts) => { seen.burn = [c.id, opts.width, opts.height, typeof opts.tmpDir]; return { vfFilter: 'drawbox=x=0:y=0:w=iw:h=300:color=red@1:t=fill', sidecars: [] }; } } }
    });
    const ok = await run(makeJob(dir, src, { cut, baseName: 'contrato', profile: { ...VERTICAL, width: 720, height: 1280, kind: 'custom' } }));
    assert.deepEqual(seen.burn, ['c', 720, 1280, 'string']);
    assert.deepEqual(seen.audio[0], { gainDb: 6 });
    near(seen.audio[1].duration, 1, 1e-9, 'duração passada ao filtro de áudio');
    const frame = fx.decodeFile(ok.output, 720, 1280);
    const [r, g, b] = fx.pixel(frame, 360, 100);
    assert.ok(r > 200 && g < 60 && b < 60, `o filtro de legenda (barra vermelha) está no topo do quadro: ${[r, g, b]}`);
  } finally {
    optional._setOverrides(null);
  }
}));

test('legenda desligada: o módulo de legendas nem é chamado', { skip: skipMedia }, () => withSource(async (dir, src) => {
  try {
    let called = 0;
    optional._setOverrides({ burnIn: { module: { prepareBurnIn: () => { called++; return null; } } } });
    await run(makeJob(dir, src, { cut: { id: 'c', title: 't', start: 0.5, end: 1.5, subtitles: { enabled: false, cues: [] } }, baseName: 'desligada' }));
    assert.equal(called, 0);
  } finally { optional._setOverrides(null); }
}));

test('fonte sem áudio exporta só vídeo; ajuste de áudio não derruba o trabalho', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const res = await run(makeJob(dir, src, { sourceInfo: { width: 1280, height: 720, fps: 10, duration: 4, hasAudio: false }, cut: { id: 'c', title: 't', start: 0.5, end: 1.5, audio: { gainDb: 3 } } }));
  assert.equal(fx.probeStreams(res.output).streams.some((s) => s.codec_type === 'audio'), false);
}, { audio: false }));

// ---------- falha comum do ffmpeg no Windows não é "queda" (e a fila não repete à toa) ----------

test('AVERROR do ffmpeg lido sem sinal (4294967274…) é falha comum NÃO recuperável; só exceção do sistema ou sinal é queda', () => {
  const real = [4294967274, 4294967294, 3015096584, 4294967040, 4294967295, 2, 255];
  for (const code of real) {
    const err = classifyFailure({ code, signal: null, stderr: 'Error binding filtergraph inputs/outputs: Invalid argument' });
    assert.equal(err.code, 'FFMPEG_FAILED', `código ${code}`);
    assert.equal(err.recoverable, false, `código ${code}: repetir não resolve`);
    assert.equal(err.details.exitCode, code);
    assert.match(err.details.stderr, /Invalid argument/, 'o stderr fica nos detalhes técnicos');
  }
  for (const code of [3221225477, 3221225725, 3221226505, 3221225786, 0xC0000374]) {
    const err = classifyFailure({ code, signal: null, stderr: '' });
    assert.equal(err.code, 'FFMPEG_CRASH', `NTSTATUS ${code.toString(16)}`);
    assert.equal(err.recoverable, true);
  }
  assert.equal(classifyFailure({ code: null, signal: 'SIGKILL', stderr: '' }).code, 'FFMPEG_CRASH');
  // o ffmpeg real, contra argumentos que ele recusa, sai assim no Windows: o resultado da classificação não pode ser "queda"
  if (!skipMedia) {
    const r = spawnSync(tools.ffmpeg, ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-map', '0:a:5', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(r.status, 0);
    const err = classifyFailure({ code: r.status, signal: r.signal, stderr: r.stderr });
    assert.equal(err.code, 'FFMPEG_FAILED', `saída real ${r.status}`);
    assert.equal(err.recoverable, false);
  }
});

test('fonte sem faixa de vídeo (só áudio): falha NÃO recuperável, com a causa certa, uma única tentativa e nada sobra', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const audioOnly = path.join(dir, 'so-audio.m4a');
  fx.ffmpeg(['-i', src, '-vn', '-c:a', 'aac', audioOnly]);
  let started = 0;
  await assert.rejects(run(makeJob(dir, audioOnly), { onStart: () => { started += 1; } }), (err) => {
    assert.equal(err.code, 'FFMPEG_FAILED');
    assert.equal(err.recoverable, false, 'a fila não deve repetir: o resultado seria o mesmo');
    assert.match(err.message, /faixa de vídeo/);
    assert.match(err.details.solution, /vídeo de verdade/);
    assert.match(err.details.stderr, /matches no streams/, 'o stderr cru fica só nos detalhes técnicos');
    return true;
  });
  assert.equal(started, 1);
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));

test('falha NVENC durante o trabalho: o aviso da queda diz o motivo em português, sem a linha crua do ffmpeg', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const detection = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
  if (!detection.nvenc.h264.available) return;
  const profile = { ...VERTICAL, id: 'enorme', width: 5000, height: 5000, encoder: 'nvenc', kind: 'custom' };
  const res = await run(makeJob(dir, src, { profile, cut: { id: 'c', title: 't', start: 0.5, end: 1 }, baseName: 'enorme-pt' }));
  const w = res.warnings.find((x) => x.code === 'ENCODER_FALLBACK');
  assert.ok(w, 'avisou a queda');
  assert.doesNotMatch(w.message, /@|Nothing was written|packets|\[|nvenc @/i, `sem texto cru do ffmpeg: ${w.message}`);
  assert.match(w.message, /placa/);
  assert.match(w.message, /software/);
}));

// ------------------------------------------------------------------ limites vindos da fila (Etapa 3)

test('threadArgs: só pede núcleos quando a fila definiu um número maior que zero', () => {
  const { threadArgs } = require('../src/core/export/jobRunner');
  assert.deepEqual(threadArgs({ threads: 4 }), ['-threads', '4']);
  assert.deepEqual(threadArgs({ threads: 0 }), []);
  assert.deepEqual(threadArgs({}), []);
  assert.deepEqual(threadArgs(undefined), []);
  assert.deepEqual(threadArgs({ threads: 2.5 }), [], 'número quebrado não vira argumento');
});

test('withPriority: com prioridade baixa ligada, chama o observador original e baixa a do processo; desligada, devolve o mesmo observador', () => {
  const { withPriority } = require('../src/core/export/jobRunner');
  const seen = [];
  const original = (info) => seen.push(info.pid);
  assert.equal(withPriority(original, { lowPriority: false }), original);
  assert.equal(withPriority(original, undefined), original);
  const wrapped = withPriority(original, { lowPriority: true });
  assert.notEqual(wrapped, original);
  wrapped({ pid: 0 }); // pid inválido: não muda prioridade nenhuma, mas o observador continua sendo chamado
  assert.deepEqual(seen, [0]);
  assert.doesNotThrow(() => withPriority(undefined, { lowPriority: true })({ pid: 0 }));
});

test('com os limites da fila (núcleos e prioridade baixa) o ffmpeg de verdade exporta normalmente e o observador recebe o pid', { skip: skipMedia }, () => withSource(async (dir, src) => {
  const pids = [];
  const res = await run(makeJob(dir, src, { baseName: 'limitado' }), { limits: { lowPriority: true, threads: 2 }, onStart: ({ pid }) => pids.push(pid) });
  assert.equal(res.skipped, false);
  const info = await fx.probe(res.output);
  assert.deepEqual([info.width, info.height], [VERTICAL.width, VERTICAL.height]);
  assert.equal(pids.length, 1);
  assert.ok(Number.isInteger(pids[0]) && pids[0] > 0);
  assert.deepEqual(res.warnings, []);
  assert.ok(noPartIn(path.join(dir, 'saida')));
}));
