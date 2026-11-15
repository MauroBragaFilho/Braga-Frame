'use strict';

/**
 * Detector local de layout (src/core/export/layoutDetector.js): modelo a partir dos quadros de referência, decisão por quadro e por
 * corte (conservadora), extração de quadros com o ffmpeg de verdade num vídeo sintético com dois layouts (mais um terceiro que não é
 * nenhum dos dois) e os canais export:layoutRef / export:detectLayouts.
 *
 * A avaliação com quadros REAIS de uma live (rotulados à mão) é feita fora do repositório (o vídeo é conteúdo de terceiros);
 * os números ficam em docs/recursos/exportEngine.md.
 */

const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../src/core/export/layoutDetector');
const L = require('../src/core/export/layouts');
const encoders = require('../src/core/export/encoders');
const fx = require('./export-fixtures');

const { tools, skipMedia } = fx;
const W = D.THUMB_W;
const H = D.THUMB_H;

// ---------- miniaturas fabricadas: conteúdo que varia + cenário fixo ----------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Campo suave aleatório (conteúdo de um jogo ou de uma câmera): muda inteiro a cada semente. */
function content(seed) {
  const r = rng(seed);
  const waves = Array.from({ length: 5 }, () => ({ fx: 0.05 + r() * 0.35, fy: 0.05 + r() * 0.35, p: r() * 6.28, a: 20 + r() * 40 }));
  const t = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 110;
      for (const w of waves) v += w.a * Math.sin(x * w.fx + y * w.fy + w.p);
      t[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return t;
}

function box(t, x0, y0, x1, y1, f) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) t[y * W + x] = f(x, y);
}

/** Cenário de cada layout por cima do conteúdo: conversa = QR (xadrez) e painel de linhas à direita; jogo = caixa da câmera e barra de itens. */
function scene(layout, seed) {
  const t = content(seed);
  if (layout === 'conversa') {
    box(t, 46, 24, 62, 34, (x, y) => ((Math.floor((x - 46) / 2) + Math.floor((y - 24) / 2)) % 2 ? 20 : 240));
    box(t, 48, 3, 62, 20, (x, y) => (y % 3 === 0 ? 235 : 40));
    box(t, 2, 1, 62, 3, () => 230);
  } else if (layout === 'jogo') {
    box(t, 0, 0, 19, 11, (x, y) => (x === 18 || y === 10 ? 245 : Math.round(70 + 8 * Math.sin(seed + x * 0.5 + y * 0.7))));
    box(t, 20, 32, 44, 35, (x) => (x % 3 === 0 ? 235 : 55));
  } else if (layout === 'outro') {
    box(t, 45, 0, 64, 11, (x, y) => (x === 45 || y === 10 ? 250 : 90));
    box(t, 2, 26, 14, 33, () => 250);
  }
  return t;
}

const refsOf = (n = 3) => ({
  conversa: Array.from({ length: n }, (_, i) => scene('conversa', 100 + i * 7)),
  jogo: Array.from({ length: n }, (_, i) => scene('jogo', 200 + i * 11))
});

test('gradientMap: áreas lisas não têm borda; uma borda aparece só onde está; bytes e números dão o mesmo mapa', () => {
  const flat = D.gradientMap(new Uint8Array(W * H).fill(120));
  assert.equal(Math.max(...flat), 0);
  const step = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) step[y * W + x] = x < 32 ? 0 : 255;
  const g = D.gradientMap(step);
  assert.equal(g[10 * W + 31], 1, 'a borda vertical entre as colunas 31 e 32');
  assert.equal(g[10 * W + 20], 0);
  assert.equal(g[10 * W + 40], 0);
  const asFloat = Float32Array.from(step, (v) => v / 255);
  assert.deepEqual([...D.gradientMap(asFloat)], [...g]);
});

test('buildModel: dois layouts bem diferentes dão um cenário fixo reconhecível para cada um', () => {
  const model = D.buildModel(refsOf(3));
  assert.equal(model.ok, true, JSON.stringify(model.problems));
  assert.deepEqual(model.problems, []);
  for (const layout of D.LAYOUTS) {
    assert.equal(model.layouts[layout].n, 3);
    assert.ok(model.layouts[layout].cells.length >= D.MIN_CELLS, `${layout}: ${model.layouts[layout].cells.length} células`);
  }
  // o cenário fixo mora onde os layouts desenham (QR/painel à direita; câmera à esquerda), não no conteúdo que muda
  const cx = (cells) => cells.reduce((s, i) => s + (i % W), 0) / cells.length;
  assert.ok(cx(model.layouts.conversa.cells) > W / 2, 'conversa: cenário à direita');
  assert.ok(cx(model.layouts.jogo.cells) < W / 2, 'jogo: cenário à esquerda');
  const summary = D.summarize(model);
  assert.equal(summary.ok, true);
  assert.deepEqual(Object.keys(summary.layouts), ['conversa', 'jogo']);
  assert.ok(summary.layouts.conversa.sceneryPct > 0 && summary.layouts.conversa.sceneryPct < 30);
});

test('buildModel: recusa referências que não servem, com a causa em português (poucas, quase iguais, sem cenário em comum)', () => {
  // poucas
  const few = D.buildModel({ conversa: [scene('conversa', 1)], jogo: refsOf(2).jogo });
  assert.equal(few.ok, false);
  assert.equal(few.problems[0].code, 'FEW_REFS');
  assert.match(few.problems[0].message, /Conversa: escolha pelo menos 2 quadros de referência, de momentos diferentes \(1 escolhido\)/);
  assert.equal(D.buildModel({}).ok, false);
  assert.equal(D.buildModel(null).problems.length, 2);
  // quadros inválidos (tamanho errado) não contam
  assert.equal(D.buildModel({ conversa: [new Uint8Array(10), new Uint8Array(10)], jogo: refsOf(2).jogo }).problems[0].code, 'FEW_REFS');

  // quase iguais: o modelo confundiria conteúdo com cenário
  const base = scene('jogo', 5);
  const almost = Uint8Array.from(base, (v, i) => (i % 97 === 0 ? v + 1 : v));
  const similar = D.buildModel({ conversa: refsOf(2).conversa, jogo: [base, almost] });
  assert.equal(similar.ok, false);
  assert.equal(similar.problems[0].code, 'SIMILAR_REFS');
  assert.match(similar.problems[0].message, /Jogo: dois dos quadros escolhidos são quase iguais.*momentos bem diferentes/);

  // nada que distinga um layout do outro: os quadros dos dois são praticamente os mesmos
  const twin = (t) => Uint8Array.from(t, (v, i) => (i % 211 === 0 ? v + 1 : v));
  const same = D.buildModel({ conversa: [scene('jogo', 11), scene('jogo', 12)], jogo: [twin(scene('jogo', 11)), twin(scene('jogo', 12))] });
  assert.equal(same.ok, false);
  assert.ok(same.problems.some((p) => p.code === 'NO_SCENERY' && /não têm uma parte fixa em comum que os distinga/.test(p.message)));
});

test('classifyFrame: decide o layout certo com folga; o que não é nenhum dos dois (ou é liso ou ruído) fica incerto; nunca chuta', () => {
  const model = D.buildModel(refsOf(3));
  for (let i = 0; i < 12; i++) {
    const c = D.classifyFrame(model, scene('conversa', 1000 + i));
    assert.equal(c.layout, 'conversa', `conversa ${i}: ${JSON.stringify(c.scores)}`);
    assert.ok(c.confidence >= 0.66, `confiança ${c.confidence}`);
    assert.equal(D.classifyFrame(model, scene('jogo', 2000 + i)).layout, 'jogo', `jogo ${i}`);
  }
  // outra cena (câmera no canto oposto + bloco), liso e ruído não decidem
  for (let i = 0; i < 6; i++) assert.equal(D.classifyFrame(model, scene('outro', 3000 + i)).layout, null, `outro ${i}`);
  for (const v of [0, 128, 255]) assert.equal(D.classifyFrame(model, new Uint8Array(W * H).fill(v)).layout, null, `liso ${v}`);
  const r = rng(9);
  assert.equal(D.classifyFrame(model, Uint8Array.from({ length: W * H }, () => Math.floor(r() * 256))).layout, null, 'ruído');
  // entradas inválidas
  assert.equal(D.classifyFrame(model, null).reason, 'sem_quadro');
  assert.equal(D.classifyFrame({ ok: false }, scene('jogo', 1)).reason, 'sem_modelo');
  assert.equal(D.classifyFrame(null, scene('jogo', 1)).layout, null);
});

test('classifyCut: vale o layout se ao menos 2 dos 3 quadros decidem e nenhum discorda; senão "layout incerto"', () => {
  const model = D.buildModel(refsOf(3));
  const conv = (n) => scene('conversa', 5000 + n);
  const jogo = (n) => scene('jogo', 6000 + n);
  const outro = (n) => scene('outro', 7000 + n);

  const all = D.classifyCut(model, [conv(1), conv(2), conv(3)]);
  assert.equal(all.layout, 'conversa');
  assert.equal(all.reason, 'ok');
  assert.equal(all.samples.length, 3);
  assert.ok(all.confidence >= 0.66);
  assert.equal(all.confidence, Math.min(...all.samples.map((s) => s.confidence)), 'a confiança do corte é a do pior quadro');

  const two = D.classifyCut(model, [conv(1), outro(1), conv(3)]);
  assert.equal(two.layout, 'conversa', 'dois decidem e o terceiro só não teve certeza');

  const split = D.classifyCut(model, [conv(1), jogo(1), conv(3)]);
  assert.equal(split.layout, null, 'um quadro discorda: o corte mudou de layout ou o detector errou, então não decide');
  assert.equal(split.reason, 'quadros_discordam');

  const one = D.classifyCut(model, [conv(1), outro(1), outro(2)]);
  assert.equal(one.layout, null);
  assert.equal(one.reason, 'poucos_quadros');
  const none = D.classifyCut(model, [outro(1), outro(2), outro(3)]);
  assert.equal(none.layout, null);
  assert.equal(none.reason, 'incerto');
  assert.equal(D.classifyCut(model, [conv(1), null, conv(3)]).layout, 'conversa', 'um quadro que não saiu não atrapalha');
  assert.equal(D.classifyCut(model, [null, null, conv(3)]).layout, null);
  assert.equal(D.classifyCut(model, []).layout, null);
  assert.equal(D.classifyCut(model, undefined).layout, null);
  assert.equal(D.classifyCut(D.buildModel({}), [conv(1), conv(2), conv(3)]).layout, null, 'sem modelo válido nada se decide');
});

test('cutTimes (20%, 50% e 80% do corte) e a miniatura em texto (base64) para guardar no projeto', () => {
  assert.deepEqual(D.cutTimes({ start: 10, end: 20 }), [12, 15, 18]);
  assert.deepEqual(D.cutTimes({ start: 0, end: 3 }), [0.6, 1.5, 2.4]);
  assert.deepEqual(D.cutTimes({ start: 5, end: 5 }), []);
  assert.deepEqual(D.cutTimes({ start: 'a', end: 9 }), []);
  assert.deepEqual(D.cutTimes(null), []);

  const t = scene('jogo', 42);
  const text = D.thumbToBase64(t);
  assert.equal(text.length, 3072, '2304 bytes em base64');
  assert.match(text, /^[A-Za-z0-9+/]{3072}$/, 'é o mesmo formato que a aba confere antes de usar');
  assert.deepEqual([...D.thumbFromBase64(text)], [...t]);
  assert.equal(D.thumbFromBase64('curto'), null);
  assert.equal(D.thumbFromBase64(null), null);
  assert.equal(D.thumbFromBase64(`${text.slice(0, -4)}AAAA`).length, 2304);
});

// ---------- ffmpeg real: vídeo sintético com dois layouts e um terceiro ----------

// o vídeo sintético é gerado uma vez só e apagado no fim do arquivo de testes
let shared = null;
const extraDirs = [];
function layoutVideo() {
  if (!shared) {
    const dir = fx.tmpDir('bf-detector-');
    const file = path.join(dir, 'layouts.mp4');
    const info = fx.makeLayoutSource(file);
    shared = { dir, file, info, seg: (n) => info.segments[n] };
  }
  return shared;
}
after(() => {
  encoders.resetCache();
  encoders.configure({ cacheDir: null });
  encoders.forgetMemory();
  if (shared) fx.cleanup(shared.dir);
  for (const dir of extraDirs) fx.cleanup(dir);
});
const withLayoutVideo = async (fn) => fn(layoutVideo());

/** Referências como o usuário faria: dois momentos de cada layout, em segmentos diferentes. */
async function realRefs(file, info) {
  const grab = (t) => D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: t });
  const s = info.segments;
  return {
    conversa: [await grab(s[0].start + 1.5), await grab(s[2].start + 3)],
    jogo: [await grab(s[1].start + 1.5), await grab(s[3].start + 3)]
  };
}

test('grabThumb: miniatura 64x36 em tons de cinza do instante pedido; sem quadro devolve null; arquivo ausente e cancelamento dão erro claro', { skip: skipMedia }, () => withLayoutVideo(async ({ dir, file, info }) => {
  const a = await D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: 2 });
  assert.ok(a instanceof Uint8Array);
  assert.equal(a.length, D.THUMB_LEN);
  const b = await D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: 2 });
  assert.deepEqual([...a], [...b], 'mesmo instante, mesma miniatura');
  const later = await D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: info.segments[1].start + 2 });
  assert.notDeepEqual([...a], [...later]);
  // o cenário aparece onde deve: a câmera do jogo (canto superior esquerdo) tem bordas fortes que a conversa não tem ali
  const game = D.gradientMap(later);
  const talk = D.gradientMap(a);
  const corner = (g) => { let s = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 14; x++) s += g[y * W + x]; return s; };
  assert.ok(corner(game) > corner(talk) * 1.3, `canto da câmera: jogo ${corner(game).toFixed(1)} x conversa ${corner(talk).toFixed(1)}`);

  assert.equal(await D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: 9999 }), null, 'depois do fim não há quadro');
  await assert.rejects(D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: path.join(dir, 'sumiu.mp4'), timeSec: 1 }), (err) => err.code === 'INPUT_MISSING' && /não foi encontrado/.test(err.message));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: 1, signal: controller.signal }), (err) => err.code === 'CANCELLED');
  // o detector só LÊ o vídeo: nada novo ao lado dele
  assert.deepEqual(fs.readdirSync(dir), ['layouts.mp4']);
}));

test('detectCuts no vídeo sintético: cada corte recebe o layout do trecho; o trecho que não é nenhum dos dois fica incerto; progresso e cancelamento', { skip: skipMedia }, () => withLayoutVideo(async ({ file, info, seg }) => {
  const refs = await realRefs(file, info);
  const cuts = [
    { id: 'talk-a', start: seg(0).start + 1, end: seg(0).end - 1 },
    { id: 'game-a', start: seg(1).start + 1, end: seg(1).end - 1 },
    { id: 'talk-b', start: seg(2).start + 0.5, end: seg(2).end - 0.5 },
    { id: 'game-b', start: seg(3).start + 0.5, end: seg(3).end - 0.5 },
    { id: 'other', start: seg(4).start + 0.5, end: seg(4).end - 0.5 },
    { id: 'invalid', start: 5, end: 5 }
  ];
  const progress = [];
  const run = await D.detectCuts({ ffmpeg: tools.ffmpeg, sourcePath: file, cuts, refs, onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(run.ok, true, JSON.stringify(run.problems));
  const by = Object.fromEntries(run.results.map((r) => [r.cutId, r]));
  assert.equal(by['talk-a'].layout, 'conversa');
  assert.equal(by['game-a'].layout, 'jogo');
  assert.equal(by['talk-b'].layout, 'conversa');
  assert.equal(by['game-b'].layout, 'jogo');
  assert.equal(by.other.layout, null, 'a terceira cena não é nenhum dos dois');
  assert.equal(by.invalid.layout, null, 'corte sem duração: nada a olhar');
  assert.equal(by['talk-a'].samples.length, 3, 'três quadros por corte');
  assert.deepEqual(by['talk-a'].samples.map((s) => s.t), D.cutTimes(cuts[0]));
  assert.ok(by['talk-a'].confidence >= 0.66);
  assert.deepEqual(progress.map((p) => p[0]), [1, 2, 3, 4, 5, 6]);
  assert.ok(progress.every((p) => p[1] === 6));
  assert.equal(run.model.ok, true);
  assert.deepEqual(Object.keys(run.model.layouts), ['conversa', 'jogo']);

  // referências ruins: devolve o motivo e não lê nenhum quadro de corte
  const bad = await D.detectCuts({ ffmpeg: tools.ffmpeg, sourcePath: file, cuts, refs: { conversa: [refs.conversa[0]], jogo: refs.jogo } });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].code, 'FEW_REFS');

  // cancelar no meio: lança CANCELLED e não devolve resultado parcial
  const controller = new AbortController();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, start: 1 + (i % 20), end: 3 + (i % 20) }));
  const pending = D.detectCuts({ ffmpeg: tools.ffmpeg, sourcePath: file, cuts: many, refs, signal: controller.signal, onProgress: (done) => { if (done === 2) controller.abort(); } });
  await assert.rejects(pending, (err) => err.code === 'CANCELLED');
}));

// ---------- canais export:layoutRef e export:detectLayouts ----------

async function withIpc(fn) {
  const userData = fx.tmpDir('bf-detector-ud-');
  extraDirs.push(userData);
  return fn({ ...layoutVideo(), ...fx.setupExportIpc(userData) });
}

test('export:layoutRef devolve a miniatura em base64 do quadro pedido, com erro claro quando não há quadro ou vídeo', { skip: skipMedia }, () => withIpc(async ({ dir, file, call }) => {
  const res = await call('export:layoutRef', { sourcePath: file, timeSec: 3 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.thumb.length, 3072);
  assert.deepEqual([res.w, res.h, res.timeSec], [64, 36, 3]);
  assert.deepEqual([...D.thumbFromBase64(res.thumb)], [...await D.grabThumb({ ffmpeg: tools.ffmpeg, sourcePath: file, timeSec: 3 })]);
  assert.equal((await call('export:layoutRef', { sourcePath: file, timeSec: 9999 })).code, 'NO_FRAME');
  assert.equal((await call('export:layoutRef', { sourcePath: path.join(dir, 'sumiu.mp4'), timeSec: 1 })).code, 'INPUT_MISSING');
  assert.equal((await call('export:layoutRef', { sourcePath: '', timeSec: 1 })).code, 'INPUT_MISSING');
}));

test('export:detectLayouts: layout por corte com a chave que vale só para estas referências e este trecho; progresso por evento; erros claros', { skip: skipMedia }, () => withIpc(async ({ file, info, seg, call, sent }) => {
  const ref = async (t) => (await call('export:layoutRef', { sourcePath: file, timeSec: t })).thumb;
  const s = info.segments;
  const refs = { conversa: [await ref(s[0].start + 1.5), await ref(s[2].start + 3)], jogo: [await ref(s[1].start + 1.5), await ref(s[3].start + 3)] };
  const cuts = [
    { id: 'a', start: seg(2).start + 1, end: seg(2).end - 1 },
    { id: 'b', start: seg(3).start + 1, end: seg(3).end - 1 },
    { id: 'c', start: seg(4).start + 1, end: seg(4).end - 1 }
  ];
  const res = await call('export:detectLayouts', { sourcePath: file, cuts, refs });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.results.map((r) => [r.cutId, r.layout]), [['a', 'conversa'], ['b', 'jogo'], ['c', null]]);
  assert.equal(res.refsDigest, L.refsDigest(refs));
  assert.equal(res.model.ok, true);
  for (const r of res.results) {
    assert.equal(r.key, L.detectorKey({ refsDigest: L.refsDigest(refs), start: cuts.find((c) => c.id === r.cutId).start, end: cuts.find((c) => c.id === r.cutId).end }));
    assert.equal(r.samples.length, 3);
    assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
  }
  // o que a aba guarda no corte vale para as mesmas referências e o mesmo trecho (e para mais nada)
  const cutA = { ...cuts[0], layoutLocal: { layout: res.results[0].layout, confidence: res.results[0].confidence, key: res.results[0].key } };
  const keyFor = (digest) => (cut) => L.detectorKey({ refsDigest: digest, start: cut.start, end: cut.end });
  assert.equal(L.localState(cutA, keyFor(L.refsDigest(refs))), 'valid');
  assert.equal(L.localState(cutA, keyFor(L.refsDigest({ ...refs, jogo: [refs.jogo[0]] }))), 'stale');
  const progress = sent.filter(([channel]) => channel === 'export:detectProgress').map(([, p]) => p);
  assert.deepEqual(progress, [{ done: 1, total: 3 }, { done: 2, total: 3 }, { done: 3, total: 3 }]);

  // referências que não servem: BAD_REFS em português, com os motivos
  const few = await call('export:detectLayouts', { sourcePath: file, cuts, refs: { conversa: refs.conversa, jogo: [refs.jogo[0]] } });
  assert.deepEqual([few.ok, few.code], [false, 'BAD_REFS']);
  assert.match(few.message, /Jogo: escolha pelo menos 2 quadros de referência/);
  assert.equal(few.details.problems[0].code, 'FEW_REFS');
  // quadros inválidos são ignorados (não derrubam); pedido sem vídeo ou sem lista de cortes é recusado
  assert.equal((await call('export:detectLayouts', { sourcePath: file, cuts, refs: { conversa: ['lixo', 5, null], jogo: [] } })).code, 'BAD_REFS');
  assert.equal((await call('export:detectLayouts', { sourcePath: '', cuts, refs })).code, 'INVALID_ARGS');
  assert.equal((await call('export:detectLayouts', { sourcePath: file, cuts: 'x', refs })).code, 'INVALID_ARGS');
  assert.equal((await call('export:detectLayouts', { sourcePath: file, cuts, refs: null })).code, 'BAD_REFS');
}));

test('export:detectLayouts: pedir outra detecção (ou cancelar) interrompe a anterior com CANCELLED, sem resultado parcial', { skip: skipMedia }, () => withIpc(async ({ file, info, call, handlers }) => {
  const ref = async (t) => (await call('export:layoutRef', { sourcePath: file, timeSec: t })).thumb;
  const s = info.segments;
  const refs = { conversa: [await ref(s[0].start + 1.5), await ref(s[2].start + 3)], jogo: [await ref(s[1].start + 1.5), await ref(s[3].start + 3)] };
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, start: 1 + (i % 20), end: 3 + (i % 20) }));
  const first = call('export:detectLayouts', { sourcePath: file, cuts: many, refs });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const cancel = await call('export:detectCancel', {});
  assert.equal(cancel.ok, true);
  const res = await first;
  assert.deepEqual([res.ok, res.code], [false, 'CANCELLED']);
  assert.match(res.message, /cancelada/);
  // cancelar sem nada rodando não é erro
  assert.equal((await call('export:detectCancel', {})).ok, true);
  assert.ok(handlers.has('export:detectProgress') === false, 'o progresso é evento do main, não canal de pedido');
}));
