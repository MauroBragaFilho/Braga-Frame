'use strict';

/**
 * Escopos das preferências (dono: prefs): geral, por JOGO e por CANAL/CRIADOR.
 * Nomes são comparados sem acento, sem diferença de maiúsculas e com espaços normalizados.
 */

const SCOPE_TYPES = Object.freeze(['general', 'game', 'channel']);
const MAX_NAME = 120;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** "  Valórant  Ranked " -> "valorant ranked". */
function normName(name) {
  return String(name === undefined || name === null ? '' : name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Chave de armazenamento (nunca um nome especial do JavaScript). */
function scopeKey(name) {
  const norm = normName(name).slice(0, MAX_NAME);
  return RESERVED.has(norm) ? `~${norm}` : norm;
}

const cleanName = (name) => String(name === undefined || name === null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

/**
 * Escopo { type, key, name } a partir de { type, name }. Geral não tem nome. Devolve null se for
 * inválido (tipo desconhecido ou jogo/canal sem nome).
 */
function makeScope(input) {
  const type = input && input.type;
  if (!SCOPE_TYPES.includes(type)) return null;
  if (type === 'general') return { type, key: '', name: '' };
  const name = cleanName(input.name);
  const key = scopeKey(name);
  if (!key) return null;
  return { type, key, name };
}

/** Rótulo curto para mensagens: "geral", "jogo Valorant", "canal Fulano". */
function scopeLabel(scope) {
  if (!scope || scope.type === 'general') return 'geral';
  return `${scope.type === 'game' ? 'jogo' : 'canal'} ${scope.name}`;
}

/**
 * Jogo e canal que valem para um projeto: o que o usuário escreveu em `meta`, e na falta disso o que a
 * origem do vídeo informa (VOD do YouTube/Twitch). Nunca grava nada.
 */
function projectScopeNames(project) {
  const meta = (project && project.meta) || {};
  const origin = (project && project.source && project.source.origin) || {};
  return {
    game: cleanName(meta.game || origin.game || ''),
    channel: cleanName(meta.channel || origin.channel || '')
  };
}

module.exports = { SCOPE_TYPES, MAX_NAME, normName, scopeKey, cleanName, makeScope, scopeLabel, projectScopeNames };
