'use strict';

const { AnalysisError, cancelled } = require('./errors');
const { ALGO_VERSION, normalizeParams, thresholds, suggestionLimit, calmLimit, canonicalJson, sha1 } = require('./params');
const { AnalysisCache, sourceKey } = require('./cache');
const { extractAudio, scoreAudio } = require('./audioSignal');
const { extractImage, scoreImage } = require('./imageSignal');
const { loadChat, chatFingerprint, scoreChat } = require('./chatSignal');
const { scoreText } = require('./textSignal');
const { scoreCalm } = require('./calmSignal');
const { combine } = require('./combine');
const { findBreaks, episodeAt } = require('./segments');

/**
 * Orquestra a análise de um vídeo: sinais (áudio, imagem, chat e, quando há transcrição, texto) -> pontuação -> sugestões.
 *
 * Sinais ausentes ou que falham NÃO bloqueiam: são ignorados e o resultado diz quais foram usados e por
 * que os outros não (`signals`) e traz `warnings`. Só se nenhum sinal puder ser analisado é que a análise
 * falha (NO_SIGNALS). Cancelamento por `signal` (AbortSignal) encerra os ffmpeg e lança CANCELLED.
 *
 * request: { file, duration, hasAudio, params, chatPath, transcript?, fresh? }   (fresh: ignora o cache e lê o vídeo de novo;
 *           transcript: { cues:[{ start, end, text, laugh? }] } já conferida com este vídeo, ou ausente)
 * deps:    { ffmpeg, cacheDir, signal, onProgress({ p, stage, message }), spawn?, onSpawn?, inputArgs? }
 */

// peso de cada etapa na barra de progresso
const WEIGHT = { audio: 0.2, image: 0.75, image_fast: 0.2 };

// cobertura: o que o ffmpeg leu pode ser bem menos que a duração (arquivo truncado); diferenças pequenas são normais
const COVERAGE_GAP_SEC = 5; // folga mínima, em segundos
const COVERAGE_GAP_FAST_SEC = 30; // no modo rápido a imagem só tem os quadros-chave: o último pode estar longe do fim
const COVERAGE_GAP_FRACTION = 0.03; // ou 3% da duração, o que for maior
const SILENT_DB = -90; // faixa em que NENHUMA janela passa disto = sem som (silêncio digital fica em -100)
const TEXT_COVERAGE_MIN = 0.9; // transcrição que cobre menos que isto do vídeo ganha aviso
const SENTENCE_GAP_SEC = 0.6; // perfil de conversa: pausa que fecha uma frase mesmo sem pontuação
const SENTENCE_PUNCT_MIN = 0.2; // transcrição com pontuação em menos de 20% das falas (legenda automática): fica o alinhamento de sempre
// perfil de conversa: o fim de frase pode estar mais longe que o fim de fala mais próximo
const CONVERSA_REACH = Object.freeze({ startBack: 8, startForward: 3, endForward: 8, endBack: 3 });
// perfil de conversa: um bom corte de conversa tem pergunta, resposta e desfecho (os reels publicados da live medida têm ~50 s). Pisos: se as
// preferências pedem mais, valem as preferências
const CONVERSA_MIN_SEC = 30;
const CONVERSA_MAX_SEC = 75;

/**
 * Perfil de conversa: limites de FRASE para o começo e o fim dos cortes. Começo: fala depois de um ponto (ou de uma pausa). Fim: fala que
 * termina em ponto ou exclamação (ou antes de uma pausa), NUNCA em pergunta, porque a resposta é o que interessa. Sem pontuação suficiente
 * na transcrição, devolve null (vale o alinhamento a qualquer fala).
 */
function sentenceBounds(cues) {
  const list = cues.filter((c) => c && c.end > c.start && c.laugh !== true).slice().sort((a, b) => a.start - b.start);
  const ends = (c) => String(c.text || '').trim();
  const withPunct = list.filter((c) => /[.!?…]$/.test(ends(c))).length;
  if (!list.length || withPunct < list.length * SENTENCE_PUNCT_MIN) return null;
  const starts = [];
  const stops = [];
  list.forEach((c, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    if (!prev || /[.!?…]$/.test(ends(prev)) || c.start - prev.end >= SENTENCE_GAP_SEC) starts.push(c.start);
    const text = ends(c);
    if (/[.!…]$/.test(text) || (!/\?$/.test(text) && (!next || next.start - c.end >= SENTENCE_GAP_SEC))) stops.push(c.end);
  });
  return { starts: starts.sort((a, b) => a - b), ends: stops.sort((a, b) => a - b), reach: CONVERSA_REACH };
}

/** Impressão digital da transcrição para a chave de cache do resultado. */
function transcriptFingerprint(cues) {
  return sha1(cues.map((c) => `${c.start}|${c.end}|${c.laugh ? 1 : 0}|${c.text}`).join('\n')).slice(0, 16);
}

/** "1:23" ou "1:02:03". */
function clockText(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

async function analyzeSource(request, deps) {
  const startedAt = Date.now();
  const { file, duration = 0, hasAudio = true } = request;
  const fresh = request.fresh === true;
  const params = normalizeParams(request.params);
  const { signal, onProgress } = deps;
  const check = () => { if (signal && signal.aborted) throw cancelled(); };
  check();

  const cache = new AnalysisCache(deps.cacheDir);
  const key = sourceKey(file);
  const warnings = [];
  const info = {
    audio: { used: false, reason: '' },
    image: { used: false, reason: '' },
    chat: { used: false, reason: '' },
    text: { used: false, reason: '' },
    calm: { used: false, reason: '' }
  };

  // ---- quais sinais valem a pena ----
  const want = params.signals;
  if (!want.audio) info.audio.reason = 'desligado';
  else if (hasAudio === false) {
    info.audio.reason = 'o vídeo não tem faixa de áudio';
    warnings.push({ code: 'NO_AUDIO', message: 'O vídeo não tem faixa de áudio: o sinal de áudio foi ignorado.' });
  }
  if (!want.image) info.image.reason = 'desligado';
  if (!want.calm) info.calm.reason = 'desligado';
  else if (!(want.audio && hasAudio !== false)) info.calm.reason = 'precisa do áudio';

  let chat = null;
  if (!want.chat) info.chat.reason = 'desligado';
  else if (!request.chatPath) info.chat.reason = 'este vídeo não tem chat baixado';
  else {
    try {
      chat = await loadChat(request.chatPath);
    } catch (err) {
      info.chat.reason = 'o arquivo de chat não pôde ser lido';
      warnings.push({ code: err.code || 'CHAT_UNREADABLE', message: err.message });
    }
  }
  const cues = request.transcript && Array.isArray(request.transcript.cues) ? request.transcript.cues : [];
  if (!want.text) info.text.reason = 'desligado';
  else if (request.transcript && request.transcript.stale) info.text.reason = 'a transcrição guardada é de outro arquivo de vídeo';
  else if (!cues.length) info.text.reason = 'este vídeo não tem transcrição';
  const useText = want.text && cues.length > 0;
  check();

  // ---- cache do resultado final ----
  const resultKey = sha1(canonicalJson({
    v: ALGO_VERSION, key, hasAudio: hasAudio !== false, params, chat: chat ? chatFingerprint(request.chatPath) : null,
    text: useText ? transcriptFingerprint(cues) : null
  })).slice(0, 32);
  const cachedResult = fresh ? null : cache.get('res', resultKey);
  if (cachedResult) {
    if (onProgress) onProgress({ p: 1, stage: 'done', message: 'Resultado já calculado antes (cache).' });
    return { ...cachedResult, fromCache: true, tookMs: Date.now() - startedAt };
  }

  // ---- extração (a parte cara), com cache por sinal ----
  const useAudio = want.audio && hasAudio !== false;
  const useImage = want.image;
  const prog = { audio: 0, image: 0 };
  const w = { audio: useAudio ? WEIGHT.audio : 0, image: useImage ? (params.image.fast ? WEIGHT.image_fast : WEIGHT.image) : 0 };
  const stageText = { audio: 'Lendo o áudio…', image: 'Analisando a imagem…' };
  const report = (stage, p) => {
    prog[stage] = Math.max(prog[stage], p);
    if (!onProgress) return;
    const sum = w.audio + w.image || 1;
    onProgress({ p: Math.min(0.97, (w.audio * prog.audio + w.image * prog.image) / sum), stage, message: stageText[stage] });
  };

  const common = { ffmpeg: deps.ffmpeg, file, duration, signal, spawn: deps.spawn, onSpawn: deps.onSpawn, inputArgs: deps.inputArgs || [] };
  const tasks = []; // { id, promise }
  const extracted = {};
  const cacheKeyFor = { audio: ['sig-audio', key], image: ['sig-image', key + (params.image.fast ? 'f' : '0')] };

  async function extractWithCache(id, run) {
    const hit = fresh ? null : cache.get(...cacheKeyFor[id]);
    if (hit) { report(id, 1); return { data: hit, cached: true }; }
    return { data: await run(), cached: false };
  }

  if (useAudio) {
    const promise = extractWithCache('audio', () => extractAudio({ ...common, onProgress: (p) => report('audio', p) }))
      .then((r) => { extracted.audio = r; });
    tasks.push({ id: 'audio', promise });
  }
  if (useImage) {
    const promise = extractWithCache('image', () => extractImage({ ...common, fast: params.image.fast, onProgress: (p) => report('image', p) }))
      .then((r) => { extracted.image = r; });
    tasks.push({ id: 'image', promise });
  }
  const settled = await Promise.allSettled(tasks.map((t) => t.promise));
  check();
  const failedIds = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') return;
    const { id } = tasks[i];
    const err = s.reason;
    if (err && err.code === 'CANCELLED') throw err;
    if (err && err.code === 'FFMPEG_START_FAILED') throw err;
    failedIds.push(id);
    info[id].reason = 'não foi possível ler (veja os avisos)';
    warnings.push({ code: err && err.code ? err.code : `${id.toUpperCase()}_FAILED`, message: err && err.message ? err.message : `Falha ao analisar o sinal de ${id}.` });
  });
  const knownDuration = Number.isFinite(duration) && duration > 0;
  let partial = false;
  for (const id of ['audio', 'image']) {
    const r = extracted[id];
    if (!r) continue;
    info[id].used = true;
    info[id].cached = r.cached;
    const label = id === 'audio' ? 'áudio' : 'imagem';
    if (r.data.partial) {
      partial = true;
      warnings.push({ code: `${id.toUpperCase()}_PARTIAL`, message: `O ffmpeg terminou com erro no sinal de ${label}${r.data.tail ? ` (${r.data.tail})` : ''}: o arquivo pode estar truncado ou danificado; foi usado só o que deu para ler.` });
    } else if (knownDuration) {
      // o ffmpeg saiu sem erro, mas leu bem menos que a duração do arquivo (gravação cortada): diz até onde foi a análise
      const read = id === 'audio' ? Math.ceil(r.data.db.length * r.data.windowSec) : r.data.seconds;
      const gap = Math.max(id === 'image' && params.image.fast ? COVERAGE_GAP_FAST_SEC : COVERAGE_GAP_SEC, duration * COVERAGE_GAP_FRACTION);
      if (duration - read > gap) {
        warnings.push({ code: `${id.toUpperCase()}_SHORT`, message: `Só foi possível ler ${id === 'audio' ? 'o áudio' : 'a imagem'} até ${clockText(read)} (o vídeo tem ${clockText(duration)}): o arquivo pode estar incompleto ou danificado. O que vem depois disso não foi analisado.` });
      }
    }
    if (id === 'audio' && !r.data.partial) {
      let loudest = -Infinity;
      for (const level of r.data.db) if (level > loudest) loudest = level;
      if (loudest < SILENT_DB) {
        warnings.push({ code: 'AUDIO_SILENT', message: 'A faixa de áudio lida está sem som, então o sinal de áudio não ajudou. A análise (como a exportação) usa só a primeira faixa de áudio do arquivo: se o som está em outra faixa, ela não foi analisada.' });
      }
    }
    if (!r.cached && !r.data.partial) {
      try { cache.set(...cacheKeyFor[id], r.data); } catch { /* cache é opcional */ }
    }
  }

  // ---- pontuação e combinação ----
  if (onProgress) onProgress({ p: 0.98, stage: 'combine', message: 'Combinando os sinais…' });
  // A duração do ffprobe manda: nenhuma sugestão pode passar do fim real do vídeo (a exportação recusa o corte que termina depois dele).
  // O que o ffmpeg mediu (janelas de áudio arredondadas para cima, quadro da imagem) só vale quando a duração é desconhecida.
  const audioSec = extracted.audio ? Math.ceil(extracted.audio.data.db.length * extracted.audio.data.windowSec) : 0;
  const imageSec = extracted.image ? extracted.image.data.seconds : 0;
  const textSec = useText ? Math.ceil(cues.reduce((m, c) => Math.max(m, c.end), 0)) : 0;
  const total = knownDuration ? duration : Math.max(audioSec, imageSec, textSec);
  const n = Math.ceil(total);
  const th = thresholds(params.sensitivity);
  const scored = [];
  if (extracted.audio) scored.push(scoreAudio(extracted.audio.data, { n, th, baselineSec: params.baselineSec }));
  const conversa = params.profile === 'conversa';
  if (extracted.image) scored.push(scoreImage(extracted.image.data, { n, th, baselineSec: params.baselineSec, ignoreCuts: conversa }));
  if (chat) {
    const s = scoreChat(chat, { n, th, params });
    info.chat.used = true;
    info.chat.messages = s.stats.messages;
    info.chat.keywordMessages = s.stats.keywordMessages;
    scored.push(s);
  }
  // momento calmo: precisa do volume (áudio); a imagem e a transcrição, quando existem, tiram pausas, telas paradas e trechos com fala
  if (want.calm && extracted.audio) {
    const s = scoreCalm({ audio: extracted.audio.data, image: extracted.image ? extracted.image.data : null }, { n, th, cues: request.transcript && request.transcript.stale ? [] : cues });
    info.calm.used = true;
    info.calm.calmSeconds = s.stats.calmSeconds;
    scored.push(s);
  }
  if (useText) {
    const s = scoreText({ cues }, {
      n, th, baselineSec: params.baselineSec, textWeights: params.textWeights, humor: params.humor, profile: params.profile
    });
    info.text.used = true;
    info.text.cues = s.stats.cues;
    info.text.laughs = s.stats.laughs;
    if (params.humor.phrases.length || params.humor.reactions.length) info.text.humorHits = s.stats.humorHits; // quantas vezes o perfil do canal apareceu na fala
    scored.push(s);
    const covered = textSec;
    if (total > 0 && covered < total * TEXT_COVERAGE_MIN) {
      warnings.push({ code: 'TEXT_SHORT', message: `A transcrição cobre só ${Math.round((covered / total) * 100)}% do vídeo (até ${clockText(covered)}): o texto não ajuda no que vem depois disso.` });
    }
  }
  if (!scored.length) {
    // "confira o FFmpeg" só faz sentido quando alguma leitura foi tentada e falhou; com tudo desligado/ausente o problema são os ajustes
    const advice = failedIds.length
      ? 'Ligue ao menos um sinal que o vídeo tenha e confira se o FFmpeg consegue abrir o arquivo.'
      : 'Ligue ao menos um sinal que o vídeo tenha (áudio, imagem, um chat baixado na aba Novo projeto ou uma transcrição).';
    throw new AnalysisError('NO_SIGNALS', `Nenhum sinal pôde ser analisado. ${[
      info.audio.reason && `Áudio: ${info.audio.reason}.`,
      info.image.reason && `Imagem: ${info.image.reason}.`,
      info.chat.reason && `Chat: ${info.chat.reason}.`,
      info.text.reason && `Texto: ${info.text.reason}.`,
      info.calm.reason && `Momento calmo: ${info.calm.reason}.`
    ].filter(Boolean).join(' ')} ${advice}`, { signals: info, warnings });
  }

  // com transcrição, os cortes começam e terminam em limites de falas
  // (perfil de conversa: limites de FRASE, com alcance maior; sem pontuação na transcrição, limites de fala como no gameplay)
  const alignTo = useText
    ? ((conversa && sentenceBounds(cues)) || { starts: cues.map((c) => c.start).sort((a, b) => a - b), ends: cues.map((c) => c.end).sort((a, b) => a - b) })
    : null;
  // os momentos calmos têm cota própria (calmLimit): primeiro os picos, depois o calmo nos trechos que sobraram; só calmo, a cota é a inteira
  const peakSignals = scored.filter((s) => s.id !== 'calm');
  const calmSignals = scored.filter((s) => s.id === 'calm');
  const cutParams = conversa
    ? { ...params, minDurationSec: Math.max(params.minDurationSec, CONVERSA_MIN_SEC), maxDurationSec: Math.max(params.maxDurationSec, CONVERSA_MAX_SEC) }
    : params;
  // episódios (segments.js): as telas de espera entre programas (imagem parada, silêncio, sem fala) ficam fora de qualquer sugestão e cada
  // episódio ganha pelo menos uma, quando tem um pico acima da relevância mínima. A transcrição só ajuda quando o texto entra na análise
  // (e na chave do resultado)
  const seg = params.episodes
    ? findBreaks({ image: extracted.image ? extracted.image.data : null, audio: extracted.audio ? extracted.audio.data : null, cues: useText ? cues : null, n })
    : { breaks: [], episodes: [] };
  const walls = seg.breaks.map((b) => ({ ...b, gap: 0 })); // sem folga: o corte pode começar assim que a espera acaba
  let suggestions = combine({
    n, duration: total, signals: peakSignals.length ? peakSignals : calmSignals, params: cutParams, alignTo, blocked: walls, groups: seg.episodes
  });
  let limit = suggestionLimit(params, total);
  if (peakSignals.length && calmSignals.length && params.weights.calm > 0) {
    const quota = calmLimit(params, total);
    const calmPicks = combine({ n, duration: total, signals: calmSignals, params: cutParams, alignTo, blocked: [...walls, ...suggestions], limitOverride: quota });
    suggestions = [...suggestions, ...calmPicks].sort((x, y) => y.relevance - x.relevance);
    if (calmPicks.length) limit += quota; // o teto só cresce quando o calmo achou algo: sem trecho calmo, o limite é o de sempre
  }
  if (seg.episodes.length) for (const s of suggestions) s.episode = episodeAt(seg.episodes, s.peak);
  const result = {
    version: ALGO_VERSION,
    at: new Date().toISOString(),
    fromCache: false,
    tookMs: Date.now() - startedAt,
    source: { duration: total, hasAudio: hasAudio !== false },
    params,
    signals: info,
    usedSignals: scored.map((s) => s.id),
    limit,
    episodes: seg.episodes,
    breaks: seg.breaks,
    warnings,
    suggestions
  };
  // resultado incompleto (um sinal falhou, ou o ffmpeg saiu com erro e deu só parte dos dados) NÃO é guardado: uma falha passageira
  // (antivírus, disco, processo morto) não pode virar resultado permanente; a próxima análise lê o vídeo de novo
  if (!failedIds.length && !partial) {
    try { cache.set('res', resultKey, result); } catch { /* cache é opcional */ }
  }
  if (onProgress) onProgress({ p: 1, stage: 'done', message: 'Análise concluída.' });
  return result;
}

module.exports = { analyzeSource, sentenceBounds, CONVERSA_MIN_SEC, CONVERSA_MAX_SEC };
