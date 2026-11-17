'use strict';

/**
 * Proxy de visualização: uma cópia LEVE do vídeo (H.264 de até 720p, AAC estéreo) só para o player do app tocar quando o Chromium não
 * consegue tocar o original (HEVC, áudio AC-3/DTS, alguns MKV/TS do OBS). A exportação, a análise e todos os horários continuam usando o
 * ARQUIVO ORIGINAL: o proxy tem a mesma duração e os mesmos tempos (quadro de vídeo constante, áudio alinhado), então um instante do
 * player é o mesmo instante do vídeo.
 *
 *   ensure(file) -> { state: 'ready'|'running', proxyPath, p? }       começa (ou reaproveita) a cópia; lança ProxyError
 *   status(file) -> { state: 'none'|'ready'|'running', proxyPath?, p? }
 *   cancel()     -> true se havia algo rodando
 * Eventos: 'progress' { file, p, etaSec }, 'done' { file, proxyPath }, 'failed' { file, code, message }, 'cancelled' { file }.
 *
 * Um proxy por vez (abrir outro vídeo cancela o anterior). Arquivos em `dir` (cache do app): `<chave>.mp4`, gravados como `.part` e
 * renomeados no fim (nunca existe proxy pela metade); a chave é a da análise (tamanho + 3 trechos do arquivo), então copiar ou renomear o
 * vídeo reaproveita a cópia. A pasta é limitada por `maxBytes` (apaga os proxies mais antigos). Nada aqui toca o vídeo de origem.
 */

const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { lowerPriority } = require('../system/resources');

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MIN_VALID_BYTES = 1024;
const PROGRESS_STEP = 0.005;
const STDERR_TAIL = 4000;

class ProxyError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ProxyError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Argumentos do ffmpeg: até 720p (a menor medida), H.264 veryfast de qualidade modesta, quadro-chave a cada ~1 s (avançar e voltar rápido),
 * áudio AAC estéreo alinhado ao vídeo, sem metadados, `faststart` (o player começa antes de ler o arquivo todo).
 */
function buildProxyArgs({ input, output, withAudio = true }) {
  return [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-i', input,
    '-map', '0:v:0', ...(withAudio ? ['-map', '0:a:0?'] : []),
    '-vf', "scale=w='if(gt(iw,ih),min(1280,iw),min(720,iw))':h=-2:flags=fast_bilinear,setsar=1,format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '30', '-sc_threshold', '0',
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-af', 'aresample=async=1:first_pts=0'] : ['-an']),
    '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
    '-movflags', '+faststart', '-f', 'mp4', output
  ];
}

/** O que dizer ao usuário quando o ffmpeg falha (a causa vem do fim da saída de erro dele). */
function explainFailure(stderr) {
  const text = String(stderr || '');
  if (/No space left|ENOSPC/i.test(text)) return new ProxyError('NO_DISK_SPACE', 'Não há espaço em disco para criar a cópia leve do vídeo. Libere espaço e tente de novo.');
  if (/Unknown encoder|Encoder .* not found|libx264/i.test(text) && /not found|Unknown/i.test(text)) {
    return new ProxyError('CODEC_UNSUPPORTED', 'Este FFmpeg não tem o codificador H.264 (libx264), então não dá para criar a cópia leve. Use um FFmpeg completo (build "full").');
  }
  const last = text.trim().split(/\r?\n/).filter(Boolean).pop() || 'o ffmpeg terminou com erro';
  return new ProxyError('PROXY_FAILED', `Não foi possível criar a cópia leve do vídeo para o player (${last.slice(0, 200)}).`, { stderr: text.slice(-STDERR_TAIL) });
}

class ProxyManager extends EventEmitter {
  /**
   * @param {object} o
   *   dir        pasta dos proxies (criada quando precisa)
   *   getTools   () => { ffmpeg, ffprobe }
   *   keyOf      (arquivo) => chave estável (padrão: sourceKey da análise)
   *   probe      async (ffprobe, arquivo) => { duration } (padrão: probeMedia)
   *   spawnFn    para testes
   *   maxBytes   limite da pasta
   */
  constructor(o = {}) {
    super();
    if (!o.dir) throw new Error('ProxyManager: informe dir.');
    this.dir = o.dir;
    this.getTools = typeof o.getTools === 'function' ? o.getTools : () => ({});
    this.keyOf = o.keyOf || ((file) => require('../analysis/cache').sourceKey(file));
    this.probe = o.probe || ((ffprobe, file) => require('../ffmpeg/probe').probeMedia(ffprobe, file));
    this.spawnFn = o.spawnFn || spawn;
    this.maxBytes = o.maxBytes ?? DEFAULT_MAX_BYTES;
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.job = null; // { file, key, output, part, controller, p, etaSec, startedAt }
    this.closed = false;
  }

  proxyPathFor(file) {
    return path.join(this.dir, `${this.keyOf(file)}.mp4`);
  }

  _isReady(output) {
    try { const st = fs.statSync(output); return st.isFile() && st.size >= MIN_VALID_BYTES; } catch { return false; }
  }

  status(file) {
    if (this.job && this.job.file === file) return { state: 'running', proxyPath: this.job.output, p: this.job.p, etaSec: this.job.etaSec };
    let output;
    try { output = this.proxyPathFor(file); } catch { return { state: 'none' }; }
    return this._isReady(output) ? { state: 'ready', proxyPath: output } : { state: 'none' };
  }

  /** Começa a cópia (ou devolve a que já existe). Lança ProxyError (INVALID_PATH, INPUT_MISSING, NO_FFMPEG). */
  async ensure(file) {
    if (this.closed) throw new ProxyError('CLOSED', 'O app está fechando.');
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new ProxyError('INVALID_PATH', 'Informe o caminho completo do vídeo.');
    let stat;
    try { stat = fs.statSync(file); } catch { stat = null; }
    if (!stat || !stat.isFile()) throw new ProxyError('INPUT_MISSING', `O vídeo não foi encontrado: ${file}`);
    const tools = this.getTools() || {};
    if (!tools.ffmpeg) throw new ProxyError('NO_FFMPEG', 'O FFmpeg não foi encontrado, então não dá para criar a cópia leve do vídeo. Instale o FFmpeg e use "Verificar de novo" na aba Ferramentas.');

    const current = this.status(file);
    if (current.state === 'ready') {
      try { const now = new Date(); fs.utimesSync(current.proxyPath, now, now); } catch { /* só a ordem de limpeza */ }
      return current;
    }
    if (current.state === 'running') return current;
    if (this.job) this.cancel(); // outro vídeo: o anterior não interessa mais

    const output = this.proxyPathFor(file);
    const job = { file, output, part: `${output}.part`, controller: new AbortController(), p: 0, etaSec: null, startedAt: Date.now() };
    this.job = job;
    this._run(job, tools).catch((err) => this.log('error', `proxy: erro inesperado: ${err && err.stack ? err.stack : err}`));
    return { state: 'running', proxyPath: output, p: 0 };
  }

  cancel() {
    if (!this.job) return false;
    this.job.controller.abort();
    return true;
  }

  shutdown() {
    this.closed = true;
    this.cancel();
  }

  async _run(job, tools) {
    const fail = (err) => {
      if (this.job === job) this.job = null;
      this._removePart(job);
      if (err && err.code === 'CANCELLED') { this.emit('cancelled', { file: job.file }); return; }
      const e = err instanceof ProxyError ? err : new ProxyError('PROXY_FAILED', `Não foi possível criar a cópia leve: ${err && err.message ? err.message : err}`);
      this.log('warn', `proxy: ${e.message}`);
      this.emit('failed', { file: job.file, code: e.code, message: e.message });
    };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let duration = 0;
      let withAudio = true;
      if (tools.ffprobe) {
        try {
          const info = await this.probe(tools.ffprobe, job.file);
          duration = Number(info.duration) || 0;
          withAudio = info.hasAudio !== false;
        } catch { /* sem a duração a barra fica sem porcentagem, mas a cópia sai */ }
      }
      if (job.controller.signal.aborted) throw Object.assign(new Error('cancelado'), { code: 'CANCELLED' });
      this._removePart(job);
      const result = await this._ffmpeg(tools.ffmpeg, buildProxyArgs({ input: job.file, output: job.part, withAudio }), job, duration);
      if (result.aborted || job.controller.signal.aborted) throw Object.assign(new Error('cancelado'), { code: 'CANCELLED' });
      if (result.code !== 0) throw explainFailure(result.stderr);
      if (!this._isReady(job.part)) throw new ProxyError('PROXY_FAILED', 'O ffmpeg terminou, mas não gerou a cópia leve.');
      fs.renameSync(job.part, job.output);
      if (this.job === job) this.job = null;
      this.emit('progress', { file: job.file, p: 1, etaSec: 0 });
      this.emit('done', { file: job.file, proxyPath: job.output });
      this._prune(job.output);
    } catch (err) {
      fail(err);
    }
  }

  _ffmpeg(ffmpeg, args, job, duration) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnFn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        reject(new ProxyError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`));
        return;
      }
      if (child.pid) lowerPriority(child.pid); // a cópia nunca atrapalha o resto do computador
      let stderr = '';
      let buffer = '';
      let last = -1;
      let aborted = false;
      const kill = () => { aborted = true; try { child.kill(); } catch { /* já terminou */ } };
      if (job.controller.signal.aborted) kill(); else job.controller.signal.addEventListener('abort', kill, { once: true });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (!m || !(duration > 0)) continue;
          const p = Math.min(0.999, Number(m[1]) / 1e6 / duration);
          if (p - last < PROGRESS_STEP) continue;
          last = p;
          job.p = p;
          const elapsed = (Date.now() - job.startedAt) / 1000;
          job.etaSec = p > 0.03 && elapsed > 2 ? Math.round((elapsed * (1 - p)) / p) : null;
          this.emit('progress', { file: job.file, p, etaSec: job.etaSec });
        }
      });
      child.on('error', (err) => { job.controller.signal.removeEventListener('abort', kill); reject(new ProxyError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`)); });
      child.on('close', (code) => { job.controller.signal.removeEventListener('abort', kill); resolve({ code, stderr, aborted }); });
    });
  }

  _removePart(job) {
    try { fs.rmSync(job.part, { force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* fica para a próxima limpeza */ }
  }

  /** Mantém a pasta abaixo do limite apagando os proxies mais antigos (nunca o que acabou de ficar pronto). */
  _prune(keep) {
    let entries;
    try {
      entries = fs.readdirSync(this.dir).filter((n) => n.endsWith('.mp4')).map((n) => {
        const file = path.join(this.dir, n);
        const st = fs.statSync(file);
        return { file, size: st.size, at: st.mtimeMs };
      });
    } catch { return; }
    let total = entries.reduce((n, e) => n + e.size, 0);
    for (const e of entries.sort((a, b) => a.at - b.at)) {
      if (total <= this.maxBytes) break;
      if (e.file === keep) continue;
      try { fs.rmSync(e.file, { force: true }); total -= e.size; } catch { /* em uso: fica */ }
    }
  }
}

module.exports = { ProxyManager, ProxyError, buildProxyArgs, explainFailure, DEFAULT_MAX_BYTES };
