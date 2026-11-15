'use strict';

/**
 * Descobre a pasta de gravação do OBS Studio lendo a configuração REAL do programa (dono: sources).
 *
 * Onde o OBS guarda as coisas (Windows: %APPDATA%\obs-studio):
 *   basic\profiles\<perfil>\basic.ini   um por perfil; [General] Name, [Output] Mode (Simple|Advanced) e os caminhos:
 *       modo simples  -> [SimpleOutput] FilePath
 *       modo avançado -> [AdvOut] RecType=Standard  -> RecFilePath
 *                        [AdvOut] RecType=FFmpeg    -> FFFilePath   (saída personalizada para arquivo)
 *   user.ini (OBS 31+) ou global.ini (antes)   [Basic] Profile=<nome>, ProfileDir=<pasta do perfil ativo>
 *
 * O OBS grava barras invertidas dobradas ("C:\\Users\\x\\Videos") e aceita "/" ("D:/REC/OBS"); o analisador abaixo
 * lê as duas formas (e também "\" simples, caso o arquivo tenha sido editado à mão). Só leitura: nunca altera o OBS.
 * Limites: o modo portátil do OBS (pasta "config" ao lado do programa) não é procurado; use a escolha manual.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkFolder } = require('./fsGuard');

const BOM = 0xFEFF;

/** Lê um .ini do OBS: { seção: { chave: valor } }. Aceita BOM, CRLF/LF, comentários (; e #) e "\\" dobrado. */
function parseIni(text) {
  const out = {};
  let section = null;
  const source = String(text || '');
  for (const rawLine of (source.charCodeAt(0) === BOM ? source.slice(1) : source).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      if (!Object.hasOwn(out, section)) out[section] = {};
      continue;
    }
    if (section === null) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[section][key] = value.replace(/\\\\/g, '\\'); // "\\" dobrado do OBS -> "\"
  }
  return out;
}

/** Pasta de configuração do OBS neste sistema (não confere se existe). */
function obsConfigDir(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const appData = env.APPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming') : null);
    return appData ? path.join(appData, 'obs-studio') : null;
  }
  const home = env.HOME || os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'obs-studio');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'obs-studio');
}

function readIni(file) {
  try { return parseIni(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Pasta de gravação de UM perfil (conteúdo do basic.ini já lido).
 * @returns {{ mode:'simple'|'advanced', key:string, folder:string|null, note?:string }}
 */
function recordingFolderOf(ini) {
  const out = (ini && ini.Output) || {};
  const mode = /^advanced$/i.test(String(out.Mode || '')) ? 'advanced' : 'simple';
  if (mode === 'simple') {
    const folder = ((ini && ini.SimpleOutput) || {}).FilePath || '';
    return { mode, key: 'SimpleOutput.FilePath', folder: folder || null };
  }
  const adv = (ini && ini.AdvOut) || {};
  if (/ffmpeg/i.test(String(adv.RecType || ''))) {
    const folder = adv.FFFilePath || '';
    const toFile = adv.FFOutputToFile === undefined || !/^false$/i.test(String(adv.FFOutputToFile));
    return {
      mode, key: 'AdvOut.FFFilePath', folder: toFile && folder ? folder : null,
      ...(toFile ? {} : { note: 'A saída personalizada deste perfil não grava em arquivo (envia para uma URL).' })
    };
  }
  const folder = adv.RecFilePath || '';
  return { mode, key: 'AdvOut.RecFilePath', folder: folder || null };
}

/** Perfil ativo: { name, dir } lendo user.ini (OBS 31+) e depois global.ini; null se não constar. */
function activeProfile(obsDir) {
  for (const file of ['user.ini', 'global.ini']) {
    const ini = readIni(path.join(obsDir, file));
    const basic = ini && ini.Basic;
    if (basic && (basic.ProfileDir || basic.Profile)) return { name: basic.Profile || basic.ProfileDir, dir: basic.ProfileDir || basic.Profile };
  }
  return null;
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Lê os perfis do OBS (só os .ini da configuração) e a pasta de gravação de cada um, SEM tocar nas pastas de gravação:
 * `exists` fica `null` ("não conferido"). É a parte rápida e segura, que não depende de disco de rede.
 * @returns {{ found:boolean, obsDir:string|null, reason?:string,
 *   active:{name,dir}|null, profiles:[{ name, dir, active, mode, key, folder, exists:null, note? }] }}
 */
function readObsConfig({ env = process.env, platform = process.platform, obsDir } = {}) {
  const base = obsDir || obsConfigDir(env, platform);
  if (!base) return { found: false, obsDir: null, reason: 'Não foi possível descobrir a pasta de configuração do OBS neste computador.', active: null, profiles: [] };
  const profilesDir = path.join(base, 'basic', 'profiles');
  let names = [];
  try { names = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { names = []; }
  if (!fs.existsSync(base) || names.length === 0) {
    return {
      found: false, obsDir: base,
      reason: `Não encontrei a configuração do OBS em ${base}. O OBS não está instalado, nunca foi aberto ou usa o modo portátil.`,
      active: null, profiles: []
    };
  }

  const active = activeProfile(base);
  const profiles = [];
  for (const dirName of names.sort((a, b) => a.localeCompare(b))) {
    const ini = readIni(path.join(profilesDir, dirName, 'basic.ini'));
    if (!ini) continue;
    const rec = recordingFolderOf(ini);
    const folder = rec.folder ? path.normalize(rec.folder) : null;
    const isActive = Boolean(active) && (samePath(path.join(profilesDir, dirName), path.join(profilesDir, active.dir)) || (!active.dir && active.name === dirName));
    profiles.push({
      name: (ini.General && ini.General.Name) || dirName,
      dir: dirName,
      active: isActive,
      mode: rec.mode,
      key: rec.key,
      folder,
      exists: null,
      ...(rec.note ? { note: rec.note } : {})
    });
  }
  // a pasta do perfil ativo vem primeiro; depois os outros em ordem alfabética
  profiles.sort((a, b) => Number(b.active) - Number(a.active));
  return { found: profiles.length > 0, obsDir: base, active, profiles, ...(profiles.length ? {} : { reason: 'Nenhum perfil do OBS pôde ser lido.' }) };
}

/**
 * Como readObsConfig, mas confere se cada pasta de gravação existe (de forma SÍNCRONA: pode congelar o processo ~21 s se
 * uma pasta for um compartilhamento de rede fora do ar). Fica para testes e scripts; o app usa detectObsAsync, e o gancho
 * de abertura usa `checkFolders:false`. `exists`: true | false.
 * @param {{ checkFolders?:boolean }} [opts] `checkFolders:false` = só lê a configuração (`exists: null`).
 */
function detectObs({ checkFolders = true, ...opts } = {}) {
  const found = readObsConfig(opts);
  if (!checkFolders) return found;
  for (const p of found.profiles) {
    p.exists = false;
    if (p.folder) { try { p.exists = fs.statSync(p.folder).isDirectory(); } catch { p.exists = false; } }
  }
  return found;
}

const UNREACHABLE = 'Não consegui acessar a pasta de gravação agora (compartilhamento de rede fora do ar, unidade desconectada ou sem permissão).';

/**
 * Como detectObs, sem nunca travar o app: confere as pastas em paralelo, de forma assíncrona e com prazo (fsGuard).
 * `exists`: true | false (não existe) | null (não consegui acessar a tempo); neste caso o perfil ganha uma `note` explicando.
 */
async function detectObsAsync({ timeoutMs, ...opts } = {}) {
  const found = readObsConfig(opts);
  await Promise.all(found.profiles.map(async (p) => {
    if (!p.folder) { p.exists = false; return; }
    const res = await checkFolder(p.folder, { timeoutMs });
    p.exists = res.exists;
    if (res.exists === null) p.note = p.note ? `${p.note} ${UNREACHABLE}` : UNREACHABLE;
  }));
  return found;
}

/** Pastas candidatas (sem repetir), na ordem de detectObs: [{ folder, profile, active, mode, exists }]. */
function candidateFolders(detected) {
  const seen = new Set();
  const out = [];
  for (const p of detected.profiles) {
    if (!p.folder) continue;
    const key = p.folder.toLowerCase();
    if (seen.has(key)) {
      const prev = out.find((o) => o.folder.toLowerCase() === key);
      if (prev && p.active) { prev.active = true; prev.profile = p.name; }
      continue;
    }
    seen.add(key);
    out.push({ folder: p.folder, profile: p.name, active: p.active, mode: p.mode, exists: p.exists });
  }
  return out;
}

module.exports = { parseIni, obsConfigDir, recordingFolderOf, activeProfile, readObsConfig, detectObs, detectObsAsync, candidateFolders };
