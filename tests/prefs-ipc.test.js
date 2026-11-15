'use strict';

/**
 * Canais prefs:* com o ctx de verdade (createContext + Electron falso), arquivos reais em pasta temporária e
 * vídeos reais gerados com o ffmpeg do sistema para prefs:inspect (ffprobe de verdade).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rm, cutsOf, setupMain, makeVideo, saveProject, skipMedia } = require('./prefs-helpers');

const setup = setupMain;

test('todos os canais prefs:* são registrados e o handler carrega sem erro', () => {
  const { dir, ctx, loaded } = setup();
  try {
    assert.deepEqual(loaded.failed, []);
    for (const channel of ['schema', 'resolve', 'get', 'set', 'unset', 'list', 'names', 'observe', 'learned', 'learnedSet', 'learning', 'history', 'revert', 'forget', 'inspect']) {
      assert.ok(ctx.channels.has(`prefs:${channel}`), channel);
    }
    assert.ok(ctx.preferences, 'atalho ctx.preferences para outros módulos do processo principal');
  } finally { rm(dir); }
});

test('schema traz as chaves do contrato 3.5 e os perfis de exportação para o seletor', async () => {
  const { dir, call } = setup();
  try {
    const s = await call('prefs:schema');
    assert.equal(s.ok, true);
    const keys = s.keys.map((k) => k.key);
    for (const k of ['export.profileId', 'export.framing.mode', 'analysis.minRelevance', 'analysis.minDurationSec', 'analysis.maxDurationSec',
      'analysis.padBeforeSec', 'analysis.padAfterSec', 'review.defaultSort', 'review.categories', 'queue.parallel', 'subtitles.enabled', 'subtitles.mode', 'subtitles.style']) {
      assert.ok(keys.includes(k), k);
    }
    assert.ok(s.profiles.some((p) => p.id === 'vertical-1080-h264'), 'perfil padrão presente');
    assert.ok(s.profiles.length >= 12);
    assert.ok(s.groups.length >= 4);
  } finally { rm(dir); }
});

test('resolve / set / get / list / unset em ida e volta, com erros em português e código', async () => {
  const { dir, call } = setup();
  try {
    let r = await call('prefs:resolve', { game: 'Valorant', channel: 'Fulano' });
    assert.equal(r.ok, true);
    assert.equal(r.values['analysis.minRelevance'], 0.5);
    assert.deepEqual(r.scope, { game: 'Valorant', channel: 'Fulano' });

    const set = await call('prefs:set', { scope: { type: 'game', name: 'Valorant' }, key: 'analysis.minRelevance', value: 0.7 });
    assert.deepEqual([set.ok, set.changed], [true, true]);
    r = await call('prefs:resolve', { game: 'valorant' });
    assert.equal(r.values['analysis.minRelevance'], 0.7);
    assert.equal(r.details['analysis.minRelevance'].scope, 'game');

    const got = await call('prefs:get', { key: 'analysis.minRelevance', game: 'Valorant' });
    assert.deepEqual([got.scope, got.source, got.value], ['game', 'explicit', 0.7]);

    const list = await call('prefs:list', { scope: { type: 'game', name: 'Valorant' } });
    assert.deepEqual(list.values, { 'analysis.minRelevance': 0.7 });

    const bad = await call('prefs:set', { scope: { type: 'general' }, key: 'analysis.minRelevance', value: 5 });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'INVALID_VALUE');
    assert.match(bad.message, /entre 0 e 1/);
    assert.equal((await call('prefs:set', { scope: { type: 'general' }, key: 'x.y', value: 1 })).code, 'UNKNOWN_KEY');
    assert.equal((await call('prefs:set', { scope: { type: 'game', name: '' }, key: 'queue.parallel', value: 2 })).code, 'INVALID_SCOPE');

    const un = await call('prefs:unset', { scope: { type: 'game', name: 'Valorant' }, key: 'analysis.minRelevance' });
    assert.equal(un.changed, true);
    assert.equal((await call('prefs:resolve', { game: 'Valorant' })).values['analysis.minRelevance'], 0.5);
  } finally { rm(dir); }
});

test('prefs:set avisa o barramento do processo principal; sem mudança, não avisa', async () => {
  const { dir, ctx, call } = setup();
  try {
    const events = [];
    ctx.bus.on('prefs:changed', (e) => events.push(e));
    await call('prefs:set', { scope: { type: 'general' }, key: 'queue.parallel', value: 2 });
    await call('prefs:set', { scope: { type: 'general' }, key: 'queue.parallel', value: 2 });
    assert.deepEqual(events.map((e) => [e.what, e.key]), [['set', 'queue.parallel']]);
  } finally { rm(dir); }
});

test('aprendizado de ponta a ponta pelos canais: observe → learned → desativar → histórico → desfazer', async () => {
  const { dir, call } = setup();
  try {
    const cuts = cutsOf([30, 34, 36, 40, 44, 50]);
    const obs = await call('prefs:observe', { projectId: 'proj0000000001', game: 'Valorant', channel: 'Fulano', cuts });
    assert.equal(obs.ok, true);
    assert.ok(obs.changes.length >= 2);
    assert.match(obs.changes[0].text, /mediana 38 s/);

    const learned = await call('prefs:learned', { game: 'Valorant', channel: 'Fulano' });
    assert.equal(learned.enabled, true);
    const max = learned.items.find((i) => i.key === 'analysis.maxDurationSec' && i.scope.type === 'general');
    assert.equal(max.state, 'active');
    assert.equal(max.evidence, '6 cortes aprovados, mediana 38 s');
    assert.equal((await call('prefs:resolve', { game: 'Valorant', channel: 'Fulano' })).details['analysis.maxDurationSec'].source, 'learned');

    const off = await call('prefs:learnedSet', { id: max.id, enabled: false });
    assert.equal(off.changed, true);
    assert.equal((await call('prefs:resolve', { game: 'Valorant', channel: 'Fulano' })).details['analysis.maxDurationSec'].source, 'default', 'desativada: volta ao padrão');
    assert.equal((await call('prefs:learnedSet', { id: 'nao:existe:x', enabled: false })).code, 'NOT_FOUND');
    assert.equal((await call('prefs:learnedSet', { id: max.id })).code, 'INVALID_ARGS');

    const hist = await call('prefs:history', { limit: 5 });
    assert.match(hist.entries[0].label, /^Desativou a preferência aprendida/);
    assert.equal(hist.entries[0].revertible, true);
    const rev = await call('prefs:revert', { id: hist.entries[0].id });
    assert.equal(rev.ok, true);
    assert.equal((await call('prefs:resolve', { game: 'Valorant', channel: 'Fulano' })).details['analysis.maxDurationSec'].scope, 'general');
    assert.equal((await call('prefs:revert', { id: hist.entries[0].id })).code, 'ALREADY_REVERTED');

    const lr = await call('prefs:learning', { enabled: false });
    assert.equal(lr.enabled, false);
    assert.equal((await call('prefs:observe', { projectId: 'proj0000000001', cuts: cutsOf([10]) })).ignored, true);
    assert.equal((await call('prefs:learning', { minEvidence: 1 })).code, 'INVALID_VALUE');
    assert.equal((await call('prefs:learning', {})).enabled, false, 'sem payload só consulta');
    assert.equal((await call('prefs:observe', { cuts: [] })).code, 'INVALID_ARGS');

    assert.equal((await call('prefs:forget')).forgotten, 6);
  } finally { rm(dir); }
});

test('prefs:names junta preferências, aprendizado e projetos salvos (meta e origem)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const file = path.join(dir, 'v', 'a.mp4');
    makeVideo(file, 2);
    saveProject(ctx, file, { cuts: [{ start: 0, end: 1 }], meta: { game: 'Minecraft' }, origin: { type: 'vod', channel: 'Canal da Origem' } });
    await call('prefs:set', { scope: { type: 'game', name: 'Valorant' }, key: 'queue.parallel', value: 2 });
    const names = await call('prefs:names');
    assert.deepEqual(names.games, ['Minecraft', 'Valorant']);
    assert.deepEqual(names.channels, ['Canal da Origem']);
  } finally { rm(dir); }
});

// ---------- prefs:inspect ----------

test('inspect: arquivo inexistente ou pasta não derruba nada', async () => {
  const { dir, call } = setup();
  try {
    const r = await call('prefs:inspect', { path: path.join(dir, 'nao-existe.mp4'), origin: { channel: 'Fulano' } });
    assert.deepEqual([r.ok, r.exists, r.matches, r.compare, r.own], [true, false, [], null, null]);
    assert.deepEqual(r.scope, { game: '', channel: 'Fulano' });
    assert.equal((await call('prefs:inspect', { path: dir })).exists, false, 'pasta não é arquivo');
    assert.equal((await call('prefs:inspect', {})).code, 'INVALID_PATH');
  } finally { rm(dir); }
});

test('inspect: vídeo novo sem trabalho salvo não tem correspondência nem comparação', { skip: skipMedia }, async () => {
  const { dir, call } = setup();
  try {
    const file = path.join(dir, 'novo.mp4');
    makeVideo(file, 3);
    const r = await call('prefs:inspect', { path: file });
    assert.equal(r.exists, true);
    assert.equal(r.own, null);
    assert.deepEqual(r.matches, []);
    assert.equal(r.compare, null);
    assert.ok(Math.abs(r.file.duration - 3) < 0.5, `duração medida: ${r.file.duration}`);
    assert.ok(r.file.size > 0);
  } finally { rm(dir); }
});

test('inspect: FORTE por código de vídeo e FRACA por nome+tamanho+duração (cópia em outra pasta)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const original = path.join(dir, 'lives', 'live.mp4');
    makeVideo(original, 4);
    const origin = { type: 'vod', platform: 'youtube', videoId: 'abc123XYZ_1', url: 'https://www.youtube.com/watch?v=abc123XYZ_1', channel: 'Fulano', title: 'Minha live' };
    const saved = saveProject(ctx, original, { cuts: [{ start: 0, end: 2 }, { start: 2, end: 3 }], origin, meta: { game: 'Valorant', channel: 'Fulano' } });

    const copy = path.join(dir, 'backup', 'live.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);

    const strong = await call('prefs:inspect', { path: copy, origin });
    assert.equal(strong.matches.length, 1);
    assert.equal(strong.matches[0].level, 'strong');
    assert.equal(strong.matches[0].cutCount, 2);
    assert.equal(strong.matches[0].label, 'Minha live');
    assert.equal(strong.matches[0].project.id, saved.id);
    assert.equal(strong.matches[0].project.sourcePath, path.resolve(original));
    assert.deepEqual(strong.matchScope, { game: 'Valorant', channel: 'Fulano' });

    const weak = await call('prefs:inspect', { path: copy });
    assert.equal(weak.matches[0].level, 'weak');
    assert.ok(weak.matches[0].reasons.length >= 2);

    const renamed = path.join(dir, 'backup', 'outro nome.mp4');
    fs.copyFileSync(original, renamed);
    const weak2 = await call('prefs:inspect', { path: renamed });
    assert.equal(weak2.matches[0].level, 'weak', 'tamanho + duração, mesmo renomeado');

    // vídeo diferente (outra duração e tamanho, nome genérico): nenhuma correspondência
    const different = path.join(dir, 'backup', 'diferente.mp4');
    makeVideo(different, 6, '320x180');
    assert.deepEqual((await call('prefs:inspect', { path: different })).matches, []);
    // código de vídeo diferente exclui, mesmo sendo a cópia exata
    const other = await call('prefs:inspect', { path: copy, origin: { ...origin, videoId: 'OUTRO000000', url: 'https://www.youtube.com/watch?v=OUTRO000000' } });
    assert.deepEqual(other.matches, []);
  } finally { rm(dir); }
});

test('inspect: o mesmo caminho nunca se oferece como duplicata; projeto vazio com decisão não pergunta de novo', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const a = path.join(dir, 'a.mp4');
    const b = path.join(dir, 'b.mp4');
    makeVideo(a, 3);
    fs.copyFileSync(a, b);
    saveProject(ctx, a, { cuts: [{ start: 0, end: 1 }] });
    const self = await call('prefs:inspect', { path: a });
    assert.deepEqual(self.matches, []);
    assert.equal(self.own.cutCount, 1);
    assert.equal(self.compare, null, 'arquivo igual: nada mudou');

    // b ainda sem projeto: pergunta; depois de "Criar novo" (projeto vazio + decisão registrada) não pergunta mais
    assert.equal((await call('prefs:inspect', { path: b })).matches.length, 1);
    saveProject(ctx, b, { cuts: [] });
    assert.equal((await call('prefs:inspect', { path: b })).matches.length, 1, 'projeto vazio sem decisão: ainda pergunta');
    saveProject(ctx, b, { cuts: [], ext: { prefs: { match: { decision: 'new' } } } });
    const decided = await call('prefs:inspect', { path: b });
    assert.equal(decided.own.decided, true);
    assert.deepEqual(decided.matches, []);
    // com cortes próprios também não pergunta
    saveProject(ctx, b, { cuts: [{ start: 0, end: 1 }] });
    assert.deepEqual((await call('prefs:inspect', { path: b })).matches, []);
  } finally { rm(dir); }
});

test('inspect: fonte regravada mais curta → comparação com cortes fora do intervalo (nada é gravado)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const file = path.join(dir, 'live.mp4');
    makeVideo(file, 6);
    const saved = saveProject(ctx, file, { cuts: [{ start: 0, end: 2 }, { start: 3, end: 5.5 }] });
    const stored = fs.readFileSync(path.join(ctx.paths.projects, `${saved.id}.json`), 'utf8');

    makeVideo(file, 3); // regravado: mais curto
    const r = await call('prefs:inspect', { path: file });
    assert.ok(r.compare, 'mudança detectada');
    assert.equal(r.compare.direction, 'shorter');
    assert.deepEqual(r.compare.cuts.outside.map((c) => c.title), ['Corte 2']);
    assert.equal(r.compare.cuts.outside[0].kind, 'fora');
    assert.equal(r.compare.title, 'A fonte mudou desde a última análise');
    assert.match(r.compare.message, /live\.mp4/);
    assert.match(r.compare.message, /1 corte fica fora do novo intervalo/);
    assert.equal(r.compare.before.duration, saved.source.duration);
    assert.equal(fs.readFileSync(path.join(ctx.paths.projects, `${saved.id}.json`), 'utf8'), stored, 'inspect não grava nada no projeto');
  } finally { rm(dir); }
});

test('inspect: VOD que cresceu e chat salvo com mensagens a mais', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const file = path.join(dir, 'vod.mp4');
    const chatFile = path.join(dir, 'vod.chat.json');
    makeVideo(file, 3);
    fs.writeFileSync(chatFile, JSON.stringify({
      format: 'bf-chat-1', platform: 'twitch', videoId: '1',
      messages: [{ t: 1, user: 'a', text: 'oi' }, { t: 2, user: 'b', text: 'kkk' }, { t: 4, user: 'c', text: 'novo' }, { t: 5, user: 'd', text: 'novo 2' }]
    }));
    saveProject(ctx, file, { cuts: [{ start: 0, end: 2 }], chat: { path: chatFile, format: 'bf-chat-1', count: 2, platform: 'twitch' } });
    makeVideo(file, 6);
    const r = await call('prefs:inspect', { path: file });
    assert.equal(r.compare.direction, 'longer');
    assert.deepEqual(r.compare.chat, { recorded: 2, actual: 4, added: 2, afterOldEnd: 2 });
    assert.match(r.compare.message, /O chat salvo tem 2 mensagens a mais/);
    assert.match(r.compare.message, /O trecho novo/);
  } finally { rm(dir); }
});

test('inspect: projeto sem cortes não pede comparação (não há o que preservar)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const file = path.join(dir, 'v.mp4');
    makeVideo(file, 3);
    saveProject(ctx, file, { cuts: [] });
    makeVideo(file, 6);
    assert.equal((await call('prefs:inspect', { path: file })).compare, null);
  } finally { rm(dir); }
});

test('inspect sem ffprobe: não quebra, não compara duração e ainda avisa do tamanho/nome (fraca precisa de 2 sinais)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup({ tools: { ffprobe: null } });
  try {
    const a = path.join(dir, 'x', '2026-10-21 14-30-00.mp4');
    const b = path.join(dir, 'y', '2026-10-21 14-30-00.mp4');
    makeVideo(a, 3);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(a, b);
    saveProject(ctx, a, { cuts: [{ start: 0, end: 1 }] });
    const r = await call('prefs:inspect', { path: b });
    assert.equal(r.ok, true);
    assert.equal(r.file.duration, null);
    assert.match(r.file.probeError, /ffprobe/);
    assert.equal(r.matches[0].level, 'weak', 'nome + tamanho bastam');
    assert.equal(r.compare, null);
  } finally { rm(dir); }
});

test('inspect: o arquivo do projeto existente sumiu (mudou de pasta): ainda corresponde e avisa que não está mais lá', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const original = path.join(dir, 'lives', 'live.mp4');
    makeVideo(original, 3);
    const origin = { type: 'vod', platform: 'twitch', videoId: '777', channel: 'Fulano', title: 'Live movida' };
    saveProject(ctx, original, { cuts: [{ start: 0, end: 1 }], origin });
    const moved = path.join(dir, 'nova pasta', 'live.mp4');
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(original, moved);
    const r = await call('prefs:inspect', { path: moved, origin });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].level, 'strong');
    assert.equal(r.matches[0].project.sourceExists, false);
  } finally { rm(dir); }
});

// ---------- atualização de fonte em arquivo de OUTRO caminho (VOD baixado de novo) ----------

test('inspect: a live parecida em outro arquivo traz a comparação (mais curto: cortes fora do intervalo); cópia idêntica não traz nada', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup();
  try {
    const original = path.join(dir, 'lives', 'live-a.mp4');
    makeVideo(original, 6);
    const origin = { type: 'vod', platform: 'youtube', videoId: 'abc123XYZ_1', url: 'https://www.youtube.com/watch?v=abc123XYZ_1', channel: 'Fulano', title: 'Minha live' };
    const saved = saveProject(ctx, original, { cuts: [{ start: 0, end: 2 }, { start: 3, end: 5.5 }], origin, meta: { game: 'Valorant', channel: 'Fulano' } });
    const projectFile = path.join(ctx.paths.projects, `${saved.id}.json`);
    const stored = fs.readFileSync(projectFile, 'utf8');

    // o mesmo VOD baixado de novo, em outro nome, mais curto
    const shorter = path.join(dir, 'downloads', 'live-a (2).mp4');
    makeVideo(shorter, 3);
    const r = await call('prefs:inspect', { path: shorter, origin });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].level, 'strong');
    const compare = r.matches[0].compare;
    assert.ok(compare, 'a comparação do arquivo novo com o projeto parecido');
    assert.equal(compare.direction, 'shorter');
    assert.equal(compare.changed, true);
    assert.deepEqual(compare.cuts.outside.map((c) => [c.title, c.kind]), [['Corte 2', 'fora']]);
    assert.ok(compare.duration.before > compare.duration.after + 2);
    assert.ok(compare.lines.some((line) => /O vídeo ficou mais curto/.test(line)));
    assert.ok(compare.lines.some((line) => /1 corte fica fora do novo intervalo/.test(line)));
    assert.equal(r.compare, null, 'o campo de cima continua só para o mesmo caminho');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), stored, 'inspect não grava nada');

    // mais longo: o trecho novo não foi analisado
    const longer = path.join(dir, 'downloads', 'live-a (3).mp4');
    makeVideo(longer, 10);
    const grown = (await call('prefs:inspect', { path: longer, origin })).matches[0].compare;
    assert.equal(grown.direction, 'longer');
    assert.deepEqual(grown.cuts.outside, []);
    assert.ok(grown.lines.some((line) => /O trecho novo/.test(line)));

    // cópia idêntica: nada mudou, nada a mostrar
    const copy = path.join(dir, 'backup', 'live-a.mp4');
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(original, copy);
    const same = await call('prefs:inspect', { path: copy, origin });
    assert.equal(same.matches[0].level, 'strong');
    assert.equal(same.matches[0].compare, null);
  } finally { rm(dir); }
});

test('inspect sem ffprobe: a correspondência não traz comparação (não há duração para comparar)', { skip: skipMedia }, async () => {
  const { dir, ctx, call } = setup({ tools: { ffprobe: null } });
  try {
    const a = path.join(dir, 'x', '2026-10-21 14-30-00.mp4');
    const b = path.join(dir, 'y', '2026-10-21 14-30-00.mp4');
    makeVideo(a, 4);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.copyFileSync(a, b);
    saveProject(ctx, a, { cuts: [{ start: 0, end: 1 }] });
    const r = await call('prefs:inspect', { path: b });
    assert.equal(r.matches[0].level, 'weak');
    assert.equal(r.matches[0].compare, null);
  } finally { rm(dir); }
});

// ---------- textos e validação pelo IPC ----------

test('o histórico mostra o NOME do perfil de exportação (como no seletor), não o id técnico', async () => {
  const { dir, call } = setup();
  try {
    const set = await call('prefs:set', { scope: { type: 'general' }, key: 'export.profileId', value: 'vertical-1440-h264' });
    assert.equal(set.ok, true);
    assert.equal(set.entry.label, 'Definiu "Perfil de exportação" = Vertical 9:16 · 1440p (2K) · H.264 (geral)');
    const again = await call('prefs:set', { scope: { type: 'general' }, key: 'export.profileId', value: 'vertical-2160-h265' });
    assert.match(again.entry.label, /: Vertical 9:16 · 1440p \(2K\) · H\.264 → Vertical 9:16 · 2160p \(4K\) · H\.265$/);
    const hist = await call('prefs:history', { limit: 5 });
    assert.ok(hist.entries.every((e) => !/vertical-\d+-h26\d/.test(e.label)), 'nenhum id técnico nos textos');
    const unknown = await call('prefs:set', { scope: { type: 'general' }, key: 'export.profileId', value: 'user-123' });
    assert.match(unknown.entry.label, /→ user-123$/, 'perfil do usuário apagado ou desconhecido: aparece o id');
  } finally { rm(dir); }
});

test('prefs:set recusa número em texto hexadecimal ou científico e valores fora da faixa da análise', async () => {
  const { dir, call } = setup();
  try {
    for (const value of [' 0x1 ', '1e-1', 'Infinity']) {
      const res = await call('prefs:set', { scope: { type: 'general' }, key: 'analysis.minRelevance', value });
      assert.equal(res.ok, false, value);
      assert.equal(res.code, 'INVALID_VALUE');
    }
    assert.equal((await call('prefs:resolve', {})).values['analysis.minRelevance'], 0.5, 'nada foi gravado');
    const tooLong = await call('prefs:set', { scope: { type: 'general' }, key: 'analysis.maxDurationSec', value: 300 });
    assert.equal(tooLong.code, 'INVALID_VALUE');
    assert.match(tooLong.message, /entre 5 e 180 segundos/);
    assert.equal((await call('prefs:set', { scope: { type: 'general' }, key: 'analysis.maxDurationSec', value: '120' })).ok, true);
    const schema = await call('prefs:schema');
    const max = schema.keys.find((k) => k.key === 'analysis.maxDurationSec');
    assert.deepEqual([max.min, max.max], [5, 180], 'a tela monta o campo com a mesma faixa');
  } finally { rm(dir); }
});

test('arquivos de estado ilegíveis viram AVISO na prefs:schema (cópia preservada) e o recurso segue funcionando', async () => {
  const { dir, call } = setup({ beforeCreate: (d) => { fs.writeFileSync(path.join(d, 'preferences.json'), 'quebrado{'); fs.writeFileSync(path.join(d, 'learned.json'), '[1,2'); } });
  try {
    const s = await call('prefs:schema');
    assert.equal(s.ok, true);
    assert.deepEqual(s.notices.map((n) => n.code).sort(), ['LEARNED_RECOVERED', 'PREFS_RECOVERED']);
    assert.ok(s.notices.every((n) => /guardado em/.test(n.message)));
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt')).length, 2);
    assert.equal((await call('prefs:set', { scope: { type: 'general' }, key: 'queue.parallel', value: 2 })).ok, true);
    assert.deepEqual((await call('prefs:schema')).notices.length, 2, 'o aviso persiste na sessão para a tela mostrar');
  } finally { rm(dir); }
});
