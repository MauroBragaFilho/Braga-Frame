'use strict';

/**
 * Canais do recurso exportEngine (docs/recursos/exportEngine.md):
 *
 *   export:pickDir                      -> { path } | { canceled }
 *   export:listProfiles                 -> { profiles, defaultId }
 *   export:saveProfile  { profile }     -> { profile, profiles }
 *   export:deleteProfile { id }         -> { id, profiles }
 *   export:encoders { force? }          -> { ffmpeg, detection }   (NVENC testado de verdade, guardado 24 h)
 *   export:framePreview {...}           -> { dataUrl, width, height }   (mesmo filtro da exportação)
 *   export:sourceFrame {...}            -> { dataUrl, width, height }
 *   export:prepare { project, ... }     -> { jobs, reports }    (monta os Jobs e roda o QC de cada um; `layouts` aplica o layout de cada corte)
 *   export:preflight { jobs }           -> { reports }
 *   export:layoutRef {...}              -> { thumb, w, h, timeSec }   (miniatura de referência para o detector local de layout)
 *   export:detectLayouts {...}          -> { results, model }          (detector local: 3 quadros por corte; evento export:detectProgress)
 *   export:detectCancel                 -> {}
 *
 * Legado (a exportação mínima da base; a aba nova não usa): export:warnings, export:run, export:cancel.
 */

const path = require('node:path');
const { ProfileStore, allProfiles, isBuiltinId, validateProfile, DEFAULT_PROFILE_ID } = require('../../core/export/profiles');
const encoders = require('../../core/export/encoders');
const { preflight } = require('../../core/export/qc');
const { buildJobs } = require('../../core/export/jobs');
const { runExportJob } = require('../../core/export/jobRunner');
const { renderFramePreview, renderSourceFrame, PreviewError } = require('../../core/export/preview');
const { legacyProfile, legacyWarnings } = require('../../core/export/legacy');
const detector = require('../../core/export/layoutDetector');
const { refsDigest, detectorKey } = require('../../core/export/layouts');
const { probeMedia } = require('../../core/ffmpeg/probe');

function problem(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  return err;
}

const NO_FFMPEG = 'ffmpeg não encontrado. Instale o FFmpeg (ffmpeg.org/download.html), deixe-o no PATH ou defina CORTE_FFMPEG e use "Verificar de novo".';

function register(ctx) {
  const store = new ProfileStore(path.join(ctx.paths.userData, 'profiles.json'));
  encoders.configure({ cacheDir: ctx.paths.cache });

  const profilesPayload = () => allProfiles(store).map((p) => ({ ...p, builtin: isBuiltinId(p.id) }));

  // ---------- pasta de destino ----------

  ctx.handle('export:pickDir', async () => {
    const res = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      title: 'Pasta de destino dos cortes',
      properties: ['openDirectory', 'createDirectory']
    });
    return res.canceled ? { canceled: true } : { path: res.filePaths[0] };
  });

  // ---------- perfis ----------

  // Os perfis embutidos não dependem do arquivo: se profiles.json não puder ser lido (permissão, pasta no lugar do arquivo…), a lista
  // continua utilizável com eles e a resposta traz `warning` para a tela explicar, em vez de deixar a aba sem perfil nenhum.
  ctx.handle('export:listProfiles', () => {
    try {
      return { profiles: profilesPayload(), defaultId: DEFAULT_PROFILE_ID };
    } catch (err) {
      return {
        profiles: allProfiles(null).map((p) => ({ ...p, builtin: true })), defaultId: DEFAULT_PROFILE_ID,
        warning: `Seus perfis salvos não puderam ser carregados, então só os perfis do app aparecem. ${err.message}`
      };
    }
  });

  ctx.handle('export:saveProfile', ({ profile }) => {
    const saved = store.save(profile);
    return { profile: { ...saved, builtin: false }, profiles: profilesPayload() };
  });

  ctx.handle('export:deleteProfile', ({ id }) => {
    store.remove(id);
    return { id, profiles: profilesPayload() };
  });

  // ---------- codificadores ----------

  ctx.handle('export:encoders', async ({ force } = {}) => {
    if (!ctx.tools.ffmpeg) return { ffmpeg: false, detection: null, message: NO_FFMPEG };
    const detection = await encoders.detectEncoders({ ffmpeg: ctx.tools.ffmpeg, force: force === true });
    return { ffmpeg: true, detection };
  });

  // ---------- quadros ----------

  // um pedido novo com a mesma `key` cancela o anterior (a interface pede de novo a cada ajuste)
  const inflight = new Map();
  async function withKey(key, fn) {
    const controller = new AbortController();
    if (key) {
      const previous = inflight.get(key);
      if (previous) previous.abort();
      inflight.set(key, controller);
    }
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err instanceof PreviewError && err.code === 'SUPERSEDED') return { ok: false, code: 'SUPERSEDED', message: err.message };
      throw err;
    } finally {
      if (key && inflight.get(key) === controller) inflight.delete(key);
    }
  }

  ctx.handle('export:framePreview', (req) => {
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', NO_FFMPEG);
    return withKey(req.key, (signal) => renderFramePreview({
      ffmpeg: ctx.tools.ffmpeg, sourcePath: req.sourcePath, timeSec: Number(req.timeSec) || 0,
      profile: req.profile, framing: req.framing, maxSide: req.maxSide === undefined ? 640 : Number(req.maxSide), signal
    }));
  });

  ctx.handle('export:sourceFrame', (req) => {
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', NO_FFMPEG);
    return withKey(req.key, (signal) => renderSourceFrame({
      ffmpeg: ctx.tools.ffmpeg, sourcePath: req.sourcePath, timeSec: Number(req.timeSec) || 0,
      maxWidth: req.maxWidth === undefined ? 960 : Number(req.maxWidth), signal
    }));
  });

  // ---------- Jobs e controle de qualidade ----------

  function reportFor(job, duplicates) {
    const r = preflight(job, { tools: ctx.tools });
    if (duplicates && duplicates.has(job.id)) {
      r.warnings.push({ code: 'NAME_DUPLICATE', message: `Mais de um corte desta seleção vai gerar o nome "${job.baseName}.mp4". Mude o modelo do nome (inclua {n}); se nada mudar, a fila pergunta o que fazer a cada repetição.` });
    }
    return { jobId: job.id, cutId: job.cut.id, title: job.cut.title, errors: r.errors, warnings: r.warnings };
  }

  ctx.handle('export:preflight', async ({ jobs }) => {
    if (!Array.isArray(jobs)) throw problem('INVALID_ARGS', 'Informe a lista de trabalhos para conferir.');
    if (ctx.tools.ffmpeg) await encoders.detectEncoders({ ffmpeg: ctx.tools.ffmpeg });
    return { reports: jobs.map((job) => reportFor(job)) };
  });

  ctx.handle('export:prepare', async (req) => {
    const { project, info, cutIds, profile, framing, outputDir, nameTemplate, layouts } = req;
    if (!project || typeof project !== 'object' || !project.source || typeof project.source.path !== 'string') {
      throw problem('INVALID_PROJECT', 'Abra um vídeo para exportar cortes.');
    }
    if (!Array.isArray(cutIds)) throw problem('INVALID_ARGS', 'Informe os cortes a exportar.');
    const checked = validateProfile(profile);
    if (checked.errors.length) throw problem('INVALID_PROFILE', checked.errors.join(' '), { errors: checked.errors });
    if (typeof outputDir !== 'string' || !outputDir) throw problem('OUTPUT_NOT_WRITABLE', 'Escolha a pasta de destino.');
    if (ctx.tools.ffmpeg) await encoders.detectEncoders({ ffmpeg: ctx.tools.ffmpeg });
    const { jobs, missing, duplicates } = buildJobs({
      project, info, cutIds, profile: checked.profile, framing, outputDir, nameTemplate, layouts
    });
    const dup = new Set(duplicates);
    return { jobs, missing, reports: jobs.map((job) => reportFor(job, dup)) };
  });

  // ---------- detector local de layout (Conversa | Jogo) ----------

  /** Erro do detector -> erro de IPC (mensagem em português, com o código). */
  const detectorProblem = (err) => (err instanceof detector.DetectorError ? problem(err.code, err.message, err.details) : err);

  // miniatura 64x36 em tons de cinza do quadro em `timeSec` (a referência que o usuário escolhe no player)
  ctx.handle('export:layoutRef', async ({ sourcePath, timeSec }) => {
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', NO_FFMPEG);
    const at = Math.max(0, Number(timeSec) || 0);
    let thumb;
    try {
      thumb = await detector.grabThumb({ ffmpeg: ctx.tools.ffmpeg, sourcePath, timeSec: at });
    } catch (err) {
      throw detectorProblem(err);
    }
    if (!thumb) throw problem('NO_FRAME', 'Não foi possível ler um quadro neste ponto do vídeo. Escolha outro ponto ou confira se o arquivo está íntegro.');
    return { thumb: detector.thumbToBase64(thumb), w: detector.THUMB_W, h: detector.THUMB_H, timeSec: at };
  });

  // uma detecção por vez: pedir outra cancela a anterior (a interface só pede de novo depois de mudar as referências)
  let detectRun = null;

  ctx.handle('export:detectLayouts', async ({ sourcePath, cuts, refs }) => {
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', NO_FFMPEG);
    if (typeof sourcePath !== 'string' || !sourcePath) throw problem('INVALID_ARGS', 'Abra um vídeo para detectar o layout dos cortes.');
    if (!Array.isArray(cuts) || cuts.length > 1000) throw problem('INVALID_ARGS', 'Informe a lista de cortes (até 1000) para detectar o layout.');
    const given = refs && typeof refs === 'object' ? refs : {};
    const texts = {};
    const decoded = {};
    for (const layout of detector.LAYOUTS) {
      texts[layout] = (Array.isArray(given[layout]) ? given[layout] : []).filter((t) => detector.thumbFromBase64(t)).slice(0, detector.MAX_REFS);
      decoded[layout] = texts[layout].map((t) => detector.thumbFromBase64(t));
    }
    const digest = refsDigest(texts);
    if (detectRun) detectRun.abort();
    const controller = new AbortController();
    detectRun = controller;
    const started = Date.now();
    try {
      const run = await detector.detectCuts({
        ffmpeg: ctx.tools.ffmpeg, sourcePath, refs: decoded, signal: controller.signal,
        cuts: cuts.filter((c) => c && typeof c.id === 'string').map((c) => ({ id: c.id, start: Number(c.start), end: Number(c.end) })),
        onProgress: (done, total) => ctx.send('export:detectProgress', { done, total })
      });
      if (!run.ok) throw problem('BAD_REFS', run.problems.map((p) => p.message).join(' '), { problems: run.problems, model: run.model });
      const at = new Date().toISOString();
      const byId = new Map(cuts.map((c) => [c && c.id, c]));
      return {
        refsDigest: digest, model: run.model, tookMs: Date.now() - started,
        results: run.results.map((r) => {
          const cut = byId.get(r.cutId);
          return {
            cutId: r.cutId, layout: r.layout, confidence: Number(r.confidence.toFixed(3)), reason: r.reason, at,
            key: detectorKey({ refsDigest: digest, start: Number(cut.start), end: Number(cut.end) }),
            samples: r.samples.map((x) => ({ t: x.t, layout: x.layout }))
          };
        })
      };
    } catch (err) {
      throw detectorProblem(err);
    } finally {
      if (detectRun === controller) detectRun = null;
    }
  });

  ctx.handle('export:detectCancel', () => {
    if (detectRun) detectRun.abort();
    return {};
  });

  // ---------- legado (exportação mínima da base) ----------

  let legacyRun = null;

  ctx.handle('export:warnings', ({ profile, source }) => {
    const v = legacyProfile(profile);
    return { errors: v.errors, warnings: legacyWarnings(v.profile, source) };
  });

  ctx.handle('export:run', async (req) => {
    if (legacyRun) throw problem('BUSY', 'Já existe uma exportação em andamento. Aguarde terminar ou cancele.');
    if (!ctx.tools.ffmpeg) throw problem('NO_FFMPEG', NO_FFMPEG);
    const checked = legacyProfile(req.profile);
    if (checked.errors.length) throw problem('INVALID_PROFILE', checked.errors.join(' '), { errors: checked.errors });
    let sourceInfo = {};
    if (ctx.tools.ffprobe) {
      try { sourceInfo = await probeMedia(ctx.tools.ffprobe, req.input); } catch { /* o runner explica o problema de leitura */ }
    }
    legacyRun = new AbortController();
    try {
      const out = await runExportJob({
        id: 'legacy', projectId: '', projectTitle: '', sourcePath: req.input,
        sourceInfo: { width: sourceInfo.width, height: sourceInfo.height, fps: sourceInfo.fps, duration: sourceInfo.duration, hasAudio: sourceInfo.hasAudio },
        cut: { start: req.startSec, end: req.endSec, title: req.baseName }, profile: checked.profile, framing: null,
        outputDir: req.outputDir, baseName: req.baseName, onConflict: req.onConflict === 'rename' ? 'rename' : 'fail'
      }, { tools: ctx.tools, signal: legacyRun.signal, onProgress: (p) => ctx.send('export:progress', p) });
      return { output: out.output, profile: checked.profile, warnings: out.warnings };
    } finally {
      legacyRun = null;
    }
  });

  ctx.handle('export:cancel', () => {
    if (legacyRun) legacyRun.abort();
    return {};
  });
}

module.exports = { register };
