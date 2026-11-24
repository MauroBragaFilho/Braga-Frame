'use strict';

/**
 * Tela Novo projeto (aba `sources`, a antiga Fontes; renderer/features/sources.js) sem abrir o Electron: o script roda num contexto `vm`
 * com um BF falso (só o que o contrato 1.3 oferece) para conferir registro da aba, canais usados, formatação, o reconhecimento do site pelo
 * link, escolher o arquivo e os ganchos beforeOpen/afterOpen. O DOM da tela (cartões, painéis, área de soltar) é conferido em
 * tests/sources-ui.test.js; o desenho real (botões, progresso, janela) em tests/e2e/sources.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'renderer', 'features', 'sources.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'features', 'sources.css'), 'utf8');
const handler = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'handlers', 'sources.js'), 'utf8');
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function load({ project = null, api = {} } = {}) {
  const calls = [];
  const hooks = {};
  const listeners = {};
  const busListeners = {};
  const updates = [];
  const selected = [];
  const opened = [];
  let tab = null;
  const BF = {
    util: { el: () => ({}), nameOf: (p) => String(p).split(/[\\/]/).pop() },
    state: { project, tools: {} },
    ui: { registerTab: (def) => { tab = def; }, refreshTabs() {}, log() {}, toast() {}, confirm: async () => true, selectTab: (id) => { selected.push(id); return true; }, selectWorkTab: () => { selected.push('work'); return true; } },
    on: (channel, cb) => { listeners[channel] = cb; return () => {}; },
    bus: { on: (event, cb) => { busListeners[event] = cb; return () => {}; }, emit() {} },
    hooks: { add: (name, fn) => { hooks[name] = fn; return () => {}; } },
    api: async (channel, payload) => {
      calls.push([channel, plain(payload)]);
      const answer = api[channel];
      return typeof answer === 'function' ? answer(payload) : (answer || { ok: true });
    },
    project: { update(fn, opts) { updates.push(opts); fn(BF.state.project); } },
    openSource: async (file) => { opened.push(file); return api.openSource || { ok: true }; },
    ready: Promise.resolve()
  };
  const context = { window: { BF }, document: {}, setTimeout, clearTimeout, console, Date, Map, Promise, Intl };
  vm.runInNewContext(code, context, { filename: 'sources.js' });
  return { BF, tab, calls, hooks, listeners, busListeners, updates, selected, opened, sources: BF.sources };
}

const mkProject = (extra = {}) => ({
  id: 'p1', source: { path: 'D:\\VODs\\Live [123].mp4', origin: { type: 'vod' } }, meta: { game: '', channel: '' }, chat: null, cuts: [], ...extra
});

// ------------------------------------------------------------------ registro

test('registra a aba "sources" como "Novo projeto" (ordem 6, logo depois de Projetos) com selo de trabalho em andamento', () => {
  const { tab, sources } = load();
  assert.equal(tab.id, 'sources');
  assert.equal(tab.title, 'Novo projeto');
  assert.equal(tab.order, 6);
  assert.equal(tab.icon, 'add_circle');
  assert.equal(typeof tab.render, 'function');
  assert.equal(typeof tab.onShow, 'function');
  assert.equal(tab.badge(), '');
  sources.state.vod.stage = 'running';
  assert.equal(tab.badge(), '…');
  sources.state.vod.stage = 'idle';
  sources.state.chat.busy = true;
  assert.equal(tab.badge(), '…');
});

test('só usa canais sources:* que o handler registra (e project:list/shell:reveal da base)', () => {
  const registered = new Set([...handler.matchAll(/ctx\.handle\('(sources:[a-zA-Z]+)'/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/BF\.api\(\s*'([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.ok(used.size >= 8);
  for (const channel of used) {
    if (channel.startsWith('sources:')) assert.ok(registered.has(channel), `${channel} não existe no handler`);
    else assert.ok(['project:list', 'shell:reveal', 'source:pick'].includes(channel), `canal inesperado: ${channel}`);
  }
  const listened = [...code.matchAll(/BF\.on\(\s*'([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(listened, ['sources:progress']);
  assert.ok(handler.includes("'sources:progress'"), 'o handler emite o evento que a aba escuta');
});

test('registra os ganchos beforeOpen e afterOpen e escuta os eventos do app', () => {
  const { hooks, listeners, busListeners } = load();
  assert.equal(typeof hooks.beforeOpen, 'function');
  assert.equal(typeof hooks.afterOpen, 'function');
  assert.equal(typeof listeners['sources:progress'], 'function');
  assert.ok(busListeners['tools:changed'] && busListeners['project:loaded'] && busListeners['project:changed']);
});

test('o CSS cobre as classes usadas e não usa estilo inline nem cores fixas fora das variáveis do app', () => {
  const used = new Set([...code.matchAll(/class: '([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.startsWith('src-') || c === 'sources'));
  for (const name of used) assert.ok(css.includes(`.${name}`), `classe ${name} sem estilo`);
  assert.ok(!/style:\s*['"`]/.test(code), 'a CSP do app bloqueia o atributo style');
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'cores vêm das variáveis de app.css');
  assert.doesNotMatch(code, /window\.confirm|window\.prompt|alert\(/);
});

// ------------------------------------------------------------------ estado do trabalho em andamento

const stateAnswer = (job) => ({
  ok: true, settings: { obsFolder: null, downloadDir: null, cookiesBrowser: '' }, defaultDownloadDir: 'D:\\VODs', downloadDir: 'D:\\VODs',
  tools: { ytdlp: { found: true, version: '1' }, twitchDownloader: { found: true }, ffmpeg: { found: true }, ffprobe: { found: true }, jsRuntime: { found: false } },
  job
});
const chatJob = { jobId: 'chat-1', kind: 'chat', phase: 'chat', url: 'https://www.twitch.tv/videos/123', videoId: '123', platform: 'twitch', message: 'Baixando o chat…', percent: 40, title: '' };
const downloadJob = { jobId: 'download-1', kind: 'download', phase: 'download', url: 'https://www.twitch.tv/videos/123', videoId: '123', platform: 'twitch', percent: 10, title: 'Live' };
const vodProject = () => mkProject({ source: { path: 'D:\\VODs\\Live [123].mp4', origin: { type: 'vod', platform: 'twitch', url: 'https://www.twitch.tv/videos/123', videoId: '123' } } });

test('trocar de aba durante o download do chat não deixa a seção do VOD presa em "Download em andamento"', async () => {
  // o job de chat que o processo principal devolve em sources:state NÃO é um download de vídeo (antes era adotado como se fosse)
  let finishChat;
  const { sources, tab, listeners } = load({
    project: vodProject(),
    api: { 'sources:state': stateAnswer(chatJob), 'sources:chat': () => new Promise((resolve) => { finishChat = resolve; }) }
  });
  const pending = sources.downloadProjectChat(); // o usuário clicou em "Baixar chat"
  assert.equal(sources.state.chat.busy, true);
  await sources.loadState(); // voltou à aba: onShow -> refresh -> loadState (o mesmo vale para o evento tools:changed)
  assert.equal(sources.state.vod.stage, 'idle', 'um job de chat não vira "Download em andamento" na seção do VOD');
  assert.equal(sources.state.vod.adopted, undefined);
  assert.equal(sources.state.chat.busy, true, 'o chat segue em andamento (quem iniciou ainda espera a resposta)');

  finishChat({ ok: true, chat: { path: 'C:\\app\\chats\\twitch-123.json', format: 'bf-chat-1', count: 3, fetchedAt: '2026-10-21T10:00:00.000Z', platform: 'twitch' } });
  await pending;
  listeners['sources:progress']({ jobId: 'chat-1', kind: 'chat', phase: 'done', percent: 100, message: 'Chat baixado: 3 mensagens.' });
  assert.equal(sources.state.chat.busy, false);
  assert.equal(sources.state.vod.stage, 'idle', 'antes ficava "running" para sempre e o campo do link continuava desabilitado');
  assert.equal(tab.badge(), '', 'o selo da aba some');
});

test('janela recarregada no meio do download do chat: o chat é adotado como chat e termina sozinho quando o evento chega', async () => {
  const { sources, tab, listeners } = load({ project: vodProject(), api: { 'sources:state': stateAnswer(chatJob) } });
  await sources.loadState();
  assert.equal(sources.state.vod.stage, 'idle');
  assert.equal(sources.state.chat.busy, true);
  assert.equal(tab.badge(), '…');
  listeners['sources:progress']({ jobId: 'chat-1', kind: 'chat', phase: 'chat', percent: 70, message: 'Baixando o chat… 2 MB' });
  assert.equal(sources.state.chat.progress.percent, 70);
  listeners['sources:progress']({ jobId: 'chat-1', kind: 'chat', phase: 'cancelled', message: 'Download do chat cancelado.' });
  assert.equal(sources.state.chat.busy, false, 'ninguém espera a resposta: o evento final encerra o estado');
  assert.equal(sources.state.chat.adopted, false);
  assert.match(sources.state.chat.note, /cancelado/);
  assert.equal(tab.badge(), '');

  // erro e conclusão durante o chat adotado: também encerram, com a mensagem
  const failed = load({ project: vodProject(), api: { 'sources:state': stateAnswer(chatJob) } });
  await failed.sources.loadState();
  failed.listeners['sources:progress']({ jobId: 'chat-1', kind: 'chat', phase: 'error', message: 'O chat não está disponível.' });
  assert.equal(failed.sources.state.chat.busy, false);
  assert.match(failed.sources.state.chat.note, /O chat não está disponível/);
  const finished = load({ project: vodProject(), api: { 'sources:state': stateAnswer(chatJob) } });
  await finished.sources.loadState();
  finished.listeners['sources:progress']({ jobId: 'chat-1', kind: 'chat', phase: 'done', message: 'Chat baixado: 3 mensagens.' });
  assert.equal(finished.sources.state.chat.busy, false);
  assert.match(finished.sources.state.chat.note, /terminou/);
  assert.equal(finished.sources.state.vod.stage, 'idle');
});

test('janela recarregada no meio do download de um VÍDEO continua sendo adotada e encerrada pelo evento final', async () => {
  const { sources, listeners } = load({ api: { 'sources:state': stateAnswer(downloadJob) } });
  await sources.loadState();
  assert.equal(sources.state.vod.stage, 'running');
  assert.equal(sources.state.vod.adopted, true);
  assert.equal(sources.state.chat.busy, false, 'job de vídeo não mexe no estado do chat');
  listeners['sources:progress']({ jobId: 'download-1', kind: 'download', phase: 'done', percent: 100 });
  assert.equal(sources.state.vod.stage, 'idle');
  assert.equal(sources.state.vod.adopted, false);
});

// ------------------------------------------------------------------ formatação

test('formatação: bytes, duração, tempo restante, dia e linha de progresso', () => {
  const { sources } = load();
  const f = sources.format;
  assert.equal(f.fmtBytes(0), '0 B');
  assert.equal(f.fmtBytes(1536), '1,5 KB');
  assert.equal(f.fmtBytes(4.2 * 1024 ** 3), '4,2 GB');
  assert.equal(f.fmtBytes(250 * 1024 ** 2), '250 MB');
  assert.equal(f.fmtBytes(-1), '—');
  assert.equal(f.fmtDuration(65), '1:05');
  assert.equal(f.fmtDuration(3725), '1:02:05');
  assert.equal(f.fmtDuration(0), '0:00');
  assert.equal(f.fmtDuration(null), '—');
  assert.equal(f.fmtEta(45), '45 s');
  assert.equal(f.fmtEta(600), '10 min');
  assert.equal(f.fmtEta(7500), '2 h 5 min');
  assert.equal(f.fmtEta(0), '');

  const now = new Date(2026, 9, 21, 15, 0, 0);
  assert.equal(f.dayLabel(new Date(2026, 9, 21, 3, 0, 0), now), 'Hoje');
  assert.equal(f.dayLabel(new Date(2026, 9, 20, 23, 59, 0), now), 'Ontem');
  assert.equal(f.dayLabel(new Date(2026, 9, 18, 10, 0, 0), now), '18/10/2026');
  const groups = f.groupByDay([
    { startedAt: new Date(2026, 9, 21, 12, 0, 0).toISOString(), name: 'a' },
    { startedAt: new Date(2026, 9, 21, 9, 0, 0).toISOString(), name: 'b' },
    { startedAt: new Date(2026, 9, 20, 22, 0, 0).toISOString(), name: 'c' }
  ], now);
  assert.deepEqual(plain(groups).map((g) => [g.label, g.files.map((x) => x.name)]), [['Hoje', ['a', 'b']], ['Ontem', ['c']]]);

  assert.equal(f.progressLine({ phase: 'download', percent: 42.7, downloaded: 1.2 * 1024 ** 3, total: 2.9 * 1024 ** 3, speed: 8.3 * 1024 ** 2, eta: 190 }), '42% · 1,2 GB de 2,9 GB · 8,3 MB/s · faltam 3 min');
  assert.equal(f.progressLine({ phase: 'download', percent: null, downloaded: 5 * 1024 ** 2, total: null }), '5 MB', 'sem total não inventa percentual');
  assert.equal(f.progressLine({ phase: 'download', percent: 10, downloaded: 1024, total: 10240, resumed: true }), 'Retomado · 10% · 1 KB de 10 KB');
  assert.equal(f.progressLine({ phase: 'merge' }), 'Juntando vídeo e áudio…');
  assert.equal(f.progressLine({ phase: 'chat', message: 'Baixando o chat… 12 KB' }), 'Baixando o chat… 12 KB');
  assert.equal(f.progressLine({ phase: 'finishing' }), 'Guardando o arquivo…');
  assert.equal(f.metaLine({ channel: 'Canal', game: 'Minecraft', duration: 7200, uploadDate: '2026-10-20' }), 'Canal · Minecraft · 2:00:00 · 20/10/2026');
  assert.equal(f.metaLine({ channel: 'Canal', game: '', categories: ['Gaming'], duration: 65, uploadDate: '' }), 'Canal · Gaming · 1:05');
});

// ------------------------------------------------------------------ o site do link

test('platformOfUrl: reconhece YouTube e Twitch pelo endereço colado e nada além disso (só serve para trocar o cartão)', () => {
  const { sources } = load();
  const of = (text) => sources.platformOfUrl(text);
  for (const text of [
    'https://www.youtube.com/watch?v=abc', 'http://youtube.com/live/abc', 'youtube.com/watch?v=abc', '  https://youtu.be/abc?t=10  ', 'https://m.youtube.com/watch?v=abc',
    'https://music.youtube.com/watch?v=abc', 'https://www.youtube-nocookie.com/embed/abc', 'HTTPS://WWW.YOUTUBE.COM/watch?v=abc', 'https://usuario@www.youtube.com/watch?v=abc'
  ]) assert.equal(of(text), 'youtube', text);
  for (const text of [
    'https://www.twitch.tv/videos/123', 'twitch.tv/videos/123', 'https://m.twitch.tv/videos/123', 'https://twitch.tv:443/videos/123?t=1h', ' https://www.twitch.tv/canal '
  ]) assert.equal(of(text), 'twitch', text);
  for (const text of [
    '', '   ', null, undefined, 42, 'texto qualquer', 'https://exemplo.com/youtube.com', 'https://youtube.com.exemplo.com/watch?v=abc', 'https://meuyoutube.com/watch?v=abc',
    'https://www.twitch.tv.exemplo.com/videos/1', 'https://nottwitch.tv/videos/1', 'https://vimeo.com/123', 'ftp://exemplo.com', 'https://clips.twitch.tv/abc'
  ]) assert.equal(of(text), null, String(text));
});

// ------------------------------------------------------------------ arquivos locais

test('pickFile: abre o arquivo escolhido e segue para Cortes só se o projeto abriu', async () => {
  const picked = load({ api: { 'source:pick': { ok: true, path: 'D:\\Lives\\live.mp4' } } });
  await picked.sources.pickFile();
  assert.deepEqual(picked.calls, [['source:pick', {}]]);
  assert.deepEqual(plain(picked.opened), ['D:\\Lives\\live.mp4']);
  assert.deepEqual(picked.selected, ['work']);

  const canceled = load({ api: { 'source:pick': { ok: true, canceled: true } } });
  await canceled.sources.pickFile();
  assert.deepEqual(canceled.opened, []);
  assert.deepEqual(canceled.selected, []);

  const failed = load({ api: { 'source:pick': { ok: false, message: 'erro' } } });
  await failed.sources.pickFile();
  assert.deepEqual(failed.opened, []);

  const refused = load({ api: { 'source:pick': { ok: true, path: 'D:\\x.mp4' }, openSource: { ok: false, message: 'Formato não suportado.' } } });
  await refused.sources.pickFile();
  assert.deepEqual(plain(refused.opened), ['D:\\x.mp4']);
  assert.deepEqual(refused.selected, [], 'o vídeo não abriu: continua onde está');
});

// ------------------------------------------------------------------ ganchos

test('beforeOpen preenche a origem de arquivos conhecidos e respeita a origem já informada', async () => {
  const origin = { type: 'vod', platform: 'twitch', videoId: '1' };
  const { hooks, calls, sources } = load({ api: { 'sources:originFor': { ok: true, known: true, kind: 'vod', origin, chat: { path: 'c.json' }, meta: { game: 'G' } } } });
  const ctx = { path: 'D:\\VODs\\a.mp4', origin: null, info: null };
  await hooks.beforeOpen(ctx);
  assert.deepEqual(plain(ctx.origin), origin);
  assert.equal(calls.length, 1);
  assert.ok(sources.known.has('d:\\vods\\a.mp4'), 'guarda o que sabe para o afterOpen');

  const given = { path: 'D:\\x.mp4', origin: { type: 'obs' } };
  await hooks.beforeOpen(given);
  assert.equal(calls.length, 1, 'origem já informada: nem consulta');
  assert.deepEqual(plain(given.origin), { type: 'obs' });

  const unknown = load({ api: { 'sources:originFor': { ok: true, known: false } } });
  const c2 = { path: 'D:\\y.mp4', origin: null };
  await unknown.hooks.beforeOpen(c2);
  assert.equal(c2.origin, null);
  const failing = load({ api: { 'sources:originFor': { ok: false, code: 'X', message: 'erro' } } });
  const c3 = { path: 'D:\\y.mp4', origin: null };
  await failing.hooks.beforeOpen(c3);
  assert.equal(c3.origin, null, 'falha ao consultar não impede abrir');
});

test('afterOpen preenche jogo/canal só se vazios e anexa o chat existente', async () => {
  const project = mkProject();
  const { hooks, sources, updates } = load({ project, api: { 'sources:chatCheck': { ok: true, exists: true, count: 5 } } });
  const chat = { path: 'C:\\app\\chats\\twitch-1.json', format: 'bf-chat-1', count: 5, fetchedAt: '2026-10-21T10:00:00.000Z', platform: 'twitch' };
  sources.known.set('d:\\vods\\live [123].mp4', { kind: 'vod', origin: {}, chat, meta: { game: 'Minecraft', channel: 'Canal' } });
  await hooks.afterOpen({ path: 'D:\\VODs\\Live [123].mp4' });
  assert.equal(project.meta.game, 'Minecraft');
  assert.equal(project.meta.channel, 'Canal');
  assert.deepEqual(plain(project.chat), chat);
  assert.deepEqual(plain(updates), [{ reason: 'sources:attach' }]);
  assert.equal(sources.known.size, 0, 'o registro é consumido');
});

test('afterOpen nunca sobrescreve o que o usuário já definiu nem anexa chat que sumiu', async () => {
  const mine = { path: 'meu.json', format: 'bf-chat-1', count: 1 };
  const project = mkProject({ meta: { game: 'Meu Jogo', channel: '' }, chat: mine });
  const { hooks, sources, updates } = load({ project, api: { 'sources:chatCheck': { ok: true, exists: true } } });
  sources.known.set('d:\\vods\\live [123].mp4', { kind: 'vod', origin: {}, chat: { path: 'outro.json' }, meta: { game: 'Outro Jogo', channel: 'Canal' } });
  await hooks.afterOpen({ path: 'D:\\VODs\\Live [123].mp4' });
  assert.equal(project.meta.game, 'Meu Jogo');
  assert.equal(project.meta.channel, 'Canal', 'o campo vazio é preenchido');
  assert.deepEqual(plain(project.chat), mine, 'chat já anexado fica como está');
  assert.equal(updates.length, 1);

  // arquivo de chat que não existe mais: não anexa (e não dá erro)
  const p2 = mkProject();
  const gone = load({ project: p2, api: { 'sources:chatCheck': { ok: true, exists: false, reason: 'sumiu' } } });
  gone.sources.known.set('d:\\vods\\live [123].mp4', { kind: 'vod', origin: {}, chat: { path: 'sumiu.json' }, meta: { game: '', channel: '' } });
  await gone.hooks.afterOpen({ path: 'D:\\VODs\\Live [123].mp4' });
  assert.equal(p2.chat, null);
  assert.equal(gone.updates.length, 0, 'nada a gravar no projeto');
});

test('afterOpen ignora gravações do OBS, caminhos que não conferem e ausência de registro', async () => {
  const project = mkProject();
  const { hooks, sources, updates } = load({ project });
  sources.known.set('d:\\vods\\live [123].mp4', { kind: 'obs', origin: { type: 'obs' }, chat: null, meta: {} });
  await hooks.afterOpen({ path: 'D:\\VODs\\Live [123].mp4' });
  sources.known.set('d:\\outro.mp4', { kind: 'vod', origin: {}, chat: null, meta: { game: 'G', channel: 'C' } });
  await hooks.afterOpen({ path: 'D:\\outro.mp4' }); // o projeto aberto é de outro arquivo
  await hooks.afterOpen({ path: 'D:\\sem-registro.mp4' });
  await hooks.afterOpen({});
  assert.equal(updates.length, 0);
  assert.equal(project.meta.game, '');
});
