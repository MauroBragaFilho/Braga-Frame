'use strict';

/**
 * INÍCIO NO LANCE (perfil de gameplay; combine, opção `leadIn`; docs/recursos/analysis.md, "Teste numa gameplay"): a reação do streamer vem
 * DEPOIS do lance, então o corte volta pelo menos `baseSec` antes do evento e segue o som do jogo ativo para trás (buracos de até `gapSec`,
 * até `maxSec`). O fim fica, a duração máxima vale, o espaço de outra sugestão também, e com transcrição o início é começo de fala.
 * O perfil de conversa não usa (analyze.js só passa `leadIn` no gameplay).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { combine } = require('../src/core/analysis/combine');
const params = require('../src/core/analysis/params');
const { GAMEPLAY_LEAD } = require('../src/core/analysis/analyze');

const N = 300;
const P = params.normalizeParams({ maxSuggestions: 1, weights: { text: 1 } });

/** A reação: pontuação de texto alta de 150 a 154. */
function reaction() {
  const score = new Float64Array(N);
  for (let k = 150; k <= 154; k += 1) score[k] = 0.9;
  return { id: 'text', score, describe: () => [{ text: 'exclamações e reações', strength: 0.9 }] };
}
/** O som do jogo: ativo nos trechos dados. */
function game(...ranges) {
  const s = new Float64Array(N);
  for (const [a, b] of ranges) for (let k = a; k <= b; k += 1) s[k] = 0.5;
  return s;
}
const lead = (signal) => ({ ...GAMEPLAY_LEAD, signal });

test('início no lance: sem a opção, o corte começa na reação; com ela, volta pelo menos 8 s e segue o som do jogo para trás', () => {
  const [plain] = combine({ n: N, duration: N, signals: [reaction()], params: P });
  assert.ok(plain.start > 150 - GAMEPLAY_LEAD.baseSec && plain.start <= 150 - P.padBeforeSec, `sem leadIn: a margem de sempre (e a duração mínima) antes da reação (${plain.start})`);

  const [base] = combine({ n: N, duration: N, signals: [reaction()], params: P, leadIn: lead(game()) });
  assert.equal(base.start, 150 - GAMEPLAY_LEAD.baseSec, 'sem som de jogo antes: volta 8 s');
  assert.equal(base.end, plain.end, 'o fim não muda');

  // o lance (som do jogo) 30 s antes da reação, com 14 s de silêncio no meio (o trem e o riso, na live medida)
  const [far] = combine({ n: N, duration: N, signals: [reaction()], params: P, leadIn: lead(game([120, 124], [130, 135])) });
  assert.equal(far.start, 120 - P.padBeforeSec, 'segue a atividade até o começo do lance');

  // silêncio maior que o buraco aceito: não segue (o lance de antes era outro)
  const [cut] = combine({ n: N, duration: N, signals: [reaction()], params: P, leadIn: lead(game([100, 110])) });
  assert.equal(cut.start, 150 - GAMEPLAY_LEAD.baseSec, `buraco de ${150 - 111} s: fica a margem base`);
});

test('início no lance: respeita a duração máxima, o espaço de outra sugestão e começa em começo de fala', () => {
  // atividade contínua desde 60: o início pararia em 110 (até 40 s antes), mas a duração máxima (60 s) manda
  const P30 = params.normalizeParams({ maxSuggestions: 1, weights: { text: 1 }, maxDurationSec: 30 });
  const [cap] = combine({ n: N, duration: N, signals: [reaction()], params: P30, leadIn: lead(game([60, 149])) });
  assert.ok(cap.end - cap.start <= 30 + 1e-9, `duração ${cap.end - cap.start}`);

  // uma sugestão já escolhida até 135: o início não invade o espaço dela (nem a folga de 5 s)
  const [free] = combine({ n: N, duration: N, signals: [reaction()], params: P, leadIn: lead(game([120, 149])), blocked: [{ start: 100, end: 135 }] });
  assert.ok(free.start >= 135 + P.spread.minGapSec - 1e-9, `começa em ${free.start}`);

  // com transcrição: o novo início vai para o começo de fala mais próximo antes dele (até 6 s) ou, sem ele, para o primeiro depois
  const alignTo = { starts: [100, 116, 131, 150], ends: [104, 120, 135, 160] };
  const [snap] = combine({ n: N, duration: N, signals: [reaction()], params: P, alignTo, leadIn: lead(game([120, 149])) });
  assert.ok(alignTo.starts.includes(snap.start), `início ${snap.start} é começo de fala`);
  assert.ok(snap.start <= 131, 'e continua antes da reação');
});
