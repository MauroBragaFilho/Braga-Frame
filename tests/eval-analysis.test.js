'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluate, chanceBaseline, formatChance, matches, normalizeGold, normalizeSuggestions, parseArgs, format } = require('../scripts/eval-analysis');

const GOLD = [
  { s: 100, e: 140, r: 0.9, t: 'a' }, { s: 500, e: 560, r: 0.8, t: 'b' }, { s: 900, e: 930, r: 0.6, t: 'c' }, { s: 1500, e: 1560, r: 0.9, t: 'd' }
];

test('bate por início (±5 s) ou por sobreposição de 50% da menor duração', () => {
  const g = { start: 100, end: 140 };
  assert.equal(matches({ start: 104, end: 120 }, g), true, 'início dentro da tolerância');
  assert.equal(matches({ start: 94.9, end: 100.5 }, g), false, 'fora da tolerância e quase sem sobreposição');
  assert.equal(matches({ start: 60, end: 125 }, g), true, 'sobreposição de 25 s dos 40 s do gabarito (62%)');
  assert.equal(matches({ start: 60, end: 110 }, g), false, 'sobreposição de 10 s: 25% da menor');
  assert.equal(matches({ start: 200, end: 240 }, g), false);
});

test('revocação, precisão aproximada, distância e revocação 1:1', () => {
  const sugs = [
    { start: 102, end: 138, relevance: 0.9 },   // bate com a
    { start: 497, end: 565, relevance: 0.8 },   // bate com b
    { start: 3000, end: 3040, relevance: 0.7 }, // extra
    { start: 3100, end: 3140, relevance: 0.6 }  // extra
  ];
  const r = evaluate(sugs, GOLD);
  assert.equal(r.gold, 4);
  assert.equal(r.recall, 0.5);
  assert.equal(r.precisionApprox, 0.5);
  assert.equal(r.recallOneToOne, 0.5);
  assert.equal(r.pairs, 2);
  assert.equal(r.meanStartDistanceSec, 2.5);
  assert.equal(r.meanEndDistanceSec, (2 + 5) / 2);
  assert.deepEqual(r.missed.map((m) => m.index), [3, 4]);
  assert.equal(r.recallBest.total, 3, 'relevância >= 0,78 no gabarito: a, b, d');
  assert.equal(r.recallBest.hits, 2);
  assert.equal(r.topGold.n, 4);
});

test('uma sugestão larga não conta duas vezes no 1:1, mas conta nos dois no modo solto', () => {
  const gold = [{ s: 100, e: 130 }, { s: 120, e: 150 }];
  const r = evaluate([{ start: 100, end: 150, relevance: 1 }], gold);
  assert.equal(r.recall, 1);
  assert.equal(r.recallOneToOne, 0.5);
  assert.equal(r.precisionOneToOne, 1);
});

test('revocação nas N mais relevantes usa a ordem de relevância', () => {
  const sugs = [{ start: 3000, end: 3040, relevance: 0.99 }, { start: 100, end: 140, relevance: 0.2 }];
  const r = evaluate(sugs, GOLD, { top: 1 });
  assert.equal(r.topN.recall, 0);
  assert.equal(evaluate(sugs, GOLD, { top: 2 }).topN.recall, 0.25);
});

test('formatos de entrada: lista, objeto com suggestions e baseline com results/--run; erros claros', () => {
  assert.equal(normalizeSuggestions([{ start: 1, end: 5 }]).length, 1);
  assert.equal(normalizeSuggestions({ suggestions: [{ start: 1, end: 5 }, { start: 5, end: 4 }] }).length, 1, 'descarta fim antes do início');
  assert.equal(normalizeSuggestions({ results: { a: { suggestions: [{ start: 1, end: 5 }] }, b: { suggestions: [] } } }, 'b').length, 0);
  assert.throws(() => normalizeSuggestions({ results: { a: {} } }, 'zzz'), /não existe/);
  assert.throws(() => normalizeSuggestions({ nada: 1 }), /sem a lista/);
  assert.deepEqual(normalizeGold([{ start: 1, end: 5, relevance: 0.5 }, { s: 5 }]).map((g) => g.start), [1]);
  const args = parseArgs(['--result', 'a.json', '--gold', 'b.json', '--tolerance', '3', '--json'], {});
  assert.equal(args.tolerance, 3);
  assert.equal(args.json, true);
  assert.throws(() => parseArgs(['--x'], {}), /desconhecido/);
  assert.match(format(evaluate([{ start: 100, end: 140 }], GOLD)), /Revocação: 25%/);
});

test('faixa (--from/--to): só entram itens e sugestões que COMEÇAM nela, para separar a metade de ajuste da metade de teste', () => {
  const sugs = [
    { start: 102, end: 138, relevance: 0.9 },   // bate com a (1ª metade)
    { start: 503, end: 560, relevance: 0.8 },   // bate com b (1ª metade)
    { start: 3000, end: 3040, relevance: 0.7 }, // extra (2ª metade)
    { start: 1502, end: 1558, relevance: 0.6 }  // bate com d (2ª metade)
  ];
  const first = evaluate(sugs, GOLD, { from: 0, to: 1000 });
  assert.deepEqual([first.gold, first.suggestions, first.recallHits, first.precisionHits], [3, 2, 2, 2]);
  assert.deepEqual(first.range, { from: 0, to: 1000 });
  assert.deepEqual(first.missed.map((m) => m.index), [3]);
  const second = evaluate(sugs, GOLD, { from: 1000 });
  assert.deepEqual([second.gold, second.suggestions, second.recallHits, second.precisionHits], [1, 2, 1, 1]);
  assert.deepEqual(second.range, { from: 1000, to: null });
  assert.equal(second.recall, 1);
  assert.equal(second.precisionApprox, 0.5);
  assert.equal(evaluate(sugs, GOLD).range, null, 'sem faixa, nada muda');
  assert.equal(evaluate(sugs, GOLD).gold, 4);
  assert.match(format(first), /Faixa: 0:00 a 16:40 \(só itens e sugestões que COMEÇAM nela\)/);
  assert.match(format(second), /Faixa: 16:40 a fim/);
  const args = parseArgs(['--from', '0', '--to', '5400'], {});
  assert.deepEqual([args.from, args.to], [0, 5400]);
});

test('linha de comando: lê os caminhos por parâmetro ou variável de ambiente (nada do dono fica no repositório)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-eval-'));
  try {
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify({ suggestions: [{ start: 101, end: 139, relevance: 0.9 }] }));
    fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify(GOLD));
    const script = path.join(__dirname, '..', 'scripts', 'eval-analysis.js');
    const out = execFileSync(process.execPath, [script, '--result', path.join(dir, 'r.json'), '--gold', path.join(dir, 'g.json'), '--json'], { encoding: 'utf8' });
    assert.equal(JSON.parse(out).recallHits, 1);
    const out2 = execFileSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, BF_EVAL_RESULT: path.join(dir, 'r.json'), BF_EVAL_GOLD: path.join(dir, 'g.json') } });
    assert.match(out2, /Gabarito: 4 cortes/);
    assert.throws(() => execFileSync(process.execPath, [script, '--result', path.join(dir, 'nada.json'), '--gold', path.join(dir, 'g.json')], { stdio: 'pipe' }), /status 1|Command failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('referência do acaso: repetível, coerente com a cobertura e com a regra de "bate"', () => {
  const gold = [{ s: 100, e: 130 }, { s: 500, e: 530 }, { s: 900, e: 930 }];
  // um único trecho do tamanho do vídeo cobre tudo: o acaso acerta o gabarito inteiro em todo sorteio
  const full = chanceBaseline([{ start: 0, end: 1000 }], gold, 1000, { draws: 300 });
  assert.deepEqual([full.mean, full.p95, full.p99, full.max, full.hits, full.pAtLeast], [3, 3, 3, 3, 3, 1]);
  // um trecho de 1 s em 1000 s quase nunca acerta (e nunca acerta mais de um item)
  const tiny = chanceBaseline([{ start: 101, end: 102 }], gold, 1000, { draws: 2000 });
  // (cada item do gabarito é acertado se o trecho começa a até 5 s dele ou cai dentro dele: ~35 s de 1000 s, ou ~3,5% por item, ~10% nos três)
  assert.ok(tiny.mean > 0.05 && tiny.mean < 0.15 && tiny.max <= 1, `média ${tiny.mean}, máximo ${tiny.max}`);
  assert.equal(tiny.hits, 1, 'a execução real acertou um item (início a menos de 5 s)');
  assert.ok(tiny.pAtLeast > 0.05 && tiny.pAtLeast < 0.2, `a chance de o acaso acertar 1 ou mais é ~10%: ${tiny.pAtLeast}`);
  // mesma semente, mesmo resultado; outra semente, outro sorteio; mais trechos, mais acertos ao acaso
  assert.deepEqual(chanceBaseline([{ start: 101, end: 102 }], gold, 1000, { draws: 2000 }), tiny);
  const many = chanceBaseline(Array.from({ length: 30 }, (_, i) => ({ start: i * 30, end: i * 30 + 20 })), gold, 1000, { draws: 2000 });
  assert.ok(many.mean > tiny.mean, 'mais trechos acertam mais ao acaso');
  // sem sugestões, sem gabarito ou sem duração: nada a calcular
  assert.equal(chanceBaseline([], gold, 1000), null);
  assert.equal(chanceBaseline([{ start: 1, end: 2 }], [], 1000), null);
  assert.equal(chanceBaseline([{ start: 1, end: 2 }], gold, 0), null);
  assert.match(formatChance(tiny), /^Acaso \(2\.000 sorteios, as mesmas 1 durações\): média /);
  assert.match(formatChance(null), /sem sugestões, gabarito ou duração/);
  assert.equal(parseArgs(['--chance', '11090', '--draws', '500'], {}).chance, 11090);
});

test('linha de comando: --chance acrescenta a referência do acaso ao relatório (e ao --json)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-eval-'));
  try {
    fs.writeFileSync(path.join(dir, 'r.json'), JSON.stringify([{ start: 101, end: 139 }]));
    fs.writeFileSync(path.join(dir, 'g.json'), JSON.stringify(GOLD));
    const script = path.join(__dirname, '..', 'scripts', 'eval-analysis.js');
    const base = [script, '--result', path.join(dir, 'r.json'), '--gold', path.join(dir, 'g.json'), '--chance', '2000', '--draws', '500'];
    const text = execFileSync(process.execPath, base, { encoding: 'utf8' });
    assert.match(text, /Acaso \(500 sorteios, as mesmas 1 durações\)/);
    const json = JSON.parse(execFileSync(process.execPath, [...base, '--json'], { encoding: 'utf8' }));
    assert.equal(json.chance.draws, 500);
    assert.equal(json.chance.hits, 1);
    assert.equal(json.recallHits, 1);
    assert.equal(JSON.parse(execFileSync(process.execPath, base.slice(0, 5).concat('--json'), { encoding: 'utf8' })).chance, undefined, 'sem --chance, o relatório não muda');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
