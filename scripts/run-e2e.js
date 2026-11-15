#!/usr/bin/env node
'use strict';

/**
 * Roda os testes de ponta a ponta (tests/e2e/*.e2e.js) abrindo o app Electron de verdade.
 *
 * Uso:
 *   npm run test:e2e                      todos, um por vez, em ordem alfabética
 *   npm run test:e2e -- export queue      só os que casam com os filtros (nome exato "export" ou trecho do nome)
 *   node scripts/run-e2e.js --list        mostra o que rodaria e sai
 *   BF_E2E_PARALLEL=2 npm run test:e2e    até 2 ao mesmo tempo (cada um usa porta de depuração e perfil próprios)
 *
 * Opções: --list, --bail (para no primeiro que falhar; só em modo sequencial), --help.
 * Ambiente: BF_E2E_PARALLEL=n (1 a 8, padrão 1), BF_E2E_TIMEOUT_MS (prazo por arquivo, padrão 15 min),
 * BF_E2E_RETRIES=n (0 a 3, padrão 0: repete um arquivo que falhou; quem passa só na repetição aparece como instável no resumo,
 * nunca como se tivesse passado de primeira — serve para localizar testes sensíveis à carga, não para esconder falhas). Qualquer
 * outra variável (BF_E2E_SHOTDIR, BF_E2E_OFFLINE, BF_E2E_SHOT…) passa direto para os testes.
 *
 * Código de saída: 0 = todos passaram; 1 = algum falhou, estourou o prazo ou nenhum arquivo casou com o filtro.
 * Em modo paralelo a saída de cada arquivo é guardada e impressa inteira quando ele termina (sem misturar linhas).
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const E2E_DIR = path.join(ROOT, 'tests', 'e2e');
const SUFFIX = '.e2e.js';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function parseArgs(argv) {
  const opts = { filters: [], list: false, bail: false, help: false };
  for (const arg of argv) {
    if (arg === '--list') opts.list = true;
    else if (arg === '--bail') opts.bail = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) throw new Error(`Opção desconhecida: ${arg} (use --help).`);
    else opts.filters.push(arg.toLowerCase().replace(/\.e2e\.js$/, '').replace(/\.js$/, ''));
  }
  return opts;
}

/** Arquivos tests/e2e/*.e2e.js (helpers.js e qualquer outro arquivo que não termine em .e2e.js ficam de fora). */
function discover(dir = E2E_DIR) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(SUFFIX) && name !== 'helpers.js')
    .sort()
    .map((name) => ({ name: name.slice(0, -SUFFIX.length), file: path.join(dir, name) }));
}

/** Filtro: nome exato ou, se não houver exato, trecho do nome. Sem filtros = todos. */
function select(all, filters) {
  if (!filters.length) return { chosen: all, unmatched: [] };
  const chosen = [];
  const unmatched = [];
  for (const filter of filters) {
    const exact = all.filter((t) => t.name.toLowerCase() === filter);
    const hits = exact.length ? exact : all.filter((t) => t.name.toLowerCase().includes(filter));
    if (!hits.length) unmatched.push(filter);
    for (const hit of hits) if (!chosen.includes(hit)) chosen.push(hit);
  }
  return { chosen: all.filter((t) => chosen.includes(t)), unmatched };
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* já tinha terminado */ }
}

const fmtTime = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')} s`);
const running = new Set();

/** Roda um arquivo. `stream` = true repassa a saída ao vivo (modo sequencial); senão guarda para imprimir depois. */
function runOne(test, { stream, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const chunks = [];
    const child = spawn(process.execPath, [test.file], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    running.add(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const onData = (target) => (data) => {
      if (stream) target.write(data);
      else chunks.push(data);
    };
    child.stdout.on('data', onData(process.stdout));
    child.stderr.on('data', onData(process.stderr));
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      running.delete(child);
      const ms = Date.now() - startedAt;
      const ok = !error && !timedOut && code === 0;
      resolve({
        ...test, ok, code, signal, ms, timedOut, error: error ? error.message : null,
        output: stream ? '' : Buffer.concat(chunks).toString('utf8')
      });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Uso: node scripts/run-e2e.js [filtro ...] [--list] [--bail]\n  filtro: nome do teste (ex.: export) ou trecho do nome. BF_E2E_PARALLEL=n roda n ao mesmo tempo.');
    return 0;
  }
  const all = discover();
  const { chosen, unmatched } = select(all, opts.filters);
  if (unmatched.length) {
    console.error(`Nenhum e2e casa com: ${unmatched.join(', ')}. Disponíveis: ${all.map((t) => t.name).join(', ')}`);
    return 1;
  }
  if (!chosen.length) { console.error('Nenhum arquivo *.e2e.js encontrado em tests/e2e.'); return 1; }
  if (opts.list) { for (const t of chosen) console.log(t.name); return 0; }

  const parallel = Math.min(8, Math.max(1, Number(process.env.BF_E2E_PARALLEL) || 1));
  const retries = Math.min(3, Math.max(0, Math.floor(Number(process.env.BF_E2E_RETRIES) || 0)));
  const timeoutMs = Number(process.env.BF_E2E_TIMEOUT_MS) > 0 ? Number(process.env.BF_E2E_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  console.log(`E2E: ${chosen.length} arquivo(s) (${chosen.map((t) => t.name).join(', ')}) — ${parallel > 1 ? `${parallel} ao mesmo tempo` : 'em sequência'}; prazo por arquivo ${fmtTime(timeoutMs)}.`);

  const t0 = Date.now();
  const results = [];
  const queue = [...chosen];
  let stop = false;
  const stream = parallel === 1;

  async function worker() {
    while (queue.length && !stop) {
      const test = queue.shift();
      let attempt = 1;
      let res;
      for (;;) {
        if (stream) console.log(`\n=== ${test.name}${attempt > 1 ? ` (tentativa ${attempt} de ${retries + 1})` : ''} ===`);
        res = await runOne(test, { stream, timeoutMs });
        if (!stream) {
          console.log(`\n=== ${res.name}${attempt > 1 ? ` (tentativa ${attempt})` : ''} (${res.ok ? 'OK' : 'FALHOU'}, ${fmtTime(res.ms)}) ===`);
          process.stdout.write(res.output.endsWith('\n') || !res.output ? res.output : `${res.output}\n`);
        }
        if (res.ok || attempt > retries) break;
        attempt += 1;
      }
      res.attempts = attempt;
      results.push(res);
      if (!res.ok && opts.bail && stream) stop = true;
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));

  results.sort((a, b) => a.name.localeCompare(b.name));
  const notRun = chosen.filter((t) => !results.some((r) => r.name === t.name));
  console.log('\n──────── Resumo dos e2e ────────');
  const width = Math.max(...chosen.map((t) => t.name.length));
  for (const r of results) {
    const why = r.timedOut ? `estourou o prazo de ${fmtTime(timeoutMs)}` : r.error ? `não iniciou: ${r.error}` : r.signal ? `encerrado por ${r.signal}` : `código de saída ${r.code}`;
    const flaky = r.ok && r.attempts > 1 ? `   (passou só na tentativa ${r.attempts}: teste instável, investigue)` : '';
    console.log(`${r.ok ? '✔' : '✖'} ${r.name.padEnd(width)}  ${fmtTime(r.ms).padStart(10)}${r.ok ? flaky : `   ${why}${r.attempts > 1 ? ` (${r.attempts} tentativas)` : ''}`}`);
  }
  for (const t of notRun) console.log(`– ${t.name.padEnd(width)}  não rodou (--bail)`);
  const failed = results.filter((r) => !r.ok);
  console.log(`Total: ${results.length - failed.length} passaram, ${failed.length} falharam${notRun.length ? `, ${notRun.length} não rodaram` : ''} em ${fmtTime(Date.now() - t0)}.`);
  return failed.length ? 1 : 0;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of running) killTree(child.pid);
    process.exit(130);
  });
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`Erro no executor de e2e: ${err.message}`);
    for (const child of running) killTree(child.pid);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, discover, select };
