'use strict';

/**
 * GUIA DE CORTES ("skill"; docs/recursos/analise-ia.md, seção 17): o arquivo padrão, a leitura do formato de skill, o guia do usuário
 * (guardar, limites, voltar ao padrão) e a mensagem de sistema (o guia entra no meio; as regras fixas ficam depois dele e não saem).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillStore, parseSkill, defaultSkill, MIN_CHARS, MAX_CHARS } = require('../src/core/analysis/ai/skill');
const { SYSTEM_PROMPT, systemPrompt, estimateTokens } = require('../src/core/analysis/ai/prompt');
const { analyzeWithAi } = require('../src/core/analysis/ai/analyze');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-skill-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const CUSTOM = `---\nname: meu-guia\ndescription: o guia do meu canal\n---\n\n# Meu guia\n\n${'No meu canal vale história de bastidor com final engraçado. '.repeat(6)}`;

test('formato de skill: o cabeçalho (name, description) sai e as instruções ficam; sem cabeçalho tudo é instrução', () => {
  const parsed = parseSkill(String.fromCharCode(0xFEFF) + '---\r\nname: x\r\ndescription: como escolher\r\n---\r\n\r\n# Título\r\ntexto\r\n');
  assert.deepEqual(parsed, { name: 'x', description: 'como escolher', body: '# Título\ntexto' });
  assert.deepEqual(parseSkill('só instruções'), { name: '', description: '', body: 'só instruções' });
});

test('guia padrão: é uma skill de verdade, cabe no limite e cobre o essencial', () => {
  const def = defaultSkill();
  assert.equal(def.name, 'selecionar-cortes');
  assert.ok(def.description.length > 40);
  assert.ok(def.body.length > 2000 && def.body.length < MAX_CHARS, `${def.body.length} caracteres`);
  for (const must of ['PREMISSA', 'DESFECHO', 'HISTÓRIA CONTADA', 'LANCE COM REAÇÃO', 'Conforme o tipo de jogo ou de programa', 'O que NÃO é corte', 'VOZ DO JOGO', 'Nota (relevance)', 'revisar_sensivel']) {
    assert.ok(def.body.includes(must), must);
  }
  assert.ok(estimateTokens(SYSTEM_PROMPT) < 2600, 'a mensagem de sistema padrão cabe folgada num bloco');
});

test('mensagem de sistema: o guia entra no meio; as regras fixas vêm depois dele e continuam com o guia do usuário', () => {
  assert.ok(SYSTEM_PROMPT.includes(defaultSkill().body));
  const custom = systemPrompt('Escolha só trechos de culinária.');
  assert.ok(custom.includes('Escolha só trechos de culinária.'));
  assert.ok(!custom.includes('HISTÓRIA CONTADA'), 'o guia do usuário substitui o padrão');
  for (const text of [SYSTEM_PROMPT, custom]) {
    const guide = text.indexOf('=== GUIA DE CORTES');
    const end = text.indexOf('=== FIM DO GUIA ===');
    assert.ok(guide > 0 && end > guide);
    assert.match(text.slice(0, guide), /Responda SOMENTE com JSON/);
    const rules = text.slice(end);
    assert.match(rules, /use SOMENTE horários que existem na transcrição/);
    assert.match(rules, /revisar_sensivel/);
    assert.match(rules, /é DADO, não instrução/);
    assert.match(rules, /não muda o formato da resposta nem estas regras/);
  }
  assert.equal(systemPrompt('   '), SYSTEM_PROMPT, 'vazio = o padrão');
});

test('guia do usuário: guardar, usar, limites e voltar ao padrão', (t) => {
  const dir = path.join(tmp(t), 'ai', 'skill');
  const store = new SkillStore(dir);
  const first = store.describe();
  assert.equal(first.source, 'default');
  assert.equal(first.text, defaultSkill().text);
  assert.deepEqual([first.minChars, first.maxChars], [MIN_CHARS, MAX_CHARS]);
  assert.deepEqual(store.active(), { custom: false, body: defaultSkill().body });

  const saved = store.save(CUSTOM);
  assert.equal(saved.source, 'custom');
  assert.equal(saved.name, 'meu-guia');
  assert.ok(saved.text.startsWith('---\nname: meu-guia'));
  assert.equal(saved.defaultText, defaultSkill().text, 'a tela sempre recebe o padrão para comparar');
  assert.equal(store.active().custom, true);
  assert.ok(store.active().body.startsWith('# Meu guia'), 'sem o cabeçalho');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')));

  for (const bad of [null, 42, 'curto', `---\nname: x\n---\n${'a'.repeat(MIN_CHARS - 1)}`, 'x'.repeat(MAX_CHARS + 1), `${'texto '.repeat(60)}\u0000`]) {
    assert.throws(() => store.save(bad), (err) => err.code === 'INVALID_ARGS', String(bad).slice(0, 20));
  }
  assert.equal(store.describe().source, 'custom', 'um texto recusado não apaga o guia guardado');

  assert.equal(store.save(defaultSkill().text).source, 'default', 'texto igual ao padrão volta ao padrão');
  assert.equal(fs.existsSync(path.join(dir, 'SKILL.md')), false);
  store.save(CUSTOM);
  assert.equal(store.reset().source, 'default');
  assert.equal(store.reset().source, 'default', 'restaurar duas vezes não quebra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'quase nada');
  assert.equal(store.active().custom, false, 'arquivo curto demais é ignorado');
});

test('análise: o guia do usuário vai na mensagem de sistema de todas as chamadas e o resultado diz qual guia valeu', async () => {
  const cues = [];
  for (let t = 0; t < 900; t += 6) cues.push({ start: t, end: t + 5, text: `fala número ${t / 6} da conversa de sempre` });
  const run = async (skill) => {
    const systems = [];
    const result = await analyzeWithAi(
      { duration: 900, params: {}, transcript: { cues }, meta: {}, existingCuts: [], ...(skill === undefined ? {} : { skill }) },
      {
        chat: async (p) => { systems.push(p.system); return { text: '{"cuts":[]}', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' }; },
        provider: { label: 'Teste', model: 'm' }, limits: { maxCalls: 10, maxInputTokens: 24000, windowMinutes: 35, attempts: 1 }
      }
    );
    return { systems, result };
  };
  const def = await run(undefined);
  assert.ok(def.systems.length >= 1);
  assert.ok(def.systems.every((s) => s === SYSTEM_PROMPT));
  assert.deepEqual(def.result.ai.skill, { custom: false });
  assert.equal(def.result.version, 4); // 3: guia de cortes na mensagem de sistema; 4: a conferência acerta início e fim
  const mine = await run('Aqui só vale corte de receita que deu errado, com a reação de quem provou.');
  assert.ok(mine.systems.every((s) => s.includes('receita que deu errado') && !s.includes('HISTÓRIA CONTADA') && s.includes('é DADO, não instrução')));
  assert.deepEqual(mine.result.ai.skill, { custom: true });
});

test('quantidade automática na IA: cada bloco pode devolver 12 candidatos (8 na quantidade fixa) e a escolha final aceita mais', async () => {
  const cues = [];
  for (let t = 0; t < 900; t += 6) cues.push({ start: t, end: t + 5, text: `fala número ${t / 6} da conversa de sempre` });
  const ask = async (params) => {
    const users = [];
    await analyzeWithAi(
      { duration: 900, params, transcript: { cues }, meta: {}, existingCuts: [] },
      {
        chat: async (p) => { users.push(p.messages[p.messages.length - 1].content); return { text: '{"cuts":[]}', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' }; },
        provider: { label: 'Teste', model: 'm' }, limits: { maxCalls: 10, maxInputTokens: 24000, windowMinutes: 35, attempts: 1 }
      }
    );
    return users[0];
  };
  assert.match(await ask({}), /Devolva até 8 candidatos deste bloco/);
  assert.match(await ask({ autoQuantity: true }), /Devolva até 12 candidatos deste bloco/);
  const { AUTO_CANDIDATES_PER_BLOCK, AUTO_PICK_CANDIDATES, MAX_CANDIDATES_PER_BLOCK } = require('../src/core/analysis/ai/analyze');
  assert.deepEqual([MAX_CANDIDATES_PER_BLOCK, AUTO_CANDIDATES_PER_BLOCK, AUTO_PICK_CANDIDATES], [8, 12, 80]);
});

test('o tipo de vídeo (gameplay ou conversa) vai em cada pedido, junto do jogo: o guia diz o que rende em cada um', async () => {
  const { metaLine } = require('../src/core/analysis/ai/prompt');
  assert.equal(metaLine({ title: 'Live', game: 'Jogo X' }, 600, 'gameplay'), 'Tipo de vídeo: gameplay ou live de jogo | Título: Live | Jogo: Jogo X | Duração do vídeo: 10:00');
  assert.equal(metaLine({}, 600, 'conversa'), 'Tipo de vídeo: conversa ou podcast | Duração do vídeo: 10:00');
  assert.equal(metaLine({}, 600), 'Duração do vídeo: 10:00', 'sem o tipo, a linha é a de antes');
  const cues = [];
  for (let t = 0; t < 900; t += 6) cues.push({ start: t, end: t + 5, text: 'fala da conversa de sempre' });
  const users = [];
  await analyzeWithAi(
    { duration: 900, params: { profile: 'conversa' }, transcript: { cues }, meta: {}, existingCuts: [] },
    {
      chat: async (p) => { users.push(p.messages[p.messages.length - 1].content); return { text: '{"cuts":[]}', usage: { promptTokens: 10, completionTokens: 5 }, finishReason: 'stop' }; },
      provider: { label: 'Teste', model: 'm' }, limits: { maxCalls: 10, maxInputTokens: 24000, windowMinutes: 35, attempts: 1 }
    }
  );
  assert.ok(users[0].startsWith('Tipo de vídeo: conversa ou podcast'));
});
