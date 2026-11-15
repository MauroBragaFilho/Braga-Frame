'use strict';

/**
 * Codificadores de vídeo: argumentos do ffmpeg para H.264/H.265 por software (libx264/libx265) ou
 * pela GPU NVIDIA (h264_nvenc/hevc_nvenc), e detecção REAL do NVENC (um mini-encode de 1 quadro),
 * com o resultado guardado por 24 horas.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Uma consulta que FALHOU (arquivo bloqueado pelo antivírus, tempo esgotado…) só vale por poucos segundos e nunca vai para o disco. */
const NEGATIVE_TTL_MS = 10 * 1000;
const CACHE_FILE = 'encoders.json';
const PROBE_TIMEOUT_MS = 25000;

const SOFTWARE = Object.freeze({ h264: 'libx264', h265: 'libx265' });
const NVENC = Object.freeze({ h264: 'h264_nvenc', h265: 'hevc_nvenc' });

/** Nome do codificador do ffmpeg para o codec e o tipo (`software` ou `nvenc`). */
function encoderName(codec, kind) {
  return (kind === 'nvenc' ? NVENC : SOFTWARE)[codec];
}

/**
 * Argumentos de vídeo para um bitrate alvo: -b:v com teto (-maxrate) e janela (-bufsize), yuv420p,
 * tag hvc1 no H.265 (Apple/QuickTime e vários players só abrem MP4 HEVC com ela).
 * @param {{codec:'h264'|'h265', kind:'software'|'nvenc', bitrateKbps:number}} opts
 */
function buildEncoderArgs({ codec, kind, bitrateKbps }) {
  const name = encoderName(codec, kind);
  if (!name) throw new Error(`Codec desconhecido: ${codec}`);
  const target = Math.round(bitrateKbps);
  const rate = ['-b:v', `${target}k`, '-maxrate', `${Math.round(target * 1.2)}k`, '-bufsize', `${target * 2}k`];
  const args = ['-c:v', name];
  if (kind === 'nvenc') {
    // sem -spatial_aq: o ffmpeg novo (9.x) só aceita `-spatial-aq` e o antigo só `-spatial_aq`, e uma opção desconhecida derruba TODA exportação pela
    // placa (cai para software); o ganho dessa opção é pequeno e não vale a incompatibilidade
    args.push('-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', ...rate);
    if (codec === 'h264') args.push('-profile:v', 'high');
  } else if (codec === 'h264') {
    args.push('-preset', 'medium', ...rate, '-profile:v', 'high');
  } else {
    args.push('-preset', 'medium', ...rate, '-x265-params', 'log-level=error');
  }
  args.push('-pix_fmt', 'yuv420p');
  if (codec === 'h265') args.push('-tag:v', 'hvc1');
  return args;
}

// ---------- detecção ----------

let cacheDir = null;
const memory = new Map(); // chave do ffmpeg -> resultado
const inflight = new Map();
const listings = new Map(); // chave -> Set de codificadores do `ffmpeg -encoders` (só listagens que deram certo)
const failedListings = new Map(); // chave -> { until }: listagem que falhou, não repetida por alguns segundos
const negatives = new Map(); // chave -> { result, until }: detecção feita SEM a lista de codificadores (não vai para o disco)

/** Pasta onde o resultado da detecção é guardado (userData/cache). Sem isso, só vale na memória. */
function configure({ cacheDir: dir } = {}) {
  cacheDir = dir || null;
}

function clearMemory() {
  memory.clear();
  listings.clear();
  failedListings.clear();
  negatives.clear();
}

/** Esquece só a memória (o arquivo em disco continua valendo). Usado em testes. */
function forgetMemory() {
  clearMemory();
}

/** Esquece o que estava guardado (memória e arquivo). */
function resetCache() {
  clearMemory();
  if (cacheDir) {
    try { fs.rmSync(path.join(cacheDir, CACHE_FILE), { force: true }); } catch { /* sem arquivo */ }
  }
}

function keyFor(ffmpeg) {
  let size = 0;
  let mtime = 0;
  try {
    const st = fs.statSync(ffmpeg);
    size = st.size;
    mtime = Math.round(st.mtimeMs);
  } catch { /* ffmpeg sumiu: a chave muda e a detecção refaz */ }
  return `${ffmpeg}|${size}|${mtime}`;
}

function readDisk() {
  if (!cacheDir) return {};
  try {
    const data = JSON.parse(fs.readFileSync(path.join(cacheDir, CACHE_FILE), 'utf8'));
    return data && typeof data === 'object' && data.entries && typeof data.entries === 'object' ? data.entries : {};
  } catch {
    return {};
  }
}

function writeDisk(key, result) {
  if (!cacheDir) return;
  try {
    const entries = readDisk();
    entries[key] = result;
    // guarda no máximo as últimas 5 entradas (trocar de ffmpeg não faz o arquivo crescer)
    const keys = Object.keys(entries).sort((a, b) => Date.parse(entries[b].checkedAt) - Date.parse(entries[a].checkedAt)).slice(0, 5);
    const trimmed = Object.fromEntries(keys.map((k) => [k, entries[k]]));
    fs.mkdirSync(cacheDir, { recursive: true });
    const file = path.join(cacheDir, CACHE_FILE);
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: trimmed }, null, 2));
    fs.renameSync(tmp, file);
  } catch { /* cache é só otimização */ }
}

/**
 * Um resultado SEM nenhum codificador (nem libx264/libx265 nem NVENC) não é confiável como cache: pode ter vindo de uma consulta que falhou
 * (versões antigas guardavam isso por 24 h) e um FFmpeg que de fato não codifica nada não perde nada em ser conferido de novo.
 */
const plausible = (r) => Boolean(r && r.software && r.nvenc
  && (r.software.h264 || r.software.h265 || (r.nvenc.h264 && r.nvenc.h264.available) || (r.nvenc.h265 && r.nvenc.h265.available)));
const fresh = (r, now) => plausible(r) && Number.isFinite(Date.parse(r.checkedAt)) && now - Date.parse(r.checkedAt) < CACHE_TTL_MS;

/** Resultado guardado e ainda válido (24 h) para esse ffmpeg, ou null. Não executa nada. */
function getCachedEncoders(ffmpeg, now = Date.now()) {
  if (!ffmpeg) return null;
  const key = keyFor(ffmpeg);
  const mem = memory.get(key);
  if (fresh(mem, now)) return mem;
  const disk = readDisk()[key];
  if (fresh(disk, now)) {
    memory.set(key, disk);
    return disk;
  }
  return null;
}

/** Roda `ffmpeg -encoders`. `ok` só é verdadeiro se o programa respondeu e a lista tem ao menos um codificador de vídeo. */
function readEncoderList(ffmpeg) {
  const names = new Set();
  try {
    const out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*V\S*\s+(\S+)/.exec(line);
      if (m) names.add(m[1]);
    }
  } catch { /* sem lista */ }
  return { names, ok: names.size > 0 };
}

/**
 * Lista de codificadores de vídeo do ffmpeg (`ffmpeg -encoders`). Só uma listagem que DEU CERTO fica guardada
 * (por ffmpeg); uma falha momentânea (tempo esgotado, arquivo bloqueado) devolve `ok: false`, vale por poucos
 * segundos e nunca é tomada como "este ffmpeg não tem codificador nenhum".
 * @returns {{names:Set<string>, ok:boolean}}
 */
function encoderListing(ffmpeg, now = Date.now) {
  const key = keyFor(ffmpeg);
  if (listings.has(key)) return { names: listings.get(key), ok: true };
  const failure = failedListings.get(key);
  if (failure && now() < failure.until) return { names: new Set(), ok: false };
  const read = readEncoderList(ffmpeg);
  if (read.ok) {
    listings.set(key, read.names);
    failedListings.delete(key);
  } else {
    failedListings.set(key, { until: now() + NEGATIVE_TTL_MS });
  }
  return read;
}

/** Conjunto de codificadores de vídeo do ffmpeg (vazio se a consulta falhou; use `encoderListing` para saber se falhou). */
function listFfmpegEncoders(ffmpeg) {
  return encoderListing(ffmpeg).names;
}

// ---------- motivos em português ----------

/**
 * Motivo curto, em português, para um codificador que não iniciou (cabe em "… indisponível (motivo)"). O texto cru do ffmpeg
 * (inglês, com endereços de memória como "[out#0/null @ 0000…]") nunca vai para a tela: fica só em `detail`.
 * `job: true` = a falha veio de uma exportação de verdade (não do mini-encode de teste).
 */
function describeEncoderFailure(stderr, { encoder = '', job = false } = {}) {
  const text = String(stderr || '');
  const hardware = /nvenc/i.test(encoder) || !encoder;
  const subject = hardware ? 'a placa' : `o codificador ${encoder}`;
  if (/Unknown encoder|Encoder .* not found|Error selecting an encoder/i.test(text)) return `este FFmpeg não tem o codificador ${encoder || 'pedido'}`;
  if (/Cannot load (?:nvcuda|libcuda|nvEncodeAPI|libnvidia-encode)|minimum required Nvidia driver|does not support the required nvenc API version|CUDA_ERROR_NO_DEVICE|no CUDA-capable device|Failed loading nvcuvid/i.test(text)) {
    return 'o driver da placa NVIDIA não está instalado ou está desatualizado';
  }
  if (/out of memory|Cannot allocate memory|CUDA_ERROR_OUT_OF_MEMORY/i.test(text)) return `${subject} está sem memória livre ou no limite de exportações simultâneas`;
  if (/Frame Dimensions? (?:less|more) than|dimensions? (?:are|is) (?:less|more) than/i.test(text)) return `${subject} não aceita este tamanho de vídeo`;
  if (/No capable devices found/i.test(text)) {
    return job ? 'a placa NVIDIA não aceitou este corte, talvez porque a resolução passa do limite dela' : 'não foi encontrada uma placa NVIDIA compatível';
  }
  if (/OpenEncodeSessionEx failed|incompatible client key|unsupported device|InitializeEncoder failed/i.test(text)) return `${subject} recusou iniciar a codificação, por driver antigo ou limite de sessões`;
  return `${subject} não conseguiu iniciar a codificação`;
}

/** Última linha não vazia do texto, sem excesso: só para o `detail` técnico (nunca para a interface). */
function lastLine(text, max = 200) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, max);
}

/** Roda um mini-encode de 1 quadro com `encoderName`; resolve { ok } ou { ok:false, reason (português), detail (técnico) }. */
function tryEncode(ffmpeg, encoder, runner = execFile) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=5:d=1',
      '-frames:v', '1', '-c:v', encoder, '-b:v', '1M', '-pix_fmt', 'yuv420p', '-f', 'null', '-'];
    runner(ffmpeg, args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const text = String(stderr || err.message || '');
      let reason = describeEncoderFailure(text, { encoder });
      if (err.killed) reason = 'o teste demorou demais para responder e foi interrompido';
      else if (err.code === 'ENOENT' || err.code === 'EACCES') reason = 'não foi possível executar o FFmpeg';
      resolve({ ok: false, reason, detail: lastLine(text) || 'o codificador não iniciou' });
    });
  });
}

/**
 * Detecta o que o ffmpeg consegue fazer: software (libx264/libx265 compilados) e NVENC de verdade
 * (mini-encode de 1 quadro). O resultado fica 24 h em memória e em `<cache>/encoders.json`.
 *
 * @returns {Promise<{ffmpeg:string, checkedAt:string, cached:boolean,
 *   software:{h264:boolean,h265:boolean}, nvenc:{h264:{available:boolean,reason?:string}, h265:{available:boolean,reason?:string}}}>}
 */
async function detectEncoders({ ffmpeg, force = false, now = Date.now, runner } = {}) {
  if (!ffmpeg) {
    const none = { available: false, reason: 'ffmpeg não encontrado' };
    return { ffmpeg: null, checkedAt: new Date(now()).toISOString(), cached: false, software: { h264: false, h265: false }, nvenc: { h264: none, h265: none } };
  }
  const key = keyFor(ffmpeg);
  if (force) {
    // "Testar a placa de novo": esquece tudo, inclusive a lista de codificadores e as falhas recentes
    listings.delete(key);
    failedListings.delete(key);
    negatives.delete(key);
  } else {
    const hit = getCachedEncoders(ffmpeg, now());
    if (hit) return { ...hit, cached: true };
    const negative = negatives.get(key);
    if (negative && now() < negative.until) return { ...negative.result, cached: true };
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const listing = encoderListing(ffmpeg, now);
    // sem a lista (consulta falhou), cada codificador é conferido por um mini-encode de verdade: a resposta continua verdadeira
    const software = async (codec) => (listing.ok ? listing.names.has(SOFTWARE[codec]) : (await tryEncode(ffmpeg, SOFTWARE[codec], runner)).ok);
    const probe = async (codec) => {
      const name = NVENC[codec];
      if (listing.ok && !listing.names.has(name)) return { available: false, reason: 'este FFmpeg não foi compilado com NVENC' };
      const res = await tryEncode(ffmpeg, name, runner);
      return res.ok ? { available: true } : { available: false, reason: res.reason, detail: res.detail };
    };
    const [sw264, sw265, h264, h265] = await Promise.all([software('h264'), software('h265'), probe('h264'), probe('h265')]);
    const result = {
      ffmpeg,
      checkedAt: new Date(now()).toISOString(),
      cached: false,
      software: { h264: sw264, h265: sw265 },
      nvenc: { h264, h265 }
    };
    if (listing.ok) {
      memory.set(key, result);
      writeDisk(key, result);
    } else {
      // resultado montado sem a lista: pode estar incompleto por uma falha momentânea, então só vale por alguns segundos e não vai para o disco
      negatives.set(key, { result, until: now() + NEGATIVE_TTL_MS });
    }
    return result;
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

/**
 * Escolhe o codificador para o perfil. `choice`: 'auto' | 'software' | 'nvenc'.
 * Devolve { kind:'software'|'nvenc', name, warning? }. `warning` ({code,message}) só existe quando o
 * usuário pediu NVENC e ele não está disponível (a exportação segue por software e avisa).
 * `kind: null` = nenhum codificador serve (codec não suportado por esse ffmpeg).
 */
function chooseEncoder(detection, codec, choice = 'auto') {
  const sw = Boolean(detection.software[codec]);
  const hw = Boolean(detection.nvenc[codec] && detection.nvenc[codec].available);
  if (choice === 'software') return sw ? { kind: 'software', name: SOFTWARE[codec] } : { kind: null, name: SOFTWARE[codec] };
  if (choice === 'nvenc' && !hw) {
    const reason = (detection.nvenc[codec] && detection.nvenc[codec].reason) || 'não disponível';
    const why = `A placa de vídeo (NVENC) não está disponível para ${codec === 'h265' ? 'H.265' : 'H.264'} (${reason})`;
    return sw
      ? { kind: 'software', name: SOFTWARE[codec], warning: { code: 'ENCODER_FALLBACK', message: `${why}; a exportação usou o codificador por software, que é mais lento.` } }
      : { kind: null, name: NVENC[codec] };
  }
  if (hw) return { kind: 'nvenc', name: NVENC[codec] };
  return sw ? { kind: 'software', name: SOFTWARE[codec] } : { kind: null, name: SOFTWARE[codec] };
}

module.exports = {
  CACHE_TTL_MS, NEGATIVE_TTL_MS, SOFTWARE, NVENC, encoderName, buildEncoderArgs, configure, resetCache, forgetMemory,
  getCachedEncoders, listFfmpegEncoders, encoderListing, detectEncoders, chooseEncoder, tryEncode, describeEncoderFailure
};
