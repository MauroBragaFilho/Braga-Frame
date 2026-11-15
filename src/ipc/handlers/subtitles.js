'use strict';

/**
 * IPC das legendas (dono: subtitles). Canais:
 *   subtitles:status                   situação: motor, modelos, idiomas, fontes, suporte à legenda incorporada
 *   subtitles:installModel {id}        baixa um modelo (fonte oficial, SHA-256 conferido); evento subtitles:modelProgress
 *   subtitles:cancelModel {id}         cancela o download
 *   subtitles:removeModel {id}         apaga um modelo instalado
 *   subtitles:generate {…}             gera a legenda automática de um corte; evento subtitles:progress
 *   subtitles:cancel {cutId}           cancela a geração
 *   subtitles:importFile {defaultDir?} lê uma legenda .srt/.ass escolhida pelo usuário
 *   subtitles:hardware {refresh?}      placa NVIDIA detectada (nome, memória, driver) e o motor/dispositivo que seria usado
 *
 * GPU: `subtitles:generate` aceita `engine: 'auto'|'gpu'|'cpu'`. No automático, usa a placa NVIDIA se ela foi detectada (gpu.js) e há
 * um motor CUDA (instalado pela aba Ferramentas, entrada whisper-cuda, ou fornecido pelo hospedeiro); se a placa falhar repete no
 * processador, avisa e lembra da falha (engine.js). O resultado traz `device` ('GPU'|'CPU'), `fellBack`, `transcribeMs` e `speed`.
 *
 * Este módulo só devolve resultados e emite eventos: quem grava o projeto é o renderer (BF.project.update).
 * O motor (whisper-cli) vem de ctx.tools.whisper (instalado pela aba Ferramentas, entrada src/core/tools/entries/whisper.js);
 * os modelos ficam em <userData>/models (src/core/subtitles/models.js).
 * Módulo embutido (ctx.host): o motor e os modelos podem vir do hospedeiro (BDS). Os modelos dele são usados no lugar de baixar outros, a
 * instalação de um modelo novo é delegada a ele e a remoção fica com ele (veja ModelManager).
 */

const fs = require('node:fs');
const path = require('node:path');
const registry = require('../../core/tools/registry');
const { ModelManager, DEFAULT_MODEL_ID, getModel } = require('../../core/subtitles/models');
const { generateSubtitles, LANGUAGES, MAX_CUT_SECONDS } = require('../../core/subtitles/generate');
const { detectBurnInSupport } = require('../../core/subtitles/burnIn');
const { parseSubtitleFile } = require('../../core/subtitles/formats');
const { listFonts } = require('../../core/subtitles/fonts');
const { SubtitlesError } = require('../../core/subtitles/errors');
const gpuInfo = require('../../core/subtitles/gpu');
const engineInfo = require('../../core/subtitles/engine');

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function fail(code, message, details) {
  const err = new SubtitlesError(code, message, details);
  return err;
}

const samePath = (a, b) => Boolean(a) && Boolean(b) && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Texto de um arquivo de legenda. O BOM manda: UTF-16 (o "Unicode" do Bloco de Notas) e UTF-8 com BOM; sem BOM, UTF-8 e,
 * se não for válido, Windows-1252 (comum em legendas antigas).
 */
function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer); // o BOM sai sozinho
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function register(ctx) {
  // Pontos de injeção só para testes (nunca definidos no app): pasta dos modelos e opções do ModelManager.
  const options = ctx.subtitlesOptions || {};
  const modelsDir = options.modelsDir || path.join(ctx.paths.userData, 'models');
  const workRoot = options.workRoot || path.join(ctx.paths.cache, 'subtitles');
  const catalog = ctx.toolCatalog || { entries: registry.getEntries() };

  const host = ctx.host || { embedded: false, name: null, tool: () => null, whisperModels: null };
  const manager = new ModelManager({ dir: modelsDir, hostModels: host.whisperModels || null, hostName: host.name || null, ...(options.models || {}) });
  manager.cleanup(); // resíduos de um download que o app não chegou a terminar
  try { // pastas de trabalho de uma geração interrompida (o app foi fechado no meio)
    for (const name of fs.readdirSync(workRoot)) if (name.startsWith('sub-')) fs.rmSync(path.join(workRoot, name), { recursive: true, force: true });
  } catch { /* ainda não existe */ }

  const detectGpu = options.detectGpu || ((opts) => gpuInfo.detectNvidia(opts));
  const failures = new engineInfo.GpuFailureMemory();
  const CUDA_ID = 'whisper-cuda';
  const running = new Map();   // cutId -> { controller, modelId }
  Promise.resolve(detectGpu({})).catch(() => null); // aquece o cache da placa (a aba Legendas abre sem esperar o nvidia-smi)
  const modelOps = new Map();  // modelId -> AbortController do download

  ctx.toolUsage.register((key, id) => ((key === 'whisper' || id === CUDA_ID) && running.size > 0 ? 'a geração de legendas está rodando' : null));
  if (ctx.app && typeof ctx.app.on === 'function') {
    ctx.app.on('before-quit', () => {
      for (const { controller } of running.values()) controller.abort();
      for (const controller of modelOps.values()) controller.abort();
    });
  }

  const modelIdOfEntry = (entryId) => String(entryId).replace(/^whisper-/, '');
  manager.on('progress', (ev) => {
    ctx.send('subtitles:modelProgress', {
      id: modelIdOfEntry(ev.id), phase: ev.phase, message: ev.message, percent: ev.percent,
      received: ev.receivedBytes, total: ev.totalBytes, speedBps: ev.speedBps
    });
  });

  // ---------- situação ----------

  /**
   * Os motores disponíveis: `cpu` (sem CUDA), `cuda` (traz ggml-cuda; roda na placa e, com -ng, no processador).
   * Vêm do hospedeiro (BDS), da instalação do app ou do sistema; o tipo de cada um é descoberto pela pasta dele.
   */
  function resolveEngines() {
    const cuda = registry.resolveInstalled(ctx.paths.tools, CUDA_ID, { entries: catalog.entries });
    const main = ctx.tools.whisper || null;
    const mainKind = main ? engineInfo.engineKindOf(main) : null;
    const hostExe = host.tool('whisper');
    const cudaExe = mainKind === 'cuda' ? main : (host.embedded && hostExe ? null : cuda);
    const cpuExe = mainKind === 'cpu' ? main : null;
    return { cpuExe, cudaExe, any: cpuExe || cudaExe, main, mainKind, cudaFromApp: !host.embedded || !hostExe ? cuda : null };
  }

  function engineStatus() {
    const entry = catalog.entries.find((e) => e.id === 'whisper') || null;
    const asset = entry ? registry.assetFor(entry) : null;
    const eng = resolveEngines();
    const active = eng.main || eng.cudaExe || null;
    const fromApp = entry ? registry.resolveInstalled(ctx.paths.tools, 'whisper', { entries: catalog.entries }) : null;
    const fromHost = active && samePath(active, host.tool('whisper'));
    const cudaEntry = catalog.entries.find((e) => e.id === CUDA_ID) || null;
    const cudaAsset = cudaEntry ? registry.assetFor(cudaEntry) : null;
    const managedByHost = Boolean(fromHost);
    return {
      id: 'whisper',
      label: entry ? entry.label : 'Whisper (legendas automáticas)',
      version: entry ? entry.version : null,
      installed: Boolean(active),
      path: active,
      origin: active ? (fromHost ? 'host' : (samePath(active, fromApp) || samePath(active, eng.cudaFromApp) ? 'app' : 'system')) : null,
      hostName: fromHost ? host.name || null : null,
      kind: active ? engineInfo.engineKindOf(active) : null,
      available: Boolean(asset),
      unavailableReason: entry && !asset ? registry.unavailableReason(entry) : (entry ? null : 'O app não tem uma entrada oficial do motor de transcrição.'),
      sizeBytes: asset ? asset.size : 0,
      source: entry ? entry.source : null,
      // motor com placa NVIDIA (CUDA): instalável pela aba Ferramentas/Legendas, exceto quando o hospedeiro fornece o motor
      cuda: {
        id: CUDA_ID,
        available: Boolean(cudaAsset) && !managedByHost,
        unavailableReason: managedByHost ? `O motor vem do ${host.name || 'aplicativo'}; a aceleração por placa depende dele.` : (cudaEntry && !cudaAsset ? 'A aceleração NVIDIA só está disponível para Windows 64 bits.' : null),
        installed: Boolean(eng.cudaExe),
        path: eng.cudaExe,
        sizeBytes: cudaAsset ? cudaAsset.size : 0,
        version: cudaEntry ? cudaEntry.version : null,
        source: cudaEntry ? cudaEntry.source : null,
        managedByHost
      }
    };
  }

  /**
   * @param {{ refresh?:boolean, waitMs?:number }} [o]  `waitMs`: espera a detecção por no máximo esse tempo; se ela ainda não
   *   terminou devolve `pending: true` (a consulta continua e a próxima chamada já a encontra no cache) — assim o status da aba
   *   nunca fica preso esperando o nvidia-smi.
   */
  async function hardwareStatus({ refresh = false, waitMs = 0 } = {}) {
    let gpu = null;
    let pending = false;
    try {
      const detection = Promise.resolve(detectGpu({ refresh })).catch(() => null);
      if (waitMs > 0) {
        let timer = null;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('pending'), waitMs); });
        const first = await Promise.race([detection, timeout]);
        clearTimeout(timer);
        if (first === 'pending') pending = true; else gpu = first;
      } else {
        gpu = await detection;
      }
    } catch { gpu = null; }
    gpu = gpu || { available: false, name: null, memoryMb: null, driver: null, driverOk: false, source: null, reason: 'Não foi possível consultar a placa de vídeo.' };
    const eng = resolveEngines();
    const kind = eng.cudaExe ? 'cuda' : (eng.cpuExe ? 'cpu' : null);
    const lastFailure = eng.cudaExe ? failures.last() : null;
    return {
      pending,
      gpu: { ...gpu, summary: gpuInfo.describeGpu(gpu), ...(pending ? { reason: '' } : {}) },
      engineKind: kind,
      canUseGpu: Boolean(gpu.available && eng.cudaExe),
      gpuFailure: lastFailure ? lastFailure.reason : null
    };
  }

  async function buildStatus() {
    const burnIn = ctx.tools.ffmpeg
      ? detectBurnInSupport(ctx.tools.ffmpeg)
      : { supported: false, reason: 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.' };
    const hw = await hardwareStatus({ waitMs: 400 });
    return {
      engine: engineStatus(),
      ffmpeg: { found: Boolean(ctx.tools.ffmpeg) },
      hardware: hw,
      models: manager.list().map((m) => ({
        ...m, recommended: m.id === DEFAULT_MODEL_ID,
        gpuFit: hw.gpu.available ? engineInfo.gpuMemoryAdvice(getModel(m.id), hw.gpu) : { level: 'unknown', message: '' }
      })),
      defaultModel: DEFAULT_MODEL_ID,
      modelsManagedByHost: Boolean(host.whisperModels),
      hostName: host.name || null,
      languages: LANGUAGES,
      fonts: listFonts(),
      burnIn: { supported: burnIn.supported, reason: burnIn.reason },
      generating: [...running.keys()],
      limits: { maxSeconds: MAX_CUT_SECONDS }
    };
  }

  ctx.handle('subtitles:hardware', ({ refresh } = {}) => hardwareStatus({ refresh: refresh === true }));

  ctx.handle('subtitles:status', () => buildStatus());

  // ---------- modelos ----------

  ctx.handle('subtitles:installModel', async ({ id }) => {
    if (!getModel(id)) throw fail('UNKNOWN_MODEL', `Modelo desconhecido: ${id}.`);
    if (modelOps.has(id)) throw fail('BUSY', 'Esse modelo já está sendo baixado.');
    const controller = new AbortController();
    modelOps.set(id, controller);
    try {
      ctx.log('info', `legendas: instalando o modelo ${id}`);
      const res = await manager.install(id, { signal: controller.signal });
      return { id, installed: true, sizeBytes: res.sizeBytes, revision: res.revision, alreadyInstalled: res.alreadyInstalled };
    } finally {
      modelOps.delete(id);
    }
  });

  ctx.handle('subtitles:cancelModel', ({ id }) => {
    const controller = modelOps.get(id);
    if (controller) controller.abort();
    return { cancelled: Boolean(controller) };
  });

  ctx.handle('subtitles:removeModel', async ({ id }) => {
    if (!getModel(id)) throw fail('UNKNOWN_MODEL', `Modelo desconhecido: ${id}.`);
    if (modelOps.has(id)) throw fail('BUSY', 'Esse modelo está sendo baixado. Cancele o download antes de remover.');
    for (const run of running.values()) {
      if (run.modelId === id) throw fail('MODEL_IN_USE', 'Esse modelo está sendo usado na geração de uma legenda. Espere terminar (ou cancele) e tente de novo.');
    }
    const res = await manager.remove(id);
    return { id, removed: res.removed };
  });

  // ---------- geração ----------

  /**
   * Prepara UMA execução do motor (também usada pela transcrição do vídeo inteiro da aba Análise, via `ctx.transcription`): confere
   * ferramentas, modelo e "uma por vez", registra a execução em `running` (protege o motor e o modelo de remoção) e decide onde rodar
   * (placa ou processador). Lança SubtitlesError. Quem chama precisa chamar `release(run)` no fim.
   */
  async function prepareRun({ key, modelId, engine, onPrepare = () => {} }) {
    const model = getModel(modelId);
    if (!model) throw fail('UNKNOWN_MODEL', `Modelo desconhecido: ${modelId}.`);
    if (!ctx.tools.ffmpeg) throw fail('NO_FFMPEG', 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.');
    const eng = resolveEngines();
    if (!eng.any) throw fail('NO_ENGINE', 'O motor de transcrição (Whisper) não está instalado. Instale-o aqui na aba Legendas ou na aba Ferramentas.');
    const installed = manager.installed(modelId);
    if (!installed) throw fail('NO_MODEL', `O modelo ${model.label} ainda não foi baixado. Baixe-o antes de gerar a legenda.`);
    if (running.size > 0) throw fail('BUSY', 'Já existe uma legenda sendo gerada. Espere terminar (ou cancele) e tente de novo.');

    const controller = new AbortController();
    running.set(key, { controller, modelId });
    try {
      if (host.whisperModels) { // modelo do hospedeiro: o SHA-256 dele precisa ser o do catálogo daqui (conferido uma vez por arquivo)
        onPrepare('Conferindo o modelo…');
        if (!(await manager.verifyHost(modelId, { signal: controller.signal }))) {
          throw fail('NO_MODEL', `O arquivo do modelo ${model.label} no ${host.name || 'aplicativo'} não confere com o esperado (SHA-256). Reinstale o modelo por lá.`);
        }
      }
      // onde rodar: placa (motor CUDA + NVIDIA detectada) ou processador
      const mode = engineInfo.normalizeMode(engine);
      let gpu = null;
      if (mode !== 'cpu' && eng.cudaExe) { try { gpu = await detectGpu({}); } catch { gpu = null; } }
      const advice = engineInfo.gpuMemoryAdvice(model, gpu);
      const plan = engineInfo.planDevice({ mode, gpu, engineKind: eng.cudaExe ? 'cuda' : 'cpu', failure: eng.cudaExe ? failures.get(eng.cudaExe, modelId) : null, advice });
      const exe = plan.useGpu ? eng.cudaExe : (eng.cpuExe || eng.cudaExe);
      return {
        key, controller, model, modelId, installed, eng, plan, gpu, advice, exe,
        // opções de generateSubtitles que dependem do motor e do modelo
        genOptions: {
          ffmpeg: ctx.tools.ffmpeg, whisper: exe, modelPath: installed.path, dtw: model.dtw,
          useGpu: plan.useGpu, cudaEngine: exe === eng.cudaExe, cpuWhisper: eng.cpuExe,
          onGpuFailed: (reason) => { failures.set(eng.cudaExe, modelId, reason); ctx.log('warn', `legendas: a placa falhou (${reason}); usando o processador`); },
          workRoot, engine: options.engine
        }
      };
    } catch (err) {
      running.delete(key);
      throw err;
    }
  }

  function releaseRun(run) { running.delete(run.key); }

  /** Depois de uma execução: lembra/esquece falhas da placa e monta as notas de dispositivo para a interface. */
  function describeRun(run, result) {
    const { plan, eng, modelId, gpu, advice } = run;
    if (plan.useGpu && !result.fellBack && result.device === 'GPU') failures.clear(eng.cudaExe, modelId);
    const deviceNote = result.fellBack
      ? 'A placa falhou: usando o processador.'
      : (plan.note || (plan.useGpu && result.device === 'CPU' && !result.noSpeech ? 'O motor não usou a placa: rodou no processador.' : null));
    return {
      deviceLabel: result.device === 'GPU' ? `placa ${(gpu && gpu.name) || result.deviceName || 'NVIDIA'}` : 'processador',
      deviceNote, memoryAdvice: advice.level === 'tight' || advice.level === 'no' ? advice.message : null
    };
  }

  // Serviço para quem precisa do motor de transcrição sem ser a aba Legendas (a transcrição do vídeo inteiro, em handlers/analysisAi.js).
  ctx.transcription = {
    prepareRun, releaseRun, describeRun,
    defaultModelId: DEFAULT_MODEL_ID,
    /** O motor e o modelo estão prontos? (sem rodar nada) */
    async readiness({ modelId = DEFAULT_MODEL_ID } = {}) {
      const model = getModel(modelId);
      const eng = resolveEngines();
      const installed = model ? manager.installed(modelId) : null;
      let reason = '';
      if (!model) reason = `Modelo desconhecido: ${modelId}.`;
      else if (!ctx.tools.ffmpeg) reason = 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.';
      else if (!eng.any) reason = 'O motor de transcrição (Whisper) não está instalado. Instale-o na aba Legendas ou na aba Ferramentas.';
      else if (!installed) reason = `O modelo ${model.label} ainda não foi baixado. Baixe-o na aba Legendas.`;
      const hw = reason ? null : await hardwareStatus({ waitMs: 300 });
      return {
        ready: !reason, reason, modelId, modelLabel: model ? model.label : modelId,
        device: hw && hw.canUseGpu ? 'GPU' : 'CPU', busy: running.size > 0
      };
    }
  };

  ctx.handle('subtitles:generate', async (req) => {
    const { cutId, input } = req;
    const start = Number(req.start);
    const end = Number(req.end);
    const modelId = typeof req.modelId === 'string' && req.modelId ? req.modelId : DEFAULT_MODEL_ID;
    if (typeof cutId !== 'string' || !cutId) throw fail('INVALID_ARGS', 'Informe qual corte legendar.');
    if (typeof input !== 'string' || !input) throw fail('INVALID_ARGS', 'Informe o vídeo de origem.');
    const run = await prepareRun({
      key: cutId, modelId, engine: req.engine,
      onPrepare: (message) => ctx.send('subtitles:progress', { cutId, phase: 'prepare', percent: 1, message })
    });
    const { plan } = run;
    ctx.log('info', `legendas: gerando para o corte ${cutId} (${start.toFixed(1)}–${end.toFixed(1)} s, modelo ${modelId}, ${plan.useGpu ? 'placa' : 'processador'}${plan.why ? ` [${plan.why}]` : ''})`);
    try {
      const result = await generateSubtitles({
        ...run.genOptions,
        // Só o que o contrato do canal prevê (cutId, input, start, end, language, modelId, maxChars, engine): os limiares do silêncio
        // (`silence`) são um gancho de teste de generateSubtitles e NUNCA vêm do renderer (iriam parar no -af do ffmpeg).
        input, start, end, language: req.language, maxChars: req.maxChars,
        signal: run.controller.signal,
        onProgress: (ev) => ctx.send('subtitles:progress', { cutId, phase: ev.phase, percent: ev.percent, message: ev.message })
      });
      const described = describeRun(run, result);
      return { cutId, modelId, modelLabel: run.model.label, ...result, ...described };
    } finally {
      releaseRun(run);
    }
  });

  ctx.handle('subtitles:cancel', ({ cutId }) => {
    const run = running.get(cutId);
    if (run) run.controller.abort();
    return { cancelled: Boolean(run) };
  });

  // ---------- importar uma legenda existente ----------

  ctx.handle('subtitles:importFile', async ({ defaultDir }) => {
    const res = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      title: 'Escolha uma legenda (.srt ou .ass)',
      properties: ['openFile'],
      filters: [{ name: 'Legendas', extensions: ['srt', 'ass', 'ssa'] }],
      ...(typeof defaultDir === 'string' && defaultDir ? { defaultPath: defaultDir } : {})
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { canceled: true };
    const file = res.filePaths[0];
    let stat;
    try { stat = fs.statSync(file); } catch { throw fail('INPUT_MISSING', 'Não foi possível abrir o arquivo escolhido.'); }
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw fail('TOO_BIG', 'Esse arquivo é grande demais para ser uma legenda (limite de 5 MB).');
    const text = decodeText(fs.readFileSync(file));
    const ext = path.extname(file);
    const cues = parseSubtitleFile(text, ext);
    return { canceled: false, name: path.basename(file), format: ext.replace(/^\./, '').toLowerCase(), cues };
  });
}

module.exports = { register, decodeText };
