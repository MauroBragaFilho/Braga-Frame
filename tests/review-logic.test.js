'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core/review/core');
const order = require('../src/core/review/order');
const sim = require('../src/core/review/similarity');
const titles = require('../src/core/review/titles');
const batch = require('../src/core/review/batch');
const model = require('../src/core/projects/model');

const NOW = '2026-10-21T12:00:00.000Z';
const mk = (fields) => model.newCut({ title: 'x', ...fields }, { now: NOW });

// ---------- core: tempos ----------

test('clampRange limita ao vídeo e recusa corte menor que o mínimo', () => {
  assert.deepEqual(core.clampRange(-3, 10, { duration: 60 }), { start: 0, end: 10, valid: true, clamped: true, clampedEdges: ['start'] });
  assert.deepEqual(core.clampRange(50, 70, { duration: 60 }), { start: 50, end: 60, valid: true, clamped: true, clampedEdges: ['end'] });
  const tiny = core.clampRange(10, 10.1);
  assert.equal(tiny.valid, false);
  assert.match(tiny.reason, /pelo menos 0,2 s/);
  assert.equal(core.clampRange(NaN, 4).valid, false);
  assert.equal(core.clampRange(1.234, 5.678).start, 1.23, 'arredonda em centésimos');
});

test('clampRange com "edges": só a borda pedida é arredondada e limitada; a outra fica exatamente como está', () => {
  // fim além do vídeo (fonte atualizada): mexer só no início não "corrige" o fim em silêncio
  const outside = core.clampRange(69, 130, { duration: 100, edges: ['start'] });
  assert.deepEqual(outside, { start: 69, end: 130, valid: true, clamped: false, clampedEdges: [] });
  // a borda pedida é a única limitada, e a mensagem pode nomeá-la
  assert.deepEqual(core.clampRange(70, 135, { duration: 100, edges: ['end'] }), { start: 70, end: 100, valid: true, clamped: true, clampedEdges: ['end'] });
  assert.deepEqual(core.clampRange(-2, 130, { duration: 100, edges: ['start'] }), { start: 0, end: 130, valid: true, clamped: true, clampedEdges: ['start'] });
  // tempos com 3 casas: só a borda pedida vai para o centésimo
  assert.deepEqual(core.clampRange(11.123, 20.4567, { duration: 100, edges: ['start'] }), { start: 11.12, end: 20.4567, valid: true, clamped: false, clampedEdges: [] });
  // nada pedido: nada é tocado nem validado (deslocar 0/0)
  assert.deepEqual(core.clampRange(10.123, 20.4567, { edges: [] }), { start: 10.123, end: 20.4567, valid: true, clamped: false, clampedEdges: [] });
  // corte todo depois do vídeo e só o fim pedido: recusa com a causa em vez de empurrar o início para o fim do vídeo
  const gone = core.clampRange(200, 229, { duration: 100, edges: ['end'] });
  assert.equal(gone.valid, false);
  assert.match(gone.reason, /início do corte \(3:20\.0\) já está depois do fim do vídeo \(1:40\.0\)\. Ajuste o início primeiro/);
  assert.deepEqual([gone.start, gone.end], [200, 100], 'o início segue como estava');
  // sem "edges" vale o comportamento antigo: as duas bordas
  assert.deepEqual(core.clampRange(200, 229, { duration: 100 }).clampedEdges, ['end', 'start']);
});

test('adjustEdge: mexe só na borda pedida (a outra segue igual, mesmo fora do vídeo) e diz qual foi limitada', () => {
  const partlyOut = core.adjustEdge({ start: 70, end: 130 }, 'start', { delta: -1 }, { duration: 100 });
  assert.deepEqual([partlyOut.start, partlyOut.end, partlyOut.valid, partlyOut.clamped, partlyOut.clampedEdges], [69, 130, true, false, []]);
  const limited = core.adjustEdge({ start: 70, end: 130 }, 'end', { delta: 1 }, { duration: 100 });
  assert.deepEqual([limited.start, limited.end, limited.clamped, limited.clampedEdges], [70, 100, true, ['end']]);
  const crossing = core.adjustEdge({ start: 10, end: 20.4567 }, 'start', { delta: 50 }, { duration: 100 });
  assert.deepEqual([crossing.start, crossing.end, crossing.valid, crossing.clamped, crossing.clampedEdges], [20.25, 20.4567, true, true, ['start']], 'para no mínimo sem arredondar o fim');
  const rounding = core.adjustEdge({ start: 10.123, end: 20.4567 }, 'start', { delta: 1 }, { duration: 100 });
  assert.deepEqual([rounding.start, rounding.end], [11.12, 20.4567]);
  const gone = core.adjustEdge({ start: 200, end: 230 }, 'end', { delta: -1 }, { duration: 100 });
  assert.equal(gone.valid, false);
  assert.equal(gone.start, 200, 'recusa em vez de colapsar o corte para os 0,2 s finais do vídeo (e o início não é empurrado)');
});

test('adjustEdge: passos de 0,1 s sem erro de ponto flutuante e a borda para no limite', () => {
  let r = { start: 10, end: 20 };
  for (let i = 0; i < 7; i++) r = core.adjustEdge(r, 'start', { delta: 0.1 });
  assert.equal(r.start, 10.7);
  assert.equal(core.adjustEdge({ start: 10, end: 20 }, 'end', { delta: -1 }).end, 19);
  // início não passa do fim - mínimo: fica parado no limite e avisa
  const stop = core.adjustEdge({ start: 10, end: 10.5 }, 'start', { delta: 1 });
  assert.equal(stop.valid, true);
  assert.equal(stop.clamped, true);
  assert.equal(stop.start, 10.3);
  // início abaixo de zero
  const zero = core.adjustEdge({ start: 0.5, end: 5 }, 'start', { delta: -1 });
  assert.deepEqual([zero.start, zero.clamped], [0, true]);
  // fim além da duração
  const over = core.adjustEdge({ start: 5, end: 59.5 }, 'end', { delta: 1 }, { duration: 60 });
  assert.deepEqual([over.end, over.clamped], [60, true]);
  assert.equal(core.adjustEdge({ start: 1, end: 5 }, 'end', { value: 'abc' }).valid, false);
});

test('formatadores em pt-BR', () => {
  assert.equal(core.fmtTime(83.5), '1:23.5');
  assert.equal(core.fmtSeconds(32.7), '32,7 s');
  assert.equal(core.fmtSeconds(1), '1 s');
  assert.equal(core.fmtDelta(0.1), '+0,1 s');
  assert.equal(core.fmtDelta(-1), '-1 s');
  assert.equal(core.fmtDelta(0), '0 s');
  assert.equal(core.plural(1, 'corte', 'cortes'), '1 corte');
  assert.equal(core.plural(3, 'corte', 'cortes'), '3 cortes');
});

// ---------- core: campos e "alterado desde a revisão" ----------

test('applyFields: mudar o tempo incrementa a revisão; corte revisado ganha a faixa revisada e vira "alterado"', () => {
  const cut = mk({ start: 10, end: 20, status: 'approved' }); // aprovado antes desta função existir: sem reviewedRange
  assert.equal(core.reviewState(cut).changed, false, 'sem referência, não dá para dizer que mudou');
  const res = core.applyFields(cut, { start: 10.5 }, NOW);
  assert.deepEqual(res, { touched: true, timesChanged: true });
  assert.equal(cut.revision, 2);
  assert.deepEqual(cut.reviewedRange, [10, 20], 'guarda o tempo de quando foi revisado');
  const st = core.reviewState(cut);
  assert.deepEqual([st.reviewed, st.changed], [true, true]);
  // voltar ao tempo revisado limpa o aviso (a revisão continua subindo: o tempo "mudou" duas vezes)
  core.applyFields(cut, { start: 10 }, NOW);
  assert.equal(core.reviewState(cut).changed, false);
  assert.equal(cut.revision, 3);
});

test('applyFields: corte pendente não vira "alterado"; titleCustom nulo remove a marca', () => {
  const cut = mk({ start: 1, end: 5 });
  core.applyFields(cut, { end: 6 }, NOW);
  assert.equal(core.reviewState(cut).changed, false);
  assert.equal(cut.reviewedRange, undefined, 'pendente não ganha faixa revisada');
  core.applyFields(cut, { title: 'Meu', titleCustom: true }, NOW);
  assert.equal(cut.titleCustom, true);
  core.applyFields(cut, { titleCustom: null }, NOW);
  assert.equal('titleCustom' in cut, false);
});

test('snapshot/matches/fieldEq tratam null, undefined, números e listas', () => {
  const cut = mk({ start: 1, end: 5 });
  const snap = core.snapshot(cut, ['status', 'titleCustom', 'reviewedRange']);
  assert.deepEqual(snap, { status: 'pending', titleCustom: null, reviewedRange: null });
  assert.equal(core.matches(cut, { titleCustom: null, status: 'pending' }), true);
  assert.equal(core.fieldEq([1, 2], [1, 2.0000001]), true);
  assert.equal(core.fieldEq([1, 2], [1, 3]), false);
  assert.equal(core.fieldEq(undefined, null), true);
});

// ---------- ordenação e filtros ----------

const SET = () => [
  mk({ id: 'm1', title: 'Manual 1', start: 5, end: 9 }),
  mk({ id: 'a1', title: 'Auto baixa', start: 20, end: 30, origin: 'auto', relevance: 0.4 }),
  mk({ id: 'a2', title: 'Auto alta', start: 100, end: 110, origin: 'auto', relevance: 0.95 }),
  mk({ id: 'm2', title: 'Manual 2', start: 1, end: 3, status: 'approved', category: 'Clutch' }),
  mk({ id: 'a3', title: 'Auto média', start: 50, end: 60, origin: 'auto', relevance: 0.7, status: 'rejected' })
];

test('ordem cronológica é o padrão; relevância põe os sugeridos primeiro e os manuais no fim, em ordem cronológica', () => {
  const cuts = SET();
  assert.deepEqual(order.sortCuts(cuts).map((c) => c.id), ['m2', 'm1', 'a1', 'a3', 'a2']);
  assert.deepEqual(order.sortCuts(cuts, 'chrono').map((c) => c.id), ['m2', 'm1', 'a1', 'a3', 'a2']);
  assert.deepEqual(order.sortCuts(cuts, 'relevance').map((c) => c.id), ['a2', 'a3', 'a1', 'm2', 'm1']);
  assert.deepEqual(cuts.map((c) => c.id), ['m1', 'a1', 'a2', 'm2', 'a3'], 'não altera a lista original');
  assert.equal(order.normalizeSort('relevance'), 'relevance');
  assert.equal(order.normalizeSort('qualquer'), 'chrono');
  // empate de relevância desempata pelo tempo
  const tie = [mk({ id: 'z', start: 9, end: 12, relevance: 0.5 }), mk({ id: 'y', start: 2, end: 5, relevance: 0.5 })];
  assert.deepEqual(order.sortCuts(tie, 'relevance').map((c) => c.id), ['y', 'z']);
});

test('filtros: estado, categoria, origem, alterados e semelhantes', () => {
  const cuts = SET();
  const ids = (list) => list.map((c) => c.id).sort();
  assert.deepEqual(ids(order.filterCuts(cuts, { status: 'pending' })), ['a1', 'a2', 'm1']);
  assert.deepEqual(ids(order.filterCuts(cuts, { status: 'approved' })), ['m2']);
  assert.deepEqual(ids(order.filterCuts(cuts, { origin: 'auto' })), ['a1', 'a2', 'a3']);
  assert.deepEqual(ids(order.filterCuts(cuts, { origin: 'manual' })), ['m1', 'm2']);
  assert.deepEqual(ids(order.filterCuts(cuts, { category: 'Clutch' })), ['m2']);
  assert.deepEqual(ids(order.filterCuts(cuts, { category: order.NO_CATEGORY })), ['a1', 'a2', 'a3', 'm1']);
  assert.deepEqual(ids(order.filterCuts(cuts, { similar: true }, { similarIds: new Set(['a1', 'm1']) })), ['a1', 'm1']);
  const changed = cuts.find((c) => c.id === 'm2');
  core.applyFields(changed, { start: 2 }, NOW);
  assert.deepEqual(ids(order.filterCuts(cuts, { changed: true })), ['m2']);
  assert.deepEqual(ids(order.filterCuts(cuts, { status: 'approved', origin: 'auto' })), []);
  assert.deepEqual(order.categoriesIn(cuts), ['Clutch']);
  assert.deepEqual(order.countByStatus(cuts), { all: 5, pending: 3, approved: 1, rejected: 1 });
  assert.equal(order.activeExtraFilters({ status: 'pending' }), 0);
  assert.equal(order.activeExtraFilters({ origin: 'auto', changed: true }), 2);
});

// ---------- semelhança ----------

test('IoU, distância e título parecido', () => {
  const a = { start: 10, end: 20 };
  assert.equal(sim.iou(a, { start: 10, end: 20 }), 1);
  assert.ok(Math.abs(sim.iou(a, { start: 15, end: 25 }) - 5 / 15) < 1e-9);
  assert.equal(sim.iou(a, { start: 30, end: 40 }), 0);
  assert.equal(sim.gap(a, { start: 23, end: 30 }), 3);
  assert.equal(sim.gap(a, { start: 15, end: 30 }), 0);
  assert.ok(sim.titleSimilarity('Clutch incrível no Valorant', 'Clutch incrivel Valorant') >= 0.9, 'ignora acentos');
  assert.equal(sim.titleSimilarity('Corte 1', 'Corte 2'), 0, 'títulos padrão não contam');
  assert.equal(sim.titleSimilarity('Pico de áudio', 'Risada do chat'), 0);
});

test('comparePair: sobreposição forte, contido em outro, perto + título parecido e longe = não semelhante', () => {
  const base = mk({ id: 'a', title: 'Ace na final', start: 100, end: 120 });
  const overlap = mk({ id: 'b', title: 'Outro', start: 105, end: 125 }); // iou 15/25 = .6
  assert.match(sim.comparePair(base, overlap).reasons[0], /sobrepõem-se em 60%/);
  const inside = mk({ id: 'c', title: 'Dentro', start: 102, end: 106 }); // 100% do menor, mas IoU baixo (0,2)
  assert.deepEqual(sim.comparePair(base, inside).reasons, ['um cobre 100% do outro']);
  const touching = mk({ id: 'd', title: 'Ace final', start: 123, end: 130 }); // 3 s depois, título parecido
  const near = sim.comparePair(base, touching);
  assert.ok(near);
  assert.deepEqual(near.reasons, ['a 3 s de distância', 'títulos parecidos']);
  assert.equal(sim.comparePair(base, mk({ id: 'e', title: 'Risada', start: 123, end: 130 })), null, 'perto mas título diferente');
  assert.equal(sim.comparePair(base, mk({ id: 'f', title: 'Ace na final', start: 200, end: 210 })), null, 'título igual mas longe');
  assert.equal(sim.comparePair(mk({ start: 0, end: 10 }), mk({ start: 12, end: 20 })), null, 'títulos padrão: só a posição não basta');
});

test('sugestões vizinhas da análise ("Sugestão m:ss") não são "semelhantes" só por terem o mesmo título automático', () => {
  const a = mk({ id: 'a', title: 'Sugestão 0:10', start: 10, end: 30, origin: 'auto' });
  const b = mk({ id: 'b', title: 'Sugestão 0:34', start: 34, end: 55, origin: 'auto' }); // 4 s depois, momento distinto
  assert.equal(sim.titleSimilarity(a.title, b.title), 0, 'o título gerado não diz o que o corte é');
  assert.equal(sim.titleTokens('Sugestão 1:02:05').size, 0);
  assert.equal(sim.comparePair(a, b), null);
  // cadeia de sugestões coladas: continua sem virar um grupo só
  const chain = [a, b, mk({ id: 'c', title: 'Sugestão 0:58', start: 58, end: 80, origin: 'auto' }), mk({ id: 'd', title: 'Sugestão 1:23', start: 83, end: 100, origin: 'auto' })];
  assert.deepEqual(sim.findGroups(chain), []);
  // o que continua valendo: sobrepor de verdade agrupa mesmo com título automático, e título escrito pelo usuário parecido + perto agrupa
  assert.ok(sim.comparePair(a, mk({ id: 'e', title: 'Sugestão 0:15', start: 15, end: 35, origin: 'auto' })), 'sobreposição');
  assert.ok(sim.comparePair(mk({ id: 'f', title: 'Ace na final', start: 10, end: 20 }), mk({ id: 'g', title: 'Ace final', start: 23, end: 30 })), 'título do usuário parecido e perto');
});

test('findGroups: agrupa por transitividade, ordena e marca grupo resolvido', () => {
  const cuts = [
    mk({ id: 'a', title: 'A', start: 10, end: 20 }),
    mk({ id: 'b', title: 'B', start: 12, end: 22 }), // ~ a (iou 8/12)
    mk({ id: 'c', title: 'C', start: 22, end: 32 }), // encosta em b, mas sem sobreposição nem título parecido
    mk({ id: 'd', title: 'D', start: 200, end: 210 }),
    mk({ id: 'e', title: 'E', start: 202, end: 211 }) // ~ d
  ];
  const groups = sim.findGroups(cuts);
  assert.deepEqual(groups.map((g) => g.members), [['a', 'b'], ['d', 'e']]);
  assert.equal(groups[0].id, 'g-a');
  assert.deepEqual(groups[0].reasons, ['sobrepõem-se']);
  assert.equal(groups[0].resolved, false);
  const idx = sim.indexGroups(groups);
  assert.equal(idx.get('b').id, 'g-a');
  assert.equal(idx.has('c'), false);
  // com um deles rejeitado, o grupo está resolvido
  cuts[1].status = 'rejected';
  assert.equal(sim.findGroups(cuts)[0].resolved, true);
});

test('findGroups: A~B e B~C põem os três no mesmo grupo', () => {
  const cuts = [
    mk({ id: 'a', title: 'a', start: 0, end: 10 }),
    mk({ id: 'b', title: 'b', start: 4, end: 14 }), // iou 6/14 = .43
    mk({ id: 'c', title: 'c', start: 8, end: 18 }) // com b: iou .43; com a: 2/18
  ];
  const groups = sim.findGroups(cuts);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members, ['a', 'b', 'c']);
});

test('findGroups é rápido o bastante para uma live inteira (2000 cortes)', () => {
  const cuts = Array.from({ length: 2000 }, (_, i) => mk({ id: `c${i}`, title: `Corte ${i}`, start: i * 30, end: i * 30 + 20 }));
  const t = Date.now();
  const groups = sim.findGroups(cuts);
  assert.equal(groups.length, 0);
  assert.ok(Date.now() - t < 1500, 'varredura ordenada, sem comparar todos com todos');
});

test('bestToKeep prefere o já aprovado, depois a relevância, depois o mais longo; rejeitado por último', () => {
  const cuts = [
    mk({ id: 'a', start: 0, end: 10, relevance: 0.5 }),
    mk({ id: 'b', start: 2, end: 12, relevance: 0.9 }),
    mk({ id: 'c', start: 3, end: 20 })
  ];
  const byId = new Map(cuts.map((c) => [c.id, c]));
  const group = { members: ['a', 'b', 'c'] };
  assert.equal(sim.bestToKeep(group, byId), 'b', 'maior relevância');
  byId.get('a').status = 'approved'; // decisão do usuário vale mais que a relevância
  assert.equal(sim.bestToKeep(group, byId), 'a');
  byId.get('a').status = 'rejected';
  byId.get('b').status = 'rejected';
  assert.equal(sim.bestToKeep(group, byId), 'c', 'rejeitados só se não houver outro');
  const tie = new Map([['x', mk({ id: 'x', start: 0, end: 5 })], ['y', mk({ id: 'y', start: 1, end: 9 })]]);
  assert.equal(sim.bestToKeep({ members: ['x', 'y'] }, tie), 'y', 'sem relevância nem decisão, o mais longo');
  assert.equal(sim.bestToKeep({ members: ['z'] }, tie), null);
});

// ---------- títulos ----------

test('sugestões de título: locais, determinísticas, sem repetir o título atual', () => {
  const cut = mk({ id: 'a', title: 'Corte 4', start: 3725, end: 3750, category: 'clutch', reasons: ['pico de áudio', 'chat acelerou'], relevance: 0.9 });
  const out = titles.suggestTitles(cut, { game: 'Valorant', channel: 'Liz' });
  assert.deepEqual(out, [
    'Clutch em Valorant',
    'Pico de áudio em Valorant',
    'Clutch: pico de áudio',
    'Pico de áudio e chat acelerou',
    'Clutch aos 1:02:05'
  ]);
  assert.deepEqual(titles.suggestTitles(cut, { game: 'Valorant', channel: 'Liz' }), out, 'determinístico');
  // sem nenhum dado, ainda sugere algo útil
  const bare = mk({ title: 'Corte 1', start: 65, end: 80 });
  assert.deepEqual(titles.suggestTitles(bare), ['Momento da live aos 1:05']);
  // não repete o título atual nem sugestões já guardadas
  const taken = mk({ title: 'Momento da live aos 1:05', start: 65, end: 80 });
  assert.deepEqual(titles.suggestTitles(taken), []);
  const stored = mk({ title: 'X', titleSuggestions: ['Momento de Valorant aos 1:05'], start: 65, end: 80 });
  assert.deepEqual(titles.suggestTitles(stored, { game: 'Valorant' }), ['Momento da live aos 1:05']);
});

test('título personalizado nunca é sobrescrito: sugerir só devolve texto e guardar sugestões não troca o título', () => {
  const typed = mk({ title: 'Minha jogada favorita', titleCustom: true, start: 10, end: 20, category: 'Fail' });
  const before = JSON.stringify(typed);
  const fresh = titles.suggestTitles(typed, { game: 'CS2' });
  assert.ok(fresh.length > 0);
  assert.equal(JSON.stringify(typed), before, 'suggestTitles não muda o corte');
  const merged = titles.mergeSuggestions(typed.titleSuggestions, fresh);
  assert.equal(typed.title, 'Minha jogada favorita');
  assert.ok(merged.every((s) => s !== typed.title));
  assert.equal(titles.isCustomTitle(typed), true);
});

test('isCustomTitle: marca explícita vale; sem marca, só título padrão ou sugestão guardada é "automático"', () => {
  assert.equal(titles.isCustomTitle(mk({ title: 'Corte 3' })), false);
  assert.equal(titles.isCustomTitle(mk({ title: 'Clutch do ano' })), true, 'prudência: título desconhecido é tratado como do usuário');
  assert.equal(titles.isCustomTitle(mk({ title: 'Clutch do ano', titleSuggestions: ['clutch do ano'] })), false);
  assert.equal(titles.isCustomTitle(mk({ title: 'Qualquer', titleCustom: false })), false);
  assert.equal(titles.isCustomTitle(mk({ title: 'Corte 3', titleCustom: true })), true);
  // corte sugerido com título vindo da análise e nunca editado: automático; depois de mexer, vale a prudência
  const auto = mk({ title: 'Pico de áudio', origin: 'auto', relevance: 0.8 });
  assert.equal(auto.updatedAt, auto.createdAt);
  assert.equal(titles.isCustomTitle(auto), false);
  auto.updatedAt = '2026-10-22T00:00:00.000Z';
  assert.equal(titles.isCustomTitle(auto), true);
  assert.equal(titles.mergeSuggestions(['A', 'b'], ['B', 'C', ' ']).join('|'), 'A|b|C');
});

test('o título que a análise gera ("Sugestão m:ss") continua automático depois de aprovar/ajustar; o que o usuário digita não', () => {
  // exatamente como renderer/features/analysis.js cria o corte: origin 'auto', título "Sugestão <relógio>", sem titleCustom
  const fromAnalysis = (title) => mk({ title, start: 10, end: 30, origin: 'auto', relevance: 0.7, status: 'pending' });
  for (const title of ['Sugestão 0:10', 'Sugestão 12:05', 'Sugestão 1:02:05']) {
    const cut = fromAnalysis(title);
    assert.equal(titles.isDefaultTitle(title), true, title);
    assert.equal(titles.isCustomTitle(cut), false, `${title}: recém-criado`);
    core.applyFields(cut, batch.statusItem(cut, 'approved', '2026-10-22T00:00:00.000Z').after, '2026-10-22T00:00:00.000Z'); // aprovar mexe em updatedAt
    assert.notEqual(cut.updatedAt, cut.createdAt);
    assert.equal(titles.isCustomTitle(cut), false, `${title}: depois de aprovar continua automático`);
    core.applyFields(cut, { end: 31 }, '2026-10-22T00:00:01.000Z');
    assert.equal(titles.isCustomTitle(cut), false, `${title}: depois de ajustar o tempo também`);
  }
  // título de verdade do usuário continua protegido, parecido ou não com o padrão
  const typed = fromAnalysis('Sugestão do Zé');
  typed.updatedAt = '2026-10-22T00:00:00.000Z';
  assert.equal(titles.isCustomTitle(typed), true);
  assert.equal(titles.isCustomTitle(Object.assign(fromAnalysis('Sugestão 0:10'), { titleCustom: true })), true, 'a marca explícita vale mais que o padrão');
});

// ---------- lote: planos e prévia ----------

test('planBatch aprovar: prévia antes -> depois, sem alterar nada, itens já aprovados ficam "sem mudança"', () => {
  const cuts = SET();
  const snapshot = JSON.stringify(cuts);
  const plan = batch.planBatch({ cuts, ids: ['m1', 'a1', 'm2'], op: 'approve', now: NOW });
  assert.equal(JSON.stringify(cuts), snapshot, 'planejar não altera os cortes');
  assert.equal(plan.label, 'Aprovar 3 cortes');
  assert.equal(plan.historyLabel, 'Aprovou 3 cortes');
  assert.deepEqual(plan.items.map((i) => i.cutId), ['m2', 'm1', 'a1'], 'ordem cronológica');
  assert.deepEqual(plan.counts, { total: 3, changed: 2, unchanged: 1, invalid: 0 });
  const [done, one] = plan.items;
  assert.equal(done.changed, false);
  assert.equal(done.note, 'já está assim');
  assert.deepEqual(batch.describe(one), { from: 'Pendente', to: 'Aprovado' });
  assert.deepEqual(one.after, { status: 'approved', reviewedAt: NOW, reviewedRange: [5, 9] });
});

test('prévia do lote: "reconfirmado" só no corte "alterado" que de fato será recarimbado; o que já está assim diz "sem mudança"', () => {
  const cuts = [
    mk({ id: 'ok', title: 'Já aprovado', start: 10, end: 20, status: 'approved', reviewedRange: [10, 20] }),
    mk({ id: 'alt', title: 'Aprovado e alterado', start: 30, end: 41, status: 'approved', reviewedRange: [30, 40] }),
    mk({ id: 'pen', title: 'Pendente', start: 50, end: 60 })
  ];
  const plan = batch.planBatch({ cuts, ids: ['ok', 'alt', 'pen'], op: 'approve', now: NOW });
  const byId = Object.fromEntries(plan.items.map((i) => [i.cutId, i]));
  assert.deepEqual([byId.ok.changed, byId.ok.note], [false, 'já está assim']);
  assert.deepEqual(batch.describe(byId.ok), { from: 'Aprovado', to: 'Aprovado (sem mudança)' });
  assert.equal(byId.alt.changed, true);
  assert.deepEqual(batch.describe(byId.alt), { from: 'Aprovado', to: 'Aprovado (reconfirmado)' });
  assert.deepEqual(batch.describe(byId.pen), { from: 'Pendente', to: 'Aprovado' });
  assert.deepEqual(plan.counts, { total: 3, changed: 2, unchanged: 1, invalid: 0 });
  // redefinir e rejeitar seguem a mesma regra
  const reset = batch.planBatch({ cuts, ids: ['pen'], op: 'reset', now: NOW });
  assert.deepEqual(batch.describe(reset.items[0]), { from: 'Pendente', to: 'Pendente (sem mudança)' });
});

test('deslocar em lote mexe só na borda deslocada: 0/0 não muda nada e a outra borda não é arredondada nem cortada ao vídeo', () => {
  const fine = mk({ id: 'f', title: 'f', start: 10.123, end: 20.4567, status: 'approved', reviewedRange: [10.123, 20.4567] });
  const none = batch.planBatch({ cuts: [fine], ids: ['f'], op: 'shift', params: { startDelta: 0, endDelta: 0 }, duration: 100 });
  assert.deepEqual(none.counts, { total: 1, changed: 0, unchanged: 1, invalid: 0 });
  assert.equal(none.items[0].note, 'sem mudança');
  // só o início: o fim, com 4 casas, fica como está
  const startOnly = batch.planBatch({ cuts: [fine], ids: ['f'], op: 'shift', params: { startDelta: 1, endDelta: 0 }, duration: 100 });
  assert.deepEqual(startOnly.items[0].after, { start: 11.12, end: 20.4567 });
  // corte que passa do fim do vídeo (fonte atualizada): deslocar o início não leva o fim para a duração
  const outside = mk({ id: 'o', title: 'o', start: 70, end: 130 });
  const shifted = batch.planBatch({ cuts: [outside], ids: ['o'], op: 'shift', params: { startDelta: -1, endDelta: 0 }, duration: 100 });
  assert.deepEqual(shifted.items[0].after, { start: 69, end: 130 });
  assert.equal(shifted.items[0].note, '', 'sem aviso de "limitado": nada foi limitado');
  // as duas bordas continuam sendo limitadas ao vídeo
  const both = batch.planBatch({ cuts: [outside], ids: ['o'], op: 'shift', params: { startDelta: 1, endDelta: 1 }, duration: 100 });
  assert.deepEqual(both.items[0].after, { start: 71, end: 100 });
  assert.match(both.items[0].note, /limitado aos limites do vídeo/);
});

test('exportState: a exportação só vale para o corte de agora se o início e o fim batem', () => {
  const exp = (path, start, end, revision) => ({ path, at: NOW, start, end, profile: 'vertical-1080-h264', jobId: path, key: path, revision });
  assert.deepEqual(core.exportState(mk({ start: 10, end: 20 })), { last: null, stale: false });
  const cut = mk({ start: 10, end: 20, exports: [exp('a.mp4', 10, 20, 1)] });
  assert.deepEqual(core.exportState(cut), { last: cut.exports[0], stale: false });
  core.applyFields(cut, { end: 25 }, NOW); // mudou depois de exportar
  const stale = core.exportState(cut);
  assert.equal(stale.stale, true);
  assert.equal(stale.last.path, 'a.mp4');
  core.applyFields(cut, { end: 20 }, NOW); // voltou ao tempo exportado (ex.: desfazer): vale de novo, mesmo com a revisão tendo subido
  assert.equal(cut.revision, 3);
  assert.equal(core.exportState(cut).stale, false);
  // duas exportações: a mais recente que bate é a mostrada; se nenhuma bate, a última, defasada
  cut.exports.push(exp('b.mp4', 10, 30, 3));
  assert.deepEqual([core.exportState(cut).last.path, core.exportState(cut).stale], ['a.mp4', false]);
  core.applyFields(cut, { end: 40 }, NOW);
  assert.deepEqual([core.exportState(cut).last.path, core.exportState(cut).stale], ['b.mp4', true]);
  // sem os tempos gravados, vale a revisão; sem nada para comparar, não acusa
  assert.equal(core.exportState(mk({ start: 1, end: 5, revision: 2, exports: [{ path: 'x.mp4', revision: 1 }] })).stale, true);
  assert.equal(core.exportState(mk({ start: 1, end: 5, revision: 2, exports: [{ path: 'x.mp4', revision: 2 }] })).stale, false);
  assert.equal(core.exportState(mk({ start: 1, end: 5, exports: [{ path: 'x.mp4' }] })).stale, false);
  assert.equal(core.exportState(mk({ start: 1, end: 5, exports: [null, { at: NOW }] })).last, null, 'entrada sem caminho é ignorada');
});

test('planBatch rejeitar/redefinir/categorizar/remover', () => {
  const cuts = SET();
  const rej = batch.planBatch({ cuts, ids: ['m2'], op: 'reject', now: NOW });
  assert.deepEqual(batch.describe(rej.items[0]), { from: 'Aprovado', to: 'Rejeitado' });
  const reset = batch.planBatch({ cuts, ids: ['m2', 'a3'], op: 'reset', now: NOW });
  assert.deepEqual(reset.items.map((i) => i.after), [
    { status: 'pending', reviewedAt: null, reviewedRange: null },
    { status: 'pending', reviewedAt: null, reviewedRange: null }
  ]);
  const cat = batch.planBatch({ cuts, ids: ['m1', 'm2'], op: 'categorize', params: { category: '  Engraçado   demais ' } });
  assert.equal(cat.label, 'Categorizar 2 cortes como “Engraçado demais”');
  assert.deepEqual(batch.describe(cat.items[1]), { from: 'sem categoria', to: 'Engraçado demais' });
  assert.equal(cat.counts.changed, 2);
  const clear = batch.planBatch({ cuts, ids: ['m2'], op: 'categorize', params: { category: '' } });
  assert.equal(clear.label, 'Limpar a categoria de 1 corte');
  assert.deepEqual(batch.describe(clear.items[0]), { from: 'Clutch', to: 'sem categoria' });
  const rm = batch.planBatch({ cuts, ids: ['m1'], op: 'remove' });
  assert.equal(rm.items[0].type, 'remove');
  assert.equal(rm.items[0].cut.id, 'm1', 'guarda a cópia completa para poder desfazer');
  assert.equal(batch.describe(rm.items[0]).to, 'removido');
  assert.throws(() => batch.planBatch({ cuts, ids: ['m1'], op: 'explodir' }), /desconhecida/);
  assert.match(batch.planBatch({ cuts, ids: [], op: 'approve' }).error, /Nenhum corte/);
});

test('planBatch deslocar: limita ao vídeo, recusa o que ficaria inválido e avisa quando o corte já estava revisado', () => {
  const cuts = [
    mk({ id: 'p', title: 'p', start: 10, end: 20 }),
    mk({ id: 'r', title: 'r', start: 30, end: 40, status: 'approved' }),
    mk({ id: 'e', title: 'e', start: 58, end: 59.5 })
  ];
  const plan = batch.planBatch({ cuts, ids: ['p', 'r', 'e'], op: 'shift', params: { startDelta: 0.5, endDelta: 1 }, duration: 60 });
  assert.equal(plan.label, 'Deslocar tempos de 3 cortes (início +0,5 s, fim +1 s)');
  const byId = Object.fromEntries(plan.items.map((i) => [i.cutId, i]));
  assert.deepEqual(byId.p.after, { start: 10.5, end: 21 });
  assert.deepEqual(batch.describe(byId.p), { from: '0:10.0 – 0:20.0', to: '0:10.5 – 0:21.0' });
  assert.match(byId.r.note, /alterado desde a revisão/);
  assert.deepEqual(byId.e.after, { start: 58.5, end: 60 });
  assert.match(byId.e.note, /limitado aos limites do vídeo/);
  // deslocar demais deixa o corte inválido (não bloqueia os outros)
  const bad = batch.planBatch({ cuts, ids: ['p', 'e'], op: 'shift', params: { startDelta: 5, endDelta: -5 }, duration: 60 });
  assert.equal(bad.counts.invalid, 2);
  assert.equal(bad.counts.changed, 0);
  assert.match(bad.items[0].note, /pelo menos 0,2 s/);
  assert.match(batch.planBatch({ cuts, ids: ['p'], op: 'shift', params: { startDelta: 'abc' } }).error, /números/);
  assert.equal(batch.planBatch({ cuts, ids: ['p'], op: 'shift', params: { startDelta: 0, endDelta: 0 } }).counts.changed, 0);
});

test('planBatch manter um: rejeita os demais; o mantido só é aprovado se pedido', () => {
  const cuts = [
    mk({ id: 'a', title: 'a', start: 10, end: 20 }),
    mk({ id: 'b', title: 'b', start: 12, end: 22 }),
    mk({ id: 'c', title: 'c', start: 13, end: 23, status: 'rejected' })
  ];
  const plan = batch.planBatch({ cuts, ids: ['a', 'b', 'c'], op: 'keepOne', params: { keepId: 'b' }, now: NOW });
  assert.deepEqual(plan.items.map((i) => [i.cutId, i.type, i.changed]), [['a', 'reject', true], ['b', 'keep', false], ['c', 'reject', false]]);
  assert.deepEqual(batch.describe(plan.items[1]), { from: 'mantido', to: 'mantido' });
  const approve = batch.planBatch({ cuts, ids: ['a', 'b', 'c'], op: 'keepOne', params: { keepId: 'b', approveKept: true }, now: NOW });
  assert.deepEqual(approve.items.map((i) => [i.cutId, i.type]), [['a', 'reject'], ['b', 'approve'], ['c', 'reject']]);
  assert.match(batch.planBatch({ cuts, ids: ['a', 'b'], op: 'keepOne', params: {} }).error, /qual corte manter/);
});

test('aprovar de novo um corte "alterado" reconfirma a revisão (e aparece como mudança)', () => {
  const cut = mk({ id: 'a', title: 'a', start: 10, end: 20 });
  core.applyFields(cut, batch.statusItem(cut, 'approved', NOW).after, NOW);
  core.applyFields(cut, { end: 21 }, NOW);
  assert.equal(core.reviewState(cut).changed, true);
  const item = batch.statusItem(cut, 'approved', NOW);
  assert.equal(item.changed, true);
  assert.match(item.note, /reconfirma/);
  assert.deepEqual(batch.describe(item), { from: 'Aprovado', to: 'Aprovado (reconfirmado)' });
  core.applyFields(cut, item.after, NOW);
  assert.equal(core.reviewState(cut).changed, false);
});

test('titleItem: título vazio é inválido; sugestão aplicada tira a marca de personalizado', () => {
  const cut = mk({ id: 'a', title: 'Meu título', titleCustom: true });
  const empty = batch.titleItem(cut, '   ');
  assert.equal(empty.invalid, true);
  assert.equal(empty.changed, false);
  const fromSuggestion = batch.titleItem(cut, 'Clutch em Valorant', { custom: false });
  assert.deepEqual(fromSuggestion.after, { title: 'Clutch em Valorant', titleCustom: false });
  assert.deepEqual(fromSuggestion.before, { title: 'Meu título', titleCustom: true });
  assert.equal(batch.titleItem(cut, 'Meu título').changed, false, 'igual ao atual e já personalizado');
});
