'use strict';

/**
 * Estado da aba Novo projeto (sources) que sobrevive sem projeto aberto (dono: sources), em `userData/sources.json`
 * (gravação atômica: tmp + rename; arquivo ilegível é preservado como .corrupt e recomeça vazio):
 *
 *   { version:1,
 *     obsFolder: string|null,        pasta de gravações escolhida à mão (vale mais que a detectada no OBS)
 *     downloadDir: string|null,      pasta dos VODs baixados (null = a padrão)
 *     cookiesBrowser: ''|'chrome'…,  navegador de onde o yt-dlp lê os cookies ('' = não usar)
 *     lastQuality: ''|'best'|'h720'…, última qualidade de download escolhida ('' = nenhuma ainda)
 *     downloads: [{ path, origin, chat, meta, at }]   VODs baixados por aqui (para reabrir com origem e chat)
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');
const { BROWSERS } = require('./ytdlp');

const VERSION = 1;
const MAX_DOWNLOADS = 300;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function defaults() {
  return { version: VERSION, obsFolder: null, downloadDir: null, cookiesBrowser: '', lastQuality: '', downloads: [] };
}

function normalize(raw) {
  const out = defaults();
  if (!isObj(raw)) return out;
  if (typeof raw.obsFolder === 'string' && raw.obsFolder) out.obsFolder = raw.obsFolder;
  if (typeof raw.downloadDir === 'string' && raw.downloadDir) out.downloadDir = raw.downloadDir;
  if (BROWSERS.includes(raw.cookiesBrowser)) out.cookiesBrowser = raw.cookiesBrowser;
  if (typeof raw.lastQuality === 'string' && /^(best|h\d{3,4})$/.test(raw.lastQuality)) out.lastQuality = raw.lastQuality;
  if (Array.isArray(raw.downloads)) {
    out.downloads = raw.downloads
      .filter((d) => isObj(d) && typeof d.path === 'string' && d.path)
      .slice(-MAX_DOWNLOADS)
      .map((d) => ({
        path: d.path,
        origin: isObj(d.origin) ? d.origin : null,
        chat: isObj(d.chat) ? d.chat : null,
        meta: isObj(d.meta) ? d.meta : {},
        at: typeof d.at === 'string' ? d.at : ''
      }));
  }
  return out;
}

class SettingsStore {
  constructor(file) {
    this.file = file;
    this.data = this._load();
  }

  _load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return defaults(); }
    try {
      return normalize(JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text));
    } catch {
      try { fs.renameSync(this.file, `${this.file}.${Date.now()}.corrupt`); } catch { /* sem permissão: segue vazio */ }
      return defaults();
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  get() {
    return { obsFolder: this.data.obsFolder, downloadDir: this.data.downloadDir, cookiesBrowser: this.data.cookiesBrowser, lastQuality: this.data.lastQuality };
  }

  set(patch) {
    // valores inválidos já foram recusados por quem chama (SourcesManager.setSettings); normalize() é só a rede de segurança
    this.data = normalize({ ...this.data, ...patch, downloads: this.data.downloads });
    this._save();
    return this.get();
  }

  /** Guarda (ou atualiza) um VOD baixado. */
  recordDownload(entry) {
    const key = norm(entry.path);
    const list = this.data.downloads.filter((d) => norm(d.path) !== key);
    list.push({ path: entry.path, origin: entry.origin || null, chat: entry.chat || null, meta: entry.meta || {}, at: entry.at || new Date().toISOString() });
    this.data.downloads = list.slice(-MAX_DOWNLOADS);
    this._save();
  }

  /** Atualiza só o chat de um VOD já registrado (download de chat posterior). */
  updateChat(filePath, chat) {
    const key = norm(filePath);
    const item = this.data.downloads.find((d) => norm(d.path) === key);
    if (!item) return false;
    item.chat = chat;
    this._save();
    return true;
  }

  findDownload(filePath) {
    const key = norm(filePath);
    return this.data.downloads.find((d) => norm(d.path) === key) || null;
  }

  /** Tira do registro um VOD baixado (o arquivo dele acabou de ser apagado junto com o projeto). Devolve true se havia registro. */
  forgetDownload(filePath) {
    const key = norm(filePath);
    const before = this.data.downloads.length;
    this.data.downloads = this.data.downloads.filter((d) => norm(d.path) !== key);
    if (this.data.downloads.length === before) return false;
    this._save();
    return true;
  }
}

function norm(p) {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = { SettingsStore, normalize, defaults, norm, VERSION, MAX_DOWNLOADS };
