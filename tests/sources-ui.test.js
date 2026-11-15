'use strict';

/**
 * A tela Novo projeto por dentro, com o renderer/features/sources.js de verdade num DOM de mentira (tests/prefs-fakedom.js + tests/fakedom-extra.js):
 * a pergunta e os quatro cartões (Arquivos locais, YouTube, Twitch, Gravações do OBS), o painel que cada cartão mostra (só o do escolhido), a área de
 * soltar com o botão de escolher o arquivo, o cartão que acompanha o site do link colado, a escolha lembrada entre sessões (sem quebrar se o
 * armazenamento falhar), o selo "Baixando" do download em andamento e o salto para a aba Cortes quando um vídeo abre. O desenho real (CSS, soltar o
 * arquivo na janela, download de verdade) é conferido em tests/e2e/sources.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createDocument, makeEl } = require('./prefs-fakedom');
const { extendFakeDom } = require('./fakedom-extra');
const { VIDEO_EXTENSIONS } = require('../src/ipc/handlers/project');

extendFakeDom();

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'sources.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const idle = async () => { for (let i = 0; i < 8; i += 1) await tick(); };
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const TOOLS = { ytdlp: { found: true, version: '2026.10.01' }, twitchDownloader: { found: true }, ffmpeg: { found: true }, ffprobe: { found: true }, jsRuntime: { found: false } };
const stateAnswer = (job = null) => ({
  ok: true, settings: { obsFolder: null, downloadDir: null, cookiesBrowser: '' }, defaultDownloadDir: 'D:\\VODs', downloadDir: 'D:\\VODs', tools: TOOLS, job
});
const NO_OBS = { ok: true, found: false, reason: 'Não encontrei a configuração do OBS neste computador.', manual: null, selected: null, folders: [], profiles: [] };
const downloadJob = (platform) => ({ jobId: 'download-1', kind: 'download', phase: 'download', url: `https://example/${platform}`, videoId: '123', platform, percent: 10, title: 'Live' });
const chatJob = { jobId: 'chat-1', kind: 'chat', phase: 'chat', url: 'https://www.twitch.tv/videos/123', videoId: '123', platform: 'twitch', message: 'Baixando o chat…', percent: 40, title: '' };

/** A resposta de sources:fetchVod para um vídeo da plataforma. */
const vodAnswer = (platform = 'youtube') => ({
  ok: true,
  meta: {
    title: 'Live de teste', url: platform === 'twitch' ? 'https://www.twitch.tv/videos/123' : 'https://www.youtube.com/watch?v=abc', platform,
    channel: 'Canal', game: '', duration: 3600, uploadDate: '2026-10-20', categories: []
  },
  qualities: [{ id: 'best', label: 'Melhor disponível', height: 1080, estBytes: 1024 ** 3 }],
  chat: { available: true, note: '' },
  warnings: []
});
const doneAnswer = (platform = 'youtube') => ({
  ok: true, path: 'D:\\VODs\\Live de teste.mp4', bytes: 1024 ** 3, resumed: false, chat: null, warnings: [],
  origin: { type: 'vod', platform, url: 'https://example/vod', videoId: 'abc' }, meta: { game: '', channel: 'Canal' }
});

/**
 * `store`: o que o localStorage já tem; `storage`: 'ok' (BF.local de verdade), 'throws' (dados bloqueados: ler e gravar lançam) ou 'none' (sem BF.local).
 * `api`: respostas por canal (valor ou função); o que não está aqui tem uma resposta padrão de "tudo instalado, sem OBS, sem projetos".
 */
function load({ api = {}, project = null, store = {}, storage = 'ok' } = {}) {
  const doc = createDocument();
  const calls = [];
  const toasts = [];
  const selected = [];
  const opened = [];
  const hooks = {};
  const listeners = {};
  const busListeners = {};
  const saved = new Map(Object.entries(store));
  let tab = null;
  const reply = (channel, payload) => {
    const answer = api[channel];
    if (typeof answer === 'function') return answer(payload);
    if (answer !== undefined) return answer;
    if (channel === 'sources:state') return stateAnswer();
    if (channel === 'sources:obsDetect') return NO_OBS;
    if (channel === 'project:list') return { ok: true, projects: [] };
    if (channel === 'sources:partial') return { ok: true, bytes: 0, otherBytes: 0 };
    return { ok: true };
  };
  const BF = {
    util: { el: makeEl(doc), nameOf: (p) => String(p).split(/[\\/]/).pop() },
    state: { project, tools: {} },
    ui: {
      registerTab: (def) => { tab = def; }, refreshTabs() {}, log() {}, toast: (message, kind) => toasts.push([message, kind]), confirm: async () => true,
      selectTab: (id) => { selected.push(id); return true; }
    },
    on: (channel, cb) => { listeners[channel] = cb; return () => {}; },
    bus: { on: (event, cb) => { busListeners[event] = cb; return () => {}; }, emit() {} },
    hooks: { add: (name, fn) => { hooks[name] = fn; return () => {}; } },
    api: async (channel, payload, opts = {}) => { // como o BF.api do app: a resposta { ok:false } vira toast de erro só com { toast: true }
      calls.push([channel, plain(payload), plain(opts)]);
      const res = await reply(channel, payload);
      if (res.ok === false && opts.toast) toasts.push([res.message, 'error']);
      return res;
    },
    project: { update() {} },
    openSource: async (file, origin) => { opened.push([file, plain(origin)]); return reply('openSource'); },
    ready: Promise.resolve()
  };
  if (storage === 'ok') BF.local = { get: (key, fallback = null) => (saved.has(key) ? saved.get(key) : fallback), set: (key, value) => { saved.set(key, String(value)); return true; } };
  if (storage === 'throws') BF.local = { get() { throw new Error('dados do site bloqueados'); }, set() { throw new Error('dados do site bloqueados'); } };
  const sandbox = { window: { BF }, document: doc, setTimeout, clearTimeout, console, Date, Intl };
  vm.runInContext(CODE, vm.createContext(sandbox), { filename: 'sources.js' });
  const container = doc.register('panel');
  tab.render(container);
  const q = (selector) => container.querySelector(selector);
  const all = (selector) => container.querySelectorAll(selector);
  const cards = () => all('.src-choice');
  return {
    BF, tab, doc, container, calls, toasts, selected, opened, hooks, listeners, busListeners, saved, q, all, sources: BF.sources,
    /** Os cartões de escolha com `aria-pressed="true"` (deve ser um só). */
    pressed: () => cards().filter((c) => c.attrs['aria-pressed'] === 'true').map((c) => c.dataset.source),
    /** Os painéis visíveis, na ordem da tela. */
    shown: () => ['files', 'vod', 'obs', 'chat'].filter((name) => q(`[data-section="${name}"]`).hidden === false),
    /** Os cartões que mostram o selo "Baixando". */
    badges: () => cards().filter((c) => c.querySelector('.src-choice-badge').hidden === false).map((c) => c.dataset.source),
    choose: (kind) => q(`.src-choice[data-source="${kind}"]`).click(),
    /** Digita no campo do link (o painel do YouTube/Twitch). */
    paste: (text) => { const input = q('.src-url'); input.value = text; input.dispatch('input'); },
    vodTitle: () => q('[data-section="vod"] h2').textContent
  };
}

// ------------------------------------------------------------------ a tela

test('a tela abre com a pergunta, os quatro cartões e só o painel de Arquivos locais', async () => {
  const env = load();
  await idle();
  assert.equal(env.q('h2.src-question').textContent, 'Como deseja adicionar o seu vídeo?');
  assert.deepEqual(env.all('.src-choice').map((c) => c.dataset.source), ['files', 'youtube', 'twitch', 'obs']);
  assert.deepEqual(env.all('.src-choice').map((c) => c.dataset.act), ['source', 'source', 'source', 'source']);
  assert.deepEqual(env.all('.src-choice').map((c) => c.tag), ['button', 'button', 'button', 'button'], 'cada cartão é um botão (teclado e leitor de tela)');
  assert.deepEqual(env.all('.src-choice-text strong').map((n) => n.textContent), ['Arquivos locais', 'YouTube', 'Twitch', 'Gravações do OBS']);
  assert.deepEqual(env.all('.src-choice-text .muted').map((n) => n.textContent), ['Do seu computador', 'Link de um vídeo ou live', 'Link de um VOD', 'Da pasta de gravações']);
  assert.deepEqual(env.all('.src-choice-icon .material-symbols-rounded').map((n) => n.textContent), ['video_file', 'smart_display', 'live_tv', 'videocam']);
  assert.equal(env.q('.src-choices').attrs.role, 'group');
  assert.equal(env.q('.src-choices').attrs['aria-label'], 'De onde vem o vídeo');
  assert.deepEqual(env.pressed(), ['files']);
  assert.deepEqual(env.shown(), ['files'], 'sem projeto aberto não há seção do chat');
  assert.deepEqual(env.badges(), []);
});

test('a ordem da tela: pergunta, cartões, os painéis e o Avançado recolhido por último', async () => {
  const env = load();
  await idle();
  const root = env.q('.sources');
  assert.deepEqual(root.children.map((c) => c.className.split(' ')[0]), ['src-question', 'src-choices', 'src-section', 'src-section', 'src-section', 'src-section', 'src-section']);
  assert.deepEqual(env.all('[data-section]').map((n) => n.dataset.section), ['files', 'vod', 'obs', 'chat', 'advanced']);
  const advanced = env.q('[data-section="advanced"]');
  assert.equal(advanced.tag, 'details');
  assert.equal(advanced.open, false, 'o Avançado fica recolhido');
});

test('Arquivos locais: a área de soltar é um botão grande com as instruções e os formatos que o app abre de verdade', async () => {
  const env = load();
  await idle();
  const drop = env.q('[data-section="files"] .src-drop');
  assert.equal(drop.tag, 'button');
  assert.equal(drop.dataset.act, 'pick-file');
  assert.equal(drop.querySelector('.src-drop-icon').textContent, 'cloud_upload');
  assert.equal(drop.querySelector('.src-drop-title').textContent, 'Arraste e solte o vídeo aqui');
  assert.equal(drop.querySelector('.src-drop-sub').textContent, 'ou clique para escolher o arquivo');
  const formats = drop.querySelector('.src-drop-formats').textContent;
  assert.deepEqual(formats.replace(' ou ', ', ').split(', ').map((f) => f.toLowerCase()).sort(), [...VIDEO_EXTENSIONS].sort(), 'a lista de formatos é a do diálogo e do arrastar');
  assert.match(env.q('[data-section="files"] .src-hint-text').textContent, /Cada vídeo é um projeto/);
});

test('clicar na área de soltar abre o diálogo do sistema, abre o projeto e segue para Cortes', async () => {
  const env = load({ api: { 'source:pick': { ok: true, path: 'D:\\Lives\\live.mp4' } } });
  await idle();
  env.q('.src-drop').click();
  await idle();
  const picks = env.calls.filter(([channel]) => channel === 'source:pick');
  assert.deepEqual(picks.map(([, payload, opts]) => [payload, opts]), [[{}, { toast: true }]], 'o erro do diálogo vira aviso na tela');
  assert.deepEqual(env.opened, [['D:\\Lives\\live.mp4', undefined]]);
  assert.deepEqual(env.selected, ['cuts']);
});

test('escolher o arquivo: cancelar o diálogo, erro no diálogo ou vídeo que não abre não mexem na aba', async () => {
  const canceled = load({ api: { 'source:pick': { ok: true, canceled: true } } });
  await idle();
  canceled.q('.src-drop').click();
  await idle();
  assert.deepEqual(canceled.opened, []);
  assert.deepEqual(canceled.selected, []);

  const failed = load({ api: { 'source:pick': { ok: false, message: 'Não consegui abrir o diálogo.' } } });
  await idle();
  failed.q('.src-drop').click();
  await idle();
  assert.deepEqual(failed.opened, []);
  assert.deepEqual(failed.toasts, [['Não consegui abrir o diálogo.', 'error']]);

  const refused = load({ api: { 'source:pick': { ok: true, path: 'D:\\x.mp4' }, openSource: { ok: false, message: 'Formato não suportado.' } } });
  await idle();
  refused.q('.src-drop').click();
  await idle();
  assert.deepEqual(refused.opened, [['D:\\x.mp4', undefined]]);
  assert.deepEqual(refused.selected, [], 'o vídeo não abriu: continua em Novo projeto, onde o aviso de erro foi dado');
});

// ------------------------------------------------------------------ os cartões e os painéis

test('cada cartão mostra só o seu painel: o título, a explicação, o campo do link e o ícone seguem YouTube ou Twitch', async () => {
  const env = load();
  await idle();

  env.choose('youtube');
  assert.deepEqual(env.pressed(), ['youtube']);
  assert.deepEqual(env.shown(), ['vod']);
  assert.equal(env.vodTitle(), 'Vídeo do YouTube');
  assert.match(env.q('[data-section="vod"] .src-lead').textContent, /youtube\.com\/watch\?v=.*Playlists não são aceitas/);
  assert.equal(env.q('.src-url').placeholder, 'https://www.youtube.com/watch?v=…');
  assert.equal(env.q('[data-section="vod"]').attrs['aria-label'], 'Vídeo do YouTube');
  assert.equal(env.q('[data-section="vod"] .src-head-icon .material-symbols-rounded').textContent, 'smart_display');

  env.choose('twitch');
  assert.deepEqual(env.pressed(), ['twitch']);
  assert.deepEqual(env.shown(), ['vod'], 'o mesmo painel do link serve aos dois sites');
  assert.equal(env.vodTitle(), 'VOD da Twitch');
  assert.match(env.q('[data-section="vod"] .src-lead').textContent, /twitch\.tv\/videos\/.*Clipes e transmissões ao vivo não são aceitos/);
  assert.equal(env.q('.src-url').placeholder, 'https://www.twitch.tv/videos/…');
  assert.equal(env.q('[data-section="vod"]').attrs['aria-label'], 'VOD da Twitch');
  assert.equal(env.q('[data-section="vod"] .src-head-icon .material-symbols-rounded').textContent, 'live_tv');

  env.choose('obs');
  assert.deepEqual(env.pressed(), ['obs']);
  assert.deepEqual(env.shown(), ['obs']);
  assert.equal(env.q('[data-section="obs"] h2').textContent, 'Gravações do OBS');

  env.choose('files');
  assert.deepEqual(env.pressed(), ['files']);
  assert.deepEqual(env.shown(), ['files']);
});

test('a escolha do cartão fica guardada e volta na próxima vez; valor desconhecido cai em Arquivos locais', async () => {
  const first = load();
  await idle();
  assert.equal(first.saved.has('sourceKind'), false, 'só grava quando o usuário escolhe');
  first.choose('twitch');
  assert.equal(first.saved.get('sourceKind'), 'twitch');
  first.choose('twitch');
  first.choose('obs');
  assert.equal(first.saved.get('sourceKind'), 'obs');

  const again = load({ store: { sourceKind: 'obs' } });
  await idle();
  assert.deepEqual(again.pressed(), ['obs']);
  assert.deepEqual(again.shown(), ['obs']);

  const junk = load({ store: { sourceKind: 'discord' } });
  await idle();
  assert.deepEqual(junk.pressed(), ['files']);
});

test('sem armazenamento (dados bloqueados ou janela privada) os cartões continuam funcionando, só não lembram', async () => {
  for (const storage of ['throws', 'none']) {
    const env = load({ storage });
    await idle();
    assert.deepEqual(env.pressed(), ['files'], storage);
    env.choose('youtube');
    assert.deepEqual(env.pressed(), ['youtube'], storage);
    assert.deepEqual(env.shown(), ['vod'], storage);
    env.paste('https://www.twitch.tv/videos/123');
    assert.deepEqual(env.pressed(), ['twitch'], `${storage}: colar o link do outro site também funciona`);
  }
});

test('colar o link do outro site troca o cartão (o painel do link é um só); link de outro lugar ou com o painel fechado não mexe', async () => {
  const env = load();
  await idle();
  env.choose('youtube');
  env.paste('https://www.twitch.tv/videos/123');
  assert.deepEqual(env.pressed(), ['twitch']);
  assert.equal(env.vodTitle(), 'VOD da Twitch');
  assert.equal(env.q('.src-url').placeholder, 'https://www.twitch.tv/videos/…');
  assert.equal(env.saved.get('sourceKind'), 'twitch');
  env.paste('https://youtu.be/abc123');
  assert.deepEqual(env.pressed(), ['youtube']);
  assert.equal(env.vodTitle(), 'Vídeo do YouTube');
  env.paste('https://exemplo.com.br/video');
  assert.deepEqual(env.pressed(), ['youtube'], 'um endereço que não é de nenhum dos dois sites deixa o cartão como está (o aviso vem ao buscar)');
  env.paste('');
  assert.deepEqual(env.pressed(), ['youtube']);

  // o campo existe mesmo com o painel fechado: um link colado nele (ou lembrado) não tira o usuário de Arquivos locais ou do OBS
  env.choose('obs');
  env.paste('https://www.twitch.tv/videos/999');
  assert.deepEqual(env.pressed(), ['obs']);
  env.choose('files');
  env.paste('https://www.youtube.com/watch?v=zzz');
  assert.deepEqual(env.pressed(), ['files']);
});

test('buscar um link da outra plataforma troca o cartão antes de consultar (vale o site do link, não o cartão aberto)', async () => {
  const env = load({ api: { 'sources:fetchVod': vodAnswer('twitch') } });
  await idle();
  env.choose('youtube');
  env.q('.src-url').value = 'https://www.twitch.tv/videos/123'; // preenchido sem o evento de digitação (colado por outro caminho)
  env.sources.state.vod.url = 'https://www.twitch.tv/videos/123';
  env.q('[data-act="fetch"]').click();
  await idle();
  assert.deepEqual(env.pressed(), ['twitch']);
  const fetched = env.calls.filter(([channel]) => channel === 'sources:fetchVod');
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0][1].url, 'https://www.twitch.tv/videos/123');
  assert.equal(env.q('[data-section="vod"] .src-title').textContent, 'Live de teste');
  assert.equal(env.q('[data-section="vod"] .src-platform').textContent, 'Twitch');
});

// ------------------------------------------------------------------ download em andamento

test('o selo "Baixando" aparece no cartão da plataforma enquanto o vídeo baixa, mesmo com outro cartão aberto, e some quando termina', async () => {
  let finish;
  const env = load({ api: { 'sources:fetchVod': vodAnswer('youtube'), 'sources:download': () => new Promise((resolve) => { finish = resolve; }) } });
  await idle();
  env.choose('youtube');
  env.paste('https://www.youtube.com/watch?v=abc');
  env.q('[data-act="fetch"]').click();
  await idle();
  assert.deepEqual(env.badges(), [], 'consultar o vídeo ainda não é baixar');
  env.q('[data-act="download"]').click();
  await idle();
  assert.deepEqual(env.badges(), ['youtube'], 'o selo aparece assim que o download começa, sem trocar de cartão');
  assert.equal(env.tab.badge(), '…');

  env.choose('files');
  assert.deepEqual(env.shown(), ['files']);
  assert.deepEqual(env.badges(), ['youtube'], 'com outro cartão aberto o selo continua no do YouTube');
  env.choose('twitch');
  assert.deepEqual(env.badges(), ['youtube'], 'o selo é do cartão do vídeo, não do cartão aberto');

  finish(doneAnswer('youtube'));
  await idle();
  assert.deepEqual(env.badges(), [], 'terminou: o selo sai');
  assert.equal(env.tab.badge(), '');
  env.choose('youtube');
  assert.ok(env.q('[data-act="open-vod"]'), 'o resultado espera no cartão do YouTube');
});

test('download cancelado ou com erro também tira o selo "Baixando"', async () => {
  let finish;
  const env = load({ api: { 'sources:fetchVod': vodAnswer('twitch'), 'sources:download': () => new Promise((resolve) => { finish = resolve; }) } });
  await idle();
  env.choose('twitch');
  env.paste('https://www.twitch.tv/videos/123');
  env.q('[data-act="fetch"]').click();
  await idle();
  env.q('[data-act="download"]').click();
  await idle();
  assert.deepEqual(env.badges(), ['twitch']);
  finish({ ok: false, code: 'CANCELLED', message: 'Download cancelado.' });
  await idle();
  assert.deepEqual(env.badges(), []);
});

test('janela recarregada no meio do download: abre no cartão da plataforma dele, com o selo; o download do chat não muda o cartão', async () => {
  const resumed = load({ store: { sourceKind: 'obs' }, api: { 'sources:state': stateAnswer(downloadJob('twitch')) } });
  await idle();
  assert.deepEqual(resumed.pressed(), ['twitch']);
  assert.deepEqual(resumed.shown(), ['vod']);
  assert.deepEqual(resumed.badges(), ['twitch']);
  assert.ok(resumed.q('[data-section="vod"] .src-card.running'), 'a barra de progresso do download está à vista');

  const chat = load({ store: { sourceKind: 'obs' }, api: { 'sources:state': stateAnswer(chatJob) } });
  await idle();
  assert.deepEqual(chat.pressed(), ['obs'], 'chat não é download de vídeo');
  assert.deepEqual(chat.badges(), []);
});

// ------------------------------------------------------------------ chat do projeto e ganchos

test('a seção do chat só aparece com um projeto aberto', async () => {
  const none = load();
  await idle();
  assert.equal(none.q('[data-section="chat"]').hidden, true);
  const project = { id: 'p1', source: { path: 'D:\\Lives\\live.mp4', origin: null }, meta: {}, chat: null, cuts: [] };
  const open = load({ project });
  await idle();
  assert.equal(open.q('[data-section="chat"]').hidden, false);
  assert.deepEqual(open.shown(), ['files', 'chat']);
});

test('abrir um vídeo estando em Novo projeto leva para Cortes; estando em outra aba, a aba não muda', async () => {
  const env = load();
  await idle();
  await env.hooks.afterOpen({ path: 'D:\\a.mp4' });
  assert.deepEqual(env.selected, [], 'antes de qualquer aba ser mostrada não há o que deixar');
  env.busListeners['tab:changed']({ id: 'projects' });
  await env.hooks.afterOpen({ path: 'D:\\a.mp4' });
  assert.deepEqual(env.selected, [], 'quem abriu pela aba Projetos fica onde está');
  env.busListeners['tab:changed']({ id: 'sources' });
  await env.hooks.afterOpen({ path: 'D:\\a.mp4' });
  assert.deepEqual(env.selected, ['cuts'], 'soltar ou escolher o arquivo aqui segue para Cortes: o projeto já está pronto');
  env.busListeners['tab:changed']({ id: 'cuts' });
  await env.hooks.afterOpen({ path: 'D:\\b.mp4' });
  assert.deepEqual(env.selected, ['cuts'], 'já em Cortes: nada a fazer');
  env.busListeners['tab:changed']();
  await env.hooks.afterOpen({ path: 'D:\\c.mp4' });
  assert.deepEqual(env.selected, ['cuts'], 'evento sem dados não quebra nem leva a lugar nenhum');
});
