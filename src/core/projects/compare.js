'use strict';

/**
 * Comparação entre o que o projeto registrou da fonte e o arquivo que está sendo aberto agora (dono: prefs):
 * VOD que cresceu, arquivo regravado ou recodificado. Funções puras; nada é aplicado aqui — o gancho
 * `beforeOpen` mostra a diferença e só deixa a atualização seguir depois da confirmação do usuário.
 *
 * Cortes que ficam fora do novo intervalo (ou que o atravessam) são SINALIZADOS, nunca removidos ou
 * ajustados; decisões, títulos e ajustes manuais não são tocados.
 */

const { fmtDuration, fmtBytes, plural } = require('../preferences/format');

const SIZE_TOLERANCE = 0.005; // 0,5% do tamanho: abaixo disso é ruído (metadados, reempacotamento)
const CUT_EDGE_TOLERANCE = 0.05; // s: o fim do corte pode passar um pouco da duração por arredondamento

const durationTolerance = (before) => Math.max(0.5, 0.001 * before);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Duração conhecida de uma fonte: a medida pelo ffprobe (`duration`) e, se faltou, a que a plataforma informou ao
 * consultar o VOD (`origin.duration`, campo extra de `source.origin`, veja docs/recursos/sources.md).
 */
function knownDuration(source) {
  const own = num(source && source.duration);
  return own || num(source && source.origin && source.origin.duration);
}

/**
 * @param {object} project   projeto v2 salvo (usa source, cuts)
 * @param {object} incoming  { size, duration, width, height } do arquivo atual (duration null = não deu para medir)
 * @param {object} [extra]   { chat: { recorded, actual, afterOldEnd } } — chat salvo com mais mensagens que o registrado
 */
function compareSource(project, incoming, extra = {}) {
  const src = (project && project.source) || {};
  const before = { duration: knownDuration(src), size: num(src.size), width: num(src.width), height: num(src.height) };
  const after = {
    duration: knownDuration(incoming), size: num(incoming && incoming.size),
    width: num(incoming && incoming.width), height: num(incoming && incoming.height)
  };

  const durationKnown = before.duration > 0 && after.duration > 0;
  const durationDelta = durationKnown ? after.duration - before.duration : 0;
  const durationChanged = durationKnown && Math.abs(durationDelta) >= durationTolerance(before.duration);
  const sizeKnown = before.size > 0 && after.size > 0;
  const sizeDelta = sizeKnown ? after.size - before.size : 0;
  const sizeChanged = sizeKnown && Math.abs(sizeDelta) / before.size >= SIZE_TOLERANCE;
  const resolutionKnown = before.width > 0 && after.width > 0 && before.height > 0 && after.height > 0;
  const resolutionChanged = resolutionKnown && (before.width !== after.width || before.height !== after.height);
  const changed = durationChanged || sizeChanged;

  const cuts = Array.isArray(project && project.cuts) ? project.cuts : [];
  const outside = [];
  if (after.duration > 0) {
    for (const cut of cuts) {
      if (!(cut.end > after.duration + CUT_EDGE_TOLERANCE)) continue;
      outside.push({ id: cut.id, title: cut.title, start: cut.start, end: cut.end, kind: cut.start >= after.duration ? 'fora' : 'parcial' });
    }
  }

  const chatInfo = extra.chat && extra.chat.actual > extra.chat.recorded
    ? { recorded: extra.chat.recorded, actual: extra.chat.actual, added: extra.chat.actual - extra.chat.recorded, afterOldEnd: extra.chat.afterOldEnd || 0 }
    : null;

  const result = {
    changed,
    direction: durationChanged ? (durationDelta > 0 ? 'longer' : 'shorter') : 'same',
    duration: { before: before.duration, after: after.duration, delta: durationDelta, changed: durationChanged },
    size: { before: before.size, after: after.size, delta: sizeDelta, changed: sizeChanged },
    resolution: { before: { width: before.width, height: before.height }, after: { width: after.width, height: after.height }, changed: resolutionChanged },
    cuts: { total: cuts.length, outside },
    chat: chatInfo
  };
  result.lines = describeLines(result);
  return result;
}

function describeLines(r) {
  const lines = [];
  if (r.direction === 'longer') {
    lines.push(`O vídeo ficou mais longo: ${fmtDuration(r.duration.before)} → ${fmtDuration(r.duration.after)} (+${fmtDuration(r.duration.delta)}).`);
  } else if (r.direction === 'shorter') {
    lines.push(`O vídeo ficou mais curto: ${fmtDuration(r.duration.before)} → ${fmtDuration(r.duration.after)} (−${fmtDuration(-r.duration.delta)}).`);
  } else if (r.size.changed) {
    lines.push(`A duração é a mesma (${fmtDuration(r.duration.after || r.duration.before)}), mas o arquivo mudou: foi regravado ou recodificado.`);
  }
  if (r.size.changed) lines.push(`Tamanho: ${fmtBytes(r.size.before)} → ${fmtBytes(r.size.after)}.`);
  if (r.resolution.changed) {
    const { before, after } = r.resolution;
    lines.push(`Resolução: ${before.width}×${before.height} → ${after.width}×${after.height}.`);
  }
  const n = r.cuts.outside.length;
  if (n > 0) {
    const names = r.cuts.outside.slice(0, 3).map((c) => `“${c.title}”`).join(', ');
    lines.push(`${n} ${plural(n, 'corte fica', 'cortes ficam')} fora do novo intervalo (${names}${n > 3 ? ', …' : ''}). ${plural(n, 'Ele será mantido', 'Eles serão mantidos')} e sinalizado${n > 1 ? 's' : ''}; nada é apagado.`);
  } else if (r.cuts.total > 0) {
    lines.push(`${plural(r.cuts.total, 'O corte continua dentro do vídeo', `Os ${r.cuts.total} cortes continuam dentro do vídeo`)}.`);
  }
  if (r.chat) {
    lines.push(`O chat salvo tem ${r.chat.added} ${plural(r.chat.added, 'mensagem', 'mensagens')} a mais do que o projeto registrava${r.chat.afterOldEnd ? ` (${r.chat.afterOldEnd} depois de ${fmtDuration(r.duration.before)})` : ''}.`);
  }
  if (r.direction === 'longer') lines.push(`O trecho novo (de ${fmtDuration(r.duration.before)} em diante) ainda não foi analisado.`);
  lines.push('Suas decisões, títulos e ajustes manuais continuam como estão.');
  return lines;
}

/** Texto do diálogo de confirmação: { title, message }. */
function describeComparison(result, fileName = 'o vídeo') {
  return {
    title: 'A fonte mudou desde a última análise',
    message: [`Este projeto foi analisado com outra versão de “${fileName}”.`, ...result.lines].join('\n')
  };
}

module.exports = { SIZE_TOLERANCE, CUT_EDGE_TOLERANCE, durationTolerance, knownDuration, compareSource, describeComparison };
