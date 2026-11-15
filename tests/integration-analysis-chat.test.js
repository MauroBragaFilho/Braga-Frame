'use strict';

/**
 * Integração análise x fontes (chat): a análise lê o chat pelas funções REAIS do recurso Fontes
 * (src/core/sources/chatFormat.js: `readChat` e `writeChat` assíncronas, `messagesPerWindow(chat, windowSec, durationSec?)`
 * síncrona que devolve number[]), com um chat `bf-chat-1` gravado pelo próprio `writeChat`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chatFormat = require('../src/core/sources/chatFormat');
const { loadChat, perSecondCounts } = require('../src/core/analysis/chatSignal');
const { analyzeSource } = require('../src/core/analysis/analyze');

const DURATION = 600;
const BURST = { from: 300, to: 306 };

/** Chat de uma "live": uma mensagem a cada 2 s, e uma rajada (20 por segundo, com "clip" no texto) em 300 a 306 s. */
function liveChat() {
  const messages = [];
  for (let t = 0; t < DURATION; t += 2) messages.push({ t, user: 'viewer', text: 'oi' });
  for (let t = BURST.from; t < BURST.to; t += 0.05) messages.push({ t: Math.round(t * 100) / 100, user: `fã${Math.floor(t * 20) % 7}`, text: 'CLIP!!! que jogada' });
  return { platform: 'twitch', videoId: '123456', messages };
}

async function withChat(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-integ-chat-'));
  try {
    const file = path.join(dir, 'chats', 'twitch-123456.json');
    const written = await chatFormat.writeChat(file, liveChat()); // exatamente como o recurso Fontes grava
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'x'.repeat(2048)); // só a chave de cache lê o arquivo: com só o sinal de chat nenhum ffmpeg roda
    return await fn({ dir, file, written, video: path.join(dir, 'video.mp4') });
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('writeChat (Fontes) -> loadChat/readChat (Análise): o chat gravado volta inteiro e ordenado', async () => {
  await withChat(async ({ file, written }) => {
    assert.equal(written.count, liveChat().messages.length);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.format, 'bf-chat-1');
    const read = await chatFormat.readChat(file);
    assert.equal(read.messages.length, written.count);
    const loaded = await loadChat(file);
    assert.equal(loaded.platform, 'twitch');
    assert.equal(loaded.messages.length, written.count);
    assert.ok(loaded.messages.every((m, i, all) => i === 0 || all[i - 1].t <= m.t), 'ordenado por t');
  });
});

test('a contagem por segundo da análise é a messagesPerWindow(chat, 1, n) do recurso Fontes', async () => {
  await withChat(async ({ file }) => {
    const chat = await chatFormat.readChat(file);
    const official = chatFormat.messagesPerWindow(chat, 1, DURATION);
    assert.ok(Array.isArray(official), 'devolve um array de contagens (síncrono)');
    assert.equal(official.length, DURATION);
    const mine = perSecondCounts(chat.messages, DURATION);
    assert.equal(mine.length, DURATION);
    for (let k = 0; k < DURATION; k++) assert.equal(mine[k], official[k], `segundo ${k}`);
    // a rajada está onde deveria
    const burstSum = official.slice(BURST.from, BURST.to).reduce((a, b) => a + b, 0);
    assert.ok(burstSum >= 100, `rajada de ~120 mensagens em 6 s (achei ${burstSum})`);
    assert.ok(official[10] <= 1, 'fora da rajada: no máximo 1 mensagem por segundo (uma a cada 2 s)');
    // mensagens depois do fim do vídeo não entram na contagem
    assert.equal(perSecondCounts([{ t: 5 }, { t: 999 }], 10).reduce((a, b) => a + b, 0), 1);
  });
});

test('analyzeSource só com o sinal de chat acha a rajada do chat gravado pelo writeChat (palavra-chave "clip" e velocidade)', async () => {
  await withChat(async ({ dir, file, video }) => {
    const result = await analyzeSource({
      file: video,
      duration: DURATION,
      hasAudio: false,
      chatPath: file,
      params: { signals: { audio: false, image: false, chat: true }, chat: { keywords: ['clip'] }, minRelevance: 0 }
    }, { cacheDir: path.join(dir, 'cache') });
    assert.equal(result.signals.chat.used, true, 'o sinal de chat foi usado');
    assert.equal(result.signals.chat.reason, '');
    assert.ok(result.signals.chat.messages > 300);
    assert.ok(result.signals.chat.keywordMessages >= 100, 'as mensagens com "clip" foram contadas');
    assert.deepEqual(result.usedSignals, ['chat']);
    assert.ok(result.suggestions.length >= 1, 'pelo menos uma sugestão');
    const best = result.suggestions[0];
    // o público reage depois do lance (atraso de 6 s): o trecho sugerido cobre a rajada
    assert.ok(best.start <= BURST.from + 2 && best.end >= BURST.to - 2, `sugestão ${best.start}-${best.end} deveria cobrir a rajada ${BURST.from}-${BURST.to}`);
    assert.ok(best.reasons.some((r) => /chat|palavras-chave/.test(r)), `motivos: ${best.reasons.join(' | ')}`);
    assert.ok(result.suggestions.every((s) => s.start >= 0 && s.end <= DURATION));
  });
});

test('chat ausente ou ilegível: o sinal é ignorado com o motivo e a análise falha com NO_SIGNALS só se não sobrar nenhum', async () => {
  await withChat(async ({ dir, file, video }) => {
    await assert.rejects(
      analyzeSource({ file: video, duration: DURATION, hasAudio: false, chatPath: path.join(dir, 'nao-existe.json'), params: { signals: { audio: false, image: false, chat: true } } }, { cacheDir: path.join(dir, 'c1') }),
      (err) => err.code === 'NO_SIGNALS' && /chat/i.test(err.message)
    );
    fs.writeFileSync(file, '{ não é json');
    await assert.rejects(
      analyzeSource({ file: video, duration: DURATION, hasAudio: false, chatPath: file, params: { signals: { audio: false, image: false, chat: true } } }, { cacheDir: path.join(dir, 'c2') }),
      (err) => err.code === 'NO_SIGNALS'
    );
  });
});
