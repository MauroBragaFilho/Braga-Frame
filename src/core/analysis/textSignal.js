'use strict';

const { normText, isLaughter } = require('./transcript/format');
const { softRamp, noisyOr, clamp01, median, mad, MAD_TO_SIGMA, localBaseline, prefixSums } = require('./stats');

/**
 * Sinal de TEXTO: a transcrição do vídeo (falas com horário) vira uma pontuação por segundo (0..1). É o melhor sinal quando existe
 * (docs/recursos/analise-ia.md, seção 2): os bons momentos de uma live têm risada, exclamação, fala rápida, bordão repetido e o
 * próprio streamer dizendo "olha isso" / "vou clipar". Regras simples e explicáveis, sem IA e sem enviar nada para fora.
 *
 * Seis pistas, cada uma uma pontuação suave (logística, nunca 1,0) calculada em uma janela ao redor do segundo:
 *   laugh    marcas de risada (`*Risos*`) logo DEPOIS do lance: o segundo pontua nos ~15 s que antecedem a risada;
 *   exclaim  exclamações ("!") e interjeições/palavrões de reação ("caralho", "nossa", "meu deus"...) por janela de ~17 s; as palavras de
 *            reação do PERFIL DE HUMOR do canal (humor.js) entram aqui, junto com as da lista do app;
 *   pace     ritmo de fala (palavras por segundo) acima do normal DAQUELE trecho (mediana/MAD local, só sobre trechos com fala);
 *   repeat   repetição de bordão: o mesmo par de palavras (ou a mesma palavra de conteúdo) se repete em poucos segundos;
 *   meta     o streamer fala do próprio momento ("vou clipar", "olha isso", "não acredito");
 *   humor    expressões do canal: os bordões que o usuário cadastrou no perfil de humor (humor.js) ditos na janela de ~17 s.
 *   structure (só no PERFIL DE CONVERSA) conselho/dica, história contada, opinião e pergunta seguida de resposta, em ~25 s.
 * O texto total é a soma de evidências independentes (ou ruidoso) das pistas, cada uma multiplicada pelo seu peso (0 desliga).
 *
 * Perfil de CONVERSA (podcast, entrevista, bate-papo; `profile: 'conversa'`): numa conversa, repetir palavra é hesitação ("uma agência de
 * marketing, mas era uma agência de marketing") ou ênfase ("rede social, rede social"), não bordão. Ali a repetição só conta como LAÇO: a
 * mesma frase curta é o miolo de pelo menos duas falas e aparece em três ou mais falas em ~25 s ("obrigado você" em sequência, "a satisfação
 * foi toda minha", "quem me conhece sabe"). E entra a pista de estrutura. Medido numa live real de podcast (docs/recursos/analysis.md, "Perfil de
 * conversa"): o laço aparece 2,4 vezes mais nos trechos que viraram cortes do que fora deles; a repetição do gameplay, 1,2 vez; conselho, 2,2.
 * Sem transcrição o sinal simplesmente não existe (a análise segue com áudio, imagem e chat).
 */

const FEATURES = ['laugh', 'exclaim', 'pace', 'repeat', 'meta', 'humor', 'structure'];

const WINDOW_BACK_SEC = 8; // janela simétrica das pistas de contagem (±8 s = 17 s)
const WINDOW_AHEAD_SEC = 8;
const LAUGH_BACK_SEC = 1; // a risada vem depois do lance: o segundo pontua se há risada nos próximos ~15 s
const LAUGH_AHEAD_SEC = 15;
const LAUGH_RUN_GAP_SEC = 4; // marcas de risada a menos disso uma da outra são a mesma risada
const LAUGH_RUN_MAX = 3; // uma risada longa vale no máximo isto (laços do reconhecimento não inflam a pontuação)
const REPEAT_LOOKBACK_SEC = 6; // uma fala "repete" outra dita até 6 s antes
const SHORT_CUE_WORDS = 4; // fala curta: até 4 palavras
const MAX_WORDS_PER_SEC = 6; // uma fala nunca concentra as palavras em menos tempo que isto (fala de 6 palavras por segundo no máximo)
const PACE_MIN_SPEECH = 0.4; // palavras/s mínimas para a janela contar como "fala" na linha de base do ritmo
const PACE_MIN_SCALE = 0.35; // piso do desvio do ritmo (palavras/s)
const PACE_MIN_SAMPLES = 60; // segundos de fala para o bloco ter linha de base própria
const PACE_Z_CAP = 6; // limite superior do desvio do ritmo
const HUMOR_CUE_MAX = 2; // uma fala vale no máximo isto de expressão do canal (a mesma fala repetindo o bordão não infla)
const HUMOR_COMMON_SHARE = 0.01; // expressão do perfil dita em mais de 1% das falas (no mínimo HUMOR_COMMON_MIN) é fala habitual do canal:
const HUMOR_COMMON_MIN = 6; // acima disso cada vez vale menos (limite / ocorrências), para o bordão de todo minuto não encher a lista
// perfil de conversa
const LOOP_WINDOW_SEC = 25; // um laço: a mesma frase em LOOP_MIN_CUES falas em até 25 s
const LOOP_MIN_CUES = 3;
const LOOP_MIN_COVER = 0.6; // a frase é o miolo da fala (60% das palavras dela ou mais) em pelo menos duas das falas
const LOOP_MAX_WORDS = 5; // frases de 2 a 5 palavras
const LOOP_HABITUAL_SHARE = 0.01; // frase presente em mais de 1% das falas (no mínimo LOOP_HABITUAL_MIN) é jeito de falar, não laço
const LOOP_HABITUAL_MIN = 8;
const STRUCTURE_BACK_SEC = 12; // janela da estrutura: ±12 s (os bons momentos de conversa são mais longos que os de gameplay)
const STRUCTURE_AHEAD_SEC = 12;
const QA_ANSWER_SEC = 25; // pergunta "com resposta": nos 25 s seguintes há pelo menos QA_MIN_SPEECH_SEC de fala
const QA_MIN_SPEECH_SEC = 10;
const STRUCTURE_CUE_MAX = 1.5; // uma fala vale no máximo isto de estrutura

/** Palavras de ligação e muletas: não contam como "palavra de conteúdo" na repetição. */
const STOP = new Set((
  'para como mais mas nao uma que tem esse essa isso aqui entao tambem ainda sobre voce voces pelo pela num numa dele dela eles elas ' +
  'quando onde muito muita tava esta estou vamos vai vou foi ser ter sao eram seja tudo todo toda cara mano velho veio tipo assim agora ' +
  'porque tinha estava fazer algum alguma nada coisa gente aquele aquela essas esses dessa desse nessa nesse pode sim vei bagulho negocio ' +
  'moleque pra pro com por dos das nos nas meu minha seu sua ele ela eu tu nos ate tao so ja la ai ta to ne'
).split(' '));

/** Interjeições e palavrões de reação (texto já normalizado: minúsculo, sem acento, sem pontuação). */
const REACTION_RE = new RegExp(`(?:^| )(?:${[
  'caralh\\w*', 'porra', 'puta que pariu', 'putz', 'merda', 'cacete', 'fod[aeo]\\w*', 'nossa(?: senhora)?', 'caramba', 'eita', 'uau',
  'socorro', 'meu deus', 'deus do ceu', 'pelo amor de deus', 'que isso', 'que merda', 'vish', 'aff', 'xii'
].join('|')})(?= |$)`);

/** O streamer fala do próprio momento ("vou clipar essa parte", "olha isso", "não acredito"). */
const META_RE = new RegExp(`(?:^| )(?:${[
  'clip(?:a|ar|e|es|ou)', 'vou (?:tentar )?clip\\w*', 'isso (?:vai|vale) (?:pro|pra|para) (?:o )?(?:corte|clip\\w*)', 'nao acredito',
  'nao e possivel', 'olha (?:isso|essa|so|aqui)', 'vem ver'
].join('|')})(?= |$)`);

/** Perfil de conversa: palavras de ligação que não contam na frase do laço ("me", "de", "a"...). */
const LOOP_STOP = new Set('a o e de da do das dos em na no nas nos um uma uns umas pra pro para com que se me te ne ai ta eh'.split(' '));

const wordsRe = (list) => new RegExp(`(?:^| )(?:${list.join('|')})(?= |$)`);
/** Perfil de conversa: conselho e dica ("primeiro de tudo", "tem que", "estudem", "não tenha pressa"). */
const ADVICE_RE = wordsRe(['dica\\w*', 'conselho\\w*', 'o segredo', 'primeiro de tudo', 'primeiramente', 'se voce', 'tem que', 'nao tenha',
  'estud(?:e|em|ar|ando)', 'faca(?:m)?', 'busque(?:m)?', 'acredit\\w+', 'o importante', 'licao', 'aprendi']);
/** Perfil de conversa: história contada ("teve um dia", "quando eu era", "na época"). */
const STORY_RE = wordsRe(['teve um dia', 'uma vez', 'quando eu era', 'na epoca', 'eu lembro', 'lembro que', 'aconteceu', 'historia\\w*',
  'desde crianca', 'infancia', 'naquela epoca', 'um dia']);
/** Perfil de conversa: opinião e frase de posição ("eu acredito", "a gente precisa", "não é só"). */
const OPINION_RE = wordsRe(['eu acredito', 'pra mim', 'a verdade', 'o problema', 'por que e que', 'a gente precisa', 'nos precisamos',
  'muito mais que', 'nao e so', 'muito importante']);

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Casador das expressões do PERFIL DE HUMOR do canal (humor.js) sobre a fala já normalizada (sem acento, minúscula, sem pontuação): a expressão
 * só vale como palavra(s) inteira(s) ("eita" não casa dentro de "receita") e a mais longa vence quando uma contém a outra ("puta que pariu" e
 * "puta"). Devolve { re, labels } (`labels`: expressão normalizada -> texto como o usuário escreveu, para o motivo mostrado) ou null sem expressões.
 */
function phraseMatcher(list) {
  const labels = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    const key = typeof item === 'string' ? normText(item) : '';
    if (key && !labels.has(key)) labels.set(key, item.replace(/\s+/g, ' ').trim());
  }
  if (!labels.size) return null;
  const alt = [...labels.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map(escapeRe).join('|');
  return { re: new RegExp(`(?:^| )(${alt})(?= |$)`, 'g'), labels };
}

/**
 * Peso de cada expressão do perfil conforme o quanto ela aparece: 1 até o limite (cerca de 1% das falas, no mínimo 6 falas) e limite / falas
 * acima dele. Um bordão dito em todo minuto é fala habitual do canal, não pista de um bom momento: sem isso ele encheria a lista de sugestões
 * (o mesmo cuidado de `habitualPhrases` com a repetição).
 */
function phraseWeights(cues, matcher) {
  const count = new Map();
  for (const cue of cues) {
    if (!cue || cue.laugh === true || isLaughter(cue.text)) continue;
    const norm = normText(cue.text || '');
    if (!norm) continue;
    const here = new Set();
    for (const m of norm.matchAll(matcher.re)) here.add(m[1]);
    for (const key of here) count.set(key, (count.get(key) || 0) + 1);
  }
  const limit = Math.max(HUMOR_COMMON_MIN, Math.ceil(cues.length * HUMOR_COMMON_SHARE));
  return (key) => {
    const inCues = count.get(key) || 0;
    return inCues > limit ? limit / inCues : 1;
  };
}

const wordsOf = (norm) => (norm ? norm.split(' ') : []);
const isNumber = (w) => /^\d+$/.test(w);
/** Palavra com peso para a repetição: três letras ou mais, ou um número ("21 reais"). */
const solid = (w) => w.length >= 3 || isNumber(w);

/**
 * Quantas falas contêm cada par de palavras e cada fala curta inteira (para ignorar o que o falante repete o tempo todo).
 * `limit` = acima disso a expressão é "habitual" (cerca de 0,4% das falas, no mínimo 4).
 */
function habitualPhrases(cues) {
  const pairs = new Map();
  const wholes = new Map();
  for (const cue of cues) {
    if (!cue || cue.laugh === true) continue;
    const norm = normText(cue.text || '');
    const ws = wordsOf(norm);
    if (!ws.length) continue;
    wholes.set(norm, (wholes.get(norm) || 0) + 1);
    const seen = new Set();
    for (let i = 0; i + 1 < ws.length; i += 1) seen.add(`${ws[i]} ${ws[i + 1]}`);
    for (const pair of seen) pairs.set(pair, (pairs.get(pair) || 0) + 1);
  }
  return { pairs, cues: wholes, limit: Math.max(4, Math.ceil(cues.length * 0.004)) };
}

/**
 * Perfil de conversa: laços de repetição. Uma frase de 2 a 5 palavras (sem as de ligação) que aparece em LOOP_MIN_CUES falas em até
 * LOOP_WINDOW_SEC e é o miolo (LOOP_MIN_COVER) de pelo menos duas delas: "obrigado você… obrigado você, fulano… obrigado você". Assunto
 * repetido ("fazer rede social para um restaurante… rede social para uma loja") não é miolo da fala e não conta; frase que o vídeo inteiro
 * repete (mais de 1% das falas) também não. Devolve Map(índice da fala em `list` -> laços, até 2).
 */
function loopRepeats(list) {
  const items = [];
  list.forEach((cue, index) => {
    if (!cue || !(cue.end > cue.start) || cue.laugh === true || isLaughter(cue.text)) return;
    const toks = wordsOf(normText(cue.text || '')).filter((w) => !LOOP_STOP.has(w));
    if (toks.length >= 2) items.push({ index, start: cue.start, toks, padded: ` ${toks.join(' ')} ` });
  });
  const grams = (toks) => {
    const out = new Set();
    for (let len = 2; len <= LOOP_MAX_WORDS; len += 1) {
      for (let k = 0; k + len <= toks.length; k += 1) {
        const g = toks.slice(k, k + len);
        if (g.some(solid)) out.add(g.join(' '));
      }
    }
    return out;
  };
  const inCues = new Map();
  for (const it of items) for (const g of grams(it.toks)) inCues.set(g, (inCues.get(g) || 0) + 1);
  const habitual = Math.max(LOOP_HABITUAL_MIN, Math.ceil(items.length * LOOP_HABITUAL_SHARE));
  const hits = new Map();
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    for (const g of grams(it.toks)) {
      const len = g.split(' ').length;
      if (len / it.toks.length < LOOP_MIN_COVER || inCues.get(g) > habitual) continue;
      const members = [it];
      let core = 1;
      for (let j = i + 1; j < items.length && items[j].start - it.start <= LOOP_WINDOW_SEC; j += 1) {
        if (!items[j].padded.includes(` ${g} `)) continue;
        members.push(items[j]);
        if (len / items[j].toks.length >= LOOP_MIN_COVER) core += 1;
      }
      if (members.length >= LOOP_MIN_CUES && core >= 2) {
        for (const m of members) hits.set(m.index, Math.min(2, (hits.get(m.index) || 0) + 1));
      }
    }
  }
  return hits;
}

/**
 * Perfil de conversa: unidades de estrutura de cada fala (conselho 1; história, opinião e pergunta seguida de resposta 0,5; até
 * STRUCTURE_CUE_MAX). Devolve Map(índice da fala -> unidades).
 */
function structureUnits(list) {
  const out = new Map();
  list.forEach((cue, index) => {
    if (!cue || !(cue.end > cue.start) || cue.laugh === true || isLaughter(cue.text)) return;
    const text = String(cue.text || '');
    const norm = normText(text);
    if (!norm) return;
    let units = 0;
    if (ADVICE_RE.test(norm)) units += 1;
    if (STORY_RE.test(norm)) units += 0.5;
    if (OPINION_RE.test(norm)) units += 0.5;
    if (/\?\s*$/.test(text)) {
      let speech = 0;
      for (let j = index + 1; j < list.length && list[j].start - cue.end <= QA_ANSWER_SEC; j += 1) {
        const c = list[j];
        if (c && c.end > c.start && !(c.laugh === true || isLaughter(c.text))) speech += Math.min(c.end, cue.end + QA_ANSWER_SEC) - c.start;
      }
      if (speech >= QA_MIN_SPEECH_SEC) units += 0.5;
    }
    if (units > 0) out.set(index, Math.min(STRUCTURE_CUE_MAX, units));
  });
  return out;
}

/**
 * Evidência por segundo extraída das falas. Devolve arrays de tamanho n:
 *   laugh (marcas de risada, uma por risada), exclaim (unidades de exclamação/reação), repeat, meta, humor (contagens) e words (palavras/s),
 *   mais `humorHits`: [{ sec, label }] com cada expressão do perfil dita (para o motivo da sugestão dizer qual foi).
 * `humor` = perfil do canal para o algoritmo (humor.js): { phrases:[bordões], reactions:[palavras de reação] }, ambos opcionais.
 * `profile` = 'gameplay' (padrão) ou 'conversa': no de conversa a repetição vira laço (loopRepeats) e `structure` é preenchido.
 * Função pura: serve também aos testes.
 */
function extractEvents(cues, n, humor = null, profile = 'gameplay') {
  const laugh = new Float64Array(n);
  const exclaim = new Float64Array(n);
  const repeat = new Float64Array(n);
  const meta = new Float64Array(n);
  const humorUnits = new Float64Array(n);
  const structure = new Float64Array(n);
  const humorHits = [];
  const words = new Float64Array(n);
  const list = Array.isArray(cues) ? cues : [];
  const phrases = phraseMatcher(humor && humor.phrases);
  const reactions = phraseMatcher(humor && humor.reactions);
  const phraseWeight = phrases ? phraseWeights(list, phrases) : null;
  const reactionWeight = reactions ? phraseWeights(list, reactions) : null;

  // marcas de risada vizinhas viram uma risada só (com valor até LAUGH_RUN_MAX)
  let runStart = -Infinity;
  let runLast = -Infinity;
  let runCount = 0;
  const closeRun = () => {
    if (runCount > 0) {
      const sec = Math.floor(runStart);
      if (sec >= 0 && sec < n) laugh[sec] += Math.min(LAUGH_RUN_MAX, runCount);
    }
    runCount = 0;
  };

  const conversa = profile === 'conversa';
  const loops = conversa ? loopRepeats(list) : null;
  const structureOf = conversa ? structureUnits(list) : null;
  const habitual = habitualPhrases(list);
  const recent = []; // falas dos últimos REPEAT_LOOKBACK_SEC s: { start, bigrams:Set, norm }
  for (let cueIndex = 0; cueIndex < list.length; cueIndex += 1) {
    const cue = list[cueIndex];
    if (!cue || !(cue.end > cue.start)) continue;
    const sec = Math.floor(cue.start);
    const isLaugh = cue.laugh === true || isLaughter(cue.text);
    if (isLaugh) {
      if (cue.start - runLast > LAUGH_RUN_GAP_SEC) { closeRun(); runStart = cue.start; }
      runCount += 1;
      runLast = cue.end;
      continue; // a marca de risada não é fala: não conta palavras nem repetição
    }
    const text = String(cue.text || '');
    const norm = normText(text);
    const ws = wordsOf(norm);
    if (!ws.length) continue;

    // palavras por segundo: espalhadas sobre a duração da fala (no mínimo palavras/6 s: ninguém fala mais rápido que isso)
    const spread = Math.max(cue.end - cue.start, ws.length / MAX_WORDS_PER_SEC);
    const from = Math.floor(cue.start);
    const to = Math.max(from + 1, Math.ceil(cue.start + spread));
    for (let k = Math.max(0, from); k < to && k < n; k += 1) words[k] += ws.length / (to - from);

    if (sec < 0 || sec >= n) continue;
    const bangs = (text.match(/!/g) || []).length;
    let reaction = REACTION_RE.test(norm) ? 1 : 0; // as palavras de reação do perfil do canal valem como as do app (menos se o canal as diz o tempo todo)
    if (reactions) for (const m of norm.matchAll(reactions.re)) reaction = Math.max(reaction, reactionWeight(m[1]));
    if (bangs || reaction > 0) exclaim[sec] += Math.min(1.5, (bangs ? 1 : 0) + 0.75 * reaction);
    if (META_RE.test(norm)) meta[sec] += 1;
    if (phrases) {
      let units = 0;
      for (const m of norm.matchAll(phrases.re)) {
        units += phraseWeight(m[1]);
        humorHits.push({ sec, label: phrases.labels.get(m[1]) });
      }
      if (units > 0) humorUnits[sec] += Math.min(HUMOR_CUE_MAX, units);
    }

    if (conversa) {
      // conversa: a repetição é só o laço (loopRepeats); a estrutura vem pronta de structureUnits
      if (loops.has(cueIndex)) repeat[sec] += loops.get(cueIndex);
      if (structureOf.has(cueIndex)) structure[sec] += structureOf.get(cueIndex);
      continue;
    }

    // repetição de bordão (o que se repete COLADO, em poucos segundos; palavra de assunto repetida numa conversa não conta):
    //   a) a mesma palavra de conteúdo em sequência na própria fala ("like, like, like", "matem, matem");
    //   b) um par de palavras que a fala anterior (até REPEAT_LOOKBACK_SEC antes) ou a própria fala já tinha dito ("21 reais... 21 reais");
    //   c) uma fala curta inteira repetida ("Beco moleque!" duas vezes).
    // Expressões que o próprio falante usa o tempo todo ("e aí", "eu acho que") não são bordão: b) e c) ignoram o que aparece em muitas falas.
    while (recent.length && cue.start - recent[0].start > REPEAT_LOOKBACK_SEC) recent.shift();
    let hits = 0;
    for (let i = 0; i + 1 < ws.length; i += 1) {
      if (ws[i] === ws[i + 1] && ws[i].length >= 3 && !STOP.has(ws[i]) && !isNumber(ws[i])) hits += 1;
    }
    const bigrams = new Set();
    for (let i = 0; i + 1 < ws.length; i += 1) {
      const a = ws[i];
      const b = ws[i + 1];
      if (a === b || !solid(a) || !solid(b) || (STOP.has(a) && STOP.has(b)) || (isNumber(a) && isNumber(b))) continue;
      const pair = `${a} ${b}`;
      if (habitual.pairs.get(pair) > habitual.limit) { bigrams.add(pair); continue; }
      if (bigrams.has(pair) || recent.some((r) => r.bigrams.has(pair))) hits += 1;
      bigrams.add(pair);
    }
    const wholeCue = ws.length >= 2 || (ws[0].length >= 4 && !STOP.has(ws[0]) && !isNumber(ws[0]));
    if (wholeCue && ws.length <= SHORT_CUE_WORDS && habitual.cues.get(norm) <= habitual.limit && recent.some((r) => r.norm === norm)) hits += 1;
    if (hits) repeat[sec] += Math.min(2, hits);
    recent.push({ start: cue.start, bigrams, norm });
  }
  closeRun();
  return { laugh, exclaim, repeat, meta, humor: humorUnits, humorHits, words, structure };
}

/** Soma de `values` em [k - back, k + ahead] para cada k, com somas acumuladas. */
function windowSums(values, back, ahead) {
  const n = values.length;
  const p = prefixSums(values);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k += 1) out[k] = p[Math.min(n, k + ahead + 1)] - p[Math.max(0, k - back)];
  return out;
}

const fmtN = (x) => String(Math.round(x * 10) / 10).replace('.', ',');

/**
 * Pontuação por segundo (0..1). `th` = thresholds(sensitivity); `textWeights` = peso de cada pista (0 desliga); `humor` = perfil de humor do
 * canal para o algoritmo ({ phrases, reactions }, humor.js). `profile` = 'gameplay' (padrão) ou 'conversa' (ver extractEvents).
 * `cues` em segundos desde o início do vídeo. Devolve { id, score, describe(from, to), stats }.
 */
function scoreText(transcript, { n, th, baselineSec = 600, textWeights = {}, humor = null, profile = 'gameplay' }) {
  const cues = transcript && Array.isArray(transcript.cues) ? transcript.cues : [];
  const conversa = profile === 'conversa';
  const ev = extractEvents(cues, n, humor, profile);
  const w = (id) => (Number.isFinite(textWeights[id]) ? textWeights[id] : 1);

  const laughSum = windowSums(ev.laugh, LAUGH_BACK_SEC, LAUGH_AHEAD_SEC);
  const exclaimSum = windowSums(ev.exclaim, WINDOW_BACK_SEC, WINDOW_AHEAD_SEC);
  const repeatSum = windowSums(ev.repeat, WINDOW_BACK_SEC, WINDOW_AHEAD_SEC);
  const metaSum = windowSums(ev.meta, WINDOW_BACK_SEC + 4, WINDOW_AHEAD_SEC + 4);
  const humorSum = windowSums(ev.humor, WINDOW_BACK_SEC, WINDOW_AHEAD_SEC);
  const structureSum = windowSums(ev.structure, STRUCTURE_BACK_SEC, STRUCTURE_AHEAD_SEC);

  // ritmo: palavras por segundo (média de 17 s) contra o normal de fala do trecho (só janelas com fala; mediana/MAD por bloco)
  const wordsSum = windowSums(ev.words, WINDOW_BACK_SEC, WINDOW_AHEAD_SEC);
  const rate = new Float64Array(n);
  for (let k = 0; k < n; k += 1) rate[k] = wordsSum[k] / (WINDOW_BACK_SEC + WINDOW_AHEAD_SEC + 1);
  const speechRates = [];
  for (let k = 0; k < n; k += 1) if (rate[k] >= PACE_MIN_SPEECH) speechRates.push(rate[k]);
  const globalCenter = median(speechRates);
  const globalScale = Math.max(PACE_MIN_SCALE, MAD_TO_SIGMA * mad(speechRates, globalCenter));
  const base = localBaseline(rate, baselineSec, (block) => {
    const sp = [];
    for (const v of block) if (v >= PACE_MIN_SPEECH) sp.push(v);
    if (sp.length < PACE_MIN_SAMPLES) return { center: globalCenter, scale: globalScale };
    const c = median(sp);
    return { center: c, scale: Math.max(PACE_MIN_SCALE, MAD_TO_SIGMA * mad(sp, c)) };
  });

  const parts = {
    laugh: new Float64Array(n), exclaim: new Float64Array(n), pace: new Float64Array(n), repeat: new Float64Array(n), meta: new Float64Array(n),
    humor: new Float64Array(n), structure: new Float64Array(n)
  };
  const paceZ = new Float64Array(n);
  const score = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    parts.laugh[k] = softRamp(laughSum[k], th.textLaugh0, th.textLaughSpan);
    parts.exclaim[k] = softRamp(exclaimSum[k], th.textExclaim0, th.textExclaimSpan);
    parts.repeat[k] = softRamp(repeatSum[k], th.textRepeat0, th.textRepeatSpan);
    parts.meta[k] = softRamp(metaSum[k], th.textMeta0, th.textMetaSpan);
    parts.humor[k] = softRamp(humorSum[k], th.textHumor0, th.textHumorSpan);
    if (conversa) parts.structure[k] = softRamp(structureSum[k], th.textStructure0, th.textStructureSpan);
    if (rate[k] >= PACE_MIN_SPEECH) {
      paceZ[k] = Math.min(PACE_Z_CAP, (rate[k] - base.center[k]) / base.scale[k]);
      parts.pace[k] = softRamp(paceZ[k], th.textPace0, th.textPaceSpan);
    }
    score[k] = noisyOr(FEATURES.map((id) => clamp01(w(id) * parts[id][k])));
  }

  const laughMarks = ev.laugh.reduce((s, v) => s + v, 0);

  /** "expressão do canal: “bora”" (até duas, as mais ditas na janela do segundo `k`). */
  function humorReason(k) {
    const count = new Map();
    for (const hit of ev.humorHits) {
      if (hit.sec >= k - WINDOW_BACK_SEC && hit.sec <= k + WINDOW_AHEAD_SEC) count.set(hit.label, (count.get(hit.label) || 0) + 1);
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([label]) => `“${label}”`);
    if (!top.length) return 'expressão do canal';
    return `${top.length > 1 ? 'expressões' : 'expressão'} do canal: ${top.join(', ')}`;
  }

  function describe(from, to) {
    const out = [];
    const best = { laugh: -1, exclaim: -1, pace: -1, repeat: -1, meta: -1, humor: -1, structure: -1 };
    for (let k = Math.max(0, from); k <= to && k < n; k += 1) {
      for (const id of FEATURES) if (parts[id][k] > 0 && (best[id] < 0 || parts[id][k] > parts[id][best[id]])) best[id] = k;
    }
    const strength = (id) => clamp01(w(id) * parts[id][best[id]]);
    if (best.laugh >= 0) out.push({ text: laughSum[best.laugh] >= 2 ? 'risadas' : 'risada', strength: strength('laugh') });
    if (best.exclaim >= 0) out.push({ text: 'exclamações e reações', strength: strength('exclaim') });
    if (best.pace >= 0) out.push({ text: `ritmo de fala acelerou (${fmtN(rate[best.pace])} palavras/s)`, strength: strength('pace') });
    if (best.repeat >= 0) out.push({ text: conversa ? 'laço de repetição (bordão)' : 'repetição (bordão)', strength: strength('repeat') });
    if (best.meta >= 0) out.push({ text: 'fala sobre o próprio momento', strength: strength('meta') });
    if (best.humor >= 0) out.push({ text: humorReason(best.humor), strength: strength('humor') });
    if (best.structure >= 0) out.push({ text: 'conselho, história ou opinião', strength: strength('structure') });
    return out;
  }

  return { id: 'text', score, describe, parts, stats: { cues: cues.length, laughs: laughMarks, humorHits: ev.humorHits.length } };
}

module.exports = {
  scoreText, extractEvents, windowSums, phraseMatcher, loopRepeats, structureUnits, REACTION_RE, META_RE, ADVICE_RE, STORY_RE, OPINION_RE, FEATURES
};
