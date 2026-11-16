'use strict';

/**
 * Canais IPC da IA na nuvem e da transcrição do vídeo (domínio `analysis:`, dono: analysis). Registrados por handlers/analysis.js.
 *
 *   analysis:aiState                      -> estado do provedor (NUNCA traz a chave): origem, provedor, modelo, chave guardada?, aceite, limites…
 *   analysis:aiSave   { provider?, model?, baseUrl?, apiKey?, clearKey?, limits? } -> estado   (a chave só entra aqui e nunca volta)
 *   analysis:aiTest                       -> { ok, message, ms }      (pedido fixo e minúsculo, sem dado do projeto)
 *   analysis:aiAccept { accepted:boolean } -> estado                  (aviso de privacidade do provedor em uso)
 *   analysis:aiEstimate { projectId, path, size, duration, params?, chatPath?, profile? } -> { windows, calls, tokens…, label, exceedsLimit }
 *   analysis:humorExamples { projectId } -> { examples: { approved, rejected, projects } }   (cortes aprovados/rejeitados do mesmo canal que iriam
 *       como exemplo do perfil de humor; a tela os mostra antes de qualquer envio. Não envia nada.)
 *   analysis:aiSkill                      -> { skill: { source:'default'|'custom', text, chars, tokens, defaultText, minChars, maxChars } }   (o guia de cortes, skill.js)
 *   analysis:aiSkillSave { text }         -> { skill }   (guarda o guia do usuário; texto igual ao padrão volta ao padrão)
 *   analysis:aiSkillReset                 -> { skill }   (apaga o guia do usuário)
 *   analysis:transcriptStatus { projectId, path, size, duration, modelId? } -> { transcript, engine, running }   (engine = o Whisper e o modelo estão prontos?)
 *   analysis:transcriptImport { projectId, path (o vídeo), size, duration, subtitlePath?, defaultDir? } -> { status, warnings } | { canceled:true }  (sem `subtitlePath`, abre o seletor)
 *   analysis:transcriptGenerate { projectId, path, size, duration, modelId?, language?, engine? } -> { jobId }
 *   analysis:transcriptCancel { jobId? }  -> { cancelled }
 *   analysis:transcriptRemove { projectId } -> { removed }
 * Eventos: analysis:transcriptProgress { jobId, p, doneUntil, message }, analysis:transcriptDone { jobId, projectId, status, speed?, deviceNote? },
 *   analysis:transcriptFailed { jobId, projectId, code, message, resumable?, doneUntil? }.
 */

const fs = require('node:fs');
const path = require('node:path');
const { AiRuntime } = require('../../ai/runtime');
const { TranscriptStore } = require('../transcript/store');
const { TranscriptManager } = require('../transcript/manager');
const { SubtitleFileError, MAX_BYTES } = require('../transcript/subtitleFile');
const { AiAnalysisManager } = require('./manager');
const { SkillStore } = require('./skill');
const { AnalysisError } = require('../errors');

function electronSafeStorage() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron.safeStorage || null : null;
  } catch { return null; }
}

/** @returns {{ aiManager, transcriptManager, runtime, store }} */
function registerAiChannels(ctx) {
  const opts = ctx.analysisAiOptions || {};
  const host = ctx.host || {};
  const runtime = new AiRuntime({
    dir: path.join(ctx.paths.userData, 'ai'),
    safeStorage: opts.safeStorage !== undefined ? opts.safeStorage : electronSafeStorage,
    fetchImpl: opts.fetchImpl || null,
    host: host.ai || null,
    hostName: host.name || null,
    // OpenRouter "só gratuitos" (src/ipc/handlers/aiOpenrouter.js, que carrega antes deste handler): catálogo, guard, Pacer e fallback.
    // Sem ele o runtime NÃO libera o OpenRouter (falha fechada: nunca cai no comportamento antigo, que deixava usar modelo pago).
    openrouter: ctx.aiOpenrouter || null,
    ...(opts.restrict ? { restrict: opts.restrict } : {})
  });
  // a chave do OpenRouter (contador de pedidos gratuitos, `aiOpenrouter:limits`) vem do MESMO cofre do runtime, só neste processo
  if (ctx.aiOpenrouter && typeof ctx.aiOpenrouter.setKeyProvider === 'function') {
    ctx.aiOpenrouter.setKeyProvider(() => {
      if (runtime.host) return { key: null, reason: 'host' };
      const key = runtime.secretFor('openrouter');
      if (key) return key;
      return { key: null, reason: runtime.secrets.has('openrouter') ? 'unreadable' : 'none' };
    });
  }
  const store = new TranscriptStore(path.join(ctx.paths.userData, 'transcripts'));
  const skill = new SkillStore(path.join(ctx.paths.userData, 'ai', 'skill')); // o guia de cortes do usuário (o padrão vai com o app)
  const aiManager = new AiAnalysisManager({
    runtime, store, skill, projects: ctx.projectStore || null, getTools: () => ctx.tools,
    readChat: opts.readChat, probe: opts.probe, sleep: opts.sleep, retry: opts.retry
  });
  const transcriptManager = new TranscriptManager({
    store, engine: opts.engine || {
      // o serviço do motor de legendas só existe depois de handlers/subtitles.js carregar: consultado na hora do uso
      prepareRun: (o) => requireEngine().prepareRun(o),
      releaseRun: (run) => requireEngine().releaseRun(run),
      describeRun: (run, result) => requireEngine().describeRun(run, result),
      get defaultModelId() { return requireEngine().defaultModelId; }
    },
    generate: opts.generate
  });
  function requireEngine() {
    if (!ctx.transcription) throw new AnalysisError('NO_ENGINE', 'O motor de transcrição não está disponível neste app.');
    return ctx.transcription;
  }

  // a IA rodando dentro do modo "Algoritmo + IA" (combo.js) não fala direto com o renderer: quem fala é o combo (handlers/analysis.js)
  const inner = (ev) => typeof ctx.isInnerAnalysisJob === 'function' && ctx.isInnerAnalysisJob(ev.jobId);
  aiManager.on('progress', (ev) => { if (!inner(ev)) ctx.send('analysis:progress', ev); });
  aiManager.on('done', (ev) => { if (!inner(ev)) ctx.send('analysis:done', ev); });
  aiManager.on('failed', (ev) => {
    if (ev.code !== 'CANCELLED') ctx.log('warn', `analysis(ia): ${ev.message} (${ev.code})`);
    if (!inner(ev)) ctx.send('analysis:failed', ev);
  });
  transcriptManager.on('progress', (ev) => ctx.send('analysis:transcriptProgress', ev));
  transcriptManager.on('done', (ev) => ctx.send('analysis:transcriptDone', ev));
  transcriptManager.on('failed', (ev) => {
    if (ev.code !== 'CANCELLED') ctx.log('warn', `transcrição: ${ev.message} (${ev.code})`);
    ctx.send('analysis:transcriptFailed', ev);
  });

  const sourceOf = (p) => ({ path: String(p.path || ''), size: Number(p.size) || 0, duration: Number(p.duration) || 0 });

  ctx.handle('analysis:aiState', () => ({ ai: runtime.state() }));
  ctx.handle('analysis:aiSave', (payload) => ({ ai: runtime.save(payload) }));
  ctx.handle('analysis:aiAccept', (payload) => ({ ai: runtime.accept(payload && payload.accepted !== false) }));
  ctx.handle('analysis:aiTest', async () => runtime.test({}));
  // a lista de modelos que a chave guardada pode usar (Gemini, Groq, Personalizado/LM Studio); o OpenRouter tem a própria
  ctx.handle('analysis:aiModels', async () => runtime.models({}));
  ctx.handle('analysis:aiEstimate', async (payload) => ({ estimate: await aiManager.estimate(payload || {}) }));
  // guia de cortes (skill): o texto que ensina a IA a escolher; só texto do usuário, nada de segredo
  ctx.handle('analysis:aiSkill', () => ({ skill: skill.describe() }));
  ctx.handle('analysis:aiSkillSave', (payload) => ({ skill: skill.save(payload && payload.text) }));
  ctx.handle('analysis:aiSkillReset', () => ({ skill: skill.reset() }));
  ctx.handle('analysis:humorExamples', (payload) => ({ examples: aiManager.humorExamples(payload || {}) }));

  ctx.handle('analysis:transcriptStatus', async (payload) => {
    if (!payload || typeof payload.projectId !== 'string' || !payload.projectId) throw new AnalysisError('INVALID_ARGS', 'Informe o projeto.');
    const source = sourceOf(payload);
    let engine = { ready: false, reason: 'O motor de transcrição não está disponível neste app.' };
    if (ctx.transcription) engine = await ctx.transcription.readiness({ modelId: typeof payload.modelId === 'string' && payload.modelId ? payload.modelId : undefined });
    return { transcript: transcriptManager.summary(payload.projectId, source), engine, running: transcriptManager.status() };
  });

  ctx.handle('analysis:transcriptImport', async (payload) => {
    const p = payload || {};
    if (typeof p.projectId !== 'string' || !p.projectId) throw new AnalysisError('INVALID_ARGS', 'Informe o projeto.');
    let file = typeof p.subtitlePath === 'string' && p.subtitlePath ? p.subtitlePath : null; // `path` é o vídeo
    if (!file) {
      const res = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
        title: 'Escolha a legenda do vídeo (.srt ou .vtt)',
        properties: ['openFile'],
        filters: [{ name: 'Legendas', extensions: ['srt', 'vtt'] }],
        ...(typeof p.defaultDir === 'string' && p.defaultDir ? { defaultPath: p.defaultDir } : {})
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
      file = res.filePaths[0];
    }
    if (!path.isAbsolute(file)) throw new AnalysisError('INVALID_ARGS', 'Informe o caminho completo da legenda.');
    let stat;
    try { stat = fs.statSync(file); } catch { throw new AnalysisError('INPUT_MISSING', 'Não foi possível abrir o arquivo escolhido.'); }
    if (!stat.isFile()) throw new AnalysisError('INPUT_MISSING', 'O caminho escolhido não é um arquivo.');
    if (stat.size > MAX_BYTES) throw new SubtitleFileError('TOO_BIG', 'Esse arquivo é grande demais para ser uma legenda (limite de 8 MB). Confira se é o arquivo certo.');
    const buffer = fs.readFileSync(file);
    const out = transcriptManager.importBuffer({ projectId: p.projectId, buffer, ext: path.extname(file), fileName: path.basename(file), source: sourceOf(p) });
    return { canceled: false, status: out.status, warnings: out.warnings };
  });

  ctx.handle('analysis:transcriptGenerate', (payload) => {
    const p = payload || {};
    return transcriptManager.start({
      projectId: p.projectId, path: p.path, size: p.size, duration: p.duration,
      modelId: typeof p.modelId === 'string' && p.modelId ? p.modelId : undefined,
      language: typeof p.language === 'string' && p.language ? p.language : 'pt',
      engine: p.engine
    });
  });
  ctx.handle('analysis:transcriptCancel', (payload) => ({ cancelled: transcriptManager.cancel(payload && payload.jobId) }));
  ctx.handle('analysis:transcriptRemove', (payload) => {
    if (!payload || typeof payload.projectId !== 'string') throw new AnalysisError('INVALID_ARGS', 'Informe o projeto.');
    return { removed: transcriptManager.remove(payload.projectId) };
  });

  return { aiManager, transcriptManager, runtime, store, skill };
}

module.exports = { registerAiChannels };
