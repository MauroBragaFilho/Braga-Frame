'use strict';

/**
 * Baixa o instalador de uma Release e o CONFERE (dono: base; docs/atualizacao.md). O arquivo só chega ao nome final se o tamanho e o SHA-256 forem
 * EXATAMENTE os que o GitHub informou na Release (o `digest` é calculado pelo GitHub quando o arquivo é enviado); antes disso ele vive num `.part`
 * que é apagado em qualquer falha. Nada aqui executa o arquivo.
 *
 * Defesas: o endereço já veio conferido de pickInstaller (check.js); aqui se confere também o endereço FINAL depois dos redirecionamentos (GitHub ou
 * githubusercontent.com), o Content-Length contra o tamanho esperado, o espaço livre em disco e que o fluxo nunca passe do tamanho esperado.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateError';
    this.code = code;
  }
}

const MESSAGES = Object.freeze({
  NETWORK: 'Não consegui baixar a atualização: sem conexão ou o GitHub não respondeu. Tente de novo mais tarde.',
  HTTP: 'Não consegui baixar a atualização: o GitHub respondeu com um erro. Tente de novo mais tarde.',
  HOST: 'A atualização foi recusada: o download foi redirecionado para um endereço que não é do GitHub.',
  SIZE: 'A atualização foi recusada: o arquivo baixado não tem o tamanho que a Release informa. Nada foi instalado.',
  HASH: 'A atualização foi recusada: o SHA-256 do arquivo baixado não confere com o da Release. Nada foi instalado.',
  DISK: 'Não há espaço livre suficiente para baixar a atualização. Libere espaço e tente de novo.',
  CANCELLED: 'Download cancelado.'
});

const GITHUB_HOST = (host) => host === 'github.com' || host.endsWith('.githubusercontent.com');
const SAFETY_MARGIN = 64 * 1024 * 1024; // além do tamanho do instalador, sobra mínima no disco
const PROGRESS_EVERY_MS = 200;

const fail = (code) => new UpdateError(code, MESSAGES[code]);

/** Bytes livres na unidade de `dir`; null se o sistema não informar (aí não se bloqueia). */
function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

/** SHA-256 de um arquivo, em blocos (sem carregar tudo na memória). */
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** O mesmo, síncrono: para o instante em que o app fecha e não dá para esperar. */
function hashFileSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/**
 * @param {{ asset: {name:string,url:string,size:number,sha256:string}, dir: string, fetchImpl?: Function, onProgress?: Function,
 *           signal?: AbortSignal, allowHost?: (host:string)=>boolean, free?: (dir:string)=>number|null, userAgent?: string }} o
 * @returns {Promise<{ file: string, size: number, sha256: string }>} o arquivo conferido (nome final, dentro de `dir`)
 * @throws {UpdateError} NETWORK | HTTP | HOST | SIZE | HASH | DISK | CANCELLED (mensagens em português; nada fica no disco além de `dir`)
 */
async function downloadInstaller({ asset, dir, fetchImpl = globalThis.fetch, onProgress = () => {}, signal, allowHost = GITHUB_HOST, free = freeBytes, userAgent = 'BragaFrame (atualizacao)' }) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, asset.name);
  const part = `${dest}.part`;
  const cleanup = () => { try { fs.rmSync(part, { force: true }); } catch { /* ignorar */ } };
  cleanup();

  const room = free(dir);
  if (room !== null && room < asset.size + SAFETY_MARGIN) throw fail('DISK');

  let handle = null;
  try {
    let res;
    try {
      res = await fetchImpl(asset.url, { signal, redirect: 'follow', headers: { Accept: 'application/octet-stream', 'User-Agent': userAgent } });
    } catch (err) {
      throw err && err.name === 'AbortError' ? fail('CANCELLED') : fail('NETWORK');
    }
    if (!res.ok) throw fail('HTTP');
    try { if (res.url && !allowHost(new URL(res.url).hostname)) throw fail('HOST'); } catch (err) { if (err instanceof UpdateError) throw err; throw fail('HOST'); }
    const length = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(length) && length > 0 && length !== asset.size) throw fail('SIZE');

    handle = await fs.promises.open(part, 'w');
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    try {
      for await (const chunk of res.body) {
        received += chunk.length;
        if (received > asset.size) throw fail('SIZE'); // passou do que a Release informa: para na hora
        hash.update(chunk);
        await handle.write(chunk);
        const now = Date.now();
        if (now - lastReport >= PROGRESS_EVERY_MS) { lastReport = now; onProgress({ received, total: asset.size, percent: Math.min(100, Math.floor((received / asset.size) * 100)) }); }
      }
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      throw err && err.name === 'AbortError' ? fail('CANCELLED') : fail('NETWORK');
    }
    await handle.close();
    handle = null;
    if (received !== asset.size) throw fail('SIZE');
    if (hash.digest('hex') !== asset.sha256) throw fail('HASH');
    onProgress({ received, total: asset.size, percent: 100 });

    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return { file: dest, size: received, sha256: asset.sha256 };
  } catch (err) {
    if (handle) { try { await handle.close(); } catch { /* ignorar */ } }
    cleanup();
    throw err instanceof UpdateError ? err : fail('NETWORK');
  }
}

module.exports = { UpdateError, MESSAGES, GITHUB_HOST, SAFETY_MARGIN, freeBytes, hashFile, hashFileSync, downloadInstaller };
