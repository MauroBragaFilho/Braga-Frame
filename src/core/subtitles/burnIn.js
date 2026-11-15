'use strict';

/**
 * Legendas na exportação (contrato 3.3, dono: subtitles).
 *
 *   prepareBurnIn(cut, { tmpDir, width, height }) -> null | { vfFilter, sidecars:[{ path, ext }], warnings }
 *
 * Chamado pelo jobRunner do exportEngine, com o corte (snapshot do job) e o tamanho do quadro JÁ ENQUADRADO.
 *  - devolve `null` quando o corte não tem legenda a aplicar (desligada, sem falas visíveis);
 *  - `vfFilter`: filtro `subtitles` do libass, a ser acrescentado DEPOIS dos filtros de enquadramento (ou `null`
 *    se a entrega for só em arquivo separado). O ASS fica em `tmpDir` e já está no tamanho do quadro de saída;
 *  - `sidecars`: arquivos SRT/ASS criados em `tmpDir`; o jobRunner os grava ao lado do vídeo exportado como
 *    "<nome do vídeo>.<ext>", sem sobrescrever nada;
 *  - `warnings`: avisos curtos (não impeditivos) para o jobRunner repassar, se quiser;
 *  - lança SubtitlesError('BURNIN_UNSUPPORTED') quando a entrega pede legenda incorporada e este FFmpeg não tem
 *    o filtro de legendas (libass), com a explicação e a solução.
 *
 * É síncrono de propósito (o jobRunner pode chamar com ou sem `await`).
 * Tempos das falas: relativos ao início do corte (= início do vídeo exportado).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const shared = require('./shared');
const formats = require('./formats');
const { SubtitlesError } = require('./errors');
const { listFonts } = require('./fonts');
const { locateTools } = require('../ffmpeg/locate');

// ---------- suporte do FFmpeg ----------

const supportCache = new Map(); // "caminho|tamanho|mtime" -> resultado

const UNSUPPORTED_REASON = 'Este FFmpeg não tem o filtro de legendas (libass), então a legenda não pode ser incorporada ao vídeo. '
  + 'Instale uma versão completa do FFmpeg (a "full" para Windows em ffmpeg.org/download.html) ou escolha a entrega em arquivo separado (SRT/ASS).';

/**
 * Confere se o FFmpeg sabe incorporar legendas: precisa do filtro `subtitles` (libass).
 * @returns {{ supported:boolean, reason:string|null, ffmpeg:string|null }}
 */
function detectBurnInSupport(ffmpegPath) {
  const exe = ffmpegPath || locateTools().ffmpeg;
  if (!exe) {
    return { supported: false, reason: 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.', ffmpeg: null };
  }
  let key = exe;
  try { const st = fs.statSync(exe); key = `${exe}|${st.size}|${st.mtimeMs}`; } catch { /* sem cache confiável */ }
  if (supportCache.has(key)) return supportCache.get(key);
  let result;
  try {
    const out = execFileSync(exe, ['-hide_banner', '-filters'], { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024 });
    const has = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s+V->V`, 'm').test(out);
    const supported = has('subtitles');
    result = { supported, reason: supported ? null : UNSUPPORTED_REASON, ffmpeg: exe };
  } catch (err) {
    result = { supported: false, reason: `Não foi possível consultar o FFmpeg (${err.message}).`, ffmpeg: exe };
  }
  supportCache.set(key, result);
  return result;
}

// ---------- escape para o filtro ----------

/**
 * Escapa um valor (caminho) para uso em `-vf`, nos dois níveis do FFmpeg (opção do filtro e descrição do grafo,
 * veja "Notes on filtergraph escaping" na documentação). Os separadores do Windows viram "/" (aceitos por tudo).
 * Cobre dois-pontos da unidade ("C:"), aspas simples, vírgula, ponto e vírgula, colchetes e barra invertida.
 */
function escapeFilterValue(value) {
  const unix = String(value).replace(/\\/g, '/');
  const level1 = unix.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
  return level1.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[[\],;]/g, (c) => `\\${c}`);
}

/** Pasta de fontes do sistema (Windows), se existir; o libass a escaneia para achar a fonte pedida. */
function systemFontsDir() {
  if (process.platform !== 'win32') return null;
  const dir = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
  return fs.existsSync(dir) ? dir : null;
}

/** Filtro `subtitles` para um arquivo ASS já escrito. */
function subtitlesFilter(assPath, { fontsDir = systemFontsDir() } = {}) {
  const parts = [`filename=${escapeFilterValue(assPath)}`];
  if (fontsDir) parts.push(`fontsdir=${escapeFilterValue(fontsDir)}`);
  return `subtitles=${parts.join(':')}`;
}

// ---------- avisos ----------

const EMPTY_WARNING = 'A legenda está ligada, mas nenhuma fala aparece neste corte: o vídeo sai sem legenda. Gere ou escreva as falas na aba Legendas, ou desligue a legenda deste corte.';

/**
 * Avisos (não impeditivos) sobre as legendas de um corte; usado por prepareBurnIn e oferecido ao QC da exportação.
 * `fonts` (padrão: as do computador) existe para os testes.
 */
function subtitleWarnings(cut, { fonts = null } = {}) {
  const warnings = [];
  const sub = cut && cut.subtitles;
  if (!sub || sub.enabled !== true) return warnings;
  // as falas já acompanhando o intervalo atual do corte (mesma regra do export)
  const cues = shared.cleanCues(shared.rebaseSubtitles(sub, cut).subtitles.cues);
  const duration = Math.max(0, Number(cut.end) - Number(cut.start));
  // Ligada, mas sem nenhuma fala para mostrar (lista vazia ou tudo fora do corte): prepareBurnIn devolve null e o vídeo sai
  // sem legenda. Não é erro (não bloqueia), mas quem ligou a legenda precisa saber.
  if (!shared.visibleCues(sub, cut).length) warnings.push(EMPTY_WARNING);
  const review = cues.filter((c) => c.needsReview && shared.rangeState(c, duration) !== 'outside').length;
  if (review > 0) warnings.push(`${review} fala(s) da legenda ainda estão marcadas para revisão.`);
  const outside = cues.filter((c) => shared.rangeState(c, duration) === 'outside').length;
  if (outside > 0) warnings.push(`${outside} fala(s) da legenda ficaram fora do corte e não entram no vídeo.`);
  const family = shared.normalizeStyle(sub.style).fontFamily;
  const known = (fonts || listFonts()).find((f) => f.name === family);
  if (known && !known.available) warnings.push(`A fonte "${family}" não foi encontrada neste computador; o FFmpeg vai usar outra no lugar.`);
  return warnings;
}

// ---------- principal ----------

/**
 * @param {object} cut  corte (normalizado) com `subtitles`
 * @param {{ tmpDir:string, width:number, height:number, ffmpegPath?:string, support?:object, fontsDir?:string|null }} opts
 *   support: resultado de detectBurnInSupport já conhecido (a interface e os testes injetam); fontsDir: padrão = fontes do Windows
 */
function prepareBurnIn(cut, opts = {}) {
  const sub = cut && cut.subtitles;
  if (!sub || typeof sub !== 'object' || sub.enabled !== true) return null;

  const cues = shared.visibleCues(sub, cut);
  if (!cues.length) return null;

  const width = Math.round(Number(opts.width));
  const height = Math.round(Number(opts.height));
  if (!(width >= 16) || !(height >= 16)) {
    throw new SubtitlesError('INVALID_SIZE', 'Tamanho do vídeo de saída inválido para aplicar as legendas.', { width: opts.width, height: opts.height });
  }
  if (!opts.tmpDir) throw new SubtitlesError('NO_TMPDIR', 'Faltou a pasta temporária para preparar as legendas.');

  const mode = shared.normalizeMode(sub.mode);
  const wantBurn = mode === 'burn' || mode === 'both';
  const wantSidecar = mode === 'sidecar' || mode === 'both';
  const style = shared.normalizeStyle(sub.style);
  const warnings = subtitleWarnings(cut);

  if (wantBurn) {
    const support = opts.support || detectBurnInSupport(opts.ffmpegPath);
    if (!support.supported) throw new SubtitlesError('BURNIN_UNSUPPORTED', support.reason || UNSUPPORTED_REASON);
  }

  fs.mkdirSync(opts.tmpDir, { recursive: true });
  const result = { vfFilter: null, sidecars: [], warnings };

  if (wantBurn) {
    const assPath = path.join(opts.tmpDir, 'legenda.ass');
    fs.writeFileSync(assPath, formats.cuesToAss(cues, style, { width, height, title: cut.title || 'Corte' }), 'utf8');
    result.vfFilter = subtitlesFilter(assPath, { fontsDir: opts.fontsDir === undefined ? systemFontsDir() : opts.fontsDir });
  }

  if (wantSidecar) {
    const ext = shared.sidecarFormatOf(sub);
    const file = path.join(opts.tmpDir, `legenda-arquivo.${ext}`);
    const text = ext === 'ass'
      ? formats.cuesToAss(cues, style, { width, height, title: cut.title || 'Corte' })
      : formats.cuesToSrt(cues, { maxChars: style.maxCharsPerLine });
    fs.writeFileSync(file, text, 'utf8');
    result.sidecars.push({ path: file, ext });
  }
  return result;
}

module.exports = {
  prepareBurnIn, detectBurnInSupport, subtitleWarnings, subtitlesFilter, escapeFilterValue, systemFontsDir,
  SubtitlesError, UNSUPPORTED_REASON, EMPTY_WARNING
};
