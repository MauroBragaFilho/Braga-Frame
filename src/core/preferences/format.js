'use strict';

/** Formatação de textos em português usada nas mensagens do matcher e do comparador de fontes. */

/** 4321 -> "1:12:01"; 125.4 -> "2:05". Sem duração -> "—". */
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Tamanho em bytes -> "3,1 GB". */
function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  const text = unit === 0 ? String(Math.round(value)) : (Math.round(value * 10) / 10).toFixed(1);
  return `${text.replace('.', ',')} ${units[unit]}`;
}

const plural = (n, one, many) => (n === 1 ? one : many);

module.exports = { fmtDuration, fmtBytes, plural };
