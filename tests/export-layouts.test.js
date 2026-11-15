'use strict';

/**
 * Layouts do canal (Conversa | Jogo): precedência e origem do enquadramento, presets, Jobs, chave da fila, QC da câmera e a
 * exportação de verdade (ffmpeg real, amostragem de pixels). A fonte única da regra é src/core/export/layouts.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../src/core/export/layouts');
const F = require('../src/core/export/framing');
const { buildJobs } = require('../src/core/export/jobs');
const { preflight } = require('../src/core/export/qc');
const { runExportJob } = require('../src/core/export/jobRunner');
const { listBuiltinProfiles } = require('../src/core/export/profiles');
const { jobKey } = require('../src/core/queue/jobKey');
const encoders = require('../src/core/export/encoders');
const qh = require('./queue-helpers');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;
const VERTICAL = listBuiltinProfiles().find((p) => p.id === 'vertical-1080-h264');
const ALL_ENCODERS = new Set(['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc']);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: obtido ${actual.toFixed(1)}, esperado ${expected.toFixed(1)} (±${tol})`);

/** Congela em profundidade: qualquer escrita nas entradas do resolvedor lançaria erro (modo estrito). */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
const clone = (v) => JSON.parse(JSON.stringify(v));

const presets = () => L.composePresets({});
const resolve = (cut, extra = {}) => L.resolveCutFraming({ cut, profile: VERTICAL, projectFraming: {}, presets: presets(), ...extra });

// ---------- presets ----------

test('presets de fábrica: medidos na live de teste (Conversa centrada no rosto; Jogo com a câmera inteira no canto superior esquerdo)', () => {
  const d = L.defaultPresets();
  assert.deepEqual(Object.keys(d), ['conversa', 'jogo']);
  assert.equal(d.conversa.framing.mode, 'center');
  assert.equal(d.conversa.framing.focusX, 0.63, 'rosto em ~58% da largura: janela 9:16 de 43% a 75%, sem chat nem QR code');
  assert.equal(d.conversa.framing.zoom, 1);
  assert.equal(d.jogo.framing.mode, 'stack');
  assert.equal(d.jogo.framing.stack.webcamPosition, 'top');
  assert.deepEqual(d.jogo.framing.stack.webcamRect, { x: 0, y: 0, w: 0.3047, h: 0.3028 }, 'a caixa da câmera (783x440 de 2560x1440) com 3 px de folga');
  assert.equal(d.jogo.framing.stack.webcamHeightPct, 31, 'a faixa tem quase a proporção 16:9 da câmera');
  assert.ok(d.jogo.framing.stack.gameRect.x >= 0.3047, 'o jogo começa depois da câmera: ela não aparece de novo na faixa de baixo');
  assert.deepEqual(d.jogo.ref, { w: 2560, h: 1440 });
  const composed = presets();
  for (const layout of L.LAYOUTS) {
    assert.equal(composed[layout].from, 'app');
    assert.equal(composed[layout].own, false);
    assert.deepEqual(composed[layout].framing, F.normalizeFraming(d[layout].framing, { partial: true }));
  }
});

test('composePresets: fábrica < herdado das preferências < deste projeto (campo a campo), com a origem de cada um', () => {
  const inherited = { conversa: { framing: { focusX: 0.5, zoom: 1.4 }, ref: { w: 1920, h: 1080 } } };
  const project = { conversa: { framing: { zoom: 1.2 } } };
  const onlyInherited = L.composePresets({ inherited, scopes: { conversa: 'canal Braga' } });
  assert.deepEqual(onlyInherited.conversa.framing, { mode: 'center', focusX: 0.5, focusY: 0.5, zoom: 1.4 });
  assert.equal(onlyInherited.conversa.from, 'canal Braga');
  assert.deepEqual(onlyInherited.conversa.ref, { w: 1920, h: 1080 });
  assert.equal(onlyInherited.jogo.from, 'app', 'o outro layout segue na fábrica');

  const both = L.composePresets({ inherited, project, scopes: { conversa: 'canal Braga' } });
  assert.equal(both.conversa.framing.zoom, 1.2, 'o projeto vence');
  assert.equal(both.conversa.framing.focusX, 0.5, 'o que o projeto não citou vem do canal');
  assert.equal(both.conversa.from, 'projeto');
  assert.equal(both.conversa.own, true);
  assert.deepEqual(both.conversa.ref, { w: 1920, h: 1080 }, 'sem referência própria, vale a herdada');

  // entradas inválidas são ignoradas, nada quebra
  const junk = L.composePresets({ inherited: { conversa: 'lixo', jogo: { framing: 7 } }, project: { jogo: null } });
  assert.equal(junk.conversa.from, 'app');
  assert.equal(junk.jogo.from, 'app');
});

test('readPresets (o que chega pelo IPC): confere cada preset e descarta o que não presta', () => {
  assert.equal(L.readPresets(null), null);
  assert.equal(L.readPresets('x'), null);
  assert.equal(L.readPresets({ conversa: 'x', jogo: 5, outro: { framing: { mode: 'blur' } } }), null);
  const ok = L.readPresets({
    conversa: { framing: { focusX: 5, mode: 'inexistente', zoom: '1.5' }, ref: { w: 1920, h: 1080 }, from: 'canal X', own: true },
    jogo: { framing: { mode: 'stack', stack: { webcamRect: { x: 0, y: 0, w: 0.3, h: 0.3 } } }, from: 12 },
    lixo: { framing: { mode: 'blur' } }
  });
  assert.deepEqual(Object.keys(ok), ['conversa', 'jogo']);
  assert.deepEqual(ok.conversa.framing, { focusX: 1, zoom: 1.5 }, 'valores ajustados à faixa; modo desconhecido sai');
  assert.equal(ok.conversa.from, 'canal X');
  assert.equal(ok.jogo.from, 'app', 'origem inválida vira "app"');
  assert.deepEqual(ok.jogo.camera, { x: 0, y: 0, w: 0.3, h: 0.3 });
  assert.equal(L.readPresets({ conversa: { framing: { zoom: 1 }, from: 'x'.repeat(500) } }).conversa.from.length, 80);
});

// ---------- universais: o renderer usa o MESMO código (window.BFFraming e window.BFLayouts) ----------

test('framing.js e layouts.js são universais: sem module/require expõem window.BFFraming e window.BFLayouts e decidem igual ao CommonJS', () => {
  const root = path.join(__dirname, '..', 'src', 'core', 'export');
  const page = {}; // o "window" de uma página: nada de module, require nem Node
  vm.createContext(page);
  page.globalThis = page;
  for (const name of ['framing.js', 'layouts.js']) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), page, { filename: name });
  assert.equal(typeof page.BFFraming.resolveFraming, 'function');
  assert.equal(typeof page.BFFraming.mergeLayers, 'function');
  assert.deepEqual(Object.keys(page.BFFraming).sort(), Object.keys(F).sort(), 'a mesma API nos dois ambientes');
  assert.deepEqual(Object.keys(page.BFLayouts).sort(), Object.keys(L).sort());
  assert.equal(Object.keys(page).filter((k) => !['globalThis', 'BFFraming', 'BFLayouts'].includes(k)).length, 0, 'nada vaza para o escopo global da página');
  // as mesmas contas: o que a aba mostra é o que o main exporta
  const cut = { id: 'c', start: 1, end: 5, layout: 'jogo', framing: { zoom: 1.3 } };
  const fromPage = page.BFLayouts.resolveCutFraming({ cut, profile: VERTICAL, projectFraming: { focusY: 0.3 }, presets: page.BFLayouts.composePresets({}) });
  const fromNode = L.resolveCutFraming({ cut, profile: VERTICAL, projectFraming: { focusY: 0.3 }, presets: presets() });
  assert.deepEqual(JSON.parse(JSON.stringify(fromPage)), JSON.parse(JSON.stringify(fromNode)));
  assert.deepEqual(JSON.parse(JSON.stringify(page.BFFraming.mergeLayers({ blur: { strength: 5 } }, { blur: { strength: 9 }, zoom: 2 }, null, 'x'))), { blur: { strength: 9 }, zoom: 2 });
});

test('mergeLayers: junta camadas parciais campo a campo (a última vence), ignora o inválido e não altera as entradas', () => {
  const a = deepFreeze({ mode: 'stack', stack: { webcamHeightPct: 30, webcamPosition: 'top' }, zoom: 1.2 });
  const b = deepFreeze({ stack: { webcamHeightPct: 45 }, focusX: 7, blur: { strength: 500 } });
  assert.deepEqual(F.mergeLayers(a, null, undefined, 'x', 3, b), {
    mode: 'stack', zoom: 1.2, focusX: 1, blur: { strength: 80 }, stack: { webcamHeightPct: 45, webcamPosition: 'top' }
  });
  assert.deepEqual(F.mergeLayers(), {});
  const rect = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  assert.deepEqual(F.mergeLayers({ stack: { webcamRect: rect } }, { stack: { webcamRect: { x: 0.5, y: 0.5, w: 0.3, h: 0.3 } } }).stack.webcamRect, { x: 0.5, y: 0.5, w: 0.3, h: 0.3 }, 'o retângulo é trocado inteiro');
});

// ---------- precedência e origem ----------

test('precedência: enquadramento do corte > layout do corte (escolha > sugestão) > padrão do projeto > perfil > app', () => {
  const profile = deepFreeze({ ...VERTICAL, framing: { zoom: 1.1, blur: { strength: 40 } } });
  const projectFraming = deepFreeze({ zoom: 1.3, focusY: 0.2 });
  const frozenPresets = deepFreeze(presets());
  const cutOf = (extra) => deepFreeze({ id: 'c', title: 'x', start: 1, end: 5, ...extra });
  const run = (cut, over = {}) => L.resolveCutFraming({ cut, profile, projectFraming, presets: frozenPresets, ...over });

  // sem layout: padrão do projeto sobre o perfil
  const plain = run(cutOf({}));
  assert.equal(plain.origin.kind, 'default');
  assert.equal(plain.origin.label, 'padrão');
  assert.equal(plain.framing.zoom, 1.3);
  assert.equal(plain.framing.focusY, 0.2);

  // sugestão da análise (Conversa): o preset por cima do padrão do projeto; o que ele não define vem do projeto
  const conversa = run(cutOf({ layout: 'conversa' }));
  assert.equal(conversa.origin.kind, 'suggested');
  assert.equal(conversa.origin.label, 'sugerido: Conversa');
  assert.equal(conversa.framing.focusX, 0.63, 'o preset vence o padrão do projeto');
  assert.equal(conversa.framing.zoom, 1, 'o zoom do preset (1) vence o do projeto (1,3)');
  assert.equal(conversa.framing.focusY, 0.5, 'o preset também fixa o foco vertical');
  assert.equal(conversa.framing.blur.strength, 40, 'campo que o preset não cita vem do perfil');

  // sugestão Jogo: modo empilhado
  const jogo = run(cutOf({ layout: 'jogo' }));
  assert.equal(jogo.framing.mode, 'stack');
  assert.equal(jogo.origin.label, 'sugerido: Jogo');
  assert.equal(jogo.origin.via, 'ia');

  // a escolha do usuário vence a sugestão
  const chosen = run(cutOf({ layout: 'jogo', layoutChoice: 'conversa' }));
  assert.equal(chosen.origin.kind, 'chosen');
  assert.equal(chosen.origin.label, 'escolhido: Conversa');
  assert.equal(chosen.framing.mode, 'center');
  // "padrão" escolhido ignora a sugestão
  const asDefault = run(cutOf({ layout: 'jogo', layoutChoice: 'padrao' }));
  assert.equal(asDefault.origin.kind, 'default');
  assert.equal(asDefault.framing.mode, 'center');
  assert.equal(asDefault.framing.focusX, 0.5);

  // o enquadramento do corte vence o do layout, campo a campo; o resto continua do layout
  const own = run(cutOf({ layout: 'conversa', framing: { focusX: 0.2 } }));
  assert.equal(own.origin.kind, 'custom');
  assert.equal(own.origin.label, 'personalizado');
  assert.equal(own.origin.layout, 'conversa', 'o layout por baixo continua registrado');
  assert.equal(own.origin.base, 'suggested');
  assert.equal(own.framing.focusX, 0.2, 'o corte vence');
  assert.equal(own.framing.zoom, 1, 'o que o corte não citou vem do preset do layout');
  const ownMode = run(cutOf({ layout: 'jogo', framing: { mode: 'blur' } }));
  assert.equal(ownMode.framing.mode, 'blur', 'o modo do corte vence o do layout');
  assert.equal(ownMode.origin.camera, null, 'sem o modo empilhado a câmera do layout não vale');

  // as entradas (congeladas) não foram tocadas: nada lançou erro, e o resolvedor devolve cópias
  conversa.framing.focusX = 0;
  assert.equal(frozenPresets.conversa.framing.focusX, 0.63);
});

test('o interruptor desliga só a SUGESTÃO: a escolha do usuário continua valendo; sem presets nenhum layout se aplica', () => {
  const cut = { id: 'c', start: 1, end: 5, layout: 'jogo' };
  const off = resolve(cut, { useSuggested: false });
  assert.equal(off.origin.kind, 'default');
  assert.equal(off.framing.mode, 'center');
  const chosenOff = resolve({ ...cut, layoutChoice: 'jogo' }, { useSuggested: false });
  assert.equal(chosenOff.origin.kind, 'chosen');
  assert.equal(chosenOff.framing.mode, 'stack');
  const none = resolve(cut, { presets: null });
  assert.equal(none.origin.kind, 'default', 'sem presets o corte segue o padrão (e não afirma um layout que não aplicou)');
  assert.equal(resolve({ id: 'c', start: 1, end: 5 }).origin.kind, 'default', 'corte manual sem layout segue o padrão');
  assert.equal(resolve({ id: 'c', start: 1, end: 5, layout: 'desconhecido' }).origin.kind, 'default');
});

test('fontes da sugestão: detector local (resultado válido) > palpite da IA > nenhuma; resultado velho ou incerto não vale', () => {
  const digest = L.refsDigest({ conversa: ['a', 'b'], jogo: ['c', 'd'] });
  const localKey = (cut) => L.detectorKey({ refsDigest: digest, start: cut.start, end: cut.end });
  const base = { id: 'c', start: 10, end: 20, layout: 'conversa' };
  const detected = { ...base, layoutLocal: { layout: 'jogo', confidence: 0.91, key: localKey(base) } };

  assert.deepEqual(L.suggestionOf(detected, { localKey }), { layout: 'jogo', via: 'detector', confidence: 0.91 }, 'a imagem vence o palpite do texto');
  assert.deepEqual(L.suggestionOf(base, { localKey }), { layout: 'conversa', via: 'ia' });
  assert.equal(L.localState(detected, localKey), 'valid');

  const uncertain = { ...base, layoutLocal: { layout: null, confidence: 0, key: localKey(base) } };
  assert.equal(L.localState(uncertain, localKey), 'uncertain');
  assert.equal(L.suggestionOf(uncertain, { localKey }).via, 'ia', 'incerto não decide: vale o palpite da IA');
  assert.equal(L.suggestionOf({ id: 'c', start: 10, end: 20, layoutLocal: uncertain.layoutLocal }, { localKey }), null, 'sem palpite da IA: nenhuma sugestão (padrão)');

  const moved = { ...detected, end: 21 };
  assert.equal(L.localState(moved, localKey), 'stale', 'o trecho do corte mudou: a detecção não vale mais');
  assert.equal(L.suggestionOf(moved, { localKey }).via, 'ia');
  const otherRefs = (cut) => L.detectorKey({ refsDigest: L.refsDigest({ conversa: ['a', 'x'], jogo: ['c', 'd'] }), start: cut.start, end: cut.end });
  assert.equal(L.localState(detected, otherRefs), 'stale', 'as referências mudaram: a detecção não vale mais');
  assert.equal(L.localState(base, localKey), 'none');
  assert.equal(L.suggestionOf(detected, { useSuggested: false, localKey }), null);

  // a origem do corte registra quem sugeriu
  const viaDetector = L.resolveCutFraming({ cut: detected, profile: VERTICAL, presets: presets(), localKey });
  assert.equal(viaDetector.origin.label, 'sugerido: Jogo');
  assert.equal(viaDetector.origin.via, 'detector');
  assert.equal(viaDetector.origin.confidence, 0.91);
  assert.equal(viaDetector.framing.mode, 'stack');
});

test('refsDigest e detectorKey: mudam com qualquer quadro ou intervalo e são estáveis', () => {
  const a = { conversa: ['x1', 'x2'], jogo: ['y1'] };
  assert.equal(L.refsDigest(a), L.refsDigest(clone(a)));
  assert.match(L.refsDigest(a), /^[0-9a-f]{8}$/);
  assert.notEqual(L.refsDigest(a), L.refsDigest({ conversa: ['x1', 'x2'], jogo: ['y1', 'y2'] }));
  assert.notEqual(L.refsDigest(a), L.refsDigest({ conversa: ['x2', 'x1'], jogo: ['y1'] }), 'a ordem conta');
  assert.notEqual(L.refsDigest({ conversa: ['ab'], jogo: [] }), L.refsDigest({ conversa: [], jogo: ['ab'] }), 'o layout conta');
  assert.equal(L.refsDigest(null), L.refsDigest({}));
  assert.equal(L.detectorKey({ refsDigest: 'abc', start: 1, end: 2.456 }), 'abc:1.00-2.46');
});

test('o enquadramento resolvido é idempotente: o runner o resolve de novo (perfil < Job < corte) e chega ao mesmo resultado', () => {
  const profile = { ...VERTICAL, framing: { zoom: 1.2 } };
  for (const cut of [{ id: 'c', start: 1, end: 5, layout: 'jogo' }, { id: 'c', start: 1, end: 5, layout: 'conversa', framing: { focusX: 0.3 } }, { id: 'c', start: 1, end: 5, layoutChoice: 'conversa', framing: { mode: 'blur', blur: { strength: 12 } } }]) {
    const { framing } = L.resolveCutFraming({ cut, profile, projectFraming: { focusY: 0.4 }, presets: presets() });
    assert.deepEqual(F.resolveFraming(cut, profile, framing), framing, JSON.stringify(cut));
  }
});

// ---------- QC da câmera ----------

test('cameraProblems: proporção diferente da usada no layout, retângulo fora da fonte e câmera pequena (só conta, sem olhar a imagem)', () => {
  const cutJogo = { id: 'c', start: 1, end: 5, layout: 'jogo' };
  const { framing, origin } = resolve(cutJogo);
  const at = (width, height) => L.cameraProblems({ framing, origin, sourceInfo: { width, height } });

  assert.deepEqual(at(1920, 1080), [], 'o mesmo 16:9 do layout, em qualquer resolução');
  assert.deepEqual(at(2560, 1440), []);
  const aspect = at(1920, 1200);
  assert.deepEqual(aspect.map((p) => p.code), ['aspect']);
  assert.match(aspect[0].message, /Jogo foi definido para vídeos 16:9 \(2560×1440\).*1920×1200 \(16:10\).*câmera pode não estar/);
  assert.deepEqual(at(1440, 1080).map((p) => p.code), ['aspect'], '4:3');
  assert.match(at(1440, 1080)[0].message, /4:3/);
  const small = at(640, 360);
  assert.deepEqual(small.map((p) => p.code), ['small']);
  assert.match(small[0].message, /câmera do layout Jogo ocupa só 195×109 pixels/);

  // retângulo da câmera que sai da fonte (como foi guardado, sem o ajuste silencioso para caber)
  const out = L.composePresets({ project: { jogo: { framing: { stack: { webcamRect: { x: 0.9, y: -0.1, w: 0.3, h: 0.3 } } } } } });
  const outside = L.resolveCutFraming({ cut: cutJogo, profile: VERTICAL, presets: out });
  const problems = L.cameraProblems({ framing: outside.framing, origin: outside.origin, sourceInfo: { width: 1920, height: 1080 } });
  assert.deepEqual(problems.map((p) => p.code), ['outside']);
  assert.match(problems[0].message, /de 90% a 120% da largura e de -10% a 20% da altura.*passa da borda de cima e da borda direita.*encostado na borda/);
  assert.ok(outside.framing.stack.webcamRect.x + outside.framing.stack.webcamRect.w <= 1 + 1e-9, 'o filtro encosta o retângulo na borda (é o que o aviso diz)');

  // sem layout, em outro modo ou sem origem: nada a conferir
  assert.deepEqual(L.cameraProblems({ framing: resolve({ id: 'c', start: 1, end: 5 }).framing, origin: resolve({ id: 'c', start: 1, end: 5 }).origin, sourceInfo: { width: 1920, height: 1200 } }), []);
  const blur = resolve({ ...cutJogo, framing: { mode: 'blur' } });
  assert.deepEqual(L.cameraProblems({ framing: blur.framing, origin: blur.origin, sourceInfo: { width: 1920, height: 1200 } }), []);
  assert.deepEqual(L.cameraProblems({ framing, origin: null, sourceInfo: { width: 1920, height: 1200 } }), []);
  assert.deepEqual(L.cameraProblems({}), []);
  const conversa = resolve({ id: 'c', start: 1, end: 5, layout: 'conversa' });
  assert.deepEqual(L.cameraProblems({ framing: conversa.framing, origin: conversa.origin, sourceInfo: { width: 1920, height: 1200 } }), [], 'Conversa não tem retângulo de câmera');
});

// ---------- Jobs: origem registrada e chave da fila ----------

const project = () => ({
  id: 'p1', source: { path: 'D:\\Lives\\live.mp4', duration: 600, width: 2560, height: 1440 },
  cuts: [
    { id: 'a', title: 'Jogo da IA', start: 10, end: 20, status: 'approved', layout: 'jogo' },
    { id: 'b', title: 'Conversa da IA', start: 30, end: 40, status: 'approved', layout: 'conversa' },
    { id: 'c', title: 'Manual', start: 50, end: 60, status: 'approved' },
    { id: 'd', title: 'Ajustado', start: 70, end: 80, status: 'approved', layout: 'conversa', framing: { focusX: 0.2 } },
    { id: 'e', title: 'Escolhido', start: 90, end: 100, status: 'approved', layout: 'jogo', layoutChoice: 'conversa' }
  ]
});
const INFO = { width: 2560, height: 1440, fps: 60, duration: 600, hasAudio: true };
const jobsOf = (extra = {}) => buildJobs({ project: project(), info: INFO, cutIds: ['a', 'b', 'c', 'd', 'e'], profile: VERTICAL, outputDir: 'D:\\Lives\\Cortes', layouts: { presets: presets(), useSuggested: true }, ...extra });

test('buildJobs: cada Job registra a origem do enquadramento (framingSource) e leva o enquadramento já resolvido', () => {
  const { jobs } = jobsOf();
  const byId = Object.fromEntries(jobs.map((j) => [j.cut.id, j]));
  assert.deepEqual(Object.keys(byId.a).sort(), ['baseName', 'createdAt', 'cut', 'framing', 'framingSource', 'id', 'onConflict', 'outputDir', 'profile', 'projectId', 'projectTitle', 'sourceInfo', 'sourcePath']);
  assert.equal(byId.a.framing.mode, 'stack');
  assert.equal(byId.a.framingSource.label, 'sugerido: Jogo');
  assert.equal(byId.a.framingSource.via, 'ia');
  assert.deepEqual(byId.a.framingSource.preset, { from: 'app', ref: { w: 2560, h: 1440 } });
  assert.deepEqual(byId.a.framingSource.camera, { x: 0, y: 0, w: 0.3047, h: 0.3028 });
  assert.equal(byId.b.framing.mode, 'center');
  assert.equal(byId.b.framing.focusX, 0.63);
  assert.equal(byId.b.framingSource.label, 'sugerido: Conversa');
  assert.equal(byId.c.framingSource.label, 'padrão');
  assert.equal(byId.c.framingSource.layout, null);
  assert.equal(byId.d.framingSource.label, 'personalizado');
  assert.equal(byId.d.framingSource.base, 'suggested');
  assert.equal(byId.d.framing.focusX, 0.2);
  assert.equal(byId.e.framingSource.label, 'escolhido: Conversa');
  assert.equal(byId.e.framing.mode, 'center');
  // o corte do Job é um instantâneo: continua com o layout da análise e a escolha do usuário, e o projeto não foi alterado
  assert.equal(byId.e.cut.layout, 'jogo');
  assert.equal(byId.e.cut.layoutChoice, 'conversa');
  assert.equal(project().cuts[0].framing, undefined);
  assert.deepEqual(byId.a.profile, VERTICAL, 'o perfil não foi alterado pelo layout');

  // interruptor desligado: as sugestões deixam de valer (a escolha do corte "e" continua)
  const off = Object.fromEntries(jobsOf({ layouts: { presets: presets(), useSuggested: false } }).jobs.map((j) => [j.cut.id, j]));
  assert.equal(off.a.framingSource.label, 'padrão');
  assert.equal(off.a.framing.mode, 'center');
  assert.equal(off.b.framingSource.label, 'padrão');
  assert.equal(off.d.framingSource.label, 'personalizado');
  assert.equal(off.d.framingSource.layout, null, 'sem sugestão por baixo');
  assert.equal(off.e.framingSource.label, 'escolhido: Conversa');

  // sem o parâmetro `layouts` (chamadores antigos) nada muda: tudo no padrão
  const legacy = Object.fromEntries(jobsOf({ layouts: undefined }).jobs.map((j) => [j.cut.id, j]));
  assert.equal(legacy.a.framing.mode, 'center');
  assert.equal(legacy.a.framingSource.label, 'padrão');
  assert.equal(legacy.e.framingSource.label, 'padrão', 'sem presets nem a escolha do usuário se aplica');
});

test('chave da fila: o enquadramento efetivo muda a chave (nada exportado é pulado por engano); a origem sozinha não muda', () => {
  const key = (extra, id) => {
    const job = jobsOf(extra).jobs.find((j) => j.cut.id === id);
    return jobKey(job);
  };
  // corte sugerido como Jogo: ligar/desligar o interruptor troca o enquadramento (stack <-> center) e a chave
  const on = key({}, 'a');
  const off = key({ layouts: { presets: presets(), useSuggested: false } }, 'a');
  assert.notEqual(on, off, 'com e sem o layout sugerido são arquivos diferentes');
  assert.equal(on, key({}, 'a'), 'estável');
  // editar o preset muda a chave dos cortes que o usam, e só deles
  const edited = L.composePresets({ project: { jogo: { framing: { stack: { webcamHeightPct: 40 } } } } });
  assert.notEqual(on, key({ layouts: { presets: edited, useSuggested: true } }, 'a'));
  assert.equal(key({}, 'b'), key({ layouts: { presets: edited, useSuggested: true } }, 'b'), 'o corte de Conversa não depende do preset de Jogo');
  // a mesma imagem final por caminhos diferentes (sugerido x escolhido) é o mesmo trabalho: a chave só olha o resultado
  const project2 = project();
  project2.cuts[0] = { ...project2.cuts[0], layoutChoice: 'jogo' };
  const chosenJob = buildJobs({ project: project2, info: INFO, cutIds: ['a'], profile: VERTICAL, outputDir: 'D:\\Lives\\Cortes', layouts: { presets: presets(), useSuggested: true } }).jobs[0];
  assert.equal(chosenJob.framingSource.kind, 'chosen');
  assert.equal(jobKey(chosenJob), on, 'sugerido: Jogo e escolhido: Jogo geram o mesmo arquivo');
  // trocar o layout da análise por outro layout muda a imagem
  const project3 = project();
  project3.cuts[0] = { ...project3.cuts[0], layoutChoice: 'conversa' };
  const swapped = buildJobs({ project: project3, info: INFO, cutIds: ['a'], profile: VERTICAL, outputDir: 'D:\\Lives\\Cortes', layouts: { presets: presets(), useSuggested: true } }).jobs[0];
  assert.notEqual(jobKey(swapped), on);
});

test('fila de verdade: um corte já exportado no padrão NÃO é pulado quando o layout muda o enquadramento; repetir o mesmo layout é pulado; a origem fica no Job guardado', async () => {
  const dir = qh.tmpDir('layouts');
  try {
    const fake = qh.makeFakeRunner({ autoFinish: 1 });
    const q = qh.makeManager(dir, { runner: fake.runner }).load();
    const src = qh.makeSource(dir);
    const make = (layouts) => {
      const proj = { ...project(), source: { ...project().source, path: src } };
      const job = buildJobs({ project: proj, info: INFO, cutIds: ['a'], profile: VERTICAL, outputDir: path.join(dir, 'Cortes'), layouts }).jobs[0];
      return { ...job, sourceInfo: { ...job.sourceInfo }, onConflict: 'rename', id: `job-${Math.random().toString(36).slice(2, 8)}` };
    };

    // 1) exportado no padrão (interruptor desligado)
    const [first] = q.enqueue([make({ presets: presets(), useSuggested: false })]);
    await qh.waitUntil(() => qh.stateOf(q, first.id) === 'done', { what: 'a primeira exportação' });
    assert.equal(first.framingSource.label, 'padrão', 'a origem chega ao Job que a fila guarda');
    // 2) o mesmo corte com o layout sugerido: o enquadramento efetivo mudou, então é trabalho novo
    const [second] = q.enqueue([make({ presets: presets(), useSuggested: true })]);
    assert.notEqual(second.state, 'skipped', `não pode ser pulado: ${second.skippedReason}`);
    assert.equal(second.framingSource.label, 'sugerido: Jogo');
    assert.equal(second.framingSource.via, 'ia');
    await qh.waitUntil(() => qh.stateOf(q, second.id) === 'done', { what: 'a segunda exportação' });
    // 3) repetir exatamente o mesmo (mesmo layout) é pulado
    const [third] = q.enqueue([make({ presets: presets(), useSuggested: true })]);
    assert.equal(third.state, 'skipped');
    assert.equal(third.skippedCode, 'ALREADY_DONE');
    assert.equal(fake.calls.length, 2, 'só duas exportações de verdade');
    // 4) a origem foi gravada no queue.json (auditoria)
    q.flush();
    const saved = qh.readState(dir).jobs.map((j) => j.framingSource && j.framingSource.label);
    assert.deepEqual(saved.slice(0, 2), ['padrão', 'sugerido: Jogo']);
    q.shutdown();
  } finally {
    qh.removeDir(dir);
  }
});

// ---------- exportação de verdade (ffmpeg real, amostragem de pixels) ----------

test('Jogo e Conversa no ffmpeg real: o layout vira empilhado (câmera em cima) ou recorte no rosto; ajuste de um corte não altera preset nem perfil', { skip: skipMedia }, () => {
  const dir = fx.tmpDir('bf-layouts-');
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, audio: false });
    const info = { width: 1920, height: 1080, fps: 10, duration: 3, hasAudio: false };
    const proj = {
      id: 'p', source: { path: src, duration: 3, width: 1920, height: 1080 },
      cuts: [
        { id: 'g1', title: 'Jogo 1', start: 0, end: 2, layout: 'jogo' },
        { id: 'g2', title: 'Jogo 2', start: 0, end: 2, layout: 'jogo', framing: { stack: { webcamPosition: 'bottom' } } },
        { id: 'c1', title: 'Conversa', start: 0, end: 2, layout: 'conversa' },
        { id: 'c2', title: 'Conversa ajustada', start: 0, end: 2, layout: 'conversa', framing: { focusX: 0 } }
      ]
    };
    const composed = presets();
    const presetsBefore = clone(composed);
    const profileBefore = clone(VERTICAL);
    const { jobs } = buildJobs({ project: proj, info, cutIds: proj.cuts.map((c) => c.id), profile: VERTICAL, outputDir: path.join(dir, 'Cortes'), layouts: { presets: composed, useSuggested: true } });
    const byId = Object.fromEntries(jobs.map((j) => [j.cut.id, j]));
    const render = (id) => fx.renderRaw(src, F.buildVideoGraph({ framing: byId[id].framing, profile: VERTICAL }), 1080, 1920);

    // Jogo: faixa de cima (596 px) = a câmera (canto superior esquerdo da fonte), faixa de baixo = o jogo (a região logo depois da câmera)
    const camH = 596;
    const cam = fx.coverWindow({ x: 0, y: 0, w: 0.3047, h: 0.3028 }, 1920, 1080, 1080, camH);
    const game = fx.coverWindow({ x: 0.306, y: 0, w: 0.459, h: 1 }, 1920, 1080, 1080, 1920 - camH);
    const g1 = render('g1');
    near(fx.avg(g1, 4, camH / 2, 0), 255 * cam.x0, 8, 'câmera: borda esquerda');
    near(fx.avg(g1, 1075, camH / 2, 0), 255 * cam.x1, 8, 'câmera: borda direita (30% da largura da fonte)');
    near(fx.avg(g1, 540, 4, 1), 255 * cam.y0, 8, 'câmera: topo');
    near(fx.avg(g1, 540, camH - 5, 1), 255 * cam.y1, 8, 'câmera: base (30% da altura da fonte)');
    near(fx.avg(g1, 4, camH + 700, 0), 255 * game.x0, 8, 'jogo: começa depois da câmera');
    near(fx.avg(g1, 1075, camH + 700, 0), 255 * game.x1, 8, 'jogo: borda direita');
    near(fx.avg(g1, 540, camH + 4, 1), 255 * game.y0, 8, 'jogo: topo');
    near(fx.avg(g1, 540, 1915, 1), 255 * game.y1, 8, 'jogo: base');

    // Conversa: recorte vertical com foco horizontal de 0,63 (janela de 43% a 75% da largura)
    const win = 1080 / 1920 / (1920 / 1080);
    const c1 = render('c1');
    near(fx.avg(c1, 4, 960, 0), 255 * 0.63 * (1 - win), 8, 'conversa: borda esquerda da janela');
    near(fx.avg(c1, 1075, 960, 0), 255 * (0.63 * (1 - win) + win), 8, 'conversa: borda direita da janela');

    // ajuste de UM corte: só ele muda (a câmera passa para baixo / a janela vai para a esquerda)...
    const g2 = render('g2');
    near(fx.avg(g2, 4, 1920 - camH / 2, 0), 255 * cam.x0, 8, 'ajuste do corte: a câmera foi para baixo');
    near(fx.avg(g2, 4, 700, 0), 255 * game.x0, 8, 'ajuste do corte: o jogo passou para cima');
    const c2 = render('c2');
    near(fx.avg(c2, 4, 960, 0), 0, 8, 'ajuste do corte: janela encostada na esquerda');
    assert.ok(fx.avg(c1, 4, 960, 0) - fx.avg(c2, 4, 960, 0) > 80, 'a janela do corte ajustado é bem diferente da do preset');
    // ...e os outros cortes do mesmo layout continuam idênticos ao preset, pixel por pixel
    assert.ok(render('g1').data.equals(g1.data));
    assert.ok(render('c1').data.equals(c1.data));
    // preset, perfil e projeto não foram tocados
    assert.deepEqual(composed, presetsBefore, 'o preset não foi alterado por ajustes de corte');
    assert.deepEqual(VERTICAL, profileBefore, 'o perfil não foi alterado');
    assert.equal(proj.cuts[1].framing.stack.webcamPosition, 'bottom');
    assert.equal(proj.cuts[0].framing, undefined);
  } finally { fx.cleanup(dir); }
});

test('exportar de verdade (runExportJob): o arquivo de um corte Jogo sai empilhado e o de um corte Conversa sai recortado no rosto', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-layouts-run-');
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, fps: 10, seconds: 3 });
    const info = { width: 1920, height: 1080, fps: 10, duration: 3, hasAudio: true };
    const proj = { id: 'p', source: { path: src, duration: 3, width: 1920, height: 1080 }, cuts: [
      { id: 'j', title: 'Jogo', start: 0.5, end: 2, layout: 'jogo' }, { id: 'c', title: 'Conversa', start: 0.5, end: 2, layout: 'conversa' }] };
    const profile = { ...VERTICAL, width: 540, height: 960, bitrateKbps: 3000, encoder: 'software' };
    const { jobs } = buildJobs({ project: proj, info, cutIds: ['j', 'c'], profile, outputDir: path.join(dir, 'Cortes'), layouts: { presets: presets(), useSuggested: true } });
    const out = {};
    for (const job of jobs) {
      const res = await runExportJob({ ...job, onConflict: 'rename' }, { tools });
      out[job.cut.id] = res.output;
      const probed = await fx.probe(res.output);
      assert.deepEqual([probed.width, probed.height], [540, 960]);
    }
    const jogo = fx.decodeFile(out.j, 540, 960, { ss: 0.5 });
    const conversa = fx.decodeFile(out.c, 540, 960, { ss: 0.5 });
    const camH = 298; // 31% de 960, par
    // jogo: a faixa de cima só mostra a região da câmera (R < 80), a de baixo vai além (até ~195)
    near(fx.avg(jogo, 536, camH / 2, 0), 255 * 0.3047, 12, 'jogo exportado: borda direita da câmera');
    assert.ok(fx.avg(jogo, 536, camH + 300, 0) > 150, 'jogo exportado: a faixa de baixo mostra mais da largura da fonte');
    // conversa: a janela 9:16 começa em 43% da largura
    near(fx.avg(conversa, 3, 480, 0), 255 * 0.63 * (1 - 1080 / 1920 / (1920 / 1080)), 12, 'conversa exportada: borda esquerda da janela');
  } finally { fx.cleanup(dir); }
});

// ---------- QC no Job montado ----------

function withQcJob(fn) {
  const dir = fx.tmpDir('bf-layouts-qc-');
  try {
    const src = path.join(dir, 'fonte.mp4');
    fx.makeCodedSource(src, { width: 320, height: 180, fps: 5, seconds: 2 });
    const make = (info, cutExtra = {}, layouts = { presets: presets(), useSuggested: true }) => buildJobs({
      project: { id: 'p', source: { path: src, duration: 600, width: info.width, height: info.height }, cuts: [{ id: 'c', title: 'Meu corte', start: 10, end: 40, layout: 'jogo', ...cutExtra }] },
      info: { ...info, fps: 30, duration: 600, hasAudio: true }, cutIds: ['c'], profile: { ...VERTICAL, width: 360, height: 640, kind: 'custom', bitrateKbps: 2000 }, outputDir: path.join(dir, 'Cortes'), layouts
    }).jobs[0];
    return fn(make, dir);
  } finally { fx.cleanup(dir); }
}
const qc = (job) => preflight(job, { tools, encoderNames: ALL_ENCODERS });

test('QC: o retângulo da câmera fora da fonte (outra proporção, fonte pequena, retângulo para fora) é AVISO e nunca bloqueia', { skip: skipMedia }, () => withQcJob((make) => {
  const clean = qc(make({ width: 1920, height: 1080 }));
  assert.deepEqual(clean.errors, []);
  assert.ok(!clean.warnings.some((w) => w.code === 'CAMERA_RECT'), 'a fonte 16:9 do layout: nada a avisar');

  const aspect = qc(make({ width: 1920, height: 1200 }));
  assert.deepEqual(aspect.errors, [], 'aviso não bloqueia');
  const w = aspect.warnings.filter((x) => x.code === 'CAMERA_RECT');
  assert.equal(w.length, 1);
  assert.match(w[0].message, /layout Jogo foi definido para vídeos 16:9.*1920×1200 \(16:10\)/);

  const small = qc(make({ width: 640, height: 360 }));
  assert.deepEqual(small.errors, []);
  assert.match(small.warnings.find((x) => x.code === 'CAMERA_RECT').message, /ocupa só 195×109 pixels/);

  // retângulo guardado para fora da fonte
  const out = L.composePresets({ project: { jogo: { framing: { stack: { webcamRect: { x: 0.85, y: 0, w: 0.3, h: 0.3 } } } } } });
  const outside = qc(make({ width: 1920, height: 1080 }, {}, { presets: out, useSuggested: true }));
  assert.deepEqual(outside.errors, []);
  assert.match(outside.warnings.find((x) => x.code === 'CAMERA_RECT').message, /passa da borda direita/);

  // sem layout (ou sem o interruptor), em outro modo, ou um Job sem origem (como o que a fila reenvia ao QC): nenhum aviso de câmera
  for (const job of [
    make({ width: 1920, height: 1200 }, { layout: undefined }),
    make({ width: 1920, height: 1200 }, {}, { presets: presets(), useSuggested: false }),
    make({ width: 1920, height: 1200 }, { framing: { mode: 'blur' } }),
    make({ width: 1920, height: 1200 }, { layout: 'conversa' }),
    (() => { const j = make({ width: 1920, height: 1200 }); delete j.framingSource; return j; })()
  ]) {
    assert.ok(!qc(job).warnings.some((x) => x.code === 'CAMERA_RECT'));
  }
}));

// ---------- export:prepare (IPC) ----------

test('export:prepare com layouts: Jobs com a origem e o aviso da câmera no relatório de cada corte; pedido malformado não quebra', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('bf-layouts-ipc-');
  try {
    const src = path.join(dir, 'live.mp4');
    fx.makeCodedSource(src, { width: 1920, height: 1080, fps: 10, seconds: 4 });
    const { call } = fx.setupExportIpc(path.join(dir, 'userdata'));
    const proj = { id: 'p-1', version: 2, source: { path: src, duration: 4, width: 1920, height: 1080 }, cuts: [
      { id: 'a', title: 'Jogo', start: 0.5, end: 1.5, status: 'approved', layout: 'jogo' },
      { id: 'b', title: 'Conversa', start: 2, end: 3.5, status: 'approved', layout: 'conversa' },
      { id: 'c', title: 'Sem layout', start: 3, end: 3.8, status: 'approved' }] };
    const profile = { ...VERTICAL, encoder: 'software' };
    const outputDir = path.join(dir, 'Cortes');
    const info = (w, h) => ({ width: w, height: h, fps: 10, duration: 4, hasAudio: true });
    const base = { project: proj, cutIds: ['a', 'b', 'c'], profile, framing: { zoom: 1.2 }, outputDir };

    const ok = await call('export:prepare', { ...base, info: info(1920, 1080), layouts: { presets: presets(), useSuggested: true, refsDigest: 'abc' } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const [a, b, c] = ok.jobs;
    assert.equal(a.framing.mode, 'stack');
    assert.equal(a.framingSource.label, 'sugerido: Jogo');
    assert.equal(b.framing.mode, 'center');
    assert.equal(b.framing.focusX, 0.63);
    assert.equal(b.framing.zoom, 1, 'o preset vence o padrão do projeto (zoom 1,2)');
    assert.equal(c.framing.zoom, 1.2, 'sem layout vale o padrão do projeto');
    assert.equal(c.framingSource.label, 'padrão');
    for (const r of ok.reports) assert.ok(!r.warnings.some((x) => x.code === 'CAMERA_RECT'));

    // fonte 16:10: o corte Jogo avisa, os outros não; ninguém é bloqueado
    const wide = await call('export:prepare', { ...base, info: info(1920, 1200), layouts: { presets: presets(), useSuggested: true } });
    const byCut = Object.fromEntries(wide.reports.map((r) => [r.cutId, r]));
    assert.ok(byCut.a.warnings.some((x) => x.code === 'CAMERA_RECT' && /16:10/.test(x.message)));
    assert.ok(!byCut.b.warnings.some((x) => x.code === 'CAMERA_RECT'));
    assert.ok(!byCut.c.warnings.some((x) => x.code === 'CAMERA_RECT'));
    assert.ok(wide.reports.every((r) => r.errors.length === 0));

    // sem `layouts`: tudo no padrão; com lixo: ignorado
    const none = await call('export:prepare', { ...base, info: info(1920, 1080) });
    assert.equal(none.jobs[0].framing.mode, 'center');
    assert.equal(none.jobs[0].framingSource.label, 'padrão');
    for (const junk of ['x', 7, [], { presets: 'x' }, { presets: { jogo: 'x', conversa: { framing: 4 } } }, { presets: { jogo: { framing: { mode: 'stack', stack: { webcamRect: 'x' } } } } }]) {
      const res = await call('export:prepare', { ...base, info: info(1920, 1080), layouts: junk });
      assert.equal(res.ok, true, JSON.stringify(junk));
      assert.equal(res.jobs.length, 3);
    }
    assert.ok(!fs.existsSync(outputDir), 'preparar não cria nada no destino');
  } finally {
    encoders.resetCache();
    encoders.configure({ cacheDir: null });
    encoders.forgetMemory();
    fx.cleanup(dir);
  }
});
