'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { probeMedia } = require('../../core/ffmpeg/probe');
const { newProject, projectIdFor } = require('../../core/projects/projectStore');
const projectFiles = require('../../core/projects/projectFiles');
const { ThumbnailCache, ID_RE: PROJECT_ID_RE } = require('../../core/projects/thumbnails');

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'ts'];

const DURATION_UNKNOWN_MESSAGE = 'Este arquivo não informa a duração (comum em gravações que não foram finalizadas, como quando o programa de gravação caiu). Dá para marcar cortes digitando os tempos, mas o app não confere se o fim passa do vídeo. Para corrigir o arquivo, reempacote-o (no OBS: Arquivo > Remux de Gravações) e abra a cópia.';

function problem(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Aceita `"caminho"` ou `{ path }` (e `{ path, origin }`). */
function sourceArgs(payload) {
  const input = typeof payload === 'string' ? { path: payload } : (payload || {});
  if (typeof input.path !== 'string' || !input.path) throw problem('INVALID_PATH', 'Informe o caminho do vídeo.');
  return input;
}

/** ffprobe do vídeo, com erros em português que dizem o que fazer. */
async function probeSource(ctx, sourcePath) {
  if (!ctx.tools.ffprobe) {
    throw problem('NO_FFPROBE', 'ffprobe não encontrado. Instale o FFmpeg e deixe-o no PATH (ou defina CORTE_FFPROBE) e use "Verificar de novo".');
  }
  if (!fs.existsSync(sourcePath)) throw problem('INPUT_MISSING', `O arquivo não foi encontrado: ${sourcePath}`);
  return probeMedia(ctx.tools.ffprobe, sourcePath);
}

/** Nome do projeto como a lista o mostra: o título da origem (VOD baixado) ou o nome do arquivo sem extensão. */
function titleOf(project) {
  const origin = project.source && project.source.origin;
  if (origin && origin.title) return String(origin.title);
  return path.basename(String((project.source && project.source.path) || ''), path.extname(String((project.source && project.source.path) || ''))) || 'Vídeo';
}

/**
 * Fontes, projetos salvos, adoção de projeto por outra fonte, miniaturas e exclusão de projeto.
 *
 * Canais novos (aba Projetos):
 *   project:thumbnail { id, path, size, duration }  -> { state:'ready', url } | { state:'missing' } | { state:'none', reason }
 *       miniatura do vídeo (um quadro tirado neste computador, guardado em userData/cache/thumbs); `id` precisa ser o do caminho informado
 *   project:deletePreview { id }                    -> { plan } o que seria apagado, em números (nada é apagado): cortes, arquivos de dados, exportações,
 *       vídeo e chat baixados pelo app, o que impede (`busy`: exportação na fila, análise ou transcrição em andamento)
 *   project:delete { id, files? }                   -> { result } apaga o projeto e os dados dele (cortes, histórico, transcrição, miniatura, rastro na fila);
 *       com `files: true` apaga também os cortes exportados (e as legendas ao lado) e o vídeo e o chat que o PRÓPRIO app baixou. O vídeo do
 *       usuário nunca é apagado. Recusa (PROJECT_BUSY) se há trabalho em andamento sobre o projeto. Veja src/core/projects/projectFiles.js.
 */
function register(ctx) {
  const store = ctx.projectStore;
  const thumbs = new ThumbnailCache({ dir: path.join(ctx.paths.cache, 'thumbs'), getFfmpeg: () => ctx.tools.ffmpeg });
  const dataDirs = () => ({ history: path.join(ctx.paths.userData, 'history'), transcripts: path.join(ctx.paths.userData, 'transcripts'), thumbs: thumbs.dir });
  const deleting = new Set(); // projetos sendo apagados: project:save recusa gravá-los (nada recria o arquivo no meio da exclusão)

  ctx.handle('source:pick', async () => {
    const res = await ctx.dialog.showOpenDialog(ctx.getWindow(), {
      title: 'Escolher vídeo (gravação do OBS, gameplay ou live)',
      properties: ['openFile'],
      filters: [{ name: 'Vídeos', extensions: VIDEO_EXTENSIONS }]
    });
    return res.canceled ? { canceled: true } : { path: res.filePaths[0] };
  });

  // abre (ou cria) o projeto do vídeo: { path, origin? } -> { info, project, restored, url, recovered?, warnings? }
  //  - recovered: o arquivo do projeto estava corrompido ({ file (guardado como .corrupt), restoredFromBackup, backupAt }); a
  //    interface precisa AVISAR, porque sem isso o usuário veria os cortes sumirem sem explicação;
  //  - warnings: avisos que não impedem de abrir ([{ code, message }]), hoje só DURATION_UNKNOWN.
  ctx.handle('source:open', async (payload) => {
    const { path: sourcePath, origin } = sourceArgs(payload);
    const info = await probeSource(ctx, sourcePath);
    const media = { size: info.size, duration: info.duration, width: info.width, height: info.height };
    const loaded = store.loadDetailed(sourcePath);
    let project = loaded.project;
    const restored = Boolean(project);
    if (!project) {
      project = store.save(newProject(sourcePath, info, origin || null));
    } else {
      project = store.save({
        ...project,
        source: { ...project.source, ...media, origin: project.source.origin || origin || null }
      });
    }
    const out = { info, project, restored, url: pathToFileURL(path.resolve(sourcePath)).href };
    if (loaded.recovered) out.recovered = loaded.recovered;
    if (!(info.duration > 0)) out.warnings = [{ code: 'DURATION_UNKNOWN', message: DURATION_UNKNOWN_MESSAGE }];
    return out;
  });

  // o renderer é o único que grava o projeto
  ctx.handle('project:save', ({ project }) => {
    if (!project || typeof project !== 'object' || !project.source || typeof project.source.path !== 'string') {
      throw problem('INVALID_PROJECT', 'Projeto inválido: não foi possível salvar.');
    }
    if (deleting.has(projectIdFor(project.source.path))) throw problem('PROJECT_DELETING', 'Este projeto está sendo apagado: nada foi salvo.');
    return { project: store.save(project) };
  });

  // lista de projetos: cada um com o aviso de "arquivo do vídeo não encontrado" (movido/apagado), sem tocar em nada
  ctx.handle('project:list', () => ({
    projects: store.list().map((p) => {
      let fileMissing = false;
      try { fileMissing = !(p.source && p.source.path && require('node:fs').statSync(p.source.path).isFile()); } catch { fileMissing = true; }
      return { ...p, fileMissing };
    })
  }));

  // copia cortes/decisões de um projeto salvo (por id ou pelo caminho do vídeo antigo) para outro vídeo
  ctx.handle('project:adopt', async ({ fromId, fromPath, path: newPath, origin }) => {
    if (typeof newPath !== 'string' || !newPath) throw problem('INVALID_PATH', 'Informe o caminho do vídeo novo.');
    const existing = fromId ? store.loadById(fromId) : (typeof fromPath === 'string' && fromPath ? store.load(fromPath) : null);
    if (!existing) throw problem('PROJECT_NOT_FOUND', 'O projeto de origem não foi encontrado.');
    const info = await probeSource(ctx, newPath);
    const project = store.adopt(existing, newPath, { info, origin });
    return { project, info, url: pathToFileURL(path.resolve(newPath)).href };
  });

  // ---------- miniaturas ----------

  ctx.handle('project:thumbnail', async (payload) => {
    const { id, path: sourcePath, size, duration } = payload || {};
    if (typeof id !== 'string' || !PROJECT_ID_RE.test(id) || typeof sourcePath !== 'string' || !sourcePath || projectIdFor(sourcePath) !== id) {
      throw problem('INVALID_ARGS', 'Informe o projeto (o id e o caminho do vídeo dele).');
    }
    const res = await thumbs.get({ id, path: sourcePath, size, duration });
    return res.state === 'ready' ? { state: 'ready', url: res.url } : { state: res.state, ...(res.reason ? { reason: res.reason } : {}) };
  });

  // ---------- apagar o projeto ----------

  /**
   * Caminhos (normPath) dos cortes exportados que os OUTROS projetos anotaram. Um arquivo que mais de um projeto cita (um "substituir" no
   * conflito de nome, por exemplo) não é só deste: fica. Só lê os outros projetos que têm exportação anotada.
   */
  function exportsOfOthers(id, summaries) {
    const out = new Set();
    for (const summary of summaries) {
      if (summary.id === id || !summary.exportedCount) continue;
      const other = store.peekById(summary.id).project;
      for (const cut of (other && other.cuts) || []) {
        for (const entry of Array.isArray(cut.exports) ? cut.exports : []) {
          if (entry && typeof entry.path === 'string' && entry.path) out.add(projectFiles.normPath(entry.path));
        }
      }
    }
    return out;
  }

  /**
   * O que a exclusão apagaria, em listas completas (para apagar de verdade) — sem alterar nada em disco (por isso lê com `peekById`, que
   * não separa arquivo corrompido). Projeto que não pôde ser lido ainda pode ser apagado: só os dados dele (`unreadable`).
   */
  async function planDeletion(id) {
    if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) throw problem('INVALID_ARGS', 'Informe o projeto.');
    const peek = store.peekById(id);
    const project = peek.project || null;
    if (!project && !fs.existsSync(path.join(store.dir, `${id}.json`))) throw problem('PROJECT_NOT_FOUND', 'Este projeto não existe mais.');
    const plan = { id, project, data: await projectFiles.dataFiles(id, dataDirs()), exports: { files: [], missing: 0 }, download: null, busy: null };
    if (project) {
      plan.busy = ctx.projectBusy ? ctx.projectBusy(project) : null;
      const summaries = store.list();
      const protectedPaths = new Set(summaries.map((p) => projectFiles.normPath(p.source.path))); // o vídeo de origem de qualquer projeto nunca é "corte exportado"
      if (project.cuts.some((c) => Array.isArray(c.exports) && c.exports.length)) {
        for (const shared of exportsOfOthers(id, summaries)) protectedPaths.add(shared); // nem um arquivo que outro projeto também anotou
      }
      plan.exports = await projectFiles.exportFiles(project, { protectedPaths });
      const record = ctx.sources && typeof ctx.sources.downloadRecord === 'function' ? ctx.sources.downloadRecord(project.source.path) : null;
      plan.download = await projectFiles.downloadFiles(project, record);
    }
    return plan;
  }

  /** O plano em números, para a interface decidir (sem caminhos de cortes, só contagens e tamanhos). */
  function describePlan(plan) {
    const project = plan.project;
    const cuts = { total: 0, pending: 0, approved: 0, rejected: 0 };
    for (const cut of project ? project.cuts : []) {
      cuts.total += 1;
      if (cut.status in cuts) cuts[cut.status] += 1;
    }
    const exported = plan.exports.files.filter((f) => f.kind === 'export');
    const sidecars = plan.exports.files.filter((f) => f.kind === 'sidecar');
    const video = plan.download && plan.download.video;
    const chat = plan.download && plan.download.chat;
    return {
      id: plan.id,
      title: project ? titleOf(project) : '',
      unreadable: !project,
      cuts,
      busy: plan.busy,
      data: { files: plan.data.length, bytes: projectFiles.sumBytes(plan.data) },
      exports: { files: exported.length, sidecars: sidecars.length, bytes: projectFiles.sumBytes(plan.exports.files), missing: plan.exports.missing },
      download: plan.download ? { video: video ? { name: path.basename(video.file), bytes: video.bytes } : null, chat: chat ? { name: path.basename(chat.file), bytes: chat.bytes } : null } : null,
      // o vídeo de origem fica no lugar quando o app não o baixou (é do usuário) ou quando ele já não existe
      keepsSource: Boolean(project) && !video,
      sourceName: project ? path.basename(project.source.path) : ''
    };
  }

  ctx.handle('project:deletePreview', async (payload) => ({ plan: describePlan(await planDeletion((payload || {}).id)) }));

  ctx.handle('project:delete', async (payload) => {
    const { id, files: withFiles } = payload || {};
    const plan = await planDeletion(id);
    if (plan.busy) throw problem('PROJECT_BUSY', plan.busy);
    if (deleting.has(id)) throw problem('PROJECT_DELETING', 'Este projeto já está sendo apagado.');
    deleting.add(id);
    try {
      thumbs.cancel(id); // um ffmpeg lendo o vídeo para a miniatura não pode segurar o arquivo
      const failed = [];
      const removed = { exports: 0, sidecars: 0, video: 0, chat: 0, dataFiles: 0, bytes: 0 };
      const count = (items) => {
        for (const item of items) {
          removed.bytes += item.bytes || 0;
          if (item.kind === 'export') removed.exports += 1;
          else if (item.kind === 'sidecar') removed.sidecars += 1;
          else if (item.kind === 'video') removed.video += 1;
          else if (item.kind === 'chat') removed.chat += 1;
          else removed.dataFiles += 1;
        }
      };
      const fail = (items) => failed.push(...items.map((f) => ({ name: path.basename(f.file), message: f.message })));
      const outputs = [];

      if (withFiles === true && plan.project) {
        const exported = await projectFiles.removeAll(plan.exports.files);
        count(exported.removed);
        fail(exported.failed);
        outputs.push(...exported.removed.filter((f) => f.kind === 'export').map((f) => f.file));
        if (exported.removed.some((f) => f.kind === 'export')) await projectFiles.pruneDefaultExportDir(plan.project);
        if (plan.download) {
          const items = [plan.download.video && { kind: 'video', ...plan.download.video }, plan.download.chat && { kind: 'chat', ...plan.download.chat }].filter(Boolean);
          const downloaded = await projectFiles.removeAll(items);
          count(downloaded.removed);
          fail(downloaded.failed);
          if (downloaded.removed.some((f) => f.kind === 'video') && ctx.sources && typeof ctx.sources.forgetDownload === 'function') ctx.sources.forgetDownload(plan.project.source.path);
        }
      }

      if (plan.project && ctx.queue && typeof ctx.queue.forgetProject === 'function') {
        try { ctx.queue.forgetProject({ projectId: id, sourcePath: plan.project.source.path, outputs }); } catch (err) { ctx.log('warn', `fila: não consegui limpar o rastro do projeto apagado (${err.message})`); }
      }

      const data = await projectFiles.removeAll(plan.data);
      count(data.removed);
      fail(data.failed);
      const stored = store.remove(id); // o arquivo do projeto é o último a sair
      removed.dataFiles += stored.files;
      removed.bytes += stored.bytes;
      failed.push(...stored.failed.map((f) => ({ name: f.name, message: f.message })));
      const projectRemoved = !fs.existsSync(path.join(store.dir, `${id}.json`));
      ctx.log('info', `projeto ${id} apagado (${removed.exports} corte(s) exportado(s), ${removed.video} vídeo(s) baixado(s), ${removed.dataFiles} arquivo(s) de dados${failed.length ? `, ${failed.length} falha(s)` : ''})`);
      return { result: { projectRemoved, removed, failed, keptSource: !(plan.download && plan.download.video && removed.video) } };
    } finally {
      deleting.delete(id);
    }
  });
}

module.exports = { register, VIDEO_EXTENSIONS };
