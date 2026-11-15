'use strict';

/**
 * Regras e filtro dos ajustes MANUAIS de áudio por corte (arquitetura 3.3).
 *
 * Escopo: só o que o usuário pede — ganho em dB, mudo e fades de entrada/saída. Não existe nenhum
 * tratamento automático aqui (nada de normalização, redução de ruído, compressor ou melhoria de voz).
 * Os ajustes ficam em `cut.audio` e valem só na exportação; a fonte nunca é alterada.
 *
 * Arquivo "universal" (como projects/model.js): módulo CommonJS no processo principal e, carregado por
 * <script> no renderer, expõe `window.BFAudioFilter`. Assim a prévia (Web Audio) usa exatamente as
 * mesmas regras de limite e o mesmo envelope que o filtro do FFmpeg aplica na exportação.
 *
 * Uso na exportação:
 *   const { buildAudioFilter } = require('../audio/audioFilter');
 *   const af = buildAudioFilter(cut.audio, { duration: cut.end - cut.start });   // string | null
 *   if (af) args.push('-af', af);
 * O filtro supõe que o áudio do corte começa em t = 0 (é o caso de `-ss <início> -to <fim> -i <fonte>`,
 * com o `-ss` ANTES do `-i`). Se a exportação cortar depois da entrada (`-ss` depois do `-i`), passe
 * `offset: cut.start` para os fades acompanharem o tempo da fonte.
 */
(function () {
  const LIMITS = Object.freeze({
    gainMinDb: -30,
    gainMaxDb: 20,
    /** Cada fade pode ocupar, no máximo, metade da duração do corte. */
    fadeMaxFraction: 0.5,
    maxHistory: 50
  });

  const GAIN_EPSILON_DB = 0.005; // abaixo disso o ganho é considerado zero
  const FADE_EPSILON_SEC = 0.001; // abaixo disso não há fade

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Número finito (aceita string numérica, inclusive com vírgula); senão o padrão. */
  function num(v, fallback) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim().replace(',', '.'));
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  function round(n, decimals) {
    const f = 10 ** decimals;
    return Math.round(n * f) / f;
  }

  /** Formato curto para filtro do ffmpeg: sem zeros à direita nem notação científica ("0.5", "-6", "2.25"). */
  function fmtNum(n, decimals) {
    const r = round(n, decimals);
    return String(Object.is(r, -0) ? 0 : r);
  }

  /** Número para texto de aviso na tela (pt-BR: vírgula decimal). O filtro do ffmpeg usa fmtNum (ponto). */
  const ptNum = (n, decimals) => fmtNum(n, decimals).replace('.', ',');

  /**
   * Os quatro valores do ajuste, sempre válidos: ganho dentro de -30..+20 dB (2 casas), mudo booleano,
   * fades >= 0 (3 casas). Não considera a duração do corte (veja resolveAudio).
   */
  function normalizeAudio(raw) {
    const a = isObj(raw) ? raw : {};
    return {
      gainDb: round(clamp(num(a.gainDb, 0), LIMITS.gainMinDb, LIMITS.gainMaxDb), 2),
      mute: a.mute === true,
      fadeInSec: round(Math.max(0, num(a.fadeInSec, 0)), 3),
      fadeOutSec: round(Math.max(0, num(a.fadeOutSec, 0)), 3)
    };
  }

  /** Maior fade permitido para um corte desta duração (metade, arredondada para baixo em ms). */
  function maxFadeSec(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return 0;
    return Math.floor(duration * LIMITS.fadeMaxFraction * 1000) / 1000;
  }

  /**
   * Valores efetivos de um ajuste para um corte de `duration` segundos: aplica os limites (fades até a
   * metade da duração) e lista o que foi limitado em `warnings` (avisos, nunca erros). Não altera `audio`.
   * `neutral` = nada a fazer (sem filtro).
   */
  function resolveAudio(audio, { duration } = {}) {
    const raw = isObj(audio) ? audio : {};
    const a = normalizeAudio(raw);
    const known = Number.isFinite(duration) && duration > 0;
    const warnings = [];

    const rawGain = num(raw.gainDb, 0);
    if (Math.abs(rawGain - a.gainDb) > GAIN_EPSILON_DB) {
      warnings.push({ code: 'GAIN_LIMITED', message: `O ganho de ${ptNum(rawGain, 2)} dB passa do limite; a exportação usa ${ptNum(a.gainDb, 2)} dB (limites: ${LIMITS.gainMinDb} a +${LIMITS.gainMaxDb} dB).` });
    }

    let fadeIn = a.fadeInSec;
    let fadeOut = a.fadeOutSec;
    const maxFade = known ? maxFadeSec(duration) : null;
    if (known) {
      if (fadeIn > maxFade) {
        warnings.push({ code: 'FADE_IN_LIMITED', message: `O fade in de ${ptNum(fadeIn, 2)} s passa da metade do corte; a exportação usa ${ptNum(maxFade, 2)} s.` });
        fadeIn = maxFade;
      }
      if (fadeOut > maxFade) {
        warnings.push({ code: 'FADE_OUT_LIMITED', message: `O fade out de ${ptNum(fadeOut, 2)} s passa da metade do corte; a exportação usa ${ptNum(maxFade, 2)} s.` });
        fadeOut = maxFade;
      }
    } else if (fadeOut >= FADE_EPSILON_SEC) {
      // sem a duração não dá para saber onde o fade out começa
      warnings.push({ code: 'FADE_OUT_NEEDS_DURATION', message: 'Sem a duração do corte não é possível aplicar o fade out; informe { duration } ao montar o filtro.' });
      fadeOut = 0;
    }
    if (fadeIn < FADE_EPSILON_SEC) fadeIn = 0;
    if (fadeOut < FADE_EPSILON_SEC) fadeOut = 0;

    const neutral = !a.mute && Math.abs(a.gainDb) < GAIN_EPSILON_DB && fadeIn === 0 && fadeOut === 0;
    return { gainDb: a.gainDb, mute: a.mute, fadeInSec: fadeIn, fadeOutSec: fadeOut, maxFadeSec: maxFade, neutral, warnings };
  }

  /**
   * Filtro de áudio do FFmpeg (`-af`) para os ajustes de um corte, ou null quando não há nada a fazer.
   * `audio`: { gainDb, mute, fadeInSec, fadeOutSec } (o que estiver em cut.audio; `history` é ignorado).
   * `opts.duration`: duração do corte em segundos (obrigatória para o fade out); `opts.offset`: tempo, no
   * fluxo que o filtro vê, em que o corte começa (padrão 0; veja o topo do arquivo).
   *
   *   mudo            -> "volume=0" (fades não fazem sentido)
   *   ganho != 0      -> "volume=<dB>dB"
   *   fade in         -> "afade=t=in:st=<offset>:d=<s>"
   *   fade out        -> "afade=t=out:st=<offset + duração - s>:d=<s>"
   */
  function buildAudioFilter(audio, opts = {}) {
    const r = resolveAudio(audio, { duration: opts.duration });
    if (r.neutral) return null;
    if (r.mute) return 'volume=0';
    const offset = Number.isFinite(opts.offset) ? Math.max(0, opts.offset) : 0;
    const parts = [];
    if (Math.abs(r.gainDb) >= GAIN_EPSILON_DB) parts.push(`volume=${fmtNum(r.gainDb, 2)}dB`);
    if (r.fadeInSec > 0) parts.push(`afade=t=in:st=${fmtNum(offset, 3)}:d=${fmtNum(r.fadeInSec, 3)}`);
    if (r.fadeOutSec > 0) parts.push(`afade=t=out:st=${fmtNum(offset + opts.duration - r.fadeOutSec, 3)}:d=${fmtNum(r.fadeOutSec, 3)}`);
    return parts.length ? parts.join(',') : null;
  }

  // ---------- envelope (usado pela prévia, mesma matemática do filtro) ----------

  const dbToLinear = (db) => 10 ** (db / 20);
  const linearToDb = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

  /**
   * Ganho linear no instante `t` (segundos desde o início do corte) para os valores já resolvidos
   * (`resolveAudio`). Igual ao filtro: volume fixo vezes a rampa linear do afade in e do afade out.
   */
  function envelopeAt(resolved, t, duration) {
    if (resolved.mute) return 0;
    let g = dbToLinear(resolved.gainDb);
    if (resolved.fadeInSec > 0 && t < resolved.fadeInSec) g *= clamp(t / resolved.fadeInSec, 0, 1);
    if (resolved.fadeOutSec > 0 && t > duration - resolved.fadeOutSec) g *= clamp((duration - t) / resolved.fadeOutSec, 0, 1);
    return g;
  }

  /** Pontos [t, ganho linear] onde o envelope muda de inclinação (entre eles a variação é linear). */
  function envelopePoints(resolved, duration) {
    const times = [0];
    if (resolved.fadeInSec > 0) times.push(resolved.fadeInSec);
    if (resolved.fadeOutSec > 0) times.push(duration - resolved.fadeOutSec);
    times.push(duration);
    const unique = [...new Set(times.map((t) => round(clamp(t, 0, duration), 6)))].sort((x, y) => x - y);
    return unique.map((t) => [t, envelopeAt(resolved, t, duration)]);
  }

  /**
   * Plano de automação do GainNode da prévia (Web Audio) a partir da posição atual do player, em passos
   * { op: 'set' | 'ramp', value, time } em ordem cronológica, no relógio do áudio (`now` + tempo até o ponto).
   * 'set' = AudioParam.setValueAtTime; 'ramp' = linearRampToValueAtTime.
   *
   * Dentro do corte vale o envelope (ganho/mudo vezes as rampas dos fades, igual ao filtro da exportação);
   * antes dele o som passa como está, com uma rampa curta de entrada; depois do fim o último valor é mantido por
   * `graceSec` (o player para um pouco depois do fim: sem isso, o som cheio vazaria num estalo) e então volta
   * ao normal. Opções: { start, end (do corte, em segundos da fonte), mediaTime (posição do player), rate,
   * now, graceSec }.
   */
  function previewPlan(resolved, opts) {
    const { start, end, mediaTime } = opts;
    const duration = end - start;
    const now = Number.isFinite(opts.now) ? opts.now : 0;
    const rate = opts.rate > 0 ? opts.rate : 1;
    const grace = Number.isFinite(opts.graceSec) ? opts.graceSec : 0.3;
    const at = (media) => now + Math.max(0, (media - mediaTime) / rate);
    const plan = [];
    const set = (value, time) => plan.push({ op: 'set', value, time });
    const ramp = (value, time) => plan.push({ op: 'ramp', value, time });

    if (mediaTime >= end + grace) { set(1, now); return plan; }
    let cursor;
    if (mediaTime < start) {
      // ainda antes do corte: som normal até um instante antes, e uma rampa curta até o valor do início
      set(1, now);
      if (start - mediaTime > 0.03) set(1, at(start - 0.02));
      ramp(envelopeAt(resolved, 0, duration), at(start));
      cursor = 0;
    } else {
      cursor = clamp(mediaTime - start, 0, duration);
      set(envelopeAt(resolved, cursor, duration), now);
    }
    for (const [t, value] of envelopePoints(resolved, duration)) {
      if (t > cursor + 1e-6) ramp(value, at(start + t));
    }
    set(envelopeAt(resolved, duration, duration), at(end + grace));
    ramp(1, at(end + grace + 0.05));
    return plan;
  }

  const api = {
    LIMITS, GAIN_EPSILON_DB, FADE_EPSILON_SEC,
    normalizeAudio, maxFadeSec, resolveAudio, buildAudioFilter,
    dbToLinear, linearToDb, envelopeAt, envelopePoints, previewPlan
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFAudioFilter = api;
})();
