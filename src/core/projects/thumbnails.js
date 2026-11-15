'use strict';

/**
 * Miniaturas dos projetos (aba Projetos): um quadro do vídeo, em JPEG de 320 px de largura, guardado em `<pasta>/<id>.<chave>.jpg`.
 *
 *  - O QUADRO é tirado do próprio vídeo, neste computador, pelo ffmpeg do sistema (nada de rede): em 10% da duração (entre 5 s e 10 min), onde uma
 *    live já passou da abertura e costuma ter jogo na tela. Se o instante não render quadro, tenta o começo.
 *  - A CHAVE vem do caminho, tamanho e duração do vídeo: se o arquivo muda (outra gravação no mesmo nome), a miniatura é refeita e a antiga sai.
 *  - O ffmpeg roda em segundo plano com prioridade baixa, no máximo `concurrency` por vez (a lista pode ter dezenas de projetos), com prazo,
 *    e o mesmo pedido repetido reaproveita o que já está em andamento. Falha não é repetida por um minuto (um vídeo que não abre não vira tempestade).
 *  - Antes de chamar o ffmpeg confere (com prazo) se o vídeo está acessível: um compartilhamento de rede fora do ar não prende os trabalhadores.
 *  - Vídeo que sumiu ou foi movido continua mostrando a miniatura que já existe.
 * O dono do arquivo é este módulo; apagar o projeto apaga `<id>.*` desta pasta (project:delete). Nada aqui toca em arquivo do usuário.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { runFfmpeg } = require('../analysis/proc');
const { guardIo } = require('../sources/fsGuard');

const ID_RE = /^[0-9a-f]{16}$/;
const WIDTH = 320;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 25000;
const FAIL_TTL_MS = 60000;
const REACH_TIMEOUT_MS = 2500;
const MIN_BYTES = 200; // um JPEG de verdade tem mais que isso

const norm = (p) => {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Instante do quadro: 10% da duração, entre 5 s e 10 min; vídeo curto (menos de 30 s) usa o meio; duração desconhecida usa 5 s. */
function thumbTime(duration) {
  const d = Number(duration) || 0;
  if (!(d > 0)) return 5;
  if (d < 30) return Math.round((d / 2) * 1000) / 1000;
  return Math.min(Math.max(d * 0.1, 5), 600);
}

const isJpeg = (buf) => buf.length >= MIN_BYTES && buf[0] === 0xff && buf[1] === 0xd8;

class ThumbnailCache {
  /**
   * @param {{ dir: string, getFfmpeg: () => (string|null), concurrency?: number, timeoutMs?: number, now?: () => number, spawn?: Function }} o
   *   `spawn` (testes) troca o child_process.spawn do ffmpeg.
   */
  constructor({ dir, getFfmpeg, concurrency = DEFAULT_CONCURRENCY, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now, spawn } = {}) {
    this.dir = dir;
    this.getFfmpeg = getFfmpeg;
    this.concurrency = Math.max(1, Math.floor(concurrency) || 1);
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.spawn = spawn;
    this.waiting = []; // tarefas esperando vaga: { id, run, cancel }
    this.active = 0;
    this.inflight = new Map(); // arquivo final -> Promise do resultado
    this.controllers = new Map(); // id -> Set(AbortController) das gerações em andamento
    this.failed = new Map(); // arquivo final -> instante da falha
    fs.mkdirSync(dir, { recursive: true });
  }

  keyFor({ path: sourcePath, size, duration }) {
    return crypto.createHash('sha1').update(`bf-thumb|${norm(sourcePath)}|${Number(size) || 0}|${Math.round(Number(duration) || 0)}`).digest('hex').slice(0, 10);
  }

  fileFor(id, key) {
    return path.join(this.dir, `${id}.${key}.jpg`);
  }

  /** A miniatura mais recente que existe para o projeto (qualquer chave): { file, mtimeMs } | null. */
  cached(id) {
    let best = null;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return null; }
    for (const name of names) {
      if (!name.startsWith(`${id}.`) || !name.endsWith('.jpg')) continue;
      try {
        const st = fs.statSync(path.join(this.dir, name));
        if (st.isFile() && st.size >= MIN_BYTES && (!best || st.mtimeMs > best.mtimeMs)) best = { file: path.join(this.dir, name), mtimeMs: st.mtimeMs };
      } catch { /* sumiu agora */ }
    }
    return best;
  }

  _ready(found) {
    return { state: 'ready', file: found.file, mtimeMs: found.mtimeMs, url: `${pathToFileURL(found.file).href}?v=${Math.round(found.mtimeMs)}` };
  }

  /**
   * Miniatura do projeto. `source` = { id, path, size, duration } (o id tem de ser o do projeto). Resolve sempre, sem lançar:
   *   { state:'ready', file, url, mtimeMs } | { state:'missing' } (vídeo inacessível e nenhuma miniatura guardada) |
   *   { state:'none', reason:'NO_FFMPEG'|'FAILED'|'CANCELLED' }.
   */
  async get(source) {
    const id = source && source.id;
    if (typeof id !== 'string' || !ID_RE.test(id) || typeof source.path !== 'string' || !source.path) return { state: 'none', reason: 'INVALID' };
    const key = this.keyFor(source);
    const file = this.fileFor(id, key);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.size >= MIN_BYTES) return this._ready({ file, mtimeMs: st.mtimeMs });
    } catch { /* ainda não existe */ }
    const older = () => { const found = this.cached(id); return found ? this._ready(found) : null; };
    const failedAt = this.failed.get(file);
    if (failedAt !== undefined && this.now() - failedAt < FAIL_TTL_MS) return older() || { state: 'none', reason: 'FAILED' };
    const reach = await guardIo(`thumb-stat:${norm(source.path)}`, () => fs.promises.stat(source.path), { timeoutMs: REACH_TIMEOUT_MS });
    if (!reach.ok || !reach.value.isFile()) return older() || { state: 'missing' };
    const ffmpeg = typeof this.getFfmpeg === 'function' ? this.getFfmpeg() : null;
    if (!ffmpeg) return older() || { state: 'none', reason: 'NO_FFMPEG' };
    let pending = this.inflight.get(file);
    if (!pending) {
      pending = this._schedule(id, () => this._generate({ ffmpeg, source, file, id }))
        .finally(() => this.inflight.delete(file));
      this.inflight.set(file, pending);
    }
    const res = await pending;
    if (res.state === 'ready') return res;
    return older() || res;
  }

  /** Põe a tarefa na fila de `concurrency` vagas. A tarefa recebe a vaga quando chega a vez; `cancel(id)` tira as que ainda esperam. */
  _schedule(id, run) {
    return new Promise((resolve) => {
      const task = { id, run: () => run().then(resolve, () => resolve({ state: 'none', reason: 'FAILED' })), cancel: () => resolve({ state: 'none', reason: 'CANCELLED' }) };
      this.waiting.push(task);
      this._pump();
    });
  }

  _pump() {
    while (this.active < this.concurrency && this.waiting.length) {
      const task = this.waiting.shift();
      this.active += 1;
      task.run().finally(() => { this.active -= 1; this._pump(); });
    }
  }

  _fail(file) {
    this.failed.set(file, this.now());
    return { state: 'none', reason: 'FAILED' };
  }

  async _generate({ ffmpeg, source, file, id }) {
    const run = { controller: new AbortController(), cancelled: false };
    if (!this.controllers.has(id)) this.controllers.set(id, new Set());
    this.controllers.get(id).add(run);
    const timer = setTimeout(() => run.controller.abort(), this.timeoutMs);
    try {
      const time = thumbTime(source.duration);
      let jpeg = await this._grab(ffmpeg, source.path, time, run.controller.signal);
      if (!jpeg && time > 0.5) jpeg = await this._grab(ffmpeg, source.path, 0, run.controller.signal); // o instante não rendeu quadro: tenta o começo
      if (!jpeg) return this._fail(file);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, jpeg);
        fs.renameSync(tmp, file);
      } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nada a fazer */ }
        return this._fail(file);
      }
      this._removeStale(id, file);
      this.failed.delete(file);
      return this._ready({ file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // cancelado de fora (o projeto está sendo apagado) não é falha do vídeo; o prazo estourado e o ffmpeg que não abriu são
      return run.cancelled ? { state: 'none', reason: 'CANCELLED' } : this._fail(file);
    } finally {
      clearTimeout(timer);
      const set = this.controllers.get(id);
      if (set) { set.delete(run); if (!set.size) this.controllers.delete(id); }
    }
  }

  /** Um quadro em JPEG (Buffer) ou null. Lança CANCELLED se o pedido foi cancelado/estourou o prazo. */
  async _grab(ffmpeg, sourcePath, timeSec, signal) {
    const chunks = [];
    let size = 0;
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', String(Math.max(0, Number(timeSec.toFixed(3)))), '-i', sourcePath,
      '-frames:v', '1', '-an', '-sn', '-vf', `scale=${WIDTH}:-2:flags=bicubic`, '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'];
    const { code } = await runFfmpeg(ffmpeg, args, {
      signal,
      spawn: this.spawn,
      onStdout: (chunk) => { size += chunk.length; if (size <= 2 * 1024 * 1024) chunks.push(chunk); }
    });
    if (code !== 0) return null;
    const buf = Buffer.concat(chunks);
    return isJpeg(buf) ? buf : null;
  }

  /** Tira as miniaturas antigas do projeto (outras chaves). */
  _removeStale(id, keep) {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const full = path.join(this.dir, name);
      if (name.startsWith(`${id}.`) && full !== keep) { try { fs.rmSync(full, { force: true }); } catch { /* em uso: fica para a próxima */ } }
    }
  }

  /** Cancela o que está esperando e o que está em andamento para este projeto (antes de apagá-lo). */
  cancel(id) {
    const keep = [];
    for (const task of this.waiting) { if (task.id === id) task.cancel(); else keep.push(task); }
    this.waiting = keep;
    for (const run of this.controllers.get(id) || []) { run.cancelled = true; run.controller.abort(); }
  }
}

module.exports = { ThumbnailCache, thumbTime, ID_RE, WIDTH };
