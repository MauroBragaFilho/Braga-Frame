'use strict';

/**
 * O layout do menu lateral (src/core/ui/menuLayout.js, "universal": o mesmo código vale no Node e no renderer): quais telas cada item do menu abriga,
 * a ordem das abas internas, a tela sem aba própria (Novo projeto, que acende Projetos) e o que acontece com tela que o layout não conhece.
 * O desenho no app (botões, abas internas, teclado, selos) é conferido em tests/e2e/menu.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LAYOUT, plan, itemOf } = require('../src/core/ui/menuLayout');

/** As telas que o app registra hoje, com a ordem (`order`) de cada uma. */
const REAL = [
  ['home', 1], ['projects', 5], ['sources', 6], ['cuts', 10], ['export', 20], ['queue', 30], ['subtitles', 40], ['audio', 50], ['analysis', 60], ['general', 75], ['prefs', 80], ['tools', 90]
].map(([id, order]) => ({ id, order, title: id }));

const summary = (items) => items.map((i) => [i.id, i.kind, i.tabs, i.hidden]);

test('as 12 telas do app viram 5 itens de menu, na ordem do desenho: Início, Projetos, Cortes, Exportações e Configurações', () => {
  const items = plan(REAL);
  assert.deepEqual(items.map((i) => i.title), ['Início', 'Projetos', 'Cortes', 'Exportações', 'Configurações']);
  assert.deepEqual(items.map((i) => i.icon), ['home', 'folder_special', 'content_cut', 'queue', 'settings']);
  assert.deepEqual(summary(items), [
    ['home', 'single', ['home'], []],
    ['projects', 'single', ['projects'], ['sources']],
    ['editor', 'group', ['cuts', 'analysis', 'subtitles', 'audio', 'export'], []],
    ['queue', 'single', ['queue'], []],
    ['settings', 'group', ['general', 'prefs', 'tools'], []]
  ]);
  assert.deepEqual(items.map((i) => i.defaultTab), ['home', 'projects', 'cuts', 'queue', 'general']);
});

test('as abas internas de Cortes seguem o fluxo de trabalho (Cortes, Análise, Legendas, Áudio, Exportar), e não a ordem antiga do menu', () => {
  const editor = plan(REAL).find((i) => i.id === 'editor');
  assert.deepEqual(editor.tabs, ['cuts', 'analysis', 'subtitles', 'audio', 'export']);
  assert.equal(editor.defaultTab, 'cuts', 'abrir um projeto leva à aba Cortes, como antes');
});

test('Novo projeto não tem item nem aba interna: pertence a Projetos (que acende quando ela está aberta)', () => {
  const items = plan(REAL);
  assert.ok(items.every((i) => !i.tabs.includes('sources')), 'nenhum item lista a tela como aba');
  assert.equal(itemOf(items, 'sources').id, 'projects');
  assert.equal(itemOf(items, 'projects').id, 'projects');
  assert.equal(itemOf(items, 'analysis').id, 'editor');
  assert.equal(itemOf(items, 'tools').id, 'settings');
  assert.equal(itemOf(items, 'queue').id, 'queue');
  assert.equal(itemOf(items, 'nao-existe'), null);
  assert.equal(itemOf(null, 'home'), null);
});

test('toda tela que uma feature registra está no layout (nenhuma cai no item automático) e o layout não cita tela que não existe', () => {
  const dir = path.join(__dirname, '..', 'renderer', 'features');
  const registered = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of code.matchAll(/BF\.ui\.registerTab\(\{\s*id:\s*'([a-zA-Z]+)'/g)) registered.push(m[1]);
  }
  assert.equal(new Set(registered).size, registered.length, 'nenhuma tela registrada duas vezes');
  const inLayout = LAYOUT.flatMap((i) => [...i.tabs, ...i.hidden]);
  assert.deepEqual([...registered].sort(), [...inLayout].sort(), 'as telas registradas pelas features são exatamente as do layout');
  assert.equal(new Set(inLayout).size, inLayout.length, 'cada tela está em um item só');
});

test('registro parcial: só entram as telas registradas; com uma só, o item vira "single"; sem nenhuma, não aparece', () => {
  const some = plan(REAL.filter((t) => ['cuts', 'export', 'tools'].includes(t.id)));
  assert.deepEqual(summary(some), [['editor', 'group', ['cuts', 'export'], []], ['settings', 'single', ['tools'], []]]);
  const one = plan([{ id: 'cuts', order: 10 }]);
  assert.deepEqual(summary(one), [['editor', 'single', ['cuts'], []]]);
  assert.deepEqual(plan([]), []);
  assert.deepEqual(plan(null), []);
  assert.deepEqual(plan(undefined), []);
  assert.deepEqual(plan([null, {}, { id: 3 }, 'x']), [], 'entradas sem id válido são ignoradas');
});

test('se só a tela sem aba própria existe, ela passa a ser a tela do item', () => {
  const items = plan([{ id: 'sources', order: 6 }]);
  assert.deepEqual(summary(items), [['projects', 'single', ['sources'], []]]);
  assert.equal(items[0].defaultTab, 'sources');
});

test('uma tela que o layout não conhece (um recurso novo) ganha um item próprio na posição do seu order', () => {
  const items = plan([...REAL, { id: 'biblioteca', title: 'Biblioteca', order: 20, icon: 'photo_library' }, { id: 'solta' }]);
  assert.deepEqual(items.map((i) => i.id), ['home', 'projects', 'editor', 'biblioteca', 'queue', 'settings', 'solta']);
  const added = items.find((i) => i.id === 'biblioteca');
  assert.deepEqual({ title: added.title, icon: added.icon, kind: added.kind, tabs: added.tabs, defaultTab: added.defaultTab }, { title: 'Biblioteca', icon: 'photo_library', kind: 'single', tabs: ['biblioteca'], defaultTab: 'biblioteca' });
  const bare = items.find((i) => i.id === 'solta');
  assert.deepEqual({ title: bare.title, icon: bare.icon, order: bare.order }, { title: 'solta', icon: 'circle', order: 100 }, 'sem título, ícone nem ordem: o id, "circle" e o fim do menu');
});

test('a ordem dos itens vem do layout e não da ordem em que as telas foram registradas', () => {
  const shuffled = [...REAL].reverse();
  assert.deepEqual(plan(shuffled).map((i) => i.id), ['home', 'projects', 'editor', 'queue', 'settings']);
  assert.deepEqual(plan(shuffled).find((i) => i.id === 'editor').tabs, ['cuts', 'analysis', 'subtitles', 'audio', 'export']);
});

test('o layout é imutável (nenhum recurso o altera por engano)', () => {
  assert.ok(Object.isFrozen(LAYOUT));
  assert.ok(LAYOUT.every((item) => Object.isFrozen(item)));
  assert.throws(() => { 'use strict'; LAYOUT.push({}); }, TypeError);
});
