'use strict';

/**
 * Modelo de dados do projeto (v2) e do corte — arquitetura 2.1 e 2.2.
 *
 * Este arquivo é "universal": funciona como módulo CommonJS no processo principal e, carregado por
 * <script>, expõe `window.BFModel` no renderer (o renderer usa BF.model.newCut para criar cortes
 * já completos). Por isso não usa nenhum módulo do Node e fica dentro de uma função.
 *
 * Regras:
 *  - `normalizeProject` / `normalizeCut` NUNCA descartam campos desconhecidos: tudo que não for do
 *    contrato é preservado como veio (outros recursos guardam dados em `ext` ou em campos próprios);
 *  - são idempotentes: normalizar de novo algo já normalizado não muda nada;
 *  - sempre usar estas funções ao ler e ao gravar um projeto.
 */
(function () {
  const VERSION = 2;
  const STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
  const CUT_ORIGINS = Object.freeze(['manual', 'auto']);
  const SOURCE_TYPES = Object.freeze(['file', 'obs', 'vod']);
  const DEFAULT_PROFILE_ID = 'vertical-1080-h264';
  const LEGACY_RESOLUTIONS = [1080, 1440, 2160];
  const LEGACY_CODECS = ['h264', 'h265'];

  class ProjectError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'ProjectError';
      this.code = code;
      this.details = details;
    }
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const nowIso = () => new Date().toISOString();

  /** Número finito (aceita string numérica); senão o padrão. */
  function num(v, fallback) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }

  /** Identificador curto e único o bastante para um corte/projeto (não é criptográfico). */
  function uid(prefix = '') {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  }

  /** Campos conhecidos primeiro (ordem estável no JSON) e depois os desconhecidos, intactos. */
  function withExtras(known, raw) {
    const extras = Object.fromEntries(Object.entries(raw).filter(([key]) => !(key in known)));
    return { ...known, ...extras };
  }

  // ---------- corte ----------

  /**
   * Preenche os padrões de um corte. `opts`: { index } (para o título padrão "Corte N"),
   * { now } e { createdAt } (valores de data para cortes vindos sem datas, como os do formato v1).
   */
  function normalizeCut(raw, opts = {}) {
    const src = isObj(raw) ? raw : {};
    const now = opts.now || nowIso();
    const start = Math.max(0, num(src.start, 0));
    const relevance = num(src.relevance, null);
    const audio = isObj(src.audio) ? src.audio : {};
    const createdAt = str(src.createdAt) || opts.createdAt || now;
    const id = typeof src.id === 'string' && src.id ? src.id : (typeof src.id === 'number' ? String(src.id) : uid('c'));

    const known = {
      id,
      title: str(src.title).trim() || `Corte ${(opts.index || 0) + 1}`,
      titleSuggestions: strList(src.titleSuggestions),
      start,
      end: num(src.end, start),
      status: STATUSES.includes(src.status) ? src.status : 'pending',
      category: str(src.category),
      relevance: relevance === null ? null : Math.min(1, Math.max(0, relevance)),
      origin: CUT_ORIGINS.includes(src.origin) ? src.origin : 'manual',
      reasons: strList(src.reasons),
      revision: Math.max(1, Math.floor(num(src.revision, 1))),
      framing: isObj(src.framing) ? src.framing : null,
      audio: withExtras({
        gainDb: num(audio.gainDb, 0),
        mute: audio.mute === true,
        fadeInSec: Math.max(0, num(audio.fadeInSec, 0)),
        fadeOutSec: Math.max(0, num(audio.fadeOutSec, 0)),
        history: Array.isArray(audio.history) ? audio.history : []
      }, audio),
      subtitles: isObj(src.subtitles) ? src.subtitles : null,
      exports: Array.isArray(src.exports) ? src.exports.filter(isObj) : [],
      notes: str(src.notes),
      createdAt,
      updatedAt: str(src.updatedAt) || createdAt,
      reviewedAt: str(src.reviewedAt) || null
    };
    return withExtras(known, src);
  }

  /** Cria um corte novo (pendente, manual) já completo. `fields` sobrescreve os padrões. */
  function newCut(fields = {}, opts = {}) {
    const now = opts.now || nowIso();
    return normalizeCut({ status: 'pending', origin: 'manual', ...fields, id: fields.id || uid('c'), createdAt: fields.createdAt || now, updatedAt: fields.updatedAt || now }, { ...opts, now });
  }

  // ---------- projeto ----------

  function normalizeOrigin(origin) {
    if (!isObj(origin)) return null;
    return { ...origin, type: SOURCE_TYPES.includes(origin.type) ? origin.type : 'file' };
  }

  /** Perfil embutido equivalente ao perfil legado do formato v1 ({ resolution, codec, bitrateKbps }). */
  function deriveProfileId(legacyProfile) {
    if (isObj(legacyProfile) && LEGACY_RESOLUTIONS.includes(Number(legacyProfile.resolution)) && LEGACY_CODECS.includes(legacyProfile.codec)) {
      return `vertical-${Number(legacyProfile.resolution)}-${legacyProfile.codec}`;
    }
    return DEFAULT_PROFILE_ID;
  }

  /**
   * Lê um projeto (v1 ou v2) e devolve sempre o formato v2, sem perder campos desconhecidos.
   * `opts`: { idFor(sourcePath) } para projetos sem id; { now } para datas ausentes.
   * Lança ProjectError: INVALID_PROJECT (estrutura irreconhecível) ou PROJECT_VERSION_UNSUPPORTED
   * (gravado por uma versão mais nova do app — o arquivo não deve ser alterado).
   */
  function normalizeProject(raw, opts = {}) {
    if (!isObj(raw)) throw new ProjectError('INVALID_PROJECT', 'Projeto inválido: o arquivo não contém um objeto.');
    const version = raw.version === undefined ? 1 : raw.version;
    if (!Number.isInteger(version) || version < 1) throw new ProjectError('INVALID_PROJECT', 'Projeto inválido: versão desconhecida.');
    if (version > VERSION) {
      throw new ProjectError('PROJECT_VERSION_UNSUPPORTED', `Este projeto foi salvo por uma versão mais nova do app (formato ${version}). Atualize o app para abri-lo.`, { version });
    }
    if (raw.cuts !== undefined && !Array.isArray(raw.cuts)) throw new ProjectError('INVALID_PROJECT', 'Projeto inválido: a lista de cortes está corrompida.');

    const source = isObj(raw.source) ? raw.source : {};
    const sourcePath = str(source.path);
    if (!sourcePath) throw new ProjectError('INVALID_PROJECT', 'Projeto inválido: falta o caminho do vídeo de origem.');

    const now = opts.now || nowIso();
    const updatedAt = str(raw.updatedAt) || now;
    const meta = isObj(raw.meta) ? raw.meta : {};
    const analysis = isObj(raw.analysis) ? raw.analysis : {};

    const seen = new Set();
    const cuts = (raw.cuts || []).filter(isObj).map((rawCut, index) => {
      let cut = normalizeCut(rawCut, { index, now, createdAt: updatedAt });
      while (seen.has(cut.id)) cut = { ...cut, id: uid('c') };
      seen.add(cut.id);
      return cut;
    });

    const known = {
      version: VERSION,
      id: str(raw.id) || (typeof opts.idFor === 'function' ? opts.idFor(sourcePath) : uid('p')),
      updatedAt,
      source: withExtras({
        path: sourcePath,
        size: num(source.size, 0),
        duration: num(source.duration, 0),
        width: num(source.width, 0),
        height: num(source.height, 0),
        origin: normalizeOrigin(source.origin)
      }, source),
      meta: withExtras({ game: str(meta.game), channel: str(meta.channel) }, meta),
      cuts,
      exportDir: str(raw.exportDir) || null,
      profileId: str(raw.profileId) || deriveProfileId(raw.profile),
      profile: isObj(raw.profile) ? raw.profile : null,
      customProfiles: Array.isArray(raw.customProfiles) ? raw.customProfiles : [],
      chat: isObj(raw.chat) ? raw.chat : null,
      analysis: withExtras({ lastRun: isObj(analysis.lastRun) ? analysis.lastRun : null }, analysis),
      history: Array.isArray(raw.history) ? raw.history : [],
      ext: isObj(raw.ext) ? raw.ext : {}
    };
    return withExtras(known, raw);
  }

  /** Projeto novo e vazio para uma fonte: { path, size, duration, width, height, origin }. */
  function blankProject(source, opts = {}) {
    return normalizeProject({ version: VERSION, source }, opts);
  }

  const api = { VERSION, STATUSES, CUT_ORIGINS, SOURCE_TYPES, DEFAULT_PROFILE_ID, ProjectError, normalizeProject, normalizeCut, newCut, blankProject, deriveProfileId, uid };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFModel = api;
})();
