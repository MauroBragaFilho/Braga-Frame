'use strict';

/**
 * Aprendizado de preferências (funções puras; dono: prefs). A partir das observações guardadas em
 * `learned.json` (o estado atual de cada corte decidido pelo usuário) calcula, por escopo (geral, jogo e
 * canal), as preferências PROPOSTAS, cada uma com a evidência em texto legível. Quem decide se uma
 * proposta vale (evidência mínima, ligada/desligada pelo usuário) é o serviço em index.js.
 *
 * Regras (provisórias, documentadas em docs/recursos/prefs.md):
 *  - duração: mediana dos cortes APROVADOS; mínimo = menor entre metade da mediana e o 1º quartil;
 *    máximo = maior entre 1,5 × a mediana e o 3º quartil (o miolo das aprovações sempre cabe), sempre dentro das
 *    faixas aceitas pelas preferências (as mesmas da análise, veja keys.js);
 *  - categorias: as usadas em cortes não rejeitados, da mais para a menos usada, seguidas das padrão;
 *  - relevância mínima: o maior limite (20/40/60/80%) abaixo do qual >= 70% dos cortes sugeridos e
 *    decididos foram rejeitados, desde que acima dele no máximo 50% tenham sido rejeitados;
 *  - perfil de exportação: o mais usado nos cortes aprovados, se tiver >= 50% deles.
 */

const { DEFAULT_CATEGORIES, findDef, sameValue, fmtNum } = require('./keys');
const { scopeKey } = require('./scope');

const RELEVANCE_EDGES = Object.freeze([0.2, 0.4, 0.6, 0.8]);
const REJECT_RATE_BELOW = 0.7;
const REJECT_RATE_ABOVE_MAX = 0.5;
const PROFILE_MIN_SHARE = 0.5;
const MAX_CATEGORIES = 20;
const LEARNED_KEYS = Object.freeze([
  'export.profileId', 'analysis.minRelevance', 'analysis.minDurationSec', 'analysis.maxDurationSec', 'review.categories'
]);

// faixas aceitas para as durações (keys.js, alinhadas com as da análise): a proposta nunca sai delas
const MIN_RANGE = [findDef('analysis.minDurationSec').min, findDef('analysis.minDurationSec').max];
const MAX_RANGE = [findDef('analysis.maxDurationSec').min, findDef('analysis.maxDurationSec').max];

const plural = (n, one, many) => (n === 1 ? one : many);
const pct = (x) => `${Math.round(x * 100)}%`;
const secText = (n) => `${fmtNum(Math.round(n * 10) / 10)} s`;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Quantil por interpolação linear de um vetor já ordenado. */
function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const median = (values) => quantile([...values].sort((a, b) => a - b), 0.5);

/** { median, min, max } a partir das durações dos cortes aprovados. */
function durationRange(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const med = quantile(sorted, 0.5);
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  const min = clamp(Math.floor(Math.min(med * 0.5, p25)), MIN_RANGE[0], MIN_RANGE[1]);
  const max = clamp(Math.ceil(Math.max(med * 1.5, p75)), Math.max(min + 5, MAX_RANGE[0]), MAX_RANGE[1]);
  return { median: med, min, max };
}

/** Agrupa as observações por escopo: 'general', 'game:<chave>' e 'channel:<chave>'. */
function buildGroups(observations) {
  const groups = new Map();
  const add = (id, scope, state) => {
    let group = groups.get(id);
    if (!group) { group = { id, scope, states: [] }; groups.set(id, group); }
    group.scope = scope; // o nome mais recente (observações entram da mais antiga para a mais nova)
    group.states.push(state);
  };
  const list = Object.values(observations || {}).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  for (const obs of list) {
    const gKey = obs.game ? scopeKey(obs.game) : '';
    const cKey = obs.channel ? scopeKey(obs.channel) : '';
    for (const state of Object.values(obs.cuts || {})) {
      add('general', { type: 'general', key: '', name: '' }, state);
      if (gKey) add(`game:${gKey}`, { type: 'game', key: gKey, name: obs.game }, state);
      if (cKey) add(`channel:${cKey}`, { type: 'channel', key: cKey, name: obs.channel }, state);
    }
  }
  return groups;
}

function relevanceProposal(states) {
  const decided = states.filter((s) => s.origin === 'auto' && typeof s.relevance === 'number' && (s.status === 'approved' || s.status === 'rejected'));
  if (!decided.length) return null;
  for (const edge of [...RELEVANCE_EDGES].reverse()) {
    const below = decided.filter((s) => s.relevance < edge);
    const above = decided.filter((s) => s.relevance >= edge);
    if (!below.length || !above.length) continue;
    const rejBelow = below.filter((s) => s.status === 'rejected').length;
    const rejAbove = above.filter((s) => s.status === 'rejected').length;
    const rate = rejBelow / below.length;
    if (rate >= REJECT_RATE_BELOW && rejAbove / above.length <= REJECT_RATE_ABOVE_MAX && above.length > rejAbove) {
      return {
        value: edge,
        n: below.length,
        evidence: `${rejBelow} de ${below.length} ${plural(below.length, 'corte', 'cortes')} com relevância abaixo de ${pct(edge)} foram rejeitados (${pct(rate)})`
      };
    }
  }
  return null;
}

function categoryProposal(states) {
  const used = states.filter((s) => s.status !== 'rejected' && s.category);
  if (!used.length) return null;
  const counts = new Map();
  for (const s of used) {
    const k = s.category.toLowerCase();
    const row = counts.get(k) || { count: 0, spellings: new Map() };
    row.count += 1;
    row.spellings.set(s.category, (row.spellings.get(s.category) || 0) + 1);
    counts.set(k, row);
  }
  const ranked = [...counts.entries()].map(([k, row]) => ({
    k,
    count: row.count,
    name: [...row.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'))[0][0]
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  const list = ranked.map((r) => r.name);
  const have = new Set(ranked.map((r) => r.k));
  for (const name of DEFAULT_CATEGORIES) if (!have.has(name.toLowerCase())) list.push(name);
  const top = ranked.slice(0, 3).map((r) => `${r.name} (${r.count})`).join(', ');
  return {
    value: list.slice(0, MAX_CATEGORIES),
    n: used.length,
    evidence: `${used.length} ${plural(used.length, 'corte categorizado', 'cortes categorizados')}; mais usadas: ${top}`
  };
}

function profileProposal(states) {
  const withProfile = states.filter((s) => s.status === 'approved' && s.profileId);
  if (!withProfile.length) return null;
  const counts = new Map();
  for (const s of withProfile) counts.set(s.profileId, (counts.get(s.profileId) || 0) + 1);
  const [id, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const share = count / withProfile.length;
  if (share < PROFILE_MIN_SHARE) return null;
  return {
    value: id,
    n: withProfile.length,
    evidence: `${count} de ${withProfile.length} ${plural(withProfile.length, 'corte aprovado usou', 'cortes aprovados usaram')} este perfil (${pct(share)})`
  };
}

/**
 * Propostas de um grupo (um escopo). Cada item: { id, key, scope, value, n, evidence }.
 * Por padrão descarta o que é igual ao padrão do app (não muda nada); `keepDefaults` mantém, para quem precisa comparar
 * com o valor herdado (computeItems: o padrão só é "nada a dizer" quando nenhum escopo mais amplo propõe outro valor).
 */
function itemsForGroup(group, { keepDefaults = false } = {}) {
  const items = [];
  const push = (key, proposal) => {
    if (!proposal) return;
    const def = findDef(key);
    if (!keepDefaults && def && sameValue(proposal.value, def.default)) return; // igual ao padrão: não muda nada, não é proposto
    items.push({ id: `${group.scope.type}:${group.scope.key}:${key}`, key, scope: group.scope, value: proposal.value, n: proposal.n, evidence: proposal.evidence });
  };

  const approved = group.states.filter((s) => s.status === 'approved' && s.duration > 0);
  if (approved.length) {
    const durations = approved.map((s) => s.duration);
    const range = durationRange(durations);
    const evidence = `${approved.length} ${plural(approved.length, 'corte aprovado', 'cortes aprovados')}, mediana ${secText(range.median)}`;
    push('analysis.minDurationSec', { value: range.min, n: approved.length, evidence });
    push('analysis.maxDurationSec', { value: range.max, n: approved.length, evidence });
  }
  push('analysis.minRelevance', relevanceProposal(group.states));
  push('review.categories', categoryProposal(group.states));
  push('export.profileId', profileProposal(group.states));
  return items;
}

/**
 * Todas as propostas de todos os escopos, a partir das observações. Uma proposta só é listada quando diz algo além do
 * que o escopo já herdaria:
 *  - geral: herda o padrão do app, então some se for igual a ele;
 *  - jogo/canal: herda a proposta GERAL da mesma chave (ou o padrão, se ela não existe). Some se for igual ao herdado
 *    e redundante (a geral mostrada tem a mesma evidência, os mesmos cortes) ou se o herdado é o próprio padrão.
 *    Importante: uma proposta de canal igual ao PADRÃO do app continua listada quando a geral propõe outro valor,
 *    senão o valor geral passaria por cima do que o canal mostra (o canal propõe 60 s, a geral 45 s: vale 60 s).
 */
function computeItems(observations) {
  const all = [];
  for (const group of buildGroups(observations).values()) all.push(...itemsForGroup(group, { keepDefaults: true }));
  const general = new Map(all.filter((i) => i.scope.type === 'general').map((i) => [i.key, i]));
  return all.filter((i) => {
    const def = findDef(i.key);
    const isDefault = Boolean(def) && sameValue(i.value, def.default);
    if (i.scope.type === 'general') return !isDefault;
    const wide = general.get(i.key);
    const inherited = wide ? wide.value : (def ? def.default : undefined);
    if (!sameValue(i.value, inherited)) return true; // difere do que herdaria: diz algo
    if (wide && !sameValue(wide.value, def.default)) return wide.n !== i.n; // a geral aparece: redundante só com a mesma evidência
    return false; // igual ao padrão (herdado direto ou pela geral, que não é listada): nada a dizer
  });
}

module.exports = {
  RELEVANCE_EDGES, LEARNED_KEYS, REJECT_RATE_BELOW, REJECT_RATE_ABOVE_MAX, PROFILE_MIN_SHARE,
  quantile, median, durationRange, buildGroups, itemsForGroup, computeItems, plural, pct
};
