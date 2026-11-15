'use strict';

/**
 * Correspondência entre um vídeo que está sendo aberto e as lives já analisadas (dono: prefs).
 * Funções puras sobre os resumos de `projectStore.list()`. Níveis:
 *
 *  - strong (forte): mesmo código de vídeo (origin.videoId ou o endereço do YouTube/Twitch) ou mesmo endereço;
 *  - medium (média): mesmo canal + título normalizado parecido + duração parecida;
 *  - weak (fraca): pelo menos DOIS sinais entre nome do arquivo, tamanho e duração parecidos.
 *
 * Proteções contra falsos positivos: códigos de vídeo diferentes excluem a correspondência (o mesmo
 * canal repete título e duração todo dia); datas de publicação diferentes e canais diferentes também;
 * números diferentes no título ("#12" x "#13") derrubam a semelhança; nomes genéricos ("video.mp4")
 * não contam como sinal. Só projetos com cortes entram (uma live "já analisada" tem trabalho salvo).
 */

const path = require('node:path');
const { normName } = require('../preferences/scope');
const { fmtDuration, fmtBytes } = require('../preferences/format');
const { knownDuration } = require('./compare');

const LEVEL_RANK = Object.freeze({ strong: 3, medium: 2, weak: 1, none: 0 });
const MEDIUM_TITLE_SIMILARITY = 0.8;
const GENERIC_NAME_RE = /^(video|gravacao|recording|output|untitled|sem titulo|novo|new|clip|gameplay|live|stream|replay|captura|capture|obs|teste|test|final|arquivo|file)( \d+)?$/;

const PLATFORM_NAMES = { youtube: 'YouTube', twitch: 'Twitch' };

function samePath(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(String(p));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return norm(a) === norm(b);
}

/** Nome do arquivo sem pasta e sem extensão (aceita "\" e "/"). */
function baseName(file) {
  const name = String(file || '').split(/[\\/]/).pop() || '';
  return name.replace(/\.[^.]+$/, '');
}

const words = (text) => normName(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Título sem acento, caixa ou pontuação ("Live: Ranked!" -> "live ranked"). */
function normalizeTitle(title) {
  return words(title);
}

function tokens(title) {
  return normalizeTitle(title).split(' ').filter(Boolean);
}

/**
 * Semelhança 0..1 entre dois títulos (coeficiente de Dice sobre as palavras). Títulos iguais depois de
 * normalizados valem 1; se os NÚMEROS diferem (episódio, data) a semelhança não passa de 0,5.
 */
function titleSimilarity(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (A.join(' ') === B.join(' ')) return 1;
  const setA = new Set(A);
  const setB = new Set(B);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const dice = (2 * inter) / (setA.size + setB.size);
  const nums = (set) => [...set].filter((t) => /^\d+$/.test(t)).sort().join(',');
  return nums(setA) === nums(setB) ? dice : Math.min(dice, 0.5);
}

/** Código do vídeo a partir de um endereço do YouTube ou da Twitch: { platform, id } ou null. */
function parseVideoUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^(www|m|player|gaming)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return parts[0] ? { platform: 'youtube', id: parts[0] } : null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.searchParams.get('v')) return { platform: 'youtube', id: url.searchParams.get('v') };
    if (['live', 'shorts', 'embed', 'v'].includes(parts[0]) && parts[1]) return { platform: 'youtube', id: parts[1] };
    return null;
  }
  if (host === 'twitch.tv') {
    const vIndex = parts.indexOf('videos');
    if (vIndex >= 0 && parts[vIndex + 1]) return { platform: 'twitch', id: parts[vIndex + 1] };
    const legacy = parts.indexOf('v');
    if (legacy >= 0 && parts[legacy + 1]) return { platform: 'twitch', id: parts[legacy + 1] };
    if (url.searchParams.get('video')) return { platform: 'twitch', id: url.searchParams.get('video') };
  }
  return null;
}

/** Referência do vídeo de origem: { platform|null, id } a partir de origin.videoId e/ou origin.url. */
function videoRef(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const fromUrl = parseVideoUrl(origin.url);
  let id = origin.videoId !== undefined && origin.videoId !== null ? String(origin.videoId).trim() : '';
  let platform = typeof origin.platform === 'string' && origin.platform ? origin.platform.toLowerCase() : null;
  if (!id && fromUrl) id = fromUrl.id;
  if (!platform && fromUrl) platform = fromUrl.platform;
  if (!id) return null;
  if (platform === 'twitch' || (!platform && /^v\d+$/.test(id))) id = id.replace(/^v(?=\d+$)/i, '');
  return { platform, id };
}

function sameUrl(a, b) {
  const clean = (u) => (typeof u === 'string' ? u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[#?].*$/, '').replace(/\/+$/, '') : '');
  const ca = clean(a);
  return Boolean(ca) && ca === clean(b);
}

const channelOf = (summaryOrIncoming) => normName(
  (summaryOrIncoming.origin && summaryOrIncoming.origin.channel) || (summaryOrIncoming.meta && summaryOrIncoming.meta.channel) || ''
);

const titleOf = (origin) => (origin && typeof origin.title === 'string' ? origin.title : '');

function genericName(key) {
  return key.length < 4 || GENERIC_NAME_RE.test(key);
}

/** Nome para a pergunta: título de origem ou nome do arquivo. */
function liveLabel(summary) {
  const title = titleOf(summary.source && summary.source.origin).trim();
  return title || baseName(summary.source && summary.source.path) || 'live sem nome';
}

/**
 * Compara o vídeo que está sendo aberto com UM projeto salvo.
 * `incoming`: { path, size, duration, origin, meta? }; `summary`: item de projectStore.list().
 * Devolve { level, score, reasons } (level 'none' = sem correspondência; `excluded` = descartado de propósito).
 */
function matchOne(incoming, summary) {
  const none = (excluded = false) => ({ level: 'none', score: 0, reasons: [], excluded });
  const src = summary.source || {};
  if (!summary.cutCount) return none();
  if (incoming.path && src.path && samePath(incoming.path, src.path)) return none();

  const refIn = videoRef(incoming.origin);
  const refOld = videoRef(src.origin);
  if (refIn && refOld) {
    const platformsCompatible = !refIn.platform || !refOld.platform || refIn.platform === refOld.platform;
    if (platformsCompatible && refIn.id === refOld.id) {
      const platform = refIn.platform || refOld.platform;
      const name = platform ? PLATFORM_NAMES[platform] || platform : null;
      return { level: 'strong', score: 1000, reasons: [name ? `mesmo vídeo do ${name} (código ${refIn.id})` : `mesmo código de vídeo (${refIn.id})`], excluded: false };
    }
    if (platformsCompatible && refIn.id !== refOld.id) return none(true); // vídeos diferentes da mesma plataforma
  }
  if (sameUrl(incoming.origin && incoming.origin.url, src.origin && src.origin.url)) {
    return { level: 'strong', score: 1000, reasons: ['mesmo endereço do vídeo'], excluded: false };
  }

  const dateIn = String((incoming.origin && incoming.origin.uploadDate) || '').slice(0, 10);
  const dateOld = String((src.origin && src.origin.uploadDate) || '').slice(0, 10);
  if (dateIn && dateOld && dateIn !== dateOld) return none(true);
  const chIn = channelOf({ origin: incoming.origin, meta: incoming.meta });
  const chOld = channelOf({ origin: src.origin, meta: summary.meta });
  if (chIn && chOld && chIn !== chOld) return none(true);

  const durIn = knownDuration(incoming);
  const durOld = knownDuration(src);

  // média: canal + título + duração
  const titleIn = titleOf(incoming.origin);
  const titleOld = titleOf(src.origin);
  if (chIn && chIn === chOld && titleIn && titleOld && durIn && durOld) {
    const sim = titleSimilarity(titleIn, titleOld);
    const tolerance = Math.max(30, 0.01 * Math.max(durIn, durOld));
    if (sim >= MEDIUM_TITLE_SIMILARITY && Math.abs(durIn - durOld) <= tolerance) {
      const channelName = (incoming.origin && incoming.origin.channel) || (incoming.meta && incoming.meta.channel) || (src.origin && src.origin.channel) || (summary.meta && summary.meta.channel) || '';
      return {
        level: 'medium',
        score: 500 + Math.round(sim * 100),
        reasons: [`mesmo canal (${channelName}), título ${sim === 1 ? 'igual' : 'parecido'} e duração parecida (${fmtDuration(durIn)} e ${fmtDuration(durOld)})`],
        excluded: false
      };
    }
  }

  // fraca: pelo menos dois sinais do arquivo
  const reasons = [];
  const nameIn = words(baseName(incoming.path));
  const nameOld = words(baseName(src.path));
  if (nameIn && nameIn === nameOld && !genericName(nameIn)) reasons.push('mesmo nome de arquivo');
  const sizeIn = Number(incoming.size) > 0 ? Number(incoming.size) : 0;
  const sizeOld = Number(src.size) > 0 ? Number(src.size) : 0;
  if (sizeIn && sizeOld && Math.abs(sizeIn - sizeOld) / Math.max(sizeIn, sizeOld) <= 0.001) reasons.push(`mesmo tamanho (${fmtBytes(sizeIn)})`);
  if (durIn && durOld && Math.abs(durIn - durOld) <= Math.max(1, 0.002 * Math.max(durIn, durOld))) reasons.push(`duração parecida (${fmtDuration(durIn)} e ${fmtDuration(durOld)})`);
  if (reasons.length >= 2) return { level: 'weak', score: 100 * reasons.length, reasons, excluded: false };
  return none();
}

/**
 * Todas as correspondências (nível != none), da melhor para a pior: nível, pontuação, mais cortes,
 * mais recente. Cada item: { level, score, reasons, label, cutCount, project: <resumo> }.
 */
function findMatches(incoming, summaries) {
  const out = [];
  for (const summary of Array.isArray(summaries) ? summaries : []) {
    const result = matchOne(incoming, summary);
    if (result.level === 'none') continue;
    out.push({ level: result.level, score: result.score, reasons: result.reasons, label: liveLabel(summary), cutCount: summary.cutCount, project: summary });
  }
  return out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]
    || b.score - a.score
    || b.cutCount - a.cutCount
    || String(b.project.updatedAt).localeCompare(String(a.project.updatedAt)));
}

module.exports = {
  LEVEL_RANK, MEDIUM_TITLE_SIMILARITY, normalizeTitle, titleSimilarity, parseVideoUrl, videoRef, baseName, liveLabel, matchOne, findMatches
};
