'use strict';

/**
 * EXEMPLOS do perfil de humor do canal (docs/recursos/analise-ia.md, seção 16): trechos de cortes que o usuário APROVOU e REJEITOU em projetos
 * anteriores do mesmo canal, para a IA aprender o gosto dele. O que sai do computador é só o texto da fala do corte (a transcrição que o app já
 * guarda), limitado a `exampleChars` caracteres por exemplo e a poucos exemplos; a tela mostra exatamente isto antes de qualquer envio.
 *
 *   aprovados  cortes com status "approved" (os já exportados vêm primeiro: o usuário os usou de fato);
 *   rejeitados cortes com status "rejected" (o que o algoritmo ou a IA sugeriu e ele disse que não presta).
 * Projetos do mesmo canal (campo "canal" do projeto, sem diferenciar caixa nem acento); o projeto sem canal olha todos. Os mais recentes primeiro, no
 * máximo dois aprovados e um rejeitado por projeto (variedade), e só projetos com transcrição guardada que ainda vale para o vídeo.
 */

const { cuesInRange, sameSource } = require('../transcript/format');
const { normName } = require('../../preferences/scope');
const humor = require('../humor');

const MAX_PROJECTS = 60; // projetos lidos à procura de exemplos (os mais recentes do canal)
const MIN_TEXT_CHARS = 40; // fala curta demais não ensina nada
const PER_PROJECT = Object.freeze({ approved: 2, rejected: 1 });
const GAP = ' […] ';

/**
 * Fala do corte para servir de exemplo: tudo, se couber; senão o começo (o gancho) e o fim (o desfecho) com "[…]" no meio, sempre em fim de palavra.
 */
function excerpt(cues, start, end, maxChars = humor.LIMITS.exampleChars) {
  const text = cuesInRange(Array.isArray(cues) ? cues : [], start, end)
    .map((c) => humor.squash(c && c.text))
    .filter(Boolean)
    .join(' ');
  if (text.length <= maxChars) return text;
  const head = Math.round((maxChars - GAP.length) * 0.6);
  const tail = maxChars - GAP.length - head;
  return `${text.slice(0, head).replace(/\s+\S*$/, '')}${GAP}${text.slice(-tail).replace(/^\S*\s+/, '')}`;
}

/** Os `max` primeiros de `candidates` (já em ordem de preferência), com no máximo `perProject` por projeto; se faltar, completa com os que sobraram. */
function pick(candidates, max, perProject) {
  const first = [];
  const rest = [];
  const used = new Map();
  for (const c of candidates) {
    const n = used.get(c.projectId) || 0;
    if (first.length < max && n < perProject) { first.push(c); used.set(c.projectId, n + 1); } else rest.push(c);
  }
  return [...first, ...rest].slice(0, max);
}

/**
 * @param {{ projects: object, transcripts: object, projectId?: string|null, maxApproved?: number, maxRejected?: number }} o
 *   projects    ProjectStore (list, loadById); transcripts: TranscriptStore (get); projectId: o projeto que será analisado (diz o canal)
 * @returns {{ approved: Example[], rejected: Example[], projects: number }}
 *   Example = { projectId, cutId, title, category, start, end, durationSec, text, exported }  (`projects` = projetos lidos)
 * Nunca lança: projeto ou transcrição ilegível é pulado.
 */
function selectExamples({ projects, transcripts, projectId = null, maxApproved = humor.LIMITS.examplesPositive, maxRejected = humor.LIMITS.examplesNegative } = {}) {
  const out = { approved: [], rejected: [], projects: 0 };
  if (!projects || !transcripts) return out;
  let channel = '';
  try {
    const current = projectId ? projects.loadById(projectId) : null;
    channel = current && current.meta ? normName(current.meta.channel) : '';
  } catch { /* projeto ilegível: olha todos */ }
  let list;
  try { list = projects.list(); } catch { return out; }

  const pool = { approved: [], rejected: [] };
  for (const summary of list) {
    if (out.projects >= MAX_PROJECTS) break;
    const counts = summary && summary.counts ? summary.counts : {};
    if (!(counts.approved > 0 || counts.rejected > 0)) continue;
    if (channel && normName(summary.meta && summary.meta.channel) !== channel) continue;
    let project;
    let doc;
    try {
      project = projects.loadById(summary.id);
      doc = project ? transcripts.get(summary.id) : null;
    } catch { continue; }
    if (!project || !doc || !Array.isArray(doc.cues) || !sameSource(doc.source, project.source)) continue;
    out.projects += 1;
    for (const cut of project.cuts || []) {
      const kind = cut.status === 'approved' ? 'approved' : (cut.status === 'rejected' ? 'rejected' : null);
      if (!kind) continue;
      const text = excerpt(doc.cues, cut.start, cut.end);
      if (text.length < MIN_TEXT_CHARS) continue;
      pool[kind].push({
        projectId: summary.id, cutId: cut.id, title: humor.squash(cut.title).slice(0, 80), category: humor.squash(cut.category).slice(0, 30),
        start: cut.start, end: cut.end, durationSec: Math.round(cut.end - cut.start), text, exported: Array.isArray(cut.exports) && cut.exports.length > 0
      });
    }
  }
  // os usados de verdade (exportados) valem mais; dentro de cada grupo, vale a ordem dos projetos (mais recente primeiro)
  const exportedFirst = [...pool.approved.filter((c) => c.exported), ...pool.approved.filter((c) => !c.exported)];
  out.approved = pick(exportedFirst, Math.max(0, maxApproved), PER_PROJECT.approved);
  out.rejected = pick(pool.rejected, Math.max(0, maxRejected), PER_PROJECT.rejected);
  return out;
}

/** Valida exemplos vindos de fora (renderer/IPC): { approved, rejected } de { title, category, durationSec, text }, nos limites do perfil. */
function normalizeExamples(raw) {
  const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, max) => (typeof value === 'string' ? humor.squash(value).slice(0, max) : '');
  const one = (list, max) => (Array.isArray(list) ? list : []).map((e) => {
    const x = e !== null && typeof e === 'object' ? e : {};
    return {
      title: str(x.title, 80),
      category: str(x.category, 30),
      durationSec: Number.isFinite(Number(x.durationSec)) ? Math.max(0, Math.round(Number(x.durationSec))) : 0,
      text: str(x.text, humor.LIMITS.exampleChars)
    };
  }).filter((e) => e.text).slice(0, max); // item sem texto não gasta vaga
  return { approved: one(src.approved, humor.LIMITS.examplesPositive), rejected: one(src.rejected, humor.LIMITS.examplesNegative) };
}

module.exports = { selectExamples, normalizeExamples, excerpt, MIN_TEXT_CHARS, MAX_PROJECTS };
