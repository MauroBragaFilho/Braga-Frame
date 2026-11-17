'use strict';

/**
 * Modo JANELAS CANDIDATAS da análise por IA (src/core/analysis/ai/windows.js, candidates.js, chunking.packCandidateBlocks, analyze.js):
 * o filtro local marca trechos, a IA vê só eles e devolve frases (não horários), o app acha os horários pelas frases e ajusta início e
 * fim às palavras do Whisper. Contra o mesmo servidor HTTP local de ai-fakes.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AiRuntime } = require('../src/core/ai/runtime');
const { TranscriptStore } = require('../src/core/analysis/transcript/store');
const { buildDocument, normalizeCues } = require('../src/core/analysis/transcript/format');
const { AiAnalysisManager } = require('../src/core/analysis/ai/manager');
const { parseWindowVerdicts } = require('../src/core/analysis/ai/parse');
const { packCandidateBlocks } = require('../src/core/analysis/ai/chunking');
const F = require('./ai-fakes');

const VIDEO = { path: 'C:/videos/live.mp4', size: 1234567 };
const MOMENTS = [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 2500, punch: 'obrigado jogo eu morri afogado' }, { at: 4300, punch: 'vinte e um reais uma espada' }];

/** Palavras com tempo: cada fala dividida em partes iguais (com uma folga de 0,05 s entre palavras). */
function wordsOf(cues) {
  const out = [];
  for (const c of cues) {
    if (c.laugh) continue;
    const parts = c.text.split(/\s+/);
    const step = (c.end - c.start) / parts.length;
    parts.forEach((p, i) => out.push([c.start + i * step, c.start + (i + 1) * step - 0.05, p]));
  }
  return out;
}

/** Áudio sintético: fala em -30 dB e, 12 s depois do começo de cada momento, 6 s a +12 dB (a reação). */
function fakeAudio(duration, moments) {
  const db = [];
  for (let i = 0; i < duration * 2; i += 1) {
    const t = i / 2;
    let v = -30 + (((i * 7919) % 13) - 6) / 3;
    if (moments.some((m) => t >= m.start + 12 && t < m.start + 18)) v += 12;
    db.push(v);
  }
  return { windowSec: 0.5, db };
}

function setup(t, { withWords = true, audio = true } = {}) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const tr = F.makeTranscript({ minutes: 80, moments: MOMENTS });
  const { cues } = normalizeCues(tr.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), { duration: tr.duration });
  const store = new TranscriptStore(path.join(dir, 'transcripts'));
  const words = withWords ? wordsOf(cues) : undefined;
  store.save('proj1', buildDocument({ projectId: 'proj1', origin: 'generated', source: { ...VIDEO, duration: tr.duration }, cues, dropped: {}, words }));
  const make = (mock) => {
    const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage() });
    runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'fake-model', apiKey: F.KEY });
    runtime.accept(true);
    return new AiAnalysisManager({
      runtime, store, getTools: () => ({ ffmpeg: null, ffprobe: null }), readChat: async () => null, sleep: async () => {}, retry: { baseDelayMs: 1, maxDelayMs: 2 },
      audioDb: audio ? async () => fakeAudio(tr.duration, tr.moments) : async () => null
    });
  };
  return { tr, words, make };
}

function run(manager, tr, extra) {
  return new Promise((resolve) => {
    manager.on('done', (e) => resolve({ done: e.result }));
    manager.on('failed', (e) => resolve({ failed: e }));
    manager.start({
      projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: tr.duration, existingCuts: [], meta: { title: 'Live' },
      params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, ...extra
    });
  });
}

const userText = (call) => call.body.messages[call.body.messages.length - 1].content;
const isPick = (call) => userText(call).includes('=== CANDIDATOS ===');
const isWindows = (call) => userText(call).includes('=== JANELA ');

/** Responde cada janela: se o núcleo contém um momento conhecido, as frases dele; senão is_valid_clip false. */
function windowAnswer(call, moments, { badStart = false } = {}) {
  const heads = [...userText(call).matchAll(/=== JANELA (w\d+) \| núcleo (\d+):(\d\d) a (\d+):(\d\d)/g)];
  const windows = heads.map((h) => ({ id: h[1], from: Number(h[2]) * 60 + Number(h[3]), to: Number(h[4]) * 60 + Number(h[5]) }));
  return JSON.stringify({
    windows: windows.map((w) => {
      const m = moments.find((x) => x.start + 12 >= w.from && x.start + 12 <= w.to);
      if (!m) return { id: w.id, is_valid_clip: false, hook_score: 2, suggested_title: '', start_phrase: '', end_phrase: '', category: 'humor' };
      return {
        id: w.id, is_valid_clip: true, hook_score: 9, suggested_title: 'Momento chamativo',
        start_phrase: badStart ? 'frase que ninguém falou nesta live' : 'eu preciso muito de couro agora',
        end_phrase: m.punch, category: 'humor'
      };
    })
  });
}

test('parseWindowVerdicts lê o JSON estrito e tolera lixo', () => {
  const ok = parseWindowVerdicts('```json\n{"windows":[{"id":"w1","is_valid_clip":true,"hook_score":"8","suggested_title":"T","start_phrase":"a b c","end_phrase":"d e f","category":"react"},{"id":"w2","is_valid_clip":"não"},{"semid":1}]}\n```');
  assert.equal(ok.items.length, 2);
  assert.equal(ok.invalid, 1);
  assert.deepEqual([ok.items[0].valid, ok.items[0].hookScore, ok.items[0].category], [true, 8, 'Hype']);
  assert.equal(ok.items[1].valid, false);
});

test('packCandidateBlocks agrupa janelas por chamada e leva 15 s de contexto', () => {
  const tr = F.makeTranscript({ minutes: 80, moments: MOMENTS });
  const cands = Array.from({ length: 14 }, (_, i) => ({ id: `w${i + 1}`, from: 100 + i * 300, to: 170 + i * 300, score: 1 }));
  const blocks = packCandidateBlocks(cands, tr.cues, tr.duration, { maxPerCall: 6 });
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].packed.length, 6);
  assert.equal(blocks[0].packed[0].ctxFrom, 85);
  assert.equal(blocks[0].packed[0].ctxTo, 185);
});

test('janelas candidatas: a IA vê só os trechos marcados, devolve frases e o app acha os horários e ajusta às palavras', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi((call) => {
    if (isPick(call)) {
      const ids = [...userText(call).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
      return { json: F.chatBody(JSON.stringify({ picks: ids.map((id, k) => ({ id, relevance: 0.9 - k * 0.05, title: `Final ${id}`, category: 'Engraçado', reasons: ['ok'] })) })) };
    }
    return { json: F.chatBody(windowAnswer(call, s.tr.moments)) };
  });
  t.after(() => mock.close());
  const { done, failed } = await run(s.make(mock), s.tr, { aiWindows: true });
  assert.equal(failed, undefined, failed && failed.message);
  assert.equal(done.ai.windows.mode, 'candidates');
  assert.equal(done.suggestions.length, 3);
  // só chamadas de janelas (1 bloco: 3 janelas) + a escolha final
  assert.ok(mock.calls.length <= 3, `chamadas: ${mock.calls.length}`);
  assert.ok(mock.calls.filter(isWindows).length >= 1);
  assert.equal(done.ai.windows.valid, 3);
  // cada sugestão contém o momento inteiro e nenhuma borda cai no meio de uma palavra
  for (const m of s.tr.moments) {
    const sug = done.suggestions.find((x) => x.start <= m.start + 1 && x.end >= m.end - 4);
    assert.ok(sug, `momento ${m.at} sem sugestão`);
  }
  for (const x of done.suggestions) {
    for (const [a, b] of s.words) {
      assert.ok(!(a + 1e-3 < x.start && x.start < b - 1e-3), `início ${x.start} corta a palavra ${a}-${b}`);
      assert.ok(!(a + 1e-3 < x.end && x.end < b - 1e-3), `fim ${x.end} corta a palavra ${a}-${b}`);
    }
  }
});

test('janelas candidatas: o texto enviado cai bem mais que 60% em relação ao método de blocos', async (t) => {
  const s = setup(t);
  const mockBlocks = await F.startMockAi((call) => {
    if (isPick(call)) return { json: F.chatBody(JSON.stringify({ picks: [] })) };
    return { json: F.chatBody(JSON.stringify({ cuts: [] })) };
  });
  const mockWin = await F.startMockAi((call) => {
    if (isPick(call)) return { json: F.chatBody(JSON.stringify({ picks: [] })) };
    return { json: F.chatBody(windowAnswer(call, s.tr.moments)) };
  });
  t.after(() => { mockBlocks.close(); mockWin.close(); });
  await run(s.make(mockBlocks), s.tr, {});
  await run(s.make(mockWin), s.tr, { aiWindows: true });
  const bytes = (m) => m.calls.reduce((n, c) => n + (c.raw ? c.raw.length : 0), 0);
  const ratio = bytes(mockWin) / bytes(mockBlocks);
  assert.ok(ratio < 0.4, `os pedidos em janelas ficaram em ${Math.round(ratio * 100)}% dos de blocos`);
});

test('janelas candidatas: frase de abertura que não existe vira descarte com motivo (nada inventado entra)', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi((call) => {
    if (isPick(call)) return { json: F.chatBody(JSON.stringify({ picks: [] })) };
    return { json: F.chatBody(windowAnswer(call, s.tr.moments, { badStart: true })) };
  });
  t.after(() => mock.close());
  const { done } = await run(s.make(mock), s.tr, { aiWindows: true });
  assert.equal(done.suggestions.length, 0);
  assert.equal(done.ai.droppedByReason.phrase, 3);
});

test('janelas candidatas: sem sinais suficientes volta ao método de blocos, com aviso', async (t) => {
  const s = setup(t, { audio: false });
  const mock = await F.startMockAi((call) => {
    if (isPick(call)) return { json: F.chatBody(JSON.stringify({ picks: [] })) };
    return { json: F.chatBody(JSON.stringify({ cuts: [] })) };
  });
  t.after(() => mock.close());
  const { done } = await run(s.make(mock), s.tr, { aiWindows: true });
  // as 3 risadas das transcrições (uma por momento) não bastam sozinhas: volta aos blocos
  assert.ok(done.warnings.some((w) => w.code === 'AI_WINDOWS_FALLBACK'));
  assert.equal(done.ai.blocks, 3);
});

test('janelas candidatas: o ajuste às palavras vale também sem o modo (transcrição gerada)', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi((call) => {
    if (isPick(call)) return { json: F.chatBody(JSON.stringify({ picks: [] })) };
    const b = /bloco (\d+) de/.exec(userText(call));
    const idx = b ? Number(b[1]) - 1 : -1;
    const m = [s.tr.moments[0], s.tr.moments[1], s.tr.moments[2]][idx];
    return { json: F.chatBody(F.cutsJson(m ? [{ start: m.start + 3, end: m.end - 1, punchline: m.punch }] : [])) };
  });
  t.after(() => mock.close());
  const { done } = await run(s.make(mock), s.tr, {});
  assert.ok(done.suggestions.length >= 1);
  for (const x of done.suggestions) {
    for (const [a, b] of s.words) assert.ok(!(a + 1e-3 < x.start && x.start < b - 1e-3), `início ${x.start} corta a palavra ${a}-${b}`);
  }
});
