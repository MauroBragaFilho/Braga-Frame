'use strict';

/**
 * Utilitários dos testes de ponta a ponta: abrem o app Electron de verdade (perfil de usuário próprio),
 * controlam a interface pelo DevTools Protocol e respondem aos modais do BF.ui.
 *
 * A porta de depuração é dinâmica (--remote-debugging-port=0, lida do arquivo DevToolsActivePort do
 * perfil), então vários testes podem rodar ao mesmo tempo sem disputar a porta.
 *
 * Uso típico:
 *   const app = await launchApp(userDataDir);      // app.page.eval(...), app.errors, app.stop()
 *   await waitFor(app.page, "document.querySelector('#cuts .cut')");
 *   await answerModal(app.page, true);
 *   assertNoConsoleErrors(app.page);
 *   await app.stop();  // ou cleanupAll() no finally
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = new Set();

/** Pasta temporária própria do teste (prefixo bf-). Remova com removeDir() no finally. */
function mkTemp(name = 'e2e') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `bf-${name}-`));
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Processos (pid, nome) cuja linha de comando cita `needle` (um caminho). Serve para achar os processos auxiliares do
 * Electron (GPU, utilitários, crashpad) que ainda seguram arquivos de um perfil depois que o processo principal saiu.
 * O caminho de um perfil temporário é único do teste, então só podem ser processos dele.
 */
function processesUsing(needle) {
  try {
    if (process.platform === 'win32') {
      const script = '$n = $env:BF_NEEDLE; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($n) } | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }';
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        env: { ...process.env, BF_NEEDLE: needle.toLowerCase() }, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore']
      });
      return out.split(/\r?\n/).filter(Boolean).map((line) => { const [pid, name] = line.split('|'); return { pid: Number(pid), name }; }).filter((p) => p.pid && p.pid !== process.pid);
    }
    const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter((line) => line.includes(needle)).map((line) => ({ pid: Number(line.trim().split(/\s+/)[0]), name: 'processo' })).filter((p) => p.pid && p.pid !== process.pid);
  } catch { return []; }
}

/**
 * Apaga uma pasta temporária do teste. No Windows os processos auxiliares do Electron seguram arquivos (dicionários, cache)
 * por alguns segundos depois que o app fecha (EPERM/EBUSY): repete por até `timeoutMs` e, passados alguns segundos, encerra
 * os que ainda citam a pasta. Se mesmo assim não der, AVISA e devolve false (não reprova um teste que já passou); qualquer
 * outro erro é lançado.
 */
function removeDir(dir, { timeoutMs = 30000 } = {}) {
  const end = Date.now() + timeoutMs;
  let killed = false;
  let last = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      last = err;
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'EAGAIN'].includes(err.code)) throw err;
    }
    if (Date.now() >= end) break;
    if (!killed && attempt >= 4) {
      killed = true;
      for (const p of processesUsing(dir)) killTree(p.pid);
    }
    sleepSync(Math.min(1000, 200 + attempt * 100));
  }
  console.warn(`aviso: não foi possível remover ${dir}: ${last.message}`);
  return false;
}

/**
 * Ambiente do app: o do teste mais `extra`. No Windows os nomes de variável não diferenciam maiúsculas: sem isto, passar
 * `PATH` quando o ambiente herdado tem `Path` criaria DUAS variáveis e o sistema escolheria uma delas ao acaso.
 */
function mergeEnv(base, extra = {}) {
  const env = { ...base };
  for (const key of Object.keys(extra)) {
    for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
  }
  return { ...env, ...extra };
}

/** Gera um vídeo de teste (barras + tom) com o ffmpeg. */
function makeSampleVideo(ffmpeg, file, { seconds = 20, size = '1920x1080', rate = 30 } = {}) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ], { windowsHide: true });
}

/** Conexão com uma página pelo DevTools Protocol. */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    const page = {
      ws,
      errors: [],
      send(method, params = {}) {
        return new Promise((done) => {
          const id = ++nextId;
          const timer = setTimeout(() => { pending.delete(id); done({ error: { message: `sem resposta do DevTools para ${method}` } }); }, 60000);
          pending.set(id, { done, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(method, fn) {
        listeners.set(method, [...(listeners.get(method) || []), fn]);
      },
      /** Executa JavaScript na página e devolve o valor (aguarda Promises). */
      async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.error) throw new Error(`Erro do DevTools: ${r.error.message}`);
        if (r.result.exceptionDetails) {
          const d = r.result.exceptionDetails;
          throw new Error(`Erro na página: ${d.exception?.description || d.text}`);
        }
        return r.result.result.value;
      },
      /** Tecla de verdade (Escape, Enter, Tab...) enviada ao elemento em foco. */
      async press(key, { shift = false } = {}) {
        const codes = { Escape: 27, Enter: 13, Tab: 9, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 };
        const base = { key, code: key, windowsVirtualKeyCode: codes[key], modifiers: shift ? 8 : 0 };
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      }
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { done, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        done(msg);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
      }
    };
    ws.onclose = () => {
      for (const { done, timer } of pending.values()) { clearTimeout(timer); done({ error: { message: 'conexão com o app fechada' } }); }
      pending.clear();
    };
    ws.onerror = () => reject(new Error('Não foi possível conectar ao DevTools do app.'));
    ws.onopen = () => resolve(page);
  });
}

/** Espera `expr` (JavaScript da página) ficar verdadeiro. Erros transitórios (página recarregando) são repetidos. */
async function waitFor(page, expr, timeoutMs = 20000, what = expr) {
  const end = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < end) {
    try {
      if (await page.eval(expr)) return;
      lastError = null;
    } catch (err) { lastError = err; }
    await sleep(150);
  }
  throw new Error(`Tempo esgotado esperando: ${what}${lastError ? ` (último erro: ${lastError.message})` : ''}`);
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch { /* já tinha terminado */ }
}

/** Pede ao Chromium para fechar tudo (sai limpo); se não sair a tempo, derruba a árvore de processos. */
async function closeBrowser(session) {
  const { proc, browserUrl } = session;
  if (proc.exitCode === null && browserUrl) {
    try {
      const browser = await connect(browserUrl);
      browser.send('Browser.close').catch(() => {});
      browser.ws.close();
    } catch { /* cai no taskkill */ }
  }
  const end = Date.now() + 6000;
  while (proc.exitCode === null && Date.now() < end) await sleep(100);
  if (proc.exitCode === null) killTree(proc.pid);
  await waitChildrenGone(session.userDataDir);
}

/**
 * Depois que o processo principal sai, os auxiliares (GPU, utilitários, crashpad) ainda levam alguns instantes para
 * terminar e seguram arquivos do perfil. Espera todos saírem (até ~10 s) e encerra à força os que sobrarem.
 */
async function waitChildrenGone(userDataDir) {
  if (!userDataDir) { await sleep(300); return; }
  const started = Date.now();
  for (;;) {
    const left = processesUsing(userDataDir);
    if (!left.length) return;
    if (Date.now() - started > 4000) for (const p of left) killTree(p.pid);
    if (Date.now() - started > 12000) return;
    await sleep(250);
  }
}

/**
 * Lê o DevToolsActivePort do perfil. Enquanto o Chromium grava o arquivo (ou um antivírus o examina) o Windows pode
 * devolver EBUSY/EPERM/EACCES por instantes: isso não é erro, é "ainda não está pronto" — devolve null e quem chama
 * tenta de novo no próximo ciclo (a espera total continua limitada pelo prazo do launchApp). Arquivo ausente = null.
 */
function readPortFile(portFile) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return fs.readFileSync(portFile, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      if (!['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1)); // espera curta e crescente
    }
  }
  return null; // continua ocupado: tenta de novo no próximo ciclo
}

/** Apaga um arquivo do perfil ignorando EBUSY/EPERM transitórios (o launchApp só precisa que ele não valha mais). */
function removeFileQuietly(file) {
  try { fs.rmSync(file, { force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* a leitura confere o conteúdo de qualquer forma */ }
}

/**
 * Abre o app com um perfil de usuário próprio e devolve { page, errors, proc, stop }.
 * `page.errors` junta erros de console, exceções e recursos que falharam (ligado desde o carregamento).
 * opts: { args: [], env: {}, timeout: ms }.
 */
// Sem ninguém usando a tela (sessão bloqueada, janela coberta) o Chromium reduz timers, renderização e mídia da janela
// em segundo plano e os testes de interface ficam instáveis. Estes parâmetros mantêm a janela 'ativa' só nos testes.
const ANTI_THROTTLE_FLAGS = [
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion'
];

async function launchApp(userDataDir, opts = {}) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  removeFileQuietly(portFile); // de uma execução anterior com o mesmo perfil

  // `opts.exe`: o programa instalado (teste do instalador); sem ele, o Electron do projeto abrindo a pasta do código
  const electron = opts.exe || require('electron');
  const proc = spawn(electron, [...(opts.exe ? [] : ['.']), `--user-data-dir=${userDataDir}`, '--remote-debugging-port=0', ...ANTI_THROTTLE_FLAGS, ...(opts.args || [])], {
    cwd: opts.exe ? path.dirname(opts.exe) : ROOT, stdio: 'ignore', windowsHide: false,
    // BF_VIDEOS_DIR: o app de teste nunca enxerga a pasta Vídeos de verdade (só uma pasta dentro do perfil temporário)
    env: mergeEnv(process.env, { BF_VIDEOS_DIR: path.join(userDataDir, 'videos'), ...(opts.env || {}) })
  });
  const session = { proc, userDataDir, page: null, browserUrl: null, stopped: false };
  session.stop = async () => {
    if (session.stopped) return;
    session.stopped = true;
    try { session.page?.ws.close(); } catch { /* ignorar */ }
    await closeBrowser(session);
    sessions.delete(session);
  };
  sessions.add(session);

  try {
    const deadline = Date.now() + (opts.timeout || 40000);
    let port = null;
    while (Date.now() < deadline && !port) {
      if (proc.exitCode !== null) throw new Error(`O app fechou antes de abrir a janela (código ${proc.exitCode}).`);
      const content = readPortFile(portFile);
      if (content) {
        const [first, browserPath] = content.split(/\r?\n/);
        if (Number(first) > 0 && browserPath) { port = Number(first); session.browserUrl = `ws://127.0.0.1:${port}${browserPath}`; }
      }
      if (!port) await sleep(150);
    }
    if (!port) throw new Error('O app não informou a porta de depuração a tempo.');

    let target = null;
    while (Date.now() < deadline && !target) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
      } catch { /* ainda subindo */ }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error('A janela do app não apareceu a tempo.');

    const page = await connect(target.webSocketDebuggerUrl);
    session.page = page;
    page.on('Runtime.exceptionThrown', (p) => page.errors.push(`exceção: ${p.exceptionDetails.exception?.description || p.exceptionDetails.text}`));
    page.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'assert') page.errors.push(`console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    });
    page.on('Log.entryAdded', ({ entry }) => {
      if (entry.level === 'error') page.errors.push(`log: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
    });
    // ao ligar, o Chromium repete as mensagens já guardadas: nada do carregamento inicial escapa
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Page.enable');
    await waitFor(page, "document.readyState === 'complete' && window.BF ? BF.ready.then(() => true) : false", 30000, 'interface carregada (BF.ready)');
    await sleep(300);
    return { page, proc, stop: session.stop, get errors() { return page.errors; }, userDataDir };
  } catch (err) {
    await session.stop();
    throw err;
  }
}

/**
 * Abre o app uma segunda vez com o MESMO perfil de uma instância que já está rodando e espera ele sair sozinho
 * (trava de instância única). Devolve { exitCode, ms } (exitCode null = continuou vivo até o prazo e foi encerrado).
 */
async function runSecondInstance(userDataDir, { timeout = 30000 } = {}) {
  const electron = require('electron');
  const proc = spawn(electron, ['.', `--user-data-dir=${userDataDir}`], { cwd: ROOT, stdio: 'ignore', windowsHide: false });
  const started = Date.now();
  while (proc.exitCode === null && Date.now() - started < timeout) await sleep(100);
  const exitCode = proc.exitCode;
  if (exitCode === null) killTree(proc.pid);
  return { exitCode, ms: Date.now() - started };
}

/** Fecha todos os apps abertos por launchApp (use no finally). */
async function cleanupAll() {
  for (const session of [...sessions]) await session.stop();
}

/**
 * Responde a um modal do BF.ui (confirm/prompt): true clica no botão principal, false em cancelar.
 * Com `text`, preenche o campo do prompt antes. Devolve { title, message } do modal respondido.
 */
async function answerModal(page, accept, { timeout = 15000, text } = {}) {
  await waitFor(page, "!!document.querySelector('.bf-modal')", timeout, 'um modal do BF.ui');
  return page.eval(`(() => {
    const modal = document.querySelector('.bf-modal');
    const seen = { title: modal.querySelector('h2')?.textContent ?? '', message: modal.querySelector('.bf-modal-msg')?.textContent ?? '' };
    ${text === undefined ? '' : `modal.querySelector('input').value = ${JSON.stringify(text)};`}
    modal.querySelector('[data-act="${accept ? 'ok' : 'cancel'}"]').click();
    return seen;
  })()`);
}

const modalOpen = (page) => page.eval("!!document.querySelector('.bf-modal')");

/** Falha se a página registrou erros de console/exceções. `ignore` = lista de RegExp aceitas. */
function assertNoConsoleErrors(page, ignore = []) {
  const errors = page.errors.filter((e) => !ignore.some((re) => re.test(e)));
  if (errors.length) throw new Error(`Erros no console do app:\n- ${errors.join('\n- ')}`);
}

/** Salva uma captura da janela (PNG) em `file`. */
async function screenshot(page, file) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
}

module.exports = {
  ROOT, sleep, mkTemp, removeDir, makeSampleVideo,
  connect, waitFor, launchApp, cleanupAll, answerModal, modalOpen, assertNoConsoleErrors, screenshot, readPortFile,
  runSecondInstance, processesUsing, mergeEnv
};
