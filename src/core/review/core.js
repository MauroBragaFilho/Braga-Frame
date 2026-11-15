'use strict';

/**
 * Núcleo da revisão (dono: review): tempos, campos revisáveis do corte e indicadores.
 *
 * Arquivo "universal", como `projects/model.js`: módulo CommonJS no Node (testes) e, carregado por
 * <script> pelo `renderer/features/cuts.js`, vira `window.BFReview.core`. Por isso não usa módulos do Node.
 *
 * Campos que a revisão acrescenta ao corte (o modelo preserva campos desconhecidos):
 *  - `titleCustom`  true quando o usuário digitou o título (nunca é sobrescrito por sugestão);
 *  - `reviewedRange` [início, fim] vigentes quando o corte foi aprovado/rejeitado; se o tempo mudar depois,
 *    o corte aparece como "alterado desde a revisão".
 */
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory();
  else { root.BFReview = root.BFReview || {}; root.BFReview.core = factory(); }
})(globalThis, function () {
  /** Duração mínima de um corte (s). */
  const MIN_LENGTH = 0.2;
  const EPS = 1e-6;
  /** Campos do corte que a revisão lê, grava e restaura (o histórico guarda só estes). */
  const FIELD_KEYS = Object.freeze(['status', 'reviewedAt', 'reviewedRange', 'category', 'title', 'titleCustom', 'start', 'end']);
  const STATUS_LABEL = Object.freeze({ pending: 'Pendente', approved: 'Aprovado', rejected: 'Rejeitado' });

  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const round2 = (n) => Math.round(n * 100) / 100;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  /** "1 corte" / "3 cortes". */
  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many}`;
  }

  /** Mesmo formato de BF.util.fmt: "m:ss.d". */
  function fmtTime(sec) {
    const s = Math.max(0, sec || 0);
    const m = Math.floor(s / 60);
    return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
  }

  /** "32,7 s" (vírgula decimal, pt-BR). */
  function fmtSeconds(sec) {
    const v = round2(sec);
    const text = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
    return `${text.replace('.', ',')} s`;
  }

  /** "+0,1 s" / "-1 s" / "0 s". */
  function fmtDelta(sec) {
    const v = round2(sec);
    if (v === 0) return '0 s';
    return `${v > 0 ? '+' : '-'}${fmtSeconds(Math.abs(v))}`;
  }

  // ---------- intervalos ----------

  // arredondam para o centésimo sem errar por ponto flutuante (20,2 - 0,2 não vira 19,99)
  const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;
  const ceil2 = (n) => Math.ceil(n * 100 - 1e-9) / 100;

  /**
   * Valida/ajusta um intervalo: início >= 0, fim <= duração (se conhecida) e duração >= `min`.
   * `edges` diz quais bordas o usuário pediu para mexer (padrão: as duas): só elas são arredondadas e limitadas
   * ao vídeo; a outra segue EXATAMENTE como está (inclusive passando da duração: isso é o aviso "Fora da fonte",
   * não algo a corrigir em silêncio). Com `edges` vazio nada é tocado nem validado.
   * Devolve { start, end, valid, clamped, clampedEdges, reason? }; `clamped` = foi preciso limitar ao vídeo.
   */
  function clampRange(start, end, { duration = Infinity, min = MIN_LENGTH, edges = ['start', 'end'] } = {}) {
    if (!isNum(start) || !isNum(end)) return { start, end, valid: false, clamped: false, clampedEdges: [], reason: 'Tempo inválido: informe números.' };
    const moves = new Set(edges);
    if (!moves.size) return { start, end, valid: true, clamped: false, clampedEdges: [] };
    const known = isNum(duration) && duration > 0;
    let s = moves.has('start') ? round2(start) : start;
    let e = moves.has('end') ? round2(end) : end;
    const limited = new Set();
    if (moves.has('start') && s < 0) { s = 0; limited.add('start'); }
    if (moves.has('end') && known && e > duration + EPS) { e = round2(duration); limited.add('end'); }
    if (moves.has('start') && known && s > duration - min + EPS) { s = Math.max(0, floor2(duration - min)); limited.add('start'); }
    const clampedEdges = [...limited];
    const clamped = clampedEdges.length > 0;
    if (e - s < min - EPS) {
      // o corte inteiro (ou quase) está depois do fim do vídeo e só o fim foi pedido: empurrar o início seria mexer no que não foi pedido
      if (!moves.has('start') && known && s > duration - min + EPS) {
        return { start: s, end: e, valid: false, clamped, clampedEdges, reason: `O início do corte (${fmtTime(s)}) já está depois do fim do vídeo (${fmtTime(duration)}). Ajuste o início primeiro.` };
      }
      return { start: s, end: e, valid: false, clamped, clampedEdges, reason: `O corte precisa ter pelo menos ${fmtSeconds(min)} (o fim deve ser maior que o início).` };
    }
    return { start: s, end: e, valid: true, clamped, clampedEdges };
  }

  /**
   * Move uma borda: `change` = { delta } (relativo) ou { value } (absoluto). A borda para no limite
   * (0, duração, ou a outra borda +/- mínimo) em vez de falhar; `clamped` avisa que foi limitada.
   * A outra borda nunca é alterada.
   */
  function adjustEdge(range, edge, change, opts = {}) {
    const min = opts.min === undefined ? MIN_LENGTH : opts.min;
    const current = edge === 'start' ? range.start : range.end;
    const target = change && change.value !== undefined ? Number(change.value) : current + Number(change && change.delta !== undefined ? change.delta : 0);
    if (!isNum(target)) return { start: range.start, end: range.end, valid: false, clamped: false, clampedEdges: [], reason: 'Tempo inválido: informe um número.' };
    let { start, end } = range;
    let clamped = false;
    if (edge === 'start') {
      start = target;
      if (start > end - min) { start = floor2(end - min); clamped = true; }
    } else {
      end = target;
      if (end < start + min) { end = ceil2(start + min); clamped = true; }
    }
    const out = clampRange(start, end, { ...opts, edges: [edge] });
    const clampedEdges = clamped && !out.clampedEdges.includes(edge) ? [edge, ...out.clampedEdges] : out.clampedEdges;
    return { ...out, clamped: out.clamped || clamped, clampedEdges };
  }

  // ---------- campos revisáveis ----------

  function fieldEq(a, b) {
    if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
    if (isNum(a) && isNum(b)) return Math.abs(a - b) <= EPS;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => fieldEq(v, b[i]));
    return a === b;
  }

  /** Cópia dos campos revisáveis do corte (`keys` limita quais); ausente vira null. */
  function snapshot(cut, keys = FIELD_KEYS) {
    const out = {};
    for (const key of keys) {
      const v = cut[key];
      out[key] = v === undefined ? null : clone(v);
    }
    return out;
  }

  /** true se todos os campos de `fields` já valem no corte. */
  function matches(cut, fields) {
    return Object.keys(fields).every((key) => fieldEq(cut[key], fields[key]));
  }

  const hasRange = (r) => Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1]);

  /**
   * Grava `fields` no corte (no lugar). Se início/fim mudarem: `revision` +1 e, quando o corte já estava
   * revisado e ainda não tinha `reviewedRange`, guarda o tempo de antes (é o que marca "alterado").
   * `updatedAt` = now quando algo muda. Devolve { touched, timesChanged }.
   */
  function applyFields(cut, fields, now) {
    const wasReviewed = cut.status === 'approved' || cut.status === 'rejected';
    const hadRange = hasRange(cut.reviewedRange);
    const oldStart = cut.start;
    const oldEnd = cut.end;
    let touched = false;
    for (const key of FIELD_KEYS) {
      if (!(key in fields)) continue;
      const value = clone(fields[key]);
      if (fieldEq(cut[key], value)) continue;
      if (key === 'titleCustom' && (value === null || value === undefined)) delete cut.titleCustom;
      else cut[key] = value === undefined ? null : value;
      touched = true;
    }
    const timesChanged = Math.abs(cut.start - oldStart) > EPS || Math.abs(cut.end - oldEnd) > EPS;
    if (timesChanged) {
      cut.revision = (isNum(cut.revision) ? cut.revision : 1) + 1;
      if (wasReviewed && !hadRange && !('reviewedRange' in fields)) cut.reviewedRange = [oldStart, oldEnd];
    }
    if (touched) cut.updatedAt = now;
    return { touched, timesChanged };
  }

  // ---------- indicadores ----------

  /** Estado de revisão derivado (não é gravado): revisado? alterado desde a revisão? */
  function reviewState(cut) {
    const reviewed = cut.status === 'approved' || cut.status === 'rejected';
    const range = hasRange(cut.reviewedRange) ? cut.reviewedRange : null;
    const changed = Boolean(reviewed && range && (Math.abs(range[0] - cut.start) > EPS || Math.abs(range[1] - cut.end) > EPS));
    return { reviewed, changed, reviewedRange: range, origin: cut.origin === 'auto' ? 'auto' : 'manual' };
  }

  /** A exportação `entry` (cut.exports[]) foi feita com os tempos que o corte tem agora? Sem os tempos gravados, vale a `revision`. */
  function exportMatches(entry, cut) {
    if (!entry || typeof entry !== 'object') return false;
    if (isNum(entry.start) && isNum(entry.end)) return fieldEq(entry.start, cut.start) && fieldEq(entry.end, cut.end);
    if (isNum(entry.revision) && isNum(cut.revision)) return entry.revision === cut.revision;
    return true; // sem como comparar: não acusa defasagem
  }

  /**
   * Última exportação do corte e se ela ficou defasada. Devolve { last, stale }: `last` = a exportação mais recente que
   * bate com os tempos de agora (se o usuário voltou ao tempo exportado, ela volta a valer) ou, não havendo, a mais
   * recente de todas com `stale: true` ("o arquivo foi gerado com outro início/fim"); null se nunca exportou.
   */
  function exportState(cut) {
    const list = (Array.isArray(cut.exports) ? cut.exports : []).filter((e) => e && typeof e === 'object' && e.path);
    if (!list.length) return { last: null, stale: false };
    for (let i = list.length - 1; i >= 0; i--) if (exportMatches(list[i], cut)) return { last: list[i], stale: false };
    return { last: list[list.length - 1], stale: true };
  }

  return {
    MIN_LENGTH, EPS, FIELD_KEYS, STATUS_LABEL,
    isNum, round2, clone, plural, fmtTime, fmtSeconds, fmtDelta,
    clampRange, adjustEdge, fieldEq, snapshot, matches, applyFields, reviewState, hasRange, exportState
  };
});
