'use strict';

const { AnalysisError, cancelled } = require('./errors');
const { ALGO_VERSION, RESULT_REVISION, normalizeParams, thresholds, suggestionLimit, calmLimit, canonicalJson, sha1 } = require('./params');
const { AnalysisCache, sourceKey } = require('./cache');
const { extractAudio, scoreAudio } = require('./audioSignal');
const { extractImage, scoreImage } = require('./imageSignal');
const { loadChat, chatFingerprint, scoreChat } = require('./chatSignal');
const { scoreText } = require('./textSignal');
const { isLaughter } = require('./transcript/format');
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
// perfil de gameplay: o corte começa no lance, não na reação (combine, `leadIn`). Medido numa live de CoD (16/11/2026): o lance vem 5 a
// 40 s antes da reação ("Nossa senhora!", o riso). O início volta 8 s antes do evento e, se o som do jogo estava ativo antes (score do
// áudio >= 0,2, buracos de até 15 s), segue essa atividade até 40 s antes: o parceiro atropelado pelo trem 30 s antes do riso passou a
// entrar no corte. Buraco de 12 s não alcançava (o jogo fica quieto e ninguém fala entre o lance e a reação)
// filtro de ideias fracas (params.filterWeak; docs "Filtro de ideias fracas"): com transcrição, a sugestão precisa de ao menos uma reação de
// voz ou do chat. Medido numa live de CoD (16/11/2026, 86 candidatos): "voz + volume" acerta 16 de 24 e "voz sem volume" 7 de 14; sem
// voz, "volume sozinho" acerta 5 de 25, "volume + repetição/ritmo" 2 de 14 e "só repetição/ritmo/imagem" 1 de 9
const VOICE_EVIDENCE = Object.freeze(['text:laugh', 'text:exclaim', 'text:meta', 'text:humor', 'text:structure', 'text:loop', 'chat:rate', 'chat:keywords']);
// no perfil de conversa o ritmo de fala também é reação de voz (num podcast é uma das pistas que mais pesam: sem ela a live medida cai de 5
// para 3 de 20); no gameplay, ritmo sozinho acertou pouco
const VOICE_EVIDENCE_CONVERSA = Object.freeze([...VOICE_EVIDENCE, 'text:pace']);
// o filtro só vale quando a transcrição marca reações: abaixo disto por hora (a do .md importado da live de podcast: 20; a do Whisper do
// app na live de CoD: 61) ele fica desligado e a análise avisa. Medido em duas transcrições: é um corte prudente, não calibrado
const MIN_VOICE_PER_HOUR = 30;
// CONCORDÂNCIA das pistas: em quantas FAMÍLIAS independentes a sugestão tem evidência. Uma família no máximo (o volume estourado, a fala
// rápida) diz pouco; quando a voz reage, o chat ri, o volume sobe e a fala acelera no mesmo trecho, quase sempre há um momento ali. Medido
// numa gameplay de 4h18 contra a seleção feita à mão (lista bem aberta, 188 sugestões): 1 família 10% de acerto, 2 famílias 38%, 3 famílias
// 51%, 4 famílias 69%. A imagem fica de fora (troca de cena acontece em quase todo trecho de jogo) e o momento calmo conta zero.
const FAMILIES = Object.freeze({
  voice: Object.freeze(['text:laugh', 'text:laughrun', 'text:exclaim', 'text:meta', 'text:humor', 'text:structure', 'text:loop']),
  chat: Object.freeze(['chat:rate', 'chat:keywords', 'chat:laugh']),
  audio: Object.freeze(['audio:level', 'audio:rise']),
  speech: Object.freeze(['text:pace', 'text:repeat'])
});
/** Em quantas famílias de pista (voz, chat, volume, ritmo da fala) a evidência aparece: 0 a 4. */
function agreementOf(evidence) {
  let count = 0;
  for (const kinds of Object.values(FAMILIES)) if ((evidence || []).some((e) => kinds.includes(e))) count += 1;
  return count;
}
// quantidade automática: como não há teto por hora, uma pista sozinha não basta (com o filtro valendo). A sugestão precisa de duas famílias
// de pista, ou de duas reações de voz DIFERENTES (risada e fala sobre o momento, exclamação e risada…), que já se confirmam entre si
const AUTO_MIN_AGREEMENT = 2;
/** A evidência se confirma? Duas famílias, ou duas reações de voz diferentes. */
function corroborated(evidence) {
  if (agreementOf(evidence) >= AUTO_MIN_AGREEMENT) return true;
  return (evidence || []).filter((e) => FAMILIES.voice.includes(e)).length >= 2;
}
const ONE_CUE_REASON = 'uma pista só (sem outra que confirme)';
// "fim cobrindo a reação" (combine.js, tailOut): o corte segue a risada marcada até 30 s além do fim, tolerando buracos de 4 s
const REACTION_TAIL = Object.freeze({ maxSec: 30, gapSec: 4 });
const WEAK_REASON = 'sem reação de voz nem do chat';
const GAMEPLAY_LEAD = Object.freeze({ baseSec: 8, maxSec: 40, gapSec: 15, minScore: 0.2 });

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
    v: ALGO_VERSION, rev: RESULT_REVISION, key, hasAudio: hasAudio !== false, params, chat: chat ? chatFingerprint(request.chatPath) : null,
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
    // stageP: quanto DESTA etapa já foi (0..1). A tela estima o tempo pela etapa em andamento: a barra inteira mistura etapas de ritmos
    // muito diferentes (o áudio de uma live de 4 h leva 1 a 2 min e a imagem, dezenas), e a conta pela barra só fazia o tempo restante subir
    onProgress({ p: Math.min(0.97, (w.audio * prog.audio + w.image * prog.image) / sum), stage, stageP: prog[stage], message: stageText[stage] });
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
  let th = thresholds(params.sensitivity);
  // QUANTIDADE AUTOMÁTICA com o filtro valendo (transcrição que marca reações): a detecção fica um degrau mais sensível. Sem teto por hora,
  // quem segura a qualidade é o filtro (reação de voz ou do chat) e a exigência de duas famílias de pista; com eles, um degrau a mais trouxe
  // 7 momentos fortes ou bons a mais na gameplay medida (25 contra 18 de 37), com as 20 primeiras da lista iguais ou melhores.
  let autoBoost = false;
  if (params.autoQuantity && params.filterWeak && useText && params.sensitivity < 5) {
    const probe = scoreText({ cues }, { n, th, baselineSec: params.baselineSec, textWeights: params.textWeights, humor: params.humor, profile: params.profile });
    if (total > 0 && (probe.stats.voiceSeconds || 0) / (total / 3600) >= MIN_VOICE_PER_HOUR) {
      th = thresholds(params.sensitivity + 1);
      autoBoost = true;
    }
  }
  const scored = [];
  if (extracted.audio) scored.push(scoreAudio(extracted.audio.data, { n, th, baselineSec: params.baselineSec }));
  const conversa = params.profile === 'conversa';
  if (extracted.image) scored.push(scoreImage(extracted.image.data, { n, th, baselineSec: params.baselineSec, ignoreCuts: conversa }));
  if (chat) {
    const s = scoreChat(chat, { n, th, params });
    info.chat.used = true;
    info.chat.messages = s.stats.messages;
    info.chat.keywordMessages = s.stats.keywordMessages;
    if (s.stats.small) info.chat.laughMessages = s.stats.laughMessages; // chat pequeno: quantas mensagens de riso contaram como reação
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
  const audioScored = scored.find((s) => s.id === 'audio');
  const leadIn = !conversa && peakSignals.length ? { ...GAMEPLAY_LEAD, signal: audioScored ? audioScored.score : new Float64Array(n) } : null;
  // só com transcrição (sem ela não há como saber se houve reação de voz) e só na rodada dos picos (o momento calmo é calmo de propósito)
  const filtered = [];
  const textScored = scored.find((s) => s.id === 'text');
  const voicePerHour = textScored && total > 0 ? (textScored.stats.voiceSeconds || 0) / (total / 3600) : 0;
  const filterOn = Boolean(params.filterWeak && useText && peakSignals.length && voicePerHour >= MIN_VOICE_PER_HOUR);
  if (params.filterWeak && useText && peakSignals.length && !filterOn) {
    warnings.push({ code: 'FILTER_OFF', message: `O filtro de ideias fracas ficou desligado nesta análise: a transcrição quase não marca risadas, exclamações ou reações (${Math.round(voicePerHour)} por hora; o filtro precisa de ${MIN_VOICE_PER_HOUR}). Legenda sem pontuação ou sem risadas costuma dar isso.` });
  }
  const voiceKinds = conversa ? VOICE_EVIDENCE_CONVERSA : VOICE_EVIDENCE;
  const discard = filterOn
    ? (c) => {
      // reação: da voz, do chat em rajada, ou a risada de um chat pequeno JUNTO de fala animada (ritmo ou repetição). A risada do chat com
      // volume alto e mais nada acertou pouco (27% contra 43% com a fala animada, na gameplay medida): costuma ser barulho do jogo
      const laughWithSpeech = c.evidence.includes('chat:laugh') && c.evidence.some((e) => FAMILIES.speech.includes(e));
      if (!c.evidence.some((e) => voiceKinds.includes(e)) && !laughWithSpeech) return WEAK_REASON;
      if (params.autoQuantity && !corroborated(c.evidence)) return ONE_CUE_REASON;
      return null;
    }
    : null;
  // risada marcada na transcrição, segundo a segundo: o corte termina depois dela (combine.js, tailOut)
  let tailOut = null;
  if (useText && peakSignals.length) {
    const active = new Uint8Array(n);
    let any = false;
    for (const cue of cues) {
      if (!cue || !(cue.end > cue.start) || !(cue.laugh === true || isLaughter(cue.text))) continue;
      for (let k = Math.max(0, Math.floor(cue.start)); k < Math.min(n, Math.ceil(cue.end)); k += 1) { active[k] = 1; any = true; }
    }
    if (any) tailOut = { ...REACTION_TAIL, active };
  }
  let suggestions = combine({
    n, duration: total, signals: peakSignals.length ? peakSignals : calmSignals, params: cutParams, alignTo, blocked: walls, groups: seg.episodes, leadIn,
    tailOut, discard, discarded: filtered
  });
  let limit = suggestionLimit(params, total);
  if (peakSignals.length && calmSignals.length && params.weights.calm > 0) {
    const quota = calmLimit(params, total);
    const calmPicks = combine({ n, duration: total, signals: calmSignals, params: cutParams, alignTo, blocked: [...walls, ...suggestions], limitOverride: quota });
    suggestions = [...suggestions, ...calmPicks].sort((x, y) => y.relevance - x.relevance);
    if (calmPicks.length) limit += quota; // o teto só cresce quando o calmo achou algo: sem trecho calmo, o limite é o de sempre
  }
  if (seg.episodes.length) for (const s of suggestions) s.episode = episodeAt(seg.episodes, s.peak);
  // em quantas famílias de pista a sugestão tem evidência (informação; a ORDEM da lista continua a da relevância: ordenar pela concordância
  // foi medido e piorou o topo da lista, 12 acertos nas 20 primeiras contra 16)
  for (const s of suggestions) s.agreement = agreementOf(s.evidence);
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
    // o que o filtro de ideias fracas descartou (o motivo e os sinais de cada uma), para conferir
    filtered: filtered.slice(0, 300),
    filter: { on: filterOn, voicePerHour: Math.round(voicePerHour * 10) / 10, discarded: filtered.length, ...(autoBoost ? { autoSensitivity: params.sensitivity + 1 } : {}) },
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

module.exports = {
  analyzeSource, sentenceBounds, agreementOf, corroborated, CONVERSA_MIN_SEC, CONVERSA_MAX_SEC, GAMEPLAY_LEAD, VOICE_EVIDENCE, VOICE_EVIDENCE_CONVERSA, MIN_VOICE_PER_HOUR,
  FAMILIES, AUTO_MIN_AGREEMENT, REACTION_TAIL
};
