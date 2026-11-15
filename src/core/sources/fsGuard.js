'use strict';

/**
 * Leituras de disco em pastas que o USUÁRIO configurou (gravações do OBS, pasta escolhida à mão), que podem estar num
 * compartilhamento de rede fora do ar ou numa unidade desconectada (perfis antigos do OBS apontando para um NAS são comuns).
 * No Windows um `fs.statSync` numa pasta assim congela o processo principal INTEIRO (todas as abas, a fila, a exportação)
 * por ~21 s. Por isso, aqui tudo é assíncrono e com limite de tempo: passado o prazo, devolve "não sei" (`exists: null`)
 * em vez de esperar o sistema desistir.
 *
 * A chamada que estourou o prazo continua pendurada numa thread do sistema até o Windows desistir. Para ela não ocupar
 * todas as threads (o libuv tem 4, compartilhadas com o resto do app):
 *   - chamadas repetidas para a mesma pasta reaproveitam a que já está pendente (nunca abrem uma segunda);
 *   - no máximo MAX_HUNG pastas diferentes podem estar penduradas ao mesmo tempo; as demais respondem "não sei" na hora.
 */

const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 2500;
const MAX_HUNG = 3;

const pending = new Map(); // chave -> Promise do resultado (a operação ainda não terminou)
const hung = new Set(); // chaves cuja operação passou do prazo e segue pendurada

const keyOf = (kind, target) => `${kind}:${process.platform === 'win32' ? String(target).toLowerCase() : String(target)}`;

/**
 * Executa `op()` (que devolve uma Promise de E/S) com prazo.
 * @returns {Promise<{ ok:true, value:* } | { ok:false, error:Error } | { timedOut:true, skipped?:boolean }>}
 */
function guardIo(key, op, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let promise = pending.get(key);
  if (!promise) {
    if (hung.size >= MAX_HUNG) return Promise.resolve({ timedOut: true, skipped: true });
    promise = Promise.resolve().then(op).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    pending.set(key, promise);
    promise.then(() => { pending.delete(key); hung.delete(key); });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { hung.add(key); resolve({ timedOut: true }); }, timeoutMs);
    promise.then((result) => { clearTimeout(timer); resolve(result); });
  });
}

/**
 * A pasta existe e é pasta?  `exists`: true | false (não existe) | null (não consegui saber: rede fora do ar, sem permissão,
 * unidade que não responde). `timedOut` quando o prazo estourou; `code` é o código do sistema quando houve outro erro.
 * @returns {Promise<{ exists:boolean|null, timedOut?:boolean, code?:string }>}
 */
async function checkFolder(folder, { timeoutMs } = {}) {
  if (typeof folder !== 'string' || !folder) return { exists: false };
  const res = await guardIo(keyOf('stat', folder), () => fs.promises.stat(folder), { timeoutMs });
  if (res.timedOut) return { exists: null, timedOut: true };
  if (res.ok) return { exists: res.value.isDirectory() };
  const code = res.error && res.error.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { exists: false };
  return { exists: null, ...(code ? { code } : {}) };
}

/** Lista a pasta com prazo: { entries } | { timedOut:true } | { error }. */
async function readFolder(folder, { timeoutMs } = {}) {
  const res = await guardIo(keyOf('readdir', folder), () => fs.promises.readdir(folder, { withFileTypes: true }), { timeoutMs });
  if (res.timedOut) return { timedOut: true };
  if (res.ok) return { entries: res.value };
  return { error: res.error };
}

/** Só para os testes: quantas operações estão penduradas agora. */
const stats = () => ({ pending: pending.size, hung: hung.size });

module.exports = { guardIo, checkFolder, readFolder, stats, DEFAULT_TIMEOUT_MS, MAX_HUNG };
