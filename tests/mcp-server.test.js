'use strict';

/**
 * Servidor MCP do Braga Frame (src/mcp): a configuração (token, porta, opções), o servidor HTTP de verdade (autenticação, anti DNS rebinding, protocolo
 * JSON-RPC, lotes, limite de corpo, fila de ações, cancelamento), o serviço (configuração pronta para o agente, token novo, ligar e desligar) e a ponte
 * stdio. Um toolbox de mentira no lugar das ferramentas (elas têm o teste próprio: tests/mcp-toolbox.test.js); o app inteiro é conferido em
 * tests/e2e/mcp.e2e.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const McpConfig = require('../src/mcp/McpConfig');
const McpServer = require('../src/mcp/McpServer');
const McpService = require('../src/mcp/McpService');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-mcp-'));
const clean = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

/** Toolbox de mentira: `ler` (leitura), `agir` (ação, espera `gates.agir`), `lenta` (leitura que espera o cancelamento) e `falha` ({ error }). */
function fakeToolbox() {
  const events = [];
  const gates = { agir: [], lenta: [] };
  const tools = [
    { name: 'ler', kind: 'read', description: 'Lê algo.', inputSchema: { type: 'object', properties: { x: { type: 'number' } }, additionalProperties: false } },
    { name: 'agir', kind: 'action', description: 'Faz algo.', inputSchema: { type: 'object', properties: {} } },
    { name: 'lenta', kind: 'read', description: 'Espera.', inputSchema: { type: 'object', properties: {} } },
    { name: 'falha', kind: 'read', description: 'Falha.', inputSchema: { type: 'object', properties: {} } }
  ];
  return {
    events, gates,
    definitions: () => tools,
    kindOf: (name) => (tools.find((t) => t.name === name) || {}).kind || null,
    async execute(name, args, opts) {
      events.push(['start', name, opts.agent, opts.autoConfirm]);
      if (name === 'agir') { const g = defer(); gates.agir.push(g); await g.promise; events.push(['end', name]); return JSON.stringify({ done: args.n || 1 }); }
      if (name === 'lenta') {
        const g = defer();
        gates.lenta.push(g);
        await new Promise((resolve, reject) => { g.promise.then(resolve); opts.signal.addEventListener('abort', () => { events.push(['abort', name]); reject(Object.assign(new Error('x'), { code: 'CANCELLED' })); }); });
        return JSON.stringify({ ok: true });
      }
      if (name === 'falha') return JSON.stringify({ error: 'deu errado' });
      return JSON.stringify({ ok: true, args });
    }
  };
}

function request(port, { token, body, method = 'POST', host, origin, pathname = '/mcp', raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : (body === undefined ? '' : JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    // agent:false = uma conexão nova por requisição (cada teste liga um servidor novo na mesma porta preferida: uma conexão reaproveitada estaria morta)
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* vazio */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function boot({ toolbox = fakeToolbox(), autoConfirm = false } = {}) {
  const dir = tmp();
  const changes = [];
  const svc = new McpService({ configDir: dir, getToolbox: () => toolbox, clipboard: null, onChange: () => changes.push(Date.now()) });
  if (autoConfirm) svc.config.setOptions({ autoConfirm: true });
  await svc.setEnabled(true);
  const { port } = svc.status();
  const token = svc.config.getToken();
  const rpc = (method, params, id = 1) => request(port, { token, body: { jsonrpc: '2.0', id, method, params } });
  const call = (name, args, id = 1) => rpc('tools/call', { name, arguments: args }, id);
  return { dir, svc, toolbox, port, token, rpc, call, changes, close: async () => { await svc.shutdown(); clean(dir); } };
}

// ---------------------------------------------------------------- configuração

test('McpConfig: desligado por padrão, porta própria (não a do BDS), sem token até alguém precisar; valores inválidos no arquivo voltam ao padrão', () => {
  const dir = tmp();
  try {
    const cfg = new McpConfig({ dir });
    assert.equal(cfg.isEnabled(), false);
    assert.equal(cfg.port, 47822);
    assert.notEqual(cfg.port, 47821, 'o BDS usa a 47821: os dois podem ficar ligados ao mesmo tempo');
    assert.equal(cfg.getToken(), '');
    assert.equal(cfg.autoConfirms(), false);
    assert.equal(fs.existsSync(cfg.file), false, 'ler não cria arquivo');
    fs.writeFileSync(cfg.file, JSON.stringify({ enabled: 'sim', port: 80, token: 'curto', autoConfirm: 'talvez' }));
    const bad = new McpConfig({ dir });
    assert.deepEqual([bad.isEnabled(), bad.port, bad.getToken(), bad.autoConfirms()], [false, 47822, '', false], 'tudo o que não é válido é ignorado');
    fs.writeFileSync(cfg.file, '{não é json');
    assert.equal(new McpConfig({ dir }).isEnabled(), false, 'arquivo corrompido: padrão, sem lançar');
    fs.writeFileSync(cfg.file, '[1,2]');
    assert.equal(new McpConfig({ dir }).port, 47822);
  } finally { clean(dir); }
});

test('McpConfig: token de 256 bits que persiste, setEnabled gera o primeiro, regenerar troca, opções só aceitam booleano, porta só válida', () => {
  const dir = tmp();
  try {
    const cfg = new McpConfig({ dir });
    assert.equal(cfg.setEnabled(true), true);
    const first = cfg.getToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(new McpConfig({ dir }).getToken(), first, 'persiste');
    assert.equal(cfg.ensureToken(), first, 'ensureToken não troca um token que já existe');
    const second = cfg.regenerateToken();
    assert.notEqual(second, first);
    assert.match(second, /^[0-9a-f]{64}$/);
    cfg.setOptions({ autoConfirm: 'sim' });
    assert.equal(cfg.autoConfirms(), false, 'só booleano');
    cfg.setOptions({ autoConfirm: true });
    assert.equal(new McpConfig({ dir }).autoConfirms(), true);
    cfg.setPort(80);
    cfg.setPort('50000');
    assert.equal(cfg.port, 47822, 'porta inválida é ignorada');
    cfg.setPort(50123);
    assert.equal(new McpConfig({ dir }).port, 50123);
    assert.equal(cfg.setEnabled(false), false);
    assert.equal(new McpConfig({ dir }).isEnabled(), false);
    assert.equal(fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), false, 'nenhum .tmp esquecido');
  } finally { clean(dir); }
});

test('McpConfig: a ponte stdio é gravada ao lado, igual à do código, e regravar não muda nada', () => {
  const dir = tmp();
  try {
    const cfg = new McpConfig({ dir });
    const file = cfg.writeBridge();
    assert.equal(file, path.join(dir, 'mcp-bridge.js'));
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp', 'bridge.js'), 'utf8');
    assert.equal(fs.readFileSync(file, 'utf8'), source);
    const mtime = fs.statSync(file).mtimeMs;
    cfg.writeBridge();
    assert.equal(fs.statSync(file).mtimeMs, mtime, 'igual: não regrava');
    fs.writeFileSync(file, '// velha');
    cfg.writeBridge();
    assert.equal(fs.readFileSync(file, 'utf8'), source, 'desatualizada: troca');
  } finally { clean(dir); }
});

// ---------------------------------------------------------------- servidor HTTP

test('servidor: recusa sem token, com token errado, Host que não é o local, Origin de navegador, método e caminho errados', async () => {
  const s = await boot();
  try {
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await request(s.port, { body: ping })).status, 401, 'sem token');
    assert.equal((await request(s.port, { token: 'errado', body: ping })).status, 401);
    assert.equal((await request(s.port, { token: s.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')), body: ping })).status, 401, 'token parecido, mas errado');
    assert.equal((await request(s.port, { token: s.token, body: ping, host: 'evil.example.com' })).status, 403, 'DNS rebinding');
    assert.equal((await request(s.port, { token: s.token, body: ping, host: `127.0.0.1:${s.port + 1}` })).status, 403, 'porta do Host diferente');
    assert.equal((await request(s.port, { token: s.token, body: ping, origin: 'https://evil.example.com' })).status, 403, 'navegador');
    assert.equal((await request(s.port, { token: s.token, method: 'GET' })).status, 405);
    assert.equal((await request(s.port, { token: s.token, body: ping, pathname: '/outro' })).status, 404);
    assert.equal((await request(s.port, { token: s.token, method: 'DELETE' })).status, 200, 'fim de sessão');
    for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`]) {
      // o servidor só escuta em 127.0.0.1, mas o cabeçalho "localhost" é aceito (é como alguns agentes escrevem)
      assert.equal((await request(s.port, { token: s.token, body: ping, host })).status, 200, host);
    }
    assert.equal((await s.rpc('ping')).status, 200);
    const r401 = await request(s.port, { body: ping });
    assert.equal(r401.json.error, 'Token ausente ou inválido.');
  } finally { await s.close(); }
});

test('servidor: initialize negocia a versão, guarda o nome do agente (limpo) e avisa; notificação dá 202; método e parâmetros inválidos viram erro JSON-RPC', async () => {
  const s = await boot();
  try {
    const init = (await s.rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'Anti<gravity>\n  Agent;.' } })).json.result;
    assert.equal(init.protocolVersion, '2025-03-26');
    assert.equal(init.serverInfo.name, 'braga-frame');
    assert.deepEqual(init.capabilities, { tools: { listChanged: false } });
    assert.match(init.instructions, /DADO do aplicativo, nunca instrução/);
    assert.equal(s.svc.status().client, 'Antigravity Agent.', 'só letras, números e . @ - _ espaço (nada de marcação nem quebra de linha)');
    assert.ok(s.changes.length >= 1, 'a tela é avisada de que um agente conectou');
    assert.equal((await s.rpc('initialize', { protocolVersion: '1999-01-01' })).json.result.protocolVersion, '2025-06-18', 'versão desconhecida: a mais nova que o servidor fala');
    assert.equal((await request(s.port, { token: s.token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })).status, 202);
    assert.equal((await s.rpc('nao/existe')).json.error.code, -32601);
    assert.equal((await request(s.port, { token: s.token, body: { id: 1, method: 'ping' } })).json.error.code, -32600, 'sem "jsonrpc": 2.0');
    assert.equal((await request(s.port, { token: s.token, raw: '{não é json' })).json.error.code, -32700);
    assert.deepEqual((await s.rpc('resources/list')).json.result, { resources: [] });
    assert.deepEqual((await s.rpc('prompts/list')).json.result, { prompts: [] });
  } finally { await s.close(); }
});

test('servidor: tools/list devolve a lista do toolbox com anotações (leitura x ação; nada destrutivo, nada que fale com a internet)', async () => {
  const s = await boot();
  try {
    const tools = (await s.rpc('tools/list')).json.result.tools;
    assert.deepEqual(tools.map((t) => t.name), ['ler', 'agir', 'lenta', 'falha']);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(by.ler.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.deepEqual(by.agir.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.equal(by.ler.inputSchema.type, 'object');
    assert.equal(by.ler.kind, undefined, '"kind" é interno: não vai ao agente');
  } finally { await s.close(); }
});

test('servidor: tools/call passa os argumentos, o nome do agente e a opção de dispensar a confirmação; { error } vira isError; parâmetros ruins viram -32602', async () => {
  const s = await boot();
  try {
    await s.rpc('initialize', { clientInfo: { name: 'Claude' } });
    const ok = (await s.call('ler', { x: 7 })).json.result;
    assert.equal(ok.isError, false);
    assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true, args: { x: 7 } });
    assert.deepEqual(s.toolbox.events.at(-1), ['start', 'ler', 'Claude', false]);
    assert.equal((await s.call('falha', {})).json.result.isError, true);
    assert.equal((await s.rpc('tools/call', { arguments: {} })).json.error.code, -32602, 'sem nome');
    assert.equal((await s.rpc('tools/call', { name: 'x'.repeat(81) })).json.error.code, -32602, 'nome grande demais');
    assert.equal((await s.rpc('tools/call', { name: 'ler', arguments: [1] })).json.error.code, -32602, 'argumentos que não são um objeto');
    assert.equal((await s.rpc('tools/call', { name: 'ler', arguments: null })).json.error.code, -32602);
    const noArgs = (await s.rpc('tools/call', { name: 'ler' })).json.result;
    assert.deepEqual(JSON.parse(noArgs.content[0].text).args, {}, 'sem "arguments": objeto vazio');
    assert.ok(s.svc.status().calls >= 3, 'as chamadas são contadas');
  } finally { await s.close(); }
  const auto = await boot({ autoConfirm: true });
  try {
    await auto.call('ler', {});
    assert.equal(auto.toolbox.events.at(-1)[3], true, 'o usuário dispensou a confirmação: o toolbox sabe');
    auto.svc.setOptions({ autoConfirm: false });
    await auto.call('ler', {});
    assert.equal(auto.toolbox.events.at(-1)[3], false, 'e a mudança vale na hora, sem reiniciar');
  } finally { await auto.close(); }
});

test('servidor: lote de requisições, limite de itens, limite de corpo', async () => {
  const s = await boot();
  try {
    const batch = await request(s.port, { token: s.token, body: [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }] });
    assert.equal(batch.status, 200);
    assert.deepEqual(batch.json.map((r) => r.id), [1, 2], 'a notificação do lote não responde');
    assert.equal((await request(s.port, { token: s.token, body: [] })).status, 400);
    assert.equal((await request(s.port, { token: s.token, body: Array.from({ length: 21 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' })) })).status, 400, 'mais de 20 itens');
    const big = await request(s.port, { token: s.token, raw: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { x: 'a'.repeat(300 * 1024) } }) });
    assert.equal(big.status, 413);
    assert.equal((await s.rpc('ping')).status, 200, 'o servidor segue vivo depois de recusar');
  } finally { await s.close(); }
});

test('servidor: as AÇÕES entram numa fila (uma confirmação por vez); a leitura passa na frente; o limite de chamadas simultâneas responde "ocupado"', async () => {
  const s = await boot();
  try {
    const a1 = s.call('agir', { n: 1 }, 1);
    const a2 = s.call('agir', { n: 2 }, 2);
    await sleep(120);
    assert.equal(s.toolbox.events.filter((e) => e[0] === 'start' && e[1] === 'agir').length, 1, 'a segunda ação só começa quando a primeira termina');
    const read = await s.call('ler', {}, 3);
    assert.equal(read.json.result.isError, false, 'uma leitura não espera a fila de ações');
    s.toolbox.gates.agir[0].resolve();
    await sleep(120);
    assert.equal(s.toolbox.events.filter((e) => e[0] === 'start' && e[1] === 'agir').length, 2);
    s.toolbox.gates.agir[1].resolve();
    assert.deepEqual([(await a1).json.result.content[0].text, (await a2).json.result.content[0].text], ['{"done":1}', '{"done":2}']);
    assert.deepEqual(s.toolbox.events.filter((e) => e[1] === 'agir').map((e) => e[0]), ['start', 'end', 'start', 'end'], 'em ordem, sem sobrepor');

    // saturação: 8 em andamento, a 9ª volta "ocupado"
    const held = Array.from({ length: 8 }, (_, i) => s.call('lenta', {}, 100 + i));
    await sleep(200);
    const ninth = await s.call('ler', {}, 200);
    assert.equal(ninth.json.result.isError, true);
    assert.match(ninth.json.result.content[0].text, /ocupado/);
    for (const g of s.toolbox.gates.lenta) g.resolve();
    for (const r of await Promise.all(held)) assert.equal(r.json.result.isError, false);
    assert.equal((await s.call('ler', {}, 201)).json.result.isError, false, 'liberou: volta a atender');
  } finally { await s.close(); }
});

test('servidor: se o agente desconecta no meio de uma ação, a espera é cancelada (o toolbox recebe o sinal)', async () => {
  const s = await boot();
  try {
    const req = http.request({ host: '127.0.0.1', port: s.port, path: '/mcp', method: 'POST', agent: false, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.token}` } });
    req.on('error', () => {});
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lenta', arguments: {} } }));
    await sleep(200);
    assert.equal(s.toolbox.events.some((e) => e[0] === 'start' && e[1] === 'lenta'), true);
    req.destroy();
    await sleep(300);
    assert.equal(s.toolbox.events.some((e) => e[0] === 'abort'), true, 'o sinal de cancelamento chegou');
    assert.equal((await s.rpc('ping')).status, 200);
  } finally { await s.close(); }
});

test('servidor: porta ocupada cai numa livre; parar fecha a porta; sem toolbox é erro interno, não queda', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  const server = new McpServer({ getToolbox: () => fakeToolbox(), getToken: () => 'a'.repeat(64) });
  try {
    const got = await server.start(busy);
    assert.notEqual(got, busy);
    assert.equal(server.running, true);
    assert.equal(await server.start(busy), got, 'ligar de novo devolve a mesma porta');
    await server.stop();
    assert.equal(server.running, false);
    await assert.rejects(() => request(got, { token: 'a'.repeat(64), body: {} }), 'fechada');
    await server.stop(); // parar de novo não lança
  } finally { blocker.close(); await server.stop(); }
  const none = new McpServer({ getToolbox: () => null, getToken: () => 'b'.repeat(64) });
  const port = await none.start(0);
  try {
    const res = await request(port, { token: 'b'.repeat(64), body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.equal(res.json.error.code, -32603);
    assert.equal(res.json.error.message, 'Erro interno.', 'nenhum detalhe interno vaza');
  } finally { await none.stop(); }
});

// ---------------------------------------------------------------- serviço

test('McpService: desligado não escuta; ligar grava a configuração e a ponte e mostra a porta (sem o token); desligar fecha; reiniciar religa sozinho', async () => {
  const dir = tmp();
  const make = () => new McpService({ configDir: dir, getToolbox: () => fakeToolbox(), clipboard: null });
  try {
    const off = make();
    await off.init();
    assert.deepEqual([off.status().enabled, off.status().running, off.status().url], [false, false, '']);
    const on = make();
    const st = await on.setEnabled(true);
    assert.deepEqual([st.enabled, st.running, st.autoConfirm, st.error], [true, true, false, '']);
    assert.match(st.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(JSON.stringify(st).includes(on.config.getToken()), false, 'o estado público não leva o token');
    assert.ok(fs.existsSync(path.join(dir, 'mcp-bridge.js')));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8'));
    assert.deepEqual([saved.enabled, saved.port], [true, st.port], 'a porta realmente usada fica guardada');
    await on.shutdown();
    const again = make(); // "reiniciar o app"
    await again.init();
    assert.equal(again.status().running, true, 'ligado antes de fechar: volta ligado');
    const off2 = await again.setEnabled(false);
    assert.deepEqual([off2.enabled, off2.running], [false, false]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'mcp.json'), 'utf8')).enabled, false);
    // não conseguir abrir a porta: desliga, diz por quê (sem detalhes técnicos) e não derruba
    const broken = make();
    broken.server.start = async () => { throw Object.assign(new Error('EACCES: permissão negada em 127.0.0.1'), { code: 'EACCES' }); };
    await assert.rejects(() => broken.setEnabled(true), /Não foi possível abrir a porta local para os agentes\./);
    assert.equal(broken.config.isEnabled(), false, 'falhou: fica desligado');
    assert.match(broken.status().error, /porta local/);
    assert.equal(broken.status().error.includes('EACCES'), false);
    fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ enabled: true, port: 50999, token: 'c'.repeat(64) }));
    const failInit = make();
    failInit.server.start = async () => { throw new Error('ocupada'); };
    await failInit.init(); // nunca derruba a abertura do app
    assert.equal(failInit.status().running, false);
  } finally { clean(dir); }
});

test('McpService: configuração pronta para o Antigravity (serverUrl), HTTP e comando; vai SÓ para a área de transferência; token novo invalida o antigo; a opção de dispensar a confirmação', async () => {
  const dir = tmp();
  let clip = null;
  const svc = new McpService({ configDir: dir, getToolbox: () => fakeToolbox(), clipboard: { writeText: (t) => { clip = t; } } });
  try {
    assert.throws(() => svc.buildConfig('http'), /Ligue "Conectar agentes \(MCP\)" primeiro\./, 'desligado: não há o que copiar');
    await svc.setEnabled(true);
    const { port } = svc.status();
    const token = svc.config.getToken();
    const url = `http://127.0.0.1:${port}/mcp`;
    assert.deepEqual(JSON.parse(svc.buildConfig('antigravity')), { mcpServers: { 'braga-frame': { serverUrl: url, headers: { Authorization: `Bearer ${token}` } } } });
    assert.deepEqual(JSON.parse(svc.buildConfig('http')), { mcpServers: { 'braga-frame': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } });
    const stdio = JSON.parse(svc.buildConfig('stdio')).mcpServers['braga-frame'];
    assert.equal(stdio.command, 'node');
    assert.deepEqual(stdio.args, [path.join(dir, 'mcp-bridge.js'), path.join(dir, 'mcp.json')]);
    assert.equal(JSON.stringify(stdio).includes(token), false, 'o comando não leva o token na linha: a ponte o lê do arquivo');
    assert.throws(() => svc.buildConfig('xyz'), /Formato de agente desconhecido\./);
    assert.deepEqual(svc.copyConfig('http'), { kind: 'http' });
    assert.equal(JSON.parse(clip).mcpServers['braga-frame'].headers.Authorization, `Bearer ${token}`);
    const noClip = new McpService({ configDir: dir, getToolbox: () => null, clipboard: null });
    await noClip.setEnabled(true).catch(() => {});
    assert.throws(() => noClip.copyConfig('http'), /área de transferência não está disponível/);
    await noClip.shutdown();

    // token novo: o antigo deixa de valer sem reiniciar
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await request(port, { token, body: ping })).status, 200);
    svc.regenerateToken();
    assert.equal((await request(port, { token, body: ping })).status, 401);
    assert.equal((await request(port, { token: svc.config.getToken(), body: ping })).status, 200);
    // opções
    assert.equal(svc.setOptions({ autoConfirm: true }).autoConfirm, true);
    assert.equal(svc.setOptions({}).autoConfirm, true, 'sem o campo: não muda');
    assert.equal(svc.setOptions({ autoConfirm: false }).autoConfirm, false);
  } finally { await svc.shutdown(); clean(dir); }
});

// ---------------------------------------------------------------- ponte stdio

/** Roda a ponte com o mcp.json do serviço e conversa linha a linha. */
function runBridge(service) {
  const child = spawn(process.execPath, [service.config.writeBridge(), service.config.file], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lines.push(JSON.parse(l)); }
  });
  const ask = async (msg) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    const end = Date.now() + 15000;
    while (Date.now() < end) { const hit = lines.find((l) => l.id === msg.id); if (hit) return hit; await sleep(20); }
    throw new Error(`a ponte não respondeu a ${msg.method}`);
  };
  return { child, lines, ask, send: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`), exit: () => new Promise((resolve) => { child.on('exit', resolve); child.stdin.end(); }) };
}

test('ponte stdio: repassa initialize, tools/list e tools/call ao servidor; notificação não responde; fechar a entrada encerra o processo', async () => {
  const dir = tmp();
  const svc = new McpService({ configDir: dir, getToolbox: () => fakeToolbox(), clipboard: null });
  await svc.setEnabled(true);
  const b = runBridge(svc);
  try {
    assert.equal((await b.ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Ponte' } } })).result.serverInfo.name, 'braga-frame');
    b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal((await b.ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 4);
    const out = await b.ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ler', arguments: { x: 1 } } });
    assert.deepEqual(JSON.parse(out.result.content[0].text).args, { x: 1 });
    assert.deepEqual(b.lines.map((l) => l.id), [1, 2, 3], 'a notificação não gerou resposta');
    assert.equal(svc.status().client, 'Ponte');
    assert.equal(await b.exit(), 0, 'termina sozinha ao fechar a entrada');
  } finally { b.child.kill(); await svc.shutdown(); clean(dir); }
});

test('ponte stdio: token recusado, servidor desligado e aplicativo fechado viram erros claros em português (nunca silêncio)', async () => {
  const dir = tmp();
  const svc = new McpService({ configDir: dir, getToolbox: () => fakeToolbox(), clipboard: null });
  await svc.setEnabled(true);
  const cfgFile = path.join(dir, 'mcp.json');
  try {
    // token que o servidor não conhece
    const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    fs.writeFileSync(cfgFile, JSON.stringify({ ...saved, token: 'd'.repeat(64) }));
    let b = runBridge(svc);
    assert.match((await b.ask({ jsonrpc: '2.0', id: 1, method: 'ping' })).error.message, /Token recusado\. Copie a configuração de novo/);
    await b.exit();
    // desligado no arquivo
    fs.writeFileSync(cfgFile, JSON.stringify({ ...saved, enabled: false }));
    b = runBridge(svc);
    assert.match((await b.ask({ jsonrpc: '2.0', id: 1, method: 'ping' })).error.message, /servidor MCP está desligado/);
    await b.exit();
    // ligado no arquivo, mas o app não está escutando (fechado)
    fs.writeFileSync(cfgFile, JSON.stringify(saved));
    await svc.shutdown();
    b = runBridge(svc);
    assert.match((await b.ask({ jsonrpc: '2.0', id: 1, method: 'ping' })).error.message, /Braga Frame não está aberto/);
    // sem id (notificação) e sem servidor: nada é escrito
    b.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await sleep(200);
    assert.equal(b.lines.length, 1);
    await b.exit();
  } finally { await svc.shutdown(); clean(dir); }
});
