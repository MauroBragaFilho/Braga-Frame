'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./subtitles-helpers');
const registry = require('../src/core/tools/registry');
const { toolKeyFor } = require('../src/core/tools/catalog');
const { createContext } = require('../src/ipc/context');
const { loadHandlers } = require('../src/ipc');
const F = require('../src/core/subtitles/formats');
const sub = require('../src/ipc/handlers/subtitles');

/** ctx de verdade (createContext) com Electron falso; `resolver` define as ferramentas do sistema. */
function setup({ whisper = null, subtitlesOptions } = {}) {
  const userData = H.tmpDir('bf-subs-ipc-');
  const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe, whisper }) });
  const ctx = createContext(fe.deps);
  if (subtitlesOptions) ctx.subtitlesOptions = subtitlesOptions;
  sub.register(ctx);
  return { ctx, fe, userData, done: () => H.cleanup(userData) };
}

test('a entrada oficial do whisper existe, é válida e alimenta o ctx.tools.whisper', () => {
  const reg = registry.loadRegistry({ strict: true });
  const entry = reg.entries.find((e) => e.id === 'whisper');
  assert.ok(entry, 'src/core/tools/entries/whisper.js carregou');
  assert.equal(toolKeyFor('whisper'), 'whisper');
  assert.deepEqual(registry.validateEntry(entry), []);
  const win = registry.assetFor(entry, 'win32', 'x64');
  assert.equal(win.name, 'whisper-bin-x64.zip');
  assert.equal(win.kind, 'zip');
  assert.equal(win.stripComponents, 1);
  assert.equal(win.exe, 'whisper-cli.exe');
  assert.equal(win.size, 8573270);
  assert.equal(win.sha256, 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c');
  assert.match(win.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\/whisper-bin-x64\.zip$/);
  assert.match(entry.source, /^oficial: https:\/\/github\.com\/ggml-org\/whisper\.cpp\//);
  for (const key of Object.keys(entry.assets)) {
    const a = registry.assetFor(entry, ...key.split('-'));
    assert.match(a.url, /^https:\/\/github\.com\/ggml-org\/whisper\.cpp\/releases\/download\/b5130\//, key);
    assert.equal(a.sha256.length, 64);
  }
  assert.equal(registry.assetFor(entry, 'darwin', 'arm64'), null, 'macOS: o projeto oficial não publica o whisper-cli');
  assert.match(registry.unavailableReason(entry, 'darwin', 'arm64'), /não publica/);
});

test('o handler carrega pelo carregador da base e registra todos os canais', () => {
  const userData = H.tmpDir('bf-subs-ipc-');
  try {
    const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg }) });
    const ctx = createContext(fe.deps);
    const out = loadHandlers(ctx);
    assert.deepEqual(out.failed, [], JSON.stringify(out.failed));
    assert.ok(out.loaded.includes('subtitles.js'));
    for (const c of ['status', 'installModel', 'cancelModel', 'removeModel', 'generate', 'cancel', 'importFile', 'hardware', 'transcript']) assert.ok(ctx.channels.has(`subtitles:${c}`), c);
  } finally { H.cleanup(userData); }
});

test('subtitles:status sem motor nem modelo: diz o que falta, com tamanhos e fonte', async () => {
  const t = setup();
  try {
    const s = await t.fe.call('subtitles:status');
    assert.equal(s.ok, true);
    assert.equal(s.engine.installed, false);
    assert.equal(s.engine.origin, null);
    assert.equal(s.engine.available, true);
    assert.equal(s.engine.sizeBytes, 8573270);
    assert.match(s.engine.source, /oficial/);
    assert.equal(s.ffmpeg.found, Boolean(H.tools.ffmpeg));
    assert.deepEqual(s.models.map((m) => m.id), ['tiny', 'base', 'small', 'medium', 'large-v3-turbo']);
    assert.ok(s.models.every((m) => m.installed === false && m.busy === false));
    assert.equal(s.models.filter((m) => m.recommended).map((m) => m.id).join(), 'small');
    assert.equal(s.defaultModel, 'small');
    assert.ok(s.languages.some((l) => l.code === 'pt') && s.languages.some((l) => l.code === 'auto'));
    assert.ok(Array.isArray(s.fonts) && s.fonts.length >= 5 && s.fonts.every((f) => typeof f.available === 'boolean'));
    assert.equal(typeof s.burnIn.supported, 'boolean');
    assert.deepEqual(s.generating, []);
    assert.equal(s.limits.maxSeconds, 1800);
    assert.equal(t.ctx.toolUsage.inUse('whisper', 'whisper'), null, 'ocioso: não bloqueia a remoção/atualização do motor');
  } finally { t.done(); }
});

test('subtitles:status com o motor do sistema (CORTE_WHISPER/PATH): origem "system"', async () => {
  const t = setup({ whisper: process.execPath });
  try {
    const s = await t.fe.call('subtitles:status');
    assert.equal(s.engine.installed, true);
    assert.equal(s.engine.origin, 'system');
    assert.equal(s.engine.path, process.execPath);
  } finally { t.done(); }
});

test('modelos pelo IPC: instalar com progresso e eventos, reinstalar sem rede, remover', async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(400 * 1024) });
  const t = setup({ subtitlesOptions: { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } });
  try {
    const res = await t.fe.call('subtitles:installModel', { id: 'tiny' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.installed, true);
    assert.equal(res.alreadyInstalled, false);
    assert.equal(res.sizeBytes, hub.data.length);

    const events = t.fe.sent.filter(([c]) => c === 'subtitles:modelProgress').map(([, p]) => p);
    assert.ok(events.length >= 3);
    assert.ok(events.every((e) => e.id === 'tiny'), 'o id do modelo (não o da entrada do instalador)');
    assert.ok(events.some((e) => e.phase === 'download' && e.received > 0 && e.total === hub.data.length));
    assert.equal(events.at(-1).phase, 'done');

    const status = await t.fe.call('subtitles:status');
    const tiny = status.models.find((m) => m.id === 'tiny');
    assert.equal(tiny.installed, true);
    assert.equal(tiny.installedSizeBytes, hub.data.length);

    const requests = hub.requests.length;
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'tiny' })).alreadyInstalled, true);
    assert.equal(hub.requests.length, requests, 'sem rede quando já está instalado');

    const removed = await t.fe.call('subtitles:removeModel', { id: 'tiny' });
    assert.deepEqual([removed.ok, removed.removed], [true, true]);
    assert.equal((await t.fe.call('subtitles:status')).models.find((m) => m.id === 'tiny').installed, false);

    // erros
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'nao-existe' })).code, 'UNKNOWN_MODEL');
    assert.equal((await t.fe.call('subtitles:removeModel', { id: 'nao-existe' })).code, 'UNKNOWN_MODEL');
    assert.equal((await t.fe.call('subtitles:installModel', {})).code, 'UNKNOWN_MODEL');
    assert.deepEqual(await t.fe.call('subtitles:cancelModel', { id: 'tiny' }), { ok: true, cancelled: false });
  } finally { await hub.close(); t.done(); }
});

test('cancelar o download do modelo pelo IPC (e ao fechar o app) não deixa nada no disco', async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(2 * 1024 * 1024), slow: true });
  const t = setup({ subtitlesOptions: { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } });
  try {
    const pending = t.fe.call('subtitles:installModel', { id: 'tiny' });
    await new Promise((resolve) => { const w = setInterval(() => { if (t.fe.sent.some(([c, p]) => c === 'subtitles:modelProgress' && p.received > 100 * 1024)) { clearInterval(w); resolve(); } }, 20); });
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'tiny' })).code, 'BUSY', 'o mesmo modelo não baixa em duplicidade');
    assert.equal((await t.fe.call('subtitles:removeModel', { id: 'tiny' })).code, 'BUSY', 'não remove enquanto baixa');
    assert.deepEqual(await t.fe.call('subtitles:cancelModel', { id: 'tiny' }), { ok: true, cancelled: true });
    const res = await pending;
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CANCELLED');
    assert.deepEqual(H.listTree(path.join(t.userData, 'models')), [], 'sem modelo, sem .part, sem pasta de trabalho');

    // fechar o app no meio também cancela
    const second = t.fe.call('subtitles:installModel', { id: 'tiny' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    t.fe.quit();
    assert.equal((await second).code, 'CANCELLED');
    assert.deepEqual(H.listTree(path.join(t.userData, 'models')), []);
  } finally { await hub.close(); t.done(); }
});

test('subtitles:generate: pedidos inválidos e o que falta (motor, modelo, FFmpeg) com mensagem e código', async () => {
  const t = setup();
  const hub = await H.fakeHub({ data: crypto.randomBytes(50 * 1024) });
  try {
    const call = (payload) => t.fe.call('subtitles:generate', payload);
    const ok = { cutId: 'c1', input: process.execPath, start: 0, end: 5 };
    assert.equal((await call({ input: 'x' })).code, 'INVALID_ARGS');
    assert.equal((await call({ cutId: 'c1' })).code, 'INVALID_ARGS');
    assert.equal((await call({ ...ok, modelId: 'nao-existe' })).code, 'UNKNOWN_MODEL');
    const noEngine = await call(ok);
    assert.equal(noEngine.code, 'NO_ENGINE');
    assert.match(noEngine.message, /Instale/);
    assert.equal(noEngine.ok, false);

    // com motor mas sem o modelo
    const t2 = setup({ whisper: process.execPath });
    try {
      const noModel = await t2.fe.call('subtitles:generate', ok);
      assert.equal(noModel.code, 'NO_MODEL');
      assert.match(noModel.message, /Pequeno/);
      assert.match(noModel.message, /Baixe/);
    } finally { t2.done(); }

    // sem FFmpeg
    const userData = H.tmpDir('bf-subs-ipc-');
    try {
      const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: null, ffprobe: null, whisper: process.execPath }) });
      const ctx = createContext(fe.deps);
      sub.register(ctx);
      assert.equal((await fe.call('subtitles:generate', ok)).code, 'NO_FFMPEG');
      const st = await fe.call('subtitles:status');
      assert.equal(st.ffmpeg.found, false);
      assert.equal(st.burnIn.supported, false);
      assert.match(st.burnIn.reason, /FFmpeg/);
    } finally { H.cleanup(userData); }

    assert.deepEqual(await t.fe.call('subtitles:cancel', { cutId: 'nao-existe' }), { ok: true, cancelled: false });
  } finally { await hub.close(); t.done(); }
});

test('subtitles:importFile: SRT e ASS (UTF-8 e Windows-1252), cancelamento e arquivos inválidos', async () => {
  const t = setup();
  const dir = H.tmpDir('bf-subs-imp-');
  try {
    const pick = async (file, payload = {}) => { t.fe.dialogs.next = file ? { canceled: false, filePaths: [file] } : { canceled: true, filePaths: [] }; return t.fe.call('subtitles:importFile', payload); };

    const srt = path.join(dir, 'aula.srt');
    fs.writeFileSync(srt, F.cuesToSrt([{ start: 1, end: 2.5, text: 'Olá, ação rápida' }, { start: 3, end: 4, text: 'segunda' }]), 'utf8');
    const a = await pick(srt, { defaultDir: dir });
    assert.deepEqual([a.ok, a.canceled, a.name, a.format], [true, false, 'aula.srt', 'srt']);
    assert.deepEqual(a.cues, [{ start: 1, end: 2.5, text: 'Olá, ação rápida' }, { start: 3, end: 4, text: 'segunda' }]);
    const opts = t.fe.dialogs.calls.at(-1);
    assert.equal(opts.defaultPath, dir);
    assert.deepEqual(opts.filters[0].extensions, ['srt', 'ass', 'ssa']);

    const ansi = path.join(dir, 'antiga.srt'); // Windows-1252: "ação" em bytes soltos
    fs.writeFileSync(ansi, Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nAção rápida\r\n', 'latin1'));
    assert.equal((await pick(ansi)).cues[0].text, 'Ação rápida');

    const ass = path.join(dir, 'estilo.ass');
    fs.writeFileSync(ass, F.cuesToAss([{ start: 5, end: 6, text: 'em ASS' }], {}, { width: 1080, height: 1920 }), 'utf8');
    const b = await pick(ass);
    assert.equal(b.format, 'ass');
    assert.deepEqual(b.cues, [{ start: 5, end: 6, text: 'em ASS' }]);

    assert.deepEqual(await pick(null), { ok: true, canceled: true });

    const bad = path.join(dir, 'x.txt');
    fs.writeFileSync(bad, 'nada');
    const r1 = await pick(bad);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'BAD_FORMAT');
    const empty = path.join(dir, 'vazia.srt');
    fs.writeFileSync(empty, 'isto não é uma legenda');
    const r2 = await pick(empty);
    assert.equal(r2.code, 'EMPTY');
    assert.match(r2.message, /Não encontrei nenhuma fala/);
    const big = path.join(dir, 'grande.srt');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 10, 65));
    assert.equal((await pick(big)).code, 'TOO_BIG');
    assert.equal((await pick(path.join(dir, 'sumiu.srt'))).code, 'INPUT_MISSING');
  } finally { H.cleanup(dir); t.done(); }
});

test('decodeText: UTF-8 válido, com BOM, e Windows-1252 como segunda chance', () => {
  assert.equal(sub.decodeText(Buffer.from('ação', 'utf8')), 'ação');
  assert.equal(sub.decodeText(Buffer.from('ação', 'latin1')), 'ação');
  assert.equal(sub.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ação', 'utf8')])), 'ação', 'UTF-8 com BOM: o BOM sai');
});

test('decodeText: UTF-16 com BOM (o "Unicode" do Bloco de Notas), little e big endian, é lido como texto (antes virava lixo e "nenhuma fala")', () => {
  const text = '1\r\n00:00:01,000 --> 00:00:02,000\r\nAção rápida 日本語\r\n';
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le);
  for (let i = 2; i + 1 < be.length; i += 2) { const a = be[i]; be[i] = be[i + 1]; be[i + 1] = a; }
  be[0] = 0xfe; be[1] = 0xff;
  assert.equal(sub.decodeText(le), text);
  assert.equal(sub.decodeText(be), text);
  assert.equal(sub.decodeText(Buffer.from([0xff, 0xfe])), '', 'só o BOM: texto vazio, sem erro');
  assert.equal(F.parseSrt(sub.decodeText(le))[0].text, 'Ação rápida 日本語');
});

test('subtitles:importFile: SRT em UTF-16 (LE e BE) importa; o texto de erro cita as codificações aceitas', async () => {
  const t = setup();
  const dir = H.tmpDir('bf-subs-imp-');
  try {
    const pick = async (file) => { t.fe.dialogs.next = { canceled: false, filePaths: [file] }; return t.fe.call('subtitles:importFile', {}); };
    const srt = F.cuesToSrt([{ start: 1, end: 2.5, text: 'Olá, ação' }, { start: 3, end: 4, text: 'segunda' }]).replace(/\n/g, '\r\n');
    const le = path.join(dir, 'unicode-le.srt');
    fs.writeFileSync(le, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(srt, 'utf16le')]));
    const a = await pick(le);
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.deepEqual(a.cues, [{ start: 1, end: 2.5, text: 'Olá, ação' }, { start: 3, end: 4, text: 'segunda' }]);
    const beBytes = Buffer.from(srt, 'utf16le');
    for (let i = 0; i + 1 < beBytes.length; i += 2) { const x = beBytes[i]; beBytes[i] = beBytes[i + 1]; beBytes[i + 1] = x; }
    const be = path.join(dir, 'unicode-be.srt');
    fs.writeFileSync(be, Buffer.concat([Buffer.from([0xfe, 0xff]), beBytes]));
    assert.deepEqual((await pick(be)).cues.map((c) => c.text), ['Olá, ação', 'segunda']);
    const bad = path.join(dir, 'outra-codificacao.srt');
    fs.writeFileSync(bad, Buffer.from('1\u0000\u0000\u0000', 'latin1'));
    const r = await pick(bad);
    assert.equal(r.code, 'EMPTY');
    assert.match(r.message, /UTF-8, UTF-16 ou Windows-1252/);
  } finally { H.cleanup(dir); t.done(); }
});

test('subtitles:importFile com legenda hostil de ~200 KB: responde na hora (o parse roda no processo principal e travava)', async () => {
  const t = setup();
  const dir = H.tmpDir('bf-subs-imp-');
  try {
    const pick = async (file) => { t.fe.dialogs.next = { canceled: false, filePaths: [file] }; const t0 = Date.now(); const res = await t.fe.call('subtitles:importFile', {}); return { res, ms: Date.now() - t0 }; };
    const srt = path.join(dir, 'hostil.srt');
    fs.writeFileSync(srt, `1\n00:00:01,000 --> 00:00:02,000\n${'<a'.repeat(100000)}`);
    const ass = path.join(dir, 'hostil.ass');
    fs.writeFileSync(ass, `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,${'{'.repeat(400000)}`);
    for (const file of [srt, ass]) {
      const { res, ms } = await pick(file);
      assert.equal(res.ok, true, JSON.stringify(res).slice(0, 200));
      assert.equal(res.cues.length, 1);
      assert.ok(ms < 3000, `${path.basename(file)}: ${ms} ms (o defeito levava de 7 a 14 s)`);
    }
  } finally { H.cleanup(dir); t.done(); }
});

test('subtitles:generate NÃO repassa "silence" do renderer ao ffmpeg (era injeção de filtro: ametadata sobrescrevia arquivo do usuário)', { skip: H.tools.ffmpeg ? false : 'ffmpeg não encontrado' }, async () => {
  const hub = await H.fakeHub({ data: crypto.randomBytes(60 * 1024) });
  const t = setup({ whisper: process.execPath, subtitlesOptions: { models: { baseUrl: hub.base, catalog: H.pinnedCatalog(hub), allowLoopbackHttp: true } } });
  const dir = H.tmpDir('bf-subs-inj-');
  const cwd = process.cwd();
  try {
    assert.equal((await t.fe.call('subtitles:installModel', { id: 'tiny' })).ok, true);
    const video = H.makeVideo(path.join(dir, 'mudo.mp4'), [{ silence: 3 }]);
    const victim = path.join(dir, 'ARQUIVO_DO_USUARIO.txt');
    fs.writeFileSync(victim, 'conteudo importante do usuario');
    process.chdir(dir); // o caminho relativo do filtro injetado cairia aqui
    const file = 'ametadata=mode=print:file=ARQUIVO_DO_USUARIO.txt';
    const hostile = [
      { noiseDb: `-50dB:d=1,${file},silencedetect=noise=-50` },
      { minSilence: `1,${file}` },
      { noiseDb: -50, minSilence: 1, pad: 0.3, extra: file }
    ];
    for (const silence of hostile) {
      const res = await t.fe.call('subtitles:generate', { cutId: 'c1', input: video.file, start: 0, end: 3, modelId: 'tiny', silence });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.reason, 'silence', 'áudio mudo: nenhuma fala, sem chamar o motor');
      assert.equal(fs.readFileSync(victim, 'utf8'), 'conteudo importante do usuario', `o arquivo do usuário continua intacto (${Object.keys(silence)})`);
    }
    assert.deepEqual(fs.readdirSync(dir).filter((n) => !/^(mudo\.mp4|ARQUIVO_DO_USUARIO\.txt)$/.test(n)), [], 'nenhum arquivo novo apareceu');
  } finally { process.chdir(cwd); await hub.close(); H.cleanup(dir); t.done(); }
});

// ------------------------------------------------------------------ legenda do corte a partir da transcrição do vídeo

test('subtitles:transcript: sem transcrição, de outro arquivo e válida (com e sem as falas); e as falas viram falas do corte sem rodar o Whisper', async () => {
  const userData = H.tmpDir('bf-subs-tr-');
  try {
    const fe = H.fakeElectron(userData, { resolveTools: () => ({ ffmpeg: H.tools.ffmpeg, ffprobe: H.tools.ffprobe }) });
    const ctx = createContext(fe.deps);
    assert.deepEqual(loadHandlers(ctx).failed, []);
    const source = { path: 'C:\\lives\\a.mp4', size: 1000, duration: 600 };
    const ask = (extra = {}) => fe.call('subtitles:transcript', { projectId: 'p1', ...source, ...extra });
    assert.deepEqual(await fe.call('subtitles:transcript', {}), { ok: true, exists: false }, 'sem projeto');
    assert.deepEqual(await ask(), { ok: true, exists: false }, 'sem transcrição');
    const { buildDocument } = require('../src/core/analysis/transcript/format');
    const cues = [{ start: 8, end: 12, text: 'antes e dentro' }, { start: 20, end: 24, text: 'dentro' }, { start: 28, end: 35, text: 'dentro e depois' }, { start: 50, end: 52, text: 'fora' }];
    ctx.analysis.ai.store.save('p1', buildDocument({ projectId: 'p1', origin: 'imported', source, cues, dropped: { invalid: 0, beyond: 0, repeats: 0 } }));
    const info = await ask();
    assert.deepEqual([info.exists, info.stale, info.count, info.cues], [true, false, 4, undefined], 'sem withCues não manda as falas');
    const got = await ask({ withCues: true });
    assert.deepEqual(got.cues.map((c) => [c.start, c.end, c.text]), cues.map((c) => [c.start, c.end, c.text]));
    assert.deepEqual(await ask({ path: 'C:\\lives\\outro.mp4', withCues: true }), { ok: true, exists: true, stale: true }, 'outro arquivo: nunca devolve falas');
    // o corte 10–30 s: relativas ao corte, as das bordas recortadas e marcadas para revisão
    const S = require('../src/core/subtitles/shared');
    const out = S.importCuesForCut(got.cues, { start: 10, end: 30 });
    assert.deepEqual(out.cues.map((c) => [c.start, c.end, c.text, Boolean(c.needsReview)]), [[0, 2, 'antes e dentro', true], [10, 14, 'dentro', false], [18, 20, 'dentro e depois', true]]);
    assert.equal(out.clipped, 2);
  } finally { H.cleanup(userData); }
});
