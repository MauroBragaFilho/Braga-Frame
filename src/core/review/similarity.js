'use strict';

/**
 * Cortes semelhantes (dono: review): sobreposição temporal (IoU), proximidade e título parecido.
 * Universal: CommonJS no Node e `window.BFReview.similarity` no renderer.
 *
 * Critério PROVISÓRIO (a confirmar com a Liz, veja docs/recursos/review.md):
 *  - sobreposição: IoU >= 0.4, ou o trecho em comum cobre >= 70% do menor dos dois; OU
 *  - proximidade (<= 5 s entre os cortes, ou sobrepostos) E título parecido (>= 50% das palavras em comum,
 *    ignorando títulos padrão "Corte N" e "Sugestão m:ss").
 * Cortes semelhantes formam grupos (transitivo: A~B e B~C põem os três juntos).
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(require('./core'));
  else { root.BFReview = root.BFReview || {}; root.BFReview.similarity = factory(root.BFReview.core); }
})(globalThis, function (core) {
  const DEFAULTS = Object.freeze({ minIoU: 0.4, minContain: 0.7, maxGapSec: 5, minTitleSim: 0.5 });
  const STOPWORDS = new Set(['para', 'com', 'uma', 'uns', 'umas', 'dos', 'das', 'que', 'por', 'mais', 'como', 'nos', 'nas', 'aos', 'seu', 'sua', 'ele', 'ela', 'isso', 'esse', 'essa', 'foi', 'the', 'and', 'momento', 'live']);
  // títulos gerados pelo app ("Corte 3", "Sugestão 1:23" da análise): dizem onde o corte está, não o que ele é
  const DEFAULT_TITLE = /^(?:corte|sugestao)\s+[\d:]+$/i;

  const length = (c) => Math.max(0, c.end - c.start);
  const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

  function iou(a, b) {
    const inter = overlap(a, b);
    const union = length(a) + length(b) - inter;
    return union > 0 ? inter / union : 0;
  }

  /** Distância entre os cortes (s); 0 se se sobrepõem ou se tocam. */
  function gap(a, b) {
    return Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
  }

  /** Palavras relevantes do título (minúsculas, sem acento nem pontuação). */
  function titleTokens(title) {
    const text = String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (DEFAULT_TITLE.test(text.trim())) return new Set();
    return new Set(text.replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
  }

  /** Similaridade de Jaccard entre as palavras dos títulos (0..1). Título padrão ("Corte N", "Sugestão m:ss") não conta. */
  function titleSimilarity(a, b) {
    const ta = titleTokens(a);
    const tb = titleTokens(b);
    if (!ta.size || !tb.size) return 0;
    let common = 0;
    for (const w of ta) if (tb.has(w)) common += 1;
    return common / (ta.size + tb.size - common);
  }

  const pct = (v) => `${Math.round(v * 100)}%`;

  /** null se os cortes não são semelhantes; senão { score, reasons, iou, overlapSec, gapSec, titleSim }. */
  function comparePair(a, b, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const inter = overlap(a, b);
    const minLen = Math.min(length(a), length(b));
    const i = iou(a, b);
    const contain = minLen > 0 ? inter / minLen : 0;
    const g = gap(a, b);
    const ts = titleSimilarity(a.title, b.title);
    const bySpan = i >= o.minIoU || contain >= o.minContain;
    const near = g <= o.maxGapSec;
    const byTitle = ts >= o.minTitleSim;
    if (!bySpan && !(near && byTitle)) return null;
    const reasons = [];
    const kinds = [];
    if (i >= o.minIoU) { kinds.push('overlap'); reasons.push(`sobrepõem-se em ${pct(i)}`); }
    else if (contain >= o.minContain) { kinds.push('contain'); reasons.push(`um cobre ${pct(contain)} do outro`); }
    else if (inter > 0) { kinds.push('near'); reasons.push('se sobrepõem em parte'); }
    else { kinds.push('near'); reasons.push(`a ${core.fmtSeconds(g)} de distância`); }
    if (byTitle) { kinds.push('title'); reasons.push('títulos parecidos'); }
    const score = Math.max(i, contain * 0.9, byTitle && near ? 0.5 + ts / 2 : 0);
    return { score, reasons, kinds, iou: i, overlapSec: inter, gapSec: g, titleSim: ts };
  }

  /**
   * Agrupa os cortes semelhantes. Devolve [{ id, members:[ids em ordem cronológica], pairs, reasons, resolved }]
   * ordenado pelo primeiro corte. `resolved` = no máximo um membro ainda não rejeitado.
   */
  function findGroups(cuts, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const list = [...cuts].sort((a, b) => (a.start - b.start) || (a.end - b.end) || String(a.id).localeCompare(String(b.id)));
    const parent = list.map((_, i) => i);
    const find = (x) => { let r = x; while (parent[r] !== r) r = parent[r]; let c = x; while (parent[c] !== r) { const n = parent[c]; parent[c] = r; c = n; } return r; };
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        // ordenado por início: se o próximo começa depois do fim + folga, os seguintes também
        if (list[j].start - list[i].end > o.maxGapSec) break;
        const hit = comparePair(list[i], list[j], o);
        if (!hit) continue;
        pairs.push({ a: list[i].id, b: list[j].id, ...hit });
        const ra = find(i); const rb = find(j);
        if (ra !== rb) parent[rb] = ra;
      }
    }
    const byRoot = new Map();
    list.forEach((cut, i) => {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(cut);
    });
    const groups = [];
    for (const members of byRoot.values()) {
      if (members.length < 2) continue;
      const ids = members.map((c) => c.id);
      const mine = pairs.filter((p) => ids.includes(p.a) && ids.includes(p.b));
      const reasons = [...new Set(mine.flatMap((p) => p.reasons).map((r) => r.replace(/ em \d+%$/, '')))];
      groups.push({
        id: `g-${members[0].id}`,
        members: ids,
        pairs: mine,
        reasons,
        resolved: members.filter((c) => c.status !== 'rejected').length <= 1
      });
    }
    return groups; // já em ordem: `list` está ordenada por início e o Map guarda a ordem de chegada
  }

  /** Map id do corte -> grupo. */
  function indexGroups(groups) {
    const map = new Map();
    for (const group of groups) for (const id of group.members) map.set(id, group);
    return map;
  }

  /**
   * Qual manter por padrão num grupo: o que o usuário já aprovou (é uma decisão dele), depois o de maior
   * relevância e, por fim, o mais longo (mais contexto). Rejeitados só se não houver outro.
   */
  function bestToKeep(group, cutsById) {
    const members = group.members.map((id) => cutsById.get(id)).filter(Boolean);
    if (!members.length) return null;
    const rank = (c) => (c.status === 'approved' ? 0 : c.status === 'rejected' ? 2 : 1);
    const rel = (c) => (core.isNum(c.relevance) ? c.relevance : -1);
    members.sort((a, b) => (rank(a) - rank(b)) || (rel(b) - rel(a)) || (length(b) - length(a)) || (a.start - b.start));
    return members[0].id;
  }

  return { DEFAULTS, overlap, iou, gap, titleTokens, titleSimilarity, comparePair, findGroups, indexGroups, bestToKeep };
});
