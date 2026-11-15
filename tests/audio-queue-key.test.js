'use strict';

/**
 * Áudio x fila: a chave que a fila usa para "não repetir o que já foi exportado" só pode mudar quando o ARQUIVO
 * exportado muda. Desfazer e refazer mexem em `cut.audio.history` e `cut.audio.redo` (pilha de refazer, campo extra do
 * áudio) sem mudar o som: se isso mudasse a chave, a fila exportaria de novo o mesmo vídeo (e cairia no conflito de nome).
 * Usa o histórico REAL (audioHistory.js) e a chave REAL da fila (queue/jobKey.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const AH = require('../src/core/audio/audioHistory');
const { jobKey } = require('../src/core/queue/jobKey');

const NEUTRAL = { gainDb: 0, mute: false, fadeInSec: 0, fadeOutSec: 0, history: [] };
const jobWith = (audio) => ({
  sourcePath: 'C:\\gravacoes\\jogo.mp4',
  sourceInfo: { duration: 600, width: 1920, height: 1080 },
  profile: { id: 'vertical-1080-h264', container: 'mp4' },
  framing: null,
  cut: { id: 'c1', start: 10, end: 40, audio }
});
const step = (audio, patch, now) => AH.applyChange(audio, patch, { now }).audio;

test('desfazer e refazer não mudam a chave da fila quando o som exportado é o mesmo', () => {
  const t0 = Date.parse('2026-10-21T10:00:00Z');
  const gain6 = step(NEUTRAL, { gainDb: 6 }, t0); // história [Ganho +6]
  const exportedKey = jobKey(jobWith(gain6)); // foi exportado assim

  // o usuário testa outro valor e volta atrás: o som é o mesmo, mas agora há uma pilha de refazer
  const gain8 = step(gain6, { gainDb: 8 }, t0 + 5000);
  const back = AH.undo(gain8).audio;
  assert.equal(back.gainDb, 6);
  assert.equal(AH.redoOf(back).length, 1, 'há uma entrada para refazer');
  assert.equal(jobKey(jobWith(back)), exportedKey, 'mesmo som = mesma chave (a fila reconhece o corte como já exportado)');

  // refazer leva ao outro som: chave diferente
  const redone = AH.redo(back).audio;
  assert.equal(redone.gainDb, 8);
  assert.notEqual(jobKey(jobWith(redone)), exportedKey);

  // e voltar ao original e refazer tudo também só depende dos valores
  const reset = AH.resetToOriginal(gain6, { now: t0 + 9000 }).audio;
  assert.equal(jobKey(jobWith(reset)), jobKey(jobWith(NEUTRAL)), 'sem ajuste = chave de um corte nunca ajustado');
});

test('a chave muda com qualquer ajuste que mude o som (ganho, mudo, fade in e fade out)', () => {
  const keys = new Set();
  for (const audio of [NEUTRAL, { ...NEUTRAL, gainDb: 6 }, { ...NEUTRAL, gainDb: 7 }, { ...NEUTRAL, mute: true }, { ...NEUTRAL, fadeInSec: 1 }, { ...NEUTRAL, fadeOutSec: 1 }]) {
    keys.add(jobKey(jobWith(audio)));
  }
  assert.equal(keys.size, 6);
});
