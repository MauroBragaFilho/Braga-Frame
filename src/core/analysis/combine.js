'use strict';

const { clamp01, slidingMax } = require('./stats');
const { suggestionLimit, perWindowLimit } = require('./params');

/**
 * Combina os sinais (cada um já com pontuação 0..1 por segundo) em sugestões de corte.
 *
 *  1. Cada sinal é multiplicado pelo seu peso e "dilatado" ±alignToleranceSec (sinais levemente fora de
 *     sincronia ainda concordam).
 *  2. Evidências independentes se somam como "ou ruidoso": relevância = 1 - Π(1 - evidência). Um sinal
 *     forte sozinho já pode passar; dois sinais médios no mesmo instante passam juntos.
 *  3. Escolha gulosa dos picos, do mais relevante ao menos: a extensão do evento é onde a pontuação
 *     (sem a dilatação) fica acima de metade do pico (aceitando buracos de até 2 s); entram as margens de antes/depois
 *     (preferências); respeita duração mínima e máxima; nunca se sobrepõe a um trecho já escolhido.
 *  4. Só ficam picos com relevância >= minRelevance, até o teto de quantidade.
 *  5. (v4) O empate entre picos de mesma pontuação se resolve pela pontuação do entorno (nunca pela ordem do tempo), as sugestões se
 *     distribuem por TODA a duração (no máximo `perWindow` por janela de `spread.windowSec`, com `spread.minGapSec` de folga entre uma
 *     e outra) e, quando há transcrição (`alignTo`), o início e o fim vão para limites de falas.
 *
 * `signals`: [{ id, score: Float64Array(n), describe(from, to) -> [{ text, strength }] }]
 * `alignTo` (opcional): { starts: number[], ends: number[] } = início e fim das falas da transcrição, em ordem crescente.
 * `blocked` (opcional): sugestões já escolhidas por outra rodada ([{ start, end }]): este trecho não entra em nenhuma delas nem encosta nelas
 * (a rodada dos momentos calmos, que tem cota própria, usa isto; as telas de espera entre episódios também, com `gap: 0`: a folga entre
 * sugestões não vale para elas, e o corte pode começar logo que a espera acaba). `limitOverride` (opcional): o teto de sugestões desta rodada.
 * `groups` (opcional, cota por episódio): trechos [{ start, end }] que devem ter pelo menos uma sugestão cada. Primeiro, enquanto houver
 * grupo sem sugestão, o pico é procurado só nos grupos vazios (o melhor deles vence; a cota por janela não barra esta rodada, mas conta);
 * grupo sem nenhum pico acima da relevância mínima fica sem. Depois, a escolha de sempre no vídeo inteiro, até o teto.
 * `discard` (opcional, filtro de ideias fracas): (sugestão com `evidence` = ["text:laugh", "audio:level", …]) -> motivo | null. Descartada, a
 * vaga vai para o próximo pico e ela entra em `discarded` (lista opcional que quem chamou passa) com o motivo.
 * `tailOut` (opcional: "fim cobrindo a reação"): { active: Uint8Array(n) (1 = reação marcada neste segundo, hoje a risada da transcrição),
 *   maxSec, gapSec }. A risada vem DEPOIS do lance e a pista dela pontua os segundos ANTERIORES, então o corte terminava quando a risada
 *   começava (medido numa gameplay: quatro crises de riso, as quatro cortadas no começo da risada). Com isto o fim vai até o fim dela.
 * `leadIn` (opcional, perfil de gameplay: "início no lance"): { signal: Float64Array(n), baseSec, maxSec, gapSec, minScore }. A reação do
 * streamer vem DEPOIS do lance; o início volta pelo menos `baseSec` antes do evento e, se `signal` (o som do jogo) estava ativo antes
 * (>= minScore), segue essa atividade para trás, aceitando buracos de até `gapSec`, até `maxSec`. O fim fica onde estava, a duração
 * máxima continua valendo e o início nunca invade o espaço de outra sugestão.
 * Devolve sugestões ordenadas por relevância (decrescente).
 */

const GAP_SEC = 2;
const MIN_ACTIVATION = 0.15;
const PLATEAU_EPS = 0.02;
const TIE_EPS = 1e-9; // pontuações iguais até aqui empatam: decide a pontuação do entorno
const SNAP_START_BACK_SEC = 4; // o início anda até 4 s para trás (começo de fala) ou até 2 s para frente
const SNAP_START_FORWARD_SEC = 2;
const SNAP_END_FORWARD_SEC = 4; // o fim anda até 4 s para frente (fim de fala) ou até 2 s para trás
const SNAP_END_BACK_SEC = 2;
const LEAD_SNAP_BACK_SEC = 6; // início no lance (gameplay): o começo de fala pode estar até 6 s antes do início calculado

const round1 = (x) => Math.round(x * 10) / 10;
const round3 = (x) => Math.round(x * 1000) / 1000;

/** Primeiro índice de `arr` (crescente) com valor >= x. */
function lowerBound(arr, x) {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (arr[mid] < x) a = mid + 1; else b = mid;
  }
  return a;
}

/**
 * Leva o início para o começo de uma fala (até 4 s antes, senão até 2 s depois) e o fim para o fim de uma fala (até 4 s depois, senão
 * até 2 s antes), sem sair do espaço livre [lo, hi] nem das durações permitidas: o lado que estragaria algum limite fica como estava.
 */
function snapToSpeech(start, end, alignTo, { lo, hi, minDur, maxDur }) {
  let s = start;
  let e = end;
  const { starts, ends } = alignTo;
  // `alignTo.reach` (perfil de conversa): quanto o início e o fim podem andar até um limite de frase; sem ele, os de sempre
  const reach = alignTo.reach || {};
  const startBack = reach.startBack ?? SNAP_START_BACK_SEC;
  const startForward = reach.startForward ?? SNAP_START_FORWARD_SEC;
  const endForward = reach.endForward ?? SNAP_END_FORWARD_SEC;
  const endBack = reach.endBack ?? SNAP_END_BACK_SEC;
  if (starts && starts.length) {
    const i = lowerBound(starts, start + 1e-6); // primeira fala que começa DEPOIS do início
    const prev = i > 0 ? starts[i - 1] : null;
    const next = i < starts.length ? starts[i] : null;
    if (prev !== null && start - prev <= startBack) s = prev;
    else if (next !== null && next - start <= startForward) s = next;
  }
  if (ends && ends.length) {
    const j = lowerBound(ends, end - 1e-6); // primeira fala que termina em ou depois do fim
    const next = j < ends.length ? ends[j] : null;
    const prev = j > 0 ? ends[j - 1] : null;
    if (next !== null && next - end <= endForward) e = next;
    else if (prev !== null && end - prev <= endBack) e = prev;
  }
  if (s < lo - 1e-9) s = start;
  if (e > hi + 1e-9) e = end;
  const fits = (a, b) => b - a <= maxDur + 1e-9 && b - a >= minDur - 1e-9;
  if (fits(s, e)) return { start: s, end: e };
  if (fits(s, end)) return { start: s, end };
  if (fits(start, e)) return { start, end: e };
  return { start, end };
}

function combine({ n, duration, signals, params, alignTo = null, blocked = [], limitOverride = null, groups = [], leadIn = null, tailOut = null, discard = null, discarded = null }) {
  if (!n || !signals.length) return [];
  const parts = signals
    .map((s) => {
      const w = params.weights[s.id] ?? 1;
      const e = new Float64Array(n);
      for (let k = 0; k < n; k += 1) e[k] = clamp01(w * s.score[k]);
      return { s, w, e, d: slidingMax(e, params.alignToleranceSec) };
    })
    .filter((p) => p.w > 0);
  if (!parts.length) return [];

  const c = new Float64Array(n); // com dilatação: acha o pico e dá a relevância
  const u = new Float64Array(n); // sem dilatação: dá a extensão real do evento
  for (let k = 0; k < n; k += 1) {
    let restC = 1;
    let restU = 1;
    for (const p of parts) { restC *= 1 - p.d[k]; restU *= 1 - p.e[k]; }
    c[k] = 1 - restC;
    u[k] = 1 - restU;
  }
  const tol = params.alignToleranceSec;

  const total = duration > 0 ? duration : n;
  // o fim de uma sugestão é arredondado para 0,1 s: o teto é a duração TRUNCADA a 0,1 s, para o arredondamento nunca passar do fim real
  const capEnd = Math.floor(total * 10 + 1e-6) / 10;
  const { minDurationSec: minDur, maxDurationSec: maxDur, padBeforeSec, padAfterSec, minRelevance } = params;
  const limit = limitOverride || suggestionLimit(params, total);
  // distribuição pela duração: no máximo `perWindow` sugestões por janela e `minGap` s de folga entre uma e outra
  const spread = params.spread || { windowSec: 600, perWindow: null, minGapSec: 0 };
  const windowSec = Math.max(1, spread.windowSec || 600);
  const perWindow = perWindowLimit({ ...params, spread: { ...spread, windowSec } }, total, limit);
  const minGap = Math.max(0, spread.minGapSec || 0);
  const perBucket = new Map(); // janela -> quantas sugestões já escolhidas
  const closed = new Uint8Array(n); // segundos de janelas que já esgotaram a cota: não podem mais ser pico
  const consumed = new Uint8Array(n);
  const chosen = [];
  const out = [];
  for (const seg of blocked) {
    const gap = typeof seg.gap === 'number' ? Math.max(0, seg.gap) : minGap;
    chosen.push({ start: seg.start, end: seg.end, gap }); // os vizinhos limitam o espaço livre ao redor do pico, com a mesma folga
    for (let k = Math.max(0, Math.floor(seg.start - gap)); k < Math.min(n, Math.ceil(seg.end + gap)); k += 1) consumed[k] = 1;
  }

  // cota por episódio: de que grupo é cada segundo (-1 = nenhum) e quais grupos já têm sugestão
  const groupOf = new Int32Array(n).fill(-1);
  groups.forEach((g, i) => { for (let k = Math.max(0, Math.ceil(g.start)); k < Math.min(n, Math.floor(g.end)); k += 1) groupOf[k] = i; });
  const filled = new Uint8Array(groups.length);
  let guarantee = groups.length > 0;

  const sumBins = (a, b) => {
    let sum = 0;
    for (let k = Math.max(0, Math.floor(a)); k < Math.min(n, Math.ceil(b)); k += 1) sum += c[k];
    return sum;
  };

  /**
   * Um trecho escolhido "gasta" a evidência dele: zera os sinais nos segundos consumidos e refaz a
   * dilatação por perto. Sem isso, a "sombra" da dilatação ao lado de um evento já usado viraria um
   * falso evento (relevância máxima, sem motivo nenhum).
   */
  function spend(from, to) {
    const lo = Math.max(0, from);
    const hi = Math.min(n - 1, to);
    for (let k = lo; k <= hi; k += 1) { u[k] = 0; for (const p of parts) p.e[k] = 0; }
    for (let k = Math.max(0, lo - tol); k <= Math.min(n - 1, hi + tol); k += 1) {
      let restC = 1;
      for (const p of parts) {
        let m = 0;
        for (let j = Math.max(0, k - tol); j <= Math.min(n - 1, k + tol); j += 1) if (p.e[j] > m) m = p.e[j];
        p.d[k] = m;
        restC *= 1 - m;
      }
      c[k] = 1 - restC;
    }
  }

  /** Pico que não vira sugestão: o evento inteiro sai da disputa. */
  function drop(from, to) {
    for (let k = Math.max(0, from); k <= Math.min(n - 1, to); k += 1) consumed[k] = 1;
    spend(from, to);
  }

  while (out.length < limit) {
    let p0 = -1;
    let best = 0;
    let bestMass = -1;
    for (let k = 0; k < n; k += 1) {
      if (consumed[k] || !(c[k] > 0)) continue;
      if (guarantee ? groupOf[k] < 0 || filled[groupOf[k]] : closed[k]) continue;
      if (c[k] > best + TIE_EPS) { best = c[k]; p0 = k; bestMass = -1; } else if (p0 >= 0 && c[k] >= best - TIE_EPS) {
        // empate exato: vence quem tem mais pontuação ao redor (nunca a ordem do tempo)
        if (bestMass < 0) bestMass = sumBins(p0 - maxDur / 2, p0 + maxDur / 2);
        const mass = sumBins(k - maxDur / 2, k + maxDur / 2);
        if (mass > bestMass + TIE_EPS) { p0 = k; bestMass = mass; }
      }
    }
    if (p0 < 0 || best < minRelevance || best <= 0) {
      if (guarantee) { guarantee = false; continue; } // nenhum grupo vazio tem pico que preste: segue a escolha de sempre
      break;
    }

    // meio do platô do pico
    let l0 = p0;
    while (l0 - 1 >= 0 && !consumed[l0 - 1] && c[l0 - 1] >= best - PLATEAU_EPS) l0 -= 1;
    let r0 = p0;
    while (r0 + 1 < n && !consumed[r0 + 1] && c[r0 + 1] >= best - PLATEAU_EPS) r0 += 1;
    const peak = (l0 + r0) >> 1;

    // extensão do evento: a partir de onde a pontuação real (sem dilatação) é máxima perto do pico
    let pu = peak;
    for (let d = 0; d <= tol; d += 1) {
      if (peak - d >= 0 && !consumed[peak - d] && u[peak - d] > u[pu]) pu = peak - d;
      if (peak + d < n && !consumed[peak + d] && u[peak + d] > u[pu]) pu = peak + d;
    }
    const thr = Math.max(MIN_ACTIVATION, u[pu] * 0.5);
    let l = pu;
    let gap = 0;
    for (let k = pu - 1; k >= 0 && pu - k <= maxDur; k -= 1) {
      if (consumed[k]) break;
      if (u[k] >= thr) { l = k; gap = 0; } else { gap += 1; if (gap > GAP_SEC) break; }
    }
    let r = pu;
    gap = 0;
    for (let k = pu + 1; k < n && k - pu <= maxDur; k += 1) {
      if (consumed[k]) break;
      if (u[k] >= thr) { r = k; gap = 0; } else { gap += 1; if (gap > GAP_SEC) break; }
    }
    l = Math.min(l, peak);
    r = Math.max(r, peak);

    // intervalo livre ao redor do pico (entre trechos já escolhidos e os limites do vídeo)
    const center = peak + 0.5;
    let lo = 0;
    let hi = capEnd;
    for (const seg of chosen) {
      const gap = seg.gap ?? minGap;
      if (seg.end <= center) lo = Math.max(lo, seg.end + gap);
      else if (seg.start >= center) hi = Math.min(hi, seg.start - gap);
    }

    let start = Math.max(lo, l - padBeforeSec);
    let end = Math.min(hi, r + 1 + padAfterSec);

    // duração máxima: a janela de maxDur que contém o pico e junta mais pontuação
    if (end - start > maxDur) {
      const sMax = end - maxDur;
      let sLo = Math.max(start, peak + 1 - maxDur);
      let sHi = Math.min(sMax, peak);
      if (sLo > sHi) { sLo = Math.min(Math.max(center - maxDur / 2, start), sMax); sHi = sLo; }
      let bestS = sLo;
      let bestSum = -1;
      for (let s = sLo; s <= sHi + 1e-9; s += 1) {
        const sum = sumBins(s, s + maxDur);
        const tie = Math.abs(s + maxDur / 2 - center);
        if (sum > bestSum + 1e-9 || (Math.abs(sum - bestSum) <= 1e-9 && tie < Math.abs(bestS + maxDur / 2 - center))) { bestSum = sum; bestS = s; }
      }
      start = bestS;
      end = bestS + maxDur;
    }

    // duração mínima: estende dos dois lados dentro do espaço livre
    if (end - start < minDur) {
      if (hi - lo < minDur) { drop(Math.min(l, p0), Math.max(r, r0)); continue; } // não cabe: este pico não vira sugestão
      const need = minDur - (end - start);
      let s2 = start - need / 2;
      let e2 = end + need / 2;
      if (s2 < lo) { e2 += lo - s2; s2 = lo; }
      if (e2 > hi) { s2 -= e2 - hi; e2 = hi; }
      start = Math.max(lo, s2);
      end = Math.min(hi, e2);
    }

    // gameplay: o corte começa no lance, não na reação (veja `leadIn` acima)
    if (leadIn) {
      let b = l;
      let quiet = 0;
      for (let k = l - 1; k >= Math.max(0, Math.ceil(lo), l - leadIn.maxSec); k -= 1) {
        if (consumed[k]) break;
        if (leadIn.signal[k] >= leadIn.minScore) { b = k; quiet = 0; } else if ((quiet += 1) > leadIn.gapSec) break;
      }
      const want = Math.min(l - leadIn.baseSec, b - padBeforeSec);
      if (want < start) {
        let s2 = Math.max(lo, want, end - maxDur);
        // com transcrição, o novo início também é começo de fala: o último antes dele (sem sair do espaço livre nem passar da duração
        // máxima), senão o primeiro depois dele (sem passar do início que já existia)
        if (alignTo && alignTo.starts && alignTo.starts.length) {
          const i = lowerBound(alignTo.starts, s2 + 1e-6);
          const prev = i > 0 ? alignTo.starts[i - 1] : null;
          const next = i < alignTo.starts.length ? alignTo.starts[i] : null;
          if (prev !== null && prev >= lo - 1e-9 && s2 - prev <= LEAD_SNAP_BACK_SEC && end - prev <= maxDur + 1e-9) s2 = prev;
          else if (next !== null && next < start) s2 = next;
          else s2 = start;
        }
        start = Math.min(start, s2);
      }
    }

    // o corte termina DEPOIS da reação, não quando ela começa (veja `tailOut` acima): segue a reação marcada a partir do fim atual,
    // tolerando buracos de gapSec, até maxSec a mais e sem sair do espaço livre. Se estourar a duração máxima, quem anda é o começo
    // (o desfecho vale mais que a preparação), sem passar do começo do pico.
    if (tailOut) {
      let last = -1;
      let quiet = 0;
      const stop = Math.min(n - 1, Math.floor(hi) - 1, Math.floor(end) + tailOut.maxSec);
      for (let k = Math.max(0, Math.floor(end) - 2); k <= stop; k += 1) {
        if (tailOut.active[k]) { last = k; quiet = 0; } else if ((quiet += 1) > tailOut.gapSec) break;
      }
      if (last >= Math.floor(end)) {
        let e2 = Math.min(hi, last + 1 + padAfterSec);
        if (e2 - start > maxDur) start = Math.min(Math.max(start, e2 - maxDur), Math.max(start, l - 1));
        if (e2 - start > maxDur) e2 = start + maxDur;
        end = Math.max(end, e2);
      }
    }

    // com transcrição, começa e termina em limites de falas (nunca no meio de uma frase)
    if (alignTo) ({ start, end } = snapToSpeech(start, end, alignTo, { lo, hi, minDur, maxDur }));

    start = round1(start);
    end = round1(end);
    if (end - start <= 0) { drop(Math.min(l, p0), Math.max(r, r0)); continue; }

    // motivos e contribuição de cada sinal dentro do trecho do evento (antes de gastar a evidência)
    const from = Math.max(0, Math.min(l, n - 1));
    const to = Math.max(from, Math.min(r, n - 1));
    const reasons = [];
    const evidence = []; // o TIPO de cada motivo ("text:laugh", "audio:level"…): é o que o filtro de ideias fracas olha
    const contrib = {};
    for (const p of parts) {
      let strength = 0;
      for (let k = from; k <= to; k += 1) if (p.e[k] > strength) strength = p.e[k];
      contrib[p.s.id] = Math.round(strength * 100) / 100;
      if (strength < 0.1) continue;
      for (const item of p.s.describe(from, to)) {
        const weighted = clamp01(item.strength * p.w);
        if (weighted >= 0.1 && !reasons.some((x) => x.text === item.text)) reasons.push({ text: item.text, strength: weighted });
        if (weighted >= 0.1) {
          // o tipo do motivo e, se o sinal informar, tipos extras do mesmo motivo (`also`, ex.: a risada longa leva também 'laughrun')
          for (const name of [item.kind || 'other', ...(Array.isArray(item.also) ? item.also : [])]) {
            const kind = `${p.s.id}:${name}`;
            if (!evidence.includes(kind)) evidence.push(kind);
          }
        }
      }
    }
    reasons.sort((a, b) => b.strength - a.strength);

    // filtro de ideias fracas: descartada, a vaga vai para o próximo pico (o evento inteiro sai da disputa)
    if (discard) {
      const why = discard({ start, end, peak: peak + 0.5, relevance: best, reasons: reasons.map((x) => x.text), evidence });
      if (why) {
        if (Array.isArray(discarded)) {
          discarded.push({ start, end, peak: Math.min(peak + 0.5, total), relevance: round3(best), reasons: reasons.map((x) => x.text), evidence, why });
        }
        drop(Math.min(l, p0), Math.max(r, r0));
        continue;
      }
    }

    chosen.push({ start, end });
    const spentFrom = Math.floor(start);
    const spentTo = Math.ceil(end) - 1;
    for (let k = 0; k < n; k += 1) if (k + 0.5 >= start && k + 0.5 < end) consumed[k] = 1;
    spend(spentFrom, spentTo);
    // folga: o próximo trecho não começa colado neste
    if (minGap > 0) for (let k = Math.max(0, Math.floor(start - minGap)); k < Math.min(n, Math.ceil(end + minGap)); k += 1) consumed[k] = 1;
    // cota da janela de ~10 min: ao esgotar, nenhum outro pico dessa janela é escolhido
    const bucket = Math.floor((peak + 0.5) / windowSec);
    const used = (perBucket.get(bucket) || 0) + 1;
    perBucket.set(bucket, used);
    if (used >= perWindow) for (let k = Math.max(0, Math.floor(bucket * windowSec)); k < Math.min(n, Math.ceil((bucket + 1) * windowSec)); k += 1) closed[k] = 1;
    const group = groupOf[peak] >= 0 ? groupOf[peak] : groupOf[p0];
    if (group >= 0) filled[group] = 1;
    if (guarantee && filled.every(Boolean)) guarantee = false;

    out.push({
      id: `${Math.round(start * 10)}_${Math.round(end * 10)}`,
      start,
      end,
      peak: Math.min(peak + 0.5, total),
      relevance: round3(best),
      reasons: reasons.map((x) => x.text),
      evidence,
      signals: contrib
    });
  }
  return out.sort((a, b) => b.relevance - a.relevance);
}

module.exports = { combine };
