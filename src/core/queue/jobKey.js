'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const audioRules = require('../audio/audioFilter');
const subtitleRules = require('../subtitles/shared');

/**
 * Chave estável de um job (fonte + intervalo + perfil + enquadramento + áudio + legendas) e previsão do
 * arquivo de saída. A chave NÃO inclui a pasta de saída nem o nome do arquivo: o mesmo trabalho com outro
 * destino é decidido à parte (veja QueueManager, "pular concluído").
 *
 * Áudio e legendas entram pelo EFEITO no arquivo gerado (o mesmo filtro e os mesmos arquivos que o motor produz),
 * não pelos campos crus do corte: o histórico de ajustes, a pilha de "refazer" e valores que dão o mesmo resultado
 * (mudo com ganhos diferentes, fade acima do limite) não mudam a chave; já o formato do arquivo de legenda muda.
 */

/** Versão do formato da chave: mudar o que entra nela exige subir este número (as chaves antigas deixam de valer). */
const KEY_VERSION = 2;

const OUTPUT_EXT = 'mp4';
const CI = process.platform === 'win32' || process.platform === 'darwin';

/** Caminho absoluto normalizado para comparar (sem diferenciar maiúsculas onde o sistema não diferencia). */
function normPath(p) {
  const resolved = path.resolve(String(p));
  return CI ? resolved.toLowerCase() : resolved;
}

function samePath(a, b) {
  if (!a || !b) return false;
  return normPath(a) === normPath(b);
}

const round = (n, digits = 3) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);

/** JSON canônico: chaves em ordem alfabética, `undefined` ignorado. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Legendas que mudam o resultado: só contam se estiverem ligadas. Entram o modo normalizado (os nomes antigos
 * "srt"/"burn+ass"… valem o mesmo que o modo atual), o estilo completo, o texto/tempo dos trechos e, quando há
 * arquivo separado, o formato dele (SRT e ASS são arquivos diferentes).
 */
function subtitlesPart(subtitles) {
  if (!isObj(subtitles) || subtitles.enabled === false) return null;
  const cues = Array.isArray(subtitles.cues) ? subtitles.cues : [];
  const mode = subtitleRules.normalizeMode(subtitles.mode);
  const hasSidecar = mode === 'sidecar' || mode === 'both';
  return {
    mode,
    sidecar: hasSidecar ? subtitleRules.sidecarFormatOf(subtitles) : null,
    style: subtitleRules.normalizeStyle(subtitles.style),
    cues: cues.map((c) => [round(c && c.start), round(c && c.end), c && c.text])
  };
}

/**
 * Áudio pelo que o motor aplica: o texto do filtro `-af` (ou null = áudio original) para a duração do corte.
 * Histórico, "refazer" e qualquer campo extra ficam de fora; mudo domina o ganho e os fades; os limites (ganho,
 * fade até a metade do corte) já vêm aplicados.
 */
function audioPart(audio, duration) {
  return audioRules.buildAudioFilter(isObj(audio) ? audio : null, { duration }) || null;
}

/** Perfil sem os campos só de exibição. */
function profilePart(profile) {
  if (!isObj(profile)) return null;
  const { name, resolutionLabel, ...rest } = profile; // eslint-disable-line no-unused-vars
  return rest;
}

/** Texto canônico do que define o resultado do job. */
function keyMaterial(job) {
  const cut = isObj(job.cut) ? job.cut : {};
  const info = isObj(job.sourceInfo) ? job.sourceInfo : {};
  return {
    v: KEY_VERSION,
    source: { path: normPath(job.sourcePath), duration: round(info.duration), width: info.width ?? null, height: info.height ?? null },
    start: round(cut.start),
    end: round(cut.end),
    profile: profilePart(job.profile),
    framing: { job: job.framing ?? null, cut: cut.framing ?? null },
    audio: audioPart(cut.audio, Number(cut.end) - Number(cut.start)),
    subtitles: subtitlesPart(cut.subtitles)
  };
}

function jobKey(job) {
  return crypto.createHash('sha256').update(stableStringify(keyMaterial(job))).digest('hex').slice(0, 32);
}

/** Limpeza própria de nome de arquivo (reserva, usada se o módulo de nomes do exportador não estiver disponível). */
function safeBaseName(baseName) {
  const noControl = Array.from(String(baseName ?? ''), (ch) => (ch.charCodeAt(0) < 32 ? '_' : ch)).join('');
  return noControl.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim() || 'corte';
}

let exporterSanitizer = null;
/** A mesma limpeza que o exportador usa (src/core/export/naming.js), para a previsão bater com o arquivo real; sem ele, a reserva. */
function sanitizer() {
  if (exporterSanitizer) return exporterSanitizer;
  try {
    const mod = require('../export/naming');
    if (typeof mod.sanitizeFileName === 'function') exporterSanitizer = mod.sanitizeFileName;
  } catch { /* o módulo do exportador ainda não existe: usa a limpeza própria */ }
  return exporterSanitizer || safeBaseName;
}

/**
 * Arquivo que o job deve gerar se não houver conflito de nome: `<pasta>/<nome>.mp4` (o motor pode, no máximo, acrescentar " (2)").
 * O contêiner é sempre mp4, como no motor (jobRunner só grava .mp4): o `profile.container` vem de fora e nunca decide o caminho
 * (um valor com "../" faria a fila olhar ou apagar um `.part` fora da pasta de saída).
 */
function predictOutputPath(job) {
  return path.join(job.outputDir, `${sanitizer()(job.baseName)}.${OUTPUT_EXT}`);
}

module.exports = { jobKey, keyMaterial, stableStringify, predictOutputPath, safeBaseName, normPath, samePath, CASE_INSENSITIVE: CI, KEY_VERSION };
