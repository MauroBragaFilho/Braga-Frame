'use strict';

/**
 * Linha de comando (src/host/cli.js): `BragaFrame.exe "vídeo.mp4"` e `npm start -- "vídeo.mp4"`. O argumento é só um caminho:
 * precisa ser completo, existir, ser arquivo e ter extensão de vídeo suportada; nada dele é executado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCli, validateVideoPath, VIDEO_EXTENSIONS, MAX_ARG_LENGTH } = require('../src/host/cli');
const { OpenRequests, MAX_PENDING } = require('../src/host/openRequests');

function withFiles(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cli-'));
  try {
    const files = {};
    for (const name of ['jogo.mp4', 'LIVE final.MKV', 'ação é vida.webm', 'nota.txt', 'sem-extensao']) {
      files[name] = path.join(dir, name);
      fs.writeFileSync(files[name], 'x');
    }
    files.pasta = path.join(dir, 'pasta.mp4'); // uma pasta com nome de vídeo
    fs.mkdirSync(files.pasta);
    return fn(files, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('as extensões aceitas são as mesmas do botão Abrir vídeo', () => {
  assert.deepEqual(VIDEO_EXTENSIONS, require('../src/ipc/handlers/project').VIDEO_EXTENSIONS);
  assert.ok(['mp4', 'mkv', 'mov', 'webm', 'avi', 'flv', 'ts'].every((e) => VIDEO_EXTENSIONS.includes(e)));
});

test('app empacotado: BragaFrame.exe "vídeo" abre o vídeo', () => withFiles((f) => {
  const res = parseCli(['C:\\Program Files\\BragaFrame\\BragaFrame.exe', f['jogo.mp4']], { defaultApp: false });
  assert.deepEqual(res, { videoPath: path.normalize(f['jogo.mp4']), error: null, extra: 0, requested: f['jogo.mp4'] });
}));

test('desenvolvimento (electron . "vídeo", npm start --): o primeiro argumento solto é a pasta do app, não o vídeo', () => withFiles((f) => {
  const res = parseCli(['electron.exe', '.', f['jogo.mp4']], { defaultApp: true });
  assert.equal(res.videoPath, path.normalize(f['jogo.mp4']));
  // opções do Chromium/Electron antes ou depois não atrapalham, nem a pasta do app depois delas
  const noisy = parseCli(['electron.exe', '--user-data-dir=C:\\x', '.', '--remote-debugging-port=0', '--disable-renderer-backgrounding', f['jogo.mp4']], { defaultApp: true });
  assert.equal(noisy.videoPath, path.normalize(f['jogo.mp4']));
  // sem vídeo: nada a fazer, nem erro
  assert.deepEqual(parseCli(['electron.exe', '.'], { defaultApp: true }), { videoPath: null, error: null, extra: 0, requested: null });
}));

test('segunda instância: o argv dela traz o mesmo formato', () => withFiles((f) => {
  const res = parseCli(['C:\\BragaFrame.exe', '--allow-file-access', f['LIVE final.MKV']], { defaultApp: false });
  assert.equal(res.videoPath, path.normalize(f['LIVE final.MKV']), 'extensão em maiúsculas e espaço no nome');
  assert.equal(parseCli(['x', f['ação é vida.webm']], { defaultApp: false }).videoPath, path.normalize(f['ação é vida.webm']), 'acentos');
}));

test('"--" encerra as opções: depois dele tudo é caminho (e, sem ele, o que começa com "-" é opção e some)', () => {
  const afterDashes = parseCli(['x', '--', '-estranho.mp4'], { defaultApp: false });
  assert.equal(afterDashes.requested, '-estranho.mp4');
  assert.equal(afterDashes.error.code, 'RELATIVE_PATH');
  const asOption = parseCli(['x', '-estranho.mp4'], { defaultApp: false });
  assert.equal(asOption.requested, null);
  assert.equal(asOption.error, null);
});

test('sem argumentos, ou argv inválido: nada a abrir e sem erro', () => {
  for (const argv of [[], ['x'], undefined, null, 'texto', 7, [undefined, null, 5]]) {
    const res = parseCli(argv, { defaultApp: false });
    assert.equal(res.videoPath, null);
    assert.equal(res.error, null);
  }
});

test('caminho relativo é recusado com instrução (a pasta de trabalho de um BDS/atalho não é previsível)', () => withFiles(() => {
  for (const rel of ['jogo.mp4', '.\\jogo.mp4', '..\\jogo.mp4', 'pasta\\jogo.mp4']) {
    const res = parseCli(['x', rel], { defaultApp: false });
    assert.equal(res.videoPath, null);
    assert.equal(res.error.code, 'RELATIVE_PATH', rel);
    assert.match(res.error.message, /caminho completo/);
  }
}));

test('arquivo que não existe, pasta e formato não suportado dão erro em português', () => withFiles((f, dir) => {
  const missing = parseCli(['x', path.join(dir, 'fantasma.mp4')], { defaultApp: false });
  assert.equal(missing.error.code, 'INPUT_MISSING');
  assert.match(missing.error.message, /não foi encontrado/);
  const folder = parseCli(['x', f.pasta], { defaultApp: false });
  assert.equal(folder.error.code, 'NOT_A_FILE');
  const text = parseCli(['x', f['nota.txt']], { defaultApp: false });
  assert.equal(text.error.code, 'UNSUPPORTED_FORMAT');
  assert.match(text.error.message, /\.txt/);
  assert.match(text.error.message, /mp4/);
  const none = parseCli(['x', f['sem-extensao']], { defaultApp: false });
  assert.equal(none.error.code, 'UNSUPPORTED_FORMAT');
  for (const res of [missing, folder, text, none]) assert.equal(res.videoPath, null);
}));

test('nada do argumento é executado nem interpretado: comandos e atalhos viram só um caminho inválido', () => {
  for (const evil of ['calc.exe', 'calc.exe & del C:\\*', 'C:\\Windows\\System32\\cmd.exe', 'C:\\x.mp4 && calc', '%COMSPEC%', '$(whoami)', 'file:///C:/x.mp4', 'http://exemplo.com/v.mp4', '\\\\servidor\\compartilhado\\x.exe']) {
    const res = parseCli(['x', evil], { defaultApp: false });
    assert.equal(res.videoPath, null, evil);
    assert.ok(res.error, evil);
  }
  // um .exe com o caminho completo e existente continua recusado: só vídeo
  const exe = process.execPath;
  assert.equal(validateVideoPath(exe).code, 'UNSUPPORTED_FORMAT');
});

test('entradas absurdas: texto enorme, byte nulo, tipos errados', () => {
  assert.equal(validateVideoPath('C:\\' + 'a'.repeat(MAX_ARG_LENGTH) + '.mp4').code, 'INVALID_PATH');
  assert.equal(validateVideoPath('C:\\x\0.mp4').code, 'INVALID_PATH');
  for (const bad of [undefined, null, 5, {}, [], '', '   ']) assert.equal(validateVideoPath(bad).code, 'INVALID_PATH', String(bad));
});

test('mais de um caminho: usa o primeiro e conta os ignorados', () => withFiles((f) => {
  const res = parseCli(['x', f['jogo.mp4'], f['LIVE final.MKV'], f['ação é vida.webm']], { defaultApp: false });
  assert.equal(res.videoPath, path.normalize(f['jogo.mp4']));
  assert.equal(res.extra, 2);
}));

test('o caminho é normalizado e a conferência é do disco (statSync injetável)', () => {
  const seen = [];
  const ok = validateVideoPath('C:\\Videos\\..\\Videos\\jogo.mp4', { statSync: (p) => { seen.push(p); return { isFile: () => true }; } });
  assert.deepEqual(ok, { ok: true, path: path.normalize('C:\\Videos\\..\\Videos\\jogo.mp4') });
  assert.equal(seen.length, 1);
});

test('fila de pedidos: um vídeo por vez, erros ficam, cada pedido sai uma vez, limite de pendentes', () => {
  const q = new OpenRequests();
  assert.equal(q.push(null), false);
  assert.equal(q.push({}), false);
  assert.equal(q.push({ videoPath: null, error: null }), false);
  assert.equal(q.push({ videoPath: 'C:\\a.mp4' }), true);
  assert.equal(q.push({ path: 'C:\\b.mp4' }), true);
  assert.equal(q.push({ error: { code: 'X', message: 'falhou' } }), true);
  assert.equal(q.size, 2);
  assert.deepEqual(q.take(), [{ path: 'C:\\b.mp4' }, { error: { code: 'X', message: 'falhou' } }]);
  assert.deepEqual(q.take(), []);
  for (let i = 0; i < MAX_PENDING + 5; i += 1) q.push({ error: { message: `erro ${i}` } });
  assert.equal(q.size, MAX_PENDING);
  assert.equal(q.take().at(-1).error.message, `erro ${MAX_PENDING + 4}`);
});

test('o BDS pode abrir em desenvolvimento com a pasta do app por extenso (electron.exe + pasta do app + vídeo)', () => withFiles((f) => {
  const appDir = path.dirname(__dirname);
  const res = parseCli(['electron.exe', appDir, f['jogo.mp4']], { defaultApp: true });
  assert.equal(res.videoPath, path.normalize(f['jogo.mp4']));
  assert.equal(res.extra, 0);
}));
