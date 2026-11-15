'use strict';

/**
 * Guarda as chaves de API do computador do usuário. A chave:
 *   - fica num arquivo LOCAL em userData (`ai/secrets.json`), nunca no projeto, no repositório, em log ou em texto de erro;
 *   - é cifrada pelo `safeStorage` do Electron quando ele existe (no Windows, DPAPI: só a conta do usuário no computador consegue
 *     ler o arquivo); `mode()` diz 'safeStorage';
 *   - se o sistema não oferece cifragem (ou o Braga Frame roda fora do Electron), cai para um arquivo simples (base64, NÃO é cifra) com
 *     permissão restrita ao usuário (modo 0600; no Windows, a herança de permissões é removida com `icacls`, em melhor esforço);
 *     `mode()` diz 'file' e a interface avisa a limitação;
 *   - nunca é devolvida à interface: `has(id)` diz só se existe.
 *
 * Formato: { version: 1, entries: { <id>: { mode: 'safe' | 'plain', data: <base64> } } }.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeJsonAtomic, readJsonFile } = require('../preferences/atomic');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_KEY_LENGTH = 400;

/** Restringe o arquivo ao usuário atual (melhor esforço; falha não impede de guardar). */
function restrictToUser(file) {
  try {
    if (process.platform === 'win32') {
      const user = process.env.USERNAME;
      if (!user) return;
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    } else {
      fs.chmodSync(file, 0o600);
    }
  } catch { /* sem permissão para mudar permissões: o arquivo continua no perfil do usuário */ }
}

/** O `safeStorage` serve (existe, cifra de verdade e não é o "texto simples" do Linux)? */
function usableSafeStorage(safe) {
  if (!safe || typeof safe !== 'object') return false;
  try {
    if (typeof safe.isEncryptionAvailable !== 'function' || !safe.isEncryptionAvailable()) return false;
    if (typeof safe.getSelectedStorageBackend === 'function' && safe.getSelectedStorageBackend() === 'basic_text') return false;
    return typeof safe.encryptString === 'function' && typeof safe.decryptString === 'function';
  } catch { return false; }
}

class SecretStore {
  /**
   * @param {{ file: string, safeStorage?: object|(()=>object|null)|null, restrict?: (file:string)=>void }} o
   *   safeStorage: o do Electron (ou um dublê nos testes), ou uma função que o devolve; consultado a cada uso (só fica pronto depois do `app.ready`).
   */
  constructor({ file, safeStorage = null, restrict = restrictToUser }) {
    if (!file) throw new Error('SecretStore: informe o arquivo.');
    this.file = file;
    this._safe = safeStorage;
    this.restrict = restrict;
    this._restricted = false;
  }

  get safe() { return typeof this._safe === 'function' ? this._safe() : this._safe; }

  /** 'safeStorage' (cifrado pelo sistema) ou 'file' (arquivo simples com permissão restrita). */
  mode() { return usableSafeStorage(this.safe) ? 'safeStorage' : 'file'; }

  _read() {
    try {
      const { data } = readJsonFile(this.file);
      if (data && data.version === 1 && data.entries && typeof data.entries === 'object') return data;
    } catch { /* ilegível: recomeça */ }
    return { version: 1, entries: {} };
  }

  _write(doc) {
    writeJsonAtomic(this.file, doc, { compact: true });
    if (!this._restricted) { this.restrict(this.file); this._restricted = true; }
  }

  has(id) { return Boolean(this._read().entries[id]); }

  /** Estado sem revelar a chave: 'none' | 'ok' | 'unreadable' (cifrada por um sistema que não está disponível agora). */
  status(id) {
    const entry = this._read().entries[id];
    if (!entry) return 'none';
    return this.get(id) ? 'ok' : 'unreadable';
  }

  /** A chave em texto (só para o processo principal montar o cabeçalho da requisição). null se não há ou não dá para ler. */
  get(id) {
    const entry = this._read().entries[id];
    if (!entry || typeof entry.data !== 'string') return null;
    try {
      const buffer = Buffer.from(entry.data, 'base64');
      if (entry.mode === 'safe') return usableSafeStorage(this.safe) ? this.safe.decryptString(buffer) : null;
      return buffer.toString('utf8');
    } catch { return null; }
  }

  set(id, value) {
    if (!ID_RE.test(String(id))) throw new Error('Identificador de chave inválido.');
    const key = String(value || '').trim();
    if (key.length < 8 || key.length > MAX_KEY_LENGTH || /\s/.test(key)) throw new Error('A chave tem um formato inválido (sem espaços, de 8 a 400 caracteres).');
    const doc = this._read();
    const safe = this.safe;
    if (usableSafeStorage(safe)) doc.entries[id] = { mode: 'safe', data: safe.encryptString(key).toString('base64') };
    else doc.entries[id] = { mode: 'plain', data: Buffer.from(key, 'utf8').toString('base64') };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this._write(doc);
  }

  remove(id) {
    const doc = this._read();
    if (!doc.entries[id]) return false;
    delete doc.entries[id];
    this._write(doc);
    return true;
  }
}

module.exports = { SecretStore, usableSafeStorage, restrictToUser, MAX_KEY_LENGTH };
