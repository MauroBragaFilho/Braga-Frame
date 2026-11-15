'use strict';

/** Nomes de arquivo de saída: modelo ({fonte} - corte {n} - {titulo}) e limpeza para o Windows. */

const DEFAULT_TEMPLATE = '{fonte} - corte {n} - {titulo}';
const MAX_BASE_LENGTH = 120;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Nome de arquivo seguro (sem extensão): troca caracteres proibidos, tira pontos/espaços do fim,
 * evita nomes reservados do Windows (CON, NUL…), limita o tamanho. Nunca devolve vazio.
 */
function sanitizeFileName(name, fallback = 'corte') {
  let out = Array.from(String(name ?? ''), (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > MAX_BASE_LENGTH) out = out.slice(0, MAX_BASE_LENGTH).trim();
  out = out.replace(/[. ]+$/, '');
  if (!out || /^\.+$/.test(out)) out = fallback;
  if (RESERVED.test(out.split('.')[0])) out = `_${out}`;
  return out;
}

/**
 * Aplica o modelo. Variáveis: {fonte} (nome do vídeo sem extensão), {n} (número do corte, com zeros
 * à esquerda), {titulo}, {perfil}. Variável desconhecida fica como está (o usuário vê o erro de digitação).
 */
function applyNameTemplate(template, vars) {
  const t = typeof template === 'string' && template.trim() ? template : DEFAULT_TEMPLATE;
  const out = t.replace(/\{(fonte|n|titulo|perfil)\}/g, (_m, key) => String(vars[key] ?? ''));
  return sanitizeFileName(out);
}

module.exports = { DEFAULT_TEMPLATE, MAX_BASE_LENGTH, sanitizeFileName, applyNameTemplate };
