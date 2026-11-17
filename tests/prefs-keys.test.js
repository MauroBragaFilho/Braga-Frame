'use strict';

/**
 * Catálogo de chaves (keys.js): validação de números em texto, faixas iguais às da análise, textos honestos das legendas e
 * a garantia de que toda preferência mostrada na tela tem alguém que a lê ("nada fictício").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFS, findDef, validate, formatValue } = require('../src/core/preferences/keys');
const { RANGES } = require('../src/core/analysis/params');
const { Preferences } = require('../src/core/preferences');
const { mkTmp, rm } = require('./prefs-helpers');

const G = { type: 'general' };
const ROOT = path.join(__dirname, '..');

function withPrefs(fn) {
  const dir = mkTmp('prefs-keys');
  try { return fn(new Preferences({ dir }), dir); } finally { rm(dir); }
}

test('número em texto: só dígitos com vírgula ou ponto decimal; hexadecimal, notação científica e Infinity são recusados', () => {
  const relevance = findDef('analysis.minRelevance');
  for (const bad of [' 0x1 ', '0x1', '1e-1', '1E0', 'Infinity', '-0', '1,2,3', '0,', ',5', '', '   ', '1 000']) {
    const res = validate(relevance, bad);
    assert.equal(res.ok, false, `"${bad}" não é um número que o usuário digitaria`);
    assert.match(res.message, /entre 0 e 1/);
  }
  assert.deepEqual(validate(relevance, '0,7'), { ok: true, value: 0.7 });
  assert.deepEqual(validate(relevance, ' 0.35 '), { ok: true, value: 0.35 });
  assert.deepEqual(validate(relevance, 1), { ok: true, value: 1 });
  assert.deepEqual(validate(findDef('analysis.padBeforeSec'), '4,5'), { ok: true, value: 4.5 });
  assert.deepEqual(validate(findDef('queue.parallel'), '2'), { ok: true, value: 2 });
  assert.equal(validate(findDef('queue.parallel'), '0x2').ok, false);
  assert.equal(validate(findDef('queue.parallel'), '2e0').ok, false);
});

test('valor hexadecimal ou científico em texto não chega às preferências em vigor', () => {
  withPrefs((p) => {
    for (const bad of [' 0x1 ', '1e-1']) {
      assert.throws(() => p.set(G, 'analysis.minRelevance', bad), (err) => err.code === 'INVALID_VALUE', bad);
    }
    assert.equal(p.get('analysis.minRelevance', {}), 0.5, 'continua o padrão');
    assert.equal(p.history().length, 0);
  });
});

test('faixas de duração e margens: as mesmas que a análise aplica, então o valor mostrado é o que ela usa', () => {
  for (const [key, range] of [
    ['analysis.minDurationSec', RANGES.minDurationSec], ['analysis.maxDurationSec', RANGES.maxDurationSec],
    ['analysis.padBeforeSec', RANGES.padBeforeSec], ['analysis.padAfterSec', RANGES.padAfterSec]
  ]) {
    const def = findDef(key);
    assert.deepEqual([def.min, def.max], range, key);
  }
  assert.equal(validate(findDef('analysis.maxDurationSec'), 181).ok, false, 'a análise cortaria em 180 s');
  assert.equal(validate(findDef('analysis.maxDurationSec'), 180).ok, true);
  assert.equal(validate(findDef('analysis.minDurationSec'), 121).ok, false);
  assert.equal(validate(findDef('analysis.minDurationSec'), 2).ok, false);
  assert.match(validate(findDef('analysis.maxDurationSec'), 300).message, /entre 5 e 180 segundos/);
  withPrefs((p) => {
    assert.throws(() => p.set(G, 'analysis.maxDurationSec', 300), (err) => err.code === 'INVALID_VALUE');
    assert.equal(p.get('analysis.maxDurationSec', {}), 60);
    // um valor antigo (ou escrito à mão) fora da faixa nunca vale: a análise nunca receberia algo que ela mesma recusa
    fs.writeFileSync(p.file, JSON.stringify({ version: 1, general: { values: { 'analysis.maxDurationSec': 300 } } }));
    assert.equal(new Preferences({ dir: path.dirname(p.file) }).get('analysis.maxDurationSec', {}), 60);
  });
});

test('nome do perfil de exportação nos textos: usa o tradutor quando existe e o id quando não', () => {
  const def = findDef('export.profileId');
  assert.equal(formatValue(def, 'vertical-1440-h264'), 'vertical-1440-h264');
  assert.equal(formatValue(def, 'vertical-1440-h264', { profileName: () => 'Vertical 9:16 · 1440p' }), 'Vertical 9:16 · 1440p');
  assert.equal(formatValue(def, 'user-1', { profileName: () => null }), 'user-1');
  assert.equal(formatValue(def, null, { profileName: () => 'x' }), 'padrão do app');
});

test('legendas: o texto das preferências diz o que elas fazem de verdade (liga a caixa do corte; não gera falas)', () => {
  const enabled = findDef('subtitles.enabled');
  assert.ok(!/gerar legendas/i.test(enabled.label), `"${enabled.label}" prometia gerar legendas, o que a preferência não faz`);
  assert.match(enabled.label, /Ligar a legenda nos cortes novos/);
  assert.match(enabled.hint, /aba Legendas/);
  assert.match(findDef('subtitles.style').hint, /aba Legendas/);
  assert.match(findDef('subtitles.style').hint, /Mais opções/);
});

test('layouts do canal (aba Exportar): três chaves de objeto, herdadas por escopo; o texto do valor diz onde editar e as referências aceitam mais que 4 KB', () => {
  for (const key of ['export.layout.conversa', 'export.layout.jogo', 'export.layout.refs']) {
    const def = findDef(key);
    assert.ok(def, key);
    assert.equal(def.type, 'object');
    assert.equal(def.group, 'export');
    assert.equal(def.advanced, true, 'fica em "Mais ajustes": o lugar de editar é a aba Exportar');
    assert.equal(def.default, null);
    assert.match(def.hint, /aba Exportar/);
    assert.match(formatValue(def, { framing: {} }), /aba Exportar/, 'a tela de Preferências não manda editar nas Legendas');
  }
  assert.equal(formatValue(findDef('subtitles.style'), { fontSize: 20 }), 'definido na aba Legendas', 'o texto das Legendas não mudou');
  const preset = { framing: { mode: 'stack', stack: { webcamHeightPct: 31 } }, ref: { w: 2560, h: 1440 } };
  assert.deepEqual(validate(findDef('export.layout.jogo'), preset), { ok: true, value: preset });
  assert.equal(validate(findDef('export.layout.jogo'), 'texto').ok, false);
  assert.equal(validate(findDef('export.layout.jogo'), { lixo: 'x'.repeat(5000) }).ok, false, 'um preset não passa de 4 KB');
  const refs = { conversa: Array(4).fill('A'.repeat(3072)), jogo: Array(4).fill('B'.repeat(3072)) };
  assert.equal(validate(findDef('export.layout.refs'), refs).ok, true, '8 quadros de referência (24 KB) cabem');
  assert.equal(validate(findDef('export.layout.refs'), { x: 'x'.repeat(40000) }).ok, false);
});

test('layouts do canal herdam por escopo: o do canal vence o do jogo, que vence o geral, e novos projetos do canal enxergam o valor', () => withPrefs((prefs) => {
  const general = { framing: { focusX: 0.4 } };
  const channel = { framing: { focusX: 0.7 }, ref: { w: 1920, h: 1080 } };
  prefs.set(G, 'export.layout.conversa', general);
  assert.deepEqual(prefs.get('export.layout.conversa', { channel: 'Braga' }), general);
  prefs.set({ type: 'channel', name: 'Braga' }, 'export.layout.conversa', channel);
  assert.deepEqual(prefs.get('export.layout.conversa', { channel: 'braga ' }), channel, 'nome sem diferenciar caixa e espaços');
  assert.deepEqual(prefs.get('export.layout.conversa', { channel: 'Outro' }), general, 'outro canal herda o geral');
  assert.equal(prefs.explain('export.layout.conversa', { channel: 'Braga' }).scope, 'channel');
  assert.equal(prefs.get('export.layout.jogo', { channel: 'Braga' }), null, 'sem valor salvo o padrão é nulo (vale o preset de fábrica do exportador)');
  prefs.unset({ type: 'channel', name: 'Braga' }, 'export.layout.conversa');
  assert.deepEqual(prefs.get('export.layout.conversa', { channel: 'Braga' }), general, 'Limpar devolve a herança');
}));

test('nada fictício: toda preferência do catálogo é lida por alguma aba (ou pelo processo principal) fora da própria tela de Preferências', () => {
  const featuresDir = path.join(ROOT, 'renderer', 'features');
  const sources = [];
  // inclui as subpastas das telas divididas (features/analysis/, features/export/): a leitura da preferência pode estar numa parte
  const walkFeatures = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFeatures(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const file of walkFeatures(featuresDir)) {
    const name = path.relative(featuresDir, file);
    if (!name.endsWith('.js') || name === 'prefs.js') continue;
    sources.push([name, fs.readFileSync(file, 'utf8')]);
  }
  for (const dir of ['src/core', 'src/ipc']) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.js') ? [path.join(d, e.name)] : [])));
    for (const file of walk(path.join(ROOT, dir))) {
      if (file.includes(`${path.sep}preferences${path.sep}`) || file.endsWith(`${path.sep}prefs.js`)) continue;
      sources.push([path.relative(ROOT, file), fs.readFileSync(file, 'utf8')]);
    }
  }
  const unread = [];
  for (const def of DEFS) {
    // a análise lê por `analysis.${nome}`; as demais pelo texto inteiro da chave
    const suffix = def.key.startsWith('analysis.') ? def.key.slice('analysis.'.length) : null;
    const readers = sources.filter(([, code]) => code.includes(`'${def.key}'`) || code.includes(`"${def.key}"`) || (suffix && code.includes(`analysis.\${`) && code.includes(`'${suffix}'`)));
    if (!readers.length) unread.push(def.key);
  }
  assert.deepEqual(unread, [], 'preferência exibida na tela sem nenhuma aba que a leia seria um botão sem ação');
});
