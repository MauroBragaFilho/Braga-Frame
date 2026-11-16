'use strict';

/**
 * FILTRO DE IDEIAS FRACAS e QUANTIDADE AUTOMÁTICA (params.filterWeak / params.autoQuantity; docs/recursos/analysis.md, "Filtro de ideias
 * fracas e quantidade automática"). Com transcrição que marca reações, a sugestão precisa de ao menos uma reação de voz ou do chat; a vaga
 * da descartada vai para o próximo pico. Transcrição que quase não marca reações desliga o filtro (com aviso). Sem ffmpeg: só texto.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const params = require('../src/core/analysis/params');
const { combine } = require('../src/core/analysis/combine');
const { analyzeSource, MIN_VOICE_PER_HOUR } = require('../src/core/analysis/analyze');

/** Sinal sintético com motivos de um tipo só (kind) nos instantes dados. */
function sig(id, kind, peaks, n = 600) {
  const score = new Float64Array(n);
  for (const [at, h] of peaks) for (let k = at - 3; k <= at + 3; k += 1) score[k] = Math.max(score[k], h * (1 - Math.abs(k - at) / 4));
  return { id, score, describe: (from, to) => (peaks.some(([at]) => at >= from - 3 && at <= to + 3) ? [{ kind, text: `${id}:${kind}`, strength: 1 }] : []) };
}

test('combine: a sugestão descartada pelo filtro sai da lista, entra em "discarded" com o motivo, e a vaga vai para o próximo pico', () => {
  const P = params.normalizeParams({ maxSuggestions: 2, weights: { audio: 1, text: 1 } });
  const loud = sig('audio', 'level', [[100, 0.95], [300, 0.9]]); // volume sem voz: os dois picos mais fortes
  const voice = sig('text', 'exclaim', [[500, 0.7]]); // uma reação de voz mais fraca
  const discarded = [];
  const discard = (c) => (c.evidence.includes('text:exclaim') ? null : 'sem reação de voz nem do chat');
  const out = combine({ n: 600, duration: 600, signals: [loud, voice], params: P, discard, discarded });
  assert.deepEqual(out.map((s) => Math.round(s.peak)), [501], 'só a reação de voz fica; a vaga não é preenchida por outro pico sem voz');
  assert.deepEqual(out[0].evidence, ['text:exclaim']);
  assert.deepEqual(discarded.map((d) => [Math.round(d.peak), d.why]), [[101, 'sem reação de voz nem do chat'], [301, 'sem reação de voz nem do chat']]);
  const plain = combine({ n: 600, duration: 600, signals: [loud, voice], params: P });
  assert.deepEqual(plain.map((s) => Math.round(s.peak)).sort((a, b) => a - b), [101, 301], 'sem o filtro, os dois picos de volume');
});

test('parâmetros: filtro ligado e quantidade fixa por padrão; automática = sem teto por hora (trava de 30/h, 5 por janela; o calmo segue a Quantidade)', () => {
  const d = params.normalizeParams({});
  assert.equal(d.filterWeak, true);
  assert.equal(d.autoQuantity, false);
  const auto = params.normalizeParams({ autoQuantity: true, perHour: 6 });
  const twoHours = 7200;
  assert.equal(params.suggestionLimit(d, twoHours), 12);
  assert.equal(params.suggestionLimit(auto, twoHours), 60, `trava de ${params.AUTO_PER_HOUR} por hora`);
  assert.equal(params.perWindowLimit(auto, twoHours), params.AUTO_PER_WINDOW);
  assert.equal(params.calmLimit(auto, twoHours), params.calmLimit(d, twoHours), 'a cota do calmo não cresce com a trava');
  assert.equal(params.suggestionLimit(params.normalizeParams({ autoQuantity: true, maxSuggestions: 7 }), twoHours), 7, 'teto absoluto continua mandando');
});

/** Uma hora de conversa calma + um trecho animado com exclamações (500 s) + um trecho de fala rápida e repetida, sem exclamação (2500 s). */
function hour({ scattered = 40 } = {}) {
  const calm = ['a gente estava falando sobre o mapa novo', 'tinha bastante coisa para fazer naquela parte', 'depois a gente volta para conferir o resto'];
  const cues = [];
  for (let t = 0; t < 3600; t += 6) cues.push({ start: t, end: t + 5, text: `${calm[(t / 6) % 3]}.` });
  for (let t = 500; t < 520; t += 2) { cues.push({ start: t, end: t + 1.8, text: 'Nossa! Não acredito! Que isso!' }) }
  for (let t = 2500; t < 2520; t += 1) { cues.push({ start: t, end: t + 0.9, text: 'pega pega pega o loot pega o loot pega o loot pega' }) }
  // exclamações soltas pela hora (a transcrição "marca reações"): `scattered` por hora
  for (let i = 0; i < scattered; i += 1) { const t = 30 + i * Math.floor(3400 / Math.max(1, scattered)); if (Math.abs(t - 500) > 90 && Math.abs(t - 2500) > 90) cues.push({ start: t + 5.2, end: t + 5.9, text: 'Boa!' }); }
  return cues.sort((a, b) => a.start - b.start);
}

test('analyzeSource: com transcrição que marca reações, a fala rápida e repetida sem reação de voz é descartada; sem marcas, o filtro desliga e avisa', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-filter-'));
  const file = path.join(tmp, 'live.mp4');
  fs.writeFileSync(file, 'só texto');
  try {
    const deps = { ffmpeg: path.join(tmp, 'sem-ffmpeg.exe'), cacheDir: path.join(tmp, 'cache') };
    const run = (cues, extra) => analyzeSource({
      file, duration: 3600, hasAudio: false, transcript: { cues },
      params: { signals: { audio: false, image: false, chat: false, calm: false, text: true }, sensitivity: 5, maxSuggestions: 6, ...extra }
    }, deps);
    const near = (r, t) => r.suggestions.some((s) => s.start <= t + 10 && s.end >= t);
    const rich = await run(hour());
    assert.equal(rich.filter.on, true, `${rich.filter.voicePerHour} reações por hora (mínimo ${MIN_VOICE_PER_HOUR})`);
    assert.ok(near(rich, 505), 'o trecho com exclamações fica');
    assert.ok(!near(rich, 2505), 'a fala rápida e repetida, sem reação de voz, sai');
    assert.ok(rich.filtered.some((f) => f.start <= 2510 && f.end >= 2500 && f.why === 'sem reação de voz nem do chat'), 'e aparece na lista do filtro');
    const off = await run(hour(), { filterWeak: false });
    assert.ok(near(off, 2505), 'com o filtro desligado ela volta');
    const poor = await run(hour({ scattered: 0 }));
    assert.equal(poor.filter.on, false, 'transcrição que quase não marca reações');
    assert.ok(poor.warnings.some((w) => w.code === 'FILTER_OFF'));
    assert.ok(near(poor, 2505), 'sem o filtro, nada é descartado');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
