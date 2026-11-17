'use strict';

/**
 * Chaves reconhecidas das preferências (contrato 3.5 de docs/arquitetura.md; dono: prefs), com valor
 * padrão, tipo, limites e texto da interface. Tudo que entra em `preferences.json` passa por `validate`.
 */

const humor = require('../analysis/humor');

// Mesma lista que a aba Cortes usa quando não há preferência (renderer/features/cuts.js).
const DEFAULT_CATEGORIES = Object.freeze(['Jogada', 'Clutch', 'Engraçado', 'Fail', 'Hype', 'Dica']);

/**
 * Faixas das chaves que a análise também limita: são as MESMAS de `src/core/analysis/params.js` (RANGES), para o valor
 * que aparece em Preferências ser o que a análise de fato usa (antes aceitava 1 a 600 s e a análise cortava em 3-120 e
 * 5-180 sem avisar). Sem o módulo de análise valem os números abaixo (os mesmos de hoje).
 */
function analysisRange(name, fallback) {
  try {
    const range = require('../analysis/params').RANGES[name];
    if (Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)) return range;
  } catch { /* sem o módulo de análise: faixa própria */ }
  return fallback;
}
const MIN_DURATION_RANGE = analysisRange('minDurationSec', [3, 120]);
const MAX_DURATION_RANGE = analysisRange('maxDurationSec', [5, 180]);
const PAD_BEFORE_RANGE = analysisRange('padBeforeSec', [0, 60]);
const PAD_AFTER_RANGE = analysisRange('padAfterSec', [0, 60]);

const KEY_OPTIONS = Object.freeze('abcdefghjklmnpqrstuvwxyz'.split('').map((c) => Object.freeze([c, c.toUpperCase()])));

const GROUPS = Object.freeze([
  { id: 'export', label: 'Exportação' },
  { id: 'analysis', label: 'Análise' },
  { id: 'review', label: 'Revisão' },
  { id: 'queue', label: 'Fila' },
  { id: 'subtitles', label: 'Legendas' }
]);

/**
 * type: 'profile' | 'enum' | 'ratio' (0..1) | 'seconds' | 'int' | 'bool' | 'list' | 'object'
 * advanced: fica recolhido na tela. learnable: o aprendizado pode propor este valor.
 */
const DEFS = Object.freeze([
  { key: 'export.profileId', group: 'export', label: 'Perfil de exportação', type: 'profile', default: 'vertical-1080-h264', learnable: true, hint: 'Qualidade e formato dos arquivos exportados.' },
  { key: 'export.framing.mode', group: 'export', label: 'Enquadramento', type: 'enum', default: 'center', hint: 'Como o 9:16 é montado a partir da gravação.',
    options: [['center', 'Centralizado'], ['blur', 'Fundo desfocado'], ['stack', 'Gameplay + webcam'], ['custom', 'Personalizado']] },
  // Layouts do canal (aba Exportar): o enquadramento de cada layout e os quadros de referência do detector local. São editados lá;
  // aqui aparecem só para mostrar de onde o projeto herda (canal > jogo > geral) e permitir remover.
  { key: 'export.layout.conversa', group: 'export', label: 'Layout Conversa', type: 'object', default: null, advanced: true, valueText: 'definido na aba Exportar', hint: 'Defina na aba Exportar, em Layouts do canal.' },
  { key: 'export.layout.jogo', group: 'export', label: 'Layout Jogo', type: 'object', default: null, advanced: true, valueText: 'definido na aba Exportar', hint: 'Defina na aba Exportar, em Layouts do canal.' },
  { key: 'export.layout.refs', group: 'export', label: 'Quadros de referência dos layouts', type: 'object', default: null, advanced: true, maxLength: 32768, valueText: 'definidos na aba Exportar', hint: 'Servem para detectar o layout de cada corte pela imagem; defina na aba Exportar.' },
  { key: 'analysis.minRelevance', group: 'analysis', label: 'Relevância mínima', type: 'ratio', default: 0.5, learnable: true, hint: 'Sugestões com relevância menor não são criadas.' },
  { key: 'analysis.minDurationSec', group: 'analysis', label: 'Duração mínima', type: 'seconds', default: 15, min: MIN_DURATION_RANGE[0], max: MIN_DURATION_RANGE[1], learnable: true, hint: 'Menor duração de um corte sugerido.' },
  { key: 'analysis.maxDurationSec', group: 'analysis', label: 'Duração máxima', type: 'seconds', default: 60, min: MAX_DURATION_RANGE[0], max: MAX_DURATION_RANGE[1], learnable: true, hint: 'Maior duração de um corte sugerido.' },
  { key: 'analysis.padBeforeSec', group: 'analysis', label: 'Margem antes do momento', type: 'seconds', default: 3, min: PAD_BEFORE_RANGE[0], max: PAD_BEFORE_RANGE[1], advanced: true },
  { key: 'analysis.padAfterSec', group: 'analysis', label: 'Margem depois do momento', type: 'seconds', default: 2, min: PAD_AFTER_RANGE[0], max: PAD_AFTER_RANGE[1], advanced: true },
  { key: 'analysis.keywords', group: 'analysis', label: 'Palavras-chave do chat', type: 'list', default: null, advanced: true, hint: 'Separadas por vírgula; vazio usa as do app.' },
  // Perfil de humor do canal (aba Análise): critérios para a IA e bordões/reações para o algoritmo. Forma e limites em src/core/analysis/humor.js;
  // o valor guardado já passa por `normalize` (humor.js), então o que está no arquivo é sempre um perfil limpo.
  { key: 'analysis.humor', group: 'analysis', label: 'Perfil de humor do canal', type: 'object', default: null, advanced: true, maxLength: 16384, normalize: 'humor', valueText: 'definido na aba Análise', hint: 'O que é um bom corte do seu canal: critérios para a IA e bordões e reações para o algoritmo. Defina na aba Análise.' },
  { key: 'review.defaultSort', group: 'review', label: 'Ordem da lista de cortes', type: 'enum', default: 'chrono',
    options: [['chrono', 'Ordem da live'], ['relevance', 'Relevância']] },
  { key: 'review.categories', group: 'review', label: 'Categorias sugeridas', type: 'list', default: [...DEFAULT_CATEGORIES], learnable: true, hint: 'Separadas por vírgula.' },
  // atalhos de teclado da revisão (src/core/review/shortcuts.js): uma letra por ação; I e O (marcar início e fim) ficam de fora
  { key: 'review.key.approve', group: 'review', label: 'Atalho: aprovar o corte aberto', type: 'enum', default: 'a', advanced: true, options: KEY_OPTIONS, hint: 'Aprova e já abre o próximo corte pendente.' },
  { key: 'review.key.reject', group: 'review', label: 'Atalho: rejeitar o corte aberto', type: 'enum', default: 'r', advanced: true, options: KEY_OPTIONS, hint: 'Rejeita e já abre o próximo corte pendente.' },
  { key: 'review.key.view', group: 'review', label: 'Atalho: tocar o trecho do corte aberto', type: 'enum', default: 'v', advanced: true, options: KEY_OPTIONS },
  { key: 'review.key.next', group: 'review', label: 'Atalho: abrir o próximo corte', type: 'enum', default: 'j', advanced: true, options: KEY_OPTIONS, hint: 'A seta para baixo também funciona.' },
  { key: 'review.key.prev', group: 'review', label: 'Atalho: abrir o corte anterior', type: 'enum', default: 'k', advanced: true, options: KEY_OPTIONS, hint: 'A seta para cima também funciona. Duas ações na mesma letra: vale a primeira da lista.' },
  { key: 'queue.parallel', group: 'queue', label: 'Exportações em paralelo', type: 'int', default: 1, min: 1, max: 4, advanced: true },
  { key: 'subtitles.enabled', group: 'subtitles', label: 'Ligar a legenda nos cortes novos', type: 'bool', default: false, advanced: true, hint: 'A caixa "Legendar este corte" já nasce ligada; as falas são geradas na aba Legendas.' },
  { key: 'subtitles.mode', group: 'subtitles', label: 'Legendas no arquivo', type: 'enum', default: 'burn', advanced: true,
    options: [['burn', 'Incorporadas ao vídeo'], ['sidecar', 'Arquivo separado'], ['both', 'Os dois']] },
  { key: 'subtitles.style', group: 'subtitles', label: 'Estilo das legendas', type: 'object', default: null, advanced: true, hint: 'Defina na aba Legendas, em Mais opções.' }
]);

const BY_KEY = new Map(DEFS.map((d) => [d.key, d]));
const findDef = (key) => BY_KEY.get(key) || null;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const round = (n, digits) => { const f = 10 ** digits; return Math.round(n * f) / f; };

const fmtNum = (n) => String(round(n, 2)).replace('.', ',');

// Texto numérico: só dígitos com vírgula ou ponto decimal ("4,5", "0.7"). Number() sozinho aceitaria "0x1", "1e-1" ou "Infinity".
const NUMERIC_TEXT = /^\d+(?:[.,]\d+)?$/;

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && NUMERIC_TEXT.test(value.trim())) return Number(value.trim().replace(',', '.'));
  return NaN;
}

/**
 * Valida (e normaliza) `value` para a chave `def`. Devolve { ok:true, value } ou
 * { ok:false, message } com texto em português que diz o que corrigir.
 */
function validate(def, value) {
  const name = `"${def.label}"`;
  const bad = (message) => ({ ok: false, message });
  switch (def.type) {
    case 'profile': {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.trim())) return bad(`${name}: escolha um perfil de exportação válido.`);
      return { ok: true, value: value.trim() };
    }
    case 'enum': {
      const allowed = def.options.map((o) => o[0]);
      if (!allowed.includes(value)) return bad(`${name}: valor inválido. Opções: ${allowed.join(', ')}.`);
      return { ok: true, value };
    }
    case 'ratio': {
      const n = toNumber(value);
      if (!Number.isFinite(n) || n < 0 || n > 1) return bad(`${name}: informe um valor entre 0 e 1 (0% a 100%).`);
      return { ok: true, value: round(n, 2) };
    }
    case 'seconds': {
      const n = toNumber(value);
      if (!Number.isFinite(n) || n < def.min || n > def.max) return bad(`${name}: informe um tempo entre ${def.min} e ${def.max} segundos.`);
      return { ok: true, value: round(n, 1) };
    }
    case 'int': {
      const n = toNumber(value);
      if (!Number.isInteger(n) || n < def.min || n > def.max) return bad(`${name}: informe um número inteiro entre ${def.min} e ${def.max}.`);
      return { ok: true, value: n };
    }
    case 'bool': {
      if (typeof value !== 'boolean') return bad(`${name}: use ligado ou desligado.`);
      return { ok: true, value };
    }
    case 'list': {
      const raw = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(raw)) return bad(`${name}: informe uma lista de textos separados por vírgula.`);
      const seen = new Set();
      const out = [];
      for (const item of raw) {
        if (typeof item !== 'string') return bad(`${name}: a lista só pode conter textos.`);
        const text = item.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > 40) return bad(`${name}: cada item pode ter no máximo 40 caracteres.`);
        const k = text.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(text);
      }
      if (out.length > 30) return bad(`${name}: no máximo 30 itens.`);
      if (!out.length) return bad(`${name}: informe ao menos um item (ou remova a preferência para voltar ao padrão).`);
      return { ok: true, value: out };
    }
    case 'object': {
      if (!isObj(value)) return bad(`${name}: valor inválido.`);
      let next = value;
      if (def.normalize === 'humor') {
        // perfil de humor do canal: o que fica guardado já é um perfil limpo (limites e listas de humor.js)
        next = humor.normalizeProfile(value);
        if (humor.isEmpty(next)) return bad(`${name}: informe ao menos um critério, um bordão ou uma palavra de reação (ou remova a preferência).`);
      }
      let text;
      try { text = JSON.stringify(next); } catch { return bad(`${name}: valor inválido.`); }
      if (text.length > (def.maxLength || 4096)) return bad(`${name}: valor grande demais.`);
      return { ok: true, value: JSON.parse(text) };
    }
    default:
      return bad(`${name}: tipo de preferência desconhecido.`);
  }
}

/**
 * Texto curto do valor para a interface e o histórico. `names.profileName(id)` (opcional) devolve o nome do perfil de
 * exportação; sem ele (ou para um perfil que não existe mais) aparece o id.
 */
function formatValue(def, value, names = {}) {
  if (value === null || value === undefined) return 'padrão do app';
  switch (def.type) {
    case 'ratio': return `${Math.round(value * 100)}%`;
    case 'seconds': return `${fmtNum(value)} s`;
    case 'bool': return value ? 'ligado' : 'desligado';
    case 'enum': { const hit = def.options.find((o) => o[0] === value); return hit ? hit[1] : String(value); }
    case 'list': return Array.isArray(value) ? value.join(', ') : String(value);
    case 'object': return def.valueText || 'definido na aba Legendas';
    case 'profile': {
      const name = names && typeof names.profileName === 'function' ? names.profileName(value) : null;
      return typeof name === 'string' && name ? name : String(value);
    }
    default: return String(value);
  }
}

/**
 * Regra entre chaves: a duração mínima não pode passar da máxima. `other` é o valor da outra chave
 * no mesmo escopo (ou o padrão). Devolve texto de erro ou null.
 */
function pairProblem(key, value, other) {
  if (key === 'analysis.minDurationSec' && Number.isFinite(other) && value > other) {
    return `A duração mínima (${fmtNum(value)} s) ficaria maior que a máxima em vigor (${fmtNum(other)} s). Aumente a máxima antes.`;
  }
  if (key === 'analysis.maxDurationSec' && Number.isFinite(other) && value < other) {
    return `A duração máxima (${fmtNum(value)} s) ficaria menor que a mínima em vigor (${fmtNum(other)} s). Diminua a mínima antes.`;
  }
  return null;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { DEFAULT_CATEGORIES, GROUPS, DEFS, findDef, validate, formatValue, pairProblem, sameValue, clone, fmtNum };
