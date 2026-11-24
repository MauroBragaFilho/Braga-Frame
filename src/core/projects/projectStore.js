'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const model = require('./model');
const { healStrings } = require('./mojibake');

const { ProjectError, STATUSES } = model;
const ID_RE = /^[0-9a-f]{16}$/;
const FILE_RE = /^[0-9a-f]{16}\.json$/;
// antivírus, indexador ou sincronizador de nuvem segurando o arquivo por um instante (Windows): não é defeito do arquivo
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE']);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function projectIdFor(sourcePath) {
  const normalized = path.resolve(sourcePath);
  const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/** Projeto v2 novo e vazio para um vídeo. `info` vem do ffprobe; `origin` é opcional (veja model.js). */
function newProject(sourcePath, info = {}, origin = null) {
  const resolved = path.resolve(sourcePath);
  return model.blankProject({
    path: resolved, size: info.size, duration: info.duration, width: info.width, height: info.height, origin
  }, { idFor: projectIdFor });
}

/** Resumo de um projeto para listagens (sem os cortes). */
function summarize(project) {
  const counts = { pending: 0, approved: 0, rejected: 0 };
  let exportedCount = 0;
  for (const cut of project.cuts) {
    counts[cut.status] += 1;
    if (Array.isArray(cut.exports) && cut.exports.length) exportedCount += 1;
  }
  return {
    id: project.id,
    source: project.source,
    meta: project.meta,
    cutCount: project.cuts.length,
    counts,
    exportedCount, // cortes com pelo menos uma exportação concluída
    updatedAt: project.updatedAt
  };
}

/** Por que a gravação falhou, em português (o app tenta de novo sozinho; o texto cru fica em `details.raw`). */
function writeFailure(err) {
  const code = err && err.code;
  let why;
  if (code === 'ENOSPC') why = 'o disco está cheio. Libere espaço na unidade do app; o trabalho continua aberto e o app tenta salvar de novo sozinho.';
  else if (TRANSIENT.has(code) || code === 'EROFS') why = 'a pasta de projetos está em uso por outro programa (antivírus, sincronizador de nuvem ou outra janela) ou sem permissão de gravação. Feche o que estiver usando essa pasta; o trabalho continua aberto e o app tenta salvar de novo sozinho.';
  else why = 'o arquivo do projeto não pôde ser gravado. O trabalho continua aberto e o app tenta salvar de novo sozinho.';
  return new ProjectError('PROJECT_WRITE_FAILED', `Não foi possível salvar o projeto: ${why}`, { raw: String((err && err.message) || err), code: code || null });
}

/**
 * Um projeto por arquivo de origem, guardado como JSON em `dir`. Toda leitura e gravação passa por
 * model.normalizeProject (migra v1 -> v2 sem perder campos). Gravação atômica (tmp + fsync + rename) e, antes de
 * substituir o arquivo, a última versão boa vira `<id>.json.bak` (a rede de segurança de uma queda de energia).
 * Só um arquivo realmente corrompido (JSON quebrado ou estrutura irreconhecível) é preservado como `.corrupt`;
 * uma falha de leitura passageira (antivírus, sincronizador) nunca é tratada como corrupção.
 */
class ProjectStore {
  /** @param {string} dir pasta dos projetos @param {object} [opts] { fsImpl (testes: injeta falhas), retries, retryDelayMs } */
  constructor(dir, { fsImpl = fs, retries = 5, retryDelayMs = 25 } = {}) {
    this.dir = dir;
    this.fs = fsImpl;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
    // recuperações já feitas e ainda não contadas a quem abre o vídeo (arquivo -> recovered); veja loadDetailed
    this.pendingRecovery = new Map();
    this.fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(sourcePath) {
    return path.join(this.dir, `${projectIdFor(sourcePath)}.json`);
  }

  /** Executa `fn` repetindo quando o sistema devolve um erro passageiro (TRANSIENT). Outros erros e o esgotar das tentativas sobem. */
  _retry(fn) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return fn();
      } catch (err) {
        if (!TRANSIENT.has(err.code) || attempt >= this.retries) throw err;
        sleepSync(this.retryDelayMs * (attempt + 1));
      }
    }
  }

  /** Texto do arquivo; null se ele não existe. Falha de leitura (que não é "não existe") vira PROJECT_UNREADABLE e NADA é movido. */
  _readText(file) {
    try {
      return this._retry(() => this.fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new ProjectError('PROJECT_UNREADABLE',
        'Não foi possível abrir o projeto deste vídeo: o arquivo está em uso por outro programa (antivírus, sincronizador de nuvem…) ou sem permissão de leitura. Nada foi alterado: feche o que estiver usando a pasta de projetos do app e abra o vídeo de novo.',
        { file, raw: err.message, code: err.code || null });
    }
  }

  /**
   * Lê e normaliza um arquivo de projeto. Lança ProjectError: INVALID_PROJECT (conteúdo irreconhecível = corrompido),
   * PROJECT_VERSION_UNSUPPORTED ou PROJECT_UNREADABLE (o arquivo não pôde ser lido agora; não diz nada sobre o conteúdo).
   * Com `backup`, um arquivo v1 (que será regravado como v2) ganha uma cópia ".v1.bak", uma única vez.
   */
  _read(file, { backup = false } = {}) {
    const text = this._readText(file);
    if (text === null) throw new ProjectError('PROJECT_UNREADABLE', 'O arquivo do projeto não existe mais.', { file });
    let data;
    try {
      data = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
    } catch (err) {
      throw new ProjectError('INVALID_PROJECT', `Não foi possível ler o projeto: ${err.message}`);
    }
    // texto que outra ferramenta (ex.: PowerShell 5.1) leu como Windows-1252 e regravou volta ao normal (mojibake.js); o arquivo só é regravado no próximo salvamento
    data = healStrings(data).data;
    const project = model.normalizeProject(data, { idFor: projectIdFor });
    if (backup && (data.version === 1 || data.version === undefined) && !this.fs.existsSync(`${file}.v1.bak`)) {
      this.fs.copyFileSync(file, `${file}.v1.bak`);
    }
    return project;
  }

  /**
   * Arquivo corrompido: preserva-o como `.corrupt` (nunca apaga) e, se existir a cópia da última versão boa (`.bak`) e ela
   * estiver íntegra, devolve o projeto dela e a restaura como arquivo principal. Devolve { project, recovered }, com
   * recovered = { file (o .corrupt), restoredFromBackup, backupAt } para a interface AVISAR (nada disso é silencioso).
   */
  _recover(file) {
    const corrupt = `${file}.${Date.now()}.corrupt`;
    try {
      this._retry(() => this.fs.renameSync(file, corrupt));
    } catch (err) {
      throw new ProjectError('PROJECT_UNREADABLE',
        'O arquivo do projeto deste vídeo está danificado e não pôde ser separado (está em uso por outro programa ou sem permissão). Nada foi alterado: feche o que estiver usando a pasta de projetos do app e abra o vídeo de novo.',
        { file, raw: err.message, code: err.code || null });
    }
    const bak = `${file}.bak`;
    let project = null;
    let backupAt = null;
    try {
      project = this._read(bak);
      backupAt = this.fs.statSync(bak).mtime.toISOString();
      this._writeAtomic(file, this._readText(bak));
    } catch { project = null; backupAt = null; }
    const recovered = { file: corrupt, restoredFromBackup: Boolean(project), backupAt };
    this.pendingRecovery.set(file, recovered); // quem carregou primeiro (ex.: a conferência antes de abrir) pode não ser quem avisa o usuário
    return { project, recovered };
  }

  /** { project, recovered }: project é o salvo (sempre v2) ou null; recovered só existe se o arquivo estava corrompido. */
  _load(file) {
    if (!this.fs.existsSync(file)) return { project: null, recovered: null };
    try {
      return { project: this._read(file, { backup: true }), recovered: null };
    } catch (err) {
      if (err.code !== 'INVALID_PROJECT') throw err; // formato mais novo ou leitura impossível agora: não mexe no arquivo
      return this._recover(file); // corrompido: preservado, nunca apagado
    }
  }

  /** Retorna o projeto salvo (sempre v2) ou null. Um arquivo corrompido é preservado e a recuperação fica pendente para loadDetailed. */
  load(sourcePath) {
    return this._load(this.fileFor(sourcePath)).project;
  }

  /**
   * Como load(), mas devolve também `recovered` (null, ou { file, restoredFromBackup, backupAt } se o arquivo estava corrompido)
   * e CONSOME o aviso. Se outro código já tinha chamado load() e feito a recuperação antes (a conferência de "fonte atualizada"
   * das Preferências carrega o projeto antes de abrir), o aviso continua pendente até quem abre o vídeo pedir por aqui.
   */
  loadDetailed(sourcePath) {
    const file = this.fileFor(sourcePath);
    const loaded = this._load(file);
    const pending = this.pendingRecovery.get(file) || null;
    this.pendingRecovery.delete(file);
    return { project: loaded.project, recovered: pending };
  }

  /** Igual a load(), por id de projeto (como devolvido por list()). */
  loadById(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return this._load(path.join(this.dir, `${id}.json`)).project;
  }

  /**
   * Lê o projeto SEM mexer em nada (loadById separa um arquivo corrompido e restaura a cópia: para quem só quer olhar, como a conferência do
   * que apagar, isso seria efeito colateral). Devolve { project } ou { error } (id inválido, arquivo ausente, ilegível, corrompido ou de formato novo).
   */
  peekById(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { error: new ProjectError('INVALID_ARGS', 'Identificador de projeto inválido.') };
    try {
      return { project: this._read(path.join(this.dir, `${id}.json`)) };
    } catch (error) {
      return { error };
    }
  }

  /**
   * Apaga do armazenamento TUDO o que é deste projeto: `<id>.json`, a cópia `<id>.json.bak`, a `.v1.bak`, os `.corrupt` preservados e restos `.tmp`
   * de uma gravação interrompida. Só olha esta pasta e só nomes que começam com `<id>.json` (o id é um hash de 16 caracteres hexadecimais: arquivo
   * de outro projeto nunca casa). O arquivo principal é o ÚLTIMO a sair: se algo falhar no meio o projeto continua na lista e dá para tentar de novo.
   * Devolve { files, bytes, failed: [{ name, code, message }] }; um arquivo que não pôde ser apagado não impede os outros.
   * Quem apaga o projeto precisa antes garantir que nada vai gravá-lo de novo (o renderer é o único que grava: veja `project:save`).
   */
  remove(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ProjectError('INVALID_ARGS', 'Identificador de projeto inválido.');
    const out = { files: 0, bytes: 0, failed: [] };
    let names;
    try { names = this.fs.readdirSync(this.dir); } catch { return out; }
    const main = `${id}.json`;
    const own = names.filter((name) => name === main || name.startsWith(`${main}.`)).sort((a, b) => Number(a === main) - Number(b === main));
    for (const name of own) {
      const file = path.join(this.dir, name);
      try {
        let bytes = 0;
        try { bytes = this.fs.statSync(file).size; } catch { bytes = 0; }
        this._retry(() => this.fs.unlinkSync(file));
        out.files += 1;
        out.bytes += bytes;
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        out.failed.push({ name, code: err.code || null, message: err.message });
      }
    }
    this.pendingRecovery.delete(path.join(this.dir, main));
    return out;
  }

  /** tmp + fsync + rename (com repetição em erro passageiro). O arquivo anterior continua válido se algo falhar no meio. */
  _writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const fd = this.fs.openSync(tmp, 'w');
      try {
        this.fs.writeSync(fd, text);
        this.fs.fsyncSync(fd); // sem isto uma queda de energia podia deixar o arquivo pela metade depois do rename
      } finally {
        this.fs.closeSync(fd);
      }
      this._retry(() => this.fs.renameSync(tmp, file));
    } catch (err) {
      try { this.fs.rmSync(tmp, { force: true }); } catch { /* nada a fazer */ }
      throw err;
    }
  }

  /** Guarda a versão atual (se estiver íntegra) como `.bak` antes de ela ser substituída. Falhar aqui nunca impede de salvar. */
  _keepBackup(file) {
    try {
      const old = this.fs.readFileSync(file, 'utf8');
      JSON.parse(old.charCodeAt(0) === 0xFEFF ? old.slice(1) : old); // só uma versão boa merece virar cópia
      this._writeAtomic(`${file}.bak`, old);
    } catch { /* sem arquivo anterior, ilegível ou cópia impossível: segue sem atualizar o .bak */ }
  }

  /** Normaliza e grava de forma atômica. Devolve o projeto gravado. Falha de gravação lança PROJECT_WRITE_FAILED (português). */
  save(project) {
    const normalized = model.normalizeProject(project, { idFor: projectIdFor });
    const id = projectIdFor(normalized.source.path);
    const data = { ...normalized, id, updatedAt: new Date().toISOString() };
    const file = path.join(this.dir, `${id}.json`);
    this._keepBackup(file);
    try {
      this._writeAtomic(file, JSON.stringify(data, null, 2));
    } catch (err) {
      throw writeFailure(err);
    }
    return data;
  }

  /** Resumo de todos os projetos salvos, do mais recente ao mais antigo. Arquivos ilegíveis são ignorados. */
  list() {
    const out = [];
    for (const name of this.fs.readdirSync(this.dir)) {
      if (!FILE_RE.test(name)) continue;
      try {
        // o id da lista é o nome do arquivo: é com ele que loadById encontra o projeto
        out.push(summarize({ ...this._read(path.join(this.dir, name)), id: name.slice(0, -'.json'.length) }));
      } catch { /* ilegível ou de versão mais nova: não aparece na lista, o arquivo fica intacto */ }
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /**
   * Cria (e grava) um projeto para `newSourcePath` com os cortes e decisões de `existing`.
   * O projeto de origem não é alterado (nem em memória nem em disco).
   *  - Copia: cortes (sem as exportações, que pertencem ao vídeo antigo), meta, pasta de saída,
   *    perfis e demais campos/`ext`.
   *  - Não copia: id, fonte, análise, chat e histórico.
   *  - Se já existir projeto com cortes para o vídeo novo, falha (PROJECT_EXISTS): nunca sobrescreve
   *    trabalho do usuário. Um projeto vazio (sem cortes) é substituído.
   * `opts`: { info (ffprobe do vídeo novo), origin }.
   */
  adopt(existing, newSourcePath, opts = {}) {
    const from = model.normalizeProject(existing, { idFor: projectIdFor });
    const target = path.resolve(newSourcePath);
    if (projectIdFor(target) === projectIdFor(from.source.path)) {
      throw new ProjectError('ADOPT_SAME_SOURCE', 'O vídeo novo é o mesmo do projeto de origem.');
    }
    const current = this.load(target);
    if (current && current.cuts.length > 0) {
      throw new ProjectError('PROJECT_EXISTS', 'Já existe um projeto com cortes para este vídeo; nada foi alterado.', { id: current.id });
    }
    const info = opts.info || {};
    const copy = JSON.parse(JSON.stringify(from));
    const skip = ['id', 'source', 'analysis', 'chat', 'history', 'cuts'];
    const rest = Object.fromEntries(Object.entries(copy).filter(([key]) => !skip.includes(key)));
    const adopted = model.normalizeProject({
      ...rest,
      version: model.VERSION,
      id: projectIdFor(target),
      source: { path: target, size: info.size, duration: info.duration, width: info.width, height: info.height, origin: opts.origin || null },
      cuts: copy.cuts.map((cut) => ({ ...cut, exports: [] }))
    }, { idFor: projectIdFor });
    return this.save(adopted);
  }
}

module.exports = { ProjectStore, newProject, projectIdFor, summarize, STATUSES };
