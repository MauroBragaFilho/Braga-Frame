'use strict';

/**
 * Preferências: escopos (geral/jogo/canal), prioridade provisória canal > jogo > geral, explicação da origem,
 * validação, persistência atômica e histórico com reverter. Tudo contra arquivos reais em pasta temporária.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Preferences, PrefsError } = require('../src/core/preferences');
const { DEFS } = require('../src/core/preferences/keys');
const { normName, scopeKey } = require('../src/core/preferences/scope');
const { mkTmp, rm, clock } = require('./prefs-helpers');

const G = { type: 'general' };
const game = (name) => ({ type: 'game', name });
const channel = (name) => ({ type: 'channel', name });

function withPrefs(fn, opts = {}) {
  const dir = mkTmp('prefs-store');
  try { return fn(new Preferences({ dir, now: clock(), ...opts }), dir); } finally { rm(dir); }
}

test('sem nada gravado vale o padrão do contrato (3.5) e a origem diz "padrão"', () => {
  withPrefs((p) => {
    const { values, details } = p.resolve({});
    assert.equal(values['export.profileId'], 'vertical-1080-h264');
    assert.equal(values['export.framing.mode'], 'center');
    assert.equal(values['analysis.minRelevance'], 0.5);
    assert.equal(values['analysis.minDurationSec'], 15);
    assert.equal(values['analysis.maxDurationSec'], 60);
    assert.equal(values['analysis.padBeforeSec'], 3);
    assert.equal(values['analysis.padAfterSec'], 2);
    assert.equal(values['review.defaultSort'], 'chrono');
    assert.equal(values['queue.parallel'], 1);
    assert.equal(values['subtitles.enabled'], false);
    assert.equal(values['subtitles.mode'], 'burn');
    assert.ok(Array.isArray(values['review.categories']));
    for (const def of DEFS) assert.deepEqual(details[def.key], { scope: 'default', source: 'default', value: def.default, label: 'padrão' }, def.key);
  });
});

test('prioridade: canal vence jogo, jogo vence geral; explain diz de onde veio', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.minRelevance', 0.3);
    p.set(game('Valorant'), 'analysis.minRelevance', 0.6);
    p.set(channel('Fulano'), 'analysis.minRelevance', 0.8);

    assert.equal(p.get('analysis.minRelevance', {}), 0.3, 'só geral');
    assert.equal(p.get('analysis.minRelevance', { game: 'Valorant' }), 0.6, 'jogo > geral');
    assert.equal(p.get('analysis.minRelevance', { channel: 'Fulano' }), 0.8, 'canal > geral');
    assert.equal(p.get('analysis.minRelevance', { game: 'Valorant', channel: 'Fulano' }), 0.8, 'canal > jogo');
    assert.equal(p.get('analysis.minRelevance', { game: 'Valorant', channel: 'Outro' }), 0.6, 'canal sem valor cai no jogo');
    assert.equal(p.get('analysis.minRelevance', { game: 'Outro', channel: 'Outro' }), 0.3, 'nada específico cai no geral');

    assert.deepEqual(p.explain('analysis.minRelevance', { game: 'Valorant', channel: 'Fulano' }), {
      scope: 'channel', source: 'explicit', value: 0.8, scopeName: 'Fulano', label: 'canal Fulano'
    });
    assert.deepEqual(p.explain('analysis.minRelevance', { game: 'Valorant' }), {
      scope: 'game', source: 'explicit', value: 0.6, scopeName: 'Valorant', label: 'jogo Valorant'
    });
    assert.deepEqual(p.explain('analysis.minRelevance', {}), { scope: 'general', source: 'explicit', value: 0.3, scopeName: '', label: 'geral' });
    assert.deepEqual(p.explain('queue.parallel', { game: 'Valorant' }), { scope: 'default', source: 'default', value: 1, label: 'padrão' });
  });
});

test('cada chave tem a sua prioridade: o canal só vence nas chaves que definiu', () => {
  withPrefs((p) => {
    p.set(G, 'export.framing.mode', 'blur');
    p.set(game('Valorant'), 'analysis.padBeforeSec', 5);
    p.set(channel('Fulano'), 'analysis.padAfterSec', 4);
    const r = p.resolve({ game: 'Valorant', channel: 'Fulano' });
    assert.equal(r.values['export.framing.mode'], 'blur');
    assert.equal(r.details['export.framing.mode'].scope, 'general');
    assert.equal(r.values['analysis.padBeforeSec'], 5);
    assert.equal(r.details['analysis.padBeforeSec'].scope, 'game');
    assert.equal(r.values['analysis.padAfterSec'], 4);
    assert.equal(r.details['analysis.padAfterSec'].scope, 'channel');
  });
});

test('nomes de jogo/canal ignoram acento, caixa e espaços repetidos', () => {
  withPrefs((p) => {
    p.set(game('Counter-Strike  2'), 'review.defaultSort', 'relevance');
    assert.equal(p.get('review.defaultSort', { game: 'counter-strike 2' }), 'relevance');
    assert.equal(p.get('review.defaultSort', { game: ' COUNTER-STRIKE 2 ' }), 'relevance');
    p.set(channel('Canal do João'), 'queue.parallel', 2);
    assert.equal(p.get('queue.parallel', { channel: 'canal do joao' }), 2);
    assert.equal(normName('  Valórant  Ranked '), 'valorant ranked');
    assert.equal(p.names().games.length, 1, 'o mesmo jogo não duplica');
  });
});

test('nomes especiais do JavaScript não quebram nem poluem o protótipo', () => {
  withPrefs((p, dir) => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      p.set(game(name), 'queue.parallel', 3);
      assert.equal(p.get('queue.parallel', { game: name }), 3, name);
    }
    assert.equal({}.queue, undefined);
    assert.equal(Object.prototype.parallel, undefined);
    const again = new Preferences({ dir });
    assert.equal(again.get('queue.parallel', { game: '__proto__' }), 3);
    assert.notEqual(scopeKey('__proto__'), '__proto__');
  });
});

test('set devolve changed/entry; repetir o mesmo valor não muda nem registra histórico', () => {
  withPrefs((p) => {
    const first = p.set(G, 'queue.parallel', 2);
    assert.equal(first.changed, true);
    assert.match(first.entry.label, /Definiu "Exportações em paralelo" = 2 \(geral\)/);
    assert.equal(p.set(G, 'queue.parallel', 2).changed, false);
    assert.equal(p.history().length, 1);
    const second = p.set(G, 'queue.parallel', 3);
    assert.match(second.entry.label, /Alterou "Exportações em paralelo" \(geral\): 2 → 3/);
  });
});

test('unset remove só o valor do escopo e volta a herdar', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.padBeforeSec', 4);
    p.set(game('Valorant'), 'analysis.padBeforeSec', 8);
    assert.equal(p.get('analysis.padBeforeSec', { game: 'Valorant' }), 8);
    assert.equal(p.unset(game('Valorant'), 'analysis.padBeforeSec').changed, true);
    assert.equal(p.get('analysis.padBeforeSec', { game: 'Valorant' }), 4, 'herda do geral');
    assert.equal(p.unset(game('Valorant'), 'analysis.padBeforeSec').changed, false, 'já estava sem valor');
    assert.deepEqual(p.names().games, [], 'escopo vazio some da lista de nomes');
    p.unset(G, 'analysis.padBeforeSec');
    assert.equal(p.get('analysis.padBeforeSec', {}), 3, 'padrão');
  });
});

test('validação: chave desconhecida, valores fora do limite, tipos e escopo inválidos', () => {
  withPrefs((p) => {
    const code = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof PrefsError, err.message); return err.code; } return null; };
    assert.equal(code(() => p.set(G, 'nao.existe', 1)), 'UNKNOWN_KEY');
    assert.equal(code(() => p.set(G, 'analysis.minRelevance', 1.5)), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'analysis.minRelevance', 'abc')), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'analysis.padAfterSec', -1)), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'queue.parallel', 9)), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'queue.parallel', 1.5)), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'review.defaultSort', 'aleatorio')), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'subtitles.enabled', 'sim')), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'export.profileId', '../x')), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'review.categories', [])), 'INVALID_VALUE');
    assert.equal(code(() => p.set(G, 'subtitles.style', 'x')), 'INVALID_VALUE');
    assert.equal(code(() => p.set({ type: 'game', name: '   ' }, 'queue.parallel', 2)), 'INVALID_SCOPE');
    assert.equal(code(() => p.set({ type: 'planeta', name: 'x' }, 'queue.parallel', 2)), 'INVALID_SCOPE');
    assert.equal(p.history().length, 0, 'nenhum erro registra histórico');
    assert.equal(fs.existsSync(p.file), false, 'nem grava arquivo');
  });
});

test('normaliza valores aceitos: lista por vírgula, números em texto, percentual arredondado', () => {
  withPrefs((p) => {
    p.set(G, 'review.categories', ' Hype, clutch ,HYPE, , Fail ');
    assert.deepEqual(p.get('review.categories', {}), ['Hype', 'clutch', 'Fail']);
    p.set(G, 'analysis.padBeforeSec', '4,5');
    assert.equal(p.get('analysis.padBeforeSec', {}), 4.5);
    p.set(G, 'analysis.minRelevance', 0.333);
    assert.equal(p.get('analysis.minRelevance', {}), 0.33);
    p.set(G, 'subtitles.style', { fontSize: 42, color: '#fff' });
    assert.deepEqual(p.get('subtitles.style', {}), { fontSize: 42, color: '#fff' });
  });
});

test('duração mínima não pode passar da máxima em vigor (e vice-versa), com mensagem que diz o que fazer', () => {
  withPrefs((p) => {
    assert.throws(() => p.set(G, 'analysis.minDurationSec', 90), (err) => err.code === 'INVALID_VALUE' && /Aumente a máxima antes/.test(err.message));
    p.set(G, 'analysis.maxDurationSec', 120);
    p.set(G, 'analysis.minDurationSec', 90);
    assert.throws(() => p.set(G, 'analysis.maxDurationSec', 30), (err) => /Diminua a mínima antes/.test(err.message));
    assert.equal(p.get('analysis.minDurationSec', {}), 90);
  });
});

test('conflito vindo de escopos diferentes vira AVISO na resolução, não erro', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.maxDurationSec', 20);
    p.set(channel('Fulano'), 'analysis.minDurationSec', 30);
    const r = p.resolve({ channel: 'Fulano' });
    assert.equal(r.values['analysis.minDurationSec'], 30);
    assert.equal(r.values['analysis.maxDurationSec'], 20);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0].message, /mínima .* maior que a máxima/);
  });
});

test('list devolve o que o escopo definiu e o que herda', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.padBeforeSec', 4);
    p.set(game('Valorant'), 'analysis.padAfterSec', 6);
    const l = p.list(game('Valorant'));
    assert.deepEqual(l.values, { 'analysis.padAfterSec': 6 });
    assert.equal(l.inherited['analysis.padBeforeSec'].value, 4);
    assert.equal(l.inherited['analysis.padBeforeSec'].scope, 'general');
    assert.equal(l.inherited['analysis.padAfterSec'].scope, 'game');
    assert.deepEqual(p.list(G).values, { 'analysis.padBeforeSec': 4 });
  });
});

// ---------- persistência ----------

test('persiste em preferences.json (JSON válido, sem temporários) e outra instância lê o mesmo', () => {
  withPrefs((p, dir) => {
    p.set(G, 'queue.parallel', 2);
    p.set(game('Valorant'), 'review.defaultSort', 'relevance');
    p.set(channel('Fulano'), 'export.framing.mode', 'stack');
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.general.values['queue.parallel'], 2);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'nenhum temporário sobra');
    const again = new Preferences({ dir });
    assert.equal(again.get('queue.parallel', {}), 2);
    assert.equal(again.get('review.defaultSort', { game: 'valorant' }), 'relevance');
    assert.equal(again.get('export.framing.mode', { channel: 'FULANO' }), 'stack');
    assert.equal(again.history().length, 3, 'o histórico também persiste');
  });
});

test('falha ao gravar: o erro explica, o estado em memória volta e o arquivo antigo fica intacto', () => {
  withPrefs((p, dir) => {
    p.set(G, 'queue.parallel', 2);
    const before = fs.readFileSync(p.file, 'utf8');
    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('disco cheio'); e.code = 'ENOSPC'; throw e; };
    try {
      assert.throws(() => p.set(G, 'queue.parallel', 4), (err) => err.code === 'WRITE_FAILED' && /disco cheio/.test(err.message) && /espaço em disco/.test(err.message));
    } finally { fs.renameSync = realRename; }
    assert.equal(fs.readFileSync(p.file, 'utf8'), before, 'arquivo antigo intacto');
    assert.equal(p.get('queue.parallel', {}), 2, 'memória voltou ao que estava no disco');
    assert.equal(p.history().length, 1);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'o temporário é removido');
    assert.equal(p.set(G, 'queue.parallel', 4).changed, true, 'depois do problema volta a funcionar');
  });
});

test('arquivo corrompido: preserva uma cópia .corrupt, recomeça nos padrões e segue funcionando', () => {
  const dir = mkTmp('prefs-corrupt');
  try {
    fs.writeFileSync(path.join(dir, 'preferences.json'), '{ isto não é json');
    const logs = [];
    const p = new Preferences({ dir, log: (l, m) => logs.push([l, m]) });
    assert.equal(p.get('queue.parallel', {}), 1);
    const kept = fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt'));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{ isto não é json', 'o conteúdo original é preservado');
    assert.ok(p.recovered && logs.some(([l]) => l === 'warn'));
    assert.equal(p.notices.length, 1, 'o usuário precisa ser avisado');
    assert.equal(p.notices[0].code, 'PREFS_RECOVERED');
    assert.ok(p.notices[0].message.includes(kept[0]), 'o aviso diz onde ficou a cópia');
    p.set(G, 'queue.parallel', 2);
    assert.equal(new Preferences({ dir }).get('queue.parallel', {}), 2);
  } finally { rm(dir); }
});

test('valor inválido escrito à mão no arquivo é ignorado (vale o padrão) sem derrubar o app', () => {
  const dir = mkTmp('prefs-hand');
  try {
    fs.writeFileSync(path.join(dir, 'preferences.json'), JSON.stringify({
      version: 1, general: { values: { 'queue.parallel': 99, 'analysis.padBeforeSec': 6, 'chave.desconhecida': 1 } }, games: { '__proto__': 5 }, history: 'x'
    }));
    const p = new Preferences({ dir });
    assert.equal(p.get('queue.parallel', {}), 1, 'fora do limite: ignorado');
    assert.equal(p.get('analysis.padBeforeSec', {}), 6, 'o válido continua valendo');
    p.set(G, 'queue.parallel', 2);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'preferences.json'), 'utf8'));
    assert.equal(saved.general.values['chave.desconhecida'], 1, 'chaves de versões futuras não são apagadas');
  } finally { rm(dir); }
});

// ---------- histórico e reverter ----------

test('histórico: mais nova primeiro; reverter volta ao valor anterior e registra a reversão', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.padBeforeSec', 4);
    const e2 = p.set(G, 'analysis.padBeforeSec', 7).entry;
    assert.equal(p.get('analysis.padBeforeSec', {}), 7);
    const rev = p.revert(e2.id);
    assert.equal(p.get('analysis.padBeforeSec', {}), 4, 'voltou ao anterior');
    assert.match(rev.entry.label, /^Desfez: Alterou/);
    const h = p.history();
    assert.equal(h[0].id, rev.entry.id);
    assert.equal(h.find((e) => e.id === e2.id).revertedAt !== undefined, true);
    assert.equal(h.find((e) => e.id === e2.id).revertible, false);
    assert.throws(() => p.revert(e2.id), (err) => err.code === 'ALREADY_REVERTED');
    // desfazer o desfazer refaz
    p.revert(rev.entry.id);
    assert.equal(p.get('analysis.padBeforeSec', {}), 7);
  });
});

test('reverter a criação remove o valor; reverter a remoção devolve o valor', () => {
  withPrefs((p) => {
    const created = p.set(game('Valorant'), 'queue.parallel', 3).entry;
    p.revert(created.id);
    assert.equal(p.get('queue.parallel', { game: 'Valorant' }), 1);
    assert.deepEqual(p.names().games, [], 'escopo vazio some');

    p.set(game('Valorant'), 'queue.parallel', 3);
    const removed = p.unset(game('Valorant'), 'queue.parallel').entry;
    assert.equal(p.get('queue.parallel', { game: 'Valorant' }), 1);
    p.revert(removed.id);
    assert.equal(p.get('queue.parallel', { game: 'Valorant' }), 3);
    assert.deepEqual(p.names().games, ['Valorant']);
  });
});

test('histórico tem limite e ids continuam crescendo depois de reiniciar', () => {
  const dir = mkTmp('prefs-hist');
  try {
    let p = new Preferences({ dir });
    for (let i = 0; i < 320; i++) p.set(G, 'analysis.padBeforeSec', (i % 50) + 1 + (i % 2 ? 0.5 : 0));
    assert.equal(p.history(1000).length, 300);
    const lastId = p.history(1)[0].id;
    p = new Preferences({ dir });
    const next = p.set(G, 'analysis.padBeforeSec', 59).entry.id;
    assert.ok(next > lastId, `${next} > ${lastId}`);
    assert.throws(() => p.revert('h000001'), (err) => err.code === 'NOT_FOUND', 'entrada antiga já saiu do histórico');
  } finally { rm(dir); }
});

test('schema expõe grupos, chaves (com padrão e opções) e limites da evidência mínima', () => {
  withPrefs((p) => {
    const s = p.schema();
    assert.equal(s.keys.length, DEFS.length);
    assert.deepEqual(s.keys.find((k) => k.key === 'export.framing.mode').options.map((o) => o[0]), ['center', 'blur', 'stack', 'custom']);
    assert.deepEqual(s.minEvidence, { default: 5, min: 3, max: 100 });
    s.keys[0].label = 'mexido';
    assert.notEqual(p.schema().keys[0].label, 'mexido', 'o esquema é cópia');
  });
});
