'use strict';

const path = require('node:path');
const { AnalysisManager, AnalysisError, DEFAULTS, RANGES, ALGO_VERSION } = require('../../core/analysis');
const { registerAiChannels } = require('../../core/analysis/ai/ipc');
const { sameSource } = require('../../core/analysis/transcript/format');

/**
 * Análise de momentos interessantes (dono: analysis). Canais:
 *   analysis:defaults                    -> { defaults, ranges, version }
 *   analysis:start  { path, params?, chatPath?, fresh?, engine?, projectId?, size?, duration? } -> { jobId }   (roda em segundo plano; uma por vez; fresh:true ignora o cache)
 *       engine 'algorithm' (padrão) ou 'ai' (IA na nuvem: exige também projectId, size, duration, meta?, existingCuts?).
 *       No algoritmo, `projectId` (com size e duration) faz o processo principal procurar a transcrição do vídeo (userData/transcripts) e,
 *       se ela vale para este arquivo, usá-la como sinal de TEXTO; sem ela o algoritmo segue com áudio, imagem e chat.
 *   analysis:cancel { jobId? }           -> { cancelled }
 *   analysis:status                      -> { running: { jobId, path, startedAt, p, stage, message, engine? } | null }
 * Eventos (main -> renderer): analysis:progress { jobId, p, stage, message },
 *   analysis:done { jobId, result }, analysis:failed { jobId, code, message, details? } (inclui CANCELLED). Os dois motores usam os mesmos eventos.
 * A IA na nuvem e a transcrição do vídeo têm canais próprios (src/core/analysis/ai/ipc.js).
 * O handler nunca grava o projeto: quem aplica o resultado (cortes `origin:'auto'`, sempre pendentes) é o renderer.
 * ffmpeg/ffprobe vêm só do sistema; por isso não há registro em ctx.toolUsage (só vale para ferramentas
 * instaladas pelo app).
 */
function register(ctx) {
  const manager = new AnalysisManager({
    getTools: () => ctx.tools,
    cacheDir: path.join(ctx.paths.cache, 'analysis')
  });

  manager.on('progress', (ev) => ctx.send('analysis:progress', ev));
  manager.on('done', (ev) => ctx.send('analysis:done', ev));
  manager.on('failed', (ev) => {
    if (ev.code !== 'CANCELLED') ctx.log('warn', `analysis: ${ev.message} (${ev.code})`);
    ctx.send('analysis:failed', ev);
  });

  const ai = registerAiChannels(ctx);
  ctx.analysis = { manager, ai }; // os gerenciadores, para quem precisa saber o que está rodando (e para os testes)

  // Apagar o projeto espera a análise que lê o vídeo dele e a transcrição que vai gravá-lo (o resultado criaria um arquivo de projeto apagado).
  if (Array.isArray(ctx.busyChecks)) {
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
    ctx.busyChecks.push((project) => {
      const running = manager.status() || ai.aiManager.status();
      if (running && same(running.path, project.source && project.source.path)) return 'Há uma análise deste vídeo em andamento. Cancele-a na aba Análise antes de apagar o projeto.';
      const transcribing = ai.transcriptManager.status();
      if (transcribing && transcribing.projectId === project.id) return 'A transcrição deste vídeo está sendo gerada. Cancele-a na aba Análise antes de apagar o projeto.';
      return null;
    });
  }

  /** Transcrição guardada do projeto, só se vale para ESTE arquivo (mesmo caminho, tamanho e duração). { cues } | { cues: [], stale: true } | null. */
  function transcriptFor(payload) {
    if (!payload || typeof payload.projectId !== 'string' || !payload.projectId) return null;
    try {
      const doc = ai.store.get(payload.projectId);
      if (!doc) return null;
      const source = { path: String(payload.path || ''), size: Number(payload.size) || 0, duration: Number(payload.duration) || 0 };
      return sameSource(doc.source, source) ? { cues: doc.cues } : { cues: [], stale: true };
    } catch { return null; } // identificador inválido ou arquivo ilegível: segue sem texto
  }

  ctx.handle('analysis:defaults', () => ({ defaults: DEFAULTS, ranges: RANGES, version: ALGO_VERSION }));
  ctx.handle('analysis:start', (payload) => {
    if (manager.status() || ai.aiManager.status()) throw new AnalysisError('BUSY', 'Já existe uma análise em andamento. Espere terminar ou cancele-a.');
    if (payload && payload.engine === 'ai') return ai.aiManager.start(payload);
    return manager.start({ ...payload, transcript: transcriptFor(payload) });
  });
  ctx.handle('analysis:cancel', (payload) => {
    const jobId = payload && payload.jobId;
    return { cancelled: manager.cancel(jobId) || ai.aiManager.cancel(jobId) };
  });
  ctx.handle('analysis:status', () => ({ running: manager.status() || ai.aiManager.status() }));

  if (ctx.app && typeof ctx.app.on === 'function') {
    ctx.app.on('before-quit', () => { manager.killAll(); ai.aiManager.killAll(); ai.transcriptManager.killAll(); });
  }
  return manager;
}

module.exports = { register };
