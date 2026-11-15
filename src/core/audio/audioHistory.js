'use strict';

/**
 * Histórico, desfazer/refazer e "voltar ao original" dos ajustes de áudio de UM corte.
 *
 * Tudo é puro: recebe o `cut.audio` atual e devolve um `cut.audio` novo (o chamador grava com
 * BF.project.update). Modelo de dados dentro de `cut.audio`:
 *   - gainDb, mute, fadeInSec, fadeOutSec: os valores em vigor;
 *   - history: entradas JÁ APLICADAS, da mais antiga à mais nova: { at, label, before, after } (máx. 50),
 *     onde before/after são os quatro valores antes e depois da mudança;
 *   - redo: entradas desfeitas, prontas para refazer (campo extra; some quando vazio). Uma mudança nova
 *     descarta o redo, como em qualquer editor.
 * Mudanças seguidas no MESMO campo em poucos instantes (arrastar o controle, setas do teclado) viram uma
 * entrada só. Nenhuma operação toca na fonte: só os valores de ajuste mudam.
 *
 * Arquivo "universal": CommonJS no processo principal; no renderer expõe `window.BFAudioHistory`
 * (depende de `window.BFAudioFilter`, carregado antes).
 */
(function () {
  const rules = typeof module === 'object' && module && module.exports ? require('./audioFilter') : globalThis.BFAudioFilter;
  const { normalizeAudio, LIMITS } = rules;

  const FIELDS = Object.freeze(['gainDb', 'mute', 'fadeInSec', 'fadeOutSec']);
  const COALESCE_MS = 1200;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  /** Os quatro valores (normalizados) de um ajuste. */
  const values = (audio) => normalizeAudio(audio);

  const sameValues = (a, b) => FIELDS.every((f) => a[f] === b[f]);
  const changedFields = (a, b) => FIELDS.filter((f) => a[f] !== b[f]);

  // ---------- rótulos (pt-BR) ----------

  /** "6" -> "6", "3.5" -> "3,5" (sem zeros à direita, vírgula decimal). */
  const pt = (n, decimals = 2) => String(Math.round(n * 10 ** decimals) / 10 ** decimals).replace('.', ',');
  const signed = (n) => `${n > 0 ? '+' : ''}${pt(n)}`;

  function labelForField(field, after) {
    switch (field) {
      case 'gainDb': return `Ganho ${signed(after.gainDb)} dB`;
      case 'mute': return after.mute ? 'Mudo ligado' : 'Mudo desligado';
      case 'fadeInSec': return after.fadeInSec > 0 ? `Fade in ${pt(after.fadeInSec)} s` : 'Fade in removido';
      case 'fadeOutSec': return after.fadeOutSec > 0 ? `Fade out ${pt(after.fadeOutSec)} s` : 'Fade out removido';
      default: return 'Ajuste de áudio';
    }
  }

  function labelFor(before, after) {
    const changed = changedFields(before, after);
    return changed.length === 1 ? labelForField(changed[0], after) : 'Vários ajustes';
  }

  // ---------- leitura segura do que está gravado ----------

  /** Entrada válida { at, label, before, after } ou null (o arquivo do projeto pode ter sido editado à mão). */
  function sanitizeEntry(entry) {
    if (!isObj(entry) || !isObj(entry.before) || !isObj(entry.after)) return null;
    const before = values(entry.before);
    const after = values(entry.after);
    return {
      at: typeof entry.at === 'string' && !Number.isNaN(Date.parse(entry.at)) ? entry.at : new Date(0).toISOString(),
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label : labelFor(before, after),
      before,
      after
    };
  }

  function sanitizeList(list) {
    const out = (Array.isArray(list) ? list : []).map(sanitizeEntry).filter(Boolean);
    return out.slice(-LIMITS.maxHistory);
  }

  const historyOf = (audio) => sanitizeList(isObj(audio) ? audio.history : []);
  const redoOf = (audio) => sanitizeList(isObj(audio) ? audio.redo : []);

  /** Novo `cut.audio`: mantém os campos desconhecidos, troca valores/histórico e tira o `redo` se vazio. */
  function build(audio, vals, history, redo) {
    const base = isObj(audio) ? audio : {};
    const next = { ...base, ...vals, history: history.slice(-LIMITS.maxHistory) };
    if (redo.length) next.redo = redo.slice(-LIMITS.maxHistory); else delete next.redo;
    return next;
  }

  const canUndo = (audio) => historyOf(audio).length > 0;
  const canRedo = (audio) => redoOf(audio).length > 0;

  // ---------- operações ----------

  /**
   * Aplica `patch` (qualquer subconjunto de gainDb/mute/fadeInSec/fadeOutSec). Devolve
   * { changed, audio, entry, before, after }. Sem mudança real: changed=false e `audio` intacto.
   * Opções: { now (ms), label, coalesceMs, coalesce:false }.
   */
  function applyChange(audio, patch, opts = {}) {
    const before = values(audio);
    const after = values({ ...before, ...(isObj(patch) ? patch : {}) });
    if (sameValues(before, after)) return { changed: false, audio, entry: null, before, after };

    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    const history = historyOf(audio);
    const label = opts.label || labelFor(before, after);
    const last = history[history.length - 1];
    const coalesceWindow = Number.isFinite(opts.coalesceMs) ? opts.coalesceMs : COALESCE_MS;

    if (opts.coalesce !== false && last && !opts.label) {
      const lastFields = changedFields(last.before, last.after);
      const fields = changedFields(before, after);
      const recent = now - Date.parse(last.at) <= coalesceWindow && now >= Date.parse(last.at);
      if (recent && fields.length === 1 && lastFields.length === 1 && lastFields[0] === fields[0] && sameValues(last.after, before)) {
        // mesma mexida contínua: uma entrada só, do valor de antes ao valor de agora
        if (sameValues(last.before, after)) {
          // voltou ao ponto de partida: a entrada some
          return { changed: true, audio: build(audio, after, history.slice(0, -1), []), entry: null, before, after };
        }
        const merged = { at: new Date(now).toISOString(), label: labelFor(last.before, after), before: last.before, after };
        return { changed: true, audio: build(audio, after, [...history.slice(0, -1), merged], []), entry: merged, before, after };
      }
    }

    const entry = { at: new Date(now).toISOString(), label, before, after };
    return { changed: true, audio: build(audio, after, [...history, entry], []), entry, before, after };
  }

  /** Desfaz a última mudança aplicada. null se não há o que desfazer. */
  function undo(audio) {
    const history = historyOf(audio);
    if (!history.length) return null;
    const entry = history[history.length - 1];
    const before = values(audio);
    return { changed: true, audio: build(audio, entry.before, history.slice(0, -1), [...redoOf(audio), entry]), entry, before, after: entry.before };
  }

  /** Refaz a última mudança desfeita. null se não há o que refazer. */
  function redo(audio) {
    const stack = redoOf(audio);
    if (!stack.length) return null;
    const entry = stack[stack.length - 1];
    const before = values(audio);
    return { changed: true, audio: build(audio, entry.after, [...historyOf(audio), entry], stack.slice(0, -1)), entry, before, after: entry.after };
  }

  /**
   * Restaura o estado em que a entrada `index` (do histórico atual) deixou o áudio. Vira uma entrada nova
   * ("Restaurado: ..."), então também dá para desfazer a restauração.
   */
  function restoreEntry(audio, index, opts = {}) {
    const history = historyOf(audio);
    const target = history[index];
    if (!target) return { changed: false, audio, entry: null, before: values(audio), after: values(audio) };
    return applyChange(audio, target.after, { ...opts, label: `Restaurado: ${target.label}` });
  }

  /** Zera ganho, mudo e fades (volta ao áudio original). Fica no histórico, então dá para desfazer. */
  function resetToOriginal(audio, opts = {}) {
    return applyChange(audio, { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0 }, { ...opts, label: 'Voltar ao original' });
  }

  const api = {
    FIELDS, COALESCE_MS, values, sameValues, changedFields, labelFor, sanitizeEntry,
    historyOf, redoOf, canUndo, canRedo, applyChange, undo, redo, restoreEntry, resetToOriginal
  };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFAudioHistory = api;
})();
