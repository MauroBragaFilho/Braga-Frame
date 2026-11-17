'use strict';

/**
 * Handler tools:* (src/ipc/handlers/tools.js) com um ctx falso (ipcMain/app/dialog/shell de mentira) e um
 * servidor HTTP local de verdade; a extração é a real (tar do sistema). Sem abrir o Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createContext } = require('../src/ipc/context');
const { register, parseVersion } = require('../src/ipc/handlers/tools');
const { locateTools } = require('../src/core/ffmpeg/locate');
const { tmpDir, cleanup, makeZip, startServer, sendBuffer, makeEntry, listTree } = require('./tools-fixtures');

const T = { timeout: 30000 };
const KEY = `${process.platform}-${process.arch}`;
const real = locateTools();
const silent = { log() {}, info() {}, warn() {}, error() {} };

const zipOf = (exe = 'whisper-cli.exe') => makeZip([{ name: exe, data: 'MZ-programa-de-teste' }, { name: 'lib/dados.txt', data: 'dados' }]);

/** ctx de verdade (createContext) com Electron falso; o handler de ferramentas registrado sozinho. */
function setup(base, { entries, testIds = [], appExtra = {}, env = {} } = {}) {
  const handlers = new Map();
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (channel, payload) => sent.push([channel, payload]) } };
  const sysWhisper = path.join(base, 'whisper-do-sistema.exe');
  fs.writeFileSync(sysWhisper, 'sistema');
  const deps = {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    app: { getPath: () => path.join(base, 'userdata'), getVersion: () => '9.9.9', ...appExtra },
    dialog: {}, shell: {},
    getWindow: () => win,
    logger: silent,
    env: { ...process.env, CORTE_WHISPER: sysWhisper, CORTE_TWITCHDOWNLOADER: '', CORTE_FFMPEG: real.ffmpeg || '', CORTE_FFPROBE: real.ffprobe || '', ...env },
    toolCatalog: { entries, errors: [], allowLoopbackHttp: true, testIds }
  };
  const ctx = createContext(deps);
  register(ctx);
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  const events = (channel) => sent.filter(([c]) => c === channel).map(([, p]) => p);
  return { ctx, call, sent, events, handlers, sysWhisper, toolsDir: ctx.paths.tools };
}

async function withEnv(fn) {
  const base = tmpDir();
  try { await fn(base); } finally { cleanup(base); }
}

const waitUntil = async (cond, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('tempo esgotado esperando a condição');
};

/** Manda só o começo do arquivo e segura a conexão até o cliente desistir (instalação "em andamento"). */
function holdingServer(buf, sentBytes = 8192) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Length': buf.length });
    // SEGURA de verdade: nunca manda o último byte (o zip de teste tem ~260 bytes, menos que `sentBytes`; mandá-lo inteiro
    // deixava o download terminar e a instalação acabar em poucos ms, e o teste só passava se a leitura de `busy` fosse rápida)
    res.write(buf.subarray(0, Math.min(sentBytes, Math.max(1, buf.length - 1))));
  };
}

// ------------------------------------------------------------------ auxiliares

test('parseVersion: versões de release, de data e de git viram texto curto', () => {
  assert.equal(parseVersion('ffmpeg version 7.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2025'), '7.1.1-essentials_build-www.gyan.dev');
  assert.equal(parseVersion('ffprobe version n7.1.1 Copyright'), '7.1.1');
  assert.equal(parseVersion('ffmpeg version 2026-02-09-git-9bfa1635ae-full_build-www.gyan.dev Copyright'), 'build 2026-02-09');
  assert.equal(parseVersion('ffmpeg version N-125875-g5d4d3bdc61-20260101 Copyright'), 'build N-125875');
  assert.equal(parseVersion('sem versão aqui'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
});

test('registra os quatro canais tools:* e carrega junto dos demais handlers', () => {
  const dir = tmpDir();
  try {
    const { handlers } = setup(dir, { entries: [] });
    for (const channel of ['tools:status', 'tools:install', 'tools:cancel', 'tools:remove']) assert.ok(handlers.has(channel), channel);
  } finally { cleanup(dir); }
});

// ------------------------------------------------------------------ status

test('tools:status com o registro vazio devolve só FFmpeg e FFprobe do sistema, com versão', T, async () => {
  await withEnv(async (base) => {
    const s = setup(base, { entries: [] });
    const res = await s.call('tools:status');
    assert.equal(res.ok, true);
    assert.equal(res.platform, process.platform);
    assert.deepEqual(res.tools, []);
    assert.deepEqual(res.system.map((x) => x.id), ['ffmpeg', 'ffprobe']);
    if (real.ffmpeg && real.ffprobe) {
      for (const item of res.system) {
        assert.equal(item.found, true);
        assert.equal(item.path, real[item.id]);
        assert.match(item.version, /\S/, `${item.id}: versão detectada`);
      }
    }
  });
});

test('tools:status sem FFmpeg no sistema: found=false, sem caminho nem versão', T, async () => {
  await withEnv(async (base) => {
    const s = setup(base, { entries: [] });
    s.ctx.tools.ffmpeg = null;
    s.ctx.tools.ffprobe = '';
    const res = await s.call('tools:status');
    assert.deepEqual(res.system.map((x) => [x.id, x.found, x.path, x.version]), [['ffmpeg', false, null, null], ['ffprobe', false, null, null]]);
  });
});

test('tools:status: versão de um programa que não executa fica null (e o caminho continua visível)', T, async () => {
  await withEnv(async (base) => {
    const fake = path.join(base, 'ffmpeg-falso.exe');
    fs.writeFileSync(fake, 'isto não é um programa');
    const s = setup(base, { entries: [] });
    s.ctx.tools.ffmpeg = fake;
    const [ffmpeg] = (await s.call('tools:status')).system;
    assert.deepEqual([ffmpeg.found, ffmpeg.path, ffmpeg.version], [true, fake, null]);
  });
});

// ------------------------------------------------------------------ instalar e remover

test('instalar e remover de ponta a ponta: progresso, tools:changed, ctx.tools e prioridade sobre a do sistema', T, async () => {
  await withEnv(async (base) => {
    const buf = zipOf();
    const srv = await startServer((req, res) => sendBuffer(res, buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, id: 'whisper', version: 'b9', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY });
      const s = setup(base, { entries: [entry], testIds: ['whisper'] });

      // antes: só a cópia "do sistema" (CORTE_WHISPER)
      assert.equal(s.ctx.tools.whisper, s.sysWhisper);
      let st = await s.call('tools:status');
      assert.deepEqual(st.tools.map((t) => [t.id, t.installed, t.active.origin, t.active.path, t.test, t.busy]), [['whisper', false, 'system', s.sysWhisper, true, false]]);
      assert.equal(st.tools[0].available, true);
      assert.equal(st.tools[0].sizeBytes, buf.length);
      assert.equal(st.tools[0].version, 'b9');
      assert.equal(st.tools[0].source, entry.source);

      // instala
      const res = await s.call('tools:install', { id: 'whisper' });
      const exe = path.join(s.toolsDir, 'whisper', 'b9', 'whisper-cli.exe');
      assert.deepEqual([res.ok, res.id, res.version, res.path, res.alreadyInstalled], [true, 'whisper', 'b9', exe, false]);
      assert.equal(fs.readFileSync(exe, 'utf8'), 'MZ-programa-de-teste');
      assert.equal(s.ctx.tools.whisper, exe, 'a instalada pelo app vence a do sistema');

      // eventos: progresso no formato do contrato e tools:changed com o novo caminho
      const progress = s.events('tools:progress');
      assert.deepEqual([...new Set(progress.map((p) => p.phase))], ['prepare', 'download', 'verify', 'extract', 'install', 'done']);
      for (const p of progress) {
        assert.deepEqual(Object.keys(p).sort(), ['id', 'label', 'message', 'percent', 'phase', 'received', 'speedBps', 'total']);
        assert.equal(p.id, 'whisper');
      }
      const lastDownload = progress.filter((p) => p.phase === 'download').at(-1);
      assert.deepEqual([lastDownload.received, lastDownload.total, lastDownload.percent], [buf.length, buf.length, 100]);
      assert.equal(s.events('tools:changed').length, 1);
      assert.equal(s.events('tools:changed')[0].tools.whisper, exe);

      st = await s.call('tools:status');
      assert.deepEqual([st.tools[0].installed, st.tools[0].active.origin, st.tools[0].active.path, st.tools[0].installedVersion], [true, 'app', exe, 'b9']);
      assert.ok(st.tools[0].installedAt);

      // instalar de novo não baixa nada, mas a tela é avisada
      const requests = srv.requests.length;
      const again = await s.call('tools:install', { id: 'whisper' });
      assert.equal(again.alreadyInstalled, true);
      assert.equal(srv.requests.length, requests, 'não baixou de novo');
      assert.equal(s.events('tools:changed').length, 2);

      // remove: volta para a do sistema
      const removed = await s.call('tools:remove', { id: 'whisper' });
      assert.deepEqual([removed.ok, removed.id, removed.removed], [true, 'whisper', true]);
      assert.equal(s.ctx.tools.whisper, s.sysWhisper);
      assert.equal(s.events('tools:changed').length, 3);
      assert.equal(s.events('tools:changed')[2].tools.whisper, s.sysWhisper);
      assert.equal((await s.call('tools:status')).tools[0].active.origin, 'system');
      assert.deepEqual(listTree(s.toolsDir), [], 'nada sobrou na pasta de ferramentas (nem .tmp)');

      assert.equal((await s.call('tools:remove', { id: 'whisper' })).removed, false, 'remover o que não está instalado não é erro');
    } finally { await srv.close(); }
  });
});

test('erros explicados: id ausente/desconhecido, SHA-256 errado e plataforma sem pacote; nada fica instalado', T, async () => {
  await withEnv(async (base) => {
    const good = zipOf();
    const evil = Buffer.from(good);
    evil[evil.length - 30] ^= 0xff; // mesmo tamanho, outro conteúdo
    const srv = await startServer((req, res) => sendBuffer(res, req.url === '/ruim.zip' ? evil : good));
    try {
      const bad = makeEntry({ base: srv.base, buf: good, id: 'twitchdownloader', file: 'ruim.zip', exe: 'tool.exe', key: KEY });
      const otherOs = makeEntry({ base: srv.base, buf: good, id: 'soutro', file: 'a.zip', exe: 'a.exe', key: process.platform === 'win32' ? 'linux-x64' : 'win32-x64' });
      const s = setup(base, { entries: [bad, otherOs] });

      assert.deepEqual(await s.call('tools:install', {}), { ok: false, code: 'INVALID_ARGS', message: 'Informe qual ferramenta (id).' });
      assert.equal((await s.call('tools:install', { id: 42 })).code, 'INVALID_ARGS');
      for (const channel of ['tools:install', 'tools:remove', 'tools:cancel']) {
        const r = await s.call(channel, { id: 'nao-existe' });
        assert.deepEqual([r.ok, r.code], [false, 'UNKNOWN_TOOL'], channel);
        assert.match(r.message, /desconhecida/);
      }
      assert.equal((await s.call('tools:remove', { id: '../x' })).code, 'UNKNOWN_TOOL', 'id perigoso nem chega ao disco');

      const checksum = await s.call('tools:install', { id: 'twitchdownloader' });
      assert.equal(checksum.ok, false);
      assert.equal(checksum.code, 'CHECKSUM_MISMATCH');
      assert.match(checksum.message, /SHA-256/);
      assert.equal(s.ctx.tools.twitchDownloader, null);
      assert.equal(s.events('tools:progress').at(-1).phase, 'error');

      const unavailable = await s.call('tools:install', { id: 'soutro' });
      assert.equal(unavailable.code, 'PLATFORM_UNAVAILABLE');
      const st = await s.call('tools:status');
      assert.deepEqual(st.tools.map((t) => [t.id, t.installed, t.available]), [['twitchdownloader', false, true], ['soutro', false, false]]);
      assert.match(st.tools[1].unavailableReason, /não publica/);
      assert.deepEqual(listTree(s.toolsDir), [], 'falha não deixa instalação pela metade nem pasta de trabalho');
    } finally { await srv.close(); }
  });
});

test('cancelar no meio do download: tools:install volta CANCELLED; durante o download instalar/remover dão BUSY', T, async () => {
  await withEnv(async (base) => {
    const buf = zipOf();
    const srv = await startServer(holdingServer(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, id: 'whisper', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY });
      const s = setup(base, { entries: [entry] });

      const pending = s.call('tools:install', { id: 'whisper' });
      await waitUntil(() => s.events('tools:progress').some((p) => p.phase === 'download' && p.received > 0));
      assert.equal((await s.call('tools:status')).tools[0].busy, true);
      assert.equal((await s.call('tools:install', { id: 'whisper' })).code, 'BUSY');
      assert.equal((await s.call('tools:remove', { id: 'whisper' })).code, 'BUSY');

      assert.deepEqual(await s.call('tools:cancel', { id: 'whisper' }), { ok: true, cancelled: true });
      const result = await pending;
      assert.deepEqual([result.ok, result.code, result.message], [false, 'CANCELLED', 'Instalação cancelada.']);
      assert.equal(s.events('tools:progress').at(-1).phase, 'cancelled');
      assert.equal((await s.call('tools:status')).tools[0].busy, false);
      assert.equal((await s.call('tools:cancel', { id: 'whisper' })).cancelled, false, 'nada para cancelar');
      assert.deepEqual(listTree(s.toolsDir), []);
    } finally { await srv.close(); }
  });
});

test('fechar o app (before-quit) cancela a instalação em andamento', T, async () => {
  await withEnv(async (base) => {
    const buf = zipOf();
    const srv = await startServer(holdingServer(buf));
    try {
      const quit = [];
      const entry = makeEntry({ base: srv.base, buf, id: 'whisper', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY });
      const s = setup(base, { entries: [entry], appExtra: { on: (event, fn) => quit.push([event, fn]) } });
      assert.deepEqual(quit.map(([event]) => event), ['before-quit']);

      const pending = s.call('tools:install', { id: 'whisper' });
      await waitUntil(() => s.events('tools:progress').some((p) => p.phase === 'download' && p.received > 0));
      quit[0][1]();
      assert.equal((await pending).code, 'CANCELLED');
    } finally { await srv.close(); }
  });
});

test('ferramenta em uso (ctx.toolUsage) não é removida nem reinstalada; liberada, volta a funcionar', T, async () => {
  await withEnv(async (base) => {
    const buf = zipOf();
    const srv = await startServer((req, res) => sendBuffer(res, buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, id: 'whisper', file: 'whisper.zip', exe: 'whisper-cli.exe', key: KEY });
      const s = setup(base, { entries: [entry] });
      assert.equal((await s.call('tools:install', { id: 'whisper' })).ok, true);

      const seen = [];
      const off = s.ctx.toolUsage.register((key, id) => { seen.push([key, id]); return key === 'whisper' ? 'a geração de legendas está rodando' : null; });
      const noRemove = await s.call('tools:remove', { id: 'whisper' });
      assert.deepEqual([noRemove.ok, noRemove.code], [false, 'TOOL_IN_USE']);
      assert.match(noRemove.message, /Não é possível remover Ferramenta de teste agora: a geração de legendas está rodando\. Espere terminar/);
      const noForce = await s.call('tools:install', { id: 'whisper', force: true });
      assert.equal(noForce.code, 'TOOL_IN_USE');
      assert.match(noForce.message, /reinstalar/);
      assert.deepEqual(seen[0], ['whisper', 'whisper']);
      assert.ok(fs.existsSync(path.join(s.toolsDir, 'whisper', '1.0.0', 'whisper-cli.exe')), 'a instalação continua lá');
      // instalar sem force (já instalada) não mexe em nada: não precisa de liberação
      assert.equal((await s.call('tools:install', { id: 'whisper' })).alreadyInstalled, true);

      off();
      assert.equal((await s.call('tools:install', { id: 'whisper', force: true })).alreadyInstalled, false);
      assert.equal((await s.call('tools:remove', { id: 'whisper' })).removed, true);
    } finally { await srv.close(); }
  });
});

test('toolUsage: verificação que falha não bloqueia nem derruba; register exige função', () => {
  const dir = tmpDir();
  try {
    const { ctx } = setup(dir, { entries: [] });
    ctx.toolUsage.register(() => { throw new Error('defeito'); });
    assert.equal(ctx.toolUsage.inUse('whisper', 'whisper'), null);
    assert.throws(() => ctx.toolUsage.register('não é função'), /informe uma função/);
  } finally { cleanup(dir); }
});

test('ctx.refreshTools: avisa só se algo mudou; com { force: true } avisa sempre', () => {
  const dir = tmpDir();
  try {
    const s = setup(dir, { entries: [] });
    const before = s.events('tools:changed').length;
    s.ctx.refreshTools();
    assert.equal(s.events('tools:changed').length, before, 'nada mudou');
    s.ctx.refreshTools({ force: true });
    assert.equal(s.events('tools:changed').length, before + 1);
    assert.deepEqual(Object.keys(s.events('tools:changed').at(-1).tools).sort(), ['ffmpeg', 'ffprobe', 'twitchDownloader', 'whisper', 'ytdlp']);
  } finally { cleanup(dir); }
});

test('ao iniciar, resíduos de uma instalação interrompida são varridos', () => {
  const dir = tmpDir();
  try {
    const stale = path.join(dir, 'userdata', 'tools', '.tmp', 'whisper-abc123');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'whisper.zip.part'), 'metade');
    setup(dir, { entries: [] });
    assert.equal(fs.existsSync(path.join(dir, 'userdata', 'tools', '.tmp')), false);
  } finally { cleanup(dir); }
});

test('FFmpeg instalado pelo app: vence o do sistema (o ffprobe sai do mesmo pacote), aparece como "app" e some ao remover; em uso, não é removido', T, async () => {
  await withEnv(async (base) => {
    const buf = makeZip([{ name: 'pacote/bin/ffmpeg.exe', data: 'MZ-ffmpeg' }, { name: 'pacote/bin/ffprobe.exe', data: 'MZ-ffprobe' }, { name: 'pacote/bin/avcodec.dll', data: 'dll' }]);
    const srv = await startServer((req, res) => sendBuffer(res, buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, id: 'ffmpeg', version: '9.0.2', file: 'ffmpeg.zip', exe: 'bin/ffmpeg.exe', key: KEY, asset: { stripComponents: 1, alsoExe: { ffprobe: 'bin/ffprobe.exe' } } });
      const s = setup(base, { entries: [entry], testIds: ['ffmpeg'] });

      // antes: só o do sistema (CORTE_FFMPEG / CORTE_FFPROBE desta máquina, se houver)
      const before = await s.call('tools:status');
      assert.deepEqual(before.system.map((x) => x.origin), [real.ffmpeg ? 'system' : null, real.ffprobe ? 'system' : null]);

      const res = await s.call('tools:install', { id: 'ffmpeg' });
      const bin = path.join(s.toolsDir, 'ffmpeg', '9.0.2', 'bin');
      assert.deepEqual([res.ok, res.path], [true, path.join(bin, 'ffmpeg.exe')]);
      assert.equal(s.ctx.tools.ffmpeg, path.join(bin, 'ffmpeg.exe'), 'o do app vence CORTE_FFMPEG');
      assert.equal(s.ctx.tools.ffprobe, path.join(bin, 'ffprobe.exe'), 'o ffprobe vem do mesmo pacote e vence CORTE_FFPROBE');
      assert.equal(fs.existsSync(path.join(bin, 'avcodec.dll')), true, 'as DLLs ficam ao lado');
      assert.equal(s.events('tools:changed').at(-1).tools.ffprobe, path.join(bin, 'ffprobe.exe'));

      const after = await s.call('tools:status');
      assert.deepEqual(after.system.map((x) => [x.id, x.found, x.origin, x.path]), [['ffmpeg', true, 'app', path.join(bin, 'ffmpeg.exe')], ['ffprobe', true, 'app', path.join(bin, 'ffprobe.exe')]]);
      const row = after.tools.find((t) => t.id === 'ffmpeg');
      assert.deepEqual([row.installed, row.active.origin, row.available], [true, 'app', true]);

      // em uso (exportação, análise, legendas…): nem remove nem reinstala
      const release = s.ctx.toolUsage.register((key) => (key === 'ffmpeg' ? 'há exportações em andamento' : null));
      const blocked = await s.call('tools:remove', { id: 'ffmpeg' });
      assert.deepEqual([blocked.ok, blocked.code], [false, 'TOOL_IN_USE']);
      assert.match(blocked.message, /há exportações em andamento/);
      assert.equal(s.ctx.tools.ffmpeg, path.join(bin, 'ffmpeg.exe'), 'continua instalado');
      release();

      const removed = await s.call('tools:remove', { id: 'ffmpeg' });
      assert.equal(removed.removed, true);
      assert.equal(s.ctx.tools.ffmpeg, real.ffmpeg || null, 'volta para o do sistema');
      assert.equal(s.ctx.tools.ffprobe, real.ffprobe || null);
      assert.deepEqual(listTree(s.toolsDir), [], 'nada sobrou na pasta de ferramentas');
    } finally { await srv.close(); }
  });
});
