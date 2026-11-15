'use strict';

const crypto = require('node:crypto');
const { normalizeAlgorithmLists } = require('./humor');

/**
 * Parâmetros da análise (PROVISÓRIOS: o dono do produto ainda não definiu os "sinais e critérios").
 * Tudo é configurável; `normalizeParams` valida e limita cada valor, então o IPC nunca confia no renderer.
 *
 * Versão do algoritmo: mude quando a forma de calcular mudar, para invalidar o cache.
 *  3: a duração do vídeo (ffprobe) passou a limitar as sugestões (antes o fim podia passar dela) e surgiram os avisos de
 *     cobertura (AUDIO_SHORT, IMAGE_SHORT, AUDIO_SILENT); resultados guardados pela versão 2 podiam ter o defeito.
 *  4: recalibragem (docs/recursos/analise-ia.md, seção 13): o áudio passou a ser medido contra o NÍVEL DE FALA do trecho (só quadros
 *     acima do piso de ruído; a subida de silêncio para fala deixou de ser pico), as pontuações são logísticas (nunca 1,0), há o
 *     sinal de TEXTO (transcrição), o desempate é pela pontuação e as sugestões se distribuem por toda a duração.
 *  5: novo sinal de MOMENTO CALMO (calmSignal.js): trechos tranquilos, sem fala e sem pico, mas vivos (som e imagem continuam); resultados
 *     guardados pela versão 4 não o têm.
 * (sem mudar a versão) PERFIL do vídeo (`profile`: 'gameplay' | 'conversa'). No perfil de CONVERSA (podcast, entrevista, live de
 *     bate-papo) a repetição só conta como laço/bordão (a mesma frase em várias falas), entra a pista de ESTRUTURA (conselho, história,
 *     opinião, pergunta com resposta), as trocas de câmera e as fusões deixam de contar como acontecimento na imagem e os cortes começam e
 *     terminam em frase completa. A versão continua 5 de propósito: a leitura do vídeo (áudio e imagem guardados no cache) não mudou, o
 *     gameplay calcula igual e o perfil e a pista nova entram nos parâmetros, que já fazem parte da chave do resultado. Mudar a versão
 *     faria todo vídeo ser lido de novo à toa (numa live de 2 h, ~14 min).
 */
const ALGO_VERSION = 5;

/** Perfis do vídeo (ver acima). Gameplay é o padrão e o comportamento de sempre. */
const PROFILES = Object.freeze(['gameplay', 'conversa']);

/** Lista inicial de palavras-chave do chat (editável pelo usuário; vazia = sem esse critério). */
const DEFAULT_KEYWORDS = Object.freeze(['clip', 'pog', 'omg', 'wtf']);

/** Pistas da transcrição (textSignal.js): peso de cada uma, de 0 (desliga) a 2. */
const TEXT_FEATURES = Object.freeze(['laugh', 'exclaim', 'pace', 'repeat', 'meta', 'humor', 'structure']);

const DEFAULTS = Object.freeze({
  signals: Object.freeze({ audio: true, image: true, chat: true, text: true, calm: true }),
  sensitivity: 3, // 1 (só o que se destaca muito) .. 5 (pega até o que se destaca pouco)
  perHour: 6, // quantidade de sugestões por hora de vídeo
  maxSuggestions: null, // teto absoluto (substitui perHour quando informado)
  weights: Object.freeze({ audio: 0.8, image: 0.6, chat: 1, text: 1, calm: 0.7 }), // o calmo pesa menos: sozinho só passa quando é bem claro
  // peso de cada pista da transcrição (só vale com transcrição)
  profile: 'gameplay', // 'gameplay' | 'conversa' (PROFILES)
  // live com vários programas separados por tela de espera (segments.js): a espera fica fora e cada episódio ganha pelo menos uma sugestão
  episodes: true,
  // `structure` só existe no perfil de conversa (no de gameplay o peso não muda nada)
  textWeights: Object.freeze({ laugh: 1, exclaim: 1, pace: 1, repeat: 1, meta: 1, humor: 1, structure: 1 }),
  // perfil de humor do canal (humor.js; vem da preferência analysis.humor): bordões e palavras de reação, sem acento e em minúsculas
  humor: Object.freeze({ phrases: Object.freeze([]), reactions: Object.freeze([]) }),
  // vêm das preferências (BF.prefs): analysis.*
  padBeforeSec: 3,
  padAfterSec: 2,
  minDurationSec: 15,
  maxDurationSec: 60,
  minRelevance: 0.5,
  alignToleranceSec: 2, // sinais até 2 s fora de sincronia ainda "concordam"
  baselineSec: 600, // a linha de base (mediana/MAD, média do chat) é local, em blocos de 10 min
  // distribuição das sugestões pela duração: no máximo `perWindow` por janela de `windowSec` (null = o dobro da média, mínimo 2) e
  // `minGapSec` de folga entre uma sugestão e a próxima
  spread: Object.freeze({ windowSec: 600, perWindow: null, minGapSec: 5 }),
  chat: Object.freeze({ windowSec: 10, lagSec: 6, minMessages: 6, keywords: DEFAULT_KEYWORDS }),
  image: Object.freeze({ fast: false }) // true = só quadros-chave (bem mais rápido, bem mais grosseiro)
});

const RANGES = Object.freeze({
  sensitivity: [1, 5],
  perHour: [1, 60],
  maxSuggestions: [1, 500],
  weight: [0, 2],
  padBeforeSec: [0, 60],
  padAfterSec: [0, 60],
  minDurationSec: [3, 120],
  maxDurationSec: [5, 180],
  minRelevance: [0, 1],
  alignToleranceSec: [0, 10],
  baselineSec: [60, 3600],
  chatWindowSec: [2, 60],
  chatLagSec: [0, 60],
  chatMinMessages: [1, 100],
  spreadWindowSec: [120, 3600],
  spreadPerWindow: [1, 100],
  spreadMinGapSec: [0, 300]
});

/**
 * Limiares por sensibilidade (1..5; interpola valores quebrados). Cada linha tem 5 valores, do menos
 * sensível ao mais sensível. "x0" é onde a pontuação do sinal começa a subir; a rampa (logística, nunca 1,0)
 * chega a cerca de 90% do teto após `span` unidades a mais.
 */
const SENSITIVITY_TABLE = Object.freeze({
  audioZ0: [2.2, 1.7, 1.3, 1.0, 0.7], // desvios (σ robustos) do nível sustentado de fala acima do normal DAQUELE trecho
  audioZSpan: 1.6,
  audioRise0: [18, 15, 12, 10, 8], // subida brusca em dB sobre os ~10 s anteriores de fala (de silêncio para fala não conta)
  audioRiseSpan: 8,
  chatRatio0: [4, 3, 2.4, 2, 1.7], // vezes a média local de mensagens
  chatRatioSpan: 3,
  chatKeywords0: [5, 4, 3, 3, 2], // mensagens com palavra-chave na janela
  chatKeywordsSpan: 4,
  sceneScore0: [16, 12, 9, 7, 5], // pontuação do scdet (0..100)
  sceneScoreSpan: 18,
  motionZ0: [5, 4, 3.2, 2.7, 2.2],
  motionZSpan: 3,
  calmDrop0: [14, 12, 10, 8, 6], // dB que o trecho precisa estar abaixo do volume normal do vídeo para começar a contar como calmo
  calmSpan: 8,
  // transcrição (textSignal.js)
  textLaugh0: [0, 0, 0, 0, 0], // marcas de risada nos ~15 s seguintes (uma risada longa vale até 3)
  textLaughSpan: [2.5, 2, 1.5, 1.2, 1],
  textExclaim0: [2, 1.5, 1, 0.8, 0.5], // unidades de exclamação/reação em ~17 s
  textExclaimSpan: [3, 3, 3, 3, 3],
  textPace0: [2.5, 2, 1.5, 1.2, 0.9], // desvios do ritmo de fala (palavras/s) acima do normal do trecho
  textPaceSpan: [2.5, 2.5, 2.5, 2.5, 2.5],
  textRepeat0: [1.5, 1.1, 0.8, 0.5, 0.3], // repetições de par de palavras ou de palavra de conteúdo em ~17 s
  textRepeatSpan: [3, 3, 3, 3, 3],
  textMeta0: [0, 0, 0, 0, 0], // falas sobre o próprio momento ("vou clipar", "olha isso") em ~25 s
  textMetaSpan: [2, 1.8, 1.6, 1.3, 1],
  textHumor0: [0, 0, 0, 0, 0], // bordões do canal nos ~17 s ao redor: UM já conta (o usuário disse que é pista); dois são quase o teto
  textHumorSpan: [2, 1.8, 1.5, 1.3, 1.1],
  // perfil de conversa: unidades de estrutura (conselho 1; história, opinião e pergunta com resposta 0,5) em ~25 s ao redor
  textStructure0: [2.5, 2, 1.5, 1.2, 0.9],
  textStructureSpan: [3, 3, 3, 3, 3]
});

function lerpTable(row, sensitivity) {
  const x = Math.min(Math.max(sensitivity, 1), 5) - 1;
  const lo = Math.floor(x);
  const hi = Math.min(4, lo + 1);
  return row[lo] + (row[hi] - row[lo]) * (x - lo);
}

/** Limiares efetivos para uma sensibilidade. */
function thresholds(sensitivity) {
  const t = SENSITIVITY_TABLE;
  const row = (r) => (Array.isArray(r) ? lerpTable(r, sensitivity) : r);
  return {
    audioZ0: lerpTable(t.audioZ0, sensitivity),
    audioZSpan: t.audioZSpan,
    audioRise0: lerpTable(t.audioRise0, sensitivity),
    audioRiseSpan: t.audioRiseSpan,
    chatRatio0: lerpTable(t.chatRatio0, sensitivity),
    chatRatioSpan: t.chatRatioSpan,
    chatKeywords0: Math.round(lerpTable(t.chatKeywords0, sensitivity)),
    chatKeywordsSpan: t.chatKeywordsSpan,
    sceneScore0: lerpTable(t.sceneScore0, sensitivity),
    sceneScoreSpan: t.sceneScoreSpan,
    motionZ0: lerpTable(t.motionZ0, sensitivity),
    motionZSpan: t.motionZSpan,
    calmDrop0: lerpTable(t.calmDrop0, sensitivity),
    calmSpan: t.calmSpan,
    textLaugh0: row(t.textLaugh0),
    textLaughSpan: row(t.textLaughSpan),
    textExclaim0: row(t.textExclaim0),
    textExclaimSpan: row(t.textExclaimSpan),
    textPace0: row(t.textPace0),
    textPaceSpan: row(t.textPaceSpan),
    textRepeat0: row(t.textRepeat0),
    textRepeatSpan: row(t.textRepeatSpan),
    textMeta0: row(t.textMeta0),
    textMetaSpan: row(t.textMetaSpan),
    textHumor0: row(t.textHumor0),
    textHumorSpan: row(t.textHumorSpan),
    textStructure0: row(t.textStructure0),
    textStructureSpan: row(t.textStructureSpan)
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function num(value, [lo, hi], fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** Palavras-chave: texto sem acento e em minúsculas, sem repetidas nem vazias (máx. 50 de até 40 letras). */
function normalizeKeyword(word) {
  return String(word).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function keywordList(value, fallback) {
  const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(/[,\n;]/) : null);
  if (!list) return [...fallback];
  const out = [];
  for (const word of list) {
    if (typeof word !== 'string') continue;
    const k = normalizeKeyword(word);
    if (k && k.length <= 40 && !out.includes(k)) out.push(k);
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Valida o que veio de fora e devolve os parâmetros efetivos (todos os campos presentes). Valor
 * inválido volta ao padrão em vez de derrubar a análise.
 */
function normalizeParams(raw) {
  const src = isObj(raw) ? raw : {};
  const d = DEFAULTS;
  const sig = isObj(src.signals) ? src.signals : {};
  const w = isObj(src.weights) ? src.weights : {};
  const tw = isObj(src.textWeights) ? src.textWeights : {};
  const sp = isObj(src.spread) ? src.spread : {};
  const chat = isObj(src.chat) ? src.chat : {};
  const image = isObj(src.image) ? src.image : {};
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

  const minDurationSec = num(src.minDurationSec, RANGES.minDurationSec, d.minDurationSec);
  const maxDurationSec = Math.max(minDurationSec, num(src.maxDurationSec, RANGES.maxDurationSec, d.maxDurationSec));
  const maxSuggestions = src.maxSuggestions === null || src.maxSuggestions === undefined
    ? null
    : Math.round(num(src.maxSuggestions, RANGES.maxSuggestions, 10));
  const perWindow = sp.perWindow === null || sp.perWindow === undefined
    ? d.spread.perWindow
    : Math.round(num(sp.perWindow, RANGES.spreadPerWindow, 2));

  return {
    signals: {
      audio: bool(sig.audio, d.signals.audio), image: bool(sig.image, d.signals.image),
      chat: bool(sig.chat, d.signals.chat), text: bool(sig.text, d.signals.text), calm: bool(sig.calm, d.signals.calm)
    },
    sensitivity: num(src.sensitivity, RANGES.sensitivity, d.sensitivity),
    perHour: num(src.perHour, RANGES.perHour, d.perHour),
    maxSuggestions,
    weights: {
      audio: num(w.audio, RANGES.weight, d.weights.audio),
      image: num(w.image, RANGES.weight, d.weights.image),
      chat: num(w.chat, RANGES.weight, d.weights.chat),
      text: num(w.text, RANGES.weight, d.weights.text),
      calm: num(w.calm, RANGES.weight, d.weights.calm)
    },
    textWeights: Object.fromEntries(TEXT_FEATURES.map((id) => [id, num(tw[id], RANGES.weight, d.textWeights[id])])),
    humor: normalizeAlgorithmLists(src.humor),
    padBeforeSec: num(src.padBeforeSec, RANGES.padBeforeSec, d.padBeforeSec),
    padAfterSec: num(src.padAfterSec, RANGES.padAfterSec, d.padAfterSec),
    minDurationSec,
    maxDurationSec,
    minRelevance: num(src.minRelevance, RANGES.minRelevance, d.minRelevance),
    alignToleranceSec: Math.round(num(src.alignToleranceSec, RANGES.alignToleranceSec, d.alignToleranceSec)),
    baselineSec: num(src.baselineSec, RANGES.baselineSec, d.baselineSec),
    spread: {
      windowSec: Math.round(num(sp.windowSec, RANGES.spreadWindowSec, d.spread.windowSec)),
      perWindow,
      minGapSec: num(sp.minGapSec, RANGES.spreadMinGapSec, d.spread.minGapSec)
    },
    chat: {
      windowSec: Math.round(num(chat.windowSec, RANGES.chatWindowSec, d.chat.windowSec)),
      lagSec: Math.round(num(chat.lagSec, RANGES.chatLagSec, d.chat.lagSec)),
      minMessages: Math.round(num(chat.minMessages, RANGES.chatMinMessages, d.chat.minMessages)),
      keywords: keywordList(chat.keywords, d.chat.keywords)
    },
    image: { fast: bool(image.fast, d.image.fast) },
    profile: PROFILES.includes(src.profile) ? src.profile : d.profile,
    episodes: bool(src.episodes, d.episodes)
  };
}

/** Teto de sugestões: `maxSuggestions` se informado; senão `perHour` x horas (mínimo 3, máximo 300). */
function suggestionLimit(params, durationSec) {
  if (params.maxSuggestions) return params.maxSuggestions;
  return Math.min(300, Math.max(3, Math.round(params.perHour * (durationSec / 3600))));
}

/**
 * Máximo de sugestões por janela de `spread.windowSec` (padrão 10 min): `spread.perWindow` se informado; senão o DOBRO da média
 * (limite x janela / duração), no mínimo 2. Assim a cota é a mesma em qualquer parte do vídeo e nenhum trecho animado consome
 * sozinho a cota inteira (o defeito da linha de base: tudo concentrado na abertura da live).
 */
function perWindowLimit(params, durationSec, limit = suggestionLimit(params, durationSec)) {
  if (params.spread.perWindow) return params.spread.perWindow;
  const average = durationSec > 0 ? (limit * params.spread.windowSec) / durationSec : limit;
  return Math.max(2, Math.ceil(2 * average));
}

/**
 * Os momentos calmos têm uma cota própria, além da quantidade pedida: um quarto dela (no mínimo 1). Sem isto o calmo (que pesa menos de propósito:
 * sozinho nunca passa de ~68%) seria sempre engolido pelos picos e nunca apareceria. Quando o calmo é o único sinal, vale a quantidade inteira.
 */
function calmLimit(params, durationSec) {
  return Math.max(1, Math.round(suggestionLimit(params, durationSec) * 0.25));
}

/** JSON com chaves em ordem fixa (base de chaves de cache estáveis). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObj(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

module.exports = {
  ALGO_VERSION, DEFAULTS, DEFAULT_KEYWORDS, TEXT_FEATURES, PROFILES, RANGES, SENSITIVITY_TABLE,
  normalizeParams, normalizeKeyword, thresholds, suggestionLimit, perWindowLimit, calmLimit, canonicalJson, sha1
};
