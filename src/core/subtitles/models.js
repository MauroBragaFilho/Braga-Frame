'use strict';

/**
 * Modelos do Whisper (formato ggml) para as legendas automáticas (dono: subtitles).
 *
 * Fonte oficial única: o repositório ggerganov/whisper.cpp no Hugging Face (o mesmo projeto do motor). Como o motor
 * (entries/whisper.js), cada modelo tem a REVISÃO do repositório, o TAMANHO e o SHA-256 fixados aqui no código: o arquivo
 * baixado só é aceito se bater com eles, então uma troca do arquivo no repositório (ou no caminho) não vira instalação
 * silenciosa de um modelo que o código nativo (ggml) passaria a ler. Valores conferidos na API da fonte
 * (`/api/models/ggerganov/whisper.cpp?blobs=true`, campos `sha`, `size` e `lfs.sha256`). Para mudar de versão, troque
 * revisão, tamanho e SHA-256 JUNTOS (e rode tests/subtitles-models.test.js e o teste real, tests/subtitles-whisper.test.js).
 *
 * A instalação usa o ToolInstaller da base com uma entrada montada a partir do catálogo: download para ".part",
 * conferência de tamanho + SHA-256, publicação atômica, progresso e cancelamento, sem nunca deixar um modelo pela metade.
 * A URL do download traz a revisão, então o arquivo é exatamente o descrito.
 *
 * Os modelos ficam em "<pasta>/whisper-<id>/r<revisão>/<arquivo>.bin" (pasta própria, separada das ferramentas).
 * Versões quantizadas (q5): ocupam de 3 a 4 vezes menos que as originais, com perda de qualidade pequena.
 *
 * Módulo embutido (`hostModels`, veja src/host/index.js): quem hospeda (o BDS) é o dono dos modelos. O arquivo dele só vale se tem o
 * TAMANHO e o SHA-256 do catálogo daqui (o tamanho é conferido na hora; o SHA-256, uma vez por arquivo, em `verifyHost`, sem travar o
 * processo principal). A instalação é delegada ao hospedeiro e a remoção é recusada: nunca há uma segunda cópia em outra pasta.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const registry = require('../tools/registry');
const { ToolInstaller } = require('../tools/ToolInstaller');
const { SubtitlesError } = require('./errors');

const REPO = 'ggerganov/whisper.cpp';
const BASE_URL = 'https://huggingface.co';
/** Commit do repositório oficial em que os tamanhos e SHA-256 abaixo foram conferidos (a URL do download o inclui). */
const REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';

/**
 * Catálogo. `dtw` é o nome do preset de alinhamento de palavras do whisper.cpp (`-dtw`), que dá o tempo de cada palavra.
 * `revision`, `sizeBytes` e `sha256` são os valores EXIGIDOS do arquivo baixado (nada é lido da fonte na hora).
 */
const MODELS = Object.freeze([
  { id: 'tiny', label: 'Tiny', file: 'ggml-tiny-q5_1.bin', dtw: 'tiny', revision: REVISION, sizeBytes: 32152673, sha256: '818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7', description: 'Muito rápido, só para rascunho' },
  { id: 'base', label: 'Base', file: 'ggml-base-q5_1.bin', dtw: 'base', revision: REVISION, sizeBytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898', description: 'Rápido, bom para fala nítida' },
  { id: 'small', label: 'Pequeno', file: 'ggml-small-q5_1.bin', dtw: 'small', revision: REVISION, sizeBytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb', description: 'Equilíbrio entre velocidade e precisão (padrão)' },
  { id: 'medium', label: 'Médio', file: 'ggml-medium-q5_0.bin', dtw: 'medium', revision: REVISION, sizeBytes: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f', description: 'Mais preciso, mais lento' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo-q5_0.bin', dtw: 'large.v3.turbo', revision: REVISION, sizeBytes: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2', description: 'Maior precisão; usa mais memória e tempo' }
]);
const DEFAULT_MODEL_ID = 'small';

const getModel = (id) => MODELS.find((m) => m.id === id) || null;
const entryIdFor = (modelId) => `whisper-${modelId}`;

function isLoopback(hostname) {
  return registry.isLoopbackHost(hostname);
}

/** Um item do catálogo só vale com revisão (40 hex), tamanho e SHA-256 (64 hex) fixados. Devolve a lista de problemas. */
function validateModel(m) {
  if (!m || typeof m !== 'object') return ['item inválido'];
  const problems = [];
  if (!/^[a-z0-9][a-z0-9.-]{0,30}$/.test(String(m.id))) problems.push('id');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/.test(String(m.file))) problems.push('arquivo');
  if (!/^[0-9a-f]{40}$/.test(String(m.revision))) problems.push('revisão');
  if (!Number.isSafeInteger(m.sizeBytes) || m.sizeBytes <= 0) problems.push('tamanho');
  if (!/^[0-9a-f]{64}$/.test(String(m.sha256))) problems.push('SHA-256');
  return problems;
}

class ModelManager extends EventEmitter {
  /**
   * @param {{ dir:string, baseUrl?:string, catalog?:object[], allowLoopbackHttp?:boolean, platform?:string, arch?:string,
   *           installerOptions?:object }} opts
   *   allowLoopbackHttp e catalog: SÓ para testes (aceita http em localhost; catálogo com a revisão, o tamanho e o SHA-256
   *   do servidor falso). O app usa sempre o catálogo MODELS.
   *   hostModels: { resolve(id), install(id, { signal, onProgress }), cancel?(id) } do hospedeiro (módulo embutido).
   */
  constructor({ dir, baseUrl = BASE_URL, catalog = MODELS, allowLoopbackHttp = false, platform = process.platform, arch = process.arch, installerOptions = {}, hostModels = null, hostName = null } = {}) {
    super();
    this.hostModels = hostModels || null;
    this.hostName = hostName || null;
    this._hostChecks = new Map(); // "caminho|tamanho|mtime" -> 'ok' | 'bad' | Promise (SHA-256 do arquivo do hospedeiro)
    this._hostBusy = new Set();
    if (!dir) throw new SubtitlesError('INVALID_ARGS', 'ModelManager: informe a pasta dos modelos.');
    this.dir = path.resolve(dir);
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    const parsed = new URL(this.baseUrl);
    if (parsed.protocol !== 'https:' && !(allowLoopbackHttp && parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      throw new SubtitlesError('INSECURE_URL', 'A fonte dos modelos precisa ser um endereço seguro (https).');
    }
    for (const m of catalog) {
      const problems = validateModel(m);
      if (problems.length) throw new SubtitlesError('INVALID_ARGS', `ModelManager: o modelo ${m && m.id} está sem ${problems.join(', ')} fixado(s) no catálogo.`);
    }
    this._catalog = catalog;
    this.platform = platform;
    this.arch = arch;
    this.installer = new ToolInstaller({ toolsDir: this.dir, entries: [], platform, arch, allowLoopbackHttp, ...installerOptions });
    this.installer.on('progress', (ev) => this.emit('progress', ev));
  }

  get catalog() { return this._catalog; }

  _model(modelId) { return this._catalog.find((m) => m.id === modelId) || null; }

  /** Resíduos de instalações interrompidas (chame ao iniciar o app). */
  cleanup() { return this.hostModels ? undefined : this.installer.cleanupStaging(); }

  isBusy(modelId) { return this._hostBusy.has(modelId) || this.installer.isBusy(entryIdFor(modelId)); }

  /** Arquivo do modelo no hospedeiro: { file, size, key } se existe com o tamanho do catálogo, senão null. */
  _hostFile(model) {
    let file;
    try { file = this.hostModels.resolve(model.id); } catch { return null; }
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile() || st.size !== model.sizeBytes) return null;
    return { file, size: st.size, key: `${path.resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}` };
  }

  /** Quem hospeda é o dono dos modelos; o tamanho já confere (`_hostFile`). SHA-256 conhecido como errado invalida o arquivo. */
  _hostInstalled(model) {
    const found = this._hostFile(model);
    if (!found || this._hostChecks.get(found.key) === 'bad') return null;
    return { id: model.id, path: found.file, sizeBytes: found.size, revision: model.revision, installedAt: null, sha256: model.sha256, origin: 'host', verified: this._hostChecks.get(found.key) === 'ok' };
  }

  /**
   * Confere o SHA-256 do modelo do hospedeiro contra o do catálogo (uma vez por arquivo; o resultado fica na memória). Resolve true se
   * confere (ou se o modelo não é do hospedeiro), false se o arquivo existe mas é outro. Lê em pedaços, sem travar o processo.
   */
  async verifyHost(modelId, { signal = null } = {}) {
    const model = this._model(modelId);
    if (!model || !this.hostModels) return true;
    const found = this._hostFile(model);
    if (!found) return false;
    const known = this._hostChecks.get(found.key);
    if (known === 'ok') return true;
    if (known === 'bad') return false;
    if (known) return known; // outra conferência do mesmo arquivo em andamento
    const pending = (async () => {
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(found.file, { highWaterMark: 4 * 1024 * 1024 })) {
        if (signal && signal.aborted) throw new SubtitlesError('CANCELLED', 'Conferência cancelada.');
        hash.update(chunk);
      }
      return hash.digest('hex') === model.sha256;
    })();
    this._hostChecks.set(found.key, pending);
    try {
      const ok = await pending;
      this._hostChecks.set(found.key, ok ? 'ok' : 'bad');
      return ok;
    } catch (err) {
      this._hostChecks.delete(found.key);
      throw err;
    }
  }

  busyIds() { return this._catalog.filter((m) => this.isBusy(m.id)).map((m) => m.id); }

  /** Cancela a instalação em andamento do modelo; false se não havia. */
  cancel(modelId) { return this.installer.cancel(entryIdFor(modelId)); }

  /**
   * Modelo instalado e íntegro (arquivo presente, com o tamanho gravado na instalação, e instalado a partir do SHA-256
   * que o catálogo fixa hoje) ou null. Não recalcula o SHA-256 a cada chamada (os arquivos são grandes): ele foi conferido
   * ao instalar. Um modelo de outro SHA-256 (de uma versão antiga do app) não vale: a instalação seguinte o troca.
   */
  installed(modelId) {
    const model = this._model(modelId);
    if (!model) return null;
    if (this.hostModels) return this._hostInstalled(model);
    const id = entryIdFor(modelId);
    const versions = registry.listInstalledVersions(this.dir, id)
      .sort((a, b) => String(b.manifest.installedAt || '').localeCompare(String(a.manifest.installedAt || '')));
    for (const v of versions) {
      const m = v.manifest;
      if (m.file !== model.file || !registry.isSafeFileName(m.exe) || String(m.sha256 || '').toLowerCase() !== model.sha256) continue;
      const file = registry.exePath(v.dir, m.exe);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile() || (Number.isSafeInteger(m.exeSize) && st.size !== m.exeSize)) continue;
      return { id: modelId, path: file, sizeBytes: st.size, revision: v.version.replace(/^r/, ''), installedAt: m.installedAt || null, sha256: m.sha256 };
    }
    return null;
  }

  /** Catálogo com o estado de cada modelo. */
  list() {
    return this._catalog.map((m) => {
      const inst = this.installed(m.id);
      return {
        id: m.id, label: m.label, description: m.description, sizeBytes: m.sizeBytes, dtw: m.dtw, file: m.file,
        installed: Boolean(inst), installedSizeBytes: inst ? inst.sizeBytes : 0, busy: this.isBusy(m.id),
        ...(this.hostModels ? { managedByHost: true, hostName: this.hostName } : {})
      };
    });
  }

  /**
   * Instala o modelo (ou devolve o que já está instalado, sem rede). Resolve com
   * { id, path, sizeBytes, revision, alreadyInstalled }.
   * Rejeita com SubtitlesError (UNKNOWN_MODEL, BUSY) ou ToolError do instalador (CANCELLED, CHECKSUM_MISMATCH,
   * SIZE_MISMATCH, DISK_SPACE, INCOMPLETE, HTTP_xxx…): sempre com mensagem em português.
   */
  async install(modelId, { signal = null, force = false } = {}) {
    const model = this._model(modelId);
    if (!model) throw new SubtitlesError('UNKNOWN_MODEL', `Modelo desconhecido: ${modelId}.`);
    if (!force) {
      const have = this.installed(modelId);
      if (have) return { ...have, alreadyInstalled: true };
    }
    if (this.isBusy(modelId)) throw new SubtitlesError('BUSY', `O modelo ${model.label} já está sendo baixado.`);
    if (this.hostModels) return this._installViaHost(model, signal);
    this.emit('progress', { id: entryIdFor(modelId), label: model.label, phase: 'prepare', message: 'Preparando o download…', percent: null, receivedBytes: 0, totalBytes: model.sizeBytes, speedBps: 0 });
    const entry = {
      id: entryIdFor(modelId),
      label: `Modelo ${model.label}`,
      version: `r${model.revision.slice(0, 12)}`,
      source: `oficial: https://huggingface.co/${REPO} (revisão ${model.revision.slice(0, 12)})`,
      assets: {
        [`${this.platform}-${this.arch}`]: {
          url: `${this.baseUrl}/${REPO}/resolve/${model.revision}/${encodeURIComponent(model.file)}`,
          name: model.file, size: model.sizeBytes, sha256: model.sha256, kind: 'file', exe: model.file
        }
      }
    };
    const res = await this.installer.install(entry, { signal, force });
    const have = this.installed(modelId);
    return { id: modelId, path: res.exe, sizeBytes: have ? have.sizeBytes : model.sizeBytes, revision: model.revision, alreadyInstalled: res.alreadyInstalled };
  }

  /** Pede ao hospedeiro que instale o modelo (pasta, download e conferência são dele) e confere o resultado contra o catálogo daqui. */
  async _installViaHost(model, signal) {
    const progressId = entryIdFor(model.id);
    this._hostBusy.add(model.id);
    const onAbort = () => { try { if (this.hostModels.cancel) this.hostModels.cancel(model.id); } catch { /* o hospedeiro já parou */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      this.emit('progress', { id: progressId, label: model.label, phase: 'prepare', message: `Pedindo ao ${this.hostName || 'aplicativo'} que baixe o modelo…`, percent: null, receivedBytes: 0, totalBytes: model.sizeBytes, speedBps: 0 });
      await this.hostModels.install(model.id, {
        signal,
        onProgress: (p) => this.emit('progress', {
          id: progressId, label: model.label, phase: (p && p.phase) || 'download', message: (p && p.message) || `Baixando ${model.label}…`,
          percent: p && Number.isFinite(p.percent) ? p.percent : null, receivedBytes: (p && p.receivedBytes) || 0,
          totalBytes: (p && p.totalBytes) || model.sizeBytes, speedBps: (p && p.speedBps) || 0
        })
      });
      const have = this._hostInstalled(model);
      if (!have) throw new SubtitlesError('HOST_MODEL_MISMATCH', `O ${this.hostName || 'aplicativo'} instalou o modelo ${model.label}, mas o arquivo não tem o tamanho esperado (${model.sizeBytes} bytes). Tente de novo.`);
      if (!(await this.verifyHost(model.id))) throw new SubtitlesError('HOST_MODEL_MISMATCH', `O arquivo do modelo ${model.label} no ${this.hostName || 'aplicativo'} não confere com o esperado (SHA-256). Reinstale o modelo por lá.`);
      return { id: model.id, path: have.path, sizeBytes: have.sizeBytes, revision: model.revision, alreadyInstalled: false };
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      this._hostBusy.delete(model.id);
    }
  }

  /** Apaga o modelo instalado (todas as revisões). Resolve com { id, removed }. */
  async remove(modelId) {
    if (!this._model(modelId)) throw new SubtitlesError('UNKNOWN_MODEL', `Modelo desconhecido: ${modelId}.`);
    if (this.hostModels) throw new SubtitlesError('HOST_MANAGED', `Este modelo é gerenciado pelo ${this.hostName || 'aplicativo que abriu o Braga Frame'}. Para remover, use as configurações dele.`);
    const res = await this.installer.remove(entryIdFor(modelId));
    return { id: modelId, removed: res.removed };
  }
}

module.exports = { MODELS, DEFAULT_MODEL_ID, REPO, BASE_URL, REVISION, getModel, entryIdFor, validateModel, ModelManager };
