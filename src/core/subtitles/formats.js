'use strict';

/**
 * Formatos de arquivo de legenda (dono: subtitles): gerar e ler SRT e ASS.
 *
 * Todos os tempos das falas são relativos ao início do corte (o arquivo acompanha o vídeo exportado).
 * O ASS leva o estilo da legenda e fica no tamanho do quadro de saída (PlayResX/PlayResY = largura x altura
 * do vídeo exportado), então 1 unidade do ASS = 1 pixel do vídeo e o tamanho da fonte acompanha a resolução.
 */

const shared = require('./shared');

const { wrapText, normalizeStyle, scaleFor, marginFor, cleanCues } = shared;

// ---------- tempos ----------

/** Arredonda como round() do Python 3 (metade vai para o par) — o mesmo critério do BDS para os milissegundos. */
function roundHalfEven(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const pad = (n, w) => String(n).padStart(w, '0');

/** 83.4 -> "00:01:23,400" */
function formatSrtTime(seconds) {
  const ms = roundHalfEven(Math.max(Number(seconds) || 0, 0) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

/** 83.4 -> "0:01:23.40" (centésimos, como o ASS exige). */
function formatAssTime(seconds) {
  const cs = roundHalfEven(Math.max(Number(seconds) || 0, 0) * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs % 100, 2)}`;
}

// ---------- falas visíveis ----------

/** Falas prontas para gravar: sem as vazias, em ordem, cada uma com fim > início. */
function writableCues(cues) {
  return cleanCues(cues)
    .filter((c) => c.text.trim() !== '')
    .map((c) => ({ ...c, end: c.end > c.start ? c.end : c.start + 0.1 }));
}

// ---------- SRT ----------

/**
 * Texto de uma fala no SRT, já quebrado em linhas. No SRT uma linha em branco encerra o bloco (o que viesse depois ficaria
 * sem tempo e os players o ignorariam), então as linhas vazias do texto saem; o ASS, que tem \N, as mantém.
 */
function srtText(text, maxChars) {
  return wrapText(text, maxChars).split('\n').filter((line) => line.trim() !== '').join('\n');
}

/** Texto de um arquivo .srt. `maxChars` quebra as linhas (padrão: o do estilo padrão). */
function cuesToSrt(cues, { maxChars = shared.DEFAULT_STYLE.maxCharsPerLine } = {}) {
  return writableCues(cues)
    .map((cue, i) => `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end)}\n${srtText(cue.text, maxChars)}\n`)
    .join('\n');
}

/** "00:01:23,400" (ou "00:01:23.400", ou "1:23,4") -> segundos; NaN se inválido. */
function parseSrtTime(text) {
  const m = /^\s*(?:(\d+):)?(\d+):(\d{1,2})(?:[,.](\d{1,3}))?\s*$/.exec(String(text));
  if (!m) return NaN;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const stripBom = (text) => String(text).replace(/^\uFEFF/, '');

/**
 * Lê um .srt. Marcas HTML simples (<i>, <b>, <font>) saem do texto. Blocos inválidos são ignorados.
 * A marca é `<nome ...>` sem outro "<" no meio (`[^<>]*`): com `[^>]*` um texto cheio de "<a" e nenhum ">" (legenda hostil)
 * faria o regex reler o resto do texto a cada "<", em tempo quadrático (minutos com 5 MB).
 */
function parseSrt(input) {
  const blocks = stripBom(input).replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, all) => !(i === 0 && l.trim() === '' && all.length > 1));
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) continue;
    const [a, rest] = lines[at].split('-->');
    const start = parseSrtTime(a);
    const end = parseSrtTime(String(rest || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const text = lines.slice(at + 1).join('\n').replace(/<\/?[a-zA-Z][^<>]*>/g, '').replace(/\{\\an?\d\}/g, '').trim();
    cues.push({ start, end, text });
  }
  return cleanCues(cues);
}

// ---------- ASS ----------

/** "#RRGGBB" + opacidade 0..1 -> "&HAABBGGRR" (no ASS o alfa é invertido: 00 = opaco). */
function assColor(hex, opacity = 1) {
  const h = String(hex).replace('#', '').padEnd(6, '0');
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255);
  return `&H${alpha.toString(16).padStart(2, '0')}${b}${g}${r}`.toUpperCase();
}

/**
 * Texto de uma fala no ASS: quebras de linha viram "\N" e os caracteres que o ASS interpreta (barra invertida e
 * chaves) ganham escape ("\\", "\{", "\}", aceitos pelo libass), então nunca viram comandos.
 */
function assText(text, maxChars) {
  return wrapText(text, maxChars)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N');
}

/** Valores numéricos do estilo, já na escala do quadro de saída (px). */
function assMetrics(styleInput, width, height) {
  const style = normalizeStyle(styleInput);
  const scale = scaleFor(width, height);
  return {
    style,
    scale,
    fontSize: Math.max(8, Math.round(style.fontSize * scale)),
    outline: Math.round(style.outlineWidth * scale * 10) / 10,
    marginV: marginFor(style.position, width, height),
    marginH: Math.round(width * 0.06),
    alignment: { bottom: 2, center: 5, top: 8 }[style.position]
  };
}

/** Linha "Style:" do ASS para o estilo e a resolução. */
function assStyleLine(styleInput, width, height) {
  const m = assMetrics(styleInput, width, height);
  const s = m.style;
  const box = s.background === 'box';
  const shadow = s.background === 'shadow';
  // BorderStyle 3 = caixa opaca atrás do texto (a cor da caixa é a "OutlineColour" e a "Outline" vira o respiro).
  const outlineColour = box ? assColor(s.backgroundColor, s.backgroundOpacity) : assColor(s.outlineColor, 1);
  const backColour = shadow ? assColor(s.backgroundColor, s.backgroundOpacity) : assColor('#000000', 0);
  const outline = box ? Math.max(4, Math.round(m.fontSize * 0.16)) : m.outline;
  const shadowDepth = shadow ? Math.max(1, Math.round(m.fontSize * 0.05)) : 0;
  return [
    'Style: Default', s.fontFamily, m.fontSize, assColor(s.color, 1), assColor(s.color, 1), outlineColour, backColour,
    s.bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, box ? 3 : 1, outline, shadowDepth, m.alignment, m.marginH, m.marginH, m.marginV, 1
  ].join(',');
}

/**
 * Texto completo de um arquivo .ass.
 * @param {object[]} cues  falas (tempos relativos ao corte)
 * @param {object} style  estilo (normalizado aqui)
 * @param {{ width:number, height:number, title?:string }} frame  quadro de saída
 */
function cuesToAss(cues, style, { width = 1080, height = 1920, title = 'Braga Frame' } = {}) {
  const w = Math.max(16, Math.round(Number(width) || 1080));
  const h = Math.max(16, Math.round(Number(height) || 1920));
  const maxChars = normalizeStyle(style).maxCharsPerLine;
  const events = writableCues(cues).map((c) => `Dialogue: 0,${formatAssTime(c.start)},${formatAssTime(c.end)},Default,,0,0,0,,${assText(c.text, maxChars)}`);
  return [
    '[Script Info]',
    `Title: ${String(title).replace(/[\r\n]/g, ' ')}`,
    'ScriptType: v4.00+',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: None',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    assStyleLine(style, w, h),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\r\n');
}

/** "0:01:23.45" -> segundos; NaN se inválido. */
function parseAssTime(text) {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.](\d{1,3}))?\s*$/.exec(String(text));
  if (!m) return NaN;
  const frac = m[4] ? Number(`0.${m[4]}`) : 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/**
 * Texto de um Dialogue do ASS -> texto simples: comandos {..} saem; "\N" e "\n" viram quebra; "\h" vira espaço;
 * "\\", "\{" e "\}" viram o próprio caractere.
 */
function plainAssText(raw) {
  const text = String(raw);
  let out = '';
  let noMoreClose = false; // sem "}" daqui para a frente: não procurar de novo a cada "{" (seria quadrático num texto hostil)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '\\' && (next === '{' || next === '}' || next === '\\')) {
      out += next;
      i++;
    } else if (ch === '\\' && (next === 'N' || next === 'n')) {
      out += '\n';
      i++;
    } else if (ch === '\\' && next === 'h') {
      out += ' ';
      i++;
    } else if (ch === '{') {
      const close = noMoreClose ? -1 : text.indexOf('}', i);
      if (close === -1) { noMoreClose = true; out += ch; } else i = close;
    } else {
      out += ch;
    }
  }
  return shared.trimLineEnds(out).trim();
}

/** Lê um .ass (usa a linha "Format:" dos eventos; comentários e estilos ficam de fora). */
function parseAss(input) {
  const lines = stripBom(input).replace(/\r\n?/g, '\n').split('\n');
  let inEvents = false;
  let columns = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  let at = { start: 1, end: 2, text: 9 }; // posição de cada coluna: calculada uma vez por "Format:", não a cada fala
  const cues = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) { inEvents = /^\[events\]$/i.test(trimmed); continue; }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      columns = trimmed.slice(trimmed.indexOf(':') + 1).split(',').map((c) => c.trim().toLowerCase());
      at = { start: columns.indexOf('start'), end: columns.indexOf('end'), text: columns.indexOf('text') };
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue;
    const body = trimmed.slice(trimmed.indexOf(':') + 1).replace(/^ /, '');
    const parts = body.split(',');
    const last = columns.length - 1;
    const fields = parts.length > columns.length ? [...parts.slice(0, last), parts.slice(last).join(',')] : parts;
    const start = parseAssTime(fields[at.start]);
    const end = parseAssTime(fields[at.end]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end, text: plainAssText(fields[at.text] || '') });
  }
  return cleanCues(cues);
}

/** Mais falas que isto não é uma legenda de verdade (um filme longo tem cerca de 2.000): recusa em vez de travar a tela. */
const MAX_IMPORT_CUES = 20000;

/** Lê o conteúdo de um arquivo de legenda pela extensão ('srt' | 'ass' | 'ssa'). Lança Error com mensagem em português. */
function parseSubtitleFile(text, ext) {
  const kind = String(ext || '').replace(/^\./, '').toLowerCase();
  let cues;
  if (kind === 'srt') cues = parseSrt(text);
  else if (kind === 'ass' || kind === 'ssa') cues = parseAss(text);
  else {
    const err = new Error('Formato de legenda não suportado. Use um arquivo .srt ou .ass.');
    err.code = 'BAD_FORMAT';
    throw err;
  }
  if (!cues.length) {
    const err = new Error('Não encontrei nenhuma fala nesse arquivo. Confira se ele é uma legenda .srt ou .ass válida e se foi salvo em UTF-8, UTF-16 ou Windows-1252 (outras codificações saem como texto ilegível).');
    err.code = 'EMPTY';
    throw err;
  }
  if (cues.length > MAX_IMPORT_CUES) {
    const err = new Error(`Esse arquivo tem falas demais para ser uma legenda (${cues.length.toLocaleString('pt-BR')}; o limite é ${MAX_IMPORT_CUES.toLocaleString('pt-BR')}). Confira se é o arquivo certo.`);
    err.code = 'TOO_BIG';
    throw err;
  }
  return cues;
}

module.exports = {
  formatSrtTime, formatAssTime, parseSrtTime, parseAssTime,
  cuesToSrt, srtText, parseSrt, cuesToAss, parseAss, parseSubtitleFile, MAX_IMPORT_CUES,
  assColor, assText, assStyleLine, assMetrics, plainAssText, writableCues
};
