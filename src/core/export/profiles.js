'use strict';

/**
 * Perfis de exportação (contrato 3.1 de docs/arquitetura.md).
 *
 *   Profile = { id, name, kind:'vertical'|'horizontal'|'custom', width, height, resolutionLabel,
 *               codec:'h264'|'h265', bitrateKbps, encoder:'auto'|'software'|'nvenc', fps:'source'|número,
 *               container:'mp4', framing? }
 *
 * - Embutidos: 9:16 (padrão obrigatório do produto) e 16:9; nunca são editados nem excluídos.
 * - Do usuário: salvos em `userData/profiles.json` (gravação atômica), valem para todos os projetos.
 * - `framing` (opcional) é o enquadramento inicial do perfil (ver framing.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { normalizeFraming } = require('./framing');

const LIMITS = Object.freeze({ sizeMin: 2, sizeMax: 7680, bitrateMin: 500, bitrateMax: 150000, fpsMin: 1, fpsMax: 240, nameMax: 60 });
const CODECS = Object.freeze(['h264', 'h265']);
const ENCODERS = Object.freeze(['auto', 'software', 'nvenc']);
const KINDS = Object.freeze(['vertical', 'horizontal', 'custom']);
const DEFAULT_PROFILE_ID = 'vertical-1080-h264';
/** Versão do formato de profiles.json que este app escreve (um arquivo de versão MAIOR é regravado com a mesma versão e com uma cópia de segurança). */
const FILE_VERSION = 1;
const DEFAULT_BITRATE_KBPS = 10000;

class ProfileError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const STANDARD_LABELS = new Map([
  ['1080x1920', '1080p'], ['1440x2560', '1440p (2K)'], ['2160x3840', '2160p (4K)'],
  ['1920x1080', '1080p'], ['2560x1440', '1440p (2K)'], ['3840x2160', '2160p (4K)']
]);

/** Rótulo curto da resolução: "1080p", "1440p (2K)", "2160p (4K)" ou "largura×altura". */
function resolutionLabel(width, height) {
  return STANDARD_LABELS.get(`${width}x${height}`) || `${width}×${height}`;
}

/** 'vertical' (altura > largura), 'horizontal' (largura > altura) ou 'quadrado'. */
function orientationOf(profile) {
  if (profile.height > profile.width) return 'vertical';
  if (profile.width > profile.height) return 'horizontal';
  return 'quadrado';
}

// ---------- perfis embutidos ----------

const CODEC_LABEL = { h264: 'H.264', h265: 'H.265' };
// [chave da resolução, [largura, altura] vertical, bitrate vertical, bitrate horizontal]
const BUILTIN_RESOLUTIONS = [
  ['1080', [1080, 1920], 10000, 10000],
  ['1440', [1440, 2560], 10000, 16000],
  ['2160', [2160, 3840], 10000, 35000]
];

function buildBuiltins() {
  const list = [];
  for (const kind of ['vertical', 'horizontal']) {
    for (const [key, [vw, vh], vBitrate, hBitrate] of BUILTIN_RESOLUTIONS) {
      for (const codec of CODECS) {
        const width = kind === 'vertical' ? vw : vh;
        const height = kind === 'vertical' ? vh : vw;
        list.push({
          id: `${kind}-${key}-${codec}`,
          name: `${kind === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'} · ${resolutionLabel(width, height)} · ${CODEC_LABEL[codec]}`,
          kind, width, height, resolutionLabel: resolutionLabel(width, height), codec,
          bitrateKbps: kind === 'vertical' ? vBitrate : hBitrate,
          encoder: 'auto', fps: 'source', container: 'mp4', builtin: true
        });
      }
    }
  }
  return list;
}

const BUILTIN_TEMPLATES = buildBuiltins();
const BUILTIN_IDS = new Set(BUILTIN_TEMPLATES.map((p) => p.id));

/** Cópia nova dos perfis embutidos (quem recebe pode alterar a cópia sem afetar os originais). */
function listBuiltinProfiles() {
  return BUILTIN_TEMPLATES.map((p) => ({ ...p }));
}

const isBuiltinId = (id) => BUILTIN_IDS.has(id);

// ---------- validação ----------

/**
 * Valida e completa um perfil. Devolve `{ profile, errors }`: `errors` são textos em português que
 * dizem o que corrigir (um perfil com erros não pode ser usado para exportar).
 */
function validateProfile(input) {
  const errors = [];
  const src = isObj(input) ? input : {};
  if (!isObj(input)) errors.push('Perfil ausente: escolha um perfil de exportação.');

  const width = Number(src.width);
  const height = Number(src.height);
  for (const [label, value] of [['largura', width], ['altura', height]]) {
    if (!Number.isInteger(value) || value < LIMITS.sizeMin || value > LIMITS.sizeMax) {
      errors.push(`A ${label} precisa ser um número inteiro entre ${LIMITS.sizeMin} e ${LIMITS.sizeMax} pixels.`);
    } else if (value % 2 !== 0) {
      errors.push(`A ${label} (${value}) precisa ser par: o vídeo H.264/H.265 em 4:2:0 não aceita medidas ímpares.`);
    }
  }

  const codec = src.codec === undefined ? 'h264' : src.codec;
  if (!CODECS.includes(codec)) errors.push('Codec inválido: use H.264 ou H.265.');

  const bitrate = src.bitrateKbps === undefined ? DEFAULT_BITRATE_KBPS : Number(src.bitrateKbps);
  if (!Number.isFinite(bitrate) || bitrate < LIMITS.bitrateMin || bitrate > LIMITS.bitrateMax) {
    errors.push(`O bitrate precisa ficar entre ${LIMITS.bitrateMin} e ${LIMITS.bitrateMax} kbps.`);
  }

  const encoder = src.encoder === undefined ? 'auto' : src.encoder;
  if (!ENCODERS.includes(encoder)) errors.push('Codificador inválido: use Automático, Software ou NVENC.');

  let fps = src.fps === undefined || src.fps === null ? 'source' : src.fps;
  if (fps !== 'source') {
    fps = Number(fps);
    if (!Number.isFinite(fps) || fps < LIMITS.fpsMin || fps > LIMITS.fpsMax) {
      errors.push(`Quadros por segundo inválidos: use "igual à fonte" ou um valor entre ${LIMITS.fpsMin} e ${LIMITS.fpsMax}.`);
      fps = 'source';
    }
  }

  const container = src.container === undefined ? 'mp4' : src.container;
  if (container !== 'mp4') errors.push('Formato de arquivo inválido: só MP4 é suportado.');

  const name = typeof src.name === 'string' ? src.name.trim() : '';
  const kind = KINDS.includes(src.kind) ? src.kind : 'custom';

  const profile = {
    id: typeof src.id === 'string' ? src.id : '',
    name: name || (Number.isFinite(width) && Number.isFinite(height) ? `${width}×${height}` : 'Perfil'),
    kind,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
    resolutionLabel: '',
    codec: CODECS.includes(codec) ? codec : 'h264',
    bitrateKbps: Number.isFinite(bitrate) ? Math.round(bitrate) : DEFAULT_BITRATE_KBPS,
    encoder: ENCODERS.includes(encoder) ? encoder : 'auto',
    fps,
    container: 'mp4'
  };
  profile.resolutionLabel = resolutionLabel(profile.width, profile.height);
  if (isObj(src.framing)) profile.framing = normalizeFraming(src.framing, { partial: true });
  if (src.builtin === true) profile.builtin = true;
  return { profile, errors };
}

// ---------- perfis do usuário ----------

function slug(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'perfil';
}

function newUserId(name, takenIds) {
  for (let i = 0; i < 50; i++) {
    const id = `user-${slug(name)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (!takenIds.has(id)) return id;
  }
  throw new ProfileError('PROFILE_STORE_FAILED', 'Não foi possível gerar um identificador para o perfil. Tente salvar de novo.');
}

/** Grava `data` em `file` de forma atômica (arquivo temporário + rename). */
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* sem o que limpar */ }
    throw err;
  }
}

/**
 * Perfis do usuário em `file` (userData/profiles.json). Lê o arquivo a cada chamada (sem cache em
 * memória), então uma edição externa ou outro processo nunca fica para trás.
 */
class ProfileStore {
  constructor(file) {
    if (typeof file !== 'string' || !file) throw new Error('ProfileStore: informe o caminho do arquivo de perfis.');
    this.file = file;
  }

  /** Perfis do usuário (já validados). Entradas que este app não entende ficam de fora da lista, mas continuam no arquivo. */
  list() {
    return this._load().list.map((p) => ({ ...p }));
  }

  get(id) {
    return this.list().find((p) => p.id === id) || null;
  }

  /**
   * Salva (cria ou atualiza) um perfil do usuário. Sem `id` cria um novo; com `id` de um perfil do
   * usuário atualiza; com `id` de embutido recusa (PROFILE_BUILTIN). Nome repetido é recusado.
   */
  save(input) {
    const src = isObj(input) ? input : {};
    if (isBuiltinId(src.id)) {
      throw new ProfileError('PROFILE_BUILTIN', 'Os perfis embutidos não podem ser alterados. Salve uma cópia com outro nome.');
    }
    const name = typeof src.name === 'string' ? src.name.trim() : '';
    if (!name) throw new ProfileError('INVALID_PROFILE', 'Dê um nome ao perfil.', { errors: ['Dê um nome ao perfil.'] });
    if (name.length > LIMITS.nameMax) {
      throw new ProfileError('INVALID_PROFILE', `O nome do perfil pode ter no máximo ${LIMITS.nameMax} caracteres.`, { errors: ['Nome muito longo.'] });
    }
    const { profile, errors } = validateProfile({ ...src, name });
    if (errors.length) throw new ProfileError('INVALID_PROFILE', errors.join(' '), { errors });

    const loaded = this._load();
    const { list } = loaded;
    const existing = src.id ? list.find((p) => p.id === src.id) : null;
    if (src.id && !existing && !String(src.id).startsWith('user-')) {
      throw new ProfileError('INVALID_PROFILE', 'Identificador de perfil inválido.', { errors: ['Identificador inválido.'] });
    }
    const clash = list.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== (existing ? existing.id : null));
    if (clash) {
      throw new ProfileError('PROFILE_NAME_EXISTS', `Já existe um perfil seu chamado "${clash.name}". Escolha outro nome ou atualize o existente.`, { id: clash.id });
    }

    const saved = {
      ...profile,
      id: existing ? existing.id : (src.id || newUserId(name, new Set([...list, ...loaded.rejected].map((p) => p.id)))),
      kind: 'custom'
    };
    delete saved.builtin;
    const next = existing ? list.map((p) => (p.id === saved.id ? saved : p)) : [...list, saved];
    this._write(next, loaded);
    return { ...saved };
  }

  /** Exclui um perfil do usuário. Embutido: PROFILE_BUILTIN; inexistente: PROFILE_NOT_FOUND. */
  remove(id) {
    if (isBuiltinId(id)) throw new ProfileError('PROFILE_BUILTIN', 'Os perfis embutidos não podem ser excluídos.');
    const loaded = this._load();
    if (!loaded.list.some((p) => p.id === id)) throw new ProfileError('PROFILE_NOT_FOUND', 'Este perfil não existe mais (talvez já tenha sido excluído).');
    this._write(loaded.list.filter((p) => p.id !== id), loaded);
    return { id };
  }

  /**
   * Lê o arquivo: `list` (perfis válidos), `rejected` (objetos que este app não aceita — codec desconhecido de uma versão nova,
   * id repetido… — guardados para NÃO se perderem quando o arquivo for regravado), `version` e `meta` (outros campos do arquivo).
   */
  _load() {
    const empty = () => ({ list: [], rejected: [], version: FILE_VERSION, meta: {} });
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return empty();
      throw new ProfileError('PROFILE_STORE_FAILED', `Não foi possível ler a lista de perfis (${err.message}). Verifique as permissões da pasta de dados do app.`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // arquivo corrompido: preserva uma cópia e recomeça vazio (nunca apaga o que o usuário tinha)
      try { fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* melhor esforço */ }
      return empty();
    }
    const raw = Array.isArray(data) ? data : (isObj(data) && Array.isArray(data.profiles) ? data.profiles : []);
    const version = isObj(data) && Number.isInteger(data.version) && data.version > 0 ? data.version : FILE_VERSION;
    const meta = {};
    if (isObj(data)) for (const [key, value] of Object.entries(data)) if (key !== 'version' && key !== 'profiles') meta[key] = value;
    const seen = new Set();
    const list = [];
    const rejected = [];
    for (const item of raw) {
      if (!isObj(item)) continue;
      if (typeof item.id !== 'string' || isBuiltinId(item.id) || seen.has(item.id)) { rejected.push(item); continue; }
      const { profile, errors } = validateProfile(item);
      if (errors.length || !item.name) { rejected.push(item); continue; }
      seen.add(item.id);
      list.push({ ...profile, id: item.id, kind: 'custom' });
    }
    return { list, rejected, version, meta };
  }

  _write(profiles, loaded) {
    const { rejected = [], version = FILE_VERSION, meta = {} } = loaded || {};
    try {
      // arquivo de uma versão mais nova: guarda uma cópia (uma vez) antes de regravar
      if (version > FILE_VERSION) {
        try { fs.copyFileSync(this.file, `${this.file}.v${version}.bak`, fs.constants.COPYFILE_EXCL); } catch { /* já existe ou melhor esforço */ }
      }
      writeJsonAtomic(this.file, { version, ...meta, profiles: [...profiles, ...rejected] });
    } catch (err) {
      throw new ProfileError('PROFILE_STORE_FAILED', `Não foi possível gravar os perfis (${err.message}). Verifique o espaço em disco e as permissões da pasta de dados do app.`);
    }
  }
}

/** Embutidos + do usuário (nesta ordem). */
function allProfiles(store) {
  return [...listBuiltinProfiles(), ...(store ? store.list() : [])];
}

function findProfile(id, store) {
  return allProfiles(store).find((p) => p.id === id) || null;
}

module.exports = {
  LIMITS, CODECS, ENCODERS, KINDS, DEFAULT_PROFILE_ID, DEFAULT_BITRATE_KBPS, FILE_VERSION,
  ProfileError, ProfileStore, resolutionLabel, orientationOf,
  listBuiltinProfiles, isBuiltinId, validateProfile, allProfiles, findProfile, writeJsonAtomic
};
