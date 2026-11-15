'use strict';

const { readJsonFile, writeJsonAtomic } = require('./atomic');
const { cleanName } = require('./scope');

const MAX_PROJECTS = 300;
const MAX_CUTS_PER_PROJECT = 500;
// Teto de cortes observados no total (todos os projetos). Cada observação regrava o arquivo e refaz o cálculo no processo
// principal; medido: ~4.000 cortes custam ~30 ms, 20.000 custam ~150 ms e 150.000 (300 × 500) passavam de 1,5 s por lote.
// Os projetos mais antigos saem primeiro; o projeto em edição nunca sai.
const MAX_TOTAL_CUTS = 10000;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const STATUSES = ['pending', 'approved', 'rejected'];

const safeId = (id) => typeof id === 'string' && ID_RE.test(id) && !RESERVED.has(id);

/**
 * Estado de um corte que importa ao aprendizado, ou null se não importa (pendente e sem categoria,
 * ou dados inválidos). Só números e textos curtos: nada do conteúdo do vídeo é guardado.
 */
function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const status = STATUSES.includes(raw.status) ? raw.status : 'pending';
  const category = typeof raw.category === 'string' ? raw.category.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  if (status === 'pending' && !category) return null;
  const duration = Number(raw.duration);
  const relevance = raw.relevance === null || raw.relevance === undefined ? null : Number(raw.relevance);
  return {
    status,
    duration: Number.isFinite(duration) && duration > 0 && duration <= 86400 ? Math.round(duration * 10) / 10 : 0,
    category,
    relevance: relevance !== null && Number.isFinite(relevance) ? Math.min(1, Math.max(0, Math.round(relevance * 1000) / 1000)) : null,
    origin: raw.origin === 'auto' ? 'auto' : 'manual',
    profileId: typeof raw.profileId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(raw.profileId) ? raw.profileId : null
  };
}

/** Observação lida de JSON, com o mapa de cortes sem protótipo (ids como "toString" não colidem). */
function revive(obs) {
  return { ...obs, cuts: Object.assign(Object.create(null), obs.cuts) };
}

/**
 * Observações em `userData/learned.json`: por projeto, o ESTADO ATUAL de cada corte decidido
 * (aprovado/rejeitado ou categorizado). Guardar o estado (e não o histórico de eventos) evita contar
 * duas vezes quem aprova, redefine e aprova de novo, e acompanha ajustes de tempo e remoções.
 */
class LearnedStore {
  constructor(file, { now = () => new Date().toISOString() } = {}) {
    this.file = file;
    this.now = now;
    this.recovered = null;
    this.data = this._load();
  }

  _load() {
    const { data, status, backup } = readJsonFile(this.file);
    if (status === 'corrupt') this.recovered = { backup };
    const observations = Object.create(null);
    const raw = data && data.observations && typeof data.observations === 'object' ? data.observations : {};
    for (const [projectId, obs] of Object.entries(raw)) {
      if (!safeId(projectId) || !obs || typeof obs !== 'object') continue;
      const cuts = Object.create(null);
      for (const [cutId, state] of Object.entries(obs.cuts && typeof obs.cuts === 'object' ? obs.cuts : {})) {
        const clean = safeId(cutId) ? sanitizeState(state) : null;
        if (clean) cuts[cutId] = clean;
      }
      if (!Object.keys(cuts).length) continue;
      observations[projectId] = { game: cleanName(obs.game), channel: cleanName(obs.channel), updatedAt: typeof obs.updatedAt === 'string' ? obs.updatedAt : '', cuts };
    }
    return { version: 1, observations };
  }

  _save() {
    writeJsonAtomic(this.file, { version: 1, observations: this.data.observations }, { compact: true });
  }

  /** Observações como objeto simples (para o cálculo). */
  all() {
    return this.data.observations;
  }

  /** Quantidade de cortes observados (todos os projetos). */
  count() {
    let n = 0;
    for (const obs of Object.values(this.data.observations)) n += Object.keys(obs.cuts).length;
    return n;
  }

  /**
   * Aplica o estado atual de alguns cortes de um projeto: `cuts` = [{ id, state }] (state null remove).
   * Com `onlyKnown`, só atualiza/retira cortes que JÁ estavam observados: é como desfazer, refazer e restaurar
   * entram (uma decisão desfeita deixa de contar, mas desfazer/refazer/restaurar nunca viram evidência nova).
   * Devolve true se algo mudou (e grava).
   */
  apply(projectId, { game = '', channel = '' } = {}, cuts = [], { onlyKnown = false } = {}) {
    if (!safeId(projectId)) return false;
    let obs = this.data.observations[projectId];
    if (onlyKnown && !obs) return false;
    const before = obs ? JSON.stringify(obs) : '';
    const backup = before;
    if (!obs) obs = { game: '', channel: '', updatedAt: '', cuts: Object.create(null) };
    obs.game = cleanName(game);
    obs.channel = cleanName(channel);
    for (const item of Array.isArray(cuts) ? cuts : []) {
      if (!item || !safeId(item.id)) continue;
      if (onlyKnown && !Object.prototype.hasOwnProperty.call(obs.cuts, item.id)) continue;
      const clean = sanitizeState(item.state);
      if (clean) {
        if (!Object.prototype.hasOwnProperty.call(obs.cuts, item.id) && Object.keys(obs.cuts).length >= MAX_CUTS_PER_PROJECT) continue;
        obs.cuts[item.id] = clean;
      } else {
        delete obs.cuts[item.id];
      }
    }
    let pruned = {};
    if (!Object.keys(obs.cuts).length) {
      if (!this.data.observations[projectId]) return false;
      delete this.data.observations[projectId];
    } else {
      this.data.observations[projectId] = obs;
      if (JSON.stringify(obs) === before) return false;
      obs.updatedAt = this.now();
      pruned = this._prune(projectId);
    }
    try {
      this._save();
    } catch (err) {
      // memória e disco não podem divergir: volta ao que estava antes desta chamada (inclusive o que o limite descartou)
      Object.assign(this.data.observations, pruned);
      if (backup) this.data.observations[projectId] = revive(JSON.parse(backup));
      else delete this.data.observations[projectId];
      throw err;
    }
    return true;
  }

  /**
   * Mantém os limites (projetos e cortes no total) descartando os projetos mais antigos; `keepId` (o que acabou de mudar)
   * fica. Devolve o que saiu ({ id: observação }) para desfazer se a gravação falhar.
   */
  _prune(keepId) {
    const removed = {};
    const ids = Object.keys(this.data.observations);
    let total = this.count();
    if (ids.length <= MAX_PROJECTS && total <= MAX_TOTAL_CUTS) return removed;
    const oldestFirst = ids.filter((id) => id !== keepId)
      .sort((a, b) => String(this.data.observations[a].updatedAt).localeCompare(String(this.data.observations[b].updatedAt)));
    let remaining = ids.length;
    for (const id of oldestFirst) {
      if (remaining <= MAX_PROJECTS && total <= MAX_TOTAL_CUTS) break;
      total -= Object.keys(this.data.observations[id].cuts).length;
      remaining -= 1;
      removed[id] = this.data.observations[id];
      delete this.data.observations[id];
    }
    return removed;
  }

  /** Esquece tudo o que foi observado. */
  clear() {
    const had = this.count();
    this.data.observations = Object.create(null);
    this._save();
    return had;
  }
}

module.exports = { LearnedStore, sanitizeState, safeId, MAX_PROJECTS, MAX_CUTS_PER_PROJECT, MAX_TOTAL_CUTS };
