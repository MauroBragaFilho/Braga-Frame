'use strict';

/**
 * Catálogo de ferramentas do app: as entradas oficiais de entries/*.js (registry.js) e a ligação delas
 * com as chaves do `ctx.tools`. Não baixa nem grava nada.
 *
 * Também carrega as entradas de TESTE (variável BF_TEST_TOOL_ENTRIES). Elas só existem para o e2e poder
 * instalar uma "ferramenta" a partir de um servidor HTTP local e valem somente quando TODAS as condições
 * abaixo são verdadeiras ao mesmo tempo (veja testModeAllowed):
 *   - NODE_ENV === 'test';
 *   - o app NÃO está empacotado (`app.isPackaged === false`; indefinido conta como empacotado);
 *   - todas as URLs de download são de loopback (localhost / 127.0.0.1 / ::1).
 * Em produção (app empacotado) a variável é ignorada por completo. Este é o único arquivo do app que a
 * menciona; tests/tools-catalog.test.js garante isso.
 */

const registry = require('./registry');

const TEST_ENV_VAR = 'BF_TEST_TOOL_ENTRIES';

/**
 * id da entrada (minúsculas) -> chave de `ctx.tools`. Só estes ids alimentam o `ctx.tools`;
 * uma entrada com outro id aparece na tela de Ferramentas e instala, mas nenhum módulo a recebe.
 */
const TOOL_KEY_BY_ID = Object.freeze({ ytdlp: 'ytdlp', whisper: 'whisper', twitchdownloader: 'twitchDownloader' });

/** Chave do `ctx.tools` para o id de uma entrada (sem diferenciar maiúsculas), ou null. */
function toolKeyFor(id) {
  const lower = String(id || '').toLowerCase();
  return Object.hasOwn(TOOL_KEY_BY_ID, lower) ? TOOL_KEY_BY_ID[lower] : null;
}

/** Entradas de teste só valem fora de produção: NODE_ENV=test e app não empacotado. */
function testModeAllowed(env, isPackaged) {
  return Boolean(env) && env.NODE_ENV === 'test' && isPackaged === false;
}

function allLoopback(entry) {
  return Object.values(entry.assets).every((asset) => {
    try { return registry.isLoopbackHost(new URL(asset.url).hostname); } catch { return false; }
  });
}

/** Lê o JSON de BF_TEST_TOOL_ENTRIES (uma entrada ou uma lista). Entrada inválida é descartada e vai para `errors`. */
function parseTestEntries(raw) {
  const entries = [];
  const errors = [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    return { entries, errors: [{ file: TEST_ENV_VAR, message: `JSON inválido (${err.message})` }] };
  }
  for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
    const problems = registry.validateEntry(entry, { allowLoopbackHttp: true });
    if (problems.length) {
      errors.push({ file: TEST_ENV_VAR, message: `entrada de teste inválida (${(entry && entry.id) || 'sem id'}): ${problems.join('; ')}` });
    } else if (!allLoopback(entry)) {
      errors.push({ file: TEST_ENV_VAR, message: `entrada de teste recusada (${entry.id}): só são aceitos endereços locais (localhost / 127.0.0.1)` });
    } else {
      entries.push(entry);
    }
  }
  return { entries, errors };
}

/**
 * @param {{ env?:object, isPackaged?:boolean, base?:{entries:object[], errors:object[]} }} [opts]
 *   base: entradas oficiais já carregadas (padrão: registry.getRegistry())
 * @returns {{ entries: object[], errors: {file:string,message:string}[], allowLoopbackHttp: boolean, testIds: string[] }}
 *   `testIds`: ids (minúsculas) que vieram de BF_TEST_TOOL_ENTRIES; `allowLoopbackHttp` só é true quando há alguma.
 */
function loadToolCatalog({ env = process.env, isPackaged, base } = {}) {
  const loaded = base || registry.getRegistry();
  let entries = [...loaded.entries];
  const errors = [...loaded.errors];
  const testIds = [];

  const raw = env[TEST_ENV_VAR];
  if (typeof raw === 'string' && raw.trim() !== '' && testModeAllowed(env, isPackaged)) {
    const injected = parseTestEntries(raw);
    errors.push(...injected.errors);
    for (const entry of injected.entries) {
      const key = entry.id.toLowerCase();
      entries = entries.filter((e) => e.id.toLowerCase() !== key); // a de teste substitui a oficial de mesmo id
      entries.push(entry);
      testIds.push(key);
    }
  }
  return { entries, errors, allowLoopbackHttp: testIds.length > 0, testIds };
}

module.exports = { TEST_ENV_VAR, TOOL_KEY_BY_ID, toolKeyFor, testModeAllowed, parseTestEntries, loadToolCatalog };
