'use strict';

/**
 * Geração automática de legendas de UM corte (dono: subtitles). Só o trecho do corte é processado:
 *
 *   1. o ffmpeg extrai o áudio do trecho (WAV mono 16 kHz) para uma pasta de trabalho temporária;
 *   2. `silencedetect` procura silêncio: áudio todo em silêncio = "nenhuma fala detectada", sem chamar o whisper;
 *      os trechos sem som saem do áudio antes da transcrição (e os tempos voltam ao original no fim);
 *   3. o `whisper-cli` (motor oficial do whisper.cpp) transcreve e grava um JSON com tempo e confiança por palavra;
 *      na placa NVIDIA (motor CUDA) quando ela deve ser usada; se a placa falhar, repete no processador (fallback);
 *   4. regras anti-alucinação (hallucinations.js): anotações, frases típicas de ruído, repetições e confiança
 *      extremamente baixa são descartadas COM o motivo registrado; confiança baixa vira `needsReview`;
 *   5. as palavras viram falas de legenda, com tempo RELATIVO AO INÍCIO DO CORTE.
 *
 * Nunca inventa fala: sem áudio, em silêncio ou ininteligível o resultado é `noSpeech: true`, sem falas.
 * Configuração do whisper validada no BDS (somente leitura): beam 1, sem contexto do trecho anterior (-mc 0) e
 * alinhamento por DTW (-dtw, que exige desligar a flash attention) para o tempo das palavras. NÃO usa `-sns`
 * (suprimir tokens sem fala): nos testes, com ruído ele forçava texto inventado em vez da anotação "[Música]".
 *
 * O `whisper-cli.exe` oficial não aceita acentos nos argumentos: roda com a pasta de trabalho como diretório
 * atual e só recebe nomes relativos em ASCII (o modelo vira um caminho relativo ou um atalho/cópia na pasta).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runProcess } = require('./proc');
const { SubtitlesError, cancelled, isCancelled } = require('./errors');
const { parseWhisperCppJson } = require('./whisperOutput');
const { buildCues } = require('./cueBuilder');
const { createLogWatcher, engineKindOf } = require('./engine');
const silence = require('./silence');
const halluc = require('./hallucinations');

const SAMPLE_RATE = 16000;
const MAX_CUT_SECONDS = 30 * 60;
const MIN_CUT_SECONDS = 0.3;
// só vale a pena cortar o silêncio se sair uma parte relevante do áudio
const TRIM_MIN_SECONDS = 1.5;
const TRIM_MIN_FRACTION = 0.15;
const MAX_DISCARDED_LISTED = 30;

/** Idiomas oferecidos (código do whisper.cpp). */
const LANGUAGES = Object.freeze([
  { code: 'pt', label: 'Português' }, { code: 'en', label: 'Inglês' }, { code: 'es', label: 'Espanhol' },
  { code: 'fr', label: 'Francês' }, { code: 'de', label: 'Alemão' }, { code: 'it', label: 'Italiano' },
  { code: 'ru', label: 'Russo' }, { code: 'ja', label: 'Japonês' }, { code: 'ko', label: 'Coreano' },
  { code: 'zh', label: 'Chinês' }, { code: 'auto', label: 'Detectar (mais lento)' }
]);

const MESSAGES = Object.freeze({
  'no-audio': 'Nenhuma fala detectada: este trecho do vídeo não tem áudio.',
  'short-audio': 'Nenhuma fala detectada: o corte pega menos de 0,2 s do áudio do vídeo (ele começa quase no fim).',
  silence: 'Nenhuma fala detectada: o áudio deste trecho está em silêncio.',
  'no-speech': 'Nenhuma fala detectada neste trecho (só música, ruído ou som que não dá para entender).'
});

const round3 = (n) => Math.round(n * 1000) / 1000;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Caminho relativo a `cwd` quando o resultado é só ASCII; senão null. */
function asciiRelative(cwd, target) {
  const rel = path.relative(cwd, target);
  return !path.isAbsolute(rel) && /^[\x20-\x7e]+$/.test(rel) ? rel : null;
}

/** Metade dos núcleos lógicos (≈ os físicos), entre 2 e 8: o whisper.cpp espera ocupado entre as etapas. */
function defaultThreads() {
  return Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
}

/** Argumentos do whisper-cli (os caminhos já são relativos à pasta de trabalho). */
function buildWhisperArgs({ model, audio, language, dtw, threads, noGpu = false }) {
  // -nth/-lpt/-et: limiares do whisper.cpp para descartar trecho sem fala (sem fala > 0,6 e confiança baixa) e decodificação ruim; são os
  // padrões do motor, escritos aqui de propósito para ficarem explícitos e testados
  const args = ['-m', model, '-f', audio, '-l', language, '-ojf', '-of', 'out', '-pp', '-bs', '1', '-bo', '1', '-mc', '0',
    '-nth', '0.6', '-lpt', '-1.0', '-et', '2.4', '-t', String(threads)];
  if (dtw) args.push('-dtw', dtw, '-nfa'); // o alinhamento por DTW exige a flash attention desligada
  if (noGpu) args.push('-ng'); // motor com placa NVIDIA rodando no processador (o pacote CUDA traz as DLLs de CPU)
  return args;
}

function normalizeLanguage(language) {
  const code = String(language || 'pt').toLowerCase();
  if (!/^(auto|[a-z]{2,3})$/.test(code)) throw new SubtitlesError('INVALID_ARGS', 'Idioma inválido.');
  return code;
}

/** ffmpeg: o trecho [start, start+duration] do arquivo -> WAV mono 16 kHz. Devolve { noAudio:true } se não há áudio. */
async function extractAudio({ ffmpeg, input, start, duration, wav, signal }) {
  const { code, tail } = await runProcess({
    command: ffmpeg,
    args: ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', String(round3(start)), '-i', input, '-t', String(round3(duration)),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', wav],
    signal
  });
  if (code === 0 && fs.existsSync(wav)) return { noAudio: false };
  if (/matches no streams|does not contain any stream|Output file is empty|Stream specifier/i.test(tail)) return { noAudio: true };
  throw new SubtitlesError('DECODE', 'Não foi possível ler o áudio deste trecho. Verifique se o vídeo abre normalmente e tente de novo.', { detail: tail.trim().split('\n').pop() || `código ${code}` });
}

/**
 * Duração (s) do arquivo e se tem áudio, lidas da descrição que o `ffmpeg -i` imprime (não precisa do ffprobe).
 * Só serve para explicar uma extração vazia; falha de leitura devolve `duration: null`.
 */
async function probeInput({ ffmpeg, input, signal }) {
  let duration = null;
  let hasAudio = null;
  try {
    await runProcess({
      command: ffmpeg, args: ['-hide_banner', '-nostdin', '-i', input], signal, timeoutMs: 30000,
      onLine: (line) => {
        const d = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
        if (d && duration === null) duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
        if (/Stream #\d+:\d+.*: Audio:/.test(line)) hasAudio = true;
      }
    });
  } catch (err) {
    if (isCancelled(err)) throw err; // qualquer outra falha: só não explica melhor
  }
  return { duration, hasAudio: hasAudio === true };
}

const fmtSeconds = (s) => `${(Math.round(s * 10) / 10).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;

/**
 * Roda o whisper-cli e devolve o JSON interpretado + onde rodou.
 * `useGpu`: o motor é o CUDA e a placa é para ser usada; `noGpu`: motor CUDA forçado a rodar no processador (-ng).
 * Falha com a placa vira GPU_FAILED (quem chama repete no processador).
 */
async function runWhisper({ whisper, modelPath, work, audioName, language, dtw, threads, signal, onProgress, useGpu = false, noGpu = false }) {
  // O whisper-cli não aceita acentos nos argumentos: caminho relativo em ASCII, ou atalho/cópia do modelo na pasta.
  let model = asciiRelative(work, modelPath);
  let staged = null;
  if (!model) {
    staged = path.join(work, 'model.bin');
    try { fs.linkSync(modelPath, staged); } catch { fs.copyFileSync(modelPath, staged); }
    model = 'model.bin';
  }
  let loaded = false;
  const watcher = createLogWatcher();
  let result;
  try {
    result = await runProcess({
      command: whisper,
      args: buildWhisperArgs({ model, audio: audioName, language, dtw, threads, noGpu }),
      cwd: work,
      env: { ...process.env },
      signal,
      onLine: (line) => {
        watcher.feed(line);
        const p = /progress\s*=\s*(\d+)%/.exec(line);
        if (p) onProgress('transcribe', Number(p[1]) / 100);
        else if (!loaded && /^system_info:|whisper_init_state:/.test(line)) { loaded = true; onProgress('model', 1); }
      }
    });
  } finally {
    if (staged) fs.rmSync(staged, { force: true });
  }
  const { code, tail } = result;
  const json = path.join(work, 'out.json');
  if (code !== 0 || !fs.existsSync(json)) {
    const last = tail.trim().split('\n').filter(Boolean).pop() || `código ${code}`;
    if (useGpu) {
      throw new SubtitlesError('GPU_FAILED', 'A placa de vídeo falhou na transcrição.', { detail: watcher.state.cudaError ? `erro da placa de vídeo: ${last}` : last, cudaError: watcher.state.cudaError });
    }
    throw new SubtitlesError('ENGINE_FAILED', 'O motor de transcrição falhou. Tente de novo; se continuar, reinstale o motor na aba Ferramentas.', { detail: last });
  }
  const parsed = parseWhisperCppJson(fs.readFileSync(json), { preferDtw: Boolean(dtw) });
  const onGpu = useGpu && watcher.state.sawGpu;
  return { ...parsed, device: onGpu ? 'GPU' : 'CPU', deviceName: onGpu ? watcher.state.device || null : null };
}

/**
 * @param {object} o
 * @param {string} o.ffmpeg      caminho do ffmpeg
 * @param {string} o.whisper     caminho do whisper-cli
 * @param {string} o.modelPath   arquivo .bin do modelo
 * @param {string|null} [o.dtw]  preset DTW do modelo (padrão: sem DTW, tempo por token)
 * @param {string} o.input       vídeo de origem
 * @param {number} o.start       início do corte na origem (s)
 * @param {number} o.end         fim do corte na origem (s)
 * @param {string} [o.language='pt'] código do idioma ('auto' detecta)
 * @param {number} [o.maxChars=22]   caracteres por linha (para agrupar as falas)
 * @param {string} o.workRoot    pasta onde criar a pasta de trabalho temporária (removida ao terminar)
 * @param {AbortSignal} [o.signal]
 * @param {(ev:{phase:string,percent:number,message:string})=>void} [o.onProgress]  percent 0..100
 * @param {number} [o.threads]
 * @param {{noiseDb?:number,minSilence?:number,pad?:number}} [o.silence]
 * @param {boolean} [o.useGpu=false]  usar a placa NVIDIA (o `whisper` precisa ser o motor CUDA)
 * @param {boolean} [o.cudaEngine=false] o `whisper` é o motor CUDA (no processador ele roda com -ng)
 * @param {string|null} [o.cpuWhisper]  motor de CPU para repetir se a placa falhar (sem ele, repete o mesmo motor com -ng)
 * @param {(reason:string)=>void} [o.onGpuFailed]  chamado quando a placa falhou e a geração continua no processador
 * @param {Function} [o.engine]  SÓ PARA TESTES: no lugar do whisper-cli, `engine({ work, audioName, language, useGpu, ... })` devolve o resultado já interpretado
 *   ({ language, segments, words, device? }), com os tempos do áudio que o motor receberia (já sem os silêncios cortados). Para simular uma falha da
 *   placa, lance `new SubtitlesError('GPU_FAILED', …, { detail })` quando `useGpu` for true.
 * @returns {Promise<{ cues:object[], noSpeech:boolean, reason:string|null, message:string, discarded:object[],
 *   language:string, durationSec:number, speechSec:number, trimmedSec:number, device:'GPU'|'CPU', deviceName:string|null,
 *   fellBack:boolean, fallbackReason:string|null, transcribeMs:number, audioSec:number, speed:number|null, elapsedMs:number }>}
 *   `speed`: segundos de áudio transcritos por segundo de relógio (inclui o carregamento do modelo).
 */
async function generateSubtitles(o) {
  const t0 = Date.now();
  const { ffmpeg, whisper, modelPath, input, signal = null } = o;
  const start = Number(o.start);
  const end = Number(o.end);
  const duration = end - start;
  const language = normalizeLanguage(o.language);
  const maxChars = clamp(Math.round(Number(o.maxChars) || 22), 8, 60);

  if (!ffmpeg) throw new SubtitlesError('NO_FFMPEG', 'O FFmpeg não foi encontrado. Instale-o e use "Verificar de novo" na aba Ferramentas.');
  if (!whisper || !fs.existsSync(whisper)) throw new SubtitlesError('NO_ENGINE', 'O motor de transcrição (Whisper) não está instalado. Instale-o na aba Ferramentas.');
  if (!modelPath || !fs.existsSync(modelPath)) throw new SubtitlesError('NO_MODEL', 'O modelo de transcrição não está instalado. Baixe um modelo na aba Legendas.');
  if (!input || !fs.existsSync(input)) throw new SubtitlesError('INPUT_MISSING', 'O vídeo de origem não foi encontrado.', { path: input });
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new SubtitlesError('INVALID_RANGE', 'O início ou o fim do corte é inválido. Ajuste o corte e tente de novo.');
  if (start < 0) throw new SubtitlesError('INVALID_RANGE', 'O início do corte não pode ser negativo. Ajuste o corte e tente de novo.');
  if (!(duration >= MIN_CUT_SECONDS)) throw new SubtitlesError('INVALID_RANGE', 'O corte é curto demais para legendar (precisa de ao menos 0,3 s).');
  if (duration > MAX_CUT_SECONDS) throw new SubtitlesError('INVALID_RANGE', 'O corte passa de 30 minutos; divida-o em cortes menores para gerar a legenda.');
  if (signal && signal.aborted) throw cancelled();

  const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const report = (phase, percent, message) => { try { progress({ phase, percent: clamp(percent, 0, 100), message }); } catch { /* ouvinte com defeito não derruba a geração */ } };

  fs.mkdirSync(o.workRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(o.workRoot, 'sub-'));
  const finish = (partial) => ({
    cues: [], noSpeech: true, reason: null, message: '', discarded: [], language, durationSec: round3(duration),
    speechSec: 0, trimmedSec: 0, device: 'CPU', deviceName: null, fellBack: false, fallbackReason: null, transcribeMs: 0, audioSec: 0, speed: null,
    elapsedMs: Date.now() - t0, ...partial
  });

  try {
    // 1) áudio do trecho
    report('audio', 0, 'Preparando o áudio do corte…');
    const wav = path.join(work, 'audio.wav');
    const extracted = await extractAudio({ ffmpeg, input, start, duration, wav, signal });
    const seconds = extracted.noAudio ? 0 : silence.wavSeconds(wav);
    if (seconds < 0.2) {
      // "sem áudio" só vale se o corte cai dentro do vídeo: um corte que começa depois do fim também sai vazio
      const media = await probeInput({ ffmpeg, input, signal });
      if (media.duration !== null && start >= media.duration - 0.05) {
        throw new SubtitlesError('INVALID_RANGE', `O corte começa em ${fmtSeconds(start)}, mas o vídeo tem só ${fmtSeconds(media.duration)}. Confira se este é o vídeo do corte e ajuste o início.`, { start, videoSeconds: media.duration });
      }
      if (media.hasAudio) { // o vídeo tem áudio, mas o corte pegou menos de 0,2 s dele (começa quase no fim do vídeo)
        report('done', 100, MESSAGES['short-audio']);
        return finish({ reason: 'no-speech', message: MESSAGES['short-audio'] });
      }
      report('done', 100, MESSAGES['no-audio']);
      return finish({ reason: 'no-audio', message: MESSAGES['no-audio'] });
    }

    // 2) silêncio: tudo em silêncio -> sem fala, sem chamar o whisper
    report('silence', 8, 'Procurando trechos com fala…');
    const analysis = await silence.analyzeSilence(wav, { ffmpeg, signal, ...(o.silence || {}) });
    if (!analysis.speech.length) {
      report('done', 100, MESSAGES.silence);
      return finish({ reason: 'silence', message: MESSAGES.silence });
    }
    const speechSec = analysis.speech.reduce((n, r) => n + (r.end - r.start), 0);
    let audioName = 'audio.wav';
    let timeMap = null;
    let trimmedSec = 0;
    const removable = seconds - speechSec;
    if (removable >= Math.max(TRIM_MIN_SECONDS, TRIM_MIN_FRACTION * seconds)) {
      try {
        const built = await silence.buildTrimmedWav(wav, analysis.speech, path.join(work, 'audio_fala.wav'), { signal });
        if (built.duration >= 0.2) { audioName = 'audio_fala.wav'; timeMap = built.timeMap; trimmedSec = round3(seconds - built.duration); }
      } catch (err) {
        if (isCancelled(err)) throw err; // qualquer outra falha: transcreve o áudio inteiro
      }
    }

    // 3) whisper (placa ou processador)
    report('model', 12, o.useGpu ? 'Carregando o modelo na placa de vídeo…' : 'Carregando o modelo…');
    const threads = o.threads || defaultThreads();
    const run = typeof o.engine === 'function' ? o.engine : runWhisper;
    const audioSec = timeMap ? seconds - trimmedSec : seconds;
    const attempt = (useGpu, exe) => run({
      whisper: exe, modelPath, work, audioName, language, dtw: o.dtw || null, threads, signal, useGpu,
      noGpu: !useGpu && (exe === whisper ? Boolean(o.cudaEngine) : engineKindOf(exe) === 'cuda'), // motor CUDA no processador = -ng
      onProgress: (phase, fraction) => report(phase, phase === 'model' ? 14 : 14 + fraction * 82, phase === 'model' ? 'Transcrevendo…' : `Transcrevendo… ${Math.round(fraction * 100)}%`)
    });
    const tRun = Date.now();
    let fellBack = false;
    let fallbackReason = null;
    let parsed;
    try {
      parsed = await attempt(Boolean(o.useGpu), whisper);
    } catch (err) {
      if (!o.useGpu || isCancelled(err) || !err || err.code !== 'GPU_FAILED') throw err;
      // A placa falhou (driver, memória, erro do CUDA): repete no processador e avisa; quem chama lembra da falha.
      fellBack = true;
      fallbackReason = ((err.details && err.details.detail) || err.message || 'erro da placa').toString().slice(0, 200);
      try { if (typeof o.onGpuFailed === 'function') o.onGpuFailed(fallbackReason); } catch { /* ouvinte com defeito */ }
      report('model', 12, 'A placa falhou: usando o processador…');
      parsed = await attempt(false, o.cpuWhisper && fs.existsSync(o.cpuWhisper) ? o.cpuWhisper : whisper);
    }
    const transcribeMs = Date.now() - tRun;
    const device = parsed.device || (o.useGpu && !fellBack ? 'GPU' : 'CPU');
    const deviceName = parsed.deviceName || null;
    if (timeMap) parsed = silence.remapResult(parsed, timeMap);

    // 4) regras anti-alucinação, trecho a trecho (tempos já no referencial do WAV original)
    report('filter', 97, 'Conferindo o resultado…');
    const clampItem = (it) => ({ ...it, start: clamp(it.start, 0, seconds), end: clamp(it.end, 0, seconds) });
    const segments = parsed.segments.map(clampItem);
    const words = parsed.words.map(clampItem);
    const verdicts = halluc.classifySegments(segments, { speech: analysis.speech, silences: analysis.silences, duration: seconds });

    const discarded = [];
    segments.forEach((seg, i) => {
      if (!verdicts[i].keep) discarded.push({ start: round3(seg.start), end: round3(seg.end), text: seg.text, reason: verdicts[i].reason });
    });
    const keptWords = words.filter((w) => !Number.isInteger(w.seg) || (verdicts[w.seg] && verdicts[w.seg].keep));

    // 5) palavras -> falas (tempos relativos ao início do corte)
    const built = buildCues(keptWords, { lines: 2, maxChars });
    const cues = [];
    for (const c of built) {
      const text = c.text.trim();
      if (!text) continue;
      const start0 = clamp(c.start, 0, seconds);
      const end0 = clamp(c.end, 0, seconds);
      if (end0 - start0 < 0.05) continue;
      if (c.p !== null && c.p < halluc.DISCARD_BELOW) {
        discarded.push({ start: round3(start0), end: round3(end0), text, reason: halluc.REASONS.lowConfidence });
        continue;
      }
      const review = (c.p !== null && c.p < halluc.REVIEW_BELOW) || c.segs.some((s) => verdicts[s] && verdicts[s].review);
      const cue = { start: round3(start0), end: round3(end0), text };
      if (review) cue.needsReview = true;
      cues.push(cue);
    }

    report('done', 100, cues.length ? 'Legenda pronta.' : MESSAGES['no-speech']);
    return finish({
      cues, noSpeech: cues.length === 0, reason: cues.length ? null : 'no-speech', message: cues.length ? '' : MESSAGES['no-speech'],
      ...(o.returnWords ? { words: keptWords.filter((w) => w.end - w.start >= 0 && String(w.word || '').trim()).map((w) => [round3(w.start), round3(w.end), String(w.word).trim()]) } : {}),
      discarded: discarded.slice(0, MAX_DISCARDED_LISTED), language: parsed.language || (language === 'auto' ? '' : language),
      speechSec: round3(speechSec), trimmedSec, device, deviceName, fellBack, fallbackReason, transcribeMs, audioSec: round3(audioSec),
      speed: transcribeMs > 0 ? Math.round((audioSec / (transcribeMs / 1000)) * 10) / 10 : null
    });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* a pasta temporária fica para a próxima limpeza */ }
  }
}

module.exports = { generateSubtitles, buildWhisperArgs, asciiRelative, defaultThreads, extractAudio, probeInput, LANGUAGES, MESSAGES, MAX_CUT_SECONDS };
