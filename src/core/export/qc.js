'use strict';

/**
 * Controle de qualidade antes de exportar: `preflight(job, { tools })` ->
 *   { errors:[{code,message,solution}], warnings:[{code,message}] }
 *
 * Erros impedem SÓ aquele trabalho (sempre com causa e solução). Avisos nunca bloqueiam: informam
 * algo que o usuário pode querer saber (ampliação, H.265, bitrate, corte longo, nome repetido…).
 * É síncrono de propósito (a fila pode chamar sem `await`); o NVENC só entra se a detecção já foi
 * feita e está guardada (export:encoders / primeiro job).
 */

const fs = require('node:fs');
const path = require('node:path');
const { validateProfile } = require('./profiles');
const { resolveFraming, framingUpscale } = require('./framing');
const { cameraProblems } = require('./layouts');
const { encoderListing, getCachedEncoders, SOFTWARE, NVENC } = require('./encoders');
const { sanitizeFileName } = require('./naming');
const optional = require('./optional');

const AUDIO_KBPS = 192;
const SHORTS_MAX_SEC = 180;
const RANGE_TOLERANCE_SEC = 0.25;
/** Proporção que cada tipo de perfil embutido promete (largura:altura); acima desta folga, o usuário mexeu nas medidas. */
const KIND_RATIO = Object.freeze({ vertical: [9, 16], horizontal: [16, 9] });
const RATIO_TOLERANCE = 0.01;
const fmtSec = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtBytes = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);

/** Caminho do arquivo final do trabalho (sem considerar renomeação por conflito). */
function plannedOutput(job) {
  return path.join(String(job.outputDir || ''), `${sanitizeFileName(job.baseName)}.mp4`);
}

/** Pasta existente mais próxima de `dir` (a que será gravada de fato se o resto for criado). */
function nearestExisting(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
      return null; // existe, mas é um arquivo
    } catch { /* sobe um nível */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/** Testa a gravação de verdade (um arquivo pequeno que é apagado em seguida). */
function canWriteIn(dir) {
  const probe = path.join(dir, `.bf-gravacao-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    try { fs.rmSync(probe, { force: true }); } catch { /* nada a limpar */ }
    return false;
  }
}

/** Bytes livres onde a pasta está (ou null se o sistema não informa). */
function freeBytes(dir, statfs) {
  try {
    const st = statfs(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

function bitrateAdvice({ profile, fps }) {
  const pixelsPerSecond = profile.width * profile.height * fps;
  const low = profile.codec === 'h265' ? 0.03 : 0.045;
  const high = profile.codec === 'h265' ? 0.4 : 0.6;
  const bpp = (profile.bitrateKbps * 1000) / pixelsPerSecond;
  const target = (factor) => Math.max(1, Math.round((pixelsPerSecond * factor) / 1e6));
  return { bpp, low: bpp < low ? target(profile.codec === 'h265' ? 0.05 : 0.07) : null, high: bpp > high ? target(profile.codec === 'h265' ? 0.2 : 0.3) : null };
}

/** Quantas falas da legenda aparecem no corte (já acompanhando o intervalo atual dele). Sem o módulo, conta as da lista. */
function visibleSubtitleCues(subtitles, cut) {
  try {
    return require('../subtitles/shared').visibleCues(subtitles, cut).length;
  } catch {
    return Array.isArray(subtitles.cues) ? subtitles.cues.length : 0;
  }
}

/**
 * @param {object} job  Job de exportação (contrato 3.3)
 * @param {{tools?:{ffmpeg?:string|null}, statfs?:Function, encoderNames?:Set<string>}} [opts]  `statfs` e `encoderNames` só para testes (isolam o disco e o ffmpeg)
 */
function preflight(job, { tools = {}, statfs = fs.statfsSync, encoderNames } = {}) {
  const errors = [];
  const warnings = [];
  const error = (code, message, solution) => { errors.push({ code, message, solution }); };
  const warn = (code, message) => { warnings.push({ code, message }); };

  if (!job || typeof job !== 'object') {
    error('INVALID_JOB', 'O trabalho de exportação está incompleto.', 'Adicione o corte à fila de novo pela aba Exportar.');
    return { errors, warnings };
  }
  const cut = job.cut && typeof job.cut === 'object' ? job.cut : {};
  const info = job.sourceInfo && typeof job.sourceInfo === 'object' ? job.sourceInfo : {};
  const who = cut.title ? `O corte "${cut.title}"` : 'O corte';

  // ferramenta
  if (!tools.ffmpeg) {
    error('NO_FFMPEG', 'O FFmpeg não foi encontrado, então não dá para exportar.',
      'Instale o FFmpeg pela página oficial (ffmpeg.org/download.html), deixe-o no PATH (ou defina CORTE_FFMPEG) e clique em "Verificar de novo" no aviso do topo.');
  }

  // perfil
  const { profile, errors: profileErrors } = validateProfile(job.profile);
  const profileOk = profileErrors.length === 0;
  if (!profileOk) {
    error('INVALID_PROFILE', `O perfil de exportação tem problema: ${profileErrors.join(' ')}`,
      'Abra os detalhes do perfil na aba Exportar e corrija os valores, ou escolha outro perfil.');
  }

  // entrada
  const sourcePath = typeof job.sourcePath === 'string' ? job.sourcePath : '';
  try {
    if (!sourcePath) throw new Error('sem caminho');
    if (!fs.statSync(sourcePath).isFile()) throw new Error('não é arquivo');
    fs.accessSync(sourcePath, fs.constants.R_OK);
  } catch {
    error('INPUT_MISSING', `O vídeo de origem não foi encontrado ou não pode ser lido: ${sourcePath || '(sem caminho)'}.`,
      'Confira se o arquivo continua no mesmo lugar (e se o disco ou a pasta de rede está conectado). Se o vídeo foi movido, abra-o de novo pelo botão "Abrir vídeo".');
  }

  // intervalo
  const start = Number(cut.start);
  const end = Number(cut.end);
  const duration = end - start;
  if (!(start >= 0) || !(end > start)) {
    error('INVALID_RANGE', `${who} tem início e fim inválidos (${cut.start} → ${cut.end}).`,
      'Ajuste o início e o fim na aba Cortes: o fim precisa ser maior que o início.');
  } else if (Number(info.duration) > 0 && end > Number(info.duration) + RANGE_TOLERANCE_SEC) {
    error('INVALID_RANGE', `${who} termina em ${fmtSec(end)}, depois do fim do vídeo (${fmtSec(Number(info.duration))}).`,
      'Ajuste o fim do corte na aba Cortes para dentro da duração do vídeo.');
  }
  const rangeOk = start >= 0 && end > start;

  // pasta de saída e nome
  const outputDir = typeof job.outputDir === 'string' ? job.outputDir : '';
  if (!outputDir) {
    error('OUTPUT_NOT_WRITABLE', 'Nenhuma pasta de destino foi escolhida.', 'Escolha a pasta de destino na aba Exportar.');
  } else {
    const base = nearestExisting(outputDir);
    if (!base) {
      error('OUTPUT_NOT_WRITABLE', `Não é possível usar "${outputDir}" como pasta de destino (o caminho não existe ou há um arquivo no lugar).`,
        'Escolha outra pasta de destino. Se for um disco externo ou de rede, confira se está conectado.');
    } else if (!canWriteIn(base)) {
      error('OUTPUT_NOT_WRITABLE', `Sem permissão para gravar em "${base}".`,
        'Escolha uma pasta onde você possa gravar (por exemplo, dentro de Vídeos) ou ajuste as permissões da pasta.');
    } else {
      const planned = plannedOutput(job);
      if (sourcePath && path.resolve(planned).toLowerCase() === path.resolve(sourcePath).toLowerCase()) {
        error('OUTPUT_IS_SOURCE', 'O arquivo de destino seria o próprio vídeo de origem.', 'Escolha outra pasta de destino ou outro modelo de nome.');
      } else if (fs.existsSync(planned)) {
        warn('NAME_CONFLICT', `Já existe um arquivo chamado "${path.basename(planned)}" na pasta de destino. Nada será sobrescrito sem a sua escolha: a fila vai perguntar o que fazer.`);
      }
      // espaço em disco
      if (profileOk && rangeOk) {
        const free = freeBytes(base, statfs);
        if (free !== null) {
          const bytesPerSec = ((profile.bitrateKbps + (info.hasAudio === false ? 0 : AUDIO_KBPS)) * 1000) / 8;
          const estimate = bytesPerSec * duration * 1.05;
          if (free < estimate) {
            error('NO_DISK_SPACE', `Espaço insuficiente em disco: o arquivo deve ocupar cerca de ${fmtBytes(estimate)} e há ${fmtBytes(free)} livres em "${base}".`,
              'Libere espaço no disco, escolha outra pasta de destino ou reduza o bitrate do perfil.');
          } else if (free < estimate * 1.5) {
            warn('LOW_DISK', `Pouco espaço livre: o arquivo deve ocupar cerca de ${fmtBytes(estimate)} e há ${fmtBytes(free)} livres. Outras exportações ao mesmo tempo podem não caber.`);
          }
        }
      }
    }
  }

  // codificador (se a lista do ffmpeg não pôde ser lida agora, não dá para afirmar nada: a exportação decide, sem bloquear à toa)
  const listing = profileOk && tools.ffmpeg ? (encoderNames ? { names: encoderNames, ok: true } : encoderListing(tools.ffmpeg)) : null;
  if (listing && listing.ok) {
    const names = listing.names;
    const sw = names.has(SOFTWARE[profile.codec]);
    const detection = getCachedEncoders(tools.ffmpeg);
    const hwKnown = detection ? detection.nvenc[profile.codec] : null;
    const hw = names.has(NVENC[profile.codec]) && (!hwKnown || hwKnown.available);
    const codecName = profile.codec === 'h265' ? 'H.265' : 'H.264';
    if (profile.encoder === 'software' && !sw) {
      error('CODEC_UNSUPPORTED', `Este FFmpeg não tem o codificador ${SOFTWARE[profile.codec]} (${codecName} por software).`,
        'Use um FFmpeg completo (build "full", com libx264 e libx265), ou troque o codificador do perfil para Automático.');
    } else if (!sw && !hw) {
      error('CODEC_UNSUPPORTED', `Este FFmpeg não consegue gerar ${codecName}: faltam ${SOFTWARE[profile.codec]} e ${NVENC[profile.codec]}.`,
        'Use um FFmpeg completo (build "full", com libx264 e libx265) ou escolha o outro codec no perfil.');
    } else if (profile.encoder === 'nvenc' && !hw) {
      const why = hwKnown && hwKnown.reason ? ` (${hwKnown.reason})` : '';
      warn('ENCODER_FALLBACK', `A placa de vídeo (NVENC) não está disponível para ${codecName}${why}; a exportação usará o codificador por software, que é mais lento.`);
    }
  }

  // aviso: áudio e cor da fonte
  if (info.hasAudio === false) warn('NO_AUDIO', 'O vídeo de origem não tem áudio: o arquivo exportado ficará sem som.');
  else if (Number(info.audioTracks) > 1) {
    warn('AUDIO_TRACKS', `O vídeo tem ${Number(info.audioTracks)} faixas de áudio e só a primeira entra no corte exportado (o app não mistura as faixas). Se a sua voz ou o jogo estão em outra faixa, o corte sai sem eles: junte as faixas antes, no OBS ou em um editor de vídeo.`);
  }
  if (info.hdr === true) {
    warn('HDR_SOURCE', 'O vídeo parece ser HDR e o Braga Frame não converte HDR para SDR (tone mapping): as cores do arquivo exportado podem sair apagadas. Se a cor importar, grave ou converta o vídeo em SDR antes.');
  }

  // avisos que dependem do perfil
  if (profileOk) {
    const framing = resolveFraming(cut, profile, job.framing);
    const up = framingUpscale({ framing, profile, sourceInfo: info });
    if (up !== null && up > 1.05) {
      warn('UPSCALE', `A fonte (${info.width}×${info.height}) será ampliada ${up.toFixed(1).replace('.', ',')}× para preencher ${profile.width}×${profile.height}: o vídeo não ganha detalhe com isso. Um perfil de resolução menor evita arquivos maiores sem ganho visível.`);
    }
    // layout "webcam + jogo": o retângulo da câmera sai da fonte, a fonte tem outra proporção ou é pequena demais (conta, sem olhar a imagem)
    for (const problem of cameraProblems({ framing, origin: job.framingSource, sourceInfo: info })) warn('CAMERA_RECT', problem.message);
    const wanted = KIND_RATIO[profile.kind];
    if (wanted && Math.abs((profile.width / profile.height) / (wanted[0] / wanted[1]) - 1) > RATIO_TOLERANCE) {
      const vertical = wanted[0] === 9;
      warn(vertical ? 'NOT_9X16' : 'NOT_16X9',
        `As medidas deste perfil (${profile.width}×${profile.height}) não são ${vertical ? '9:16, o padrão do produto (vertical)' : '16:9, o formato do perfil horizontal escolhido'}. Se mudou de propósito, tudo bem: o arquivo sai com essas medidas.`);
    }
    if (profile.codec === 'h265') {
      warn('HEVC_COMPAT', 'H.265 (HEVC) gera arquivos menores, mas alguns players, editores e plataformas não o abrem bem. Se for publicar, H.264 é mais seguro.');
    }
    if (profile.codec === 'h264' && (profile.width > 4096 || profile.height > 4096)) {
      warn('RES_COMPAT', `${profile.width}×${profile.height} passa do limite de 4096 pixels do H.264 em vários players e codificadores por hardware. Prefira H.265 ou uma resolução menor.`);
    }
    const fps = typeof profile.fps === 'number' ? profile.fps : (Number(info.fps) > 0 ? Number(info.fps) : 30);
    const advice = bitrateAdvice({ profile, fps });
    const mbps = (profile.bitrateKbps / 1000).toFixed(profile.bitrateKbps % 1000 ? 1 : 0);
    if (advice.low) {
      warn('BITRATE_LOW', `Bitrate baixo (${mbps} Mbps) para ${profile.width}×${profile.height}: pode aparecer perda de detalhe e blocos. Sugestão: pelo menos ${advice.low} Mbps.`);
    } else if (advice.high) {
      warn('BITRATE_HIGH', `Bitrate alto (${mbps} Mbps) para ${profile.width}×${profile.height}: o arquivo fica grande sem ganho visível. Sugestão: até ${advice.high} Mbps.`);
    }
  }

  // aviso: duração para Shorts
  if (rangeOk && duration > SHORTS_MAX_SEC) {
    warn('LONG_CUT', `${who} tem ${fmtSec(duration)}: o YouTube Shorts aceita até 3 minutos. O arquivo será exportado normalmente.`);
  }

  // módulos de outros recursos (legendas e áudio), quando existem
  const subtitles = cut.subtitles && typeof cut.subtitles === 'object' ? cut.subtitles : null;
  if (subtitles && subtitles.enabled) {
    const loaded = optional.burnIn();
    const mod = loaded.module;
    if (!mod) {
      warn('SUBTITLES_UNAVAILABLE', loaded.error || 'As legendas deste corte estão ativadas, mas o módulo de legendas não está disponível nesta versão: o vídeo será exportado sem legendas.');
    } else {
      if (typeof mod.subtitleWarnings === 'function') {
        for (const text of mod.subtitleWarnings(cut)) warn('SUBTITLES_WARNING', text);
      }
      // Só bloqueia quando a exportação REALMENTE precisaria do libass: entrega incorporada (burn/both) e ao menos uma fala
      // visível no corte (sem falas visíveis o prepareBurnIn devolve null e nada é incorporado). Arquivo separado não depende dele.
      const burns = !['sidecar', 'srt', 'ass'].includes(subtitles.mode);
      if (burns && tools.ffmpeg && visibleSubtitleCues(subtitles, cut) > 0 && typeof mod.detectBurnInSupport === 'function') {
        const support = mod.detectBurnInSupport(tools.ffmpeg);
        if (!support.supported) {
          error('CODEC_UNSUPPORTED', support.reason || 'Este FFmpeg não consegue incorporar legendas ao vídeo.',
            'Instale o FFmpeg completo (build "full", com libass) ou escolha a entrega da legenda em arquivo separado na aba Legendas.');
        }
      }
    }
  }
  if (optional.hasAudioAdjust(cut.audio)) {
    const loaded = optional.audioFilter();
    if (!loaded.module) {
      warn('AUDIO_UNAVAILABLE', loaded.error || 'Este corte tem ajustes de áudio, mas o módulo de áudio não está disponível nesta versão: o áudio será exportado como o original.');
    } else if (typeof loaded.module.resolveAudio === 'function' && rangeOk) {
      for (const w of loaded.module.resolveAudio(cut.audio, { duration }).warnings || []) warn(w.code || 'AUDIO_LIMITED', w.message);
    }
  }
  return { errors, warnings };
}

module.exports = { preflight, plannedOutput, SHORTS_MAX_SEC, AUDIO_KBPS };
