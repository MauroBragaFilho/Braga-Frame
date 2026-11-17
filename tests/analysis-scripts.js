'use strict';

/**
 * Carrega os scripts da aba Análise num contexto do `vm`, na MESMA ordem de renderer/index.html (as partes de features/analysis/*.js e depois
 * features/analysis.js). Assim os testes rodam o que o app roda e, se uma parte nova faltar no index.html, eles quebram. Não é um teste.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'renderer');

/** Caminhos (relativos a renderer/) dos scripts da Análise, na ordem do index.html. */
function analysisScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const list = [...html.matchAll(/<script src="(features\/analysis(?:\/[^"]+)?\.js)"><\/script>/g)].map((m) => m[1]);
  if (!list.length || list[list.length - 1] !== 'features/analysis.js') throw new Error('index.html: features/analysis.js precisa ser o último script da Análise');
  return list;
}

/** Roda todos os scripts da Análise em `context` (um vm.createContext). */
function runAnalysis(context) {
  for (const rel of analysisScripts()) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), context, { filename: path.basename(rel) });
  }
}

module.exports = { analysisScripts, runAnalysis };
