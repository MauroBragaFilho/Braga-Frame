'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const cutsJs = read('renderer', 'features', 'cuts.js');
const timelineJs = read('renderer', 'features', 'timeline.js');

/** A lista que o cuts.js carrega por <script>, na ordem. */
function logicList() {
  const match = /const LOGIC = \[([^\]]+)\]/.exec(cutsJs);
  assert.ok(match, 'cuts.js declara LOGIC');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('o cuts.js carrega exatamente os módulos universais da revisão e do histórico (e nenhum arquivo só do Node)', () => {
  const list = logicList();
  for (const name of list) assert.ok(fs.existsSync(path.join(ROOT, 'src', 'core', `${name}.js`)), `existe src/core/${name}.js`);
  const nodeOnly = ['review/waveform.js', 'history/store.js'];
  const universal = [];
  for (const dir of ['review', 'history']) {
    for (const file of fs.readdirSync(path.join(ROOT, 'src', 'core', dir))) {
      if (!file.endsWith('.js') || nodeOnly.includes(`${dir}/${file}`)) continue;
      universal.push(`${dir}/${file.replace(/\.js$/, '')}`);
    }
  }
  assert.deepEqual([...list].sort(), universal.sort(), 'todo módulo universal novo precisa entrar na lista do cuts.js (o index.html é da base)');
  for (const name of nodeOnly) {
    const code = read('src', 'core', name);
    assert.match(code, /require\('node:/, `${name} usa o Node`);
    assert.ok(!list.includes(name.replace(/\.js$/, '')), `${name} não pode ser carregado no renderer`);
  }
});

test('os módulos universais carregam num "navegador" sem module/require, na ordem do cuts.js, e o motor funciona', () => {
  const sandbox = { console, setTimeout, clearTimeout }; // o que o navegador tem de graça
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of logicList()) {
    assert.equal(typeof sandbox.module, 'undefined');
    vm.runInContext(read('src', 'core', `${name}.js`), sandbox, { filename: `${name}.js` });
  }
  const R = sandbox.BFReview;
  assert.deepEqual(Object.keys(R).sort(), ['batch', 'core', 'engine', 'history', 'order', 'shortcuts', 'similarity', 'titles']);
  for (const fn of ['sortCuts', 'filterCuts']) assert.equal(typeof R.order[fn], 'function');
  for (const fn of ['findGroups', 'comparePair', 'bestToKeep']) assert.equal(typeof R.similarity[fn], 'function');
  for (const fn of ['suggestTitles', 'isCustomTitle']) assert.equal(typeof R.titles[fn], 'function');
  assert.equal(typeof R.batch.planBatch, 'function');
  assert.equal(typeof R.history.planRestore, 'function');

  // o motor roda de verdade nesse ambiente (sem Node): aprova, desfaz
  const project = { id: 'p', cuts: [{ id: 'a', title: 'Corte 1', start: 1, end: 5, status: 'pending', revision: 1, origin: 'manual' }] };
  const events = [];
  const engine = R.engine.createEngine({ getProject: () => project, update: (fn) => fn(project), emit: (n, d) => events.push([n, d]), duration: () => 60 });
  engine.reset('p');
  assert.ok(engine.setStatus('a', 'approved').group);
  assert.equal(project.cuts[0].status, 'approved');
  engine.undo();
  assert.equal(project.cuts[0].status, 'pending');
  assert.deepEqual(events.filter(([n]) => n === 'decision').map(([, d]) => d.type), ['approve', 'reset']);
});

test('as features da revisão respeitam as regras do renderer (CSP, modais próprios, só BF.*)', () => {
  for (const [name, code] of [['cuts.js', cutsJs], ['timeline.js', timelineJs]]) {
    assert.doesNotMatch(code, /window\.(confirm|alert|prompt)|(^|[^.\w])(alert|prompt|confirm)\(/, `${name}: modais só pelo BF.ui`);
    assert.doesNotMatch(code, /innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, `${name}: nada de HTML por texto nem eval`);
    assert.doesNotMatch(code, /setAttribute\(\s*['"]style['"]/, `${name}: a CSP não aceita style inline`);
    assert.doesNotMatch(code, /\bstyle:\s*['"`{]/, `${name}: sem atributo style no el()`);
    assert.doesNotMatch(code, /localStorage|sessionStorage/, `${name}: estado só em memória ou no projeto`);
    assert.doesNotMatch(code, /window\.bf\b|ipcRenderer|require\(/, `${name}: só BF.api/BF.on falam com o app`);
  }
  assert.match(cutsJs, /BF\.ui\.confirm/);
  assert.match(cutsJs, /id: 'cuts',/);
  assert.match(cutsJs, /order: 10,/);
  assert.match(timelineJs, /getElementById\('timelineSlot'\)/);
  // a timeline fala com o motor só pelo BF.review (a edição passa pelo histórico)
  assert.match(timelineJs, /BF\.review\.adjust/);
  assert.doesNotMatch(timelineJs, /BF\.project\.update/, 'a timeline não altera o projeto direto');
});

test('os estilos da revisão não carregam nada de fora', () => {
  for (const file of ['cuts.css', 'timeline.css']) {
    const css = read('renderer', 'features', file);
    assert.doesNotMatch(css, /@import|url\(|https?:/, `${file}: só o que está no disco`);
  }
});
