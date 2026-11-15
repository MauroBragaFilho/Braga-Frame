'use strict';

/**
 * Lista as gravações de uma pasta (OBS ou escolhida à mão), da mais recente para a mais antiga, com a duração
 * lida pelo ffprobe e a marca "gravando" para arquivos que ainda estão sendo escritos (dono: sources).
 *
 * Como saber que o OBS ainda grava: só são examinados arquivos modificados há menos de `recentMs` (30 s; o OBS
 * descarrega dados o tempo todo). Depois de `sampleMs` (1,2 s) eles são medidos de novo: se o tamanho ou a data
 * mudaram, ou se a última escrita foi há menos de `quietMs` (8 s), o arquivo é "em gravação". Uma gravação PAUSADA no
 * OBS fica parada e pode aparecer como pronta. É só um aviso para não abrir um arquivo incompleto: o app pergunta, não bloqueia.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { readFolder } = require('./fsGuard');

const EXTENSIONS = Object.freeze(['.mp4', '.mkv', '.mov', '.flv', '.ts']);
const DEFAULTS = Object.freeze({ recentMs: 30000, quietMs: 8000, sampleMs: 1200, limit: 300, probeLimit: 40, probeTimeoutMs: 20000, probeConcurrency: 3, readdirTimeoutMs: 8000 });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Início da gravação a partir do nome padrão do OBS ("2026-10-21 03-12-45.mkv"); null se não seguir o padrão. */
function startedAtFromName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ _T-](\d{2})[-_.:](\d{2})[-_.:](\d{2})/.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(y, mo - 1, d, h, mi, s); // hora local, como o OBS grava
  return Number.isNaN(date.getTime()) ? null : date;
}

const durationCache = new Map(); // "caminho|tamanho|mtime" -> segundos (null = não deu para ler)

const cacheKey = (file, st) => `${file}|${st.size}|${Math.round(st.mtimeMs)}`;

/** Duração já conhecida (cache) ou undefined, sem executar nada. */
function peekDuration(file, st) {
  const key = cacheKey(file, st);
  return durationCache.has(key) ? durationCache.get(key) : undefined;
}

/** Duração (s) pelo ffprobe, em cache por arquivo+tamanho+data. null se não for possível ler. */
function probeDuration(ffprobe, file, st, timeoutMs = DEFAULTS.probeTimeoutMs) {
  const key = cacheKey(file, st);
  if (durationCache.has(key)) return Promise.resolve(durationCache.get(key));
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
          const value = err ? NaN : Number(String(stdout).trim().split(/\r?\n/)[0]);
          const seconds = Number.isFinite(value) && value >= 0 ? value : null;
          if (durationCache.size > 2000) durationCache.clear();
          durationCache.set(key, seconds);
          resolve(seconds);
        });
    } catch {
      resolve(null);
      return;
    }
    child.on('error', () => resolve(null));
  });
}

/** Executa `fn` sobre a lista com no máximo `limit` ao mesmo tempo. */
async function mapLimit(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

/**
 * @param {string} folder
 * @param {{ ffprobe?:string|null, now?:number, recentMs?:number, quietMs?:number, sampleMs?:number, limit?:number }} [opts]
 * @returns {Promise<{ folder, exists:boolean, files:Array, total:number, truncated:boolean, recording:number, error?:string }>}
 *   file: { name, path, size, mtimeMs, startedAt (ISO), durationSec|null, recording:boolean }
 */
async function listRecordings(folder, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const result = { folder, exists: false, files: [], total: 0, truncated: false, recording: 0 };
  // com prazo: uma pasta de rede fora do ar não pode deixar a aba "Procurando gravações…" por ~21 s
  const read = await readFolder(folder, { timeoutMs: o.readdirTimeoutMs });
  if (read.timedOut) {
    result.error = 'A pasta não respondeu a tempo (compartilhamento de rede fora do ar ou unidade desconectada?). Confira a conexão e use “Atualizar”.';
    return result;
  }
  if (read.error) {
    const err = read.error;
    result.error = err.code === 'ENOENT'
      ? 'A pasta não existe (foi apagada ou está em uma unidade desconectada).'
      : `Não foi possível ler a pasta (${err.code || err.message}). Verifique a permissão de acesso.`;
    return result;
  }
  const entries = read.entries;
  result.exists = true;

  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
    const file = path.join(folder, entry.name);
    try {
      const st = await fs.promises.stat(file);
      found.push({ name: entry.name, path: file, size: st.size, mtimeMs: st.mtimeMs, started: startedAtFromName(entry.name) });
    } catch { /* sumiu enquanto listava */ }
  }
  const stamp = (f) => (f.started ? f.started.getTime() : f.mtimeMs);
  found.sort((a, b) => stamp(b) - stamp(a) || b.mtimeMs - a.mtimeMs);
  result.total = found.length;
  result.truncated = found.length > o.limit;
  const files = found.slice(0, o.limit);

  // 1) candidatos a "em gravação": modificados há pouco tempo
  const now = o.now !== undefined ? o.now : Date.now();
  const candidates = files.filter((f) => now - f.mtimeMs < o.recentMs);
  const firstSample = new Map(candidates.map((f) => [f.path, { size: f.size, mtimeMs: f.mtimeMs }]));
  if (candidates.length) await sleep(o.sampleMs);
  const recordingSet = new Set();
  for (const f of candidates) {
    let second;
    try { second = await fs.promises.stat(f.path); } catch { continue; }
    const before = firstSample.get(f.path);
    const changed = second.size !== before.size || second.mtimeMs !== before.mtimeMs;
    const stillFresh = Date.now() - second.mtimeMs < o.quietMs;
    if (changed || stillFresh) recordingSet.add(f.path);
    f.size = second.size;
    f.mtimeMs = second.mtimeMs;
  }

  // 2) duração (arquivos em gravação ficam sem duração: o número ainda vai mudar)
  // só as mais recentes são lidas na hora (uma pasta com centenas de gravações demoraria); as demais vêm como
  // "pendentes" e a interface pede a duração delas quando o usuário abre a lista toda (probeFiles).
  await mapLimit(files, o.probeConcurrency, async (f, index) => {
    f.recording = recordingSet.has(f.path);
    f.durationPending = false;
    if (f.recording || !o.ffprobe) { f.durationSec = null; return; }
    const st = { size: f.size, mtimeMs: f.mtimeMs };
    const cached = peekDuration(f.path, st);
    if (cached !== undefined) f.durationSec = cached;
    else if (index < o.probeLimit) f.durationSec = await probeDuration(o.ffprobe, f.path, st, o.probeTimeoutMs);
    else { f.durationSec = null; f.durationPending = true; }
  });

  result.files = files.map((f) => ({
    name: f.name,
    path: f.path,
    size: f.size,
    mtimeMs: f.mtimeMs,
    startedAt: new Date(stamp(f)).toISOString(),
    durationSec: f.durationSec,
    durationPending: f.durationPending,
    recording: f.recording
  }));
  result.recording = recordingSet.size;
  return result;
}

/**
 * Durações de vários arquivos de vídeo (até 60 por chamada), para completar uma lista que veio com "pendentes".
 * @returns {Promise<Object<string, number|null>>} caminho -> segundos (null = não deu para ler)
 */
async function probeFiles(ffprobe, paths, { concurrency = DEFAULTS.probeConcurrency, timeoutMs = DEFAULTS.probeTimeoutMs } = {}) {
  const out = {};
  const wanted = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && EXTENSIONS.includes(path.extname(p).toLowerCase())).slice(0, 60);
  await mapLimit(wanted, concurrency, async (file) => {
    let st;
    try { st = await fs.promises.stat(file); } catch { out[file] = null; return; }
    if (!st.isFile()) { out[file] = null; return; }
    out[file] = ffprobe ? await probeDuration(ffprobe, file, { size: st.size, mtimeMs: st.mtimeMs }, timeoutMs) : null;
  });
  return out;
}

module.exports = { EXTENSIONS, DEFAULTS, startedAtFromName, probeDuration, peekDuration, probeFiles, listRecordings };
