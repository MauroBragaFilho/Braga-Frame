'use strict';

/** Monta os Jobs de exportação (contrato 3.3) a partir de um projeto e das escolhas da aba Exportar. */

const path = require('node:path');
const { normalizeCut } = require('../projects/model');
const { resolveCutFraming, sourceOfJob, detectorKey, readPresets } = require('./layouts');
const { applyNameTemplate } = require('./naming');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function newJobId() {
  return `job-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Nome do vídeo sem pasta e sem extensão (funciona com "\" ou "/" mesmo vindo de outro sistema). */
function baseOf(file) {
  const name = String(file).slice(Math.max(String(file).lastIndexOf('\\'), String(file).lastIndexOf('/')) + 1);
  return name.replace(/\.[^.]+$/, '');
}

/** Curvas de transferência de cor do HDR (PQ/HDR10 e HLG): o app não faz tone mapping, então o QC avisa. */
const HDR_TRANSFERS = Object.freeze(['smpte2084', 'arib-std-b67']);

/**
 * Medidas da fonte no formato do Job: { width, height, fps, duration, hasAudio } e, só quando valem um aviso do QC,
 * `audioTracks` (2 ou mais faixas de áudio) e `hdr: true`. Assim o Job comum continua exatamente com os campos do contrato 3.3.
 */
function sourceInfoFrom(info, source) {
  const i = isObj(info) ? info : {};
  const s = isObj(source) ? source : {};
  const out = {
    width: Number(i.width) || Number(s.width) || 0,
    height: Number(i.height) || Number(s.height) || 0,
    fps: Number(i.fps) || 0,
    duration: Number(i.duration) || Number(s.duration) || 0
  };
  if (typeof i.hasAudio === 'boolean') out.hasAudio = i.hasAudio;
  if (Number(i.audioTracks) > 1) out.audioTracks = Math.floor(Number(i.audioTracks));
  if (HDR_TRANSFERS.includes(i.colorTransfer)) out.hdr = true;
  return out;
}

/**
 * @param {object} opts
 * @param {object} opts.project   projeto v2 (cópia): `id`, `source`, `cuts`
 * @param {object} [opts.info]    ffprobe do vídeo aberto
 * @param {string[]} opts.cutIds  cortes a exportar
 * @param {object} opts.profile   perfil efetivo (completo)
 * @param {object} [opts.framing] padrão de enquadramento do projeto (parcial ou completo)
 * @param {object} [opts.layouts] layouts do canal: { presets (composePresets), useSuggested?: boolean, refsDigest?: string }.
 *   Sem ele nenhum layout se aplica (o corte segue o padrão). Com ele, o enquadramento de cada corte segue a precedência de
 *   layouts.js e o Job registra a origem em `framingSource`.
 * @param {string} opts.outputDir pasta de destino
 * @param {string} [opts.nameTemplate]
 * @returns {{ jobs: object[], missing: string[], duplicates: string[] }} `duplicates` = ids de jobs cujo nome final repete o de outro do lote
 */
function buildJobs({ project, info, cutIds, profile, framing, outputDir, nameTemplate, now = new Date(), layouts }) {
  const cuts = Array.isArray(project && project.cuts) ? project.cuts.filter(isObj) : [];
  const ordered = cuts.map((c, index) => normalizeCut(c, { index })).sort((a, b) => a.start - b.start);
  const digits = Math.max(2, String(ordered.length).length);
  const wanted = new Set(cutIds);
  const sourcePath = project.source.path;
  const sourceInfo = sourceInfoFrom(info, project.source);
  const projectTitle = baseOf(sourcePath);
  const lay = isObj(layouts) ? layouts : {};
  const presets = readPresets(lay.presets);
  const localKey = typeof lay.refsDigest === 'string' ? (cut) => detectorKey({ refsDigest: lay.refsDigest, start: cut.start, end: cut.end }) : null;

  const jobs = [];
  const seen = new Map();
  const duplicates = new Set();
  ordered.forEach((cut, index) => {
    if (!wanted.has(cut.id)) return;
    const snapshot = JSON.parse(JSON.stringify(cut));
    const baseName = applyNameTemplate(nameTemplate, {
      fonte: projectTitle, n: String(index + 1).padStart(digits, '0'), titulo: cut.title, perfil: profile.name || ''
    });
    const resolved = resolveCutFraming({ cut: snapshot, profile, projectFraming: framing, presets, useSuggested: lay.useSuggested !== false, localKey });
    const job = {
      id: newJobId(),
      projectId: String(project.id || ''),
      projectTitle,
      sourcePath,
      sourceInfo,
      cut: snapshot,
      profile: JSON.parse(JSON.stringify(profile)),
      framing: resolved.framing,
      framingSource: sourceOfJob(resolved.origin),
      outputDir: path.normalize(outputDir),
      baseName,
      onConflict: 'ask',
      createdAt: now.toISOString()
    };
    const key = baseName.toLowerCase();
    if (seen.has(key)) { duplicates.add(seen.get(key)); duplicates.add(job.id); } else seen.set(key, job.id);
    jobs.push(job);
  });
  const found = new Set(jobs.map((j) => j.cut.id));
  return { jobs, missing: [...wanted].filter((id) => !found.has(id)), duplicates: [...duplicates] };
}

module.exports = { buildJobs, sourceInfoFrom, baseOf, newJobId };
