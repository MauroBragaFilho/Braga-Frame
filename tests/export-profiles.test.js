'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const profiles = require('../src/core/export/profiles');
const { applyNameTemplate, sanitizeFileName } = require('../src/core/export/naming');
const { buildJobs } = require('../src/core/export/jobs');
const { legacyProfile, legacyWarnings } = require('../src/core/export/legacy');
const fx = require('./export-fixtures');

const { ProfileStore, listBuiltinProfiles, validateProfile } = profiles;

function withStore(fn) {
  const dir = fx.tmpDir('bf-export-prof-');
  try { return fn(new ProfileStore(path.join(dir, 'profiles.json')), dir); } finally { fx.cleanup(dir); }
}

const valid = { name: 'Meu vertical', width: 1080, height: 1350, codec: 'h264', bitrateKbps: 8000 };

test('perfis embutidos: 9:16 e 16:9 em 1080/1440/2160 x H.264/H.265, padrão de 10 Mbps no vertical', () => {
  const list = listBuiltinProfiles();
  assert.equal(list.length, 12);
  const byId = Object.fromEntries(list.map((p) => [p.id, p]));
  for (const [id, w, h] of [
    ['vertical-1080-h264', 1080, 1920], ['vertical-1440-h264', 1440, 2560], ['vertical-2160-h264', 2160, 3840],
    ['vertical-1080-h265', 1080, 1920], ['vertical-1440-h265', 1440, 2560], ['vertical-2160-h265', 2160, 3840],
    ['horizontal-1080-h264', 1920, 1080], ['horizontal-1440-h264', 2560, 1440], ['horizontal-2160-h264', 3840, 2160],
    ['horizontal-1080-h265', 1920, 1080], ['horizontal-1440-h265', 2560, 1440], ['horizontal-2160-h265', 3840, 2160]
  ]) {
    assert.ok(byId[id], id);
    assert.deepEqual([byId[id].width, byId[id].height, byId[id].container, byId[id].encoder, byId[id].fps], [w, h, 'mp4', 'auto', 'source'], id);
    assert.equal(byId[id].kind, id.startsWith('vertical') ? 'vertical' : 'horizontal');
    assert.equal(byId[id].codec, id.endsWith('h265') ? 'h265' : 'h264');
    assert.deepEqual(validateProfile(byId[id]).errors, [], `${id} é válido`);
  }
  for (const p of list.filter((x) => x.kind === 'vertical')) assert.equal(p.bitrateKbps, 10000, `${p.id}: 10 Mbps`);
  assert.equal(profiles.DEFAULT_PROFILE_ID, 'vertical-1080-h264');
  assert.equal(byId['vertical-2160-h264'].resolutionLabel, '2160p (4K)');
  assert.equal(byId['vertical-1440-h264'].resolutionLabel, '1440p (2K)');
  // cópias independentes: alterar o retorno não estraga os embutidos
  list[0].bitrateKbps = 1;
  assert.equal(listBuiltinProfiles()[0].bitrateKbps, 10000);
});

test('validateProfile: largura/altura pares de 2 a 7680, bitrate de 500 a 150000 kbps', () => {
  assert.deepEqual(validateProfile(valid).errors, []);
  for (const bad of [
    { ...valid, width: 1081 }, { ...valid, height: 1 }, { ...valid, width: 7682 }, { ...valid, height: 'abc' }, { ...valid, width: 1080.5 },
    { ...valid, bitrateKbps: 499 }, { ...valid, bitrateKbps: 150001 }, { ...valid, bitrateKbps: 'x' },
    { ...valid, codec: 'vp9' }, { ...valid, encoder: 'amf' }, { ...valid, fps: 0 }, { ...valid, container: 'mkv' }
  ]) {
    assert.ok(validateProfile(bad).errors.length >= 1, JSON.stringify(bad));
  }
  for (const ok of [{ ...valid, width: 2, height: 2 }, { ...valid, width: 7680, height: 7680 }, { ...valid, bitrateKbps: 500 }, { ...valid, bitrateKbps: 150000 }]) {
    assert.deepEqual(validateProfile(ok).errors, [], JSON.stringify(ok));
  }
  const filled = validateProfile({ width: 1080, height: 1920 }).profile;
  assert.deepEqual([filled.codec, filled.bitrateKbps, filled.encoder, filled.fps, filled.container], ['h264', 10000, 'auto', 'source', 'mp4']);
  assert.ok(validateProfile(null).errors.length > 0);
  assert.match(validateProfile({ ...valid, width: 1081 }).errors[0], /precisa ser par/);
});

test('ProfileStore: cria, lista, atualiza, exclui e persiste em profiles.json (valem para qualquer projeto)', () => withStore((store, dir) => {
  assert.deepEqual(store.list(), []);
  const a = store.save(valid);
  assert.match(a.id, /^user-meu-vertical-/);
  assert.equal(a.kind, 'custom');
  assert.equal(a.resolutionLabel, '1080×1350');
  const b = store.save({ ...valid, name: 'Outro', width: 720, height: 1280, codec: 'h265', encoder: 'nvenc', fps: 30 });
  // outra instância (outro projeto, outra sessão) enxerga os mesmos perfis
  const again = new ProfileStore(path.join(dir, 'profiles.json'));
  assert.deepEqual(again.list().map((p) => p.name), ['Meu vertical', 'Outro']);
  assert.deepEqual([again.get(b.id).codec, again.get(b.id).encoder, again.get(b.id).fps], ['h265', 'nvenc', 30]);

  const updated = store.save({ ...a, name: 'Meu vertical v2', bitrateKbps: 12000 });
  assert.equal(updated.id, a.id);
  assert.deepEqual(store.list().map((p) => [p.name, p.bitrateKbps]), [['Meu vertical v2', 12000], ['Outro', 8000]]);
  assert.equal(store.remove(b.id).id, b.id);
  assert.deepEqual(store.list().map((p) => p.id), [a.id]);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.profiles.length, 1);
  assert.deepEqual(fs.readdirSync(dir), ['profiles.json'], 'gravação atômica: nenhum temporário sobra');
}));

test('ProfileStore: embutidos não são editados nem excluídos; nomes e valores inválidos são recusados', () => withStore((store) => {
  assert.throws(() => store.save({ ...valid, id: 'vertical-1080-h264' }), { code: 'PROFILE_BUILTIN' });
  assert.throws(() => store.remove('vertical-1080-h264'), { code: 'PROFILE_BUILTIN' });
  assert.throws(() => store.remove('user-nao-existe'), { code: 'PROFILE_NOT_FOUND' });
  assert.throws(() => store.save({ ...valid, name: '  ' }), { code: 'INVALID_PROFILE' });
  assert.throws(() => store.save({ ...valid, name: 'x'.repeat(61) }), { code: 'INVALID_PROFILE' });
  assert.throws(() => store.save({ ...valid, width: 1081 }), (e) => e.code === 'INVALID_PROFILE' && /par/.test(e.message));
  assert.throws(() => store.save({ ...valid, bitrateKbps: 100 }), { code: 'INVALID_PROFILE' });
  assert.throws(() => store.save({ ...valid, id: 'qualquer-coisa' }), { code: 'INVALID_PROFILE' });
  store.save(valid);
  assert.throws(() => store.save({ ...valid, bitrateKbps: 9000 }), { code: 'PROFILE_NAME_EXISTS' });
  assert.throws(() => store.save({ ...valid, name: 'MEU VERTICAL' }), { code: 'PROFILE_NAME_EXISTS' });
  assert.equal(store.list().length, 1);
}));

test('ProfileStore: arquivo corrompido é preservado ao lado e a lista recomeça vazia; entradas inválidas são ignoradas', () => withStore((store, dir) => {
  const file = path.join(dir, 'profiles.json');
  fs.writeFileSync(file, '{ não é json');
  assert.deepEqual(store.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('profiles.json.corrupt-')), 'cópia do arquivo ruim guardada');
  store.save(valid);
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [
    { id: 'user-ok', name: 'Bom', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000 },
    { id: 'user-ruim', name: 'Ruim', width: 1081, height: 1920 },
    { id: 'vertical-1080-h264', name: 'Embutido falso', width: 1080, height: 1920 },
    { id: 'user-ok', name: 'Repetido', width: 1080, height: 1920 },
    'lixo'
  ] }));
  assert.deepEqual(store.list().map((p) => p.id), ['user-ok']);
}));

test('allProfiles junta embutidos e do usuário; findProfile acha pelos dois', () => withStore((store) => {
  const mine = store.save(valid);
  const all = profiles.allProfiles(store);
  assert.equal(all.length, 13);
  assert.equal(all[all.length - 1].id, mine.id);
  assert.equal(profiles.findProfile('vertical-1440-h265', store).height, 2560);
  assert.equal(profiles.findProfile(mine.id, store).name, 'Meu vertical');
  assert.equal(profiles.findProfile('nao-existe', store), null);
}));

test('perfil guarda enquadramento inicial (normalizado) e ele sobrevive ao arquivo', () => withStore((store, dir) => {
  const saved = store.save({ ...valid, framing: { mode: 'stack', zoom: 9, stack: { webcamHeightPct: 40 } } });
  assert.deepEqual(saved.framing, { mode: 'stack', zoom: 3, stack: { webcamHeightPct: 40 } });
  assert.equal(new ProfileStore(path.join(dir, 'profiles.json')).get(saved.id).framing.mode, 'stack');
}));

// ---------- nomes ----------

test('nomes: modelo, caracteres proibidos, nomes reservados do Windows e limite de tamanho', () => {
  assert.equal(applyNameTemplate(undefined, { fonte: 'live 12', n: '03', titulo: 'Clutch final' }), 'live 12 - corte 03 - Clutch final');
  assert.equal(applyNameTemplate('{titulo} [{n}] {perfil}', { fonte: 'x', n: '1', titulo: 'a:b/c?', perfil: 'P' }), 'a_b_c_ [1] P');
  assert.equal(applyNameTemplate('{fonte}-{desconhecida}', { fonte: 'v' }), 'v-{desconhecida}');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeFileName('  ...  '), 'corte');
  assert.equal(sanitizeFileName('nome com ponto final...'), 'nome com ponto final');
  assert.equal(sanitizeFileName('a\u0001b\tc'), 'a b c');
  assert.ok(sanitizeFileName('x'.repeat(500)).length <= 120);
  assert.equal(sanitizeFileName('Ação & emoção'), 'Ação & emoção');
});

// ---------- Jobs ----------

test('buildJobs: Jobs do contrato 3.3 com nome pelo modelo, enquadramento resolvido e snapshot do corte', () => {
  const project = {
    id: 'p1', source: { path: 'D:\\Lives\\gameplay 01.mp4', duration: 100, width: 1920, height: 1080 },
    cuts: [
      { id: 'c2', title: 'Segundo', start: 40, end: 50, status: 'approved', framing: { mode: 'blur' } },
      { id: 'c1', title: 'Primeiro: "x"', start: 10, end: 20, status: 'approved' },
      { id: 'c3', title: 'Rejeitado', start: 60, end: 70, status: 'rejected' }
    ]
  };
  const profile = listBuiltinProfiles()[0];
  const { jobs, missing, duplicates } = buildJobs({
    project, info: { width: 1920, height: 1080, fps: 30, duration: 100, hasAudio: true }, cutIds: ['c1', 'c2', 'nao-existe'], profile,
    framing: { zoom: 1.5 }, outputDir: 'D:\\Lives\\Cortes', nameTemplate: '{fonte} - corte {n} - {titulo}'
  });
  assert.deepEqual(missing, ['nao-existe']);
  assert.deepEqual(duplicates, []);
  assert.deepEqual(jobs.map((j) => j.baseName), ['gameplay 01 - corte 01 - Primeiro_ _x_', 'gameplay 01 - corte 02 - Segundo']);
  const [j1, j2] = jobs;
  assert.equal(j1.projectId, 'p1');
  assert.equal(j1.projectTitle, 'gameplay 01');
  assert.equal(j1.sourcePath, 'D:\\Lives\\gameplay 01.mp4');
  assert.deepEqual(j1.sourceInfo, { width: 1920, height: 1080, fps: 30, duration: 100, hasAudio: true });
  assert.equal(j1.onConflict, 'ask');
  assert.match(j1.id, /^job-/);
  assert.notEqual(j1.id, j2.id);
  assert.equal(j1.cut.id, 'c1');
  assert.equal(j1.cut.framing, null, 'o corte não foi tocado');
  assert.equal(j1.framing.mode, 'center');
  assert.equal(j1.framing.zoom, 1.5, 'padrão do projeto aplicado');
  assert.equal(j2.framing.mode, 'blur', 'ajuste do corte vence');
  assert.equal(j2.framing.zoom, 1.5);
  assert.equal(j2.cut.framing.mode, 'blur');
  assert.deepEqual(j1.profile, profile);
  assert.notEqual(j1.profile, profile, 'cópia do perfil');
  assert.ok(Date.parse(j1.createdAt) > 0);
  // o projeto original não foi alterado
  assert.equal(project.cuts[1].framing, undefined);
});

test('buildJobs: avisa nomes repetidos do mesmo lote e numera com zeros', () => {
  const cuts = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: 'Igual', start: i * 10, end: i * 10 + 5, status: 'approved' }));
  const project = { id: 'p', source: { path: '/v/live.mkv', duration: 200, width: 1280, height: 720 }, cuts };
  const profile = listBuiltinProfiles()[0];
  const same = buildJobs({ project, cutIds: ['c0', 'c1'], profile, outputDir: '/saida', nameTemplate: '{titulo}' });
  assert.equal(same.duplicates.length, 2);
  const numbered = buildJobs({ project, cutIds: ['c0', 'c11'], profile, outputDir: '/saida' });
  assert.deepEqual(numbered.jobs.map((j) => j.baseName), ['live - corte 01 - Igual', 'live - corte 12 - Igual']);
  assert.deepEqual(numbered.duplicates, []);
});

// ---------- compatibilidade com a exportação mínima da base ----------

test('legado: perfil { resolution, codec } vira perfil 9:16 do contrato e mantém os avisos antigos', () => {
  const ok = legacyProfile({ resolution: 1440, codec: 'h265', bitrateKbps: 20000 });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([ok.profile.width, ok.profile.height, ok.profile.codec, ok.profile.bitrateKbps], [1440, 2560, 'h265', 20000]);
  assert.equal(legacyProfile({ resolution: 720 }).errors.length, 1);
  assert.equal(legacyWarnings(legacyProfile({ resolution: 2160, codec: 'h265' }).profile, { width: 1920, height: 1080 }).length, 2);
  assert.deepEqual(legacyWarnings(legacyProfile({}).profile, { width: 3840, height: 2160 }), []);
});

// ---------- profiles.json de uma versão mais nova ou com entradas desconhecidas: nada se perde ao regravar ----------

test('ProfileStore: entradas que este app não entende (codec novo, versão maior) continuam no arquivo depois de salvar e de excluir', () => withStore((store, dir) => {
  const file = path.join(dir, 'profiles.json');
  const future = { id: 'user-x', name: 'X', width: 1080, height: 1920, codec: 'av1', bitrateKbps: 8000 };
  const good = { id: 'user-bom', name: 'Bom', width: 1080, height: 1920, codec: 'h264', bitrateKbps: 10000 };
  const original = { version: 2, syncedAt: '2026-01-01', profiles: [future, good, 'lixo', { id: 'user-ruim', name: 'Ruim', width: 1081, height: 1920 }] };
  fs.writeFileSync(file, JSON.stringify(original));

  assert.deepEqual(store.list().map((p) => p.id), ['user-bom'], 'a lista só mostra o que é válido');
  const created = store.save(valid);
  const afterSave = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(afterSave.version, 2, 'a versão do arquivo não foi rebaixada');
  assert.equal(afterSave.syncedAt, '2026-01-01', 'outros campos do arquivo foram mantidos');
  assert.deepEqual(afterSave.profiles.find((p) => p.id === 'user-x'), future, 'a entrada desconhecida continua lá, igualzinha');
  assert.ok(afterSave.profiles.some((p) => p.id === 'user-ruim'), 'a entrada inválida também (o usuário pode corrigir)');
  assert.deepEqual(store.list().map((p) => p.id), ['user-bom', created.id]);
  // cópia de segurança do arquivo da versão mais nova (uma vez)
  const bak = path.join(dir, 'profiles.json.v2.bak');
  assert.ok(fs.existsSync(bak), 'cópia de segurança');
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, 'utf8')), original, 'a cópia é do arquivo ORIGINAL');

  store.remove(created.id);
  const afterRemove = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(afterRemove.profiles.some((p) => p.id === 'user-x'));
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, 'utf8')), original, 'a cópia não é sobrescrita');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['profiles.json', 'profiles.json.v2.bak'], 'nenhum temporário sobra');
}));

test('ProfileStore: arquivo na versão atual sem entradas estranhas é regravado como antes (sem cópia de segurança)', () => withStore((store, dir) => {
  store.save(valid);
  assert.deepEqual(fs.readdirSync(dir), ['profiles.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'profiles.json'), 'utf8')).version, 1);
}));

// ---------- sourceInfo do Job: faixas de áudio e HDR só aparecem quando valem um aviso ----------

test('buildJobs: sourceInfo ganha audioTracks (2 ou mais faixas) e hdr (PQ/HLG) só quando valem aviso; o Job comum continua igual ao contrato', () => {
  const project = { id: 'p', source: { path: '/v/live.mkv', duration: 100, width: 1920, height: 1080 }, cuts: [{ id: 'c', title: 'x', start: 1, end: 5, status: 'approved' }] };
  const profile = listBuiltinProfiles()[0];
  const infoOf = (info) => buildJobs({ project, info, cutIds: ['c'], profile, outputDir: '/saida' }).jobs[0].sourceInfo;
  const base = { width: 1920, height: 1080, fps: 30, duration: 100, hasAudio: true };
  assert.deepEqual(infoOf({ ...base, audioTracks: 1, colorTransfer: 'bt709' }), base, 'uma faixa e SDR: nada extra');
  assert.deepEqual(infoOf(base), base);
  assert.deepEqual(infoOf({ ...base, audioTracks: 3 }), { ...base, audioTracks: 3 });
  assert.deepEqual(infoOf({ ...base, colorTransfer: 'smpte2084' }), { ...base, hdr: true });
  assert.deepEqual(infoOf({ ...base, colorTransfer: 'arib-std-b67', audioTracks: 2 }), { ...base, audioTracks: 2, hdr: true });
  assert.deepEqual(infoOf({ ...base, colorTransfer: null, audioTracks: 0 }), base);
});
