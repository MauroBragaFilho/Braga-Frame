'use strict';

/**
 * Tempos legíveis (usados por BF.util.fmt / parseTime / secs no renderer e testados no Node).
 *
 * Este arquivo é "universal", como o model.js: funciona como módulo CommonJS e, carregado por <script>, expõe
 * `window.BFTime`. Por isso não usa nenhum módulo do Node e fica dentro de uma função.
 *
 * Formato dos códigos de tempo: "m:ss.d" abaixo de 1 hora e "h:mm:ss.d" a partir dela (a mesma notação que a linha do
 * tempo e a análise mostram). O ponto separa o décimo de segundo no código de tempo; `parseTime` aceita ponto ou vírgula.
 * Durações escritas por extenso ("6,0 s") usam a vírgula do português: veja `secs`.
 */
(function () {
  /**
   * Segundos -> "m:ss.d" ou "h:mm:ss.d". Arredonda ao décimo ANTES de separar minutos e horas (59,96 s é "1:00.0", nunca
   * "0:60.0"); entrada inválida ou negativa vira 0.
   */
  function fmt(sec) {
    const value = Number(sec);
    const tenths = Math.round(Math.max(0, Number.isFinite(value) ? value : 0) * 10);
    const hours = Math.floor(tenths / 36000);
    const minutes = Math.floor((tenths % 36000) / 600);
    const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
  }

  /**
   * "1:23.5", "1:02:03", "1:02:03,5", "83,5" ou "83" -> segundos; NaN se não for um tempo válido. Em "h:mm:ss" os minutos
   * precisam ser menores que 60; em "m:ss" os segundos não são limitados (quem confere o fim do vídeo é a interface).
   */
  function parseTime(text) {
    const t = String(text === undefined || text === null ? '' : text).trim().replace(',', '.');
    const m = /^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t);
    if (!m) return NaN;
    const seconds = Number(m[3]);
    if (m[1] !== undefined && m[2] !== undefined) {
      if (Number(m[2]) >= 60) return NaN;
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + seconds;
    }
    if (m[1] !== undefined) return Number(m[1]) * 60 + seconds;
    return seconds;
  }

  /** Duração por extenso, com a vírgula do português: secs(6) -> "6,0 s", secs(4.5) -> "4,5 s". */
  function secs(sec, digits = 1) {
    const value = Number(sec);
    return `${(Number.isFinite(value) ? value : 0).toFixed(digits).replace('.', ',')} s`;
  }

  const api = { fmt, parseTime, secs };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFTime = api;
})();
