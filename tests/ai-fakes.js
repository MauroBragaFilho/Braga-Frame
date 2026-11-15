'use strict';

/**
 * Utilitários dos testes da IA na nuvem (tests/ai-*.test.js, tests/analysis-ai-*.test.js, tests/e2e/analysis-ia.e2e.js): um servidor HTTP
 * LOCAL de verdade que imita a API `chat/completions` compatível com a OpenAI (respostas válidas, JSON inválido, 429 com Retry-After,
 * 401, queda no meio, atraso, horários inventados e desfecho inexistente) e uma transcrição sintética com momentos conhecidos.
 * Não é um teste: o nome não termina em ".test.js".
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY = 'sk-bf-test-0123456789abcdefghijklmnopqrstuvwxyz'; // chave FALSA: os testes provam que ela nunca aparece em lugar nenhum

function tmpDir(prefix = 'bf-ai-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}

/** Corpo de uma resposta de chat válida (`content` = texto que o "modelo" devolveu). */
function chatBody(content, { promptTokens = 1200, completionTokens = 300, finish = 'stop' } = {}) {
  return { id: 'chatcmpl-test', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } };
}

/**
 * Sobe o servidor. `handler(call)` recebe { n, path, headers, body (objeto), raw } e devolve uma ação:
 *   { status?, json?, text?, headers?, delayMs? }      resposta normal (padrão 200)
 *   { hang: true }                                      nunca responde (a conexão fica aberta)
 *   { drop: true }                                      derruba a conexão sem responder
 *   { dropMidway: 'texto' }                             manda cabeçalho e metade do corpo e derruba
 * Registra todas as requisições em `calls`.
 */
async function startMockAi(handler) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const call = { n: calls.length + 1, method: req.method, path: req.url, headers: req.headers, body, raw };
      calls.push(call);
      let action;
      try { action = await handler(call); } catch (err) { action = { status: 500, json: { error: { message: `handler: ${err.message}` } } }; }
      action = action || {};
      if (action.hang) return;
      if (action.drop) { req.socket.destroy(); return; }
      if (action.delayMs) await new Promise((r) => setTimeout(r, action.delayMs));
      if (res.destroyed) return;
      if (action.dropMidway) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100000' });
        res.write(String(action.dropMidway));
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      const payload = action.text !== undefined ? action.text : JSON.stringify(action.json !== undefined ? action.json : {});
      res.writeHead(action.status || 200, { 'content-type': action.text !== undefined ? 'text/plain' : 'application/json', ...(action.headers || {}) });
      res.end(payload);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    calls,
    port,
    base: `http://127.0.0.1:${port}/v1`,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

// ---------- transcrição sintética ----------

const clk = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * Transcrição de `minutes` minutos: uma fala de 4 s a cada 5 s ("papo" neutro numerado) e, nos instantes de `moments`, uma sequência com
 * um desfecho conhecido. Devolve { cues, duration, moments } com cada momento = { at, setup, punch, start, end } (horários reais das falas).
 */
function makeTranscript({ minutes = 10, moments = [{ at: 120, punch: 'o bicho nem dropou couro' }] } = {}) {
  const duration = minutes * 60;
  const cues = [];
  const specials = new Map();
  for (const m of moments) specials.set(Math.floor(m.at / 5) * 5, m);
  const out = [];
  for (let t = 0; t < duration - 5; t += 5) {
    const m = specials.get(t);
    if (m) {
      const setup = m.setup || 'eu preciso muito de couro agora';
      cues.push({ start: t, end: t + 4, text: setup });
      cues.push({ start: t + 5, end: t + 9, text: 'que rato bonito não mata não' });
      cues.push({ start: t + 10, end: t + 14, text: m.punch });
      cues.push({ start: t + 14.5, end: t + 18, text: '*Risos*', laugh: true });
      out.push({ ...m, start: t, end: t + 18 });
      t += 15; // pula os slots usados
    } else {
      cues.push({ start: t, end: t + 4, text: `conversa tranquila número ${t / 5} sobre o servidor e a build` });
    }
  }
  return { cues, duration, moments: out };
}

/** Texto de uma resposta `cuts` com os candidatos informados (start/end em segundos viram m:ss). */
function cutsJson(list) {
  return JSON.stringify({
    cuts: list.map((c) => ({
      start: typeof c.start === 'number' ? clk(c.start) : c.start, end: typeof c.end === 'number' ? clk(c.end) : c.end,
      title: c.title || 'Momento engraçado', category: c.category || 'Engraçado', relevance: c.relevance == null ? 0.9 : c.relevance,
      hook: c.hook || 'gancho', punchline: c.punchline, reasons: c.reasons || ['arco completo'], layout: c.layout || 'conversa', ...(c.flags ? { flags: c.flags } : {}),
      ...(c.keywords ? { keywords: c.keywords } : {}), ...(c.theme ? { theme: c.theme } : {})
    }))
  });
}

/** Quantas vezes o corpo do pedido cita o texto (a chave nunca pode aparecer em nada que o app grava). */
function mentions(value, text) {
  return String(typeof value === 'string' ? value : JSON.stringify(value)).includes(text);
}

/** Todos os arquivos (recursivo) de uma pasta, com o conteúdo, para procurar a chave. */
function readAll(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readAll(p)); else out.push({ file: p, text: fs.readFileSync(p).toString('latin1') });
  }
  return out;
}

/** safeStorage de mentira: "cifra" invertendo e somando 1 a cada byte (nunca contém a chave em claro). */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from(Buffer.from(String(text), 'utf8').map((b) => (b + 1) & 0xff).reverse()),
    decryptString: (buf) => Buffer.from(Buffer.from(buf).reverse().map((b) => (b - 1) & 0xff)).toString('utf8')
  };
}

module.exports = { KEY, tmpDir, cleanup, chatBody, startMockAi, makeTranscript, cutsJson, clk, mentions, readAll, fakeSafeStorage };
