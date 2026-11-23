'use strict';

/**
 * A transcrição do vídeo inteiro por dentro do app, com o serviço do motor de legendas de verdade (handlers/subtitles.js) e um
 * motor/modelo de mentira (instalado por um servidor local, como nos testes de legendas): prontidão com o motivo, "uma por vez" junto das
 * legendas dos cortes, vídeo mudo sem fala inventada e o motor sempre liberado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const { createContext } = require('../src/ipc/context');
const sub = require('../src/ipc/handlers/subtitles');
const analysis = require('../src/ipc/handlers/analysis');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, ms = 20000, what = 'condição') {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(20); }
  throw new Error(`Tempo esgotado esperando: ${what}`);
}

function setup({ whisper = null, subtitlesOptions } = {}) {
  const userData = H.tmpDir('bf-tr-ipc-');
  const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper }) });
  const ctx = createContext(fe.deps);
  if (subtitlesOptions) ctx.subtitlesOptions = subtitlesOptions;
  sub.register(ctx);
  analysis.register(ctx);
  const events = (name) => fe.sent.filter(([channel]) => channel === name).map(([, payload]) => payload);
  return { ctx, fe, userData, events, done: () => H.cleanup(userData) };
}

test('prontidão da transcrição: diz o motivo (sem motor, sem modelo) e fica pronta com os dois', { skip: H.tools.ffmpeg ? false : 'ffmpeg não encontrado' }, async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(60 * 1024) });
  const opts = { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } };
  const none = setup({ subtitlesOptions: opts });
  const ready = setup({ whisper: process.execPath, subtitlesOptions: opts });
  try {
    const a = await none.ctx.transcription.readiness({ modelId: 'tiny' });
    assert.equal(a.ready, false);
    assert.match(a.reason, /motor de transcrição/);
    assert.match(a.reason, /aba Ferramentas/, 'o texto aponta o lugar que instala (as Legendas só abrem com um corte)');
    assert.deepEqual(a.needs, { ffmpeg: false, engine: true, model: true }, 'sem o motor, falta o motor e o modelo (o ffmpeg está aí)');
    const b = await ready.ctx.transcription.readiness({ modelId: 'tiny' });
    assert.equal(b.ready, false);
    assert.match(b.reason, /modelo .* ainda não foi baixado/);
    assert.match(b.reason, /aba Ferramentas/);
    assert.deepEqual(b.needs, { ffmpeg: false, engine: false, model: true });
    assert.equal((await ready.fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
    const c = await ready.ctx.transcription.readiness({ modelId: 'tiny' });
    assert.equal(c.ready, true);
    assert.deepEqual(c.needs, { ffmpeg: false, engine: false, model: false });
    assert.equal(c.device, 'CPU');
    assert.equal(c.busy, false);
    const unknown = await ready.ctx.transcription.readiness({ modelId: 'nao-existe' });
    assert.equal(unknown.ready, false);
    assert.equal(unknown.needs.model, false, 'modelo desconhecido: instalar não resolve, então a tela não oferece o botão');
    // o status do canal usa a mesma prontidão
    const st = await ready.fe.call('analysis:transcriptStatus', { projectId: 'p1', path: 'x.mp4', size: 1, duration: 10, modelId: 'tiny' });
    assert.equal(st.ok, true);
    assert.equal(st.engine.ready, true);
    assert.equal(st.engine.modelId, 'tiny');
    const dflt = await ready.fe.call('analysis:transcriptStatus', { projectId: 'p1', path: 'x.mp4', size: 1, duration: 10 });
    assert.equal(dflt.engine.ready, true, 'sem escolha, usa o modelo que já está instalado (não obriga a baixar o Pequeno)');
    assert.equal(dflt.engine.modelId, 'tiny');
    const nothing = await none.ctx.transcription.readiness({});
    assert.equal(nothing.modelId, 'small', 'sem nenhum modelo instalado, o padrão continua sendo o Pequeno (o recomendado)');
    assert.equal(none.ctx.transcription.defaultModelId, 'small');
    assert.equal(ready.ctx.transcription.defaultModelId, 'tiny');
  } finally { await hub.close(); none.done(); ready.done(); }
});

test('vídeo mudo: nenhuma fala inventada (o motor nem é chamado), erro claro, motor liberado e nada guardado', { skip: H.tools.ffmpeg ? false : 'ffmpeg não encontrado' }, async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(60 * 1024) });
  const t = setup({ whisper: process.execPath, subtitlesOptions: { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } });
  const dir = H.tmpDir('bf-tr-media-');
  try {
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
    const video = H.makeVideo(path.join(dir, 'mudo.mp4'), [{ silence: 4 }]);
    const src = { projectId: 'p1', path: video.file, size: fs.statSync(video.file).size, duration: video.duration };
    const start = await t.fe.call('analysis:transcriptGenerate', { ...src, modelId: 'tiny', language: 'pt' });
    assert.equal(start.ok, true, JSON.stringify(start));
    const failed = await waitFor(() => t.events('analysis:transcriptFailed')[0], 30000, 'falha por falta de fala');
    assert.equal(failed.code, 'NO_SPEECH');
    assert.match(failed.message, /Não encontrei fala/);
    assert.equal((await t.fe.call('analysis:transcriptStatus', src)).transcript.exists, false);
    // o motor foi liberado: uma geração de legenda de corte volta a ser aceita (não responde BUSY)
    const sub1 = await t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny' });
    assert.equal(sub1.ok, true, JSON.stringify(sub1));
    assert.equal(sub1.reason, 'silence');
  } finally { await hub.close(); H.cleanup(dir); t.done(); }
});

test('transcrever e legendar um corte não rodam ao mesmo tempo (um só motor), e o aviso diz o porquê', { skip: H.tools.ffmpeg ? false : 'ffmpeg não encontrado' }, async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(60 * 1024) });
  const t = setup({ whisper: process.execPath, subtitlesOptions: { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } });
  const dir = H.tmpDir('bf-tr-media-');
  try {
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
    const run = await t.ctx.transcription.prepareRun({ key: 'transcript:x', modelId: 'tiny', engine: 'cpu' });
    assert.equal(run.genOptions.useGpu, false);
    assert.equal(run.genOptions.ffmpeg, H.tools.ffmpeg);
    assert.ok(run.genOptions.modelPath.endsWith('.bin') || fs.existsSync(run.genOptions.modelPath));
    const video = H.makeVideo(path.join(dir, 'a.mp4'), [{ silence: 3 }]);
    const busy = await t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny' });
    assert.equal(busy.ok, false);
    assert.equal(busy.code, 'BUSY');
    await assert.rejects(() => t.ctx.transcription.prepareRun({ key: 'transcript:y', modelId: 'tiny' }), (e) => e.code === 'BUSY');
    // o motor em uso não pode ser removido (a aba Ferramentas pergunta ao toolUsage)
    assert.ok(t.ctx.toolUsage.inUse('whisper', 'whisper'));
    t.ctx.transcription.releaseRun(run);
    assert.equal(t.ctx.toolUsage.inUse('whisper', 'whisper'), null);
    // modelo desconhecido e FFmpeg ausente
    await assert.rejects(() => t.ctx.transcription.prepareRun({ key: 'k', modelId: 'nada' }), (e) => e.code === 'UNKNOWN_MODEL');
  } finally { await hub.close(); H.cleanup(dir); t.done(); }
});
