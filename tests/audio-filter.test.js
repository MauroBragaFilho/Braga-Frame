'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fx = require('./audio-fixtures');
const { buildAudioFilter, resolveAudio, normalizeAudio, maxFadeSec, envelopeAt, envelopePoints, dbToLinear, LIMITS } = require('../src/core/audio/audioFilter');

const skipMedia = fx.tools.ffmpeg && fx.tools.ffprobe ? false : 'ffmpeg/ffprobe não encontrados';
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: esperado ${expected} ±${tol}, medido ${actual}`);

// ---------- o filtro (texto) ----------

test('sem ajuste nenhum não há filtro', () => {
  assert.equal(buildAudioFilter({ gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] }, { duration: 10 }), null);
  assert.equal(buildAudioFilter(undefined, { duration: 10 }), null);
  assert.equal(buildAudioFilter(null), null);
  assert.equal(buildAudioFilter({}), null);
  assert.equal(buildAudioFilter({ gainDb: 0.001 }, { duration: 10 }), null, 'ganho desprezível = nenhum');
  assert.equal(buildAudioFilter({ gainDb: 'abc', fadeInSec: -3 }, { duration: 10 }), null, 'lixo vira o padrão');
});

test('ganho vira volume em dB, com sinal e sem zeros inúteis', () => {
  assert.equal(buildAudioFilter({ gainDb: 6 }, { duration: 10 }), 'volume=6dB');
  assert.equal(buildAudioFilter({ gainDb: -6.5 }, { duration: 10 }), 'volume=-6.5dB');
  assert.equal(buildAudioFilter({ gainDb: 0.1 }, { duration: 10 }), 'volume=0.1dB');
  assert.equal(buildAudioFilter({ gainDb: '3,25' }, { duration: 10 }), 'volume=3.25dB', 'aceita vírgula');
  assert.equal(buildAudioFilter({ gainDb: 6 }), 'volume=6dB', 'ganho não depende da duração');
});

test('ganho é limitado a -30..+20 dB', () => {
  assert.equal(buildAudioFilter({ gainDb: 99 }, { duration: 10 }), 'volume=20dB');
  assert.equal(buildAudioFilter({ gainDb: -99 }, { duration: 10 }), 'volume=-30dB');
  const r = resolveAudio({ gainDb: 99 }, { duration: 10 });
  assert.equal(r.warnings[0].code, 'GAIN_LIMITED');
  assert.deepEqual([LIMITS.gainMinDb, LIMITS.gainMaxDb], [-30, 20]);
});

test('mudo vira volume=0 e ignora ganho e fades', () => {
  assert.equal(buildAudioFilter({ mute: true }, { duration: 10 }), 'volume=0');
  assert.equal(buildAudioFilter({ mute: true, gainDb: 12, fadeInSec: 1, fadeOutSec: 1 }, { duration: 10 }), 'volume=0');
});

test('fades: início em 0 e fim relativo à duração do corte', () => {
  assert.equal(buildAudioFilter({ fadeInSec: 1 }, { duration: 10 }), 'afade=t=in:st=0:d=1');
  assert.equal(buildAudioFilter({ fadeOutSec: 1.5 }, { duration: 10 }), 'afade=t=out:st=8.5:d=1.5');
  assert.equal(buildAudioFilter({ gainDb: 3, fadeInSec: 0.5, fadeOutSec: 2 }, { duration: 12.25 }), 'volume=3dB,afade=t=in:st=0:d=0.5,afade=t=out:st=10.25:d=2');
});

test('fade nunca passa da metade da duração do corte (e avisa)', () => {
  assert.equal(maxFadeSec(10), 5);
  assert.equal(maxFadeSec(4.5), 2.25);
  assert.equal(maxFadeSec(0.0019), 0, 'arredonda para baixo em milissegundos');
  assert.equal(buildAudioFilter({ fadeInSec: 30 }, { duration: 10 }), 'afade=t=in:st=0:d=5');
  assert.equal(buildAudioFilter({ fadeOutSec: 30 }, { duration: 10 }), 'afade=t=out:st=5:d=5');
  const both = resolveAudio({ fadeInSec: 9, fadeOutSec: 9 }, { duration: 6 });
  assert.deepEqual([both.fadeInSec, both.fadeOutSec], [3, 3]);
  assert.deepEqual(both.warnings.map((w) => w.code), ['FADE_IN_LIMITED', 'FADE_OUT_LIMITED']);
  assert.ok(both.fadeInSec + both.fadeOutSec <= 6, 'os dois fades nunca se sobrepõem');
  // exatamente a metade é permitido e não gera aviso
  assert.deepEqual(resolveAudio({ fadeInSec: 3, fadeOutSec: 3 }, { duration: 6 }).warnings, []);
  // corte curtíssimo: sem fade possível
  assert.equal(buildAudioFilter({ fadeInSec: 1 }, { duration: 0.0005 }), null);
});

test('os avisos de limite usam vírgula decimal (pt-BR) e o filtro do ffmpeg continua com ponto', () => {
  const r = resolveAudio({ gainDb: 25.5, fadeInSec: 0.5, fadeOutSec: 0.45 }, { duration: 0.3 });
  assert.deepEqual(r.warnings.map((w) => w.code), ['GAIN_LIMITED', 'FADE_IN_LIMITED', 'FADE_OUT_LIMITED']);
  assert.equal(r.warnings[0].message, 'O ganho de 25,5 dB passa do limite; a exportação usa 20 dB (limites: -30 a +20 dB).');
  assert.equal(r.warnings[1].message, 'O fade in de 0,5 s passa da metade do corte; a exportação usa 0,15 s.');
  assert.equal(r.warnings[2].message, 'O fade out de 0,45 s passa da metade do corte; a exportação usa 0,15 s.');
  for (const w of r.warnings) assert.doesNotMatch(w.message, /\d\.\d/, `nenhum número com ponto decimal no texto da tela: ${w.message}`);
  // o texto para o ffmpeg não muda: ponto decimal
  assert.equal(buildAudioFilter({ gainDb: 25.5, fadeInSec: 0.5, fadeOutSec: 0.45 }, { duration: 0.3 }), 'volume=20dB,afade=t=in:st=0:d=0.15,afade=t=out:st=0.15:d=0.15');
});

test('fade out sem a duração do corte é omitido com aviso (não inventa o ponto de início)', () => {
  const r = resolveAudio({ gainDb: 2, fadeOutSec: 1 });
  assert.equal(r.fadeOutSec, 0);
  assert.equal(r.warnings[0].code, 'FADE_OUT_NEEDS_DURATION');
  assert.equal(buildAudioFilter({ gainDb: 2, fadeOutSec: 1 }), 'volume=2dB');
  assert.equal(buildAudioFilter({ fadeInSec: 1 }), 'afade=t=in:st=0:d=1', 'fade in não precisa da duração');
});

test('offset desloca os fades para o tempo da fonte (corte depois da entrada)', () => {
  assert.equal(buildAudioFilter({ fadeInSec: 1, fadeOutSec: 1 }, { duration: 10, offset: 60 }), 'afade=t=in:st=60:d=1,afade=t=out:st=69:d=1');
});

test('normalizeAudio e resolveAudio não mexem na entrada e ignoram o histórico', () => {
  const input = { gainDb: 3, mute: false, fadeInSec: 1, fadeOutSec: 0, history: [{ x: 1 }], redo: [], extra: 'x' };
  const copy = JSON.parse(JSON.stringify(input));
  buildAudioFilter(input, { duration: 10 });
  resolveAudio(input, { duration: 10 });
  assert.deepEqual(input, copy);
  assert.deepEqual(normalizeAudio(input), { gainDb: 3, mute: false, fadeInSec: 1, fadeOutSec: 0 });
  assert.deepEqual(normalizeAudio({ mute: 'sim' }), { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 }, 'mudo só vale com true');
  assert.deepEqual(normalizeAudio({ gainDb: Infinity, fadeInSec: NaN }), { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 });
});

test('o envelope da prévia segue a mesma matemática do filtro', () => {
  const r = resolveAudio({ gainDb: 6, fadeInSec: 1, fadeOutSec: 2 }, { duration: 10 });
  const g = dbToLinear(6);
  near(envelopeAt(r, 0, 10), 0, 1e-9, 'início do fade in');
  near(envelopeAt(r, 0.5, 10), g * 0.5, 1e-9, 'meio do fade in');
  near(envelopeAt(r, 5, 10), g, 1e-9, 'platô');
  near(envelopeAt(r, 9, 10), g * 0.5, 1e-9, 'meio do fade out');
  near(envelopeAt(r, 10, 10), 0, 1e-9, 'fim');
  assert.deepEqual(envelopePoints(r, 10).map(([t]) => t), [0, 1, 8, 10]);
  assert.equal(envelopeAt(resolveAudio({ mute: true, gainDb: 10 }, { duration: 10 }), 5, 10), 0);
  // sem fades: dois pontos
  assert.deepEqual(envelopePoints(resolveAudio({ gainDb: 3 }, { duration: 4 }), 4).map(([t]) => t), [0, 4]);
  // fades somando exatamente a duração: pontos não se repetem
  assert.deepEqual(envelopePoints(resolveAudio({ fadeInSec: 2, fadeOutSec: 2 }, { duration: 4 }), 4).map(([t]) => t), [0, 2, 4]);
});

// ---------- o filtro aplicado de verdade (ffmpeg) ----------

test('o filtro muda o volume exportado como esperado (ganho, mudo, fades) e a fonte não é tocada', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiofilter');
  try {
    const src = fx.makeTone(path.join(dir, 'fonte.wav'), { seconds: 12, volumeDb: 0 });
    const hashBefore = fx.sha256(src);
    const out = (n) => path.join(dir, `saida-${n}.wav`);
    const START = 2;
    const END = 6; // corte de 4 s
    const duration = END - START;
    const base = await fx.measure(src, START, END);
    near(base.meanDb, fx.SINE_MEAN_DB, 0.3, 'média da fonte (senoide de amplitude 1/8)');
    near(base.peakDb, fx.SINE_PEAK_DB, 0.3, 'pico da fonte');

    const cut = async (name, audio, probe = [0, duration]) => {
      const filter = buildAudioFilter(audio, { duration });
      fx.exportAudio(src, out(name), { start: START, end: END, filter });
      near(fx.duration(out(name)), duration, 0.06, `duração de ${name}`);
      return { filter, whole: await fx.measure(out(name), 0, duration), part: await fx.measure(out(name), probe[0], probe[1]) };
    };

    // sem ajuste: nada muda
    const same = await cut('sem', {});
    assert.equal(same.filter, null);
    near(same.whole.meanDb, base.meanDb, 0.15, 'sem ajuste');

    // +6 dB ≈ +6 dB
    const up = await cut('mais6', { gainDb: 6 });
    near(up.whole.meanDb - base.meanDb, 6, 0.3, '+6 dB na média');
    near(up.whole.peakDb - base.peakDb, 6, 0.3, '+6 dB no pico');

    // -10 dB ≈ -10 dB, e um valor fracionário
    const down = await cut('menos10', { gainDb: -10 });
    near(down.whole.meanDb - base.meanDb, -10, 0.3, '-10 dB');
    const fine = await cut('fino', { gainDb: 2.5 });
    near(fine.whole.meanDb - base.meanDb, 2.5, 0.3, '+2,5 dB (controle fino)');

    // mudo: silêncio de verdade (< -80 dB), mesmo com ganho e fades pedidos
    const muted = await cut('mudo', { mute: true, gainDb: 12, fadeInSec: 1 });
    assert.ok(muted.whole.peakDb < -80, `mudo deveria ficar abaixo de -80 dB, ficou ${muted.whole.peakDb}`);
    assert.ok(muted.whole.meanDb < -80);

    // fade in de 1 s: os primeiros 0,2 s ficam ~19 dB abaixo do platô; depois do fade volta ao nível normal
    const fin = await cut('fadein', { fadeInSec: 1 }, [0, 0.2]);
    near(fin.part.meanDb - base.meanDb, 20 * Math.log10(0.2 / Math.sqrt(3)), 1.5, 'início do fade in');
    const finPlateau = await fx.measure(out('fadein'), 1.5, 3.5);
    near(finPlateau.meanDb - base.meanDb, 0, 0.3, 'platô depois do fade in');
    const finLast = await fx.measure(out('fadein'), 3.5, 4);
    near(finLast.meanDb - base.meanDb, 0, 0.3, 'o fim não é afetado pelo fade in');

    // fade out de 1 s: os últimos 0,2 s ficam ~19 dB abaixo; o começo não é afetado
    const fout = await cut('fadeout', { fadeOutSec: 1 }, [duration - 0.2, duration]);
    near(fout.part.meanDb - base.meanDb, 20 * Math.log10(0.2 / Math.sqrt(3)), 1.5, 'fim do fade out');
    const foutFirst = await fx.measure(out('fadeout'), 0, 0.5);
    near(foutFirst.meanDb - base.meanDb, 0, 0.3, 'o começo não é afetado pelo fade out');
    const foutTail = await fx.measure(out('fadeout'), duration - 0.04, duration);
    assert.ok(foutTail.meanDb - base.meanDb < -25, `a última fração do fade out quase some (${foutTail.meanDb - base.meanDb} dB)`);

    // tudo junto: ganho + fade in + fade out
    const all = await cut('tudo', { gainDb: 4, fadeInSec: 0.5, fadeOutSec: 0.5 }, [1, 3]);
    near(all.part.meanDb - base.meanDb, 4, 0.3, 'platô com ganho');
    const allHead = await fx.measure(out('tudo'), 0, 0.1);
    assert.ok(allHead.meanDb - base.meanDb - 4 < -10, 'início do fade com ganho');

    // fades pedidos acima do limite: o filtro limita a metade (2 s) e o resultado confirma — pico só no meio
    const huge = await cut('limite', { fadeInSec: 50, fadeOutSec: 50 });
    assert.equal(huge.filter, 'afade=t=in:st=0:d=2,afade=t=out:st=2:d=2');
    const hugeMid = await fx.measure(out('limite'), 1.9, 2.1);
    near(hugeMid.meanDb - base.meanDb, 0, 0.8, 'no meio, os dois fades se encontram no nível normal');
    const hugeEdges = await fx.measure(out('limite'), 0, 0.1);
    assert.ok(hugeEdges.meanDb - base.meanDb < -15);

    // a fonte continua idêntica, byte a byte, depois de tudo isso
    assert.equal(fx.sha256(src), hashBefore, 'a fonte não pode mudar');
  } finally { fx.removeDir(dir); }
});

test('corte feito depois da entrada (-ss depois do -i) funciona com offset', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiooffset');
  try {
    const src = fx.makeTone(path.join(dir, 'fonte.wav'), { seconds: 12 });
    const base = await fx.measure(src, 3, 7);
    const filter = buildAudioFilter({ fadeInSec: 1 }, { duration: 4, offset: 3 });
    assert.equal(filter, 'afade=t=in:st=3:d=1');
    fx.exportAudio(src, path.join(dir, 'a.wav'), { start: 3, end: 7, filter, outputSeek: true });
    const head = await fx.measure(path.join(dir, 'a.wav'), 0, 0.2);
    near(head.meanDb - base.meanDb, 20 * Math.log10(0.2 / Math.sqrt(3)), 1.5, 'fade in no começo do corte');
  } finally { fx.removeDir(dir); }
});

test('numa gravação real (MP4 com AAC) o ganho e o fade também valem na exportação', { skip: skipMedia }, async () => {
  const dir = fx.tmpDir('audiomp4');
  try {
    const src = fx.makeVideo(path.join(dir, 'gameplay.mp4'), { seconds: 10, volumeDb: -3 });
    const hash = fx.sha256(src);
    const base = await fx.measure(src, 1, 5);
    const filter = buildAudioFilter({ gainDb: 6, fadeInSec: 1 }, { duration: 4 });
    fx.exportAudio(src, path.join(dir, 'corte.m4a'), { start: 1, end: 5, filter, extra: ['-c:a', 'aac', '-b:a', '192k'] });
    const plateau = await fx.measure(path.join(dir, 'corte.m4a'), 1.5, 3.5);
    near(plateau.meanDb - base.meanDb, 6, 0.8, '+6 dB depois do AAC');
    const head = await fx.measure(path.join(dir, 'corte.m4a'), 0, 0.2);
    assert.ok(plateau.meanDb - head.meanDb > 12, 'o início do fade in fica bem abaixo do platô');
    assert.equal(fx.sha256(src), hash);
  } finally { fx.removeDir(dir); }
});

// ---------- plano de automação da prévia (Web Audio) ----------

/** Valor de um AudioParam no instante t, seguindo as regras do Web Audio (set mantém; ramp é linear desde o evento anterior). */
function paramValue(plan, t, initial = 1) {
  let prevValue = initial;
  let prevTime = -Infinity;
  for (const step of plan) {
    if (t < step.time) {
      if (step.op === 'ramp' && prevTime > -Infinity) return prevValue + ((step.value - prevValue) * (t - prevTime)) / (step.time - prevTime);
      return prevValue;
    }
    prevValue = step.value;
    prevTime = step.time;
  }
  return prevValue;
}

test('o plano da prévia reproduz o envelope do filtro em qualquer ponto de partida', () => {
  const GRACE = 0.3;
  const audios = [
    { gainDb: 6 },
    { gainDb: -9, fadeInSec: 1.5, fadeOutSec: 1.5 },
    { fadeInSec: 2 },
    { fadeOutSec: 0.75, gainDb: 3 },
    { mute: true, fadeInSec: 1 },
    { fadeInSec: 50, fadeOutSec: 50 },
    {}
  ];
  const cut = { start: 34, end: 38 };
  const duration = cut.end - cut.start;
  for (const audio of audios) {
    const resolved = resolveAudio(audio, { duration });
    for (const mediaTime of [20, 33.9, 34, 35.2, 36.5, 37.99, 38, 38.2, 40, 99]) {
      for (const rate of [1, 1.5]) {
        const now = 7.25; // relógio do áudio em um ponto qualquer
        const plan = require('../src/core/audio/audioFilter').previewPlan(resolved, { ...cut, mediaTime, rate, now, graceSec: GRACE });
        assert.ok(plan.length >= 1);
        assert.deepEqual(plan.map((s) => s.time), [...plan.map((s) => s.time)].sort((x, y) => x - y), 'eventos em ordem cronológica (exigência do AudioParam)');
        assert.ok(plan.every((s) => s.time >= now && Number.isFinite(s.value) && s.value >= 0), 'nada no passado, valores finitos e não negativos');
        for (let k = 0; k <= 60; k++) {
          const tau = now + (k / 60) * 8; // 8 s de relógio de áudio
          const media = mediaTime + (tau - now) * rate; // posição do vídeo nesse instante
          let expected = null;
          if (media >= cut.start && media <= cut.end) expected = envelopeAt(resolved, media - cut.start, duration);
          else if (media > cut.end && media <= cut.end + GRACE) expected = envelopeAt(resolved, duration, duration);
          else if (media >= cut.end + GRACE + 0.06 || (media < cut.start - 0.025 && mediaTime < cut.start)) expected = 1;
          if (mediaTime >= cut.end + GRACE) expected = 1; // já passou da folga: som normal
          if (expected === null) continue; // trechos de transição (rampas curtas): só ordem e limites acima
          const got = paramValue(plan, tau);
          near(got, expected, 1e-6 + 0.02 * Math.max(expected, 1), `audio ${JSON.stringify(audio)} m0=${mediaTime} rate=${rate} τ=${(tau - now).toFixed(2)}s`);
        }
      }
    }
  }
});

test('plano da prévia: começo do corte com fade in parte do silêncio e sobe até o ganho', () => {
  const { previewPlan } = require('../src/core/audio/audioFilter');
  const resolved = resolveAudio({ gainDb: 6, fadeInSec: 1, fadeOutSec: 1 }, { duration: 4 });
  const plan = previewPlan(resolved, { start: 10, end: 14, mediaTime: 10, rate: 1, now: 100, graceSec: 0.3 });
  assert.deepEqual(plan.map((s) => [s.op, Math.round(s.value * 1000) / 1000, Math.round((s.time - 100) * 1000) / 1000]), [
    ['set', 0, 0], ['ramp', 1.995, 1], ['ramp', 1.995, 3], ['ramp', 0, 4], ['set', 0, 4.3], ['ramp', 1, 4.35]
  ]);
  // antes do corte: som normal, rampa curta e só então o fade
  const before = previewPlan(resolved, { start: 10, end: 14, mediaTime: 8, rate: 1, now: 0, graceSec: 0.3 });
  assert.deepEqual(before.slice(0, 3).map((s) => [s.op, s.value, Math.round(s.time * 1000) / 1000]), [['set', 1, 0], ['set', 1, 1.98], ['ramp', 0, 2]]);
  // bem depois do fim: só o som normal
  assert.deepEqual(previewPlan(resolved, { start: 10, end: 14, mediaTime: 20, now: 5 }), [{ op: 'set', value: 1, time: 5 }]);
});
