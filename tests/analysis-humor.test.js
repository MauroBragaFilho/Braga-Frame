'use strict';

/**
 * PERFIL DE HUMOR DO CANAL, lado do ALGORITMO (src/core/analysis/humor.js, textSignal.js, params.js e a preferência `analysis.humor`):
 *   - o perfil guardado é sempre limpo e dentro dos limites, venha de onde vier (tela, preferência editada à mão, IPC);
 *   - os BORDÕES viram uma pista do texto ("expressão do canal") e as PALAVRAS DE REAÇÃO entram na exclamação;
 *   - a busca ignora acento, caixa e pontuação, só casa palavra inteira e a expressão mais longa vence;
 *   - o bordão que o canal diz o tempo todo vale menos a cada vez; sem perfil nada muda.
 * Funções puras sobre falas sintéticas com horários conhecidos (nada de mock do que está sendo testado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const humor = require('../src/core/analysis/humor');
const params = require('../src/core/analysis/params');
const keys = require('../src/core/preferences/keys');
const { scoreText, extractEvents } = require('../src/core/analysis/textSignal');

const TH = params.thresholds(3);
const cue = (start, end, text, extra = {}) => ({ start, end, text, ...extra });
const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
const lists = (value) => humor.normalizeAlgorithmLists(value);

/** Conversa normal: uma fala de 8 palavras a cada 6 s, sem exclamação nem repetição (nenhuma pista dispara). */
function calm(seconds, { from = 0 } = {}) {
  const out = [];
  const filler = ['hoje a gente vai explorar essa região do mapa', 'preciso encontrar uns materiais para construir a base', 'depois eu volto aqui para conferir o que sobrou',
    'acho que o servidor está mais estável do que ontem', 'vou testar essa ferramenta nova que eu consegui agora', 'amanhã eu penso em como organizar o baú todo'];
  for (let t = from, i = 0; t < from + seconds; t += 6, i += 1) out.push(cue(t, t + 5, `${filler[i % filler.length]} ${i}`));
  return out;
}

// ---------- o perfil (humor.js) ----------

test('normalizeProfile: limpa o texto, separa as listas por vírgula, ponto e vírgula e linha, tira repetidos (sem diferenciar acento nem caixa)', () => {
  const p = humor.normalizeProfile({
    criteria: '  Humor seco,\r\n\r\n\r\n\r\ncom   timing\u0007 ',
    catchphrases: 'Bora, BORA; Beco moleque\n  \nnão acredito\nNAO ACREDITO',
    reactions: ['Eita', ' eita ', 'EITA!', '', 7, null, 'tenso'],
    examples: false
  });
  assert.equal(p.criteria, 'Humor seco,\n\ncom timing', 'parágrafos preservados, espaços e caracteres de controle fora');
  assert.deepEqual(p.catchphrases, ['Bora', 'Beco moleque', 'não acredito'], 'a primeira grafia fica; "NAO ACREDITO" é o mesmo bordão');
  assert.deepEqual(p.reactions, ['Eita', 'tenso'], 'item que não é texto e item vazio saem');
  assert.equal(p.examples, false);
  assert.equal(humor.normalizeProfile({ criteria: 'x' }).examples, true, 'exemplos ligados por padrão');
  assert.equal(humor.listText(p.catchphrases), 'Bora, Beco moleque, não acredito');
  assert.equal(humor.listText(null), '');
});

test('normalizeProfile: respeita os limites (texto, quantidade e tamanho dos itens) e nunca lança com lixo', () => {
  const big = humor.normalizeProfile({
    criteria: 'a'.repeat(5000),
    catchphrases: Array.from({ length: 80 }, (_, i) => `bordão número ${i}`),
    reactions: ['x'.repeat(200), 'y']
  });
  assert.equal(big.criteria.length, humor.LIMITS.criteria);
  assert.equal(big.catchphrases.length, humor.LIMITS.items);
  assert.equal(big.reactions[0].length, humor.LIMITS.itemLength);
  const empty = { criteria: '', catchphrases: [], reactions: [], themes: [], examples: true };
  for (const garbage of [undefined, null, 5, 'texto', [], [1, 2], () => 1, true]) assert.deepEqual(humor.normalizeProfile(garbage), empty, String(garbage));
  assert.deepEqual(humor.normalizeProfile({ criteria: 7, catchphrases: { a: 1 }, reactions: 9, examples: 'não' }), empty, 'tipos errados viram vazio (só o `false` desliga os exemplos)');
});

test('isEmpty: sem critério, bordão nem palavra o perfil não diz nada (os exemplos sozinhos não contam)', () => {
  assert.equal(humor.isEmpty(null), true);
  assert.equal(humor.isEmpty({ examples: false }), true);
  assert.equal(humor.isEmpty({ criteria: '   ' }), true);
  assert.equal(humor.isEmpty({ criteria: 'x' }), false);
  assert.equal(humor.isEmpty({ catchphrases: ['bora'] }), false);
  assert.equal(humor.isEmpty({ reactions: 'eita' }), false);
});

test('listas do algoritmo: minúsculas, com o acento (para o motivo ficar legível), sem repetidos, em ordem estável e só os 40 primeiros', () => {
  assert.deepEqual(
    lists({ phrases: ['Não acredito', 'nao ACREDITO', 'Bora!', 'beco moleque'], reactions: 'Eita; tenso, EITA' }),
    { phrases: ['beco moleque', 'bora!', 'não acredito'], reactions: ['eita', 'tenso'] }
  );
  const same = lists({ phrases: ['b', 'a', 'c'] });
  assert.deepEqual(lists({ phrases: ['c', 'a', 'b'] }), same, 'a ordem dada não muda o resultado (chave de cache estável)');
  const forty = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`);
  const cut = lists({ phrases: [...forty, 'aaa'] });
  assert.equal(cut.phrases.length, 40);
  assert.ok(!cut.phrases.includes('aaa'), 'o limite vale para os primeiros itens, antes de ordenar');
  for (const garbage of [undefined, null, 'x', [], 5]) assert.deepEqual(lists(garbage), { phrases: [], reactions: [] }, String(garbage));
  // do perfil guardado para o algoritmo: o mesmo que normalizar as listas à mão
  const profile = humor.normalizeProfile({ catchphrases: 'Bora; Não acredito', reactions: 'Eita' });
  assert.deepEqual(humor.forAlgorithm(profile), lists({ phrases: ['Bora', 'Não acredito'], reactions: ['Eita'] }));
  assert.deepEqual(lists(humor.forAlgorithm(profile)), humor.forAlgorithm(profile), 'idempotente');
});

test('normalizeParams: o perfil do canal é validado (lixo vira vazio) e tem peso próprio de 0 a 2', () => {
  const d = params.normalizeParams(undefined);
  assert.deepEqual(d.humor, { phrases: [], reactions: [] });
  assert.equal(d.textWeights.humor, 1);
  assert.ok(params.TEXT_FEATURES.includes('humor'));
  const p = params.normalizeParams({ humor: { phrases: ['Bora', 'bora', 7, 'x'.repeat(100)], reactions: 'Eita, tenso' }, textWeights: { humor: 9 } });
  assert.deepEqual(p.humor.phrases, ['bora', 'x'.repeat(humor.LIMITS.itemLength)]);
  assert.deepEqual(p.humor.reactions, ['eita', 'tenso']);
  assert.equal(p.textWeights.humor, 2);
  for (const garbage of ['texto', 5, [], { phrases: 5 }, null]) assert.deepEqual(params.normalizeParams({ humor: garbage }).humor, { phrases: [], reactions: [] }, String(garbage));
  // o perfil entra na chave de cache do resultado (sem ele o resultado antigo valeria para outro perfil)
  const a = params.sha1(params.canonicalJson(params.normalizeParams({ humor: { phrases: ['bora'] } })));
  const b = params.sha1(params.canonicalJson(params.normalizeParams({ humor: { phrases: ['bora', 'eita'] } })));
  const none = params.sha1(params.canonicalJson(params.normalizeParams({})));
  assert.equal(new Set([a, b, none]).size, 3);
});

test('preferência analysis.humor: guarda o perfil já limpo, recusa o vazio e o tamanho absurdo, e a tela mostra de onde ele vem', () => {
  const def = keys.findDef('analysis.humor');
  assert.ok(def && def.type === 'object' && def.default === null && def.advanced === true);
  const ok = keys.validate(def, { criteria: '  Humor seco \n\n\n\ncom timing', catchphrases: 'a, b; c\nA', reactions: ['x'], examples: false, lixo: 'fora' });
  assert.deepEqual(ok, { ok: true, value: { criteria: 'Humor seco\n\ncom timing', catchphrases: ['a', 'b', 'c'], reactions: ['x'], themes: [], examples: false } });
  assert.equal(keys.validate(def, { criteria: '', catchphrases: [], reactions: [], examples: false }).ok, false, 'perfil vazio: o caminho é remover a preferência');
  assert.equal(keys.validate(def, 'texto').ok, false);
  assert.equal(keys.validate(def, ['a']).ok, false);
  const maxed = keys.validate(def, { criteria: '"'.repeat(5000), catchphrases: Array.from({ length: 80 }, (_, i) => `"${i}"`.repeat(10)), reactions: ['"'.repeat(200)] });
  assert.equal(maxed.ok, true, 'o pior caso (aspas escapadas no JSON) cabe no limite da preferência');
  assert.ok(JSON.stringify(maxed.value).length <= def.maxLength);
  assert.equal(keys.formatValue(def, ok.value), 'definido na aba Análise');
  assert.equal(keys.formatValue(def, null), 'padrão do app');
});

// ---------- o algoritmo (textSignal.js) ----------

test('bordão do canal: casa palavra inteira, sem diferenciar acento, caixa e pontuação, e a expressão mais longa vence', () => {
  const profile = lists({ phrases: ['não acredito', 'Beco Moleque', 'eita', 'puta que pariu', 'puta'] });
  const cues = [
    cue(10, 12, 'NAO ACREDITO, cara'), // acento e caixa
    cue(20, 22, 'Beco, moleque!'), // pontuação no meio
    cue(30, 32, 'receita de bolo'), // "eita" dentro de outra palavra não vale
    cue(40, 42, 'Puta que pariu!'), // vence "puta": conta uma vez, não duas
    cue(50, 52, 'Puta merda') // só "puta"
  ];
  const ev = extractEvents(cues, 100, profile);
  assert.deepEqual([10, 20, 30, 40, 50].map((s) => ev.humor[s]), [1, 1, 0, 1, 1]);
  assert.deepEqual(ev.humorHits.map((h) => [h.sec, h.label]), [[10, 'não acredito'], [20, 'beco moleque'], [40, 'puta que pariu'], [50, 'puta']], 'o motivo mostra o texto como o usuário escreveu');
  // sem perfil (ou com listas vazias) a pista não existe
  for (const none of [undefined, null, {}, { phrases: [], reactions: [] }, { phrases: 'texto', reactions: 5 }]) {
    const e = extractEvents(cues, 100, none);
    assert.equal(sum(e.humor), 0, JSON.stringify(none));
    assert.deepEqual(e.humorHits, []);
  }
});

test('uma fala vale no máximo duas vezes o bordão (repetir o bordão na mesma fala não infla), e o texto do bordão pode ter regex no meio', () => {
  const ev = extractEvents([cue(10, 15, 'bora bora bora bora bora bora')], 40, lists({ phrases: ['bora'] }));
  assert.equal(ev.humor[10], 2);
  assert.equal(ev.humorHits.length, 6, 'os seis aparecem como ocorrências, mas a fala vale 2');
  // caracteres especiais de regex viram letras comuns (dobrados na normalização) e nunca quebram a análise
  const odd = lists({ phrases: ['(a+', 'c++ é bom?', '[x]', '.*', '\\d'] });
  assert.doesNotThrow(() => extractEvents([cue(1, 3, 'a c++ e bom x d texto')], 20, odd));
});

test('palavras de reação do canal entram na exclamação, com o mesmo peso das da lista do app', () => {
  const profile = lists({ reactions: ['sinistro', 'Tenso'] });
  const cues = [cue(10, 12, 'sinistro'), cue(20, 22, 'Nossa'), cue(30, 33, 'tenso demais'), cue(40, 43, 'Sinistro!'), cue(50, 52, 'tensor de matriz')];
  const ev = extractEvents(cues, 80, profile);
  assert.equal(ev.exclaim[10], 0.75, 'reação do canal vale como as do app');
  assert.equal(ev.exclaim[20], 0.75, 'as do app continuam valendo');
  assert.equal(ev.exclaim[30], 0.75, 'sem diferenciar caixa');
  assert.equal(ev.exclaim[40], 1.5, 'reação + "!" fica no teto de 1,5');
  assert.equal(ev.exclaim[50], 0, 'só palavra inteira');
  const plain = extractEvents(cues, 80);
  assert.equal(plain.exclaim[10], 0, 'sem o perfil "sinistro" não é pista');
  assert.equal(plain.exclaim[20], 0.75);
  assert.equal(sum(ev.humor), 0, 'reação não é bordão: não vira "expressão do canal"');
});

test('bordão dito em muitas falas vale menos a cada vez: o canal que o repete o tempo todo não enche a lista', () => {
  const profile = lists({ phrases: ['bora'] });
  const few = [];
  for (let i = 0; i < 4; i += 1) few.push(cue(10 + i * 30, 12 + i * 30, 'bora lá'));
  const evFew = extractEvents(few, 200, profile);
  assert.equal(sum(evFew.humor), 4, 'poucas falas: cada uma vale 1');
  const many = [];
  for (let i = 0; i < 60; i += 1) many.push(cue(i * 6, i * 6 + 2, 'bora lá'));
  const evMany = extractEvents(many, 400, profile);
  const unit = evMany.humor[0];
  assert.ok(unit > 0 && unit < 0.2, `cada vez vale bem menos (${unit})`);
  assert.ok(Math.abs(sum(evMany.humor) - 6) < 1e-9, 'o total de uma expressão comum nunca passa do limite (6 falas ou 1% delas)');
  const hundreds = [];
  for (let i = 0; i < 1000; i += 1) hundreds.push(cue(i * 6, i * 6 + 2, i % 2 ? 'bora lá' : 'e aí pessoal'));
  assert.ok(Math.abs(sum(extractEvents(hundreds, 6100, profile).humor) - 10) < 1e-9, 'em 1000 falas o limite é 10 (1%)');
  // as palavras de reação do canal seguem a mesma regra
  const evReact = extractEvents(many, 400, lists({ reactions: ['bora'] }));
  assert.ok(evReact.exclaim[0] > 0 && evReact.exclaim[0] < 0.1, `${evReact.exclaim[0]}`);
});

test('scoreText: o bordão do canal sobe a pontuação do segundo e o motivo diz qual foi; fora dele nada muda; sem perfil nada muda', () => {
  const cues = [...calm(300), cue(300, 302, 'Beco moleque'), ...calm(300, { from: 306 })];
  const n = 620;
  const profile = lists({ phrases: ['beco moleque'] });
  const base = scoreText({ cues }, { n, th: TH });
  const withProfile = scoreText({ cues }, { n, th: TH, humor: profile });
  assert.ok(base.score[301] < 0.2, `a fala calma não pontua (${base.score[301]})`);
  assert.ok(withProfile.score[301] > 0.6, `o bordão pontua (${withProfile.score[301]})`);
  assert.ok(withProfile.parts.humor[301] > 0.6 && withProfile.parts.humor[301] < 0.97);
  assert.ok(withProfile.parts.humor[290] === 0 && withProfile.parts.humor[320] === 0, 'só na janela de ~17 s ao redor');
  assert.equal(withProfile.score[100], base.score[100], 'longe do bordão a pontuação é a mesma');
  assert.equal(withProfile.stats.humorHits, 1);
  const why = withProfile.describe(295, 310);
  assert.ok(why.some((r) => r.text === 'expressão do canal: “beco moleque”' && r.strength > 0.6), JSON.stringify(why));
  assert.deepEqual(base.describe(295, 310).filter((r) => /canal/.test(r.text)), []);
  // listas vazias = sem perfil, bit a bit
  const empty = scoreText({ cues }, { n, th: TH, humor: { phrases: [], reactions: [] } });
  assert.deepEqual(Array.from(empty.score), Array.from(base.score));
  // dois bordões diferentes na mesma janela: os dois aparecem no motivo, o mais dito primeiro
  const two = scoreText({ cues: [...cues, cue(304, 306, 'bora bora'), cue(307, 309, 'Beco moleque')] }, { n, th: TH, humor: lists({ phrases: ['beco moleque', 'bora bora'] }) });
  assert.ok(two.describe(295, 312).some((r) => r.text === 'expressões do canal: “beco moleque”, “bora bora”'), JSON.stringify(two.describe(295, 312)));
  // dois bordões em ~17 s chegam perto do teto de uma pista
  assert.ok(two.parts.humor[305] > 0.9, `${two.parts.humor[305]}`);
});

test('scoreText: o peso da pista "expressões do canal" vai de 0 (desliga) a 2 e vale para o motivo também', () => {
  const cues = [...calm(300), cue(300, 302, 'Beco moleque'), ...calm(300, { from: 306 })];
  const profile = lists({ phrases: ['beco moleque'] });
  const run = (textWeights) => scoreText({ cues }, { n: 620, th: TH, humor: profile, textWeights });
  const normal = run({});
  const off = run({ humor: 0 });
  const double = run({ humor: 2 });
  const base = scoreText({ cues }, { n: 620, th: TH });
  assert.equal(off.score[301], base.score[301], 'peso 0 desliga a pista');
  assert.equal(off.describe(295, 310).find((r) => /canal/.test(r.text)).strength, 0, 'e a força do motivo vai a 0');
  assert.ok(double.score[301] > normal.score[301]);
  // as outras pistas seguem independentes
  const lively = [...cues.slice(0, 20), cue(120, 122, 'Nossa!'), ...cues.slice(20)];
  const mixed = scoreText({ cues: lively }, { n: 620, th: TH, humor: profile, textWeights: { humor: 0 } });
  assert.ok(mixed.parts.exclaim[121] > 0 && mixed.parts.humor.every((v) => v >= 0));
});

test('o resultado da análise do texto não depende da ordem em que o usuário listou os bordões', () => {
  const cues = [...calm(120), cue(60, 62, 'Beco moleque'), cue(90, 92, 'eita bora')];
  const a = scoreText({ cues }, { n: 130, th: TH, humor: lists({ phrases: ['beco moleque', 'bora'], reactions: ['tenso'] }) });
  const b = scoreText({ cues }, { n: 130, th: TH, humor: lists({ phrases: ['bora', 'beco moleque'], reactions: ['tenso'] }) });
  assert.deepEqual(Array.from(a.score), Array.from(b.score));
});

test('temas do perfil: limpos como as outras listas, contam para o perfil não estar vazio, passam pela preferência e o algoritmo os ignora', () => {
  const p = humor.normalizeProfile({ themes: ['Piadas', ' piadas ', 'Cenas de história', '', 7, 'x'.repeat(200)] });
  assert.deepEqual(p.themes, ['Piadas', 'Cenas de história', 'x'.repeat(60)]);
  assert.equal(humor.isEmpty({ themes: ['Piadas'] }), false);
  assert.equal(humor.isEmpty({ themes: [] }), true);
  assert.deepEqual(humor.normalizeProfile({ themes: 'a, b; c' }).themes, ['a', 'b', 'c']);
  assert.deepEqual(humor.normalizeProfile({ themes: { a: 1 } }).themes, [], 'tipo errado vira vazio');
  assert.equal(humor.normalizeProfile({ themes: Array.from({ length: 80 }, (_, i) => `tema ${i}`) }).themes.length, humor.LIMITS.items);
  assert.deepEqual(humor.forAlgorithm({ themes: ['Piadas'], catchphrases: ['Bora'] }), { phrases: ['bora'], reactions: [] }, 'o algoritmo não recebe temas');
  const def = keys.findDef('analysis.humor');
  const ok = keys.validate(def, { themes: 'Piadas; Cenas de história' });
  assert.equal(ok.ok, true, 'um perfil só com temas é válido');
  assert.deepEqual(ok.value.themes, ['Piadas', 'Cenas de história']);
});
