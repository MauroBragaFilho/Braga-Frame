'use strict';

/**
 * Sinal de TEXTO (src/core/analysis/textSignal.js): a transcrição vira pontuação por segundo. Funções puras sobre falas sintéticas
 * com horários conhecidos (nada de mock do que está sendo testado): risadas, exclamações e reações, ritmo de fala, repetição de
 * bordão e falas sobre o próprio momento. Os números absolutos dependem da sensibilidade; aqui valem o lugar e a ordem de grandeza.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const params = require('../src/core/analysis/params');
const { scoreText, extractEvents, windowSums, REACTION_RE, META_RE } = require('../src/core/analysis/textSignal');

const TH = params.thresholds(3);
const cue = (start, end, text, extra = {}) => ({ start, end, text, ...extra });
const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
const maxIn = (series, from, to) => { let m = 0; for (let k = Math.max(0, from); k <= Math.min(series.length - 1, to); k += 1) if (series[k] > m) m = series[k]; return m; };

/** Conversa normal: uma fala de 8 palavras a cada 6 s (1,3 palavras/s), sem exclamação, sem repetição. */
function calm(seconds, { from = 0 } = {}) {
  const list = [];
  const filler = ['hoje a gente vai explorar essa região do mapa', 'preciso encontrar uns materiais para construir a base', 'depois eu volto aqui para conferir o que sobrou',
    'acho que o servidor está mais estável do que ontem', 'vou testar essa ferramenta nova que eu consegui agora', 'amanhã eu penso em como organizar o baú todo'];
  for (let t = from, i = 0; t < from + seconds; t += 6, i += 1) list.push(cue(t, t + 5, `${filler[i % filler.length]} ${i}`));
  return list;
}

test('extractEvents: exclamações, reações, falas sobre o momento e palavras por segundo ficam no segundo certo', () => {
  const cues = [
    cue(10, 12, 'Olha só que legal.'),
    cue(20, 22, 'Nossa!'), // exclamação + interjeição
    cue(30, 33, 'Que isso, caralho'), // reação sem "!"
    cue(40, 43, 'Não acredito!!'), // exclamação + fala sobre o momento
    cue(50, 54, 'Vou tentar clipar essa parte'),
    cue(60, 62, 'Bom dia pessoal')
  ];
  const ev = extractEvents(cues, 100);
  assert.equal(ev.exclaim[20], 1.5, 'Nossa! = exclamação + reação, limitado a 1,5');
  assert.equal(ev.exclaim[30], 0.75, 'reação sem exclamação vale menos');
  assert.equal(ev.exclaim[40], 1, 'só "!"');
  assert.equal(ev.exclaim[10], 0);
  assert.equal(ev.exclaim[60], 0);
  assert.equal(ev.meta[40], 1, '"não acredito" é fala sobre o momento');
  assert.equal(ev.meta[50], 1, '"vou tentar clipar"');
  assert.equal(ev.meta[10], 1, '"olha só"');
  assert.equal(ev.meta[60], 0);
  assert.ok(Math.abs(sum(ev.words) - cues.reduce((n, c) => n + c.text.split(/\s+/).length, 0)) < 1e-9, 'todas as palavras entram no ritmo');
  assert.ok(ev.words[60] > 0 && ev.words[64] === 0);
});

test('extractEvents: marcas de risada seguidas são UMA risada (laços do reconhecimento não inflam) e não contam como fala', () => {
  const run = [];
  for (let t = 100; t < 120; t += 2) run.push(cue(t, t + 2, '*Risos*', { laugh: true })); // 10 marcas em laço
  const cues = [...run, cue(200, 202, '*Risos*', { laugh: true }), cue(300, 303, 'Pessoal, bem-vindos de volta')];
  const ev = extractEvents(cues, 400);
  assert.equal(ev.laugh[100], 3, 'a risada longa vale no máximo 3');
  assert.equal(sum(ev.laugh) - ev.laugh[100] - ev.laugh[200], 0, 'só o começo de cada risada marca');
  assert.equal(ev.laugh[200], 1, 'uma marca solta vale 1');
  assert.equal(ev.words[101], 0, 'risada não tem palavras');
  assert.ok(ev.words[300] > 0);
  // sem a marca laugh na fala, o texto "*Risos*" também é reconhecido
  assert.equal(extractEvents([cue(5, 7, '[risos]')], 20).laugh[5], 1);
});

test('extractEvents: repetição de bordão conta o que se repete colado; expressão habitual do falante e assunto repetido, não', () => {
  const cues = [
    cue(10, 13, 'Beco moleque!'), cue(14, 17, 'Beco moleque!'), // fala curta repetida
    cue(30, 34, 'É like, like, like!'), // palavra em sequência
    cue(50, 55, 'o preço é 21 reais uma espada'), cue(56, 58, '21 reais, velho!'), // par repetido
    cue(70, 75, 'a montanha de pedra é grande'), cue(80, 85, 'subi a montanha de pedra ontem') // assunto repetido com mais de 6 s de distância
  ];
  // "e aí" dito o tempo todo: expressão habitual (não é bordão)
  for (let t = 100; t < 700; t += 20) cues.push(cue(t, t + 1.5, 'E aí'), cue(t + 4, t + 5.5, 'E aí'));
  const ev = extractEvents(cues, 800);
  assert.ok(ev.repeat[14] >= 1, 'a fala curta inteira repetida');
  assert.ok(ev.repeat[30] >= 2, 'palavra repetida em sequência');
  assert.ok(ev.repeat[56] >= 1, 'o par "21 reais" repetido');
  assert.equal(ev.repeat[80], 0, 'o mesmo assunto 10 s depois não é bordão');
  assert.equal(sum(ev.repeat.slice(100, 700)), 0, '"e aí" é habitual neste falante e fica de fora');
  // números em lista (alucinação típica do reconhecimento) não viram repetição
  const numbers = extractEvents([cue(5, 6, '1'), cue(7, 8, '1'), cue(9, 10, '1 1')], 20);
  assert.equal(sum(numbers.repeat), 0);
});

test('palavras de reação e de fala sobre o momento: sem acento, caixa ou pontuação; sem casar dentro de outra palavra', () => {
  for (const ok of ['caralho', 'meu deus', 'nossa senhora', 'puta que pariu', 'eita', 'fodeu']) assert.ok(REACTION_RE.test(` ${ok} `) || REACTION_RE.test(ok), ok);
  for (const no of ['nossas', 'caramelo', 'portaria', 'musica']) assert.equal(REACTION_RE.test(no), false, no);
  for (const ok of ['vou clipar', 'isso vai pro corte', 'nao acredito', 'olha isso']) assert.ok(META_RE.test(ok), ok);
  for (const no of ['clipboard', 'eclipse', 'olhar']) assert.equal(META_RE.test(no), false, no);
});

test('scoreText: conversa calma não pontua; um minuto animado (exclamações, reações, repetição e fala rápida) pontua no lugar certo', () => {
  const lively = [];
  const phrases = ['Nossa, olha isso!', 'Não acredito!', 'Caralho, morri de novo!', 'Que foda, véi, que foda, véi!', 'Matem, matem!'];
  for (let t = 600, i = 0; t < 660; t += 3, i += 1) lively.push(cue(t, t + 2.5, `${phrases[i % phrases.length]} ${phrases[(i + 1) % phrases.length]} ${phrases[(i + 2) % phrases.length]}`));
  const cues = [...calm(600), ...lively, ...calm(600, { from: 660 })];
  const s = scoreText({ cues }, { n: 1260, th: TH, baselineSec: 600 });
  assert.equal(s.id, 'text');
  assert.ok(maxIn(s.score, 0, 560) < 0.1, `conversa calma: ${maxIn(s.score, 0, 560)}`);
  assert.ok(maxIn(s.score, 700, 1259) < 0.1, `depois do minuto animado: ${maxIn(s.score, 700, 1259)}`);
  const peak = maxIn(s.score, 600, 660);
  assert.ok(peak >= 0.85 && peak < 1, `no minuto animado: ${peak} (alta, mas nunca 1,0)`);
  const reasons = s.describe(600, 660).map((r) => r.text);
  assert.ok(reasons.includes('exclamações e reações'), reasons.join('|'));
  assert.ok(reasons.some((r) => /^ritmo de fala acelerou \(\d+(,\d)? palavras\/s\)$/.test(r)), reasons.join('|'));
  assert.ok(reasons.includes('fala sobre o próprio momento'), reasons.join('|'));
  assert.deepEqual(s.describe(0, 100), [], 'sem pista, sem motivo');
  assert.equal(s.stats.cues, cues.length);
});

test('scoreText: a risada vem DEPOIS do lance, então a pontuação cobre os segundos que a antecedem', () => {
  const cues = [...calm(300), cue(300, 302, '*Risos*', { laugh: true }), ...calm(300, { from: 310 })];
  const s = scoreText({ cues }, { n: 610, th: TH });
  assert.ok(s.score[292] > 0.5 && s.score[300] > 0.5, 'os ~15 s antes da risada pontuam');
  assert.ok(s.score[285] > 0, 'começa uns 15 s antes');
  assert.equal(s.score[270], 0);
  assert.equal(s.score[308], 0, 'depois da risada acabou');
  assert.ok(Math.max(...s.score) < 1);
  assert.deepEqual(s.describe(290, 300).map((r) => r.text), ['risada']);
  const twice = scoreText({ cues: [...cues, cue(304, 306, '*Risos*', { laugh: true })] }, { n: 610, th: TH });
  assert.ok(Math.max(...twice.score) > Math.max(...s.score), 'mais risada, mais pontuação');
});

test('scoreText: pesos por pista (0 desliga), sem transcrição e sensibilidade', () => {
  const cues = [...calm(300), cue(300, 302, 'Nossa!'), cue(303, 305, 'Caralho!'), cue(306, 308, 'Não acredito!'), cue(309, 311, 'Meu deus!'), ...calm(300, { from: 315 })];
  const on = scoreText({ cues }, { n: 620, th: TH });
  assert.ok(maxIn(on.score, 295, 320) > 0.5);
  const off = scoreText({ cues }, { n: 620, th: TH, textWeights: { exclaim: 0, meta: 0 } });
  assert.ok(maxIn(off.score, 295, 320) < maxIn(on.score, 295, 320) * 0.5, 'sem a pista de exclamações sobra pouco');
  const none = scoreText({ cues }, { n: 620, th: TH, textWeights: { laugh: 0, exclaim: 0, pace: 0, repeat: 0, meta: 0 } });
  assert.equal(sum(none.score), 0);
  assert.equal(sum(scoreText({ cues: [] }, { n: 100, th: TH }).score), 0);
  assert.equal(sum(scoreText(null, { n: 100, th: TH }).score), 0);
  const strict = scoreText({ cues }, { n: 620, th: params.thresholds(1) });
  const loose = scoreText({ cues }, { n: 620, th: params.thresholds(5) });
  assert.ok(maxIn(loose.score, 295, 320) > maxIn(strict.score, 295, 320), 'sensibilidade alta pontua mais');
});

test('windowSums: soma em [k - back, k + ahead] nas bordas e no meio', () => {
  assert.deepEqual([...windowSums(Float64Array.from([1, 0, 0, 2, 0]), 1, 1)], [1, 1, 2, 2, 2]);
  assert.deepEqual([...windowSums(Float64Array.from([0, 0, 5, 0, 0]), 0, 2)], [5, 5, 5, 0, 0]);
});
