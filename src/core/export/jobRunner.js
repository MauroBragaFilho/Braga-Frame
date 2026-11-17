'use strict';

/**
 * Executa um trabalho de exportação (contrato 3.3 de docs/arquitetura.md):
 *
 *   runExportJob(job, { tools, onProgress(0..1), signal, tmpDir, onStart? })
 *     -> { output, warnings:[{code,message}], skipped?, encoder, sizeBytes }   ou lança ExportError(code, message, details)
 *
 * Monta o filtro de vídeo (enquadramento + legenda queimada), o de áudio, escolhe o codificador
 * (auto/software/NVENC, com queda para software e aviso), grava em "<saída>.mp4.part" e só renomeia
 * ao concluir. Nada existente é sobrescrito ou apagado sem escolha explícita (`onConflict: 'replace'`,
 * que troca o arquivo de forma atômica SÓ depois do sucesso). Cancelar (signal) mata o ffmpeg e
 * limpa o .part.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { validateProfile } = require('./profiles');
const { resolveFraming, buildVideoGraph } = require('./framing');
const encoders = require('./encoders');
const { sanitizeFileName } = require('./naming');
const optional = require('./optional');
const { lowerPriority } = require('../system/resources');
const { probeMedia } = require('../ffmpeg/probe');

/** Códigos que a fila pode tentar de novo; os demais não adiantam repetir. */
const RECOVERABLE_CODES = Object.freeze(['FFMPEG_START_FAILED', 'IO_BUSY', 'FFMPEG_CRASH', 'DISK_TRANSIENT']);
const NON_RECOVERABLE_CODES = Object.freeze([
  'INPUT_MISSING', 'INVALID_PROFILE', 'INVALID_RANGE', 'NO_DISK_SPACE', 'OUTPUT_EXISTS', 'CANCELLED', 'CODEC_UNSUPPORTED',
  // além do contrato (pedido de contrato em docs/recursos/exportEngine.md)
  'NO_FFMPEG', 'FFMPEG_FAILED', 'OUTPUT_NOT_WRITABLE', 'SUBTITLES_FAILED', 'AUDIO_FAILED', 'OUTPUT_INVALID'
]);
const STDERR_TAIL = 4000;

/** O que fazer, por código (vai em `details.solution`; a fila mostra junto da mensagem). */
const SOLUTIONS = Object.freeze({
  NO_FFMPEG: 'Instale o FFmpeg pela página oficial (ffmpeg.org/download.html), deixe-o no PATH (ou defina CORTE_FFMPEG) e use "Verificar de novo".',
  FFMPEG_FAILED: 'Veja os detalhes técnicos. Se o erro mencionar um filtro ou codificador, use um FFmpeg completo (build "full"); se mencionar o vídeo, confira se ele abre em outro programa.',
  OUTPUT_NOT_WRITABLE: 'Escolha outra pasta de destino na aba Exportar, onde você tenha permissão para gravar.',
  SUBTITLES_FAILED: 'Revise as legendas deste corte na aba Legendas, ou desative-as para exportar sem legenda.',
  AUDIO_FAILED: 'Revise os ajustes de áudio deste corte na aba Áudio.',
  OUTPUT_INVALID: 'Tente exportar de novo; se repetir, confira o espaço e a saúde do disco de destino.'
});

class ExportError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.recoverable = RECOVERABLE_CODES.includes(code);
    const solution = SOLUTIONS[code];
    if (details !== undefined || solution) this.details = { ...(solution ? { solution } : {}), ...details };
  }
}

// ---------- destino (nome, conflito, publicação) ----------

/** Destinos em uso por trabalhos deste processo (dois trabalhos nunca gravam o mesmo arquivo). */
const reserved = new Set();
const keyOf = (file) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

function removeFile(file) {
  try { fs.rmSync(file, { force: true, maxRetries: 10, retryDelay: 150 }); } catch { /* não deu: segue */ }
}

/**
 * Escolhe o arquivo de saída e o reserva. `onConflict` já resolvido:
 *  - rename: "nome.mp4", "nome (2).mp4"…;  replace: usa o nome (troca ao concluir);
 *  - skip: devolve { skipped, existing };  fail: OUTPUT_EXISTS.
 * Um ".part" sem dono (sobra de uma execução interrompida) é arquivo nosso: é descartado.
 */
function reserveTarget(outputDir, baseName, onConflict, sourcePath) {
  const safe = sanitizeFileName(baseName);
  for (let i = 1; i < 10000; i++) {
    const final = path.join(outputDir, `${safe}${i === 1 ? '' : ` (${i})`}.mp4`);
    const part = `${final}.part`;
    const key = keyOf(final);
    if (sourcePath && key === keyOf(sourcePath)) {
      throw new ExportError('OUTPUT_EXISTS', 'O arquivo de destino seria o próprio vídeo de origem; nada foi gravado.', { path: final });
    }
    const busy = reserved.has(key);
    const exists = fs.existsSync(final);
    if (!busy && fs.existsSync(part)) removeFile(part);
    if (!busy && !exists) {
      reserved.add(key);
      return { final, part, key, replacing: false };
    }
    if (onConflict === 'rename') continue;
    if (onConflict === 'skip' && exists && !busy) return { skipped: true, existing: final };
    if (onConflict === 'replace' && exists && !busy) {
      reserved.add(key);
      return { final, part, key, replacing: true };
    }
    throw new ExportError('OUTPUT_EXISTS',
      busy ? `Outra exportação está gravando "${path.basename(final)}" agora.` : `Já existe um arquivo chamado "${path.basename(final)}" na pasta de destino.`,
      { path: final });
  }
  throw new ExportError('OUTPUT_EXISTS', 'Não foi possível encontrar um nome livre para o arquivo na pasta de destino.');
}

/**
 * Publica o .part como arquivo final SEM sobrescrever (link físico que falha se o nome já existe; onde o
 * sistema de arquivos não tem links, confere e renomeia). Com `replace`, troca de forma atômica.
 * Devolve o caminho final (em `rename`, outro nome se o escolhido surgiu no meio do caminho).
 */
function publish(target, onConflict) {
  const { part } = target;
  let { final } = target;
  if (target.replacing) {
    fs.renameSync(part, final);
    return final;
  }
  for (let attempt = 0; attempt < 1000; attempt++) {
    try {
      fs.linkSync(part, final);
      removeFile(part);
      return final;
    } catch (err) {
      if (err.code === 'EEXIST') {
        if (onConflict !== 'rename') throw new ExportError('OUTPUT_EXISTS', `O arquivo "${path.basename(final)}" surgiu durante a exportação; nada foi sobrescrito.`, { path: final });
        final = nextFreeName(final);
        continue;
      }
      // sem suporte a links (exFAT, rede…): confere e renomeia
      if (fs.existsSync(final)) {
        if (onConflict !== 'rename') throw new ExportError('OUTPUT_EXISTS', `O arquivo "${path.basename(final)}" surgiu durante a exportação; nada foi sobrescrito.`, { path: final });
        final = nextFreeName(final);
        continue;
      }
      fs.renameSync(part, final);
      return final;
    }
  }
  throw new ExportError('OUTPUT_EXISTS', 'Não foi possível encontrar um nome livre para o arquivo na pasta de destino.');
}

function nextFreeName(final) {
  const dir = path.dirname(final);
  const ext = path.extname(final);
  const stem = path.basename(final, ext).replace(/ \((\d+)\)$/, '');
  for (let i = 2; i < 10000; i++) {
    const candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate) && !reserved.has(keyOf(candidate))) return candidate;
  }
  throw new ExportError('OUTPUT_EXISTS', 'Não foi possível encontrar um nome livre para o arquivo na pasta de destino.');
}

/** Copia legendas externas para ao lado do vídeo, sem sobrescrever nada. Devolve avisos. */
function copySidecars(sidecars, finalVideo) {
  const warnings = [];
  const stem = finalVideo.slice(0, -path.extname(finalVideo).length);
  for (const item of Array.isArray(sidecars) ? sidecars : []) {
    if (!item || typeof item.path !== 'string' || !item.path) continue;
    const ext = String(item.ext || path.extname(item.path)).replace(/^\./, '');
    if (!ext) continue;
    const target = `${stem}.${ext}`;
    try {
      if (fs.existsSync(target)) {
        const same = fs.statSync(target).size === fs.statSync(item.path).size && fs.readFileSync(target).equals(fs.readFileSync(item.path));
        if (!same) warnings.push({ code: 'SIDECAR_EXISTS', message: `Já existe "${path.basename(target)}" ao lado do vídeo e ele foi mantido (não foi sobrescrito); o arquivo de legenda novo não foi copiado.` });
        continue;
      }
      fs.copyFileSync(item.path, target, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      warnings.push({ code: 'SIDECAR_FAILED', message: `Não foi possível copiar o arquivo de legenda "${path.basename(target)}" (${err.message}).` });
    }
  }
  return warnings;
}

// ---------- ffmpeg ----------

/** Canais da primeira faixa de áudio (ffprobe); 0 se não deu para saber (o export segue como antes). */
function audioChannels(ffprobe, file) {
  return new Promise((resolve) => {
    if (!ffprobe) { resolve(0); return; }
    execFile(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0', file],
      { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? 0 : (Number.parseInt(String(stdout).trim(), 10) || 0)));
  });
}

/**
 * Fonte MONO: o "-ac 2" do ffmpeg sozinho põe o canal nos dois lados com -3 dB (preserva a potência), e o arquivo sairia 3 dB
 * mais baixo que o trecho original: o ganho de +6 dB pedido na aba Áudio valeria só +3 dB. Duplicar o canal sem perda mantém
 * "nível exportado = nível medido na fonte + ganho". Fontes estéreo (ou com mais canais) seguem pelo caminho de sempre.
 */
const MONO_TO_STEREO = 'pan=stereo|c0=c0|c1=c0';

function secondsArg(sec) {
  return String(Number(sec.toFixed(3)));
}

function buildFfmpegArgs({ input, output, start, duration, graph, audioFilter, withAudio, encoderArgs }) {
  return [
    '-hide_banner', '-nostdin', '-n', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-ss', secondsArg(start), '-t', secondsArg(duration), '-i', input,
    '-filter_complex', graph, '-map', '[vout]',
    ...(withAudio ? ['-map', '0:a:0?'] : ['-an']),
    ...encoderArgs,
    ...(withAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', ...(audioFilter ? ['-af', audioFilter] : [])] : []),
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-movflags', '+faststart', '-f', 'mp4', output
  ];
}

/** `-threads N` do codificador quando a fila pede um limite de núcleos (0 ou ausente: o ffmpeg decide). */
function threadArgs(limits) {
  const n = limits && Number.isInteger(limits.threads) ? limits.threads : 0;
  return n > 0 ? ['-threads', String(n)] : [];
}

/** O `onStart` do ffmpeg, com a prioridade baixa aplicada ao processo quando a fila pede (melhor esforço). */
function withPriority(onStart, limits) {
  if (!limits || limits.lowPriority !== true) return onStart;
  return (info) => {
    lowerPriority(info && info.pid);
    if (typeof onStart === 'function') onStart(info);
  };
}

/** Roda o ffmpeg. Resolve { code, signal, stderr, aborted }; rejeita só se o processo nem iniciou. */
function runFfmpeg(ffmpeg, args, { signal, onProgress, totalSec, onStart }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new ExportError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`, { path: ffmpeg }));
      return;
    }
    let stderr = '';
    let buffer = '';
    let aborted = false;
    let last = -1;
    const kill = () => { aborted = true; try { child.kill(); } catch { /* já terminou */ } };
    const onAbort = () => kill();
    if (signal) {
      if (signal.aborted) kill(); else signal.addEventListener('abort', onAbort, { once: true });
    }
    if (typeof onStart === 'function' && child.pid) {
      try { onStart({ pid: child.pid }); } catch { /* observador não pode derrubar a exportação */ }
    }
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (!m || !onProgress || !(totalSec > 0)) continue;
        const p = Math.min(0.999, Number(m[1]) / 1e6 / totalSec);
        if (p - last >= 0.002) { last = p; try { onProgress(p); } catch { /* idem */ } }
      }
    });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new ExportError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: ${err.message}`, { path: ffmpeg }));
    });
    child.on('close', (code, sig) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, signal: sig, stderr, aborted });
    });
  });
}

/**
 * O ffmpeg "caiu" de verdade (e repetir pode resolver)? Só quando o sistema o matou por sinal ou, no Windows, quando saiu com
 * uma exceção do sistema (NTSTATUS 0xC000xxxx: violação de acesso 0xC0000005, estouro de pilha 0xC00000FD, 0xC0000409…).
 * Uma falha comum do ffmpeg NÃO é queda: ele sai com um AVERROR (negativo, que o Windows entrega sem sinal, p. ex. 4294967274
 * para "Invalid argument" ou 3015096584 para "filtro não encontrado"), e repetir a mesma coisa daria o mesmo erro.
 */
function isCrashExit(code, signal) {
  if (signal) return true;
  if (typeof code !== 'number' || !Number.isFinite(code)) return false;
  return ((code >>> 0) >>> 16) === 0xC000;
}

/** Transforma o fracasso do ffmpeg em ExportError com causa e solução. */
function classifyFailure({ code, signal, stderr }) {
  const s = stderr || '';
  const details = { exitCode: code, signal: signal || null, stderr: s };
  if (/No space left on device|ENOSPC|not enough space on the disk|disk is full/i.test(s)) {
    return new ExportError('NO_DISK_SPACE', 'O disco ficou sem espaço durante a exportação. Libere espaço (ou escolha outra pasta de destino) e tente de novo; nada foi deixado pela metade.', details);
  }
  if (/Permission denied|Access is denied|being used by another process|Device or resource busy|Resource busy|EBUSY|EACCES/i.test(s)) {
    return new ExportError('IO_BUSY', 'O arquivo ou a pasta de destino está em uso por outro programa (ou sem permissão). Feche o que estiver usando e tente de novo.', details);
  }
  if (/Input\/output error|Error writing trailer|I\/O error|Error closing file|Broken pipe/i.test(s)) {
    return new ExportError('DISK_TRANSIENT', 'Houve um erro de leitura ou gravação no disco durante a exportação. Confira o disco (ou a conexão, se for externo ou de rede) e tente de novo.', details);
  }
  if (/Unknown encoder|Encoder .* not found|Error selecting an encoder|Unrecognized option|Option .* not found|No such filter/i.test(s)) {
    return new ExportError('CODEC_UNSUPPORTED', 'Este FFmpeg não suporta o codificador ou o filtro necessário. Use um FFmpeg completo (build "full", com libx264, libx265 e libass).', details);
  }
  if (/Invalid data found when processing input|moov atom not found|Error opening input|could not find codec parameters/i.test(s)) {
    return new ExportError('INPUT_MISSING', 'O vídeo de origem não pôde ser lido (o arquivo sumiu, está corrompido ou não está disponível). Confira o arquivo e abra-o de novo.', details);
  }
  if (/Stream specifier .*matches no streams|Stream map .*matches no streams|does not contain any stream/i.test(s)) {
    return new ExportError('FFMPEG_FAILED', 'O arquivo de origem não tem uma faixa de vídeo que o ffmpeg consiga usar (talvez seja só áudio). Repetir não resolve.', {
      ...details, solution: 'Abra um vídeo de verdade no app (com imagem). Se este arquivo deveria ter imagem, confira se ele abre em outro programa.'
    });
  }
  if (isCrashExit(code, signal)) {
    return new ExportError('FFMPEG_CRASH', 'O ffmpeg encerrou de forma inesperada durante a exportação. Tentar de novo costuma resolver.', details);
  }
  return new ExportError('FFMPEG_FAILED', 'O ffmpeg não conseguiu exportar este corte. Veja os detalhes técnicos do erro.', details);
}

// ---------- verificação ----------

async function verifyOutput(file, profile, expectedSec, ffprobe) {
  const warnings = [];
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* trata abaixo */ }
  if (!size) throw new ExportError('OUTPUT_INVALID', 'O ffmpeg terminou, mas o arquivo gerado está vazio. Tente exportar de novo.');
  if (!ffprobe) return { warnings, size };
  let info;
  try {
    info = await probeMedia(ffprobe, file);
  } catch (err) {
    throw new ExportError('OUTPUT_INVALID', `O arquivo gerado não pôde ser lido na verificação final (${err.message}). Tente exportar de novo.`);
  }
  if (info.width !== profile.width || info.height !== profile.height) {
    throw new ExportError('OUTPUT_INVALID', `O arquivo gerado tem ${info.width}×${info.height}, e o perfil pede ${profile.width}×${profile.height}. Tente exportar de novo.`);
  }
  if (Math.abs(info.duration - expectedSec) > Math.max(1, expectedSec * 0.05)) {
    warnings.push({ code: 'DURATION_MISMATCH', message: `O arquivo exportado tem ${info.duration.toFixed(1)} s e o corte tem ${expectedSec.toFixed(1)} s. Confira o resultado antes de publicar.` });
  }
  return { warnings, size };
}

// ---------- entrada principal ----------

function checkJob(job, tools) {
  if (!job || typeof job !== 'object') throw new ExportError('INVALID_RANGE', 'Trabalho de exportação inválido.');
  if (!tools || !tools.ffmpeg) {
    throw new ExportError('NO_FFMPEG', 'ffmpeg não encontrado. Instale o FFmpeg (ffmpeg.org/download.html), deixe-o no PATH ou defina CORTE_FFMPEG e use "Verificar de novo".');
  }
  if ((tools.ffmpeg.includes('/') || tools.ffmpeg.includes('\\')) && !fs.existsSync(tools.ffmpeg)) {
    throw new ExportError('FFMPEG_START_FAILED', `Não foi possível iniciar o ffmpeg: o arquivo "${tools.ffmpeg}" não existe mais. Use "Verificar de novo" no aviso do topo.`, { path: tools.ffmpeg });
  }
  const { profile, errors } = validateProfile(job.profile);
  if (errors.length) throw new ExportError('INVALID_PROFILE', errors.join(' '), { errors });
  const cut = job.cut && typeof job.cut === 'object' ? job.cut : {};
  const start = Number(cut.start);
  const end = Number(cut.end);
  if (!(start >= 0) || !(end > start)) throw new ExportError('INVALID_RANGE', 'O fim do corte precisa ser maior que o início.', { start: cut.start, end: cut.end });
  const info = job.sourceInfo && typeof job.sourceInfo === 'object' ? job.sourceInfo : {};
  if (Number(info.duration) > 0 && end > Number(info.duration) + 0.25) {
    throw new ExportError('INVALID_RANGE', 'O corte termina depois do fim do vídeo. Ajuste o fim do corte.', { end, duration: info.duration });
  }
  const sourcePath = typeof job.sourcePath === 'string' ? job.sourcePath : '';
  let stat = null;
  try { stat = fs.statSync(sourcePath); } catch { /* tratado abaixo */ }
  if (!stat || !stat.isFile()) throw new ExportError('INPUT_MISSING', 'O arquivo de origem não foi encontrado.', { path: sourcePath });
  if (typeof job.outputDir !== 'string' || !job.outputDir) throw new ExportError('OUTPUT_NOT_WRITABLE', 'A pasta de destino não foi informada.');
  return { profile, cut, start, end, info, sourcePath };
}

function ensureOutputDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    const busy = err.code === 'EBUSY';
    throw new ExportError(busy ? 'IO_BUSY' : 'OUTPUT_NOT_WRITABLE',
      `Não foi possível usar a pasta de destino "${dir}" (${err.message}). Escolha uma pasta onde seja possível gravar.`, { path: dir });
  }
}

/**
 * @param {object} job  Job (contrato 3.3). `onConflict` precisa vir resolvido: rename|replace|skip|fail.
 * @param {{tools:{ffmpeg:string,ffprobe?:string}, onProgress?:(p:number)=>void, signal?:AbortSignal, tmpDir?:string, onStart?:(x:{pid:number})=>void}} opts
 */
async function runExportJob(job, { tools, onProgress, signal, tmpDir, onStart, limits } = {}) {
  const { profile, cut, start, end, info, sourcePath } = checkJob(job, tools);
  const warnings = [];
  const duration = end - start;
  const cancelled = () => new ExportError('CANCELLED', 'Exportação cancelada.');
  if (signal && signal.aborted) throw cancelled();

  const onConflict = ['rename', 'replace', 'skip', 'fail'].includes(job.onConflict) ? job.onConflict : 'fail';
  ensureOutputDir(job.outputDir);
  const target = reserveTarget(job.outputDir, job.baseName, onConflict, sourcePath);
  if (target.skipped) {
    return {
      output: target.existing, skipped: true, encoder: null, sizeBytes: 0,
      warnings: [{ code: 'SKIPPED', message: `"${path.basename(target.existing)}" já existe e foi mantido: este corte foi pulado.` }]
    };
  }

  let ownTmp = null;
  try {
    // ----- legendas e áudio (módulos opcionais de outros recursos) -----
    let workDir = tmpDir;
    const loadedBurn = optional.burnIn();
    let burn = null;
    if (cut.subtitles && typeof cut.subtitles === 'object' && cut.subtitles.enabled) {
      const fn = loadedBurn.module && (loadedBurn.module.prepareBurnIn || loadedBurn.module.default);
      if (typeof fn === 'function') {
        if (!workDir) { ownTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-export-')); workDir = ownTmp; }
        try {
          burn = await fn(cut, { tmpDir: workDir, width: profile.width, height: profile.height, ffmpegPath: tools.ffmpeg });
        } catch (err) {
          // sem libass neste FFmpeg: é limitação do codificador (a mensagem do módulo já traz a solução)
          if (err && err.code === 'BURNIN_UNSUPPORTED') throw new ExportError('CODEC_UNSUPPORTED', err.message, { solution: 'Instale o FFmpeg completo (build "full") ou escolha a entrega da legenda em arquivo separado na aba Legendas.' });
          throw new ExportError('SUBTITLES_FAILED', `Não foi possível preparar as legendas deste corte: ${err && err.message}`, { cause: String(err && err.message) });
        }
        for (const text of Array.isArray(burn && burn.warnings) ? burn.warnings : []) {
          warnings.push(typeof text === 'string' ? { code: 'SUBTITLES_WARNING', message: text } : text);
        }
        // Legenda ligada, mas sem nada a aplicar (prepareBurnIn devolveu null): o vídeo sai sem legenda e o motivo vem do módulo de legendas.
        if (!burn && typeof loadedBurn.module.subtitleWarnings === 'function') {
          for (const text of loadedBurn.module.subtitleWarnings(cut)) warnings.push({ code: 'SUBTITLES_WARNING', message: text });
        }
      } else {
        warnings.push({ code: 'SUBTITLES_UNAVAILABLE', message: loadedBurn.error || 'As legendas deste corte estão ativadas, mas o módulo de legendas não está disponível: o vídeo foi exportado sem legendas.' });
      }
    }
    let audioFilter = null;
    if (optional.hasAudioAdjust(cut.audio)) {
      const loadedAudio = optional.audioFilter();
      const fn = loadedAudio.module && (loadedAudio.module.buildAudioFilter || loadedAudio.module.default);
      if (typeof fn === 'function') {
        try {
          audioFilter = fn(cut.audio, { duration }) || null;
          // limites aplicados (ganho, fades) viram avisos, nunca erros
          const resolve = loadedAudio.module.resolveAudio;
          if (typeof resolve === 'function') warnings.push(...(resolve(cut.audio, { duration }).warnings || []));
        } catch (err) {
          throw new ExportError('AUDIO_FAILED', `Não foi possível aplicar os ajustes de áudio deste corte: ${err && err.message}`, { cause: String(err && err.message) });
        }
      } else {
        warnings.push({ code: 'AUDIO_UNAVAILABLE', message: loadedAudio.error || 'Este corte tem ajustes de áudio, mas o módulo de áudio não está disponível: o áudio foi exportado como o original.' });
      }
    }

    // ----- filtros e codificador -----
    const framing = resolveFraming(cut, profile, job.framing);
    const graph = buildVideoGraph({ framing, profile, postFilters: burn && burn.vfFilter ? [burn.vfFilter] : [] });
    const withAudio = info.hasAudio !== false;
    const detection = await encoders.detectEncoders({ ffmpeg: tools.ffmpeg });
    const choice = encoders.chooseEncoder(detection, profile.codec, profile.encoder);
    if (!choice.kind) {
      throw new ExportError('CODEC_UNSUPPORTED', `Este FFmpeg não tem codificador para ${profile.codec === 'h265' ? 'H.265' : 'H.264'} (${choice.name}). Use um FFmpeg completo (build "full") ou escolha outro codec no perfil.`, { encoder: choice.name });
    }
    if (choice.warning) warnings.push(choice.warning);

    const monoSource = withAudio && (await audioChannels(tools.ffprobe, sourcePath)) === 1;
    const audioChain = [monoSource ? MONO_TO_STEREO : null, audioFilter].filter(Boolean).join(',') || null;
    const attempt = (kind) => runFfmpeg(tools.ffmpeg, buildFfmpegArgs({
      input: sourcePath, output: target.part, start, duration, graph, audioFilter: audioChain, withAudio,
      encoderArgs: [...threadArgs(limits), ...encoders.buildEncoderArgs({ codec: profile.codec, kind, bitrateKbps: profile.bitrateKbps })]
    }), { signal, onProgress, totalSec: duration, onStart: withPriority(onStart, limits) });

    if (onProgress) onProgress(0);
    let usedKind = choice.kind;
    let result = await attempt(usedKind);
    if (result.aborted || (signal && signal.aborted)) throw cancelled();
    if (result.code !== 0 && usedKind === 'nvenc') {
      const failure = classifyFailure(result);
      if (!['NO_DISK_SPACE', 'IO_BUSY', 'DISK_TRANSIENT', 'INPUT_MISSING'].includes(failure.code) && encoders.chooseEncoder(detection, profile.codec, 'software').kind) {
        // a placa falhou de verdade (driver, sessões, limite de resolução…): refaz por software e avisa
        removeFile(target.part);
        // o motivo vai em português; a linha crua do ffmpeg (inglês, com endereços de memória) não aparece para o usuário
        const reason = encoders.describeEncoderFailure(result.stderr, { encoder: encoders.encoderName(profile.codec, 'nvenc'), job: true });
        warnings.push({ code: 'ENCODER_FALLBACK', message: `A placa de vídeo (NVENC) falhou nesta exportação (${reason}); o corte foi exportado pelo codificador por software, que é mais lento.` });
        usedKind = 'software';
        if (onProgress) onProgress(0);
        result = await attempt(usedKind);
        if (result.aborted || (signal && signal.aborted)) throw cancelled();
      }
    }
    if (result.code !== 0) throw classifyFailure(result);

    // ----- verificação e publicação -----
    const verified = await verifyOutput(target.part, profile, duration, tools.ffprobe);
    if (signal && signal.aborted) throw cancelled(); // cancelado durante a verificação: nada é publicado
    warnings.push(...verified.warnings);
    let output;
    try {
      output = publish(target, onConflict);
    } catch (err) {
      if (err instanceof ExportError) throw err;
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(err.code);
      throw new ExportError(busy ? 'IO_BUSY' : 'OUTPUT_NOT_WRITABLE',
        `Não foi possível gravar o arquivo final (${err.message}). Se ele estiver aberto em outro programa, feche-o e tente de novo.`, { path: target.final });
    }
    warnings.push(...copySidecars(burn && burn.sidecars, output));
    if (onProgress) onProgress(1);
    return { output, warnings, skipped: false, encoder: { kind: usedKind, name: encoders.encoderName(profile.codec, usedKind) }, sizeBytes: verified.size };
  } finally {
    removeFile(target.part);
    reserved.delete(target.key);
    if (ownTmp) { try { fs.rmSync(ownTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* resto em %TEMP% */ } }
  }
}

module.exports = {
  threadArgs, withPriority, ExportError, RECOVERABLE_CODES, NON_RECOVERABLE_CODES, runExportJob, buildFfmpegArgs, classifyFailure, reserveTarget, publish
};
