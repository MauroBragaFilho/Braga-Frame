'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Localiza programas de sistema: variável de ambiente (CORTE_FFMPEG, CORTE_YTDLP…) e depois o PATH.
 * O FFmpeg/ffprobe só vêm daqui (o projeto oficial não publica binários); as demais ferramentas
 * (yt-dlp, whisper, TwitchDownloaderCLI) só caem aqui quando o app não as instalou
 * (veja resolveTools em src/ipc/context.js).
 *
 * A procura é feita no próprio Node, varrendo as pastas do PATH com o sistema de arquivos. Não usa `where`/`which`:
 * o `where.exe` escreve na página de código OEM do Windows (pastas com acento, como "João" ou "Programação", viravam
 * texto corrompido e a ferramenta "sumia"), também procura primeiro na pasta atual do processo (um ffmpeg.exe falso
 * ali seria executado) e cada chamada custava de 0,2 a 1 s no processo principal.
 */

/** Valor da variável `name` em `env`, sem diferenciar maiúsculas (no Windows o PATH pode se chamar "Path"). */
function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const wanted = name.toLowerCase();
  const key = Object.keys(env).find((k) => k.toLowerCase() === wanted);
  return key === undefined ? undefined : env[key];
}

/** Pastas do PATH: absolutas, sem aspas, sem repetição. Entradas vazias ou relativas (a pasta atual) não valem. */
function pathDirs(env) {
  const dirs = [];
  const seen = new Set();
  for (const raw of String(envValue(env, 'PATH') || '').split(path.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1').trim();
    if (!dir || !path.isAbsolute(dir)) continue;
    const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    dirs.push(dir);
  }
  return dirs;
}

/** Extensões que o Windows executa sem digitar (PATHEXT); em outros sistemas, só o nome exato. */
function executableExts(env) {
  if (process.platform !== 'win32') return [''];
  const list = String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.trim()).filter((e) => e.startsWith('.'));
  return list.length ? list : ['.COM', '.EXE', '.BAT', '.CMD'];
}

/** true se `file` existe e não é pasta. Atalhos especiais do Windows (que o stat recusa) valem se o lstat os enxerga. */
function isFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false }); // "não existe" é o caso comum no PATH: sem lançar erro (é bem mais rápido)
    return stat ? stat.isFile() : false;
  } catch {
    try { return !fs.lstatSync(file).isDirectory() && process.platform === 'win32'; } catch { return false; }
  }
}

/**
 * Nomes dentro de `dir` (minúsculas no Windows -> como estão gravados, o que também corrige o `.EXE` em maiúsculas do PATHEXT).
 * Uma listagem por pasta custa bem menos que um stat por candidato (a maioria não existe). null = pasta que não existe ou
 * não é pasta (pula); undefined = não deu para listar (sem permissão): quem chama confere os candidatos um a um.
 */
function listDir(dir) {
  try {
    const map = new Map();
    for (const entry of fs.readdirSync(dir)) map.set(process.platform === 'win32' ? entry.toLowerCase() : entry, entry);
    return map;
  } catch (err) {
    return err && (err.code === 'ENOENT' || err.code === 'ENOTDIR') ? null : undefined;
  }
}

/** Candidatos de `name` dentro de uma pasta, na ordem em que o sistema os tentaria. */
function candidateNames(name, exts) {
  if (process.platform !== 'win32') return [name];
  const hasExt = exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase()));
  return hasExt ? [name] : exts.map((e) => name + e);
}

/**
 * Procura vários programas de uma vez, numa única varredura do PATH.
 * @param {Array<{key:string, name:string, envVar?:string}>} specs `key` identifica o resultado; `name` é o programa no PATH
 *   (ex.: "ffmpeg"); `envVar` (ex.: "CORTE_FFMPEG") pode apontar direto para o executável e vale antes do PATH
 *   (precisa ser um arquivo; pasta não conta).
 * @param {object} [env] ambiente consultado (padrão: process.env)
 * @returns {Object<string,string|null>} `key` -> caminho completo ou null
 */
function findTools(specs, env = process.env) {
  const out = {};
  const pending = [];
  for (const spec of specs) {
    const fromEnv = spec.envVar ? envValue(env, spec.envVar) : undefined;
    if (fromEnv && isFile(fromEnv)) out[spec.key] = fromEnv;
    else { out[spec.key] = null; pending.push(spec); }
  }
  if (!pending.length) return out;
  const exts = executableExts(env);
  const names = new Map(pending.map((spec) => [spec.key, candidateNames(spec.name, exts)]));
  for (const dir of pathDirs(env)) {
    const entries = listDir(dir);
    if (entries === null) continue;
    for (const spec of pending) {
      if (out[spec.key]) continue;
      for (const candidate of names.get(spec.key)) {
        const actual = entries ? entries.get(process.platform === 'win32' ? candidate.toLowerCase() : candidate) : candidate;
        if (!actual) continue;
        const file = path.join(dir, actual);
        if (isFile(file)) { out[spec.key] = file; break; }
      }
    }
    if (pending.every((spec) => out[spec.key])) break;
  }
  return out;
}

/**
 * Localiza um programa de sistema: variável de ambiente (arquivo) e depois o PATH.
 * @param {string} name programa procurado no PATH (ex.: "ffmpeg")
 * @param {string} [envVar] variável que pode apontar direto para o executável (ex.: "CORTE_FFMPEG")
 * @param {object} [env] ambiente consultado (padrão: process.env)
 */
function findTool(name, envVar, env = process.env) {
  return findTools([{ key: 'tool', name, envVar }], env).tool;
}

function locateTools(env = process.env) {
  return findTools([
    { key: 'ffmpeg', name: 'ffmpeg', envVar: 'CORTE_FFMPEG' },
    { key: 'ffprobe', name: 'ffprobe', envVar: 'CORTE_FFPROBE' }
  ], env);
}

module.exports = { locateTools, findTool, findTools, pathDirs };
