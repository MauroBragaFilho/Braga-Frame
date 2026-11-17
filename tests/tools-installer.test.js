'use strict';

/**
 * ToolInstaller com servidor HTTP local de verdade (node:http) servindo zip/tar.gz gerados no teste
 * e extração real com o tar do sistema.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ToolInstaller } = require('../src/core/tools/ToolInstaller');
const registry = require('../src/core/tools/registry');
const { tmpDir, cleanup, makeZip, makeTarGz, startServer, sendBuffer, makeEntry, listTree, sha256 } = require('./tools-fixtures');

const T = { timeout: 30000 };

async function withEnv(fn) {
  const base = tmpDir();
  try { await fn({ base, toolsDir: path.join(base, 'tools') }); } finally { cleanup(base); }
}

function makeInstaller(toolsDir, entries, extra = {}) {
  return new ToolInstaller({
    toolsDir, entries, platform: 'win32', arch: 'x64', allowLoopbackHttp: true, attempts: 1, backoffMs: 1, ...extra
  });
}

const demoZip = (extra = []) => makeZip([
  { name: 'demo.exe', data: 'MZ-programa-de-teste' },
  { name: 'lib/', },
  { name: 'lib/dados.txt', data: 'dados' },
  ...extra
]);

/** Servidor que serve o mesmo buffer em qualquer caminho. */
const serveAlways = (buf) => (req, res) => sendBuffer(res, buf);

/** Servidor que manda só o começo e segura a conexão até o cliente desistir. */
function holdingServer(buf, sentBytes = 65536) {
  const state = { closed: null };
  state.closedPromise = new Promise((resolve) => { state.closed = resolve; });
  const handler = (req, res) => {
    res.writeHead(200, { 'Content-Length': buf.length });
    res.write(buf.subarray(0, sentBytes));
    res.on('close', () => state.closed(true));
  };
  return { handler, state };
}

/** Nada fora de <base>/tools e nenhuma pasta de trabalho (.tmp) esquecida dentro dela. */
const noResidue = (base) => {
  const all = listTree(base);
  assert.deepEqual(all.filter((p) => p !== 'tools' && !p.startsWith('tools/')), [], 'sobrou lixo fora da pasta de ferramentas');
  assert.deepEqual(all.filter((p) => p.startsWith('tools/.tmp')), [], 'sobrou pasta de trabalho (.tmp)');
};

// ------------------------------------------------------------------ sucesso

test('instala um .zip: baixa, confere tamanho e SHA-256, extrai e grava o manifesto', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf });
      const inst = makeInstaller(toolsDir, [entry]);
      const events = [];
      inst.on('progress', (e) => events.push(e));

      const res = await inst.install('demotool');
      const finalDir = path.join(toolsDir, 'demotool', '1.0.0');
      assert.equal(res.alreadyInstalled, false);
      assert.equal(res.dir, finalDir);
      assert.equal(res.exe, path.join(finalDir, 'demo.exe'));
      assert.equal(fs.readFileSync(res.exe, 'utf8'), 'MZ-programa-de-teste');
      assert.equal(fs.readFileSync(path.join(finalDir, 'lib', 'dados.txt'), 'utf8'), 'dados');

      const manifest = JSON.parse(fs.readFileSync(path.join(finalDir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.id, 'demotool');
      assert.equal(manifest.version, '1.0.0');
      assert.equal(manifest.file, 'demo.zip');
      assert.equal(manifest.sha256, sha256(buf));
      assert.equal(manifest.size, buf.length);
      assert.equal(manifest.exe, 'demo.exe');
      assert.equal(manifest.exeSize, Buffer.byteLength('MZ-programa-de-teste'));
      assert.equal(manifest.source, entry.source);
      assert.equal(manifest.url, entry.assets['win32-x64'].url);
      assert.ok(!Number.isNaN(Date.parse(manifest.installedAt)));

      // só a pasta da instalação: nada de .part, .tmp, pasta de extração
      assert.deepEqual(listTree(toolsDir), [
        'demotool', 'demotool/1.0.0', 'demotool/1.0.0/demo.exe', 'demotool/1.0.0/lib', 'demotool/1.0.0/lib/dados.txt', 'demotool/1.0.0/manifest.json'
      ]);

      // o registro enxerga a instalação (reconferida no disco)
      assert.equal(inst.resolveInstalled('demotool'), res.exe);
      assert.equal(registry.resolveInstalled(toolsDir, 'demotool', { entries: [entry], platform: 'win32', arch: 'x64' }), res.exe);
      const [st] = inst.status();
      assert.equal(st.installed, true);
      assert.equal(st.busy, false);
      noResidue(base);

      // progresso: fases em ordem, download cresce até 100%, fecha em "done"
      const phases = [...new Set(events.map((e) => e.phase))];
      assert.deepEqual(phases, ['prepare', 'download', 'verify', 'extract', 'install', 'done']);
      const dl = events.filter((e) => e.phase === 'download');
      assert.equal(dl[dl.length - 1].percent, 100);
      assert.equal(dl[dl.length - 1].receivedBytes, buf.length);
      assert.equal(events[events.length - 1].phase, 'done');
      assert.ok(events.every((e) => e.id === 'demotool' && e.label === 'Ferramenta de teste'));
    } finally { await srv.close(); }
  });
});

test('instala um .tar.gz que traz tudo numa pasta externa (stripComponents)', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const buf = makeTarGz([
      { name: 'tool-2.0/', type: '5' },
      { name: 'tool-2.0/bin/', type: '5' },
      { name: 'tool-2.0/bin/tool.exe', data: 'binario' },
      { name: 'tool-2.0/LICENSE', data: 'MIT' }
    ]);
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, file: 'tool-2.0.tar.gz', exe: 'bin/tool.exe', asset: { stripComponents: 1 } });
      const inst = makeInstaller(toolsDir, [entry]);
      const res = await inst.install('demotool');
      assert.equal(fs.readFileSync(res.exe, 'utf8'), 'binario');
      assert.equal(fs.readFileSync(path.join(res.dir, 'LICENSE'), 'utf8'), 'MIT');
      assert.ok(!fs.existsSync(path.join(res.dir, 'tool-2.0')), 'a pasta externa não pode sobrar dentro da instalação');
      assert.equal(inst.resolveInstalled('demotool'), res.exe);
      assert.deepEqual(fs.readdirSync(toolsDir), ['demotool']);
    } finally { await srv.close(); }
  });
});

test('stripComponents errado (pacote sem a pasta externa esperada) não instala', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = makeZip([{ name: 'a.exe', data: 'x' }, { name: 'b.txt', data: 'y' }]);
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, exe: 'a.exe', asset: { stripComponents: 1 } })]);
      await assert.rejects(inst.install('demotool'), { code: 'EXE_MISSING' });
      noResidue(base);
      assert.deepEqual(fs.readdirSync(toolsDir), []);
    } finally { await srv.close(); }
  });
});

test('arquivo único (estilo yt-dlp.exe): o próprio download vira o executável', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const buf = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]);
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, file: 'yt-dlp.exe', exe: 'yt-dlp.exe', version: '2025.10.01' });
      const inst = makeInstaller(toolsDir, [entry]);
      const res = await inst.install('demotool');
      assert.deepEqual(fs.readFileSync(res.exe), buf);
      assert.deepEqual(listTree(toolsDir), ['demotool', 'demotool/2025.10.01', 'demotool/2025.10.01/manifest.json', 'demotool/2025.10.01/yt-dlp.exe']);
      assert.equal(inst.resolveInstalled('demotool'), res.exe);
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ integridade

test('SHA-256 errado: rejeita e não instala nada', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, asset: { sha256: sha256(Buffer.from('outro conteudo')) } });
      const inst = makeInstaller(toolsDir, [entry], { attempts: 3 });
      const events = [];
      inst.on('progress', (e) => events.push(e));
      await assert.rejects(inst.install('demotool'), (err) => {
        assert.equal(err.code, 'CHECKSUM_MISMATCH');
        assert.match(err.message, /integridade/);
        return true;
      });
      assert.equal(srv.requests.length, 1, 'erro de integridade não deve ser repetido');
      assert.deepEqual(listTree(toolsDir), []);
      noResidue(base);
      assert.equal(inst.resolveInstalled('demotool'), null);
      assert.equal(inst.status()[0].installed, false);
      assert.equal(inst.isBusy('demotool'), false);
      assert.equal(events[events.length - 1].phase, 'error');
    } finally { await srv.close(); }
  });
});

test('tamanho errado (menor ou maior que o declarado): rejeita e não instala', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    // Com Content-Length e sem (chunked): o servidor entrega o arquivo certo, mas a entrada declara outro tamanho.
    const servers = [
      await startServer(serveAlways(buf)),
      await startServer((req, res) => { res.writeHead(200); res.write(buf.subarray(0, 100)); res.end(buf.subarray(100)); })
    ];
    try {
      for (const srv of servers) {
        for (const delta of [-10, +10]) {
          const entry = makeEntry({ base: srv.base, buf, asset: { size: buf.length + delta } });
          const inst = makeInstaller(toolsDir, [entry]);
          await assert.rejects(inst.install('demotool'), { code: 'SIZE_MISMATCH' }, `servidor ${srv.base}, delta ${delta}`);
          assert.deepEqual(listTree(toolsDir), []);
          noResidue(base);
        }
      }
    } finally { for (const s of servers) await s.close(); }
  });
});

test('servidor que manda bytes demais é cortado sem baixar tudo', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const huge = Buffer.concat([buf, crypto.randomBytes(2 * 1024 * 1024)]);
    const srv = await startServer((req, res) => { res.writeHead(200); res.end(huge); }); // sem Content-Length
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      await assert.rejects(inst.install('demotool'), { code: 'SIZE_MISMATCH' });
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('pacote corrompido (com SHA-256 certo, mas não é um zip): EXTRACT_FAILED e nada instalado', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = Buffer.from('isto nao e um zip, so texto qualquer repetido '.repeat(20));
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      await assert.rejects(inst.install('demotool'), { code: 'EXTRACT_FAILED' });
      assert.deepEqual(listTree(toolsDir), []);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('o pacote não traz o executável esperado: EXE_MISSING e nada instalado', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = makeZip([{ name: 'outro.exe', data: 'x' }]);
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, exe: 'demo.exe' })]);
      await assert.rejects(inst.install('demotool'), (err) => err.code === 'EXE_MISSING' && /demo\.exe/.test(err.message));
      assert.deepEqual(listTree(toolsDir), []);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ zip-slip

test('zip-slip: entradas que escapam da pasta são recusadas antes de extrair (zip e tar.gz)', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const evilNames = ['../evil.txt', '../../evil.txt', 'ok/../../evil.txt', '/abs-evil.txt', 'C:/evil.txt', 'sub/..\\..\\evil.txt'];
    for (const evil of evilNames) {
      for (const kind of ['zip', 'tar.gz']) {
        const files = [{ name: 'demo.exe', data: 'MZ' }, { name: evil, data: 'EVIL' }];
        const buf = kind === 'zip' ? makeZip(files) : makeTarGz(files);
        const srv = await startServer(serveAlways(buf));
        try {
          const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, file: `pacote.${kind}` })]);
          await assert.rejects(inst.install('demotool'), (err) => {
            assert.equal(err.code, 'EXTRACT_UNSAFE', `${kind} ${evil}: ${err.message}`);
            return true;
          });
          assert.deepEqual(listTree(toolsDir), [], `${kind} ${evil}`);
          // nenhum arquivo malicioso em lugar nenhum (nem ao lado da pasta de ferramentas nem na raiz do teste)
          const all = listTree(base);
          assert.ok(!all.some((p) => /evil/i.test(p)), `${kind} ${evil}: apareceu ${all.filter((p) => /evil/i.test(p))}`);
        } finally { await srv.close(); }
      }
    }
  });
});

// ------------------------------------------------------------------ cancelamento

test('cancela no meio do download por AbortSignal: nada fica para trás e a conexão é encerrada', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = Buffer.concat([demoZip(), crypto.randomBytes(1024 * 1024)]);
    const { handler, state } = holdingServer(buf);
    const srv = await startServer(handler);
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, file: 'grande.zip' })]);
      const controller = new AbortController();
      const events = [];
      inst.on('progress', (e) => {
        events.push(e);
        if (e.phase === 'download' && e.receivedBytes > 0) controller.abort();
      });
      await assert.rejects(inst.install('demotool', { signal: controller.signal }), { code: 'CANCELLED' });
      assert.equal(await state.closedPromise, true, 'o servidor deveria ter visto a conexão cair');
      assert.equal(inst.isBusy('demotool'), false);
      assert.equal(events[events.length - 1].phase, 'cancelled');
      assert.deepEqual(listTree(toolsDir), []);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('cancela por installer.cancel(id) e permite instalar de novo em seguida', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = Buffer.concat([demoZip(), crypto.randomBytes(512 * 1024)]);
    let mode = 'hold';
    const held = holdingServer(buf);
    const srv = await startServer((req, res, ctx) => (mode === 'hold' ? held.handler(req, res, ctx) : sendBuffer(res, buf)));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      const started = new Promise((resolve) => inst.on('progress', (e) => { if (e.phase === 'download' && e.receivedBytes > 0) resolve(); }));
      const pending = inst.install('demotool');
      pending.catch(() => {});
      await started;
      assert.equal(inst.isBusy('demotool'), true);
      assert.equal(inst.status()[0].busy, true);
      assert.equal(inst.cancel('demotool'), true);
      await assert.rejects(pending, { code: 'CANCELLED' });
      assert.equal(inst.cancel('demotool'), false, 'já não há o que cancelar');
      assert.deepEqual(listTree(toolsDir), []);

      mode = 'ok';
      const res = await inst.install('demotool');
      assert.equal(fs.readFileSync(res.exe, 'utf8'), 'MZ-programa-de-teste');
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('sinal já cancelado: não faz nem a requisição', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      await assert.rejects(inst.install('demotool', { signal: AbortSignal.abort() }), { code: 'CANCELLED' });
      assert.equal(srv.requests.length, 0);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('duas instalações simultâneas da mesma ferramenta: a segunda é recusada (BUSY)', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = Buffer.concat([demoZip(), crypto.randomBytes(512 * 1024)]);
    const { handler } = holdingServer(buf);
    const srv = await startServer(handler);
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      const started = new Promise((resolve) => inst.on('progress', (e) => { if (e.phase === 'download' && e.receivedBytes > 0) resolve(); }));
      const first = inst.install('demotool');
      first.catch(() => {});
      await started;
      await assert.rejects(inst.install('demotool'), { code: 'BUSY' });
      await assert.rejects(inst.remove('demotool'), { code: 'BUSY' });
      inst.cancelAll();
      await assert.rejects(first, { code: 'CANCELLED' });
      noResidue(base);
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ rede

test('redirecionamentos (relativo e absoluto) são seguidos', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer((req, res) => {
      if (req.url === '/start') { res.writeHead(302, { Location: '/meio' }); return res.end(); }
      if (req.url === '/meio') { res.writeHead(301, { Location: `http://${req.headers.host}/arquivos/final.zip` }); return res.end(); }
      return sendBuffer(res, buf);
    });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, urlPath: '/start' })]);
      const res = await inst.install('demotool');
      assert.ok(fs.existsSync(res.exe));
      assert.deepEqual(srv.requests.map((r) => r.url), ['/start', '/meio', '/arquivos/final.zip']);
    } finally { await srv.close(); }
  });
});

test('redirecionamentos demais (laço) são recusados', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer((req, res) => { res.writeHead(302, { Location: '/laco' }); res.end(); });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, urlPath: '/laco' })], { maxRedirects: 3 });
      await assert.rejects(inst.install('demotool'), { code: 'TOO_MANY_REDIRECTS' });
      assert.equal(srv.requests.length, 4); // a primeira + 3 saltos permitidos
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('HTTP 404 não é repetido; HTTP 503 é repetido até o limite de tentativas', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer((req, res) => { res.writeHead(req.url === '/404.zip' ? 404 : 503); res.end('x'); });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, urlPath: '/404.zip' })], { attempts: 3 });
      await assert.rejects(inst.install('demotool'), { code: 'HTTP_404' });
      assert.equal(srv.requests.length, 1);

      const inst2 = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf, urlPath: '/503.zip' })], { attempts: 3 });
      await assert.rejects(inst2.install('demotool'), { code: 'HTTP_503' });
      assert.equal(srv.requests.length, 4);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('queda da conexão no meio do download: falha sem deixar lixo', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = Buffer.concat([demoZip(), crypto.randomBytes(256 * 1024)]);
    const srv = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Length': buf.length });
      res.write(buf.subarray(0, buf.length / 2));
      setTimeout(() => res.socket.destroy(), 30);
    });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      await assert.rejects(inst.install('demotool'), { code: 'INCOMPLETE' });
      assert.deepEqual(listTree(toolsDir), []);
      noResidue(base);
      assert.equal(inst.resolveInstalled('demotool'), null);
    } finally { await srv.close(); }
  });
});

test('queda transitória: tenta de novo (recomeça do zero) e instala', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const buf = Buffer.concat([demoZip(), crypto.randomBytes(128 * 1024)]);
    let calls = 0;
    const srv = await startServer((req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Length': buf.length });
        res.write(buf.subarray(0, 1000));
        return setTimeout(() => res.socket.destroy(), 20);
      }
      return sendBuffer(res, buf);
    });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })], { attempts: 3 });
      const messages = [];
      inst.on('progress', (e) => messages.push(e.message));
      const res = await inst.install('demotool');
      assert.equal(calls, 2);
      assert.ok(fs.existsSync(res.exe));
      assert.ok(messages.some((m) => /Tentando de novo/.test(m)));
      assert.deepEqual(fs.readdirSync(toolsDir), ['demotool']);
    } finally { await srv.close(); }
  });
});

test('servidor que não responde: TIMEOUT', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(() => { /* nunca responde */ });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })], { idleTimeoutMs: 200 });
      await assert.rejects(inst.install('demotool'), { code: 'TIMEOUT' });
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('URL http fora de teste é recusada (só https); sem allowLoopbackHttp nem localhost vale', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf });
      const strict = new ToolInstaller({ toolsDir, entries: [entry], platform: 'win32', arch: 'x64' });
      await assert.rejects(strict.install('demotool'), { code: 'INVALID_ENTRY' });
      assert.equal(srv.requests.length, 0);

      const remote = makeEntry({ base: 'http://exemplo.com', buf });
      await assert.rejects(makeInstaller(toolsDir, [remote]).install('demotool'), { code: 'INVALID_ENTRY' });
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('sem espaço em disco suficiente: recusa antes de baixar', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })], { diskFactor: 1e12 });
      await assert.rejects(inst.install('demotool'), (err) => err.code === 'DISK_SPACE' && /insuficiente/.test(err.message));
      assert.equal(srv.requests.length, 0);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ reinstalação, atualização e remoção

test('reinstalação segura: sem force não baixa de novo; com force substitui por inteiro', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer((req, res) => sendBuffer(res, buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      const first = await inst.install('demotool');
      assert.equal(first.alreadyInstalled, false);

      const again = await inst.install('demotool');
      assert.equal(again.alreadyInstalled, true);
      assert.equal(srv.requests.length, 1, 'instalação íntegra não deve baixar de novo');

      // dano na instalação (executável apagado): install volta a baixar sozinho
      fs.rmSync(first.exe);
      assert.equal(inst.resolveInstalled('demotool'), null);
      const repaired = await inst.install('demotool');
      assert.equal(repaired.alreadyInstalled, false);
      assert.equal(srv.requests.length, 2);
      assert.equal(fs.readFileSync(repaired.exe, 'utf8'), 'MZ-programa-de-teste');

      // force: arquivo sobrando na instalação antiga some (a pasta é trocada inteira)
      fs.writeFileSync(path.join(repaired.dir, 'sobra-antiga.txt'), 'x');
      const forced = await inst.install('demotool', { force: true });
      assert.equal(forced.alreadyInstalled, false);
      assert.equal(srv.requests.length, 3);
      assert.ok(!fs.existsSync(path.join(forced.dir, 'sobra-antiga.txt')));
      assert.deepEqual(fs.readdirSync(toolsDir), ['demotool']);
      assert.deepEqual(fs.readdirSync(path.join(toolsDir, 'demotool')), ['1.0.0']);
    } finally { await srv.close(); }
    noResidue(base);
  });
});

test('reinstalação que falha mantém a instalação anterior funcionando', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    let mode = 'ok';
    const srv = await startServer((req, res) => {
      if (mode === 'ok') return sendBuffer(res, buf);
      const broken = Buffer.from(buf);
      broken[broken.length - 30] ^= 0xff; // mesmo tamanho, conteúdo diferente
      return sendBuffer(res, broken);
    });
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      const first = await inst.install('demotool');
      const manifestBefore = fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8');

      mode = 'broken';
      await assert.rejects(inst.install('demotool', { force: true }), { code: 'CHECKSUM_MISMATCH' });
      assert.equal(inst.resolveInstalled('demotool'), first.exe, 'a instalação anterior tem que continuar valendo');
      assert.equal(fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8'), manifestBefore);
      assert.equal(fs.readFileSync(first.exe, 'utf8'), 'MZ-programa-de-teste');
      assert.deepEqual(listTree(toolsDir).filter((p) => p.startsWith('.tmp')), []);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

/** Faz fs.renameSync falhar (EIO) nas chamadas em que `match(from, to)` for verdadeiro; devolve a função que desfaz. */
function failRenames(match) {
  const original = fs.renameSync;
  fs.renameSync = function patched(from, to) {
    if (match(String(from), String(to))) throw Object.assign(new Error('falha injetada pelo teste'), { code: 'EIO' });
    return original.call(fs, from, to);
  };
  return () => { fs.renameSync = original; };
}

test('falha ao publicar a nova versão: a instalação anterior é restaurada; falha ao tirar a antiga do lugar: nada muda', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      const first = await inst.install('demotool');
      const manifestBefore = fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8');
      const intact = () => {
        assert.equal(inst.resolveInstalled('demotool'), first.exe);
        assert.equal(fs.readFileSync(path.join(first.dir, 'manifest.json'), 'utf8'), manifestBefore);
        assert.equal(fs.readFileSync(path.join(first.dir, 'lib', 'dados.txt'), 'utf8'), 'dados');
        noResidue(base);
      };

      // (a) publicar a nova pasta falha depois de a antiga já ter saído do lugar -> a antiga volta
      let restore = failRenames((from, to) => path.basename(from) === 'files' && to === first.dir);
      try {
        await assert.rejects(inst.install('demotool', { force: true }), (err) => err.code === 'INSTALL_FAILED' && /Nada foi alterado/.test(err.message));
      } finally { restore(); }
      intact();

      // (b) tirar a instalação atual do lugar falha -> nada muda
      restore = failRenames((from) => from === first.dir);
      try {
        await assert.rejects(inst.install('demotool', { force: true }), (err) => err.code === 'INSTALL_FAILED' && /continua como estava/.test(err.message));
      } finally { restore(); }
      intact();

      // (c) remover: o rename para a lixeira falha -> continua instalada
      restore = failRenames((from) => from === path.join(toolsDir, 'demotool'));
      try {
        await assert.rejects(inst.remove('demotool'), { code: 'REMOVE_FAILED' });
      } finally { restore(); }
      intact();

      // sem a falha injetada tudo volta a funcionar
      assert.equal((await inst.install('demotool', { force: true })).alreadyInstalled, false);
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('atualização: versão nova instala e a antiga é removida; status aponta "desatualizada" antes', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const v1 = makeZip([{ name: 'demo.exe', data: 'versao-1' }]);
    const v2 = makeZip([{ name: 'demo.exe', data: 'versao-2-maior' }]);
    const srv = await startServer((req, res) => sendBuffer(res, req.url === '/v1.zip' ? v1 : v2));
    try {
      const e1 = makeEntry({ base: srv.base, buf: v1, version: '1.0.0', file: 'v1.zip' });
      const e2 = makeEntry({ base: srv.base, buf: v2, version: '2.0.0', file: 'v2.zip' });
      await makeInstaller(toolsDir, [e1]).install('demotool');

      const inst2 = makeInstaller(toolsDir, [e2]);
      const before = inst2.status()[0];
      assert.equal(before.installed, false);
      assert.equal(before.outdated, true);
      assert.equal(before.installedVersion, '1.0.0');
      assert.equal(inst2.resolveInstalled('demotool'), null);

      const res = await inst2.install('demotool');
      assert.equal(fs.readFileSync(res.exe, 'utf8'), 'versao-2-maior');
      assert.deepEqual(fs.readdirSync(path.join(toolsDir, 'demotool')), ['2.0.0']);
      const after = inst2.status()[0];
      assert.equal(after.installed, true);
      assert.equal(after.outdated, false);
    } finally { await srv.close(); }
  });
});

test('remove: apaga todas as versões; segunda remoção não faz nada; ids perigosos são recusados', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf })]);
      await inst.install('demotool');
      fs.mkdirSync(path.join(toolsDir, 'demotool', '0.9.0')); // sobra de outra versão

      assert.deepEqual(await inst.remove('demotool'), { id: 'demotool', removed: true });
      assert.deepEqual(listTree(toolsDir), []);
      assert.equal(inst.resolveInstalled('demotool'), null);
      assert.equal(inst.status()[0].installed, false);
      assert.deepEqual(await inst.remove('demotool'), { id: 'demotool', removed: false });

      fs.mkdirSync(path.join(base, 'fora'));
      for (const bad of ['../fora', '..', '.tmp', 'a/b', 'a\\b', '', 'C:', null, undefined, 42]) {
        await assert.rejects(inst.remove(bad), { code: 'UNKNOWN_TOOL' }, `id ${JSON.stringify(bad)}`);
      }
      assert.ok(fs.existsSync(path.join(base, 'fora')), 'remove("../fora") não pode apagar nada fora da pasta de ferramentas');
      assert.deepEqual(listTree(toolsDir), []);
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ plataforma e ids

test('plataforma sem pacote oficial: recusa com o motivo e não toca em nada', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf, key: 'linux-arm64' });
      const inst = makeInstaller(toolsDir, [entry]); // plataforma win32-x64
      const [st] = inst.status();
      assert.equal(st.available, false);
      assert.match(st.unavailableReason, /Windows/);
      assert.equal(st.installed, false);

      await assert.rejects(inst.install('demotool'), (err) => err.code === 'PLATFORM_UNAVAILABLE' && /Windows/.test(err.message));
      assert.equal(srv.requests.length, 0);
      assert.deepEqual(listTree(base), []);
      assert.equal(inst.resolveInstalled('demotool'), null);

      // a mesma entrada instala quando o sistema é o publicado
      const linux = new ToolInstaller({ toolsDir, entries: [entry], platform: 'linux', arch: 'arm64', allowLoopbackHttp: true, attempts: 1 });
      assert.equal(linux.status()[0].available, true);
    } finally { await srv.close(); }
  });
});

test('id desconhecido e entrada inválida passada direto', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const inst = makeInstaller(toolsDir, []);
    await assert.rejects(inst.install('nao-existe'), { code: 'UNKNOWN_TOOL' });
    await assert.rejects(inst.install({ id: '../x' }), { code: 'INVALID_ENTRY' });
    assert.throws(() => new ToolInstaller({}), { code: 'INVALID_ARGUMENT' });
    assert.deepEqual(listTree(base), []);
  });
});

test('install aceita a própria entrada (objeto) além do id', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const buf = demoZip();
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = makeEntry({ base: srv.base, buf });
      const inst = makeInstaller(toolsDir, [entry]);
      const res = await inst.install(entry);
      assert.ok(fs.existsSync(res.exe));
    } finally { await srv.close(); }
  });
});

// ------------------------------------------------------------------ resíduos

test('cleanupStaging apaga resíduos de instalações interrompidas (e respeita a idade mínima)', T, async () => {
  await withEnv(async ({ toolsDir }) => {
    const inst = makeInstaller(toolsDir, []);
    const stale = path.join(toolsDir, '.tmp', 'demotool-abc123');
    fs.mkdirSync(path.join(stale, 'extract'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'demo.zip.part'), 'meio');

    assert.equal(inst.cleanupStaging({ maxAgeMs: 60 * 60 * 1000 }), 0, 'resíduo recente não deve ser apagado com idade mínima');
    assert.ok(fs.existsSync(stale));
    assert.equal(inst.cleanupStaging(), 1);
    assert.deepEqual(listTree(toolsDir), []);
    assert.equal(inst.cleanupStaging(), 0);
  });
});

test('programa em uso (Windows): reinstalar e remover nunca deixam a instalação pela metade; depois de fechar o programa não sobra lixo', { ...T, skip: process.platform !== 'win32' && 'cenário do Windows' }, async () => {
  await withEnv(async ({ toolsDir }) => {
    const ping = fs.readFileSync(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'PING.EXE'));
    const zip = makeZip([{ name: 'ping.exe', data: ping }, { name: 'dados.txt', data: 'v1' }]);
    const srv = await startServer(serveAlways(zip));
    let child = null;
    try {
      const inst = makeInstaller(toolsDir, [makeEntry({ base: srv.base, buf: zip, exe: 'ping.exe' })]);
      const first = await inst.install('demotool');
      child = spawn(first.exe, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });

      // reinstala com o programa rodando: ou conclui, ou falha avisando — nunca fica pela metade
      const again = await inst.install('demotool', { force: true }).then((r) => r, (e) => e);
      if (again instanceof Error) assert.equal(again.code, 'INSTALL_FAILED');
      const exe = inst.resolveInstalled('demotool');
      assert.ok(exe, 'a ferramenta tem que continuar instalada e íntegra');
      assert.ok(fs.existsSync(exe));

      // remove com o programa rodando: ou remove, ou falha avisando e deixa tudo como estava
      const removed = await inst.remove('demotool').then((r) => r, (e) => e);
      if (removed instanceof Error) {
        assert.equal(removed.code, 'REMOVE_FAILED');
        assert.ok(inst.resolveInstalled('demotool'));
      } else {
        assert.equal(removed.removed, true);
        assert.equal(inst.resolveInstalled('demotool'), null);
      }

      // fecha o programa: o lixo que dependia dele pode ser varrido
      child.kill();
      await new Promise((resolve) => child.once('close', resolve));
      child = null;
      inst.cleanupStaging();
      assert.ok(!fs.existsSync(path.join(toolsDir, '.tmp')), 'a pasta .tmp tem que sumir quando não há mais nada para varrer');
    } finally {
      if (child) { child.kill(); await new Promise((resolve) => child.once('close', resolve)); }
      await srv.close();
    }
  });
});

// ------------------------------------------------------------------ programas extras do mesmo pacote (alsoExe): o ffprobe junto do ffmpeg

const ffmpegLikeZip = (files) => makeZip(files.map(([name, data]) => ({ name: `ffmpeg-9.0.2-full_build-shared/${name}`, ...(data === null ? {} : { data }) })));
const ffmpegLikeEntry = (base, buf) => makeEntry({ base, buf, id: 'ffmpeg', version: '9.0.2', file: 'ffmpeg-9.0.2-full_build-shared.zip', exe: 'bin/ffmpeg.exe', asset: { stripComponents: 1, alsoExe: { ffprobe: 'bin/ffprobe.exe' } } });

test('instala um pacote com dois programas (ffmpeg + ffprobe): pasta de topo ignorada, os dois no lugar, manifesto com alsoExe', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = ffmpegLikeZip([['LICENSE', 'GPL'], ['bin/', null], ['bin/ffmpeg.exe', 'MZ-ffmpeg'], ['bin/ffprobe.exe', 'MZ-ffprobe'], ['bin/avcodec-63.dll', 'dll']]);
    const srv = await startServer(serveAlways(buf));
    try {
      const entry = ffmpegLikeEntry(srv.base, buf);
      const inst = makeInstaller(toolsDir, [entry]);
      const res = await inst.install('ffmpeg');
      const finalDir = path.join(toolsDir, 'ffmpeg', '9.0.2');
      assert.equal(res.exe, path.join(finalDir, 'bin', 'ffmpeg.exe'));
      assert.equal(fs.readFileSync(path.join(finalDir, 'bin', 'ffprobe.exe'), 'utf8'), 'MZ-ffprobe');
      assert.equal(fs.existsSync(path.join(finalDir, 'bin', 'avcodec-63.dll')), true, 'as DLLs ficam ao lado dos programas');
      const manifest = JSON.parse(fs.readFileSync(path.join(finalDir, 'manifest.json'), 'utf8'));
      assert.deepEqual(manifest.alsoExe, { ffprobe: 'bin/ffprobe.exe' });
      const opts = { entries: [entry], platform: 'win32', arch: 'x64' };
      assert.equal(registry.resolveInstalled(toolsDir, 'ffmpeg', opts), res.exe);
      assert.deepEqual(registry.resolveExtras(toolsDir, 'ffmpeg', opts), { ffprobe: path.join(finalDir, 'bin', 'ffprobe.exe') });
      noResidue(base);
    } finally { await srv.close(); }
  });
});

test('pacote sem o ffprobe: a instalação é recusada (EXE_MISSING), nada fica instalado nem sobra pasta de trabalho', T, async () => {
  await withEnv(async ({ base, toolsDir }) => {
    const buf = ffmpegLikeZip([['bin/', null], ['bin/ffmpeg.exe', 'MZ-ffmpeg']]);
    const srv = await startServer(serveAlways(buf));
    try {
      const inst = makeInstaller(toolsDir, [ffmpegLikeEntry(srv.base, buf)]);
      await assert.rejects(inst.install('ffmpeg'), (e) => e.code === 'EXE_MISSING' && /bin\/ffprobe\.exe/.test(e.message));
      assert.equal(inst.resolveInstalled('ffmpeg'), null);
      assert.equal(fs.existsSync(path.join(toolsDir, 'ffmpeg', '9.0.2')), false);
      noResidue(base);
    } finally { await srv.close(); }
  });
});
