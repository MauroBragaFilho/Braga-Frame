'use strict';

/**
 * A aba Análise por dentro, com o renderer/features/analysis.js de verdade rodando num DOM de mentira (tests/prefs-fakedom.js):
 * estimativa de tempo ao retomar uma análise, ajustes corrigidos na tela, botão Analisar sem sinal utilizável, descartar e
 * restaurar sugestões, resultado de outro vídeo (project:adopt copia o `ext` inteiro) e "analisar de novo sem o guardado".
 * O desenho real (CSS, foco, teclado) é conferido em tests/e2e/analysis.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const model = require('../src/core/projects/model');
const params = require('../src/core/analysis/params');
const humor = require('../src/core/analysis/humor');
const { FakeNode, createDocument, makeEl } = require('./prefs-fakedom');

// o DOM de mentira não tem classList.toggle/remove, que a aba usa
Object.defineProperty(FakeNode.prototype, 'classList', {
  configurable: true,
  get() {
    const self = this;
    const names = () => self.className.split(/\s+/).filter(Boolean);
    const api = {
      contains: (c) => names().includes(c),
      add: (c) => { if (!names().includes(c)) self.className = [...names(), c].join(' '); },
      remove: (c) => { self.className = names().filter((n) => n !== c).join(' '); },
      toggle: (c, force) => {
        const on = force === undefined ? !names().includes(c) : Boolean(force);
        if (on) api.add(c); else api.remove(c);
        return on;
      }
    };
    return api;
  }
});

const { runAnalysis } = require('./analysis-scripts');
const SOURCE = { path: 'C:\\lives\\a.mp4', size: 5000, duration: 600 };
const OTHER = { path: 'C:\\lives\\obs-gravacao.mkv', size: 7000, duration: 650 };

const plain = (v) => JSON.parse(JSON.stringify(v));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const text = (node) => (typeof node.textContent === 'string' ? node.textContent : node.textContentDeep);
const S = (start, end, over = {}) => ({ id: `${start}_${end}`, start, end, peak: (start + end) / 2, relevance: 0.8, reasons: ['pico de áudio 5σ'], ...over });

/** ext.analysis de uma análise já feita (como o onDone grava). */
function savedAnalysis(source, suggestions, over = {}) {
  return {
    source, runAt: '2026-01-01T00:00:00.000Z', fromCache: false, tookMs: 4000, limit: 6, warnings: [],
    signals: { audio: { used: true, reason: '' }, image: { used: false, reason: 'desligado' }, chat: { used: false, reason: 'este vídeo não tem chat baixado' } },
    suggestions, ...over
  };
}

/**
 * Carrega a aba. `api(channel, payload)` responde ao BF.api (devolva undefined para o padrão `{ ok: true }`);
 * `calls` guarda tudo que a aba pediu ao processo principal.
 */
function load({ ext, source = SOURCE, cuts = [], info = { duration: source.duration, hasAudio: true }, chat = null, api, prefs = {} } = {}) {
  const doc = createDocument();
  const el = makeEl(doc);
  const tabs = [];
  const calls = [];
  const logs = [];
  const toasts = [];
  const emitted = [];
  const played = [];
  const busHandlers = new Map();
  const mainHandlers = new Map();
  const project = model.normalizeProject({ version: 2, id: 'p1', source, cuts, ext: ext || {}, chat });
  const BF = {
    state: { project, info, tools: { ffmpeg: 'f', ffprobe: 'p' } },
    util: { el },
    ui: { registerTab: (def) => tabs.push(def), log: (msg, kind) => logs.push([msg, kind]), toast: (msg) => toasts.push(msg), refreshTabs() {}, confirm: async () => true },
    bus: { on: (name, fn) => busHandlers.set(name, fn), emit: (name, data) => emitted.push([name, data]) },
    hooks: { add() {} },
    on: (channel, fn) => mainHandlers.set(channel, fn),
    api: async (channel, payload) => {
      calls.push([channel, payload]);
      const custom = api ? await api(channel, payload) : undefined;
      if (custom !== undefined) return custom;
      if (channel === 'analysis:defaults') return { ok: true, defaults: params.DEFAULTS, ranges: params.RANGES, version: params.ALGO_VERSION };
      if (channel === 'analysis:start') return { ok: true, jobId: 'a1' };
      return { ok: true };
    },
    ready: Promise.resolve(),
    prefs: { get: (key, fallback) => fallback, explain: () => null, scope: () => ({ game: '', channel: '' }), set: async () => ({ ok: true }), unset: async () => ({ ok: true }), ...prefs },
    model,
    player: { playRange: (a, b) => played.push([a, b]) },
    project: {
      update(mutator, { reason } = {}) {
        const result = mutator(project);
        emitted.push(['project:update', { reason }]);
        const onChanged = busHandlers.get('project:changed'); // como o BF.project.update de verdade
        if (onChanged) onChanged({ reason });
        return result;
      }
    }
  };
  runAnalysis(vm.createContext({ window: { BF, BFHumor: humor }, document: doc, setTimeout, URL }));
  const tab = tabs[0];
  const container = doc.register('container');
  tab.render(container);
  const q = (selector) => container.querySelector(selector);
  const all = (selector) => container.querySelectorAll(selector);
  return { BF, doc, tab, container, project, calls, logs, toasts, emitted, played, q, all, mainHandlers, busHandlers };
}

/** Título (<summary>) da seção recolhida "Descartadas". */
const dismissedTitle = (env) => env.q('#anDismissed').children[0];

/** Linhas da lista de sugestões (cada uma com seus botões). */
const rows = (env, listSelector = '#anList') => env.q(listSelector).children;

// ---------- retomar análise em andamento ----------

test('remainingSec: sem hora de início (0), progresso baixo/completo ou início no futuro não há estimativa; senão é proporcional', () => {
  const { BF } = load();
  const { remainingSec } = BF.analysis;
  const now = 1_700_000_000_000;
  assert.equal(remainingSec(0.2, 0, now), null, 'startedAt 0 era o defeito: a conta virava "agora - 1970"');
  assert.equal(remainingSec(0.2, undefined, now), null);
  assert.equal(remainingSec(0.02, now - 60000, now), null, 'menos de 5%: cedo demais');
  assert.equal(remainingSec(1, now - 60000, now), null);
  assert.equal(remainingSec(0.5, now + 5000, now), null, 'início no futuro');
  assert.equal(remainingSec(0.2, now - 60000, now), 240);
  assert.equal(remainingSec(0.5, now - 30000, now), 30);
});

test('retomar uma análise em andamento (interface recarregada): a estimativa usa o início real em vez de um tempo absurdo', async () => {
  const startedAt = Date.now() - 60000;
  const env = load({ api: (channel) => (channel === 'analysis:status'
    ? { ok: true, running: { jobId: 'a7', path: SOURCE.path, startedAt, p: 0.2, stage: 'audio', message: 'Lendo o áudio…' } }
    : undefined) });
  env.tab.onShow();
  await tick();
  await tick();
  const line = text(env.q('#anProgressText'));
  assert.match(line, /^Lendo o áudio… 20% · cerca de 4 min restantes$/, line);
  assert.equal(env.q('#anRun').disabled, true);
  assert.equal(env.q('#anCancel').hidden, false, 'dá para cancelar a análise retomada');

  // o main não informou a hora de início: sem estimativa em vez de inventar uma
  const noStart = load({ api: (channel) => (channel === 'analysis:status'
    ? { ok: true, running: { jobId: 'a8', path: SOURCE.path, p: 0.2, stage: 'audio', message: 'Lendo o áudio…' } }
    : undefined) });
  noStart.tab.onShow();
  await tick();
  await tick();
  assert.equal(text(noStart.q('#anProgressText')), 'Lendo o áudio… 20%');
});

// ---------- ajustes ----------

test('número fora da faixa: o campo passa a mostrar o valor que a análise vai usar (e é o que fica gravado)', () => {
  const env = load();
  const weight = env.q('#anWeight-audio');
  weight.value = '5';
  weight.dispatch('change');
  assert.equal(weight.value, '2', 'peso máximo é 2');
  assert.equal(env.project.ext.analysis.settings.weights.audio, 2);
  const lag = env.q('#anChatLag');
  lag.value = '500';
  lag.dispatch('change');
  assert.equal(lag.value, '60');
  assert.equal(env.project.ext.analysis.settings.chat.lagSec, 60);
  const win = env.q('#anChatWindow');
  win.value = '1';
  win.dispatch('change');
  assert.equal(win.value, '2');
  assert.equal(env.project.ext.analysis.settings.chat.windowSec, 2);
  // campo apagado ou com lixo volta ao valor em vigor, não fica vazio
  weight.value = '';
  weight.dispatch('change');
  assert.equal(weight.value, '2');
  // valor válido não muda
  weight.value = '0.5';
  weight.dispatch('change');
  assert.equal(weight.value, '0.5');
  assert.equal(env.project.ext.analysis.settings.weights.audio, 0.5);
});

test('Analisar só fica ativo com algum sinal utilizável; sem nenhum, a tela diz o motivo e nada é enviado', () => {
  const env = load();
  const run = env.q('#anRun');
  const warn = env.q('#anSignalWarn');
  assert.equal(run.disabled, false);
  assert.equal(warn.hidden, true);
  for (const id of ['audio', 'image', 'chat']) {
    const box = env.q(`#anSignal-${id}`);
    box.checked = false;
    box.dispatch('change');
  }
  assert.equal(run.disabled, true);
  assert.equal(warn.hidden, false);
  assert.match(text(warn), /Nenhum sinal utilizável/);
  assert.equal(env.q('#anFresh').disabled, true, 'o "analisar de novo" também');
  run.click(); // mesmo que o clique chegue, nada é enviado
  assert.equal(env.calls.filter(([channel]) => channel === 'analysis:start').length, 0);
  const image = env.q('#anSignal-image');
  image.checked = true;
  image.dispatch('change');
  assert.equal(run.disabled, false);
  assert.equal(warn.hidden, true);

  // vídeo sem áudio e sem chat: só a imagem conta
  const bare = load({ info: { duration: 600, hasAudio: false } });
  const boxImage = bare.q('#anSignal-image');
  boxImage.checked = false;
  boxImage.dispatch('change');
  assert.equal(bare.q('#anRun').disabled, true, 'áudio e chat estão marcados, mas este vídeo não tem nenhum dos dois');
  assert.equal(bare.q('#anSignalWarn').hidden, false);
  boxImage.checked = true;
  boxImage.dispatch('change');
  assert.equal(bare.q('#anRun').disabled, false);

  // com chat baixado, o chat volta a contar
  const withChat = load({ info: { duration: 600, hasAudio: false }, chat: { path: 'C:\\chat.json', format: 'bf-chat-1', count: 10, platform: 'twitch' } });
  const imageBox = withChat.q('#anSignal-image');
  imageBox.checked = false;
  imageBox.dispatch('change');
  assert.equal(withChat.q('#anRun').disabled, false);
});

// ---------- descartar ----------

const THREE = [S(100, 130, { relevance: 0.9 }), S(200, 230, { relevance: 0.8 }), S(300, 330, { relevance: 0.7 })];

test('descartar uma sugestão: some da lista e do selo SEM criar corte, fica em "Descartadas" e pode ser restaurada', () => {
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, THREE) } });
  assert.equal(rows(env).length, 3);
  assert.equal(env.q('#anDismissed').hidden, true, 'sem descartadas, a seção nem aparece');
  assert.equal(env.tab.badge(), 3);

  env.emitted.length = 0;
  rows(env)[1].querySelector('.an-dismiss').click();
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['100', '300']);
  assert.equal(env.project.cuts.length, 0, 'descartar não cria corte (nem rejeitado)');
  assert.equal(env.project.ext.analysis.dismissed.length, 1);
  assert.deepEqual(plain(env.project.ext.analysis.dismissed[0]), plain({ start: 200, end: 230, peak: 215, at: env.project.ext.analysis.dismissed[0].at }));
  assert.equal(env.tab.badge(), 2);
  assert.ok(!env.emitted.some(([name]) => name === 'cuts:changed' || name === 'decision'), 'nenhum evento de corte');
  assert.match(text(env.q('#anSummary')), /3 sugestão\(ões\) encontrada\(s\) · 1 descartada\(s\) · sinais usados/);
  assert.doesNotMatch(text(env.q('#anSummary')), /já nos cortes/);
  assert.equal(env.q('#anDismissed').hidden, false);
  assert.equal(env.q('#anDismissed').open, false, 'recolhida');
  assert.equal(text(dismissedTitle(env)), 'Descartadas (1)');
  assert.equal(rows(env, '#anDismissedList').length, 1);
  assert.equal(env.doc.activeElement, rows(env)[1].querySelector('.an-dismiss'), 'o foco vai para a linha que ocupou o lugar');

  // ver trecho continua funcionando na seção das descartadas
  rows(env, '#anDismissedList')[0].querySelector('.an-view').click();
  assert.deepEqual(plain(env.played), [[200, 230]]);

  // restaurar
  rows(env, '#anDismissedList')[0].querySelector('.an-restore').click();
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['100', '200', '300']);
  assert.deepEqual(plain(env.project.ext.analysis.dismissed), []);
  assert.equal(env.q('#anDismissed').hidden, true);
  assert.equal(env.tab.badge(), 3);
});

test('descartar todas e restaurar todas; a mensagem de lista vazia diz que foram descartadas (e não que viraram cortes)', () => {
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, THREE) } });
  const dismissAll = env.q('#anDismissAll');
  assert.equal(dismissAll.hidden, false);
  assert.equal(text(dismissAll), 'Descartar todas (3)');
  dismissAll.click();
  assert.equal(rows(env).length, 0);
  assert.equal(env.project.cuts.length, 0);
  assert.equal(env.q('#anEmpty').hidden, false);
  assert.match(text(env.q('#anEmpty')), /foram descartadas/);
  assert.equal(dismissAll.hidden, true);
  assert.equal(env.q('#anAddAll').hidden, true);
  assert.equal(env.tab.badge(), '');
  assert.equal(text(dismissedTitle(env)), 'Descartadas (3)');
  assert.ok(env.toasts.some((m) => /3 sugestão\(ões\) descartada\(s\)/.test(m) && /Nenhum corte foi criado/.test(m)));

  env.q('#anRestoreAll').click();
  assert.equal(rows(env).length, 3);
  assert.deepEqual(plain(env.project.ext.analysis.dismissed), []);
  assert.equal(env.q('#anDismissed').hidden, true);
});

test('sugestão que virou corte continua contando como "já nos cortes"; descartada não é confundida com ela', () => {
  const cuts = [{ id: 'c1', title: 'Rejeitado', start: 198, end: 232, status: 'rejected', origin: 'manual' }];
  const env = load({ cuts, ext: { analysis: savedAnalysis(SOURCE, THREE, { dismissed: [{ start: 300, end: 330, peak: 315 }] }) } });
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['100']);
  assert.match(text(env.q('#anSummary')), /3 sugestão\(ões\) encontrada\(s\) · 1 já nos cortes · 1 descartada\(s\)/);
  rows(env)[0].querySelector('.an-dismiss').click();
  assert.match(text(env.q('#anEmpty')), /nos cortes ou foram descartadas/);
  // só nos cortes (nada descartado): o texto de sempre
  const only = load({ cuts, ext: { analysis: savedAnalysis(SOURCE, [S(200, 230)]) } });
  assert.match(text(only.q('#anEmpty')), /Todas as sugestões já estão nos cortes \(inclusive as rejeitadas\)/);
});

test('uma nova análise do mesmo vídeo não traz de volta o que foi descartado (mesmo deslocado), mas mostra o que é novo', async () => {
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, THREE, { dismissed: [{ start: 100, end: 130, peak: 115 }] }) } });
  assert.equal(rows(env).length, 2);
  env.q('#anRun').click();
  await tick();
  const start = env.calls.find(([channel]) => channel === 'analysis:start');
  assert.ok(start && !('fresh' in start[1]), 'a análise normal não pede para ignorar o cache');
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 2000, limit: 6, warnings: [], usedSignals: ['audio'], params: {},
    signals: savedAnalysis(SOURCE, []).signals,
    suggestions: [S(98, 133, { relevance: 0.95 }), S(400, 430, { relevance: 0.6 })]
  } });
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['400'], 'a região descartada (98-133 cobre 100-130) fica de fora');
  assert.equal(text(dismissedTitle(env)), 'Descartadas (1)');
  assert.equal(env.project.ext.analysis.dismissed.length, 1, 'o descarte continua guardado');
  assert.deepEqual(plain(env.project.analysis.lastRun.count), 2);
  // restaurar a descartada (agora é a 98-133 da nova análise)
  rows(env, '#anDismissedList')[0].querySelector('.an-restore').click();
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['98', '400']);
});

test('restaurar uma sugestão não devolve outra que um descarte antigo (maior) também cobria', () => {
  const A = S(100, 125, { relevance: 0.9 });
  const B = S(126, 150, { relevance: 0.8 });
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, [A, B], { dismissed: [{ start: 100, end: 150, peak: 125 }] }) } });
  assert.equal(rows(env).length, 0);
  assert.equal(rows(env, '#anDismissedList').length, 2);
  // restaura a A: a B continua descartada
  rows(env, '#anDismissedList')[0].querySelector('.an-restore').click();
  assert.deepEqual(plain([...rows(env)].map((li) => li.dataset.start)), ['100']);
  assert.deepEqual(plain([...rows(env, '#anDismissedList')].map((li) => li.dataset.start)), ['126']);
});

// ---------- resultado de outro vídeo ----------

test('sameSource: mesmo caminho (barras e caixa não importam), tamanho e duração; sem identidade gravada não vale', () => {
  const { BF } = load();
  const same = BF.analysis.sameSource;
  assert.equal(same(SOURCE, { ...SOURCE }), true);
  assert.equal(same(SOURCE, { ...SOURCE, path: 'c:/LIVES/a.mp4' }), true);
  assert.equal(same(SOURCE, { ...SOURCE, path: 'C:\\lives\\b.mp4' }), false);
  assert.equal(same(SOURCE, { ...SOURCE, size: 5001 }), false);
  assert.equal(same(SOURCE, { ...SOURCE, duration: 601.5 }), false);
  assert.equal(same(SOURCE, { ...SOURCE, duration: 600.4 }), true, 'diferença de milissegundos entre leituras do ffprobe');
  assert.equal(same(SOURCE, { path: SOURCE.path, size: 0, duration: 0 }), true, 'fonte sem tamanho/duração conhecidos: vale pelo caminho');
  assert.equal(same(undefined, SOURCE), false);
  assert.equal(same({}, SOURCE), false);
});

test('projeto adotado para outro vídeo: as sugestões, os avisos e as descartadas do vídeo antigo NÃO aparecem como se fossem deste; os ajustes sim', () => {
  const ext = { analysis: savedAnalysis(SOURCE, THREE, {
    settings: { sensitivity: 5 }, dismissed: [{ start: 100, end: 130, peak: 115 }],
    warnings: [{ code: 'AUDIO_SHORT', message: 'aviso do vídeo antigo' }]
  }) };
  const adopted = load({ source: OTHER, ext });
  assert.equal(adopted.q('#anResults').hidden, true, 'nenhum resultado para o vídeo novo');
  assert.equal(adopted.tab.badge(), '');
  assert.equal(adopted.q('#anNotice').children.length, 0, 'avisos do outro vídeo não valem aqui');
  assert.equal(adopted.q('#anSensitivity').value, '5', 'os ajustes acompanham a adoção');
  // o mesmo ext no vídeo certo mostra tudo
  const original = load({ source: SOURCE, ext });
  assert.equal(original.q('#anResults').hidden, false);
  assert.equal(original.tab.badge(), 2);
  assert.equal(original.q('#anNotice').children.length, 1);

  // analisar o vídeo novo substitui o resultado e NÃO herda as descartadas do antigo
  adopted.q('#anRun').click();
  return tick().then(() => {
    adopted.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
      at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 1000, limit: 6, warnings: [], usedSignals: ['audio'], params: {},
      signals: savedAnalysis(OTHER, []).signals, suggestions: [S(100, 130)]
    } });
    assert.deepEqual(plain(adopted.project.ext.analysis.source), OTHER);
    assert.deepEqual(plain(adopted.project.ext.analysis.dismissed), []);
    assert.equal(adopted.project.ext.analysis.settings.sensitivity, 5);
    assert.equal(rows(adopted).length, 1, 'a sugestão em 100-130 do vídeo novo aparece (não é a descartada do antigo)');
  });
});

test('resultado sem identidade da fonte (guardado por uma versão antiga) não é mostrado até analisar de novo', () => {
  const old = savedAnalysis(SOURCE, THREE);
  delete old.source;
  const env = load({ ext: { analysis: old } });
  assert.equal(env.q('#anResults').hidden, true);
  assert.equal(env.tab.badge(), '');
});

// ---------- analisar de novo sem o guardado ----------

test('"Analisar de novo, sem usar o guardado" pede fresh:true ao processo principal; Analisar comum não', async () => {
  const env = load();
  env.q('#anFresh').click();
  await tick();
  const [channel, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.equal(channel, 'analysis:start');
  assert.equal(payload.fresh, true);
  assert.equal(payload.path, SOURCE.path);
  assert.equal(env.q('#anFresh').disabled, true, 'travado enquanto analisa');
  assert.equal(env.q('#anReset').disabled, true);
  assert.match(text(env.q('#anFresh')), /sem usar o guardado/);
  // dentro dos ajustes avançados (recolhidos), não na tela principal
  const advanced = env.q('.an-advanced');
  assert.equal(advanced.open, false);
  assert.ok(advanced.contains(env.q('#anFresh')) && advanced.contains(env.q('#anReset')));
});

test('poucos botões antes de analisar: os 4 passos, o seletor de motor, Analisar, os da transcrição, os da IA de chat, os do guia de cortes e os dois dos ajustes avançados (as seções que não são do passo escolhido só ficam escondidas por CSS)', () => {
  const env = load();
  const shown = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };
  // a transcrição (opcional no algoritmo) tem "Transcrever" e "Importar"; remover, cancelar e o resto só aparecem quando fazem sentido
  assert.deepEqual(env.all('button').filter(shown).map((b) => b.id).sort(), ['anEngine-ai', 'anEngine-algorithm', 'anEngine-both', 'anFresh', 'anMBuild', 'anMRead', 'anReset', 'anRun', 'anSkillReset', 'anSkillSave', 'anStep-method', 'anStep-results', 'anStep-settings', 'anStep-transcript', 'anTGenerate', 'anTImport']);
  assert.equal(env.q('.an-advanced').open, false);
  assert.equal(env.all('button').filter((b) => b.className.split(/\s+/).includes('primary') && shown(b)).length, 1, 'um destaque primário só');
});

// ---------- sinal de texto (transcrição) no algoritmo ----------

const TRANSCRIPT = { exists: true, stale: false, origin: 'imported', importedFrom: 'a.srt', coveredSec: 590, duration: 600, coverage: 0.98, cues: 120, laughs: 2, speechSec: 400, dropped: {} };
const transcriptApi = (transcript) => (channel) => (channel === 'analysis:transcriptStatus' ? { ok: true, transcript, engine: { ready: false, reason: 'O motor de transcrição não está pronto.' }, running: null } : undefined);

test('sinal "Texto": sem transcrição fica desligado e dizendo por quê; com transcrição conta como sinal utilizável e vai no pedido', async () => {
  const none = load({ api: transcriptApi({ exists: false }) });
  await tick();
  const box = none.q('#anSignal-text');
  assert.equal(box.disabled, true);
  assert.match(text(none.q('#anHint-text')), /sem transcrição deste vídeo/);
  assert.match(text(none.q('#anTLine')), /Sem transcrição/);
  assert.equal(text(none.q('#anTChip')), 'Opcional', 'no algoritmo a transcrição é opcional');
  // só o texto ligado e sem transcrição: nada utilizável
  for (const id of ['audio', 'image', 'chat']) { const b = none.q(`#anSignal-${id}`); b.checked = false; b.dispatch('change'); }
  assert.equal(none.q('#anRun').disabled, true);

  const env = load({ api: transcriptApi(TRANSCRIPT) });
  await tick();
  assert.equal(env.q('#anSignal-text').disabled, false);
  assert.equal(env.q('#anSignal-text').checked, true);
  assert.match(text(env.q('#anHint-text')), /risadas, exclamações, ritmo de fala e repetição/);
  assert.match(text(env.q('#anTLine')), /Cobre 9:50 de 10:00 \(98%\)/);
  env.q('#anRun').click();
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.equal(payload.engine, undefined, 'algoritmo');
  assert.equal(payload.projectId, 'p1', 'o processo principal procura a transcrição deste projeto');
  assert.equal(payload.size, SOURCE.size);
  assert.equal(payload.duration, SOURCE.duration);
  assert.equal(payload.params.signals.text, true);
  assert.deepEqual(plain(payload.params.weights), { audio: 0.8, image: 0.6, chat: 1, text: 1, calm: 0.7 });
  assert.deepEqual(plain(payload.params.textWeights), { laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1, structure: 1 });
  assert.equal(payload.params.profile, 'gameplay', 'tipo de vídeo padrão vai no pedido');
  assert.deepEqual(plain(payload.params.humor), { phrases: [], reactions: [] }, 'sem perfil do canal: nenhuma expressão');

  // só o texto ligado e COM transcrição: basta para analisar
  const onlyText = load({ api: transcriptApi(TRANSCRIPT) });
  await tick();
  for (const id of ['audio', 'image', 'chat']) { const b = onlyText.q(`#anSignal-${id}`); b.checked = false; b.dispatch('change'); }
  assert.equal(onlyText.q('#anRun').disabled, false);
  // transcrição de outro arquivo (stale) não conta
  const stale = load({ api: transcriptApi({ ...TRANSCRIPT, stale: true }) });
  await tick();
  assert.equal(stale.q('#anSignal-text').disabled, true);
  assert.equal(text(stale.q('#anTChip')), 'De outro arquivo');
});

test('Ajustes avançados trazem o peso do texto e o de cada pista da transcrição (recolhidos, corrigidos na tela e guardados no projeto)', () => {
  const env = load();
  const advanced = env.q('.an-advanced');
  assert.equal(advanced.open, false);
  for (const id of ['anWeight-audio', 'anWeight-image', 'anWeight-chat', 'anWeight-text', 'anTextWeight-laugh', 'anTextWeight-exclaim', 'anTextWeight-pace', 'anTextWeight-repeat', 'anTextWeight-meta', 'anTextWeight-humor']) {
    assert.ok(advanced.contains(env.q(`#${id}`)), `${id} dentro dos ajustes avançados`);
  }
  assert.equal(env.q('#anWeight-text').value, '1');
  assert.equal(env.q('#anWeight-audio').value, '0.8');
  const pace = env.q('#anTextWeight-pace');
  pace.value = '9';
  pace.dispatch('change');
  assert.equal(pace.value, '2', 'pista limitada a 0..2 e o campo mostra o valor que vale');
  assert.equal(env.project.ext.analysis.settings.textWeights.pace, 2);
  const laugh = env.q('#anTextWeight-laugh');
  laugh.value = '0';
  laugh.dispatch('change');
  assert.equal(env.project.ext.analysis.settings.textWeights.laugh, 0, 'peso 0 desliga a pista');
  env.q('#anReset').click();
  assert.equal(env.q('#anTextWeight-laugh').value, '1', 'Restaurar padrões');
  assert.equal(env.q('#anTextWeight-pace').value, '1');
});

test('Tipo de vídeo (perfil da análise): gameplay por padrão; conversa fica guardado no projeto, explica o que muda e vai no pedido', () => {
  const env = load();
  const select = env.q('#anProfile');
  assert.ok(env.q('#anSignals').contains(select), 'fica em "O que procurar", à vista');
  assert.equal(select.value, 'gameplay');
  assert.match(text(env.q('#anProfileHint')), /Exclamações/);
  assert.ok(env.q('.an-advanced').contains(env.q('#anTextWeight-structure')), 'o peso da pista de estrutura fica nos ajustes avançados');
  select.value = 'conversa';
  select.dispatch('change');
  assert.equal(env.project.ext.analysis.settings.profile, 'conversa');
  assert.match(text(env.q('#anProfileHint')), /trocas de câmera/);
  env.q('#anReset').click();
  assert.equal(env.q('#anProfile').value, 'gameplay', 'Restaurar padrões');
});

test('Separar por episódios: ligado por padrão, vai no pedido; cada sugestão mostra o episódio e o resumo conta episódios e espera', async () => {
  const env = load();
  const box = env.q('#anEpisodes');
  assert.ok(env.q('#anSignals').contains(box), 'fica em "O que procurar", à vista');
  assert.equal(box.checked, true);
  assert.match(text(env.q('#anEpisodesHint')), /telas de espera/);
  box.checked = false;
  box.dispatch('change');
  assert.equal(env.project.ext.analysis.settings.episodes, false, 'fica guardado no projeto');
  env.q('#anReset').click();
  assert.equal(env.q('#anEpisodes').checked, true, 'Restaurar padrões');
  env.q('#anRun').click();
  await tick();
  const start = env.calls.find(([channel]) => channel === 'analysis:start');
  assert.equal(start[1].params.episodes, true, 'vai no pedido');
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 2000, limit: 6, warnings: [], usedSignals: ['audio'], params: {},
    signals: savedAnalysis(SOURCE, []).signals,
    episodes: [{ start: 60, end: 300 }, { start: 360, end: 540 }],
    breaks: [{ start: 0, end: 60 }, { start: 300, end: 360 }, { start: 540, end: 600 }],
    suggestions: [S(100, 130, { relevance: 0.9, episode: 1 }), S(400, 430, { relevance: 0.7, episode: 2 })]
  } });
  assert.deepEqual([...rows(env)].map((li) => text(li.querySelector('.an-episode'))), ['Episódio 1', 'Episódio 2']);
  assert.match(text(env.q('#anSummary')), /2 episódios · telas de espera puladas .3 min./);
  assert.equal(env.project.ext.analysis.suggestions[1].episode, 2, 'o episódio fica guardado com a sugestão');
  assert.deepEqual(plain(env.project.ext.analysis.breaks), [{ start: 0, end: 60 }, { start: 300, end: 360 }, { start: 540, end: 600 }]);
  // sem espera (análise antiga ou opção desligada): nem chip, nem contagem
  const old = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)]) } });
  assert.equal(rows(old)[0].querySelector('.an-episode'), null);
  assert.doesNotMatch(text(old.q('#anSummary')), /episódio|espera/);
});

test('Quantidade automática e filtro de ideias fracas: padrões, o controle por hora trava na automática, vão no pedido e o resumo conta as descartadas', async () => {
  const env = load();
  const auto = env.q('#anAutoQty');
  const filter = env.q('#anFilterWeak');
  assert.equal(auto.checked, false, 'quantidade fixa por padrão');
  assert.equal(filter.checked, true, 'filtro ligado por padrão');
  assert.equal(env.q('#anPerHour').disabled, false);
  auto.checked = true;
  auto.dispatch('change');
  assert.equal(env.project.ext.analysis.settings.autoQuantity, true, 'fica no projeto');
  assert.equal(env.q('#anPerHour').disabled, true, 'na automática o "por hora" não vale');
  assert.match(text(env.all('.an-out')[1]), /automática/, 'a saída da Quantidade diz "automática"');
  env.q('#anRun').click();
  await tick();
  const start = env.calls.find(([channel]) => channel === 'analysis:start');
  assert.equal(start[1].params.autoQuantity, true);
  assert.equal(start[1].params.filterWeak, true);
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 2000, limit: 30, warnings: [], usedSignals: ['audio', 'text'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, filter: { on: true, voicePerHour: 60, discarded: 7 }, filtered: [],
    suggestions: [S(100, 130), S(200, 230)]
  } });
  assert.match(text(env.q('#anSummary')), /7 ideias fracas descartadas/);
  assert.deepEqual(plain(env.project.ext.analysis.filter), { on: true, discarded: 7 });
});

test('Ordem da lista: mais relevantes primeiro por padrão; "Ordem dos episódios" mostra pela ordem do vídeo, fica no projeto e não muda o resto', async () => {
  const EPS = { episodes: [{ start: 60, end: 300 }, { start: 360, end: 540 }], breaks: [{ start: 0, end: 60 }, { start: 300, end: 360 }, { start: 540, end: 600 }] };
  const sugs = [S(400, 430, { relevance: 0.95, episode: 2 }), S(100, 130, { relevance: 0.9, episode: 1 }), S(200, 230, { relevance: 0.7, episode: 1 })];
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, sugs, EPS) } });
  const order = env.q('#anOrder');
  const starts = (e) => [...rows(e)].map((li) => li.dataset.start);
  assert.equal(env.q('.an-order').hidden, false);
  assert.ok(env.q('#anResults').contains(order) && !env.q('.an-results-head').contains(order), 'numa linha própria, logo acima da lista (o topo continua com os botões em massa)');
  assert.equal(order.value, 'relevance');
  assert.equal(text(order.children[1]), 'Ordem dos episódios');
  assert.deepEqual(starts(env), ['400', '100', '200'], 'padrão: a mais relevante primeiro');
  order.value = 'time';
  order.dispatch('change');
  assert.deepEqual(starts(env), ['100', '200', '400'], 'ordem do vídeo: episódio 1, depois o 2');
  assert.deepEqual([...rows(env)].map((li) => text(li.querySelector('.an-episode'))), ['Episódio 1', 'Episódio 1', 'Episódio 2']);
  assert.equal(env.project.ext.analysis.listOrder, 'time', 'fica no projeto');
  assert.equal(env.project.ext.analysis.suggestions[0].start, 400, 'o resultado guardado não muda');
  // descartar a primeira da tela (a de 100 s) e conferir que a ordem continua
  rows(env)[0].querySelector('.an-dismiss').click();
  assert.deepEqual(starts(env), ['200', '400']);
  // reabrir o projeto: a escolha continua
  const again = load({ ext: { analysis: { ...savedAnalysis(SOURCE, sugs, EPS), listOrder: 'time' } } });
  assert.equal(again.q('#anOrder').value, 'time');
  assert.deepEqual(starts(again), ['100', '200', '400']);
  // uma análise nova mantém a escolha
  again.q('#anRun').click();
  await tick();
  again.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 2000, limit: 6, warnings: [], usedSignals: ['audio'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, ...EPS,
    suggestions: [S(450, 480, { relevance: 0.99, episode: 2 }), S(70, 100, { relevance: 0.6, episode: 1 })]
  } });
  assert.equal(again.project.ext.analysis.listOrder, 'time');
  assert.deepEqual(starts(again), ['70', '450']);
  // sem episódios: "Ordem do vídeo"; com uma sugestão só, a escolha nem aparece
  const plainVideo = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130), S(200, 230)]) } });
  assert.equal(text(plainVideo.q('#anOrder').children[1]), 'Ordem do vídeo');
  const single = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)]) } });
  assert.equal(single.q('.an-order').hidden, true);
});

// ---------- dicas de volume removidas, provedor escolhido pelo usuário, aceite sem prazo ----------

const PRESETS = [
  { id: 'gemini', label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', suggestedModel: 'gemini-2.5-flash' },
  { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', suggestedModel: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', suggestedModel: 'google/gemini-2.5-flash' },
  { id: 'custom', label: 'Personalizado', baseUrl: '', suggestedModel: '' }
];
const FILE_NOTE = 'O sistema não oferece cifragem aqui: a chave fica em um arquivo local sem cifra, com permissão restrita à sua conta.';
const SAFE_NOTE = 'A chave é guardada cifrada pelo Windows (só a sua conta lê).';
const aiState = (over = {}, provider = {}) => ({
  source: 'local', hostName: null, readOnly: false, presets: PRESETS, selected: null,
  provider: { source: 'local', id: null, label: '', model: '', suggestedModel: '', baseUrl: '', host: '', hasKey: false, keyStatus: 'none', keyRequired: true, keyHint: '', ready: false, reason: 'Escolha o provedor de IA.', accepted: false, privacy: '', ...provider },
  ready: false, accepted: false, encryption: 'safeStorage', encryptionNote: SAFE_NOTE,
  limits: { maxCalls: 14, maxInputTokens: 24000, windowMinutes: 35, attempts: 3 }, limitRanges: { maxCalls: [2, 60] }, ...over
});
const aiApi = (state, extra) => (channel, payload) => {
  if (channel === 'analysis:aiState' || channel === 'analysis:aiSave' || channel === 'analysis:aiAccept') return { ok: true, ai: typeof state === 'function' ? state(channel, payload) : state };
  return extra ? extra(channel, payload) : undefined;
};

test('IA: nenhum provedor vem escolhido; a aba pede a escolha, trava o resto e não envia nada', async () => {
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(aiState({ encryption: 'file', encryptionNote: FILE_NOTE }), transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  const select = env.q('#anCfgProvider');
  assert.equal(select.value, '', 'a lista começa em "Escolha um provedor…"');
  assert.equal(text(select.children[0]), 'Escolha um provedor…');
  assert.equal(select.children[0].disabled, true, 'e essa opção não dá para escolher de volta');
  assert.deepEqual(plain(select.children.slice(1).map((o) => o.attrs.value ?? o.value)), ['gemini', 'groq', 'openrouter', 'custom']);
  assert.match(text(env.q('#anProvider')), /Escolha o provedor e o modelo de IA\. Nada é enviado antes de você escolher/);
  assert.equal(text(env.q('#anPChip')), 'Falta configurar');
  assert.equal(env.q('#anCfgModel').value, '', 'o modelo também não vem preenchido');
  assert.equal(env.q('#anCfgModel').disabled, true);
  assert.equal(env.q('#anCfgKey').disabled, true);
  assert.equal(env.q('#anCfgKeySave').disabled, true);
  assert.equal(env.q('#anCfgAccept').disabled, true, 'não dá para aceitar o aviso de um provedor que não existe');
  assert.equal(env.q('#anCfgAccept').checked, false);
  assert.equal(env.q('#anCfgTest').disabled, true);
  assert.equal(env.q('#anRun').disabled, true);
  assert.match(text(env.q('#anAiWarn')), /Escolha o provedor de IA\./);
  assert.equal(env.q('#anAiConfig').open, true, 'sem provedor o cartão de configuração já vem aberto');
  env.q('#anRun').click();
  await tick();
  assert.deepEqual(env.calls.filter(([c]) => c === 'analysis:start' || c === 'analysis:aiAccept' || c === 'analysis:aiTest').map(([c]) => c), [], 'nada foi pedido ao processo principal');
  // a escolha automática de motor também ignora a IA enquanto não houver provedor pronto E aceito
  const auto = load({ api: aiApi(aiState(), transcriptApi(TRANSCRIPT)) });
  await tick();
  assert.equal(auto.BF.analysis.engineChoice(), 'algorithm');
  assert.match(text(auto.q('#anEngineHint')), /escolhido automaticamente/);
});

test('IA: escolhido o provedor, o modelo continua vazio (só uma sugestão no campo e na lista); o aviso de chave sem cifra aparece como alerta', async () => {
  const state = aiState({ selected: 'groq', encryption: 'file', encryptionNote: FILE_NOTE }, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', suggestedModel: 'llama-3.3-70b-versatile', reason: 'Informe o modelo.' });
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(state, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.q('#anCfgProvider').value, 'groq');
  assert.equal(env.q('#anCfgModel').value, '', 'sem modelo padrão');
  assert.equal(env.q('#anCfgModel').placeholder, 'ex.: llama-3.3-70b-versatile');
  assert.equal(env.q('#anCfgModel').disabled, false);
  assert.equal(env.q('#anCfgModel').getAttribute('list'), 'anCfgModelList');
  assert.equal(env.q('#anCfgModelList').children.length, 1);
  assert.equal(env.q('#anCfgModelList').children[0].value, 'llama-3.3-70b-versatile');
  assert.equal(env.q('#anCfgKey').disabled, false);
  // chave em arquivo sem cifra (decisão do dono: aceito, com aviso): o texto aparece na tela em estilo de alerta
  const note = env.q('#anCfgEnc');
  assert.equal(text(note), FILE_NOTE);
  assert.match(note.className, /an-warn/);
  // com cifragem do sistema: texto discreto
  const safe = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(aiState({ selected: 'groq' }, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', reason: 'Informe o modelo.' }), transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(text(safe.q('#anCfgEnc')), SAFE_NOTE);
  assert.doesNotMatch(safe.q('#anCfgEnc').className, /an-warn/);
  assert.equal(safe.all('#anHints').length, 0, 'não existe mais a opção "Dicas de volume"');
});

test('IA: "Ver modelos disponíveis" busca a lista do provedor, mostra no seletor e na sugestão do campo; escolher salva; erro aparece', async () => {
  const state = aiState({ selected: 'groq' }, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', suggestedModel: 'llama-3.3-70b-versatile', model: 'velho', hasKey: true, keyStatus: 'stored', reason: '' });
  let modelsReply = { ok: true, provider: 'groq', models: ['llama-3.3-70b-versatile', 'qwen-4-32b', 'velho'], hidden: 2 };
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(state, (channel) => (channel === 'analysis:aiModels' ? modelsReply : transcriptApi(TRANSCRIPT)(channel))) });
  await tick();
  await tick();
  const btn = env.q('#anCfgModels');
  assert.ok(btn && !btn.hidden && !btn.disabled, 'o botão aparece ao lado do campo Modelo');
  assert.equal(env.q('#anCfgModelPick').hidden, true, 'sem lista buscada, sem seletor');
  btn.click();
  await tick();
  await tick();
  assert.equal(env.calls.filter(([c]) => c === 'analysis:aiModels').length, 1);
  const pick = env.q('#anCfgModelPick');
  assert.equal(pick.hidden, false);
  assert.equal(pick.children.length, 4, 'a frase de escolha + os 3 modelos');
  assert.match(text(pick.children[3]), /velho .em uso./);
  assert.equal(env.q('#anCfgModelList').children.length, 3, 'o campo também sugere os modelos (sem repetir a sugestão)');
  assert.match(text(env.q('#anCfgModelsOut')), /3 modelos disponíveis neste provedor .2 outros, de embedding, voz ou imagem, ficaram de fora./);
  pick.value = 'qwen-4-32b';
  pick.dispatch('change');
  await tick();
  assert.deepEqual(plain(env.calls.filter(([c]) => c === 'analysis:aiSave').map(([, p]) => p)).pop(), { model: 'qwen-4-32b' });
  // a busca falha: a mensagem do processo principal aparece no lugar
  modelsReply = { ok: false, code: 'AUTH', message: 'O provedor recusou a chave de API.' };
  btn.click();
  await tick();
  await tick();
  assert.match(text(env.q('#anCfgModelsOut')), /recusou a chave/);
  assert.equal(env.q('#anCfgModelPick').hidden, true);
});

test('IA: análise que falha por modelo recusado oferece "Ver modelos disponíveis" no aviso, ao lado de "Usar o algoritmo"', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'velho', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(ready, (channel) => {
    if (channel === 'analysis:start') return { ok: false, code: 'MODEL', message: 'O provedor não encontrou o modelo (ou o endereço). Confira o nome do modelo.' };
    if (channel === 'analysis:aiModels') return { ok: true, provider: 'custom', models: ['novo'], hidden: 0 };
    return transcriptApi(TRANSCRIPT)(channel);
  }) });
  await tick();
  await tick();
  env.q('#anRun').click();
  await tick();
  await tick();
  const help = env.q('#anModelHelp');
  assert.ok(help, 'o aviso oferece a lista');
  assert.ok(env.q('#anUseAlgorithm'), 'e continua oferecendo o algoritmo');
  help.click();
  await tick();
  await tick();
  assert.equal(env.q('#anAiConfig').open, true, 'abre o cartão do provedor');
  assert.equal(env.calls.filter(([c]) => c === 'analysis:aiModels').length, 1);
  assert.equal(env.q('#anCfgModelPick').hidden, false);
});

test('IA: sem "Dicas de volume" na tela, nas configurações salvas nem no pedido; o pedido não carrega audioHints', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true, accepted_note: 1 }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ ext: { analysis: { settings: { engine: 'ai', audioHints: true } } }, api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.all('#anHints').length, 0);
  assert.ok(!/Dicas de volume|dicas de volume/i.test(text(env.container)), 'a tela não fala em dicas de volume');
  env.q('#anRun').click();
  await tick();
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.equal(payload.engine, 'ai');
  assert.ok(!('audioHints' in payload), 'o pedido não leva dicas de volume');
  assert.ok(!('audioHints' in plain(env.project.ext.analysis.settings)), 'e a configuração do projeto também não');
});

test('aviso de privacidade: vale até o usuário revogar (sem prazo); no Personalizado vale para aquele endereço e trocar o endereço o pede de novo', async () => {
  const custom = aiState({ selected: 'custom', ready: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'https://a.exemplo/v1', host: 'a.exemplo', model: 'm', keyRequired: false, hasKey: true, keyStatus: 'ok', ready: true, reason: '', accepted: false, privacy: 'O conteúdo vai para o servidor que você informou.' });
  const confirms = [];
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(custom, transcriptApi(TRANSCRIPT)) });
  env.BF.ui.confirm = async (opts) => { confirms.push(opts); return false; };
  await tick();
  await tick();
  env.q('#anRun').click();
  await tick();
  assert.equal(confirms.length, 1);
  assert.equal(confirms[0].title, 'Enviar trechos para a IA?');
  assert.match(confirms[0].message, /Quem recebe: Personalizado \(a\.exemplo\)/);
  assert.match(confirms[0].message, /para este provedor e este endereço até você revogar/);
  assert.match(confirms[0].message, /se mudar o endereço, ele é pedido de novo/);
  assert.match(confirms[0].message, /Não tem prazo\./);
  assert.doesNotMatch(confirms[0].message, /expira|dias|renov/i);
  assert.equal(env.calls.filter(([c]) => c === 'analysis:start' || c === 'analysis:aiAccept').length, 0, 'recusar não envia nem registra nada');
  // provedor fixo: o texto não fala de endereço
  const fixed = aiState({ selected: 'groq', ready: true }, { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', host: 'api.groq.com', model: 'm', hasKey: true, keyStatus: 'ok', ready: true, reason: '', accepted: false });
  const env2 = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(fixed, transcriptApi(TRANSCRIPT)) });
  const confirms2 = [];
  env2.BF.ui.confirm = async (opts) => { confirms2.push(opts); return false; };
  await tick();
  await tick();
  env2.q('#anRun').click();
  await tick();
  assert.match(confirms2[0].message, /O aviso fica aceito para este provedor até você revogar\. Não tem prazo\./);

  // trocar o endereço de um Personalizado com aceite: a tela avisa que o aviso será pedido de novo (e que a chave só some se mudar de servidor)
  const accepted = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'https://a.exemplo/v1', host: 'a.exemplo', model: 'm', keyRequired: false, hasKey: true, keyStatus: 'ok', ready: true, reason: '', accepted: true });
  const env3 = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(accepted, transcriptApi(TRANSCRIPT)) });
  const confirms3 = [];
  env3.BF.ui.confirm = async (opts) => { confirms3.push(opts); return true; };
  await tick();
  await tick();
  const url = env3.q('#anCfgUrl');
  url.value = 'https://a.exemplo/outro/v1'; // mesmo servidor, outro caminho
  url.dispatch('change');
  await tick();
  assert.equal(confirms3.length, 1);
  assert.match(confirms3[0].message, /Outro endereço é outro destinatário: o aviso de privacidade precisa ser aceito de novo\./);
  assert.doesNotMatch(confirms3[0].message, /chave guardada também é apagada/, 'mesmo servidor: a chave fica');
  assert.deepEqual(plain(env3.calls.filter(([c]) => c === 'analysis:aiSave').map(([, p]) => p)), [{ baseUrl: 'https://a.exemplo/outro/v1' }]);
  url.value = 'https://b.exemplo/v1'; // outro servidor
  url.dispatch('change');
  await tick();
  assert.match(confirms3[1].message, /A chave guardada também é apagada/);
});

test('IA no BDS com o OpenRouter: o interruptor "Usar apenas modelos gratuitos" aparece (ligado), o modelo pago explica a recusa, e desligar manda só freeOnly; com outro provedor do BDS ele não aparece', async () => {
  const hostProvider = { source: 'host', hostName: 'BDS', id: 'openrouter', label: 'OpenRouter', model: 'vendor/pago-barato', host: 'openrouter.ai', hasKey: true, keyRequired: true, accepted: true, consentKey: 'host:openrouter', ready: false, reasonCode: 'NOT_FREE', reason: 'O modelo "vendor/pago-barato" não é gratuito. O assistente do BDS usa o OpenRouter e, com "Usar apenas modelos gratuitos" ligado, o app só usa modelos gratuitos: nada foi enviado e nada foi cobrado.', freeCapable: true, freeOnly: true };
  let current = aiState({ source: 'host', hostName: 'BDS', readOnly: true, presets: [], selected: null, accepted: true }, hostProvider);
  const saves = [];
  const env = load({
    ext: { analysis: { settings: { engine: 'ai' } } },
    api: aiApi((channel, payload) => {
      if (channel === 'analysis:aiSave') {
        saves.push(payload);
        current = { ...current, provider: { ...current.provider, freeOnly: payload.freeOnly, ready: payload.freeOnly === false, reasonCode: payload.freeOnly === false ? undefined : 'NOT_FREE', reason: payload.freeOnly === false ? '' : hostProvider.reason }, ready: payload.freeOnly === false };
      }
      return current;
    }, transcriptApi(TRANSCRIPT))
  });
  await tick();
  await tick();
  assert.equal(env.q('#anHostFreeBox').hidden, false, 'o interruptor aparece quando o provedor do BDS é o OpenRouter');
  assert.equal(env.q('#anHostFree').checked, true, 'ligado por padrão');
  assert.equal(env.q('#anCfgLocal').hidden, true, 'o resto da configuração continua do BDS (só leitura)');
  assert.match(text(env.q('#anProvider')), /vendor\/pago-barato.*não é gratuito.*assistente do BDS usa o OpenRouter/);
  assert.equal(text(env.q('#anPChip')), 'Falta configurar');
  assert.equal(env.q('#anRun').disabled, true, 'com o modelo pago e o modo ligado, Analisar fica travado');
  // desligar é explícito e manda SÓ o interruptor
  env.q('#anHostFree').checked = false;
  env.q('#anHostFree').dispatch('change');
  await tick();
  await tick();
  assert.deepEqual(plain(saves), [{ freeOnly: false }]);
  assert.equal(env.q('#anHostFree').checked, false);
  assert.equal(text(env.q('#anPChip')), 'Pronto');
  // outro provedor do BDS (sem modo gratuito): o interruptor nem aparece
  const groq = aiState({ source: 'host', hostName: 'BDS', readOnly: true, presets: [], selected: null }, { source: 'host', hostName: 'BDS', id: 'groq', label: 'Groq', model: 'm', host: 'api.groq.com', hasKey: true, ready: true, reason: '', accepted: false });
  const env2 = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(groq, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env2.q('#anHostFreeBox').hidden, true);
});

// ---------- perfil de humor do canal ----------

/** Preferências de mentira com o perfil de humor guardado em `store.value` (o `set`/`unset` o trocam, como o BF.prefs de verdade). */
function humorPrefs(store, { scope = 'general', scopeName = '', names = { game: '', channel: '' } } = {}) {
  return {
    get: (key, fallback) => (key === 'analysis.humor' && store.value ? store.value : fallback),
    explain: (key) => (key === 'analysis.humor' && store.value ? { value: store.value, scope, scopeName, source: 'explicit' } : null),
    scope: () => names,
    set: async (key, value, where) => { store.sets.push([key, plain(value), where]); store.value = value; return { ok: true }; },
    unset: async (key, where) => { store.unsets.push([key, where]); store.value = null; return { ok: true }; }
  };
}
const newStore = (value = null) => ({ value, sets: [], unsets: [] });

test('perfil de humor: cartão recolhido; sem perfil diz "Não definido"; com perfil mostra o resumo e de onde vem; Salvar e Limpar só aparecem quando fazem sentido', async () => {
  const none = load();
  await tick();
  assert.equal(text(none.q('#anHChip')), 'Não definido');
  assert.equal(none.q('#anHConfig').open, false, 'recolhido');
  assert.ok(none.q('#anHumor').contains(none.q('#anHConfig')));
  assert.equal(text(none.q('#anHConfig').children[0]), 'Definir o perfil');
  assert.equal(none.q('#anHSave').hidden, true, 'nada para salvar');
  assert.equal(none.q('#anHClear').hidden, true, 'nada para limpar');
  assert.equal(none.q('#anHExamples').checked, true, 'os exemplos nascem ligados (o perfil só vale depois de escrito e salvo)');
  assert.match(text(none.q('#anHLine')), /Diga o que é um bom corte do seu canal/);

  const store = newStore({ criteria: 'Humor seco.', catchphrases: ['bora', 'beco moleque'], reactions: ['eita'], examples: false });
  const env = load({ prefs: humorPrefs(store, { scope: 'channel', scopeName: 'Braga', names: { game: 'Minecraft', channel: 'Braga' } }) });
  await tick();
  assert.equal(text(env.q('#anHChip')), 'Em uso');
  assert.equal(text(env.q('#anHLine')), 'critérios · 2 bordões · 1 palavra de reação · salvo para canal Braga');
  assert.equal(text(env.q('#anHConfig').children[0]), 'Editar o perfil');
  assert.equal(env.q('#anHCriteria').value, 'Humor seco.');
  assert.equal(env.q('#anHPhrases').value, 'bora, beco moleque');
  assert.equal(env.q('#anHReactions').value, 'eita');
  assert.equal(env.q('#anHExamples').checked, false);
  assert.equal(env.q('#anHExamplesBox').hidden, true, 'sem exemplos ligados a caixa de exemplos some');
  assert.equal(env.q('#anHSave').hidden, true);
  assert.equal(env.q('#anHClear').hidden, false);
  assert.equal(env.q('#anHCount').textContent, '11/1500');
  assert.equal(env.q('#anHScope').value, 'channel', 'onde o perfil em vigor está salvo é onde o Salvar vai por padrão');
  assert.deepEqual(plain(Array.from(env.q('#anHScope').children, (o) => [o.value, Boolean(o.disabled), text(o)])), [
    ['channel', false, 'Canal: Braga'], ['game', false, 'Jogo: Minecraft'], ['general', false, 'Todos os vídeos']
  ]);
  // sem canal nem jogo no projeto só "Todos os vídeos" está disponível
  assert.deepEqual(plain(Array.from(none.q('#anHScope').children, (o) => [o.value, Boolean(o.disabled)])), [['channel', true], ['game', true], ['general', false]]);
  assert.equal(none.q('#anHScope').value, 'general');
  // poucos botões: só os de sempre continuam visíveis (Salvar e Limpar aparecem quando fazem sentido)
  const shown = (node) => { for (let n = node; n; n = n.parent) if (n.hidden) return false; return true; };
  assert.deepEqual(none.all('button').filter(shown).map((b) => b.id).sort(), ['anEngine-ai', 'anEngine-algorithm', 'anEngine-both', 'anFresh', 'anMBuild', 'anMRead', 'anReset', 'anRun', 'anSkillReset', 'anSkillSave', 'anStep-method', 'anStep-results', 'anStep-settings', 'anStep-transcript', 'anTGenerate', 'anTImport']);
});

test('perfil de humor: editar mostra "Salvar"; salvar grava o perfil LIMPO nas Preferências do escopo escolhido; recusa o vazio; limpar pede confirmação', async () => {
  const store = newStore();
  const env = load({ prefs: humorPrefs(store, { names: { game: '', channel: 'Braga' } }) });
  await tick();
  const type = (id, value) => { const node = env.q(id); node.value = value; node.dispatch('input'); };
  type('#anHCriteria', '  Humor seco\n\n\n\nsem grito ');
  assert.equal(env.q('#anHSave').hidden, false, 'há o que salvar');
  type('#anHPhrases', 'Bora, BORA; Beco moleque');
  type('#anHReactions', 'eita, tenso');
  env.q('#anHExamples').checked = false;
  env.q('#anHExamples').dispatch('change');
  assert.match(text(env.q('#anHStatus')), /Alterações ainda não salvas/);
  assert.equal(env.q('#anHScope').value, 'channel', 'sem perfil salvo o mais específico disponível (o canal)');
  env.q('#anHSave').click();
  await tick();
  assert.deepEqual(store.sets, [['analysis.humor', { criteria: 'Humor seco\n\nsem grito', catchphrases: ['Bora', 'Beco moleque'], reactions: ['eita', 'tenso'], themes: [], examples: false }, 'channel']]);
  assert.ok(env.toasts.some((m) => /Perfil de humor salvo/.test(m)));
  assert.equal(env.q('#anHSave').hidden, true, 'salvo: nada mais a salvar');
  assert.equal(env.q('#anHPhrases').value, 'Bora, Beco moleque', 'a tela mostra o que ficou guardado (limpo)');
  assert.equal(text(env.q('#anHChip')), 'Em uso');
  assert.equal(env.q('#anHClear').hidden, false);
  assert.equal(env.doc.activeElement, env.q('#anHConfig').children[0], 'o foco vai para o título da seção quando o botão some');

  // esvaziar tudo: o Salvar fica travado (o caminho para remover é o Limpar)
  type('#anHCriteria', '');
  type('#anHPhrases', '');
  type('#anHReactions', '');
  assert.equal(env.q('#anHSave').hidden, false);
  assert.equal(env.q('#anHSave').disabled, true);
  assert.match(text(env.q('#anHStatus')), /Escreva ao menos um critério, um bordão ou uma palavra de reação/);
  env.q('#anHSave').click();
  await tick();
  assert.equal(store.sets.length, 1, 'nada foi gravado');

  // limpar: pede confirmação; recusar não remove, aceitar remove no escopo de onde o perfil vem
  env.BF.ui.confirm = async () => false;
  env.q('#anHClear').click();
  await tick();
  assert.deepEqual(store.unsets, []);
  env.BF.ui.confirm = async (opts) => { env.confirmed = opts; return true; };
  env.q('#anHClear').click();
  await tick();
  assert.deepEqual(store.unsets, [['analysis.humor', 'general']], 'o explain() de mentira diz que o perfil é geral');
  assert.match(env.confirmed.message, /perfil salvo para todos os vídeos/);
  assert.equal(text(env.q('#anHChip')), 'Não definido');
  assert.equal(env.q('#anHClear').hidden, true);
  assert.equal(env.q('#anHCriteria').value, '');
});

test('perfil de humor: o rascunho de quem está editando não é sobrescrito, nem por mudança nas Preferências, e vale de novo ao abrir outro vídeo', async () => {
  const store = newStore({ criteria: 'Antigo.' });
  const env = load({ prefs: humorPrefs(store) });
  await tick();
  assert.equal(env.q('#anHCriteria').value, 'Antigo.');
  env.q('#anHCriteria').value = 'Rascunho novo';
  env.q('#anHCriteria').dispatch('input');
  // outra aba muda a preferência: a tela de quem digita não perde o texto
  store.value = { criteria: 'Mudou lá fora.' };
  env.busHandlers.get('prefs:changed')({ keys: ['analysis.humor'] });
  assert.equal(env.q('#anHCriteria').value, 'Rascunho novo');
  assert.match(text(env.q('#anHLine')), /Mudou|critérios/, 'o resumo mostra o que está em vigor');
  // abrir outro vídeo descarta o rascunho (era do vídeo anterior) e mostra o perfil em vigor
  env.busHandlers.get('project:loaded')();
  assert.equal(env.q('#anHCriteria').value, 'Mudou lá fora.');
  assert.equal(env.q('#anHSave').hidden, true);
  // sem rascunho a tela acompanha as Preferências
  store.value = { criteria: 'Terceira versão.' };
  env.busHandlers.get('prefs:changed')({ keys: ['analysis.humor'] });
  assert.equal(env.q('#anHCriteria').value, 'Terceira versão.');
  // mudança em outras chaves não mexe no cartão
  store.value = { criteria: 'Quarta.' };
  env.busHandlers.get('prefs:changed')({ keys: ['analysis.minRelevance'] });
  assert.equal(env.q('#anHCriteria').value, 'Terceira versão.');
});

test('perfil de humor: o algoritmo recebe bordões e reações (sem acento no cache, em ordem), a IA recebe o perfil, e nada disso fica no projeto', async () => {
  const profile = { criteria: 'Humor seco.', catchphrases: ['Bora', 'Beco Moleque'], reactions: ['Eita'], examples: true };
  const store = newStore(profile);
  const env = load({ prefs: humorPrefs(store), api: transcriptApi(TRANSCRIPT) });
  await tick();
  env.q('#anRun').click();
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.equal(payload.engine, undefined, 'algoritmo');
  assert.deepEqual(plain(payload.params.humor), { phrases: ['beco moleque', 'bora'], reactions: ['eita'] });
  assert.equal(payload.profile, undefined, 'o algoritmo não leva o texto dos critérios');
  const kept = JSON.stringify(plain(env.project.ext));
  assert.ok(!/Beco|Humor seco|bora/i.test(kept), 'o projeto não guarda o perfil (ele fica nas Preferências)');
  assert.deepEqual(plain(env.project.ext.analysis.settings.textWeights).humor, 1, 'só o peso da pista fica nos ajustes do projeto');

  // IA: o perfil inteiro vai no pedido de análise e na estimativa
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const ai = load({ ext: { analysis: { settings: { engine: 'ai' } } }, prefs: humorPrefs(newStore(profile)), api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  const est = ai.calls.find(([c]) => c === 'analysis:aiEstimate');
  assert.deepEqual(plain(est[1].profile), { criteria: 'Humor seco.', catchphrases: ['Bora', 'Beco Moleque'], reactions: ['Eita'], themes: [], examples: true });
  ai.q('#anRun').click();
  await tick();
  await tick();
  const [, aiPayload] = ai.calls.find(([c]) => c === 'analysis:start');
  assert.equal(aiPayload.engine, 'ai');
  assert.deepEqual(plain(aiPayload.profile), { criteria: 'Humor seco.', catchphrases: ['Bora', 'Beco Moleque'], reactions: ['Eita'], themes: [], examples: true });
  assert.equal(aiPayload.params.humor, undefined, 'a IA recebe o perfil, não as listas do algoritmo');

  // sem perfil: nenhum dos dois leva nada
  const bare = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  bare.q('#anRun').click();
  await tick();
  await tick();
  assert.ok(!('profile' in bare.calls.find(([c]) => c === 'analysis:start')[1]));
  assert.ok(!('profile' in bare.calls.find(([c]) => c === 'analysis:aiEstimate')[1]));
});

test('perfil de humor: o aviso de privacidade conta que o perfil e os exemplos também vão; sem perfil não fala disso', async () => {
  const custom = aiState({ selected: 'custom', ready: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'https://a.exemplo/v1', host: 'a.exemplo', model: 'm', keyRequired: false, hasKey: true, keyStatus: 'ok', ready: true, reason: '', accepted: false, privacy: '' });
  const ask = async (prefs) => {
    const confirms = [];
    const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, prefs, api: aiApi(custom, transcriptApi(TRANSCRIPT)) });
    env.BF.ui.confirm = async (opts) => { confirms.push(opts); return false; };
    await tick();
    await tick();
    env.q('#anRun').click();
    await tick();
    return confirms[0].message;
  };
  const withProfile = await ask(humorPrefs(newStore({ criteria: 'Humor seco.' })));
  assert.match(withProfile, /O perfil de humor do canal também vai: os critérios e as listas que você escreveu e, se a opção de exemplos estiver ligada, trechos da fala de alguns cortes/);
  assert.match(withProfile, /Quem recebe: Personalizado/);
  assert.doesNotMatch(await ask({}), /perfil de humor/i);
});

test('perfil de humor: a caixa "Ver os exemplos" consulta o processo principal ao abrir e mostra exatamente o que a IA receberia', async () => {
  const examples = {
    approved: [{ projectId: 'a', cutId: 'a1', title: 'Susto no corredor', category: 'Engraçado', start: 10, end: 40, durationSec: 30, exported: true, text: 'eu abri a porta e tinha um bicho gigante parado ali' }],
    rejected: [{ projectId: 'b', cutId: 'b1', title: 'Papo de servidor', category: '', start: 60, end: 85, durationSec: 25, exported: false, text: 'depois eu vejo a configuração do servidor' }],
    projects: 2
  };
  const env = load({ prefs: humorPrefs(newStore({ criteria: 'Humor seco.' })), api: (channel) => (channel === 'analysis:humorExamples' ? { ok: true, examples } : undefined) });
  await tick();
  assert.equal(env.calls.filter(([c]) => c === 'analysis:humorExamples').length, 0, 'fechada, a caixa não consulta nada');
  assert.match(text(env.q('#anHExamplesHint')), /até 4 cortes aprovados e 3 rejeitados deste canal \(só o texto da fala, até 360 caracteres cada\)/);
  const box = env.q('#anHExamplesBox');
  box.open = true;
  box.dispatch('toggle');
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:humorExamples');
  assert.deepEqual(plain(payload), { projectId: 'p1' });
  assert.match(text(env.q('#anHExamplesNote')), /1 aprovado e 1 rejeitado, de 2 projetos do canal\. É exatamente isto que a IA recebe como exemplo\./);
  const items = env.q('#anHExamplesList').children;
  assert.equal(items.length, 2);
  assert.match(text(items[0]), /Susto no corredor.*aprovado.*30 s · Engraçado · exportado.*“eu abri a porta e tinha um bicho gigante parado ali”/);
  assert.match(text(items[1]), /Papo de servidor.*rejeitado.*25 s.*“depois eu vejo a configuração do servidor”/);
  // sem nada para mostrar, a caixa diz por quê
  const empty = load({ prefs: humorPrefs(newStore({ criteria: 'Humor seco.' })), api: (channel) => (channel === 'analysis:humorExamples' ? { ok: true, examples: { approved: [], rejected: [], projects: 0 } } : undefined) });
  await tick();
  empty.q('#anHExamplesBox').open = true;
  empty.q('#anHExamplesBox').dispatch('toggle');
  await tick();
  assert.match(text(empty.q('#anHExamplesNote')), /Ainda não há cortes aprovados ou rejeitados, com transcrição guardada, nos projetos deste canal/);
  assert.equal(empty.q('#anHExamplesList').children.length, 0);
});

test('perfil de humor: o resultado conta o que foi usado (algoritmo: expressões achadas; IA: o que foi enviado do perfil)', async () => {
  const algo = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { signals: { audio: { used: true, reason: '' }, text: { used: true, cues: 100, laughs: 1, humorHits: 7 } } }) } });
  await tick();
  assert.match(text(algo.q('#anSummary')), /sinais usados: áudio, texto · perfil do canal: 7 expressões achadas na fala/);
  const one = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { signals: { text: { used: true, cues: 100, laughs: 0, humorHits: 1 } } }) } });
  await tick();
  assert.match(text(one.q('#anSummary')), /perfil do canal: 1 expressão achada na fala/);
  const ai = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { engine: 'ai', ai: { provider: 'Groq', model: 'm', calls: 3, promptTokens: 20000, completionTokens: 2000, profile: { criteria: true, catchphrases: 2, reactions: 1, examples: { approved: 3, rejected: 1 } } } }) } });
  await tick();
  assert.match(text(ai.q('#anSummary')), /perfil do canal enviado: critérios · 2 bordões · 1 palavra de reação · 3 exemplos aprovados e 1 rejeitado/);
  // análise antiga (sem perfil) e execução sem perfil não mencionam o perfil
  const plainAi = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { engine: 'ai', ai: { provider: 'Groq', model: 'm', calls: 3 } }) } });
  await tick();
  assert.doesNotMatch(text(plainAi.q('#anSummary')), /perfil do canal/);
  assert.doesNotMatch(text(load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)]) } }).q('#anSummary')), /perfil do canal/);
});

test('perfil de humor: o resultado guardado no projeto (lastRun.params) fica SEM as listas do perfil; só o peso da pista e a contagem vão junto', async () => {
  const profile = { criteria: 'Humor seco.', catchphrases: ['Beco moleque'], reactions: ['Eita'], examples: true };
  const env = load({ prefs: humorPrefs(newStore(profile)), api: transcriptApi(TRANSCRIPT) });
  await tick();
  env.q('#anRun').click();
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.deepEqual(plain(payload.params.humor), { phrases: ['beco moleque'], reactions: ['eita'] });
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 2000, limit: 6, warnings: [], usedSignals: ['audio', 'text'],
    params: { ...payload.params, humor: payload.params.humor, textWeights: { laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1 } },
    signals: { audio: { used: true, reason: '' }, text: { used: true, cues: 100, laughs: 0, humorHits: 3 } },
    suggestions: [S(400, 430, { relevance: 0.6, reasons: ['expressão do canal: “beco moleque”'] })]
  } });
  const run = plain(env.project.analysis.lastRun);
  assert.equal(run.count, 1);
  assert.ok(!('humor' in run.params), 'o projeto não guarda os bordões nem as reações');
  assert.equal(run.params.textWeights.humor, 1);
  assert.ok(!/beco moleque|Eita/i.test(JSON.stringify(run.params)));
  assert.equal(env.project.ext.analysis.signals.text.humorHits, 3, 'a contagem de expressões achadas fica no resultado');
  assert.match(text(env.q('#anSummary')), /perfil do canal: 3 expressões achadas na fala/);
  assert.match(text(env.q('#anList')), /expressão do canal: “beco moleque”/);
});

test('perfil de humor: a aba monta antes de features/prefs.js (BF.prefs ainda é o esboço de app.js, sem scope/set/unset) e o cartão aparece só com "Todos os vídeos"', async () => {
  const env = load({ prefs: { scope: undefined, set: undefined, unset: undefined, explain: () => null } });
  await tick();
  assert.equal(text(env.q('#anHChip')), 'Não definido');
  assert.deepEqual(plain(Array.from(env.q('#anHScope').children, (o) => [o.value, Boolean(o.disabled)])), [['channel', true], ['game', true], ['general', false]]);
  assert.equal(env.q('#anHScope').value, 'general');
  // depois que as Preferências carregam e o canal aparece, o cartão passa a oferecer o canal ao próximo redesenho
  env.BF.prefs.scope = () => ({ game: '', channel: 'Braga' });
  env.busHandlers.get('prefs:changed')({ keys: ['analysis.humor'] });
  assert.deepEqual(plain(Array.from(env.q('#anHScope').children, (o) => [o.value, Boolean(o.disabled)])), [['channel', false], ['game', true], ['general', false]]);
  assert.equal(env.q('#anHScope').value, 'channel');
});

// ---------- temas do canal e palavras-chave por sugestão ----------

test('temas do canal: o campo existe, entra limpo no perfil salvo e no resumo, e só a IA os recebe (o algoritmo não muda)', async () => {
  const store = newStore();
  const env = load({ prefs: humorPrefs(store, { names: { game: '', channel: 'Braga' } }) });
  await tick();
  assert.equal(env.q('#anHThemes').value, '', 'sem perfil o campo está vazio');
  assert.match(text(env.q('#anHConfig')), /Temas do canal/);
  assert.match(text(env.q('#anHConfig')), /Só a IA usa/, 'a tela diz que o algoritmo não usa os temas');
  const type = (id, value) => { const node = env.q(id); node.value = value; node.dispatch('input'); };
  type('#anHThemes', 'Piadas, piadas; Cenas de história');
  assert.equal(env.q('#anHSave').hidden, false, 'só os temas já são algo a salvar');
  assert.equal(env.q('#anHSave').disabled, false, 'e um perfil só com temas não é vazio');
  env.q('#anHSave').click();
  await tick();
  assert.deepEqual(plain(store.sets[0][1].themes), ['Piadas', 'Cenas de história']);
  assert.equal(env.q('#anHThemes').value, 'Piadas, Cenas de história', 'a tela mostra o que ficou guardado (limpo)');
  assert.match(text(env.q('#anHLine')), /2 temas/);
  // o algoritmo não recebe os temas
  env.q('#anRun').click();
  await tick();
  const start = env.calls.find(([channel]) => channel === 'analysis:start');
  assert.ok(start, 'a análise foi pedida');
  assert.deepEqual(plain(start[1].params.humor), { phrases: [], reactions: [] }, 'o parâmetro do algoritmo não leva temas');
});

test('sugestão da IA com tema e palavras-chave: chips no cartão e, ao Adicionar, o tema e as palavras vão para o corte', () => {
  const suggestion = S(100, 130, { title: 'Susto no corredor', category: 'Hype', theme: 'Piadas', keywords: ['susto', 'corredor', 'bicho gigante'] });
  const plain1 = S(200, 230, { title: 'Sem etiquetas' });
  const env = load({ ext: { analysis: savedAnalysis(SOURCE, [suggestion, plain1], { engine: 'ai' }) } });
  const first = rows(env)[0];
  assert.equal(text(first.querySelector('.an-theme')), 'Tema: Piadas');
  assert.deepEqual(plain(first.querySelectorAll('.an-keyword').map((n) => text(n))), ['#susto', '#corredor', '#bicho gigante']);
  assert.equal(first.querySelector('.an-keywords').attrs['aria-label'], 'Palavras-chave');
  const second = rows(env)[1];
  assert.equal(second.querySelector('.an-theme'), null, 'sem tema não há chip');
  assert.equal(second.querySelector('.an-keywords'), null, 'sem palavras-chave não há lista');
  first.querySelector('.an-add').click();
  const cut = env.project.cuts.find((c) => c.start === 100);
  assert.ok(cut, 'o corte foi criado');
  assert.equal(cut.theme, 'Piadas');
  assert.deepEqual(plain(cut.keywords), ['susto', 'corredor', 'bicho gigante']);
  assert.equal(cut.status, 'pending', 'nunca aprovado sozinho');
  assert.equal(cut.origin, 'auto');
});

test('Algoritmo + IA: escolhido sozinho com a IA pronta; mostra os ajustes dos dois; o pedido leva o do algoritmo e o da IA; resumo e chips dizem quem achou', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ cuts: [{ id: 'k1', start: 40, end: 60, status: 'pending', origin: 'manual' }], api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.BF.analysis.engineChoice(), 'both', 'IA pronta e aceita: os dois juntos');
  assert.match(text(env.q('#anEngineHint')), /junta as listas.*\(escolhido automaticamente\)/);
  assert.equal(env.q('#anSignals').hidden, false, 'os sinais do algoritmo continuam na tela');
  assert.equal(env.q('#anAi').hidden, false, 'e o provedor da IA também');
  assert.match(text(env.q('#anIntro')), /Roda o algoritmo .* e depois a IA/);
  env.q('#anRun').click();
  await tick();
  await tick();
  const [, payload] = env.calls.find(([c]) => c === 'analysis:start');
  assert.equal(payload.engine, 'both');
  assert.equal(payload.params.signals.audio, true, 'os parâmetros do algoritmo');
  assert.ok(payload.params.humor, 'com as listas do perfil para o algoritmo');
  assert.equal(payload.projectId, 'p1');
  assert.equal(payload.meta.title.length > 0, true, 'os metadados da IA');
  assert.deepEqual(plain(payload.existingCuts), [{ start: 40, end: 60 }]);
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 65000, limit: 24, warnings: [], usedSignals: ['audio', 'text', 'ai'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, merge: { both: 1, ai: 1, algorithm: 1 }, ai: { provider: 'Personalizado', model: 'm', calls: 3, promptTokens: 9000, completionTokens: 1000, dropped: [], droppedTotal: 0 },
    suggestions: [
      { ...S(100, 130), engines: ['algorithm', 'ai'], title: 'O bicho', category: 'Humor' },
      { ...S(200, 230), engines: ['ai'], title: 'Outro' },
      { ...S(300, 330), engines: ['algorithm'] }
    ]
  } });
  assert.match(text(env.q('#anSummary')), /3 sugestão\(ões\) encontrada\(s\): 1 que os dois acharam, 1 só da IA, 1 só do algoritmo/);
  assert.match(text(env.q('#anSummary')), /IA: Personalizado · m · 3 chamadas, ~10 mil tokens/);
  const saved = env.project.ext.analysis;
  assert.equal(saved.engine, 'both');
  assert.deepEqual(plain(saved.merge), { both: 1, ai: 1, algorithm: 1 });
  assert.deepEqual(plain(saved.suggestions.map((s) => s.engines)), [['algorithm', 'ai'], ['ai'], ['algorithm']]);
  const chips = env.all('.an-engine-chip').map(text);
  assert.deepEqual(chips, ['Algoritmo + IA', 'IA', 'Algoritmo']);
});

test('Algoritmo + IA: sem transcrição não começa (a IA precisa dela) e a tela diz o porquê', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ ext: { analysis: { settings: { engine: 'both' } } }, api: aiApi(ready, transcriptApi({ exists: false })) });
  await tick();
  await tick();
  assert.equal(env.BF.analysis.engineChoice(), 'both');
  assert.equal(env.q('#anRun').disabled, true);
  assert.match(text(env.q('#anAiWarn')), /A IA precisa da transcrição/);
  env.q('#anEngine-algorithm').click();
  await tick();
  assert.equal(env.q('#anRun').disabled, false, 'só o algoritmo roda sem transcrição');
});

test('Guia de cortes: só é pedido ao abrir; editar libera Salvar; salvar e restaurar falam com o processo principal; o resumo diz quando valeu o seu guia', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const DEFAULT_TEXT = '---\nname: selecionar-cortes\n---\n\n# Guia de seleção de cortes\n\ntexto padrão';
  let skill = { source: 'default', text: DEFAULT_TEXT, chars: 40, tokens: 13, defaultText: DEFAULT_TEXT, minChars: 200, maxChars: 12000 };
  const env = load({ ext: { analysis: { settings: { engine: 'ai' } } }, api: aiApi(ready, (channel, payload) => {
    if (channel === 'analysis:aiSkill') return { ok: true, skill };
    if (channel === 'analysis:aiSkillSave') { skill = { ...skill, source: 'custom', text: payload.text }; return { ok: true, skill }; }
    if (channel === 'analysis:aiSkillReset') { skill = { ...skill, source: 'default', text: DEFAULT_TEXT }; return { ok: true, skill }; }
    return transcriptApi(TRANSCRIPT)(channel);
  }) });
  await tick();
  await tick();
  assert.equal(env.calls.filter(([c]) => c === 'analysis:aiSkill').length, 0, 'nada é pedido antes de abrir a caixa');
  assert.equal(env.q('#anSkillText').disabled, true);
  const box = env.q('#anSkillBox');
  box.open = true;
  box.dispatch('toggle');
  await tick();
  await tick();
  const area = env.q('#anSkillText');
  assert.equal(area.value, DEFAULT_TEXT);
  assert.equal(area.disabled, false);
  assert.equal(text(env.q('#anSkillChip')), 'Padrão');
  assert.match(text(env.q('#anSkillInfo')), /Guia padrão do app · \d+ caracteres/);
  assert.equal(env.q('#anSkillSave').disabled, true, 'sem mudança não há o que salvar');
  assert.equal(env.q('#anSkillReset').disabled, true, 'e o padrão já está valendo');
  area.value = 'meu guia: só história com final engraçado';
  area.dispatch('input');
  assert.equal(env.q('#anSkillSave').disabled, false);
  assert.match(text(env.q('#anSkillInfo')), /alterado, ainda não salvo/);
  env.q('#anSkillSave').click();
  await tick();
  await tick();
  assert.deepEqual(plain(env.calls.find(([c]) => c === 'analysis:aiSkillSave')[1]), { text: 'meu guia: só história com final engraçado' });
  assert.equal(text(env.q('#anSkillChip')), 'Personalizado');
  assert.match(text(env.q('#anSkillOut')), /Guia salvo/);
  assert.equal(env.q('#anSkillReset').disabled, false);
  env.q('#anSkillReset').click();
  await tick();
  await tick();
  await tick();
  assert.equal(env.calls.filter(([c]) => c === 'analysis:aiSkillReset').length, 1);
  assert.equal(text(env.q('#anSkillChip')), 'Padrão');
  assert.equal(env.q('#anSkillText').value, DEFAULT_TEXT);
  // o resumo da análise diz quando o guia usado foi o do usuário
  env.q('#anRun').click();
  await tick();
  await tick();
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', engine: 'ai', fromCache: false, tookMs: 30000, limit: 12, warnings: [], usedSignals: ['ai'], params: {}, signals: {},
    ai: { provider: 'Personalizado', model: 'm', calls: 2, promptTokens: 5000, completionTokens: 500, dropped: [], droppedTotal: 0, skill: { custom: true } },
    suggestions: [S(100, 130)]
  } });
  assert.match(text(env.q('#anSummary')), /com o seu guia de cortes/);
  assert.deepEqual(plain(env.project.ext.analysis.ai.skill), { custom: true });
});

test('tempo restante pela etapa: usa o ritmo da etapa em andamento (a mais lenta, se houver duas), ignora a terminada e espera ter base', () => {
  const { BF } = load();
  const { stageRemainingSec } = BF.analysis;
  const now = 1_700_000_000_000;
  const min = 60000;
  assert.equal(stageRemainingSec(null, now), null);
  assert.equal(stageRemainingSec({}, now), null);
  // imagem: começou há 4 min em 0% e está em 20% -> faltam 16 min (a conta pela barra dizia outra coisa a cada minuto)
  assert.equal(Math.round(stageRemainingSec({ image: { startedAt: now - 4 * min, p0: 0, p: 0.2 } }, now)), 16 * 60);
  // vista pela primeira vez já em 40% (janela recarregada): vale o que andou desde então
  assert.equal(Math.round(stageRemainingSec({ image: { startedAt: now - 2 * min, p0: 0.4, p: 0.5 } }, now)), 10 * 60);
  // áudio terminado não conta; com duas em andamento vale a que demora mais
  assert.equal(Math.round(stageRemainingSec({ audio: { startedAt: now - 5 * min, p0: 0, p: 1 }, image: { startedAt: now - 4 * min, p0: 0, p: 0.2 } }, now)), 16 * 60);
  assert.equal(Math.round(stageRemainingSec({ audio: { startedAt: now - min, p0: 0, p: 0.5 }, image: { startedAt: now - min, p0: 0, p: 0.1 } }, now)), 9 * 60);
  // cedo demais: menos de 5 s ou de 2% andados
  assert.equal(stageRemainingSec({ image: { startedAt: now - 3000, p0: 0, p: 0.3 } }, now), null);
  assert.equal(stageRemainingSec({ image: { startedAt: now - min, p0: 0, p: 0.01 } }, now), null);
  assert.equal(stageRemainingSec({ audio: { startedAt: now - min, p0: 0, p: 0.5 }, image: { startedAt: now - 2000, p0: 0, p: 0 } }, now), null, 'uma etapa ativa sem base ainda: não chuta');
});

test('tempo restante na tela: com a etapa informada (stageP) não usa mais a barra inteira nem chuta antes de ter base', async () => {
  const env = load();
  env.q('#anRun').click();
  await tick();
  const send = (ev) => env.mainHandlers.get('analysis:progress')({ jobId: 'a1', ...ev });
  // sem stageP (versão antiga do processo principal): a conta pela barra, como antes
  send({ p: 0.5, stage: 'image', message: 'Analisando a imagem…' });
  assert.match(text(env.q('#anProgressText')), /Analisando a imagem… 50%/);
  assert.ok(!/nesta etapa/.test(text(env.q('#anProgressText'))));
  // com stageP: a etapa acabou de começar, então ainda não há base (e a barra em 60% não vira estimativa)
  send({ p: 0.6, stage: 'image', stageP: 0.1, message: 'Analisando a imagem…', phase: 'algorithm' });
  assert.equal(text(env.q('#anProgressText')), 'Analisando a imagem… 60%', 'sem chute enquanto a etapa não tem 5 s');
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: { at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 1000, limit: 6, warnings: [], usedSignals: ['audio'], params: {}, signals: savedAnalysis(SOURCE, []).signals, suggestions: [] } });
  assert.equal(text(env.q('#anRun')), 'Analisar', 'a análise terminou');
});


test('contagem dos candidatos da IA: o resumo diz quantos ela propôs e com quantos a escolha final ficou; o que ficou de fora aparece recolhido e é guardado no projeto', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  env.q('#anRun').click();
  await tick();
  await tick();
  const funnel = { returned: 40, verified: 36, unique: 36, offered: 36, picked: 17, final: 17, perBlock: [{ from: 0, to: 2100, returned: 22, verified: 20 }, { from: 2010, to: 4110, returned: 18, verified: 16 }] };
  const unpicked = [{ start: 500, end: 540, title: 'Ficou de fora', relevance: 0.7 }, { start: 900, end: 930, title: '', relevance: 0.55 }];
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 65000, limit: 24, warnings: [], usedSignals: ['audio', 'text', 'ai'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, merge: { both: 1, ai: 0, algorithm: 0 },
    ai: { provider: 'Personalizado', model: 'm', calls: 9, promptTokens: 9000, completionTokens: 1000, dropped: [], droppedTotal: 4, funnel: { ...funnel, extra: 'não vai para o projeto' }, unpicked: unpicked.map((u) => ({ ...u, punchline: 'não vai para o projeto' })) },
    suggestions: [{ ...S(100, 130), engines: ['algorithm', 'ai'], title: 'O bicho', category: 'Humor' }]
  } });
  assert.match(text(env.q('#anSummary')), /a IA propôs 40 candidatos, 36 passaram na conferência, a escolha final ficou com 17 de 36/);
  const box = env.q('#anAiUnpicked');
  assert.equal(box.hidden, false);
  assert.equal(box.open, false, 'recolhida');
  assert.equal(text(box.children[0]), 'Fora da escolha final da IA (19)', 'o total vem da contagem, não só dos que estão listados');
  assert.match(text(box), /Ficou de fora · relevância 70%/);
  assert.match(text(box), /sem título · relevância 55%/);
  const saved = env.project.ext.analysis.ai;
  assert.deepEqual(plain(saved.funnel), funnel, 'só as contagens conhecidas');
  assert.deepEqual(plain(saved.unpicked), unpicked, 'só horários, título e nota');

  // análise antiga (sem a contagem) e análise em que a escolha final não cortou nada: nada a dizer
  const old = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { engine: 'ai', ai: { provider: 'Groq', model: 'm', calls: 3 } }) } });
  await tick();
  assert.doesNotMatch(text(old.q('#anSummary')), /propôs/);
  assert.equal(old.q('#anAiUnpicked').hidden, true);
  const all = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { engine: 'ai', ai: { provider: 'Groq', model: 'm', calls: 3, funnel: { returned: 1, verified: 1, unique: 1, offered: 1, picked: null, final: 1, perBlock: [] } } }) } });
  await tick();
  assert.match(text(all.q('#anSummary')), /a IA propôs 1 candidato ·/);
  assert.equal(all.q('#anAiUnpicked').hidden, true);
});

test('rede local: o aviso de que a chave vai sem criptografia aparece junto do endereço, só no Personalizado com http:// da rede', async () => {
  const custom = (over) => aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://192.168.0.10:20128/v1', host: '192.168.0.10:20128', model: 'm', keyRequired: false, hasKey: true, ready: true, reason: '', accepted: true, privacy: '', ...over });
  const lan = load({ api: aiApi(custom({ localNetwork: true }), transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(lan.q('#anCfgLanNote').hidden, false);
  assert.match(text(lan.q('#anCfgLanNote')), /sem criptografia/);
  const tls = load({ api: aiApi(custom({ baseUrl: 'https://gateway.exemplo/v1', host: 'gateway.exemplo', localNetwork: false }), transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(tls.q('#anCfgLanNote').hidden, true);
});

test('Só os melhores: lista curta com quantidade fixa de 4 por hora; é o oposto da quantidade automática, trava o "por hora" e vai no pedido sem mudar o ajuste guardado', async () => {
  const env = load();
  const best = env.q('#anBestOnly');
  const auto = env.q('#anAutoQty');
  assert.equal(best.checked, false, 'desligado por padrão');
  env.q('#anPerHour').value = '9';
  env.q('#anPerHour').dispatch('change');
  assert.equal(env.project.ext.analysis.settings.perHour, 9);

  // ligar "Só os melhores" desliga a automática, trava o controle por hora e diz quantas sugestões cabem
  auto.checked = true;
  auto.dispatch('change');
  assert.equal(env.project.ext.analysis.settings.autoQuantity, true);
  best.checked = true;
  best.dispatch('change');
  assert.equal(env.q('#anAutoQty').checked, false, 'ligar um desliga o outro');
  assert.deepEqual([env.project.ext.analysis.settings.bestOnly, env.project.ext.analysis.settings.autoQuantity], [true, false], 'fica no projeto');
  assert.equal(env.project.ext.analysis.settings.perHour, 9, 'o valor do controle por hora continua guardado');
  assert.equal(env.q('#anPerHour').disabled, true);
  assert.match(text(env.all('.an-out')[1]), /só os melhores: 4 por hora/);

  // o pedido leva a quantidade fixa de 4 por hora, sem a automática
  env.q('#anRun').click();
  await tick();
  const start = env.calls.find(([channel]) => channel === 'analysis:start');
  assert.equal(start[1].params.perHour, 4);
  assert.equal(start[1].params.autoQuantity, false);
  assert.equal(env.project.ext.analysis.settings.perHour, 9, 'analisar não troca o ajuste do usuário');
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: { at: '2026-02-02T00:00:00.000Z', fromCache: false, tookMs: 1000, limit: 8, warnings: [], usedSignals: ['audio'], params: {}, signals: savedAnalysis(SOURCE, []).signals, suggestions: [S(100, 130)] } });

  // ligar a automática de volta desliga "Só os melhores" e o controle por hora volta a valer quando os dois estão desligados
  const auto2 = env.q('#anAutoQty');
  auto2.checked = true;
  auto2.dispatch('change');
  assert.equal(env.q('#anBestOnly').checked, false);
  assert.equal(env.project.ext.analysis.settings.bestOnly, false);
  auto2.checked = false;
  auto2.dispatch('change');
  assert.equal(env.q('#anPerHour').disabled, false);
  assert.match(text(env.all('.an-out')[1]), /9 por hora/);

  // projeto que já vinha com a opção ligada abre com ela ligada (e, se a automática também vier marcada, vale a mais exigente)
  const saved = load({ ext: { analysis: { settings: { bestOnly: true, autoQuantity: true, perHour: 12 } } } });
  assert.equal(saved.q('#anBestOnly').checked, true);
  assert.equal(saved.q('#anAutoQty').checked, false);
  assert.equal(saved.q('#anPerHour').disabled, true);
});

test('IA confere o algoritmo: ligado por padrão só no modo Algoritmo + IA, vai no pedido, e a tela mostra o que a IA tirou e o que aprovou', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.BF.analysis.engineChoice(), 'both');
  assert.equal(env.q('#anAiReview').checked, true, 'ligado por padrão');
  assert.equal(env.q('.an-ai-review').hidden, false, 'aparece no modo Algoritmo + IA');
  env.q('#anRun').click();
  await tick();
  await tick();
  assert.equal(env.calls.find(([c]) => c === 'analysis:start')[1].review, true);
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 65000, limit: 24, warnings: [], usedSignals: ['audio', 'text', 'ai'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, merge: { both: 1, ai: 0, algorithm: 1 },
    ai: { provider: 'Personalizado', model: 'm', calls: 4, promptTokens: 9000, completionTokens: 1000, dropped: [], droppedTotal: 0 },
    review: { sent: 3, kept: 1, dropped: 2, unanswered: 0, droppedList: [{ start: 300, end: 330, relevance: 0.92, why: 'conversa técnica, sem desfecho', extra: 'não vai para o projeto' }, { start: 700, end: 730, relevance: 0.6, why: '' }] },
    suggestions: [
      { ...S(100, 130), engines: ['algorithm', 'ai'], title: 'Os dois' },
      { ...S(500, 530), engines: ['algorithm'], review: 'ai', title: 'Aprovado pela IA' }
    ]
  } });
  assert.match(text(env.q('#anSummary')), /a IA conferiu 3 sugestões do algoritmo e tirou 2/);
  assert.deepEqual(env.all('.an-engine-chip').map(text), ['Algoritmo + IA', 'Algoritmo · IA conferiu']);
  const box = env.q('#anAiReviewDrops');
  assert.equal(box.hidden, false);
  assert.equal(text(box.children[0]), 'Sugestões do algoritmo que a IA tirou (2)');
  assert.match(text(box), /conversa técnica, sem desfecho · nota do algoritmo 92%/);
  assert.match(text(box), /sem motivo informado · nota do algoritmo 60%/);
  const saved = env.project.ext.analysis;
  assert.deepEqual(plain(saved.review), { sent: 3, kept: 1, dropped: 2, unanswered: 0, adjusted: 0, list: [{ start: 300, end: 330, relevance: 0.92, why: 'conversa técnica, sem desfecho' }, { start: 700, end: 730, relevance: 0.6, why: '' }] });
  assert.equal(saved.suggestions[1].review, 'ai');

  // desligar fica no projeto e vai no pedido; em motor que não junta os dois o interruptor some
  env.q('#anAiReview').checked = false;
  env.q('#anAiReview').dispatch('change');
  assert.equal(env.project.ext.analysis.settings.aiReview, false);
  env.q('#anEngine-algorithm').click();
  await tick();
  assert.equal(env.q('.an-ai-review').hidden, true);
  // análise sem conferência: nem frase no resumo, nem caixa
  const old = load({ ext: { analysis: savedAnalysis(SOURCE, [S(100, 130)], { engine: 'both', merge: { both: 0, ai: 0, algorithm: 1 }, ai: { provider: 'Groq', model: 'm', calls: 3 } }) } });
  await tick();
  assert.doesNotMatch(text(old.q('#anSummary')), /conferiu/);
  assert.equal(old.q('#anAiReviewDrops').hidden, true);
});

test('Enviar só os trechos candidatos: desligado por padrão, aparece com IA, vai no pedido (IA e Algoritmo + IA) e fica no projeto', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.q('#anAiWindows').checked, false, 'desligado por padrão');
  assert.equal(env.q('.an-ai-windows').hidden, false, 'aparece nos modos com IA');
  env.q('#anRun').click();
  await tick();
  await tick();
  assert.equal(env.calls.find(([c]) => c === 'analysis:start')[1].aiWindows, undefined, 'desligado: o pedido não leva o campo');
  env.q('#anAiWindows').checked = true;
  env.q('#anAiWindows').dispatch('change');
  assert.equal(env.project.ext.analysis.settings.aiWindows, true);
  env.q('#anEngine-ai').click();
  await tick();
  assert.equal(env.q('.an-ai-windows').hidden, false);
  const estimates = env.calls.filter(([c]) => c === 'analysis:aiEstimate');
  assert.equal(estimates[estimates.length - 1][1].aiWindows, true, 'a estimativa também considera o modo');
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: { at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 1, limit: 24, warnings: [], usedSignals: [], params: {}, signals: savedAnalysis(SOURCE, []).signals, ai: { calls: 1 }, suggestions: [] } });
  env.q('#anRun').click();
  await tick();
  await tick();
  const starts = env.calls.filter(([c]) => c === 'analysis:start');
  assert.equal(starts[starts.length - 1][1].aiWindows, true);
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: { at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 1, limit: 24, warnings: [], usedSignals: [], params: {}, signals: savedAnalysis(SOURCE, []).signals, ai: { calls: 1 }, suggestions: [] } });
  env.q('#anEngine-algorithm').click();
  await tick();
  assert.equal(env.q('.an-ai-windows').hidden, true, 'sem IA o interruptor some');
});

test('IA confere o algoritmo com bordas: o resumo diz quantas a IA ajustou, o selo muda e o projeto guarda as bordas do algoritmo', async () => {
  const ready = aiState({ selected: 'custom', ready: true, accepted: true }, { id: 'custom', label: 'Personalizado', baseUrl: 'http://127.0.0.1:9/v1', host: '127.0.0.1:9', model: 'm', keyRequired: false, ready: true, reason: '', accepted: true, privacy: '' });
  const env = load({ api: aiApi(ready, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  env.q('#anRun').click();
  await tick();
  await tick();
  env.mainHandlers.get('analysis:done')({ jobId: 'a1', result: {
    at: '2026-02-02T00:00:00.000Z', engine: 'both', fromCache: false, tookMs: 65000, limit: 24, warnings: [], usedSignals: ['audio', 'text', 'ai'], params: {},
    signals: savedAnalysis(SOURCE, []).signals, merge: { both: 0, ai: 0, algorithm: 2 },
    ai: { provider: 'Personalizado', model: 'm', calls: 4, promptTokens: 9000, completionTokens: 1000, dropped: [], droppedTotal: 0 },
    review: { sent: 2, kept: 2, dropped: 0, unanswered: 0, adjusted: 1, droppedList: [] },
    suggestions: [
      { ...S(275, 334), engines: ['algorithm'], review: 'ai', reviewFrom: { start: 300, end: 330 }, title: 'Ajustado pela IA' },
      { ...S(500, 530), engines: ['algorithm'], review: 'ai', title: 'Aprovado pela IA' }
    ]
  } });
  assert.match(text(env.q('#anSummary')), /a IA conferiu 2 sugestões do algoritmo, tirou 0 e ajustou o início ou o fim de 1/);
  const chips = env.all('.an-engine-chip');
  assert.deepEqual(chips.map(text), ['Algoritmo · IA ajustou', 'Algoritmo · IA conferiu']);
  assert.match(chips[0].attrs.title ?? chips[0].title, /o algoritmo tinha marcado 5:00 a 5:30/);
  const saved = env.project.ext.analysis;
  assert.deepEqual(plain(saved.suggestions[0].reviewFrom), { start: 300, end: 330 });
  assert.deepEqual([saved.suggestions[0].start, saved.suggestions[0].end], [275, 334]);
  assert.equal(saved.suggestions[1].reviewFrom, undefined);
  assert.equal(saved.review.adjusted, 1);
});

test('IA: provedores de reserva — as três escolhas, o que falta em cada um, o aviso de privacidade de cada um e o aviso de blocos menores', async () => {
  const provider = { id: 'custom', label: 'Personalizado', baseUrl: 'https://a.exemplo/v1', host: 'a.exemplo', model: 'm', keyRequired: false, hasKey: true, keyStatus: 'ok', ready: true, reason: '', accepted: true, privacy: '', tokensPerMinute: null };
  const groq = { id: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile', host: 'api.groq.com', ready: true, accepted: false, reason: '', privacy: 'Confira os termos da Groq.', tokensPerMinute: 8000, usable: true, note: '' };
  const gemini = { id: 'gemini', label: 'Google Gemini', model: '', host: 'generativelanguage.googleapis.com', ready: false, accepted: false, reason: 'Informe o modelo.', privacy: '', tokensPerMinute: null, usable: true, note: '' };
  const options = [{ id: 'gemini', label: 'Google Gemini' }, { id: 'groq', label: 'Groq' }, { id: 'openrouter', label: 'OpenRouter' }];
  let current;
  const make = (fallbackProviders, limited) => aiState({
    selected: 'custom', ready: true, accepted: true,
    effectiveLimits: limited ? { maxCalls: 14, maxInputTokens: 5700, maxOutputTokens: 2000, windowMinutes: 35, attempts: 3, limitedBy: { id: 'groq', label: 'Groq', tokensPerMinute: 8000 } } : { maxCalls: 14, maxInputTokens: 24000, windowMinutes: 35, attempts: 3 },
    fallback: { ids: fallbackProviders.map((p) => p.id), max: 3, options, providers: fallbackProviders }
  }, provider);
  current = make([groq, gemini], true);
  const env = load({ api: aiApi((channel, payload) => {
    if (channel === 'analysis:aiAccept' && payload.provider === 'groq') current = make([{ ...groq, accepted: true }, gemini], true);
    if (channel === 'analysis:aiSave' && payload.fallback) current = make(payload.fallback.map((id) => ({ groq, gemini }[id])), false);
    return current;
  }, transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(env.q('#anFallbackBox').hidden, false);
  const selects = [1, 2, 3].map((n) => env.q(`#anFallback${n}`));
  assert.deepEqual(plain(selects[0].children.map((o) => text(o))), ['Nenhum', 'Google Gemini', 'Groq', 'OpenRouter'], 'o provedor escolhido não é opção de reserva');
  assert.deepEqual(selects.map((s) => s.value), ['groq', 'gemini', '']);
  // o que falta em cada reserva
  const items = env.all('.an-fb-item');
  assert.equal(items.length, 2);
  assert.match(text(items[0]), /Aviso pendente.*Groq · llama-3\.3-70b-versatile · 8\.000 tokens por minuto/);
  assert.match(text(items[0]), /Aceitar aviso/);
  assert.match(text(items[1]), /Falta configurar.*Google Gemini.*limite por minuto ainda não conhecido.*Informe o modelo\./);
  assert.doesNotMatch(text(items[1]), /Aceitar aviso/, 'sem configurar não há o que aceitar');
  // blocos menores: o aviso diz qual provedor limita e o que fazer
  assert.equal(env.q('#anFallbackNote').hidden, false);
  assert.match(text(env.q('#anFallbackNote')), /limite de 8\.000 tokens por minuto de Groq faz a análise usar até ~5\.700 tokens por chamada \(o seu limite é 24\.000\)/);
  assert.doesNotMatch(text(env.q('#anProvider')), /reserva:/, 'nenhuma reserva está pronta e aceita ainda');
  // o aviso de privacidade da reserva é pedido com os dados DELA e vai com o id dela
  const confirms = [];
  env.BF.ui.confirm = async (opts) => { confirms.push(opts); return true; };
  items[0].querySelector('.an-fb-accept').click();
  await tick();
  await tick();
  assert.match(confirms[0].message, /Quem recebe: Groq \(api\.groq\.com\)/);
  assert.match(confirms[0].message, /Confira os termos da Groq\./);
  assert.deepEqual(plain(env.calls.find(([c]) => c === 'analysis:aiAccept')[1]), { accepted: true, provider: 'groq' });
  assert.doesNotMatch(text(env.all('.an-fb-item')[0]), /Aviso pendente/);
  assert.match(text(env.q('#anProvider')), /Personalizado · m · reserva: Groq/, 'a linha do provedor lembra as reservas prontas e aceitas');
  // trocar as reservas grava a lista na ordem dos campos, sem repetir
  selects[0].value = 'gemini';
  selects[1].value = 'groq';
  selects[2].value = 'groq';
  selects[0].dispatch('change');
  await tick();
  assert.deepEqual(plain(env.calls.filter(([c]) => c === 'analysis:aiSave').pop()[1]), { fallback: ['gemini', 'groq'] });
  assert.equal(env.q('#anFallbackNote').hidden, true, 'sem a Groq limitando, o aviso some');
  // sem o campo no estado (outro modo) a seção nem aparece
  const old = load({ api: aiApi(aiState({ selected: 'custom', ready: true, accepted: true }, provider), transcriptApi(TRANSCRIPT)) });
  await tick();
  await tick();
  assert.equal(old.q('#anFallbackBox').hidden, true);
});
