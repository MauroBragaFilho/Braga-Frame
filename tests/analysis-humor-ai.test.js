'use strict';

/**
 * PERFIL DE HUMOR DO CANAL, lado da IA (src/core/analysis/ai/{prompt,chunking,analyze,manager,humorExamples}.js):
 *   - o pedido de cada bloco leva os critérios, os bordões, as palavras de reação e, se o perfil deixa, trechos de cortes aprovados e rejeitados;
 *   - a escolha final leva o resumo do perfil (sem os exemplos);
 *   - os exemplos vêm dos projetos do mesmo canal, com transcrição que ainda vale, e nunca passam dos limites;
 *   - sem perfil o pedido é o de sempre; o resultado diz só quantas coisas do perfil foram enviadas.
 * Tudo contra stores de verdade em pasta temporária e um servidor HTTP local que imita `chat/completions` (nada de mock do que está sendo testado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const humor = require('../src/core/analysis/humor');
const prompt = require('../src/core/analysis/ai/prompt');
const { buildWindows, estimate } = require('../src/core/analysis/ai/chunking');
const { selectExamples, normalizeExamples, excerpt } = require('../src/core/analysis/ai/humorExamples');
const { AiRuntime } = require('../src/core/ai/runtime');
const { AiAnalysisManager } = require('../src/core/analysis/ai/manager');
const { ProjectStore, newProject } = require('../src/core/projects/projectStore');
const { TranscriptStore } = require('../src/core/analysis/transcript/store');
const { buildDocument, normalizeCues } = require('../src/core/analysis/transcript/format');
const F = require('./ai-fakes');

const TEXT = (word) => `${word} aconteceu agora uma coisa inacreditável no meio do jogo e o chat foi à loucura`; // > 40 caracteres
const userText = (body) => body.messages[body.messages.length - 1].content;
const isPick = (body) => userText(body).includes('=== CANDIDATOS ===');

/**
 * Um "mundo" de projetos: cada projeto tem vídeo (só o caminho), cortes com status e uma transcrição guardada que cobre os cortes.
 * `cuts`: [{ title, status, start, end, text, exported? }]. `stale`: a transcrição é de outro arquivo (tamanho diferente); `noTranscript`: não há.
 */
function world(t) {
  const dir = F.tmpDir();
  t.after(() => F.cleanup(dir));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
  const projects = new ProjectStore(path.join(dir, 'projects'));
  const transcripts = new TranscriptStore(path.join(dir, 'transcripts'));
  const add = ({ name, channel = 'Canal Braga', updatedAt, cuts = [], stale = false, noTranscript = false, source = null }) => {
    const video = source ? source.path : path.join(dir, `${name}.mp4`);
    const info = source ? { size: source.size, duration: source.duration } : { size: 1000, duration: 600 };
    const p = newProject(video, info);
    p.meta.channel = channel;
    p.cuts = cuts.map((c, i) => ({ id: `${name}-c${i}`, title: c.title, start: c.start, end: c.end, status: c.status, category: c.category || '', exports: c.exported ? [{ path: 'x.mp4' }] : [] }));
    const saved = projects.save(p);
    if (updatedAt) { // a ordem por recência da lista segue `updatedAt`
      const file = projects.fileFor(video);
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), updatedAt }, null, 2));
    }
    if (!noTranscript) {
      const cues = cuts.map((c) => ({ start: c.start + 1, end: c.end - 1, text: c.text || TEXT(c.title) }));
      transcripts.save(saved.id, buildDocument({
        projectId: saved.id, origin: 'imported', source: { path: video, size: stale ? info.size + 1 : info.size, duration: info.duration }, cues,
        dropped: { invalid: 0, beyond: 0, repeats: 0 }
      }));
    }
    return saved.id;
  };
  return { dir, projects, transcripts, add };
}

const cut = (title, status, start, extra = {}) => ({ title, status, start, end: start + 30, ...extra });

// ---------- o texto do pedido ----------

test('profileBlock: critérios, bordões, reações e exemplos aprovados/rejeitados; sem perfil não há bloco; exemplos só se o perfil deixa', () => {
  assert.equal(prompt.profileBlock(null, { approved: [{ text: 'x'.repeat(50) }] }), '');
  assert.equal(prompt.profileBlock({ examples: true }, {}), '', 'só os exemplos ligados não dizem nada');
  const profile = { criteria: 'Humor seco e inesperado.\nNão gosto de grito vazio.', catchphrases: ['Beco moleque', 'bora'], reactions: ['eita'], examples: true };
  const examples = {
    approved: [{ title: 'O bicho "caiu"', category: 'Engraçado', durationSec: 38, text: 'cara eu juro que “vi” o bicho cair sozinho' }],
    rejected: [{ title: 'Conversa', category: '', durationSec: 22, text: 'depois eu configuro o servidor com calma' }]
  };
  const text = prompt.profileBlock(profile, examples);
  assert.match(text, /^=== PERFIL DE HUMOR DESTE CANAL/);
  assert.ok(text.includes('Critérios do dono:\nHumor seco e inesperado.\nNão gosto de grito vazio.'));
  assert.ok(text.includes('Bordões e expressões do canal: “Beco moleque”, “bora”'));
  assert.ok(text.includes('Palavras e reações do canal: “eita”'));
  assert.ok(text.includes('APROVOU'), 'tem a seção dos aprovados');
  assert.ok(text.includes('REJEITOU'), 'tem a seção dos rejeitados');
  assert.ok(text.includes("1. O bicho 'caiu' (38 s, Engraçado) fala do corte: “cara eu juro que 'vi' o bicho cair sozinho”"), text);
  assert.ok(text.includes('1. Conversa (22 s) fala do corte: “depois eu configuro o servidor com calma”'), 'sem categoria não sobra vírgula');
  assert.match(text, /não os copie/, 'os exemplos são só referência de gosto');
  assert.match(text, /SOMENTE para a transcrição abaixo/);
  // exemplos desligados: o resto do perfil segue, os exemplos não
  const off = prompt.profileBlock({ ...profile, examples: false }, examples);
  assert.ok(off.includes('Critérios do dono:') && !off.includes('APROVOU') && !off.includes('bicho'), off);
  assert.doesNotMatch(off, /não os copie/);
  // o resumo da escolha final: critérios e listas, sem exemplo nenhum
  const summary = prompt.profileSummary(profile);
  assert.ok(summary.includes('Humor seco e inesperado.') && summary.includes('“Beco moleque”') && summary.includes('“eita”'));
  assert.ok(!summary.includes('bicho') && !summary.includes('APROVOU'));
  assert.equal(prompt.profileSummary({}), '');
});

test('buildBlockMessage e buildPickMessage: o perfil entra antes do formato da resposta e, sem ele, a mensagem é a de sempre', () => {
  const window = { index: 0, total: 1, from: 0, to: 600, lines: ['0:05 oi gente'], chatLines: [] };
  const base = { window, meta: { title: 'Live' }, duration: 600, prefs: { minDurationSec: 15, maxDurationSec: 60, keywords: [] }, maxCandidates: 8 };
  const plain = prompt.buildBlockMessage(base);
  assert.equal(prompt.buildBlockMessage({ ...base, profile: '' }), plain);
  const block = prompt.profileBlock({ criteria: 'Humor seco.' }, {});
  const withProfile = prompt.buildBlockMessage({ ...base, profile: block });
  assert.ok(withProfile.indexOf('=== PERFIL DE HUMOR') > withProfile.indexOf('Cortes de 15 a 60 segundos'));
  assert.ok(withProfile.indexOf('=== PERFIL DE HUMOR') < withProfile.indexOf('Formato da resposta'));
  assert.ok(withProfile.indexOf('Formato da resposta') < withProfile.indexOf('=== TRANSCRIÇÃO'));
  assert.equal(withProfile.replace(`\n\n${block}`, ''), plain, 'tirando o bloco volta a ser a mesma mensagem');

  const cand = [{ cid: 'c1', start: 10, end: 40, relevance: 0.8, title: 'T', punchline: 'p', reasons: [], flags: [], category: 'Hype' }];
  const pickBase = { candidates: cand, meta: {}, duration: 600, limit: 3, prefs: { minDurationSec: 15, maxDurationSec: 60 } };
  const pickPlain = prompt.buildPickMessage(pickBase);
  const summary = prompt.profileSummary({ criteria: 'Humor seco.', catchphrases: ['bora'] });
  const pick = prompt.buildPickMessage({ ...pickBase, profile: summary });
  assert.ok(pick.includes('Humor seco.') && pick.indexOf('Humor seco.') < pick.indexOf('Formato da resposta'));
  assert.equal(pick.replace(`\n\n${summary}`, ''), pickPlain);
});

test('chunking: o perfil ocupa espaço em CADA chamada de bloco (a janela encolhe) e a estimativa o inclui', () => {
  const t = F.makeTranscript({ minutes: 60 });
  const plain = buildWindows(t.cues, t.duration, { maxInputTokens: 6000 });
  const withProfile = buildWindows(t.cues, t.duration, { maxInputTokens: 6000, profileTokens: 1500 });
  assert.ok(withProfile.length > plain.length, `${withProfile.length} blocos com o perfil contra ${plain.length} sem ele`);
  const same = buildWindows(t.cues, t.duration, { profileTokens: 700 });
  const base = buildWindows(t.cues, t.duration);
  assert.equal(same.length, base.length);
  for (let i = 0; i < base.length; i += 1) assert.equal(same[i].tokens, base[i].tokens + 700, `bloco ${i}`);
  const e0 = estimate(base);
  const e1 = estimate(same, { pickExtraTokens: 300 });
  assert.equal(e1.inputTokens, e0.inputTokens + 700 * base.length + 300);
  for (const bad of [undefined, null, -5, 'x', NaN]) assert.deepEqual(buildWindows(t.cues, t.duration, { profileTokens: bad }).map((w) => w.tokens), base.map((w) => w.tokens), String(bad));
});

// ---------- os exemplos (humorExamples.js) ----------

test('excerpt: a fala inteira se couber; senão o começo e o fim do corte, em fim de palavra, dentro do limite', () => {
  const cues = [{ start: 0, end: 4, text: 'primeiro   trecho' }, { start: 4, end: 8, text: 'segundo trecho' }, { start: 100, end: 104, text: 'fora do corte' }];
  assert.equal(excerpt(cues, 0, 10), 'primeiro trecho segundo trecho', 'espaços normalizados, só o que toca o corte');
  const long = Array.from({ length: 60 }, (_, i) => ({ start: i * 2, end: i * 2 + 1.9, text: `palavra${i} segue aqui` }));
  const short = excerpt(long, 0, 120, 200);
  assert.ok(short.length <= 200, `${short.length}`);
  assert.ok(short.startsWith('palavra0 segue aqui palavra1'));
  assert.ok(short.endsWith('segue aqui'), short);
  assert.ok(short.includes(' […] '));
  assert.ok(!/palavr$|palav$/.test(short.split(' […] ')[0]), 'não corta palavra ao meio');
  assert.equal(excerpt(null, 0, 10), '');
  assert.equal(excerpt([], 0, 10), '');
});

test('normalizeExamples: lixo vira vazio e os limites valem (quantidade, tamanho do texto, texto vazio sai)', () => {
  for (const bad of [undefined, null, 5, 'x', [], { approved: 'x', rejected: {} }]) assert.deepEqual(normalizeExamples(bad), { approved: [], rejected: [] }, String(bad));
  const many = normalizeExamples({
    approved: Array.from({ length: 10 }, (_, i) => ({ title: `T${i}`, category: 'Hype', durationSec: 30.4, text: `texto ${i} ${'y'.repeat(900)}` })),
    rejected: [{ text: '' }, null, { title: 'sem texto' }, { text: 'bom', durationSec: 'x', title: 7 }, 5]
  });
  assert.equal(many.approved.length, humor.LIMITS.examplesPositive);
  assert.ok(many.approved.every((e) => e.text.length <= humor.LIMITS.exampleChars && e.durationSec === 30));
  assert.deepEqual(many.rejected, [{ title: '', category: '', durationSec: 0, text: 'bom' }]);
});

test('selectExamples: só projetos do mesmo canal, com transcrição que ainda vale, exportados primeiro, variedade entre os projetos e nos limites', (t) => {
  const w = world(t);
  const p1 = w.add({ name: 'p1', updatedAt: '2026-10-20T10:00:00.000Z', cuts: [
    cut('A1', 'approved', 10, { exported: true }), cut('A2', 'approved', 50), cut('A3', 'approved', 90), cut('R1', 'rejected', 130), cut('R2', 'rejected', 170), cut('P1', 'pending', 210)
  ] });
  w.add({ name: 'p2', updatedAt: '2026-10-19T10:00:00.000Z', cuts: [cut('B1', 'approved', 10, { exported: true }), cut('B2', 'approved', 50), cut('R3', 'rejected', 90)] });
  w.add({ name: 'p3', updatedAt: '2026-10-18T10:00:00.000Z', channel: '  CANAL braga ', cuts: [cut('C1', 'approved', 10), cut('R4', 'rejected', 50)] });
  w.add({ name: 'p4', updatedAt: '2026-10-17T10:00:00.000Z', channel: 'Outro Canal', cuts: [cut('D1', 'approved', 10), cut('R5', 'rejected', 50)] });
  w.add({ name: 'p5', updatedAt: '2026-10-16T10:00:00.000Z', stale: true, cuts: [cut('E1', 'approved', 10)] });
  w.add({ name: 'p6', updatedAt: '2026-10-15T10:00:00.000Z', noTranscript: true, cuts: [cut('F1', 'approved', 10)] });
  w.add({ name: 'p7', updatedAt: '2026-10-14T10:00:00.000Z', cuts: [cut('G1', 'approved', 10, { text: 'curto' })] });
  const titles = (list) => list.map((e) => e.title);

  const ex = selectExamples({ projects: w.projects, transcripts: w.transcripts, projectId: p1 });
  assert.deepEqual(titles(ex.approved), ['A1', 'B1', 'A2', 'B2'], 'exportados primeiro; no máximo 2 por projeto; limite de 4');
  assert.deepEqual(titles(ex.rejected), ['R1', 'R3', 'R4'], 'um rejeitado por projeto; limite de 3; só do mesmo canal (caixa e espaços não contam)');
  assert.equal(ex.projects, 4, 'lidos: p1, p2, p3 e p7 (que não rende exemplo: fala curta); p4 é de outro canal, p5 tem transcrição de outro arquivo e p6 não tem');
  const first = ex.approved[0];
  assert.deepEqual(Object.keys(first).sort(), ['category', 'cutId', 'durationSec', 'end', 'exported', 'projectId', 'start', 'text', 'title']);
  assert.equal(first.exported, true);
  assert.equal(first.durationSec, 30);
  assert.equal(first.projectId, p1);
  assert.ok(first.text.length >= 40 && first.text.length <= humor.LIMITS.exampleChars);
  assert.ok(first.text.includes('A1 aconteceu agora'), 'o texto é a fala do corte');

  // sem projeto (ou projeto sem canal) vale qualquer canal; limites pedidos
  const all = selectExamples({ projects: w.projects, transcripts: w.transcripts, projectId: null, maxApproved: 10, maxRejected: 10 });
  assert.ok(titles(all.approved).includes('D1') && titles(all.rejected).includes('R5'), 'outro canal entra quando o projeto não diz o canal');
  assert.ok(!titles(all.approved).some((x) => ['E1', 'F1', 'G1'].includes(x)), 'transcrição de outro arquivo, ausente ou curta demais não serve');
  assert.deepEqual(titles(selectExamples({ projects: w.projects, transcripts: w.transcripts, projectId: p1, maxApproved: 0, maxRejected: 1 }).approved), []);

  // poucos projetos: a variedade (2 por projeto) cede para completar o limite
  const solo = world(t);
  const s1 = solo.add({ name: 's1', cuts: [cut('S1', 'approved', 10), cut('S2', 'approved', 50), cut('S3', 'approved', 90), cut('S4', 'approved', 130)] });
  assert.deepEqual(titles(selectExamples({ projects: solo.projects, transcripts: solo.transcripts, projectId: s1 }).approved), ['S1', 'S2', 'S3', 'S4']);
});

test('selectExamples nunca lança: sem os stores, lista quebrada, projeto ilegível e id inválido', (t) => {
  const empty = { approved: [], rejected: [], projects: 0 };
  assert.deepEqual(selectExamples({}), empty);
  assert.deepEqual(selectExamples(), empty);
  const w = world(t);
  assert.deepEqual(selectExamples({ projects: w.projects, transcripts: null }), empty);
  assert.deepEqual(selectExamples({ projects: { list() { throw new Error('quebrou'); }, loadById() { throw new Error('x'); } }, transcripts: w.transcripts, projectId: 'abc' }), empty);
  const id = w.add({ name: 'ok', cuts: [cut('Ok', 'approved', 10)] });
  const bad = { list: () => w.projects.list(), loadById: (x) => { if (x === id) throw new Error('ilegível'); return w.projects.loadById(x); } };
  assert.deepEqual(selectExamples({ projects: bad, transcripts: w.transcripts, projectId: 'não é um id' }), empty, 'projeto ilegível é pulado');
  assert.equal(selectExamples({ projects: w.projects, transcripts: w.transcripts, projectId: 12345 }).approved.length, 1, 'id que não é texto: olha todos');
});

// ---------- a análise por IA com o perfil ----------

const VIDEO = { path: 'C:/videos/live-do-canal.mp4', size: 1234567, duration: 40 * 60 };

/** Mundo + projeto atual (a live analisada, com transcrição) + projetos passados do mesmo canal; devolve também o gerente. */
function aiSetup(t, { retry } = {}) {
  const w = world(t);
  const tr = F.makeTranscript({ minutes: 40, moments: [{ at: 600, punch: 'o bicho nem dropou couro' }, { at: 1500, punch: 'vinte e um reais uma espada' }] });
  const source = { ...VIDEO, duration: tr.duration };
  const currentId = w.add({ name: 'live', source, updatedAt: '2026-10-23T10:00:00.000Z' });
  const { cues } = normalizeCues(tr.cues.map((c) => ({ start: c.start, end: c.end, text: c.text })), { duration: tr.duration });
  w.transcripts.save(currentId, buildDocument({ projectId: currentId, origin: 'imported', source, cues, dropped: {}, importedFrom: 't.srt' }));
  w.add({ name: 'antiga1', updatedAt: '2026-10-20T10:00:00.000Z', cuts: [cut('Susto no corredor', 'approved', 10, { exported: true, category: 'Engraçado', text: 'eu abri a porta e tinha um bicho gigante parado ali olhando pra mim cara' }),
    cut('Papo de servidor', 'rejected', 60, { text: 'depois eu vejo a configuração do servidor com calma e a gente testa de novo' })] });
  w.add({ name: 'antiga2', updatedAt: '2026-10-19T10:00:00.000Z', cuts: [cut('Morte boba', 'approved', 10, { text: 'morri afogado na própria piscina de lava que eu mesmo construí ontem aqui' })] });
  const sleeps = [];
  const make = (mock) => {
    const runtime = new AiRuntime({ dir: path.join(w.dir, 'ai'), safeStorage: F.fakeSafeStorage() });
    runtime.save({ provider: 'custom', baseUrl: mock.base, model: 'fake-model', apiKey: F.KEY });
    runtime.accept(true);
    const manager = new AiAnalysisManager({
      runtime, store: w.transcripts, projects: w.projects, getTools: () => ({ ffmpeg: null, ffprobe: null }),
      readChat: async () => null, sleep: async (ms) => { sleeps.push(ms); }, retry
    });
    return { runtime, manager };
  };
  return { ...w, tr, source, currentId, make, sleeps };
}

function runAi(manager, s, extra = {}) {
  return new Promise((resolve) => {
    manager.on('done', (e) => resolve({ done: e.result }));
    manager.on('failed', (e) => resolve({ failed: e }));
    manager.start({
      projectId: s.currentId, path: s.source.path, size: s.source.size, duration: s.tr.duration,
      params: { minDurationSec: 15, maxDurationSec: 60, padBeforeSec: 2, padAfterSec: 1, minRelevance: 0.4, perHour: 20 }, meta: { title: 'Live' }, existingCuts: [], ...extra
    });
  });
}

/** Servidor de mentira: cada bloco devolve os momentos da transcrição que caem nele; a escolha final aceita todos os candidatos. */
function mockFor(s) {
  return F.startMockAi((call) => {
    const text = userText(call.body);
    if (isPick(call.body)) {
      const ids = [...text.matchAll(/id=(c\d+)/g)].map((x) => x[1]);
      return { json: F.chatBody(JSON.stringify({ picks: ids.map((id) => ({ id, relevance: 0.9, title: `Final ${id}`, category: 'Hype', reasons: ['bordão do canal: “bora”'] })) })) };
    }
    const range = /de (\d+):(\d+) até (\d+):(\d+)/.exec(text);
    const from = range ? Number(range[1]) * 60 + Number(range[2]) : 0;
    const to = range ? Number(range[3]) * 60 + Number(range[4]) : 0;
    const inside = s.tr.moments.filter((m) => m.start >= from && m.end <= to);
    return { json: F.chatBody(F.cutsJson(inside.map((m) => ({ start: m.start + 2, end: m.end - 1, punchline: m.punch })))) };
  });
}

test('a análise por IA envia o perfil do canal nos blocos e o resumo na escolha final, e o resultado diz só quantas coisas foram', async (t) => {
  const s = aiSetup(t);
  const mock = await mockFor(s);
  t.after(() => mock.close());
  const { manager } = s.make(mock);
  const profile = { criteria: 'Humor seco, sem grito.', catchphrases: ['Beco moleque', 'bora'], reactions: ['eita'], examples: true };
  const { done, failed } = await runAi(manager, s, { profile });
  assert.equal(failed, undefined, failed && failed.message);
  const blocks = mock.calls.filter((c) => !isPick(c.body));
  const picks = mock.calls.filter((c) => isPick(c.body));
  assert.ok(blocks.length >= 1 && picks.length === 1);
  for (const call of blocks) {
    const text = userText(call.body);
    assert.ok(text.includes('=== PERFIL DE HUMOR DESTE CANAL'), 'todo bloco leva o perfil');
    assert.ok(text.includes('Humor seco, sem grito.') && text.includes('“Beco moleque”, “bora”') && text.includes('“eita”'));
    assert.ok(text.includes('Susto no corredor') && text.includes('um bicho gigante parado ali'), 'exemplo aprovado (exportado) do mesmo canal');
    assert.ok(text.includes('Morte boba'), 'e o outro aprovado');
    assert.ok(text.includes('Papo de servidor') && text.includes('REJEITOU'), 'exemplo rejeitado');
    assert.ok(text.indexOf('=== PERFIL DE HUMOR') < text.indexOf('=== TRANSCRIÇÃO'));
  }
  const pickText = userText(picks[0].body);
  assert.ok(pickText.includes('Perfil de humor do canal') && pickText.includes('Humor seco, sem grito.') && pickText.includes('“Beco moleque”'));
  assert.ok(!pickText.includes('Susto no corredor') && !pickText.includes('bicho gigante'), 'a escolha final não leva exemplos');
  assert.equal(done.ai.profile.criteria, true);
  assert.deepEqual({ ...done.ai.profile, examples: undefined }, { criteria: true, catchphrases: 2, reactions: 1, themes: 0, examples: undefined });
  assert.deepEqual(done.ai.profile.examples, { approved: 2, rejected: 1 });
  assert.ok(!JSON.stringify(done).includes('bicho gigante') && !JSON.stringify(done).includes('Humor seco'), 'o texto do perfil e dos exemplos não vai para o resultado');
  assert.ok(done.suggestions.length >= 1);
  assert.ok(!F.mentions(mock.calls.map((c) => c.body), F.KEY), 'nada disso leva a chave');
});

test('exemplos desligados no perfil: critérios e listas vão, os trechos de cortes antigos não; perfil vazio = pedido de sempre', async (t) => {
  const s = aiSetup(t);
  const mock = await mockFor(s);
  t.after(() => mock.close());
  const off = await runAi(s.make(mock).manager, s, { profile: { criteria: 'Humor seco.', examples: false } });
  assert.equal(off.failed, undefined, off.failed && off.failed.message);
  for (const call of mock.calls.filter((c) => !isPick(c.body))) {
    const text = userText(call.body);
    assert.ok(text.includes('Humor seco.') && !text.includes('Susto no corredor') && !text.includes('REJEITOU') && !text.includes('APROVOU'));
  }
  assert.deepEqual(off.done.ai.profile.examples, { approved: 0, rejected: 0 });

  // perfil vazio (só os exemplos ligados) ou ausente: nada de perfil no pedido, e `ai.profile` é null
  for (const profile of [undefined, null, {}, { examples: true }, { criteria: '   ', catchphrases: [' '] }, 'texto', 7]) {
    const before = mock.calls.length;
    const r = await runAi(s.make(mock).manager, s, { profile });
    assert.equal(r.failed, undefined, r.failed && r.failed.message);
    assert.equal(r.done.ai.profile, null, JSON.stringify(profile));
    for (const call of mock.calls.slice(before)) assert.ok(!userText(call.body).includes('PERFIL DE HUMOR') && !userText(call.body).includes('Perfil de humor'), JSON.stringify(profile));
  }
});

test('sem os projetos (ou sem projeto do mesmo canal) o perfil vai sem exemplos; a estimativa antes de rodar inclui o perfil e o resultado não muda', async (t) => {
  const s = aiSetup(t);
  const mock = await mockFor(s);
  t.after(() => mock.close());
  const { runtime } = s.make(mock);
  const noProjects = new AiAnalysisManager({ runtime, store: s.transcripts, getTools: () => ({}), readChat: async () => null });
  const profile = { criteria: 'Humor seco.', catchphrases: ['bora'], examples: true };
  assert.deepEqual(noProjects.humorFor(s.currentId, profile).examples, { approved: [], rejected: [], projects: 0 }, 'sem ProjectStore não há de onde tirar exemplos');
  assert.deepEqual(noProjects.humorExamples({ projectId: s.currentId }), { approved: [], rejected: [], projects: 0 });

  const { manager } = s.make(mock);
  const base = { projectId: s.currentId, path: s.source.path, size: s.source.size, duration: s.tr.duration };
  const plain = await manager.estimate(base);
  const withProfile = await manager.estimate({ ...base, profile });
  assert.ok(withProfile.inputTokens > plain.inputTokens, `${withProfile.inputTokens} > ${plain.inputTokens}`);
  assert.equal(withProfile.calls, plain.calls);
  const noExamples = await manager.estimate({ ...base, profile: { ...profile, examples: false } });
  assert.ok(noExamples.inputTokens < withProfile.inputTokens && noExamples.inputTokens > plain.inputTokens, 'os exemplos também contam');
  assert.equal(mock.calls.length, 0, 'estimar não envia nada');
  const ex = manager.humorExamples({ projectId: s.currentId });
  assert.deepEqual(ex.approved.map((e) => e.title), ['Susto no corredor', 'Morte boba']);
  assert.deepEqual(ex.rejected.map((e) => e.title), ['Papo de servidor']);
  assert.equal(mock.calls.length, 0, 'mostrar os exemplos também não envia nada');
});

test('a estimativa reaproveita por alguns segundos a leitura dos exemplos (os projetos são arquivos de verdade); a análise e a caixa dos exemplos sempre leem de novo', async (t) => {
  const s = aiSetup(t);
  const mock = await mockFor(s);
  t.after(() => mock.close());
  const { runtime } = s.make(mock);
  let listCalls = 0;
  const counting = { list: () => { listCalls += 1; return s.projects.list(); }, loadById: (id) => s.projects.loadById(id) };
  const manager = new AiAnalysisManager({ runtime, store: s.transcripts, projects: counting, getTools: () => ({}), readChat: async () => null });
  const profile = { criteria: 'Humor seco.', examples: true };
  const base = { projectId: s.currentId, path: s.source.path, size: s.source.size, duration: s.tr.duration };
  const first = await manager.estimate({ ...base, profile });
  await manager.estimate({ ...base, profile });
  await manager.estimate({ ...base, profile: { ...profile, criteria: 'Outro critério.' } });
  assert.equal(listCalls, 1, 'três estimativas seguidas leram os projetos uma vez só');
  assert.ok(first.inputTokens > 0);
  manager.humorExamples({ projectId: s.currentId });
  assert.equal(listCalls, 2, 'a caixa dos exemplos lê de novo');
  assert.equal(manager.humorFor(s.currentId, profile, { fresh: true }).examples.approved.length, 2);
  assert.equal(listCalls, 3, 'a análise que vai enviar lê de novo');
  manager.humorFor(s.currentId, profile);
  assert.equal(listCalls, 3, 'e a estimativa seguinte já reaproveita essa leitura');
  // outro projeto = outra leitura; o perfil sem exemplos nem consulta os projetos
  manager.humorFor('0123456789abcdef', profile);
  assert.equal(listCalls, 4);
  manager.humorFor(s.currentId, { ...profile, examples: false }, { fresh: true });
  manager.humorFor(s.currentId, null, { fresh: true });
  assert.equal(listCalls, 4);
  // projetos ilegíveis nunca derrubam a estimativa: o perfil segue sem exemplos
  const broken = new AiAnalysisManager({ runtime, store: s.transcripts, projects: { list() { throw new Error('quebrou'); }, loadById() { throw new Error('quebrou'); } }, getTools: () => ({}), readChat: async () => null });
  const est = await broken.estimate({ ...base, profile });
  assert.ok(est.inputTokens > 0);
  assert.deepEqual(broken.humorFor(s.currentId, profile, { fresh: true }).examples, { approved: [], rejected: [], projects: 0 });
});

// ---------- temas do canal e palavras-chave por sugestão ----------

test('temas: entram no pedido dos blocos e da escolha final, o perfil só com temas já vale e o formato pede palavras-chave e tema', () => {
  const only = { themes: ['Piadas', 'Cenas de história'] };
  assert.equal(humor.isEmpty(only), false, 'só os temas já dizem alguma coisa');
  const block = prompt.profileBlock(only, {});
  assert.ok(block.includes('Temas que o dono quer neste canal: “Piadas”, “Cenas de história”'));
  assert.ok(/distribua os cortes entre eles/.test(block) && /preencha "theme"/.test(block));
  const summary = prompt.profileSummary(only);
  assert.ok(summary.includes('Temas que o dono quer neste canal: “Piadas”, “Cenas de história”'));
  assert.ok(prompt.CUT_SCHEMA.includes('"keywords"') && prompt.CUT_SCHEMA.includes('"theme"'));
  const pick = prompt.buildPickMessage({
    candidates: [{ cid: 'c1', start: 60, end: 90, relevance: 0.8, theme: 'Piadas', title: 't', punchline: 'p', reasons: [], flags: [] }, { cid: 'c2', start: 100, end: 130, relevance: 0.7, title: 't2', punchline: 'p', reasons: [], flags: [] }],
    meta: {}, duration: 600, limit: 2, prefs: { minDurationSec: 15, maxDurationSec: 60 }
  });
  const rowOf = (id) => pick.split(/\r?\n/).find((l) => l.startsWith(`id=${id} `)) || '';
  assert.ok(rowOf('c1').includes('| tema Piadas') && !rowOf('c2').includes('tema'), 'o tema aparece só no candidato que tem');
  assert.equal(humor.listText(humor.normalizeProfile({ themes: 'piadas; Piadas, história' }).themes), 'piadas, história', 'sem repetidos (acento e caixa não contam)');
});

test('palavras-chave e tema vindos da IA: limpos (sem #, sem repetir, no máximo 5) e o tema só vale se for um dos do perfil', async (t) => {
  const parse = require('../src/core/analysis/ai/parse');
  const parsed = parse.parseCandidates(JSON.stringify({ cuts: [{ start: '1:00', end: '1:30', keywords: ['#Susto', 'susto', ' bicho   gigante ', 'a', 'b', 'c', 'd', 7, ''], theme: 'Piadas' }] }));
  assert.deepEqual(parsed.items[0].keywords, ['Susto', 'bicho gigante', 'a', 'b', 'c']);
  assert.equal(parsed.items[0].theme, 'Piadas');
  assert.deepEqual(parse.parseCandidates(JSON.stringify({ cuts: [{ start: '1:00', end: '1:30' }] })).items[0].keywords, [], 'sem palavras-chave vira lista vazia');

  const s = aiSetup(t);
  const mock = F.startMockAi((call) => {
    const text = userText(call.body);
    if (isPick(call.body)) {
      const ids = [...text.matchAll(/id=(c\d+)/g)].map((x) => x[1]);
      return { json: F.chatBody(JSON.stringify({ picks: ids.map((id) => ({ id, relevance: 0.9, title: `Final ${id}`, category: 'Hype', reasons: ['arco completo'] })) })) };
    }
    const range = /de (\d+):(\d+) até (\d+):(\d+)/.exec(text);
    const from = range ? Number(range[1]) * 60 + Number(range[2]) : 0;
    const to = range ? Number(range[3]) * 60 + Number(range[4]) : 0;
    const inside = s.tr.moments.filter((m) => m.start >= from && m.end <= to);
    return { json: F.chatBody(F.cutsJson(inside.map((m, i) => ({
      start: m.start + 2, end: m.end - 1, punchline: m.punch,
      theme: i % 2 ? 'Receitas de bolo' : 'cenas de história', keywords: ['#Susto', 'susto', 'corredor']
    })))) };
  });
  const world2 = await mock;
  t.after(() => world2.close());
  const { manager } = s.make(world2);
  const { done, failed } = await runAi(manager, s, { profile: { themes: ['Piadas', 'Cenas de história'] } });
  assert.equal(failed, undefined, failed && failed.message);
  const blocks = world2.calls.filter((c) => !isPick(c.body));
  assert.ok(blocks.length >= 1 && blocks.every((c) => userText(c.body).includes('Temas que o dono quer neste canal')));
  assert.ok(isPick(world2.calls.at(-1).body) && userText(world2.calls.at(-1).body).includes('Temas que o dono quer neste canal'));
  assert.deepEqual(done.ai.profile.themes, 2, 'o resultado diz só quantos temas foram, não quais');
  assert.ok(done.suggestions.length >= 2, `sugestões: ${done.suggestions.length}`);
  for (const sug of done.suggestions) {
    assert.deepEqual(sug.keywords, ['Susto', 'corredor']);
    assert.ok(sug.theme === undefined || sug.theme === 'Cenas de história', `tema inventado não passa: ${sug.theme}`);
  }
  assert.ok(done.suggestions.some((x) => x.theme === 'Cenas de história'), 'o tema do perfil volta escrito como o dono escreveu');
  assert.ok(done.suggestions.some((x) => x.theme === undefined), 'o tema que não é do perfil ("Receitas de bolo") foi descartado');
  assert.ok(!JSON.stringify(done).includes('Receitas de bolo'));

  // sem temas no perfil nenhum tema da IA vale; as palavras-chave continuam
  const s2 = aiSetup(t);
  const mock2 = await F.startMockAi((call) => {
    const text = userText(call.body);
    if (isPick(call.body)) return { json: F.chatBody(JSON.stringify({ picks: [...text.matchAll(/id=(c\d+)/g)].map((x) => ({ id: x[1], relevance: 0.9, title: 'F', category: 'Hype', reasons: ['x'] })) })) };
    const range = /de (\d+):(\d+) até (\d+):(\d+)/.exec(text);
    const from = range ? Number(range[1]) * 60 + Number(range[2]) : 0;
    const to = range ? Number(range[3]) * 60 + Number(range[4]) : 0;
    return { json: F.chatBody(F.cutsJson(s2.tr.moments.filter((m) => m.start >= from && m.end <= to).map((m) => ({ start: m.start + 2, end: m.end - 1, punchline: m.punch, theme: 'Piadas', keywords: ['bicho'] })))) };
  });
  t.after(() => mock2.close());
  const second = await runAi(s2.make(mock2).manager, s2, {});
  assert.equal(second.failed, undefined, second.failed && second.failed.message);
  assert.ok(second.done.suggestions.length >= 1);
  assert.ok(second.done.suggestions.every((x) => x.theme === undefined && x.keywords.join() === 'bicho'));
});
