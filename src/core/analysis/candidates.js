'use strict';

/**
 * PRÉ-FILTRO LOCAL de candidatos: acha, sem IA, onde pode haver um corte e devolve JANELAS CANDIDATAS de 45 a 90 s. Só elas (com 15 s de
 * contexto de cada lado) vão para a IA no modo "janelas candidatas", em vez da transcrição inteira.
 *
 * Eventos (cada um com um desvio z contra a vizinhança de 3 min):
 *   - ÁUDIO: nível sustentado (~3 s) acima da média + 1,8 desvio padrão da janela local de 3 min. A média e o desvio contam só quadros
 *     de FALA (acima do piso de ruído): o volume sozinho engana (silêncio -> fala parece subida enorme), então a subida só vale se os
 *     ~10 s anteriores tinham fala (a mesma lição de audioSignal.js, seção 13 de analise-ia.md). O volume NUNCA vai para a IA: só decide
 *     onde olhar.
 *   - CHAT: pico de mensagens (soma de ~10 s acima da média + 1,8 desvio da janela local), deslocado em `chatOffsetSec` (padrão -5 s: o público
 *     reage alguns segundos depois do lance, então o momento é ANTES do pico).
 *   - RISADA marcada na transcrição (`laugh`).
 * Um grupo de eventos próximos vira janela se tem dois tipos de evento (sobreposição) ou um pico isolado forte. O número de janelas é limitado
 * pela fração do vídeo que podem cobrir (padrão 35%): é isso que corta os tokens.
 *
 * MEDIDO (17/11/2026, 17 lives reais, 31 h, contra o gráfico de "mais reassistidos" do YouTube; scripts/medir-janelas.js e docs/recursos/analise-ia.md,
 * seção 18): só áudio + risada é um pré-filtro FRACO (o volume sozinho já era fraco: seção 2). As sugestões do próprio algoritmo (que juntam áudio, imagem,
 * texto e chat) tocam o dobro dos picos para a mesma cobertura. Por isso `windowsFromSuggestions` existe e é a fonte principal quando há sugestões do
 * algoritmo; os eventos de áudio, chat e risada completam o que sobrar do orçamento de cobertura.
 */

const { noiseFloor } = require('./audioSignal');

const DEFAULTS = Object.freeze({
  k: 1.8,                 // desvios padrão acima da vizinhança
  localSec: 180,          // vizinhança (janela local de 3 min)
  sustainSec: 3,          // o nível de áudio é a média de ~3 s
  minPeakDb: -45,         // nível absoluto mínimo para valer como destaque de áudio
  minSigmaDb: 3,          // piso do desvio padrão de áudio (fala muito constante não explode)
  chatSmoothSec: 10,
  chatOffsetSec: -5,      // entre -4 e -6 s
  chatMinMessages: 3,     // mensagens na janela de 10 s para um pico de chat valer
  linkSec: 25,            // eventos a menos que isso um do outro são o mesmo grupo
  isolatedZ: 2.6,         // um evento sozinho precisa disto (áudio) ou isolatedChatZ (chat)
  isolatedChatZ: 3.2,
  minWindowSec: 45,
  maxWindowSec: 90,
  beforeShare: 0.6,       // da folga da janela, quanto fica antes do evento (a premissa vem antes da reação)
  maxCoverage: 0.35,      // as janelas (com o contexto) cobrem no máximo isto do vídeo
  contextSec: 15,         // contexto enviado de cada lado (só para estimar a cobertura; quem monta o pedido usa o mesmo)
  minWindows: 3           // abaixo disto o pré-filtro não ajuda: quem chama volta ao método de blocos
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Média e desvio padrão por janela local, em O(n), por somas acumuladas só dos itens com `use[i]` verdadeiro. */
function localStats(values, use, halfFrames) {
  const n = values.length;
  const cnt = new Float64Array(n + 1);
  const sum = new Float64Array(n + 1);
  const sq = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) {
    const v = use[i] ? values[i] : 0;
    cnt[i + 1] = cnt[i] + (use[i] ? 1 : 0);
    sum[i + 1] = sum[i] + v;
    sq[i + 1] = sq[i] + v * v;
  }
  return (i) => {
    const a = Math.max(0, i - halfFrames);
    const b = Math.min(n, i + halfFrames + 1);
    const c = cnt[b] - cnt[a];
    if (c < 8) return null;
    const mean = (sum[b] - sum[a]) / c;
    const variance = Math.max(0, (sq[b] - sq[a]) / c - mean * mean);
    return { mean, sigma: Math.sqrt(variance), count: c };
  };
}

/** Agrupa quadros vizinhos marcados em eventos { t (pico), z, from, to }. */
function groupFrames(marks, frameSec, gapFrames = 2) {
  const events = [];
  let cur = null;
  for (const m of marks) {
    if (cur && m.i - cur.lastI <= gapFrames) {
      cur.lastI = m.i;
      if (m.z > cur.z) { cur.z = m.z; cur.peakI = m.i; }
    } else {
      if (cur) events.push(cur);
      cur = { firstI: m.i, lastI: m.i, peakI: m.i, z: m.z };
    }
  }
  if (cur) events.push(cur);
  return events.map((e) => ({ t: e.peakI * frameSec, z: e.z, from: e.firstI * frameSec, to: (e.lastI + 1) * frameSec }));
}

/** Eventos de áudio a partir de `db` (dBFS por quadro de `frameSec`, como extractAudio). */
function audioEvents(db, { frameSec = 0.5, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = db.length;
  if (n < 20) return [];
  const floor = noiseFloor(db);
  const active = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) active[i] = db[i] > floor ? 1 : 0;
  const half = Math.max(1, Math.round(o.sustainSec / frameSec / 2));
  // nível sustentado: média dos quadros ativos em ±half (exige 40% de quadros ativos)
  const level = new Float64Array(n).fill(NaN);
  const pa = new Float64Array(n + 1);
  const pd = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) { pa[i + 1] = pa[i] + active[i]; pd[i + 1] = pd[i] + (active[i] ? db[i] : 0); }
  for (let i = 0; i < n; i += 1) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const c = pa[b] - pa[a];
    if (c >= 0.4 * (b - a) && c >= 2) level[i] = (pd[b] - pd[a]) / c;
  }
  const lv = new Float64Array(n);
  const useLv = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) { if (!Number.isNaN(level[i])) { lv[i] = level[i]; useLv[i] = 1; } }
  const stats = localStats(lv, useLv, Math.round(o.localSec / frameSec / 2));
  const lookFrom = Math.round(12 / frameSec);
  const lookTo = Math.round(2 / frameSec);
  const marks = [];
  for (let i = 0; i < n; i += 1) {
    if (!useLv[i] || level[i] < o.minPeakDb) continue;
    const st = stats(i);
    if (!st) continue;
    const sigma = Math.max(o.minSigmaDb, st.sigma);
    const z = (level[i] - st.mean) / sigma;
    if (z < o.k) continue;
    marks.push({ i, z });
  }
  // a subida só vale se os ~10 s ANTERIORES AO COMEÇO dela tinham fala (silêncio -> fala é começo de frase, não destaque)
  const hadSpeechBefore = (from) => {
    const first = Math.round(from / frameSec);
    const a = Math.max(0, first - lookFrom);
    const b = Math.max(0, first - lookTo);
    return b - a >= 4 && (pa[b] - pa[a]) / (b - a) >= 0.4;
  };
  return groupFrames(marks, frameSec, Math.round(2 / frameSec)).filter((e) => hadSpeechBefore(e.from)).map((e) => ({ ...e, kind: 'audio' }));
}

/** Eventos de chat: picos de mensagens, deslocados em `chatOffsetSec` (negativo: o momento veio ANTES da reação). */
function chatEvents(messages, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = Math.ceil(duration);
  if (!Array.isArray(messages) || !messages.length || n < 30) return [];
  const per = new Float64Array(n);
  for (const m of messages) {
    const s = Math.floor(m && m.t);
    if (Number.isFinite(s) && s >= 0 && s < n) per[s] += 1;
  }
  const w = Math.max(1, Math.round(o.chatSmoothSec));
  const smooth = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < n; i += 1) { run += per[i]; if (i >= w) run -= per[i - w]; smooth[i] = run; }
  const use = new Uint8Array(n).fill(1);
  const stats = localStats(smooth, use, Math.round(o.localSec / 2));
  const avgRate = messages.length / n;
  const minMessages = avgRate < 0.05 ? Math.max(2, o.chatMinMessages - 1) : o.chatMinMessages; // chat pequeno: 2 mensagens já é reação
  const marks = [];
  for (let i = 0; i < n; i += 1) {
    if (smooth[i] < minMessages) continue;
    const st = stats(i);
    if (!st) continue;
    const sigma = Math.max(st.sigma, Math.sqrt(Math.max(st.mean, 0.5)), 0.5);
    const z = (smooth[i] - st.mean) / sigma;
    if (z >= o.k) marks.push({ i, z });
  }
  return groupFrames(marks, 1, w).map((e) => ({ ...e, kind: 'chat', t: Math.max(0, e.t + o.chatOffsetSec) }));
}

/** Marcas de risada da transcrição como eventos. */
function laughEvents(cues) {
  const out = [];
  for (const c of Array.isArray(cues) ? cues : []) if (c && c.laugh) out.push({ t: c.start, z: 2, from: c.start, to: c.end, kind: 'laugh' });
  return out;
}

/**
 * Junta os eventos em janelas. Devolve [{ from, to, score, kinds:[…], peak }] em ordem de tempo.
 * @param {{ events:object[], duration:number }} x
 */
function buildCandidateWindows({ events, duration }, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sorted = [...events].filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  // 1) grupos de eventos vizinhos
  const groups = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (g && e.t - g.last <= o.linkSec) { g.events.push(e); g.last = e.t; } else groups.push({ events: [e], last: e.t });
  }
  // 2) o grupo vale? dois tipos de evento, duas risadas, ou um pico isolado forte
  const wins = [];
  for (const g of groups) {
    const kinds = [...new Set(g.events.map((e) => e.kind))];
    const best = (kind) => Math.max(0, ...g.events.filter((e) => e.kind === kind).map((e) => e.z));
    const laughs = g.events.filter((e) => e.kind === 'laugh').length;
    const strong = best('audio') >= o.isolatedZ || best('chat') >= o.isolatedChatZ;
    if (kinds.length < 2 && laughs < 2 && !strong) continue;
    const score = best('audio') / o.isolatedZ + best('chat') / o.isolatedChatZ + Math.min(laughs, 3) * 0.4 + (kinds.length - 1) * 0.5;
    const t0 = g.events[0].t;
    const t1 = g.events[g.events.length - 1].t;
    const peak = g.events.reduce((p, e) => (e.z > p.z ? e : p), g.events[0]).t;
    const len = clamp(t1 - t0 + 45, o.minWindowSec, o.maxWindowSec);
    let from = t0 - (len - (t1 - t0)) * o.beforeShare;
    from = clamp(from, 0, Math.max(0, duration - len));
    const to = Math.min(duration, from + len);
    if (to - from < Math.min(o.minWindowSec, duration)) continue;
    wins.push({ from: round1(from), to: round1(to), score, kinds, peak: round1(peak) });
  }
  // 3) sobreposições: junta se ainda cabe em maxWindowSec; senão apara o começo da seguinte (ou larga a mais fraca)
  const out = [];
  for (const w of wins.sort((a, b) => a.from - b.from)) {
    const prev = out[out.length - 1];
    if (!prev || w.from >= prev.to) { out.push({ ...w }); continue; }
    if (w.to - prev.from <= o.maxWindowSec) {
      prev.to = w.to; prev.score += w.score; prev.kinds = [...new Set([...prev.kinds, ...w.kinds])];
      if (w.score > prev.score / 2) prev.peak = w.peak;
    } else if (w.to - prev.to >= o.minWindowSec) out.push({ ...w, from: prev.to });
    else if (w.score > prev.score) { out[out.length - 1] = { ...w }; }
  }
  // 4) cobertura máxima: fica com as de maior pontuação até a soma (com o contexto) chegar ao limite
  const budget = Math.max(0, o.maxCoverage * duration);
  let used = 0;
  const kept = new Set();
  for (const w of [...out].sort((a, b) => b.score - a.score)) {
    const cost = w.to - w.from + 2 * o.contextSec;
    if (used + cost > budget && kept.size >= 1) continue;
    used += cost;
    kept.add(w);
  }
  return out.filter((w) => kept.has(w)).map((w, i) => ({ id: `w${i + 1}`, from: w.from, to: w.to, score: Math.round(w.score * 100) / 100, kinds: w.kinds, peak: w.peak }));
}

const round1 = (n) => Math.round(n * 10) / 10;

const overlapSec = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/**
 * Janelas de 45 a 90 s ao redor de sugestões do algoritmo ({ start, end, relevance? }): a premissa antes (60% da folga), as mais relevantes
 * primeiro, até o orçamento de cobertura (janela + contexto). Sugestão que cai quase toda em janela já escolhida não vira outra.
 * @returns {Array<{ id, from, to, score, kinds:['algorithm'], peak }>} em ordem de tempo
 */
function windowsFromSuggestions(suggestions, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const ranked = [...(Array.isArray(suggestions) ? suggestions : [])]
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => (Number.isFinite(b.relevance) ? b.relevance : 0) - (Number.isFinite(a.relevance) ? a.relevance : 0));
  const budget = Math.max(0, o.maxCoverage * duration);
  const out = [];
  let used = 0;
  for (const s of ranked) {
    const span = s.end - s.start;
    const len = clamp(span + 20, o.minWindowSec, o.maxWindowSec);
    const from = round1(clamp(s.start - (len - span) * o.beforeShare, 0, Math.max(0, duration - len)));
    const to = round1(Math.min(duration, from + len));
    if (to - from < Math.min(o.minWindowSec, duration)) continue;
    const cost = to - from + 2 * o.contextSec;
    if (used + cost > budget && out.length >= 1) continue;
    if (out.some((w) => overlapSec(from, to, w.from, w.to) > 0.5 * (to - from))) continue;
    used += cost;
    out.push({ from, to, score: Number.isFinite(s.relevance) ? s.relevance : 0, kinds: ['algorithm'], peak: round1(Number.isFinite(s.peak) ? s.peak : (s.start + s.end) / 2) });
  }
  return out.sort((a, b) => a.from - b.from).map((w, i) => ({ id: `w${i + 1}`, ...w }));
}

/**
 * Junta duas fontes: as janelas `primary` ficam todas; as de `secondary` só entram se não encostam em nenhuma da primeira e se cabem no que
 * sobra do orçamento (`maxCoverage` do vídeo, contando o contexto), as de maior pontuação primeiro. Devolve em ordem de tempo, com ids novos.
 */
function mergeWindows(primary, secondary, duration, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const budget = Math.max(0, o.maxCoverage * duration);
  const cost = (w) => w.to - w.from + 2 * o.contextSec;
  const out = [...primary];
  let used = out.reduce((n, w) => n + cost(w), 0);
  for (const w of [...secondary].sort((a, b) => (b.score || 0) - (a.score || 0))) {
    if (out.some((x) => overlapSec(w.from, w.to, x.from, x.to) > 0)) continue;
    if (used + cost(w) > budget) continue;
    used += cost(w);
    out.push(w);
  }
  return out.sort((a, b) => a.from - b.from).map((w, i) => ({ ...w, id: `w${i + 1}` }));
}

module.exports = { audioEvents, chatEvents, laughEvents, buildCandidateWindows, windowsFromSuggestions, mergeWindows, DEFAULTS };
