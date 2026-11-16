'use strict';

/**
 * Análise por IA de ponta a ponta, contra um servidor HTTP LOCAL de verdade que imita a API `chat/completions`:
 * duas passadas e blocos, autenticação por cabeçalho, a chave nunca em log/erro/arquivo, tentativas e espera limitadas, cancelamento,
 * conferência local rejeitando alucinação, aceite de privacidade, JSON inválido/cercado/cortado e limites de tamanho.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { AiRuntime } = require('../src/core/ai/runtime');
const { TranscriptStore } = require('../src/core/analysis/transcript/store');
const { buildDocument, normalizeCues } = require('../src/core/analysis/transcript/format');
const { AiAnalysisManager } = require('../src/core/analysis/ai/manager');
const F = require('./ai-fakes');

const VIDEO = { path: 'C:/videos/live.mp4', size: 1234567, duration: 80 * 60 };

function setup(t, { minutes = 80, moments, accept = true, limits, retry, noKey = false, tools } = {}) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  const tr = F.makeTranscript({ minutes, moments });
  const store = new TranscriptStore(path.join(dir, 'transcripts'));
  const { cues } = normalizeCues(tr.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), { duration: tr.duration });
  store.save('proj1', buildDocument({ projectId: 'proj1', origin: 'imported', source: { ...VIDEO, duration: tr.duration }, cues, dropped: {}, importedFrom: 't.srt' }));
  const sleeps = [];
  const make = (mock) => {
    const runtime = new AiRuntime({ dir: path.join(dir, 'ai'), safeStorage: F.fakeSafeStorage() });
    runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'fake-model', ...(noKey ? {} : { apiKey: F.KEY }), ...(limits ? { limits } : {}) });
    if (accept) runtime.accept(true);
    const manager = new AiAnalysisManager({
      runtime, store, getTools: () => tools || { ffmpeg: null, ffprobe: null }, cacheDir: path.join(dir, 'cache'),
      readChat: async () => null, sleep: async (ms) => { sleeps.push(ms); }, retry
    });
    return { runtime, manager };
  };
  return { dir, tr, store, sleeps, make, source: { ...VIDEO, duration: tr.duration } };
}

/** Roda uma análise e devolve { done } ou { failed } + todos os eventos. */
function run(manager, extra, tr) {
  return new Promise((resolve) => {
    const events = [];
    manager.on('progress', (e) => events.push(['progress', e]));
    manager.on('done', (e) => resolve({ done: e.result, events }));
    manager.on('failed', (e) => resolve({ failed: e, events }));
    manager.start({ projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: tr.duration, params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, meta: { title: 'Live de teste' }, existingCuts: [], ...extra });
  });
}

const blockIndex = (body) => {
  const m = /bloco (\d+) de (\d+)/.exec(body.messages[body.messages.length - 1].content);
  return m ? Number(m[1]) - 1 : -1;
};
const isPick = (body) => body.messages[body.messages.length - 1].content.includes('=== CANDIDATOS ===');
const userText = (body) => body.messages[body.messages.length - 1].content;

test('duas passadas em blocos: candidatos por bloco, escolha final por id, chave só no cabeçalho', async (t) => {
  const s = setup(t, { moments: [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 2500, punch: 'obrigado jogo eu morri afogado' }, { at: 4300, punch: 'vinte e um reais uma espada' }] });
  const [m1, m2, m3] = s.tr.moments;
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) {
      const ids = [...userText(call.body).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
      return { json: F.chatBody(JSON.stringify({ picks: [...ids].reverse().map((id, k) => ({ id, relevance: 0.9 - k * 0.1, title: `Título final ${id}`, category: 'Hype', reasons: ['escolhido'] })) })) };
    }
    const b = blockIndex(call.body);
    const pick = [[m1], [m2], [m3]][b] || [];
    return { json: F.chatBody(F.cutsJson(pick.map((m) => ({ start: m.start + 2, end: m.end - 1, punchline: m.punch })))) };
  });
  t.after(() => mock.close());
  const { runtime, manager } = s.make(mock);
  const { done, failed } = await run(manager, {}, s.tr);
  assert.equal(failed, undefined, failed && failed.message);
  // 3 blocos (80 min / 35 min com 90 s de sobreposição) + 1 escolha
  assert.equal(mock.calls.length, 4);
  assert.equal(done.engine, 'ai');
  assert.equal(done.ai.blocks, 3);
  assert.equal(done.ai.calls, 4);
  assert.equal(done.ai.pickUsed, true);
  assert.equal(done.suggestions.length, 3);
  // a ordem veio da 2ª passada (invertida) e títulos/categoria também
  assert.deepEqual(done.suggestions.map((x) => x.relevance), [0.9, 0.8, 0.7]);
  assert.ok(done.suggestions.every((x) => x.title.startsWith('Título final') && x.category === 'Hype'));
  assert.ok(done.suggestions.every((x) => x.layout === 'conversa' && typeof x.peak === 'number'));
  // horários ajustados aos limites das falas (+margens), dentro do vídeo
  for (const x of done.suggestions) { assert.ok(x.start >= 0 && x.end <= s.tr.duration && x.end - x.start >= 15 && x.end - x.start <= 60); }
  // autenticação por cabeçalho, nunca na URL nem no corpo
  for (const c of mock.calls) {
    assert.equal(c.headers.authorization, `Bearer ${F.KEY}`);
    assert.equal(c.path, '/v1/chat/completions');
    assert.ok(!c.path.includes(F.KEY) && !c.raw.includes(F.KEY));
    assert.equal(c.body.model, 'fake-model');
  }
  // 1ª passada de cada bloco só traz as falas do bloco; blocos vizinhos se sobrepõem
  const first = userText(mock.calls[0].body);
  assert.ok(first.includes('=== TRANSCRIÇÃO'));
  assert.ok(first.includes(`Duração do vídeo: ${F.clk(s.tr.duration)}`) && first.includes('Live de teste'));
  assert.ok(!first.includes('conversa tranquila número 500 '), 'o bloco 1 não pode trazer falas do bloco 3');
  const second = userText(mock.calls[1].body);
  assert.ok(second.includes('conversa tranquila número 402 '), 'o bloco 2 começa 90 s antes do fim do bloco 1 (sobreposição)');
  // a 2ª passada não leva a transcrição inteira, só resumos
  const pick = userText(mock.calls[3].body);
  assert.ok(!pick.includes('conversa tranquila') && pick.includes('desfecho:'));
  // a chave não aparece no resultado nem no estado público
  assert.ok(!F.mentions(done, F.KEY) && !F.mentions(runtime.state(), F.KEY));
  assert.ok(done.ai.promptTokens > 0 && done.ai.completionTokens > 0);
});

test('a chave nunca aparece em arquivo gravado (configuração, chaves cifradas, transcrição) nem em evento', async (t) => {
  const s = setup(t, { moments: [{ at: 600, punch: 'o bicho nem dropou couro' }] });
  const m = s.tr.moments[0];
  const mock = await F.startMockAi((call) => (isPick(call.body) ? { json: F.chatBody('{"picks":[]}') } : { json: F.chatBody(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch }])) }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { done, events } = await run(manager, {}, s.tr);
  assert.equal(done.suggestions.length, 1);
  for (const f of F.readAll(s.dir)) assert.ok(!f.text.includes(F.KEY), `a chave apareceu em ${f.file}`);
  assert.ok(!F.mentions(events, F.KEY));
  const secrets = fs.readFileSync(path.join(s.dir, 'ai', 'secrets.json'), 'utf8');
  assert.ok(secrets.includes('"mode":"safe"'));
});

test('conferência local: horário inventado, desfecho inexistente, silêncio, corte existente e relevância baixa são descartados com o motivo', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const [good, other] = s.tr.moments;
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    return {
      json: F.chatBody(F.cutsJson([
        { start: good.start, end: good.end, punchline: good.punch, relevance: 0.95, title: 'bom' },
        { start: 99 * 60, end: 99 * 60 + 40, punchline: 'qualquer coisa que não existe', relevance: 0.9, title: 'fora do vídeo' },
        { start: 8 * 60, end: 8 * 60 + 30, punchline: 'o bicho nem dropou couro', relevance: 0.9, title: 'horário errado: o desfecho está em outro lugar' },
        { start: good.start + 1, end: good.end - 1, punchline: 'ele disse uma frase que nunca existiu na live', relevance: 0.9, title: 'desfecho inventado' },
        { start: other.start, end: other.end, punchline: other.punch, relevance: 0.9, title: 'já existe como corte' },
        { start: 1000, end: 1004, punchline: 'curto', relevance: 0.9, title: 'curto demais' },
        { start: 'abc', end: 'def', punchline: 'x', title: 'horário ilegível' },
        { start: 1100, end: 1000, punchline: 'x', title: 'fim antes do início' }
      ]))
    };
  });
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { done } = await run(manager, { existingCuts: [{ start: other.start - 2, end: other.end + 5 }] }, s.tr);
  assert.deepEqual(done.suggestions.map((x) => x.title), ['bom']);
  const r = done.ai.droppedByReason;
  assert.ok(r.range >= 1, JSON.stringify(r));
  assert.ok(r.punchline >= 2, JSON.stringify(r));
  assert.ok(r.existing >= 1 && r.format >= 1, JSON.stringify(r));
  assert.ok(r.nospeech >= 1 || r.punchline >= 3 || r.time >= 1, JSON.stringify(r));
  assert.ok(done.ai.dropped.every((d) => d.reason && d.detail));
  assert.ok(done.suggestions[0].start >= good.start - 2.01 && done.suggestions[0].end <= good.end + 1.01);
});

test('429 com Retry-After: espera o tempo pedido e tenta de novo; 5xx recua em escada; esgotadas as tentativas o bloco é pulado com aviso', async (t) => {
  const s = setup(t, { minutes: 80, moments: [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 4300, punch: 'vinte e um reais uma espada' }], retry: { baseDelayMs: 1000, maxDelayMs: 8000 } });
  const [m1, m2] = s.tr.moments;
  const attempts = new Map();
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    const b = blockIndex(call.body);
    const n = (attempts.get(b) || 0) + 1;
    attempts.set(b, n);
    if (b === 0 && n === 1) return { status: 429, headers: { 'retry-after': '7' }, json: { error: { message: 'rate limit' } } };
    if (b === 1) return { status: 503, json: { error: { message: 'overloaded' } } }; // sempre cai
    return { json: F.chatBody(F.cutsJson([(b === 0 ? m1 : m2)].map((m) => ({ start: m.start, end: m.end, punchline: m.punch })))) };
  });
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { done, failed } = await run(manager, {}, s.tr);
  assert.equal(failed, undefined, failed && failed.message);
  assert.ok(s.sleeps.includes(7000), `esperou o Retry-After: ${s.sleeps}`);
  assert.equal(attempts.get(0), 2);
  assert.equal(attempts.get(1), 6, 'tentativas limitadas: 3 na vez do bloco e mais 3 na segunda chance, no fim');
  assert.deepEqual(s.sleeps.filter((x) => x !== 7000), [1000, 2000, 1000, 2000], 'escada 1 s, 2 s (nas duas vezes)');
  assert.equal(done.ai.failedBlocks, 1);
  assert.ok(done.warnings.some((w) => w.code === 'AI_BLOCKS_FAILED' && /1 bloco/.test(w.message)));
  assert.equal(done.suggestions.length, 2);
});

test('chave recusada (401): para na hora, uma só chamada, mensagem clara sem a chave', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi(() => ({ status: 401, json: { error: { message: `Incorrect API key provided: ${F.KEY}` } } }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { failed, done } = await run(manager, {}, s.tr);
  assert.equal(done, undefined);
  assert.equal(failed.code, 'AUTH');
  assert.equal(mock.calls.length, 1);
  assert.equal(s.sleeps.length, 0);
  assert.ok(/usar o algoritmo/i.test(failed.message), failed.message);
  assert.ok(!F.mentions(failed, F.KEY), 'o servidor ecoou a chave e ela foi retirada do erro');
});

test('cota esgotada (429 com espera longa) vira QUOTA sem ficar esperando', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi(() => ({ status: 429, headers: { 'retry-after': '3600' }, json: { error: { message: 'quota' } } }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { failed } = await run(manager, {}, s.tr);
  assert.equal(failed.code, 'QUOTA');
  assert.equal(mock.calls.length, 1);
  assert.equal(s.sleeps.length, 0);
  assert.ok(/cota|esperar/i.test(failed.message));
});

test('todos os blocos falham: erro claro com o motivo e a opção de usar o algoritmo', async (t) => {
  const s = setup(t, { minutes: 20 });
  const mock = await F.startMockAi(() => ({ status: 500, json: { error: { message: 'boom' } } }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { failed } = await run(manager, {}, s.tr);
  assert.equal(failed.code, 'SERVER');
  assert.equal(mock.calls.length, 3, 'três tentativas e para');
  assert.ok(/algoritmo/i.test(failed.message) && /tentativas/i.test(failed.message));
});

test('queda de rede no meio da resposta e servidor desligado: tentam de novo e acabam em erro claro', async (t) => {
  const s = setup(t, { minutes: 20 });
  const mock = await F.startMockAi(() => ({ dropMidway: '{"id":"x","choices":[' }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const a = await run(manager, {}, s.tr);
  assert.ok(['INTERRUPTED', 'NETWORK', 'BAD_RESPONSE'].includes(a.failed.code), a.failed.code);
  assert.equal(mock.calls.length, 3);
  await mock.close();
  const b = await run(manager, {}, s.tr);
  assert.equal(b.failed.code, 'NETWORK');
  assert.ok(/Várias tentativas/.test(b.failed.message));
});

test('JSON inválido: pede de novo com lembrete; cerca ```json e texto em volta são aceitos; resposta cortada aproveita os cortes completos', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const [m1, m2] = s.tr.moments;
  const objs = [m1, m2].map((m) => JSON.parse(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch }])).cuts[0]);
  let n = 0;
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    n += 1;
    if (n === 1) return { json: F.chatBody('Claro! Aqui estão os melhores momentos, espero que ajude.') };
    if (n === 2) return { json: F.chatBody(`Segue:\n\`\`\`json\n${JSON.stringify({ cuts: objs })}\n\`\`\`\nQualquer coisa me avise.`) };
    return { json: F.chatBody('x') };
  });
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const a = await run(manager, {}, s.tr);
  assert.equal(a.failed, undefined);
  assert.equal(a.done.suggestions.length, 2);
  assert.ok(userText(mock.calls[1].body).includes('não era um JSON válido'), 'o 2º pedido traz o lembrete');
  assert.ok(!userText(mock.calls[0].body).includes('não era um JSON válido'));

  // cortada no meio do 2º objeto: aproveita o 1º
  const cut = JSON.stringify({ cuts: objs }).slice(0, JSON.stringify({ cuts: objs }).indexOf('{', 20) + 40);
  const mock2 = await F.startMockAi((call) => (isPick(call.body) ? { json: F.chatBody('{"picks":[]}') } : { json: F.chatBody(cut, { finish: 'length' }) }));
  t.after(() => mock2.close());
  const s2 = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const { manager: m2mgr } = s2.make(mock2);
  const b = await run(m2mgr, {}, s2.tr);
  assert.equal(b.done.suggestions.length, 1);
  assert.ok(b.done.warnings.some((w) => w.code === 'AI_TRUNCATED'));
});

test('a escolha final pode falhar sem derrubar a análise: usa a ordem da 1ª passada e avisa; ids inventados são ignorados', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const [m1, m2] = s.tr.moments;
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('isto não é json nenhum') };
    return { json: F.chatBody(F.cutsJson([{ start: m1.start, end: m1.end, punchline: m1.punch, relevance: 0.7 }, { start: m2.start, end: m2.end, punchline: m2.punch, relevance: 0.95 }])) };
  });
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const a = await run(manager, {}, s.tr);
  assert.ok(a.done.warnings.some((w) => w.code === 'AI_PICK_FAILED'));
  assert.deepEqual(a.done.suggestions.map((x) => x.relevance), [0.95, 0.7]);

  const mock2 = await F.startMockAi((call) => (isPick(call.body) ? { json: F.chatBody('{"picks":[{"id":"c99"},{"id":"c2","relevance":0.8,"title":"só este"}]}') } : { json: F.chatBody(F.cutsJson([{ start: m1.start, end: m1.end, punchline: m1.punch, relevance: 0.7 }, { start: m2.start, end: m2.end, punchline: m2.punch, relevance: 0.95 }])) }));
  t.after(() => mock2.close());
  const s2 = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const b = await run(s2.make(mock2).manager, {}, s2.tr);
  assert.equal(b.done.suggestions.length, 1, 'só o id válido');
  assert.equal(b.done.suggestions[0].title, 'só este');
});

test('escolha final CORTADA pelo limite de saída (modelo que raciocina, medido em rede real): pede de novo UMA vez com mais espaço; se cortar de novo, avisa', async (t) => {
  const moments = [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }];
  const answer = (call, m1, m2) => F.chatBody(F.cutsJson([{ start: m1.start, end: m1.end, punchline: m1.punch }, { start: m2.start, end: m2.end, punchline: m2.punch }]));
  const picksText = (call) => {
    const ids = [...userText(call.body).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
    return JSON.stringify({ picks: ids.map((id, k) => ({ id, relevance: 0.9 - k * 0.1, title: `Final ${id}`, category: 'Hype', reasons: ['x'] })) });
  };
  const cutAtSecond = (full) => full.slice(0, full.indexOf('{"id":"c2"') + 12); // termina no meio do 2º item: só o 1º se aproveita

  // 1) a 1ª resposta vem cortada, a 2ª (com mais espaço) vem inteira
  const s = setup(t, { minutes: 20, moments });
  const [m1, m2] = s.tr.moments;
  const pickLimits = [];
  const mock = await F.startMockAi((call) => {
    if (!isPick(call.body)) return { json: answer(call, m1, m2) };
    pickLimits.push(call.body.max_tokens);
    const full = picksText(call);
    return { json: pickLimits.length === 1 ? F.chatBody(cutAtSecond(full), { finish: 'length' }) : F.chatBody(full) };
  });
  t.after(() => mock.close());
  const a = await run(s.make(mock).manager, {}, s.tr);
  assert.equal(a.failed, undefined, a.failed && a.failed.message);
  assert.deepEqual(pickLimits, [6000, 9600], 'a escolha pede 6000 tokens e, cortada, repete UMA vez com 1,6x');
  assert.equal(a.done.suggestions.length, 2, 'a lista inteira da 2ª resposta, não só o item do pedaço cortado');
  assert.ok(a.done.suggestions.every((x) => x.title.startsWith('Final ')));
  assert.ok(!a.done.warnings.some((w) => w.code === 'AI_PICK_TRUNCATED'), 'a repetição resolveu: nada a avisar');
  assert.equal(a.done.ai.calls, 1 + 2 + 0, 'um bloco e duas chamadas de escolha (a repetição conta)');

  // 2) cortada nas duas vezes: não repete mais, aproveita o que veio e avisa
  const s2 = setup(t, { minutes: 20, moments });
  const [n1, n2] = s2.tr.moments;
  const limits2 = [];
  const mock2 = await F.startMockAi((call) => {
    if (!isPick(call.body)) return { json: answer(call, n1, n2) };
    limits2.push(call.body.max_tokens);
    return { json: F.chatBody(cutAtSecond(picksText(call)), { finish: 'length' }) };
  });
  t.after(() => mock2.close());
  const b = await run(s2.make(mock2).manager, {}, s2.tr);
  assert.equal(b.failed, undefined);
  assert.deepEqual(limits2, [6000, 9600], 'só uma repetição, mesmo cortando de novo');
  assert.equal(b.done.suggestions.length, 1, 'só o item inteiro');
  assert.ok(b.done.warnings.some((w) => w.code === 'AI_PICK_TRUNCATED' && /cortada pelo limite de saída/.test(w.message)));
});

test('limite de saída APRENDE: um bloco cortado faz os blocos seguintes pedirem mais espaço; o prazo de cada chamada cresce com o limite', async (t) => {
  const s = setup(t, { moments: [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 2500, punch: 'obrigado jogo eu morri afogado' }] });
  const [m1, m2] = s.tr.moments;
  const seen = [];
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) { seen.push(['pick', call.body.max_tokens]); return { json: F.chatBody('{"picks":[]}') }; }
    const b = blockIndex(call.body);
    seen.push([b, call.body.max_tokens]);
    const cut = [[m1], [m2], []][b] || [];
    // o bloco 1 termina com finish_reason "length" (modelo que raciocina) mas traz o JSON completo
    return { json: F.chatBody(F.cutsJson(cut.map((m) => ({ start: m.start, end: m.end, punchline: m.punch }))), b === 0 ? { finish: 'length' } : {}) };
  });
  t.after(() => mock.close());
  const a = await run(s.make(mock).manager, {}, s.tr);
  assert.equal(a.failed, undefined, a.failed && a.failed.message);
  assert.deepEqual(seen.filter((x) => x[0] !== 'pick'), [[0, 6000], [1, 9600], [2, 9600]], 'o bloco 1 saiu cortado: os seguintes pedem 1,6x');
  assert.equal(seen.filter((x) => x[0] === 'pick').every((x) => x[1] === 6000), true, 'a escolha final tem o seu próprio limite');

  // o prazo do pedido acompanha o limite de saída (60 ms por token, de 2 a 10 minutos); a repetição de uma resposta cortada sem JSON pede mais espaço E mais prazo
  const { analyzeWithAi } = require('../src/core/analysis/ai/analyze');
  const { cues } = normalizeCues(s.tr.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), { duration: s.tr.duration });
  const calls = [];
  let n = 0;
  await analyzeWithAi(
    { duration: s.tr.duration, hasAudio: false, params: {}, transcript: { cues }, chat: null, meta: {}, existingCuts: [] },
    {
      chat: async (p) => {
        calls.push({ maxTokens: p.maxTokens, timeoutMs: p.timeoutMs });
        n += 1;
        return n === 1 ? { text: '', usage: { promptTokens: 1, completionTokens: 6000 }, finishReason: 'length' } : { text: '{"cuts":[]}', usage: { promptTokens: 1, completionTokens: 5 }, finishReason: 'stop' };
      },
      provider: { label: 'Teste', model: 'm' }, limits: { maxCalls: 14, maxInputTokens: 24000, windowMinutes: 35, attempts: 2 }, sleep: async () => {}
    }
  ).catch(() => {});
  assert.deepEqual(calls.slice(0, 2), [{ maxTokens: 6000, timeoutMs: 360000 }, { maxTokens: 9600, timeoutMs: 576000 }]);
  assert.ok(calls.every((c) => c.timeoutMs >= 120000 && c.timeoutMs <= 600000));
});

test('cancelar no meio: o pedido em andamento é abortado, nada mais é enviado e o evento é CANCELLED', async (t) => {
  const s = setup(t, { minutes: 80 });
  const mock = await F.startMockAi((call) => (blockIndex(call.body) === 0 ? { json: F.chatBody(F.cutsJson([])) } : { hang: true }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const p = run(manager, {}, s.tr);
  for (let i = 0; i < 100 && mock.calls.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mock.calls.length, 2);
  assert.equal(manager.cancel(), true);
  const { failed } = await p;
  assert.equal(failed.code, 'CANCELLED');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(mock.calls.length, 2, 'nada foi enviado depois do cancelamento');
  assert.equal(manager.status(), null);
});

test('cancelar durante a espera entre tentativas encerra na hora', async (t) => {
  const s = setup(t, { minutes: 20 });
  const mock = await F.startMockAi(() => ({ status: 503, json: { error: { message: 'x' } } }));
  t.after(() => mock.close());
  const { runtime } = s.make(mock);
  let release;
  const manager = new AiAnalysisManager({
    runtime, store: new TranscriptStore(path.join(s.dir, 'transcripts')), getTools: () => ({}), cacheDir: path.join(s.dir, 'cache'),
    sleep: (ms, signal) => new Promise((resolve, reject) => { release = () => resolve(); signal.addEventListener('abort', () => reject(Object.assign(new Error('c'), { code: 'CANCELLED' })), { once: true }); })
  });
  const p = run(manager, {}, s.tr);
  for (let i = 0; i < 100 && !release; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.ok(release, 'chegou a esperar');
  manager.cancel();
  const { failed } = await p;
  assert.equal(failed.code, 'CANCELLED');
  assert.equal(mock.calls.length, 1);
});

test('sem aceite de privacidade nada é enviado (a análise e o chat direto recusam)', async (t) => {
  const s = setup(t, { accept: false });
  const mock = await F.startMockAi(() => ({ json: F.chatBody('{"cuts":[]}') }));
  t.after(() => mock.close());
  const { runtime, manager } = s.make(mock);
  assert.throws(() => manager.start({ projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: s.tr.duration }), (e) => e.code === 'CONSENT_REQUIRED');
  await assert.rejects(() => runtime.chat({ system: 's', messages: [{ role: 'user', content: 'oi' }] }), (e) => e.code === 'CONSENT_REQUIRED');
  assert.equal(mock.calls.length, 0);
  // o teste de conexão manda só um pedido fixo, sem dado do projeto
  const r = await runtime.test();
  assert.equal(r.ok, true);
  assert.equal(mock.calls.length, 1);
  assert.ok(!mock.calls[0].raw.includes('conversa tranquila'));
  // recusar de novo depois de revogar
  runtime.accept(true);
  runtime.accept(false);
  assert.throws(() => manager.start({ projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: s.tr.duration }), (e) => e.code === 'CONSENT_REQUIRED');
});

test('sem chave, sem transcrição ou com a transcrição de outro vídeo: erros claros antes de enviar', async (t) => {
  const s = setup(t);
  const mock = await F.startMockAi(() => ({ json: F.chatBody('{"cuts":[]}') }));
  t.after(() => mock.close());
  // provedor conhecido exige modelo (escolha do usuário, sem padrão) e chave
  const rt = new AiRuntime({ dir: path.join(s.dir, 'ai2'), safeStorage: F.fakeSafeStorage() });
  const noKey = new AiAnalysisManager({ runtime: rt, store: s.store, getTools: () => ({}), cacheDir: path.join(s.dir, 'cache') });
  const startNoKey = () => noKey.start({ projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: s.tr.duration });
  assert.throws(startNoKey, (e) => e.code === 'NOT_CONFIGURED' && /Escolha o provedor/.test(e.message), 'nenhum provedor escolhido');
  rt.save({ provider: 'groq' });
  assert.throws(startNoKey, (e) => e.code === 'NOT_CONFIGURED' && /Informe o modelo/.test(e.message), 'sem modelo');
  rt.save({ model: 'llama-x' });
  assert.throws(startNoKey, (e) => e.code === 'NO_KEY');
  rt.accept(true);
  await assert.rejects(() => rt.chat({ messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'NO_KEY');
  const s2 = setup(t);
  const { manager: m2 } = s2.make(mock);
  assert.throws(() => m2.start({ projectId: 'outro', path: VIDEO.path, size: VIDEO.size, duration: s2.tr.duration }), (e) => e.code === 'NO_TRANSCRIPT');
  assert.throws(() => m2.start({ projectId: 'proj1', path: 'C:/outro/video.mp4', size: 999, duration: s2.tr.duration }), (e) => e.code === 'NO_TRANSCRIPT' && /outro arquivo/.test(e.message));
  assert.equal(mock.calls.length, 0);
});

test('limites: mais chamadas que o permitido recusa antes de enviar; o teto de tokens encolhe os blocos', async (t) => {
  const s = setup(t, { minutes: 80, limits: { maxCalls: 2 } });
  const mock = await F.startMockAi(() => ({ json: F.chatBody('{"cuts":[]}') }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { failed } = await run(manager, {}, s.tr);
  assert.equal(failed.code, 'TOO_MANY_CALLS');
  assert.equal(mock.calls.length, 0);

  const s2 = setup(t, { minutes: 80, limits: { maxCalls: 60, maxInputTokens: 4000 } });
  const sizes = [];
  const mock2 = await F.startMockAi((call) => { sizes.push(call.raw.length); return { json: F.chatBody('{"cuts":[]}') }; });
  t.after(() => mock2.close());
  const r = await run(s2.make(mock2).manager, {}, s2.tr);
  assert.ok(r.done.ai.blocks > 3, `blocos: ${r.done.ai.blocks}`);
  const est = await s2.make(mock2).manager.estimate({ projectId: 'proj1', path: VIDEO.path, size: VIDEO.size, duration: s2.tr.duration });
  assert.equal(est.calls, r.done.ai.blocks + 1);
  assert.ok(est.label.startsWith('~') && /chamadas/.test(est.label));
  // nenhuma chamada passou muito do teto estimado de tokens (4000 tokens ~ 12800 caracteres de entrada)
  assert.ok(Math.max(...sizes) < 4000 * 3.2 + 6000, `maior pedido: ${Math.max(...sizes)} caracteres`);
});

test('resultado sem nenhum corte válido: aviso claro e contagem dos descartes', async (t) => {
  const s = setup(t, { minutes: 20 });
  const mock = await F.startMockAi(() => ({ json: F.chatBody(F.cutsJson([{ start: 100, end: 140, punchline: 'frase que não existe' }])) }));
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { done } = await run(manager, {}, s.tr);
  assert.equal(done.suggestions.length, 0);
  assert.ok(done.warnings.some((w) => w.code === 'AI_NO_RESULT'));
  assert.equal(done.ai.droppedTotal, 1);
});

test('flags e layout viram dados da sugestão, mais um motivo visível "revisar"', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }] });
  const m = s.tr.moments[0];
  const mock = await F.startMockAi((call) => (isPick(call.body) ? { json: F.chatBody('{"picks":[]}') } : { json: F.chatBody(F.cutsJson([{ start: m.start, end: m.end, punchline: m.punch, layout: 'jogo', flags: ['revisar_sensivel', 'inventada'] }])) }));
  t.after(() => mock.close());
  const { done } = await run(s.make(mock).manager, {}, s.tr);
  const x = done.suggestions[0];
  assert.equal(x.layout, 'jogo');
  assert.deepEqual(x.flags, ['revisar_sensivel']);
  assert.ok(x.reasons.includes('revisar: conteúdo sensível'));
});

test('segunda chance: o bloco que falhou é pedido de novo no fim e, se responder, entra normalmente (sem aviso de bloco de fora)', async (t) => {
  const s = setup(t, { minutes: 80, moments: [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 3000, punch: 'vinte e um reais uma espada' }], retry: { baseDelayMs: 1000, maxDelayMs: 8000 } });
  const [m1, m2] = s.tr.moments;
  const attempts = new Map();
  const order = [];
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    const b = blockIndex(call.body);
    const n = (attempts.get(b) || 0) + 1;
    attempts.set(b, n);
    order.push(b);
    if (b === 1 && n <= 3) return { status: 503, json: { error: { message: 'overloaded' } } }; // sobrecarregado na vez dele; no fim já responde
    return { json: F.chatBody(F.cutsJson((b === 0 ? [m1] : b === 1 ? [m2] : []).map((m) => ({ start: m.start, end: m.end, punchline: m.punch })))) };
  });
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const { done, failed } = await run(manager, {}, s.tr);
  assert.equal(failed, undefined, failed && failed.message);
  assert.deepEqual(order, [0, 1, 1, 1, 2, 1], 'o bloco 2 só volta depois de todos os outros');
  assert.equal(done.ai.failedBlocks, 0);
  assert.equal(done.ai.recoveredBlocks, 1);
  assert.ok(!done.warnings.some((w) => w.code === 'AI_BLOCKS_FAILED'));
  assert.equal(done.suggestions.length, 2, 'o corte do bloco recuperado entrou');
});

test('bloco com a resposta cortada no meio: é pedido de novo, uma vez, com mais espaço; se vier inteiro, vale o inteiro (sem aviso)', async (t) => {
  const s = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const full = F.cutsJson(s.tr.moments.map((m) => ({ start: m.start, end: m.end, punchline: m.punch })));
  const cut = full.slice(0, full.indexOf('{', 20) + 40); // cortada no meio do 2º corte
  const limitsSeen = [];
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    limitsSeen.push(call.body.max_tokens);
    return limitsSeen.length === 1 ? { json: F.chatBody(cut, { finish: 'length' }) } : { json: F.chatBody(full) };
  });
  t.after(() => mock.close());
  const a = await run(s.make(mock).manager, {}, s.tr);
  assert.equal(a.failed, undefined, a.failed && a.failed.message);
  assert.deepEqual(limitsSeen, [6000, 9600], 'o mesmo bloco de novo, com 1,6x do limite de saída');
  assert.equal(a.done.suggestions.length, 2, 'os dois cortes, e não só o que coube na primeira resposta');
  assert.ok(!a.done.warnings.some((w) => w.code === 'AI_TRUNCATED'), 'a resposta inteira substituiu a cortada');

  // quantidade automática: o limite de saída do bloco já começa mais folgado (12 candidatos)
  const seenAuto = [];
  const mock2 = await F.startMockAi((call) => {
    if (isPick(call.body)) return { json: F.chatBody('{"picks":[]}') };
    seenAuto.push(call.body.max_tokens);
    return { json: F.chatBody(full) };
  });
  t.after(() => mock2.close());
  const s2 = setup(t, { minutes: 20, moments: [{ at: 300, punch: 'o bicho nem dropou couro' }, { at: 800, punch: 'a espada custa vinte e um reais' }] });
  const b = await run(s2.make(mock2).manager, { params: { autoQuantity: true } }, s2.tr);
  assert.equal(b.failed, undefined, b.failed && b.failed.message);
  assert.deepEqual(seenAuto, [9000]);
});

test('caminho dos candidatos: o resultado diz quantos o modelo devolveu por bloco, quantos passaram na conferência e o que a escolha final deixou de fora', async (t) => {
  const moments = [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 2500, punch: 'obrigado jogo eu morri afogado' }, { at: 4300, punch: 'vinte e um reais uma espada' }];
  const blocks = (m1, m2, m3) => [
    [{ start: m1.start + 2, end: m1.end - 1, punchline: m1.punch, title: 'Primeiro', relevance: 0.9 }, { start: m1.start + 100, end: m1.start + 130, punchline: 'isso nunca foi dito por ninguém aqui', title: 'Inventado' }],
    [{ start: m2.start + 2, end: m2.end - 1, punchline: m2.punch, title: 'Segundo', relevance: 0.8 }],
    [{ start: m3.start + 2, end: m3.end - 1, punchline: m3.punch, title: 'Terceiro', relevance: 0.6 }]
  ];
  const counts = (f) => ({ returned: f.returned, verified: f.verified, unique: f.unique, offered: f.offered, picked: f.picked, final: f.final });

  // a escolha final fica com 2 dos 3 candidatos
  const s = setup(t, { moments });
  const lists = blocks(...s.tr.moments);
  const mock = await F.startMockAi((call) => {
    if (isPick(call.body)) {
      const ids = [...userText(call.body).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
      return { json: F.chatBody(JSON.stringify({ picks: ids.slice(0, 2).map((id) => ({ id })) })) };
    }
    return { json: F.chatBody(F.cutsJson(lists[blockIndex(call.body)] || [])) };
  });
  t.after(() => mock.close());
  const { done, failed } = await run(s.make(mock).manager, {}, s.tr);
  assert.equal(failed, undefined, failed && failed.message);
  const f = done.ai.funnel;
  assert.deepEqual(counts(f), { returned: 4, verified: 3, unique: 3, offered: 3, picked: 2, final: 2 });
  assert.deepEqual(f.perBlock.map((b) => [b.returned, b.verified]), [[2, 1], [1, 1], [1, 1]], 'por bloco: devolvidos e aprovados');
  assert.ok(f.perBlock.every((b) => Number.isFinite(b.from) && b.to > b.from));
  assert.equal(done.ai.candidates, 3);
  assert.equal(done.ai.droppedTotal, 1, 'o candidato inventado caiu na conferência, não na escolha final');
  assert.deepEqual(done.suggestions.map((x) => x.title), ['Primeiro', 'Segundo']);
  assert.equal(done.ai.unpicked.length, 1);
  assert.equal(done.ai.unpicked[0].title, 'Terceiro');
  assert.equal(done.ai.unpicked[0].relevance, 0.6);
  assert.ok(done.ai.unpicked[0].end > done.ai.unpicked[0].start && Object.keys(done.ai.unpicked[0]).sort().join() === 'end,relevance,start,title', 'só horários, título e nota');

  // a escolha final falha: nada foi "deixado de fora" por ela, e a contagem diz que não houve escolha
  const s2 = setup(t, { moments });
  const lists2 = blocks(...s2.tr.moments);
  const mock2 = await F.startMockAi((call) => (isPick(call.body) ? { json: F.chatBody('isto não é json nenhum') } : { json: F.chatBody(F.cutsJson(lists2[blockIndex(call.body)] || [])) }));
  t.after(() => mock2.close());
  const b = await run(s2.make(mock2).manager, {}, s2.tr);
  assert.ok(b.done.warnings.some((w) => w.code === 'AI_PICK_FAILED'));
  assert.deepEqual(counts(b.done.ai.funnel), { returned: 4, verified: 3, unique: 3, offered: 3, picked: null, final: 3 });
  assert.deepEqual(b.done.ai.unpicked, []);
});
