'use strict';

/**
 * Renderer do OpenRouter "só com modelos gratuitos" (renderer/features/aiOpenrouter.js) sem abrir o Electron: carrega o arquivo num contexto
 * `vm` com um BF mínimo e confere as funções de formatação (contexto, datas, preços, selos) e que o id do roteador é o mesmo do processo
 * principal. O desenho de verdade (lista, teclado, interruptor, offline, selo) é conferido em tests/e2e/ai-openrouter.e2e.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const catalog = require('../src/core/ai/openrouter/catalog');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'aiOpenrouter.js'), 'utf8');

function load() {
  const BF = {
    util: { el: (tag, attrs, ...children) => ({ tag, attrs, children }), debounce: (fn) => fn },
    api: async () => ({ ok: false, code: 'NO_KEY' })
  };
  const sandbox = { window: { BF }, console, setInterval: () => 0, clearInterval() {} };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'aiOpenrouter.js' });
  return BF.aiOpenRouter;
}

const plain = (v) => JSON.parse(JSON.stringify(v));

test('a feature registra só BF.aiOpenRouter (sem aba) com o seletor, o selo e as funções de formatação', () => {
  const api = load();
  assert.equal(typeof api.createModelPicker, 'function');
  assert.equal(typeof api.createLimitsChip, 'function');
  assert.deepEqual(Object.keys(api.format).sort(), ['badges', 'context', 'day', 'money', 'plural', 'price', 'when']);
  assert.ok(!/registerTab\s*\(/.test(CODE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'não registra aba');
  assert.equal(api.ROUTER_ID, catalog.ROUTER_ID, 'o id do roteador é o mesmo do processo principal');
});

test('formatContext é igual ao do processo principal ("262 mil", "1 mi")', () => {
  const { format } = load();
  const values = [0, 500, 1000, 8192, 65536, 128000, 200000, 262144, 949999, 950000, 999999, 1000000, 1048576, 1500000, 2000000];
  for (const n of values) assert.equal(format.context(n), catalog.formatTokens(n), String(n));
  assert.equal(format.context(262144), '262 mil');
  assert.equal(format.context(1048576), '1 mi');
  assert.equal(format.context(1500000), '1,5 mi');
  assert.equal(format.context(NaN), '');
});

test('datas: "31/10" (com o ano se for de outro ano) e "23/10 às 14:32" no horário do computador', () => {
  const { format } = load();
  const now = new Date(2026, 9, 23, 12, 0).getTime();
  assert.equal(format.day('2026-10-31', now), '31/10');
  assert.equal(format.day('2027-01-02', now), '02/01/2027');
  assert.equal(format.day('lixo', now), '');
  assert.equal(format.day(null, now), '');
  assert.equal(format.when(new Date(2026, 9, 23, 14, 32).toISOString(), now), '23/10 às 14:32');
  assert.equal(format.when(new Date(2026, 0, 5, 9, 7).toISOString(), now), '05/01 às 09:07');
  assert.equal(format.when(new Date(2025, 11, 31, 23, 59).toISOString(), now), '31/12/2025 às 23:59');
  assert.equal(format.when('', now), '');
  assert.equal(format.when('ontem', now), '');
  assert.equal(format.when(null, now), '');
});

test('preços por milhão de tokens: dinheiro em pt-BR, preço variável, não informado e outras tarifas', () => {
  const { format } = load();
  assert.equal(format.money(0.3), 'US$ 0,30');
  assert.equal(format.money(2.5), 'US$ 2,50');
  assert.equal(format.money(0.075), 'US$ 0,075');
  assert.equal(format.money(15), 'US$ 15,00');
  assert.equal(format.money(0), 'US$ 0,00');
  assert.equal(format.money(1234.5), 'US$ 1.234,50');
  assert.equal(format.price({ promptPerMillion: 0.3, completionPerMillion: 2.5, variable: false, unknown: false, otherFees: false }), 'Entrada US$ 0,30 · saída US$ 2,50 por milhão de tokens');
  assert.match(format.price({ promptPerMillion: 0, completionPerMillion: 0, variable: false, unknown: false, otherFees: true }), /Entrada US\$ 0,00 · saída US\$ 0,00 por milhão de tokens, mais outras tarifas/);
  assert.match(format.price({ variable: true }), /Preço variável: depende do modelo que o roteador escolher/);
  assert.match(format.price({ unknown: true }), /Preço não informado/);
  assert.equal(format.price(null), '');
});

test('selos de uma linha: "Automático" no roteador; contexto, JSON e expiração nos modelos (a expiração já explicada pelo motivo não repete)', () => {
  const { format } = load();
  const now = new Date(2026, 9, 23).getTime();
  assert.deepEqual(plain(format.badges({ group: 'router' }, now)), [{ text: 'Automático', kind: 'accent' }]);
  assert.deepEqual(plain(format.badges({ group: 'free', contextLength: 262144, supportsJson: true, expiresAt: null, reasons: [] }, now)), [
    { text: 'contexto 262 mil', kind: '' }, { text: 'JSON', kind: 'info' }
  ]);
  // expira em breve: aviso; expira daqui a muito tempo: neutro
  assert.deepEqual(plain(format.badges({ group: 'free', contextLength: 65536, supportsJson: true, expiresAt: '2026-12-31', expiresInDays: 69, expired: false, reasons: [] }, now)).pop(), { text: 'expira 31/12', kind: '' });
  assert.deepEqual(plain(format.badges({ group: 'free', contextLength: 65536, supportsJson: false, expiresAt: '2026-10-31', expiresInDays: 8, expired: false, reasons: [] }, now)).pop(), { text: 'expira 31/10', kind: 'warn' });
  // com o motivo "expira em 31/10" na linha, o selo de expiração não repete
  const explained = { group: 'otherFree', contextLength: 262144, supportsJson: false, expiresAt: '2026-10-31', expiresInDays: 8, expired: false, reasons: [{ code: 'expires_soon', text: 'expira em 31/10' }] };
  assert.deepEqual(plain(format.badges(explained, now)), [{ text: 'contexto 262 mil', kind: '' }]);
  assert.deepEqual(plain(format.badges({ group: 'otherFree', contextLength: 0, supportsJson: false, reasons: [] }, now)), [], 'sem dados, sem selos');
});

test('o CSS da feature só usa tokens que o app define (nada de cor solta) e a feature fica antes da Análise no index.html', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'aiOpenrouter.css'), 'utf8');
  const appCss = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.css'), 'utf8');
  const used = new Set([...css.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
  assert.ok(used.size > 10);
  for (const name of used) assert.ok(new RegExp(`${name}\\s*:`).test(appCss), `${name} não existe em app.css`);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'sem cor fixa');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.indexOf('features/aiOpenrouter.js') > 0 && html.indexOf('features/aiOpenrouter.js') < html.indexOf('features/analysis.js'), 'a feature carrega antes da Análise, que a usa');
  assert.ok(html.indexOf('features/aiOpenrouter.css') > 0 && html.indexOf('features/aiOpenrouter.css') < html.indexOf('features/analysis.css'));
});
