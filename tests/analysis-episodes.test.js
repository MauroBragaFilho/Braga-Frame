'use strict';

/**
 * EPISÓDIOS e TELAS DE ESPERA (params.episodes; segments.js; docs/recursos/analysis.md, "Episódios e telas de espera"): a espera entre
 * programas é achada pela imagem parada, pelo silêncio e pela falta de fala; fica fora de qualquer sugestão; e cada episódio ganha pelo
 * menos uma sugestão quando tem pico acima da relevância mínima. Sinais sintéticos com horários conhecidos (sem ffmpeg: os sinais lidos
 * entram pelo cache, como numa segunda análise do mesmo vídeo).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBreaks, episodeAt, BREAK_MIN_SEC } = require('../src/core/analysis/segments');
const { combine } = require('../src/core/analysis/combine');
const { analyzeSource } = require('../src/core/analysis/analyze');
const { AnalysisCache, sourceKey } = require('../src/core/analysis/cache');
const params = require('../src/core/analysis/params');
const { chanceBaseline } = require('../scripts/eval-analysis');

// live sintética: espera 0-60, programa 60-400, espera 400-520, programa 520-900, espera 900-960, programa 960-1300, espera 1300-1360
const PLAN = [['wait', 0, 60], ['show', 60, 400], ['wait', 400, 520], ['show', 520, 900], ['wait', 900, 960], ['show', 960, 1300], ['wait', 1300, 1360]];
const N = 1360;
const BREAKS = [{ start: 0, end: 60 }, { start: 400, end: 520 }, { start: 900, end: 960 }, { start: 1300, end: 1360 }];
const EPISODES = [{ start: 60, end: 400 }, { start: 520, end: 900 }, { start: 960, end: 1300 }];

/**
 * `music`: a espera toca música (som alto, sem fala). `leak`: a transcrição "vaza" 15 s para dentro de cada espera (o Whisper inventa fala
 * no silêncio). `plan`: outro roteiro. Câmera de verdade mexe sempre um pouco (1 a 4%); a arte de espera, nada.
 */
function live({ music = false, leak = false, plan = PLAN } = {}) {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const motion = [];
  const db = [];
  const cues = [];
  for (const [kind, a, b] of plan) {
    for (let k = a; k < b; k += 1) {
      motion.push(kind === 'show' ? 1 + 3 * rnd() : 0);
      for (let h = 0; h < 2; h += 1) db.push(kind === 'show' ? -40 + 6 * rnd() : music ? -28 : -100);
    }
    if (kind === 'show') for (let t = a + 1; t < b - 3; t += 5) cues.push({ start: t, end: t + 4, text: 'a gente estava falando disso.' });
    else if (leak) cues.push({ start: a + 5, end: a + 20, text: 'obrigado.' });
  }
  const n = plan[plan.length - 1][2];
  return { image: { seconds: n, motion, scene: new Array(n).fill(0), fast: false, partial: false, tail: '' }, audio: { windowSec: 0.5, db, partial: false, tail: '' }, cues, n };
}

const plain = (list) => list.map(({ start, end }) => ({ start, end }));

test('espera e episódios: achados com qualquer combinação de imagem, som e transcrição', () => {
  const L = live();
  const combos = {
    'imagem, som e texto': { image: L.image, audio: L.audio, cues: L.cues },
    'imagem e som': { image: L.image, audio: L.audio },
    'imagem e texto': { image: L.image, cues: L.cues },
    'som e texto': { audio: L.audio, cues: L.cues },
    'só imagem': { image: L.image },
    'só som': { audio: L.audio }
  };
  for (const [name, input] of Object.entries(combos)) {
    const r = findBreaks({ ...input, n: N });
    assert.deepEqual(plain(r.breaks), BREAKS, name);
    assert.deepEqual(plain(r.episodes), EPISODES, name);
  }
  assert.deepEqual(findBreaks({ cues: L.cues, n: N }), { breaks: [], episodes: [] }, 'só texto não decide: falta de fala também é jogo sem narração');
  assert.equal(episodeAt(EPISODES, 61), 1);
  assert.equal(episodeAt(EPISODES, 700), 2);
  assert.equal(episodeAt(EPISODES, 450), null, 'na espera não há episódio');
});

test('espera: a transcrição que vaza não engana (duas evidências bastam); música na espera precisa da transcrição; capa parada com fala é programa', () => {
  const leak = live({ leak: true });
  assert.deepEqual(plain(findBreaks({ image: leak.image, audio: leak.audio, cues: leak.cues, n: N }).breaks), BREAKS, 'imagem parada e silêncio ganham da fala inventada');

  const music = live({ music: true });
  assert.deepEqual(plain(findBreaks({ image: music.image, audio: music.audio, cues: music.cues, n: N }).breaks), BREAKS, 'imagem parada e sem fala: espera, mesmo com música');
  assert.deepEqual(findBreaks({ image: music.image, audio: music.audio, n: N }).breaks, [], 'sem transcrição, imagem parada com som pode ser podcast com capa: não marca');

  // podcast só de áudio com a capa parada o vídeo inteiro: imagem parada, mas com som e fala o tempo todo
  const cover = live({ plan: [['show', 0, 1200]] });
  cover.image.motion = cover.image.motion.map(() => 0);
  assert.deepEqual(findBreaks({ image: cover.image, audio: cover.audio, cues: cover.cues, n: 1200 }).breaks, []);
});

test('espera: pausa curta não conta, animação curta não quebra, modo rápido não usa a imagem e vídeo parado demais não marca nada', () => {
  const short = live({ plan: [['show', 0, 300], ['wait', 300, 300 + BREAK_MIN_SEC - 5], ['show', 325, 700]] });
  assert.deepEqual(findBreaks({ image: short.image, audio: short.audio, n: 700 }).breaks, [], `menos de ${BREAK_MIN_SEC} s é pausa`);

  const anim = live({ plan: [['show', 0, 300], ['wait', 300, 340], ['show', 340, 344], ['wait', 344, 400], ['show', 400, 700]] });
  assert.deepEqual(plain(findBreaks({ image: anim.image, audio: anim.audio, n: 700 }).breaks), [{ start: 300, end: 400 }], 'buraco de 4 s dentro da espera');

  const L = live();
  const fast = { ...L.image, fast: true };
  const loud = { windowSec: 0.5, db: L.audio.db.map(() => -35) };
  assert.deepEqual(findBreaks({ image: fast, audio: loud, n: N }).breaks, [], 'no modo rápido os segundos sem quadro-chave parecem parados: a imagem fica de fora');
  assert.deepEqual(plain(findBreaks({ image: fast, audio: L.audio, n: N }).breaks), BREAKS, 'e o som decide sozinho');

  const still = live({ plan: [['wait', 0, 500], ['show', 500, 700], ['wait', 700, 1000]] });
  assert.deepEqual(findBreaks({ image: still.image, audio: still.audio, n: 1000 }), { breaks: [], episodes: [] }, 'mais de 60% parado e mudo: é o vídeo, não espera');
});

/** Sinal sintético: picos (instante, altura) com largura de ~3 s. */
function signal(n, peaks) {
  const score = new Float64Array(n);
  for (const [at, h] of peaks) for (let k = Math.max(0, at - 3); k <= Math.min(n - 1, at + 3); k += 1) score[k] = Math.max(score[k], h * (1 - Math.abs(k - at) / 4));
  return { id: 'audio', score, describe: () => [{ text: 'pico', strength: 1 }] };
}

test('cota por episódio: cada episódio ganha a melhor sugestão dele; sem a cota, o episódio forte leva tudo; a espera nunca entra', () => {
  const p = params.normalizeParams({ maxSuggestions: 3, weights: { audio: 1 } });
  const sig = signal(N, [[100, 0.95], [160, 0.94], [220, 0.93], [280, 0.92], [450, 0.99], [700, 0.6], [1100, 0.55]]);
  const walls = BREAKS.map((b) => ({ ...b, gap: 0 }));
  const inBreak = (s) => BREAKS.some((b) => s.start < b.end && s.end > b.start);

  const quota = combine({ n: N, duration: N, signals: [sig], params: p, blocked: walls, groups: EPISODES });
  assert.equal(quota.length, 3);
  assert.deepEqual(quota.map((s) => episodeAt(EPISODES, s.peak)).sort(), [1, 2, 3], 'um em cada episódio');
  assert.ok(quota.some((s) => Math.abs(s.peak - 100.5) <= 1), 'no episódio 1, o melhor pico dele');
  assert.ok(!quota.some(inBreak), 'nada na espera, nem o pico mais alto do vídeo (450 s)');

  const free = combine({ n: N, duration: N, signals: [sig], params: p, blocked: walls });
  assert.deepEqual(free.map((s) => episodeAt(EPISODES, s.peak)), [1, 1, 1], 'sem a cota, os três picos mais altos (todos no episódio 1)');
  const old = combine({ n: N, duration: N, signals: [sig], params: p });
  assert.ok(old.some(inBreak), 'sem a espera bloqueada, o pico da espera vira sugestão (o defeito que isto resolve)');

  // episódio sem nenhum pico acima da relevância mínima fica sem; a vaga volta para a escolha de sempre
  const weak = signal(N, [[100, 0.95], [160, 0.94], [700, 0.6], [1100, 0.4]]);
  const partial = combine({ n: N, duration: N, signals: [weak], params: p, blocked: walls, groups: EPISODES });
  assert.deepEqual(partial.map((s) => episodeAt(EPISODES, s.peak)).sort(), [1, 1, 2]);

  // a espera não tem folga: o corte pode começar no instante em que ela acaba (a folga entre sugestões continua valendo entre elas)
  const edge = combine({ n: N, duration: N, signals: [signal(N, [[522, 0.9]])], params: p, blocked: walls, groups: EPISODES });
  assert.equal(edge[0].start, 520);
});

test('analyzeSource: a espera fica fora, cada episódio tem sugestão e o resultado traz episódios e esperas; desligado, é o de antes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-episodes-'));
  const file = path.join(tmp, 'live.mp4');
  fs.writeFileSync(file, 'sinais em cache: o arquivo não é lido, mas a chave do cache vem dele');
  try {
    const L = live();
    // o episódio 1 é bem mais animado que os outros dois
    for (const at of [100, 160, 220, 280, 340]) for (let k = at * 2; k < at * 2 + 8; k += 1) L.audio.db[k] = -12;
    for (const at of [700, 1100]) for (let k = at * 2; k < at * 2 + 8; k += 1) L.audio.db[k] = -22;
    const cacheDir = path.join(tmp, 'cache');
    const cache = new AnalysisCache(cacheDir);
    const key = sourceKey(file);
    cache.set('sig-audio', key, L.audio);
    cache.set('sig-image', `${key}0`, L.image);
    const deps = { ffmpeg: path.join(tmp, 'sem-ffmpeg.exe'), cacheDir };
    const request = (extra) => ({
      file, duration: N, hasAudio: true, transcript: { cues: L.cues },
      params: { signals: { chat: false, calm: false }, maxSuggestions: 3, ...extra }
    });

    const on = await analyzeSource(request({}), deps);
    assert.deepEqual(plain(on.breaks), BREAKS);
    assert.deepEqual(plain(on.episodes), EPISODES);
    assert.equal(on.params.episodes, true, 'ligado por padrão');
    assert.deepEqual(on.suggestions.map((s) => s.episode).sort(), [1, 2, 3]);
    for (const s of on.suggestions) assert.ok(!BREAKS.some((b) => s.start < b.end && s.end > b.start), `${s.start}-${s.end} fora da espera`);

    const off = await analyzeSource(request({ episodes: false }), deps);
    assert.deepEqual(off.breaks, []);
    assert.deepEqual(off.episodes, []);
    assert.ok(off.suggestions.every((s) => s.episode === undefined));
    assert.ok(off.suggestions.filter((s) => episodeAt(EPISODES, s.peak) === 1).length >= 2, 'sem a cota, o episódio animado leva quase tudo');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('avaliação: o acaso justo sorteia só fora das telas de espera (e acerta mais que o sorteio no vídeo inteiro)', () => {
  // gabarito denso no programa (um item a cada 40 s), nada na espera
  const gold = [];
  for (const e of EPISODES) for (let t = e.start + 10; t < e.end - 30; t += 40) gold.push({ s: t, e: t + 25 });
  const sugs = [{ start: 100, end: 130 }, { start: 600, end: 630 }, { start: 1000, end: 1030 }];
  const whole = chanceBaseline(sugs, gold, N, { draws: 3000 });
  const fair = chanceBaseline(sugs, gold, N, { draws: 3000, exclude: BREAKS });
  assert.equal(fair.contentSec, N - 300);
  assert.equal(whole.contentSec, undefined);
  assert.ok(fair.mean > whole.mean, `o acaso que não perde sorteio na espera acerta mais (${fair.mean} > ${whole.mean})`);
  assert.equal(fair.hits, whole.hits, 'os acertos reais não mudam');
});
