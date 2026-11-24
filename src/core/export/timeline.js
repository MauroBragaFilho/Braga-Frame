'use strict';

/**
 * EXPORTAR PARA O EDITOR DE VÍDEO (DaVinci Resolve, Premiere): os cortes viram uma timeline que o editor abre, sem recodificar nada.
 *   - XML (Final Cut Pro 7, "xmeml" v4): o formato que o Premiere importa (Arquivo > Importar) e que o Resolve também aceita
 *     (Arquivo > Importar > Timeline). Cada corte é um clipe do vídeo original, com o título do corte como nome;
 *   - EDL (CMX 3600): mais simples e aceito pelos dois;
 *   - lista de tempos ("00:00:02.000 -> 00:00:10.500"): o formato da janela de cortes do Resolve Free;
 *   - legendas alinhadas à timeline em .srt (texto e tempo; os dois editores importam como faixa de legenda) e .ass (com o estilo).
 * O ESTILO da legenda não viaja no .srt nem no XML: fica no .ass e num JSON ao lado, para ser refeito no editor.
 * Funções puras (sem disco): quem grava é o canal IPC (src/ipc/handlers/timeline.js).
 */

const { exactFps } = require('../analysis/wordGrid');
const { cuesToSrt, cuesToAss } = require('../subtitles/formats');
const { normalizeStyle } = require('../subtitles/shared');

const DEFAULT_FPS = 30;

const round3 = (n) => Math.round(n * 1000) / 1000;
const pad = (n, w = 2) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

/** Escapa texto para dentro de um XML. Remove caracteres de controle, que o XML não aceita. */
function esc(value) {
  return String(value == null ? '' : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Quadro -> "HH:MM:SS:FF" (sem drop frame: o editor usa a base inteira, 30 para 29,97). */
function timecode(frame, base) {
  const f = Math.max(0, Math.round(frame));
  const b = Math.max(1, Math.round(base));
  const ff = f % b;
  const total = Math.floor(f / b);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}:${pad(ff)}`;
}

/** Segundos -> "HH:MM:SS.mmm" (a lista de tempos). */
function clockMs(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))}.${pad(ms % 1000, 3)}`;
}

/**
 * Planeja a timeline. `cuts`: cortes do projeto; `source`: { path, duration, fps, width, height, hasAudio }; `status`: 'approved' (padrão) ou
 * 'all' (tudo o que não foi rejeitado). Os clipes ficam na ordem do vídeo, um depois do outro, com início e fim em quadros inteiros.
 * Devolve { fps, base, ntsc, clips, totalFrames, skipped, warnings }.
 */
function planTimeline({ cuts, source, status = 'approved' }) {
  const warnings = [];
  let fps = exactFps(source && source.fps);
  if (!fps) { fps = DEFAULT_FPS; warnings.push(`Não sei os quadros por segundo do vídeo: usei ${DEFAULT_FPS}. Confira a taxa da sequência no editor.`); }
  const base = Math.round(fps);
  const ntsc = Math.abs(fps - base) > 0.01;
  const limit = Number(source && source.duration) > 0 ? Number(source.duration) : Infinity;
  const picked = (Array.isArray(cuts) ? cuts : [])
    .filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && (status === 'all' ? c.status !== 'rejected' : c.status === 'approved'))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const clips = [];
  let cursor = 0;
  let skipped = 0;
  picked.forEach((cut, i) => {
    const inFrame = Math.round(Math.max(0, cut.start) * fps);
    const outFrame = Math.round(Math.min(limit, cut.end) * fps);
    if (outFrame <= inFrame) { skipped += 1; return; }
    const length = outFrame - inFrame;
    clips.push({
      index: clips.length + 1, id: cut.id, title: String(cut.title || `Corte ${i + 1}`).trim() || `Corte ${i + 1}`,
      srcIn: inFrame, srcOut: outFrame, tlIn: cursor, tlOut: cursor + length, cut
    });
    cursor += length;
  });
  if (skipped) warnings.push(`${skipped} corte(s) ficaram de fora por terem duração zero depois de ajustar aos quadros.`);
  return { fps, base, ntsc, clips, totalFrames: cursor, skipped, warnings };
}

const baseName = (file) => String(file || '').split(/[\\/]/).pop() || 'video';

/** Caminho do arquivo no formato que o Premiere e o Resolve leem (file://localhost/D%3a/pasta/arquivo.mp4). */
function pathUrl(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(normalized);
  const encode = (s) => s.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
  if (drive) return `file://localhost/${drive[1]}%3a/${encode(normalized.slice(3))}`;
  return `file://localhost${normalized.startsWith('/') ? '' : '/'}${encode(normalized)}`;
}

/** XML do Final Cut Pro 7 (xmeml v4). */
function buildXml(plan, { name, source }) {
  const { base, ntsc, clips, totalFrames, fps } = plan;
  const rate = `<rate><timebase>${base}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const width = Math.max(16, Math.round(Number(source.width) || 1920));
  const height = Math.max(16, Math.round(Number(source.height) || 1080));
  const hasAudio = source.hasAudio !== false;
  const fileName = baseName(source.path);
  const fileFrames = Math.max(1, Math.round((Number(source.duration) || (clips.length ? clips[clips.length - 1].srcOut / fps : 1)) * fps));
  const videoSample = `<samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  const fileFull = [
    '<file id="file-1">',
    `<name>${esc(fileName)}</name><pathurl>${esc(pathUrl(source.path))}</pathurl>${rate}<duration>${fileFrames}</duration>`,
    `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    `<media><video>${videoSample}</video>${hasAudio ? '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>' : ''}</media>`,
    '</file>'
  ].join('');

  const clipitem = (clip, kind, track) => {
    const id = `clipitem-${kind === 'video' ? 'v' : `a${track}`}-${clip.index}`;
    const links = [`<link><linkclipref>clipitem-v-${clip.index}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${clip.index}</clipindex></link>`];
    if (hasAudio) for (const t of [1, 2]) links.push(`<link><linkclipref>clipitem-a${t}-${clip.index}</linkclipref><mediatype>audio</mediatype><trackindex>${t}</trackindex><clipindex>${clip.index}</clipindex>${kind === 'audio' ? `<groupindex>1</groupindex>` : ''}</link>`);
    return [
      `<clipitem id="${id}">`,
      `<name>${esc(clip.title)}</name><enabled>TRUE</enabled><duration>${fileFrames}</duration>${rate}`,
      `<start>${clip.tlIn}</start><end>${clip.tlOut}</end><in>${clip.srcIn}</in><out>${clip.srcOut}</out>`,
      clip.index === 1 && kind === 'video' ? fileFull : '<file id="file-1"/>',
      kind === 'audio' ? `<sourcetrack><mediatype>audio</mediatype><trackindex>${track}</trackindex></sourcetrack>` : '',
      links.join(''),
      '</clipitem>'
    ].join('');
  };

  const videoTrack = `<track>${clips.map((c) => clipitem(c, 'video', 1)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`;
  const audioTracks = hasAudio
    ? [1, 2].map((t) => `<track>${clips.map((c) => clipitem(c, 'audio', t)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`).join('')
    : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="4">',
    '<sequence id="sequence-1">',
    `<name>${esc(name)}</name><duration>${totalFrames}</duration>${rate}`,
    `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    `<media><video><format>${videoSample}</format>${videoTrack}</video>`,
    hasAudio ? `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audioTracks}</audio>` : '',
    '</media>',
    '</sequence>',
    '</xmeml>',
    ''
  ].join('\n');
}

/** EDL CMX 3600: um evento por corte, vídeo e áudio juntos (B). */
function buildEdl(plan, { name, source }) {
  const { base, clips } = plan;
  const kind = source.hasAudio === false ? 'V     ' : 'B     ';
  const lines = [`TITLE: ${String(name).replace(/[\r\n]+/g, ' ')}`, 'FCM: NON-DROP FRAME', ''];
  for (const c of clips) {
    lines.push(`${pad(c.index, 3)}  AX       ${kind}C        ${timecode(c.srcIn, base)} ${timecode(c.srcOut, base)} ${timecode(c.tlIn, base)} ${timecode(c.tlOut, base)}`);
    lines.push(`* FROM CLIP NAME: ${baseName(source.path)}`);
    lines.push(`* COMMENT: ${c.title.replace(/[\r\n]+/g, ' ')}`);
    lines.push('');
  }
  return lines.join('\r\n');
}

/** Lista de tempos do vídeo original (o formato da janela de cortes do Resolve): uma linha por corte. */
function buildTimes(plan) {
  return `${plan.clips.map((c) => `${clockMs(c.srcIn / plan.fps)} -> ${clockMs(c.srcOut / plan.fps)}`).join('\n')}\n`;
}

/**
 * Falas de todos os cortes, nos tempos da timeline. As falas guardadas são relativas ao início do corte quando foram geradas (`basedOn`);
 * se o corte mudou de borda depois, elas são deslocadas para acompanhar. `style`: o estilo do primeiro corte que tem legenda.
 * Devolve { cues, style, cutsWith, cutsWithout }.
 */
function alignedSubtitles(plan) {
  const cues = [];
  let style = null;
  let cutsWith = 0;
  let cutsWithout = 0;
  for (const clip of plan.clips) {
    const subs = clip.cut && clip.cut.subtitles;
    const list = subs && Array.isArray(subs.cues) ? subs.cues.filter((c) => c && typeof c.text === 'string' && c.text.trim()) : [];
    if (!list.length) { cutsWithout += 1; continue; }
    cutsWith += 1;
    if (!style && subs.style) style = subs.style;
    const shift = subs.basedOn && Number.isFinite(subs.basedOn.start) ? subs.basedOn.start - clip.cut.start : 0;
    const length = (clip.tlOut - clip.tlIn) / plan.fps;
    const origin = clip.tlIn / plan.fps;
    for (const c of list) {
      const start = Math.max(0, c.start + shift);
      const end = Math.min(length, c.end + shift);
      if (!(end > start)) continue;
      cues.push({ start: round3(origin + start), end: round3(origin + end), text: c.text });
    }
  }
  cues.sort((a, b) => a.start - b.start);
  return { cues, style, cutsWith, cutsWithout };
}

const srtOf = (cues, style) => cuesToSrt(cues, { maxChars: normalizeStyle(style).maxCharsPerLine });
const assOf = (cues, style, source, title) => cuesToAss(cues, normalizeStyle(style), { width: Number(source.width) || 1920, height: Number(source.height) || 1080, title });

/**
 * Tudo de uma vez. `formats`: subconjunto de ['xml', 'edl', 'times', 'subs']. Devolve { files: [{ name, content }], summary, warnings }.
 * `name`: nome-base dos arquivos (sem extensão).
 */
function buildExport({ cuts, source, status = 'approved', formats = ['xml', 'edl', 'times', 'subs'], name = 'Braga Frame' }) {
  const plan = planTimeline({ cuts, source, status });
  const warnings = [...plan.warnings];
  const files = [];
  if (!plan.clips.length) return { files, plan, warnings: [...warnings, status === 'all' ? 'Não há cortes para exportar.' : 'Nenhum corte aprovado para exportar. Aprove cortes na aba Cortes.'], summary: { clips: 0 } };
  const want = new Set(formats);
  if (want.has('xml')) files.push({ name: `${name}.xml`, content: buildXml(plan, { name, source }), kind: 'xml' });
  if (want.has('edl')) files.push({ name: `${name}.edl`, content: buildEdl(plan, { name, source }), kind: 'edl' });
  if (want.has('times')) files.push({ name: `${name} - tempos.txt`, content: buildTimes(plan), kind: 'times' });
  let subs = null;
  if (want.has('subs')) {
    subs = alignedSubtitles(plan);
    if (subs.cues.length) {
      files.push({ name: `${name}.srt`, content: srtOf(subs.cues, subs.style), kind: 'srt' });
      files.push({ name: `${name}.ass`, content: assOf(subs.cues, subs.style, source, name), kind: 'ass' });
      files.push({ name: `${name} - estilo da legenda.json`, content: `${JSON.stringify(normalizeStyle(subs.style), null, 2)}\n`, kind: 'style' });
      if (subs.cutsWithout) warnings.push(`${subs.cutsWithout} corte(s) não têm legenda e ficam sem texto no arquivo de legendas. Gere as legendas na aba Legendas.`);
    } else {
      warnings.push('Nenhum corte tem legenda gerada: o arquivo de legendas não foi criado. Gere as legendas na aba Legendas.');
    }
  }
  return {
    files, plan, warnings,
    summary: { clips: plan.clips.length, seconds: round3(plan.totalFrames / plan.fps), fps: round3(plan.fps), cues: subs ? subs.cues.length : 0 }
  };
}

module.exports = { planTimeline, buildXml, buildEdl, buildTimes, alignedSubtitles, buildExport, timecode, clockMs, pathUrl, esc };
