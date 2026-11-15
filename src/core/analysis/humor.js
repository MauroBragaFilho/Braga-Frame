'use strict';

/**
 * PERFIL DE HUMOR DO CANAL (docs/recursos/analise-ia.md, seção 16): o que o usuário diz que é um bom corte do canal dele. Vale para os dois
 * motores da análise:
 *   - a IA recebe os critérios (texto livre), os bordões e as palavras do canal e, se o usuário deixar, EXEMPLOS de cortes que ele aprovou e
 *     rejeitou (src/core/analysis/ai/humorExamples.js);
 *   - o algoritmo conta os BORDÕES como uma pista forte ("expressão do canal") e as PALAVRAS E REAÇÕES como exclamação/reação
 *     (src/core/analysis/textSignal.js).
 *
 * Forma guardada na preferência `analysis.humor` (herdada canal > jogo > geral, como as outras):
 *   { criteria: texto (até 1500 caracteres), catchphrases: [bordões], reactions: [palavras e reações], themes: [temas], examples: boolean (padrão: ligado) }
 *   Os TEMAS ("piadas", "cenas de história", "jogadas"…) são só da IA: ela prioriza esses assuntos e distribui os cortes entre eles; o algoritmo
 *   não entende assunto e os ignora.
 *
 * Este arquivo é "universal", como o model.js: funciona como módulo CommonJS e, carregado por <script>, expõe `window.BFHumor`. Por isso não
 * usa nenhum módulo do Node. Tudo aqui é função pura: valida o que veio de fora (preferência editada à mão, renderer, IPC) e nunca lança.
 */
(function () {
  const LIMITS = Object.freeze({
    criteria: 1500, // caracteres do texto livre
    items: 40, // bordões (e, separadamente, palavras e reações)
    itemLength: 60, // caracteres de cada item
    examplesPositive: 4, // exemplos de cortes aprovados enviados à IA
    examplesNegative: 3, // exemplos de cortes rejeitados enviados à IA
    exampleChars: 360 // caracteres da transcrição de cada exemplo
  });

  /** Sem caracteres de controle e com espaços normalizados (quebra de linha e tab viram espaço; o chamador que precisa de linhas separa antes). */
  function squash(value) {
    let out = '';
    for (const ch of String(value === undefined || value === null ? '' : value)) {
      const code = ch.charCodeAt(0);
      out += code < 32 || (code >= 127 && code <= 159) ? ' ' : ch;
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  /** Texto sem acento, minúsculo e só com letras e números (a mesma regra que `normText` das falas): base de comparação e de busca. */
  const fold = (value) => String(value === undefined || value === null ? '' : value)
    .normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  /** "a, b\nc; d" -> ['a', 'b', 'c', 'd'] (aceita vírgula, ponto e vírgula e quebra de linha; uma lista que já é lista passa por aqui também). */
  function parseList(value) {
    if (Array.isArray(value)) return value.filter((x) => typeof x === 'string');
    if (typeof value !== 'string') return [];
    return value.split(/[,;\n]/);
  }

  /** Itens limpos: sem vazios, sem repetidos (sem diferenciar acento nem caixa), cada um até `itemLength` caracteres, no máximo `items`. */
  function cleanItems(value) {
    const out = [];
    const seen = new Set();
    for (const raw of parseList(value)) {
      const text = squash(raw).slice(0, LIMITS.itemLength).trim();
      const key = fold(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= LIMITS.items) break;
    }
    return out;
  }

  /** Critérios: até `criteria` caracteres, parágrafos preservados (quebras de linha), sem espaços sobrando nem caracteres de controle. */
  function cleanCriteria(value) {
    if (typeof value !== 'string') return '';
    const lines = value.replace(/\r\n?/g, '\n').split('\n').map((line) => squash(line));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, LIMITS.criteria).trim();
  }

  /** Perfil completo e limpo (todos os campos presentes), a partir de qualquer coisa. Sem perfil, devolve o perfil vazio. */
  function normalizeProfile(raw) {
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      criteria: cleanCriteria(src.criteria),
      catchphrases: cleanItems(src.catchphrases),
      reactions: cleanItems(src.reactions),
      themes: cleanItems(src.themes),
      examples: src.examples !== false // só o valor `false` guardado desliga os exemplos
    };
  }

  /** O perfil não diz nada (nenhum critério, bordão, palavra nem tema)? Os exemplos sozinhos não contam: sem perfil escrito não há o que aplicar. */
  const isEmpty = (profile) => {
    const p = normalizeProfile(profile);
    return !p.criteria && !p.catchphrases.length && !p.reactions.length && !p.themes.length;
  };

  /** Lista em texto para o campo da tela ("a, b, c"). */
  const listText = (list) => (Array.isArray(list) ? list.join(', ') : '');

  /**
   * Lista para o algoritmo: cada item em minúsculas e com os espaços normalizados (o acento FICA, para o motivo da sugestão aparecer como o
   * usuário escreveu; a busca na fala ignora acento, caixa e pontuação), sem repetidos, no máximo `items` e em ordem alfabética (a ordem não
   * importa para a pontuação e assim a chave de cache do resultado é estável).
   */
  function algorithmList(value) {
    const found = new Map(); // texto dobrado -> item
    for (const raw of parseList(value)) {
      const item = squash(raw).toLowerCase().slice(0, LIMITS.itemLength).trim();
      const key = fold(item);
      if (key && !found.has(key)) found.set(key, item);
      if (found.size >= LIMITS.items) break; // o limite vale para os PRIMEIROS itens, antes de ordenar
    }
    return [...found.keys()].sort().map((key) => found.get(key));
  }

  /** O que o ALGORITMO usa (parâmetro `humor` da análise): os bordões e as palavras de reação do perfil. */
  function forAlgorithm(profile) {
    const p = normalizeProfile(profile);
    return { phrases: algorithmList(p.catchphrases), reactions: algorithmList(p.reactions) };
  }

  /** Mesma coisa, a partir do parâmetro `humor` (valida o que veio do renderer: listas de textos, no máximo `items` de até `itemLength`). */
  function normalizeAlgorithmLists(raw) {
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return { phrases: algorithmList(src.phrases), reactions: algorithmList(src.reactions) };
  }

  /** Estimativa de tokens (grosseira e conservadora: a mesma conta de ai/prompt.js, 3,2 caracteres por token). */
  const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.2);

  const api = { LIMITS, squash, fold, parseList, cleanItems, cleanCriteria, normalizeProfile, isEmpty, listText, forAlgorithm, normalizeAlgorithmLists, estimateTokens };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFHumor = api;
})();
