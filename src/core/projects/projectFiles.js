'use strict';

/**
 * Os ARQUIVOS de um projeto, para apagá-lo (aba Projetos, lixeira). Duas regras mandam em tudo aqui:
 *
 *  1. Só se apaga o que o app PODE PROVAR que é dele e deste projeto: arquivos de dados que ele guarda em pastas próprias (`<pasta>/<id>.*`), os cortes
 *     exportados que o projeto anotou (`cut.exports[].path`) com as legendas externas gravadas ao lado deles, e o vídeo (com o chat) que o próprio app
 *     BAIXOU (o registro de downloads da aba Novo projeto (sources) é a prova). O vídeo do usuário, a legenda `.srt` que ele importou e qualquer outro arquivo ao lado
 *     NUNCA entram, nem por pedido.
 *  2. Pasta, atalho e link simbólico nunca são apagados; arquivo de outro projeto (qualquer vídeo de origem, ou corte que outro projeto também
 *     anotou) é protegido; extensão fora de vídeo não passa.
 *
 * Tudo é assíncrono e com prazo (`guardIo`, o mesmo cuidado da aba Novo projeto (sources)): uma pasta de exportação num compartilhamento de rede fora do ar não congela o
 * app. Erros passageiros do Windows (antivírus, o player ainda soltando o arquivo) são repetidos algumas vezes antes de virar falha.
 */

const fs = require('node:fs');
const path = require('node:path');
const { guardIo } = require('../sources/fsGuard');

const EXPORT_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm']); // a exportação só produz MP4; os outros cobrem registros antigos
const SIDECAR_EXTS = Object.freeze(['.srt', '.ass', '.vtt']);
const STAT_TIMEOUT_MS = 4000;
const REMOVE_TIMEOUT_MS = 20000;
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EAGAIN']);
const RETRIES = 4;
const RETRY_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Caminho em forma comparável (absoluto; sem diferenciar caixa no Windows). */
function normPath(p) {
  const resolved = path.resolve(String(p));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * O que existe neste caminho, sem seguir link simbólico: { kind:'file', bytes } | { kind:'missing' } | { kind:'other' } (pasta, link…) |
 * { kind:'unknown' } (o disco não respondeu a tempo ou negou o acesso).
 */
async function statFile(file) {
  const res = await guardIo(`lstat:${normPath(file)}`, () => fs.promises.lstat(file), { timeoutMs: STAT_TIMEOUT_MS });
  if (res.timedOut) return { kind: 'unknown' };
  if (!res.ok) {
    const code = res.error && res.error.code;
    return { kind: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown' };
  }
  return res.value.isFile() ? { kind: 'file', bytes: res.value.size } : { kind: 'other' };
}

function describeFailure(code, error) {
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'o arquivo está em uso por outro programa (ou sem permissão)';
  if (code === 'TIMEOUT') return 'o disco não respondeu a tempo';
  return (error && error.message) || 'erro desconhecido';
}

/** Apaga UM arquivo (nunca pasta): { ok:true, missing? } | { ok:false, code, message }. Repete o que o Windows costuma soltar logo depois. */
async function removeFile(file, { retries = RETRIES, delayMs = RETRY_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await guardIo(`unlink:${normPath(file)}:${attempt}`, () => fs.promises.unlink(file), { timeoutMs: REMOVE_TIMEOUT_MS });
    if (res.timedOut) return { ok: false, code: 'TIMEOUT', message: describeFailure('TIMEOUT') };
    if (res.ok) return { ok: true };
    const code = res.error && res.error.code;
    if (code === 'ENOENT') return { ok: true, missing: true };
    if (!TRANSIENT.has(code) || attempt >= retries) return { ok: false, code: code || 'ERROR', message: describeFailure(code, res.error) };
    await sleep(delayMs * (attempt + 1));
  }
}

/** Apaga a lista na ordem. Devolve { removed: [item], failed: [{ ...item, code, message }] } (uma falha não impede as outras). */
async function removeAll(items) {
  const removed = [];
  const failed = [];
  for (const item of items) {
    const res = await removeFile(item.file);
    if (res.ok) removed.push(item); else failed.push({ ...item, code: res.code, message: res.message });
  }
  return { removed, failed };
}

/**
 * Arquivos de dados do projeto fora da pasta de projetos: `<pasta>/<id>.*` em cada pasta de `dirs` ({ history, transcripts, thumbs }). O id é um hash
 * de 16 caracteres hexadecimais, então o nome de outro projeto nunca começa assim. Devolve [{ kind, file, bytes }].
 */
async function dataFiles(id, dirs) {
  const out = [];
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return out;
  for (const [kind, dir] of Object.entries(dirs || {})) {
    if (!dir) continue;
    let names;
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith(`${id}.`)) continue;
      const file = path.join(dir, name);
      const st = await statFile(file);
      if (st.kind === 'file') out.push({ kind, file, bytes: st.bytes });
    }
  }
  return out;
}

/**
 * Cortes exportados que o projeto anotou e as legendas externas ao lado deles. Entra só o que: é caminho absoluto de vídeo exportável, NÃO é o
 * vídeo de origem de nenhum projeto (`protectedPaths`, conjunto de normPath) e existe agora como arquivo comum. `missing` conta as anotações
 * cujo arquivo já não existe (o usuário costuma apagar as exportações à mão). Devolve { files: [{ kind:'export'|'sidecar', file, bytes, cutId }], missing }.
 */
async function exportFiles(project, { protectedPaths = new Set() } = {}) {
  const seen = new Set();
  const files = [];
  let missing = 0;
  for (const cut of (project && project.cuts) || []) {
    for (const entry of Array.isArray(cut.exports) ? cut.exports : []) {
      const file = entry && typeof entry.path === 'string' ? entry.path : '';
      if (!file || !path.isAbsolute(file)) continue;
      const ext = path.extname(file).toLowerCase();
      if (!EXPORT_EXTS.has(ext)) continue;
      const key = normPath(file);
      if (seen.has(key) || protectedPaths.has(key)) continue;
      seen.add(key);
      const st = await statFile(file);
      if (st.kind === 'missing') { missing += 1; continue; }
      if (st.kind !== 'file') continue;
      files.push({ kind: 'export', file, bytes: st.bytes, cutId: cut.id });
      for (const sidecarExt of SIDECAR_EXTS) {
        const side = `${file.slice(0, -ext.length)}${sidecarExt}`;
        const sideKey = normPath(side);
        if (seen.has(sideKey) || protectedPaths.has(sideKey)) continue;
        seen.add(sideKey);
        const ss = await statFile(side);
        if (ss.kind === 'file') files.push({ kind: 'sidecar', file: side, bytes: ss.bytes, cutId: cut.id });
      }
    }
  }
  return { files, missing };
}

/**
 * O vídeo e o chat que o PRÓPRIO app baixou para este projeto, se o registro de downloads da aba Novo projeto (sources) (`record`: { path, chat:{ path } }) prova
 * isso: o registro precisa apontar para o vídeo de origem deste projeto. Sem registro (vídeo do usuário, gravação do OBS…) devolve `null`: nada é apagado.
 * Devolve null | { video: { file, bytes } | null, chat: { file, bytes } | null }.
 */
async function downloadFiles(project, record) {
  if (!project || !project.source || !record || typeof record.path !== 'string') return null;
  if (normPath(record.path) !== normPath(project.source.path)) return null;
  const video = await statFile(project.source.path);
  const chatFile = record.chat && typeof record.chat.path === 'string' && path.extname(record.chat.path).toLowerCase() === '.json' ? record.chat.path : '';
  const chat = chatFile && normPath(chatFile) !== normPath(project.source.path) ? await statFile(chatFile) : { kind: 'missing' };
  return {
    video: video.kind === 'file' ? { file: project.source.path, bytes: video.bytes } : null,
    chat: chat.kind === 'file' ? { file: chatFile, bytes: chat.bytes } : null
  };
}

/** A pasta "Cortes" padrão (ao lado do vídeo) que ficou vazia depois de apagar as exportações. `rmdir` recusa pasta com arquivo: nada além do vazio sai. */
async function pruneDefaultExportDir(project) {
  if (!project || !project.source || !project.source.path) return false;
  const dir = path.join(path.dirname(project.source.path), 'Cortes');
  if (project.exportDir && normPath(project.exportDir) !== normPath(dir)) return false; // pasta escolhida pelo usuário: fica
  const res = await guardIo(`rmdir:${normPath(dir)}`, () => fs.promises.rmdir(dir), { timeoutMs: STAT_TIMEOUT_MS });
  return Boolean(res.ok);
}

const sumBytes = (items) => items.reduce((n, item) => n + (item.bytes || 0), 0);

module.exports = {
  normPath, statFile, removeFile, removeAll, dataFiles, exportFiles, downloadFiles, pruneDefaultExportDir, sumBytes,
  EXPORT_EXTS, SIDECAR_EXTS
};
