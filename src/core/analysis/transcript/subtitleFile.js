'use strict';

/**
 * Leitura de legendas .srt e .vtt para virar transcrição. Aceita UTF-8 (com ou sem BOM), UTF-16 (BOM) e Windows-1252. Valida o
 * tamanho (uma live de 3 h tem cerca de 150 KB; o limite é 8 MB) e devolve falas normalizadas (veja format.js).
 */

const { normalizeCues } = require('./format');

const MAX_BYTES = 8 * 1024 * 1024;
const BOM_RE = new RegExp(`^${String.fromCharCode(0xfeff)}`);

class SubtitleFileError extends Error {
  constructor(code, message) { super(message); this.name = 'SubtitleFileError'; this.code = code; }
}

/** Texto do arquivo. O BOM manda; sem BOM, UTF-8 e, se não for válido, Windows-1252. */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return new TextDecoder('windows-1252').decode(buffer); }
}

/** "00:01:23,400", "00:01:23.400", "01:23.400" ou "1:23" -> segundos; NaN se inválido. */
function parseTime(text) {
  const m = /^\s*(?:(\d+):)?(\d{1,3}):(\d{1,2})(?:[,.](\d{1,3}))?\s*$/.exec(String(text));
  if (!m) return NaN;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** Blocos "tempo --> tempo" seguidos do texto (serve a SRT e a WebVTT). NOTE/STYLE/REGION e cabeçalhos são ignorados. */
function parseBlocks(text, kind) {
  const blocks = String(text).replace(BOM_RE, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  const cues = [];
  let skipped = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (kind === 'vtt' && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0].trim())) continue;
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) { if (block.trim()) skipped += 1; continue; }
    const [a, rest] = lines[at].split('-->');
    const start = parseTime(a);
    const end = parseTime(String(rest || '').trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { skipped += 1; continue; }
    cues.push({ start, end, text: lines.slice(at + 1).join(' ') });
  }
  return { cues, skipped };
}

/**
 * @param {Buffer} buffer conteúdo do arquivo
 * @param {string} ext   '.srt' ou '.vtt'
 * @param {{ duration?: number }} [o]  duração do vídeo (descarta falas além do fim e avisa a cobertura)
 * @returns {{ cues, dropped, skipped, warnings: string[] }}
 */
function parseSubtitleBuffer(buffer, ext, { duration = 0 } = {}) {
  const kind = String(ext || '').replace(/^\./, '').toLowerCase();
  if (kind !== 'srt' && kind !== 'vtt') throw new SubtitleFileError('BAD_FORMAT', 'Formato não suportado. Escolha uma legenda .srt ou .vtt.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new SubtitleFileError('EMPTY', 'O arquivo está vazio.');
  if (buffer.length > MAX_BYTES) throw new SubtitleFileError('TOO_BIG', 'Esse arquivo é grande demais para ser uma legenda (limite de 8 MB). Confira se é o arquivo certo.');
  const text = decodeText(buffer);
  if (kind === 'vtt' && !/^\s*WEBVTT/.test(text.replace(BOM_RE, ''))) throw new SubtitleFileError('BAD_FORMAT', 'Esse arquivo .vtt não começa com WEBVTT: não parece uma legenda WebVTT válida.');
  const { cues: raw, skipped } = parseBlocks(text, kind);
  const { cues, dropped } = normalizeCues(raw, { duration });
  if (!cues.length) throw new SubtitleFileError('EMPTY', 'Não encontrei nenhuma fala nesse arquivo. Confira se é uma legenda .srt ou .vtt válida e se foi salva em UTF-8, UTF-16 ou Windows-1252.');
  const warnings = [];
  if (skipped) warnings.push(`${skipped} bloco(s) do arquivo não foram entendidos e foram ignorados.`);
  if (dropped.beyond) warnings.push(`${dropped.beyond} fala(s) depois do fim do vídeo foram ignoradas: confira se a legenda é deste vídeo.`);
  if (dropped.repeats) warnings.push(`${dropped.repeats} fala(s) repetidas em laço foram removidas.`);
  const last = cues[cues.length - 1].end;
  if (duration > 0 && last < duration * 0.5) warnings.push('A legenda cobre menos da metade do vídeo: confira se é deste vídeo.');
  return { cues, dropped, skipped, warnings };
}

module.exports = { parseSubtitleBuffer, parseTime, decodeText, SubtitleFileError, MAX_BYTES };
