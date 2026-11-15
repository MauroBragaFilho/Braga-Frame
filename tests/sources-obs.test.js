'use strict';

/**
 * Fontes: pasta de gravação do OBS (configuração REAL do OBS lida de basic.ini/user.ini) e listagem das gravações.
 * Os .ini de tests/sources-fixtures/obs foram reduzidos do basic.ini real (sem as chaves de segredo); a listagem usa
 * vídeos gerados de verdade com o ffmpeg e um processo que ESCREVE num arquivo durante a leitura.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const obs = require('../src/core/sources/obsConfig');
const { listRecordings, startedAtFromName, EXTENSIONS } = require('../src/core/sources/recordings');
const { sampleVideo } = require('./sources-fakes');

const FIX = path.join(__dirname, 'sources-fixtures', 'obs');
const tools = locateTools();
const skipMedia = !tools.ffmpeg || !tools.ffprobe ? 'ffmpeg/ffprobe não encontrados' : false;

function tmp(name = 'obs') { return fs.mkdtempSync(path.join(os.tmpdir(), `bf-src-${name}-`)); }
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

/** Copia a árvore de fixtures para `dir` (como se fosse %APPDATA%\obs-studio). */
function installFixture(dir) {
  fs.cpSync(FIX, path.join(dir, 'obs-studio', 'basic'), { recursive: true, filter: (src) => !src.endsWith('user.ini') });
  fs.renameSync(path.join(dir, 'obs-studio', 'basic', 'profiles'), path.join(dir, 'obs-studio', 'basic', 'profiles_tmp'));
  fs.mkdirSync(path.join(dir, 'obs-studio', 'basic', 'profiles'), { recursive: true });
  fs.cpSync(path.join(dir, 'obs-studio', 'basic', 'profiles_tmp'), path.join(dir, 'obs-studio', 'basic', 'profiles'), { recursive: true });
  fs.rmSync(path.join(dir, 'obs-studio', 'basic', 'profiles_tmp'), { recursive: true, force: true });
  fs.copyFileSync(path.join(FIX, 'user.ini'), path.join(dir, 'obs-studio', 'user.ini'));
  return path.join(dir, 'obs-studio');
}

// ------------------------------------------------------------------ parseIni

test('parseIni: BOM, CRLF, barras dobradas e "/" do OBS', () => {
  const real = fs.readFileSync(path.join(FIX, 'profiles', 'Gameplay', 'basic.ini'), 'utf8');
  assert.equal(real.charCodeAt(0), 0xFEFF, 'a fixture de verdade traz BOM, como o OBS grava');
  const ini = obs.parseIni(real);
  assert.equal(ini.General.Name, 'Gameplay');
  assert.equal(ini.Output.Mode, 'Advanced');
  assert.equal(ini.Output.FilenameFormatting, '%CCYY-%MM-%DD %hh-%mm-%ss', 'o "%" do nome do arquivo não é tocado');
  assert.equal(ini.SimpleOutput.FilePath, 'C:\\Users\\fulano\\Videos', '"\\\\" do OBS vira "\\"');
  assert.equal(ini.AdvOut.RecFilePath, 'D:/REC/00 - OBS', 'caminho com "/" e espaços fica como está');

  const crlf = obs.parseIni(fs.readFileSync(path.join(FIX, 'profiles', 'Serie_e_Anime', 'basic.ini'), 'utf8'));
  assert.equal(crlf.General.Name, 'Série e Anime');
  assert.equal(crlf.SimpleOutput.FilePath, 'C:\\Users\\fulano\\Videos');
  assert.equal(crlf.Output.Mode, 'Simple');

  const single = obs.parseIni(fs.readFileSync(path.join(FIX, 'profiles', 'Streaming', 'basic.ini'), 'utf8'));
  assert.equal(single.AdvOut.FFFilePath, 'E:\\Gravacoes\\Live', '"\\" simples (arquivo editado à mão) continua valendo');
});

test('parseIni: comentários, valores com "=", aspas, chaves fora de seção e lixo', () => {
  const ini = obs.parseIni('solta=1\n; comentário\n# outro\n[A]\nk = v = w \n\nsem_igual\n[B]\nq="entre aspas"\n=vazio\n[A]\nmais=2\n');
  assert.deepEqual(ini, { A: { k: 'v = w', mais: '2' }, B: { q: 'entre aspas' } });
  assert.deepEqual(obs.parseIni(''), {});
  assert.deepEqual(obs.parseIni(null), {});
});

// ------------------------------------------------------------------ pasta de gravação por perfil

test('recordingFolderOf: modo simples, avançado padrão, avançado FFmpeg e sem caminho', () => {
  assert.deepEqual(obs.recordingFolderOf({ Output: { Mode: 'Simple' }, SimpleOutput: { FilePath: 'C:\\V' } }), { mode: 'simple', key: 'SimpleOutput.FilePath', folder: 'C:\\V' });
  assert.deepEqual(obs.recordingFolderOf({ Output: { Mode: 'Advanced' }, AdvOut: { RecType: 'Standard', RecFilePath: 'D:/R', FFFilePath: 'E:\\x' } }), { mode: 'advanced', key: 'AdvOut.RecFilePath', folder: 'D:/R' });
  assert.deepEqual(obs.recordingFolderOf({ Output: { Mode: 'advanced' }, AdvOut: { RecType: 'FFmpeg', RecFilePath: 'D:/R', FFFilePath: 'E:\\x' } }), { mode: 'advanced', key: 'AdvOut.FFFilePath', folder: 'E:\\x' });
  const url = obs.recordingFolderOf({ Output: { Mode: 'Advanced' }, AdvOut: { RecType: 'FFmpeg', FFOutputToFile: 'false', FFFilePath: 'E:\\x' } });
  assert.equal(url.folder, null);
  assert.match(url.note, /URL/);
  assert.equal(obs.recordingFolderOf({ Output: { Mode: 'Advanced' }, AdvOut: { RecType: 'Standard' } }).folder, null);
  assert.equal(obs.recordingFolderOf({}).mode, 'simple', 'sem [Output] o OBS usa o modo simples');
  assert.equal(obs.recordingFolderOf(null).folder, null);
});

test('obsConfigDir: Windows usa %APPDATA%\\obs-studio', () => {
  assert.equal(obs.obsConfigDir({ APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, 'win32'), path.join('C:\\Users\\x\\AppData\\Roaming', 'obs-studio'));
  assert.equal(obs.obsConfigDir({ USERPROFILE: 'C:\\Users\\y' }, 'win32'), path.join('C:\\Users\\y', 'AppData', 'Roaming', 'obs-studio'));
  assert.equal(obs.obsConfigDir({}, 'win32'), null);
  assert.equal(obs.obsConfigDir({ HOME: '/home/z' }, 'linux'), path.join('/home/z', '.config', 'obs-studio'));
  assert.equal(obs.obsConfigDir({ HOME: '/Users/z' }, 'darwin'), path.join('/Users/z', 'Library', 'Application Support', 'obs-studio'));
});

// ------------------------------------------------------------------ detectObs (árvore de configuração de verdade)

test('detectObs lê todos os perfis, marca o ativo (user.ini) e confere se a pasta existe', () => {
  const root = tmp('detect');
  try {
    const obsDir = installFixture(root);
    // reescreve os caminhos das fixtures para pastas que existem de verdade
    const rec = path.join(root, 'REC', '00 - OBS');
    fs.mkdirSync(rec, { recursive: true });
    const gp = path.join(obsDir, 'basic', 'profiles', 'Gameplay', 'basic.ini');
    fs.writeFileSync(gp, fs.readFileSync(gp, 'utf8').replace('D:/REC/00 - OBS', rec.replace(/\\/g, '/')));

    const found = obs.detectObs({ obsDir });
    assert.equal(found.found, true);
    assert.deepEqual(found.active, { name: 'Gameplay', dir: 'Gameplay' });
    assert.deepEqual(found.profiles.map((p) => p.dir), ['Gameplay', 'Serie_e_Anime', 'Streaming', 'Vazio'], 'ativo primeiro, depois alfabético');
    const byDir = Object.fromEntries(found.profiles.map((p) => [p.dir, p]));
    assert.equal(byDir.Gameplay.active, true);
    assert.equal(byDir.Gameplay.mode, 'advanced');
    assert.equal(byDir.Gameplay.key, 'AdvOut.RecFilePath');
    assert.equal(byDir.Gameplay.folder, path.normalize(rec));
    assert.equal(byDir.Gameplay.exists, true);
    assert.equal(byDir.Serie_e_Anime.mode, 'simple');
    assert.equal(byDir.Serie_e_Anime.key, 'SimpleOutput.FilePath');
    assert.equal(byDir.Serie_e_Anime.name, 'Série e Anime');
    assert.equal(byDir.Serie_e_Anime.exists, false, 'C:\\Users\\fulano\\Videos não existe neste computador');
    assert.equal(byDir.Streaming.key, 'AdvOut.FFFilePath');
    assert.equal(byDir.Streaming.folder, path.normalize('E:\\Gravacoes\\Live'));
    assert.equal(byDir.Vazio.folder, null);
    assert.equal(byDir.Vazio.active, false);

    const folders = obs.candidateFolders(found);
    assert.deepEqual(folders.map((f) => f.profile), ['Gameplay', 'Série e Anime', 'Streaming']);
    assert.equal(folders[0].active, true);
  } finally { rm(root); }
});

test('detectObs: global.ini (OBS antigo), OBS ausente e perfil sem basic.ini', () => {
  const root = tmp('detect2');
  try {
    // sem nada
    const none = obs.detectObs({ obsDir: path.join(root, 'nao-existe') });
    assert.equal(none.found, false);
    assert.match(none.reason, /Não encontrei a configuração do OBS/);
    assert.match(none.reason, /modo portátil/);
    assert.deepEqual(none.profiles, []);
    assert.equal(obs.detectObs({ env: {}, platform: 'win32' }).found, false);

    // OBS antigo: perfil ativo no global.ini; um perfil sem basic.ini é ignorado
    const dir = path.join(root, 'obs-studio');
    fs.mkdirSync(path.join(dir, 'basic', 'profiles', 'Antigo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'basic', 'profiles', 'SemIni'), { recursive: true });
    const vids = path.join(root, 'Videos');
    fs.mkdirSync(vids);
    fs.writeFileSync(path.join(dir, 'basic', 'profiles', 'Antigo', 'basic.ini'), `[General]\nName=Antigo\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${vids}\n`);
    fs.writeFileSync(path.join(dir, 'global.ini'), '[General]\nMaxLogs=10\n[Basic]\nProfile=Antigo\nProfileDir=Antigo\n');
    const old = obs.detectObs({ obsDir: dir });
    assert.equal(old.found, true);
    assert.equal(old.profiles.length, 1);
    assert.equal(old.profiles[0].active, true);
    assert.equal(old.profiles[0].exists, true);
    assert.equal(old.profiles[0].folder, path.normalize(vids));
  } finally { rm(root); }
});

test('detectObs com a mesma pasta em dois perfis mostra uma só vez, marcando a do perfil ativo', () => {
  const root = tmp('detect3');
  try {
    const dir = path.join(root, 'obs-studio');
    const vids = path.join(root, 'Videos');
    fs.mkdirSync(vids);
    for (const name of ['A', 'B']) {
      fs.mkdirSync(path.join(dir, 'basic', 'profiles', name), { recursive: true });
      fs.writeFileSync(path.join(dir, 'basic', 'profiles', name, 'basic.ini'), `[General]\nName=Perfil ${name}\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${vids}\n`);
    }
    fs.writeFileSync(path.join(dir, 'user.ini'), '[Basic]\nProfile=Perfil B\nProfileDir=B\n');
    const list = obs.candidateFolders(obs.detectObs({ obsDir: dir }));
    assert.equal(list.length, 1);
    assert.equal(list[0].active, true);
    assert.equal(list[0].profile, 'Perfil B');
  } finally { rm(root); }
});

// ------------------------------------------------------------------ pastas em rede fora do ar (fsGuard)

/** Promise que o teste resolve na hora que quiser (simula uma leitura de disco pendurada). */
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('fsGuard: leitura pendurada vira "não sei" no prazo, é reaproveitada e não ocupa todas as threads', async () => {
  const guard = require('../src/core/sources/fsGuard');
  const gates = [];
  const hang = (name) => { const d = deferred(); gates.push(d); let calls = 0; return { name, d, op: () => { calls += 1; return d.promise; }, calls: () => calls }; };
  try {
    const a = hang('a');
    const t0 = Date.now();
    assert.deepEqual(await guard.guardIo('t:a', a.op, { timeoutMs: 60 }), { timedOut: true });
    assert.ok(Date.now() - t0 < 1000, 'respondeu no prazo, sem esperar a leitura');
    assert.equal(guard.stats().hung, 1);
    // nova chamada para a mesma pasta reaproveita a leitura que já está pendente (não abre outra thread)
    assert.deepEqual(await guard.guardIo('t:a', a.op, { timeoutMs: 30 }), { timedOut: true });
    assert.equal(a.calls(), 1);
    // quando a leitura termina, o resultado volta normalmente e a marca de "pendurada" some
    setTimeout(() => a.d.resolve('veio'), 20);
    assert.deepEqual(await guard.guardIo('t:a', a.op, { timeoutMs: 2000 }), { ok: true, value: 'veio' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(guard.stats(), { pending: 0, hung: 0 });
    // erro de verdade é devolvido como erro (não como prazo estourado)
    const bad = await guard.guardIo('t:erro', () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })), { timeoutMs: 500 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'EACCES');

    // no máximo MAX_HUNG pastas diferentes penduradas: a seguinte responde "não sei" na hora, sem chamar o sistema
    const many = Array.from({ length: guard.MAX_HUNG }, (_, i) => hang(`m${i}`));
    for (const h of many) assert.equal((await guard.guardIo(`t:${h.name}`, h.op, { timeoutMs: 20 })).timedOut, true);
    assert.equal(guard.stats().hung, guard.MAX_HUNG);
    const extra = hang('extra');
    assert.deepEqual(await guard.guardIo('t:extra', extra.op, { timeoutMs: 20 }), { timedOut: true, skipped: true });
    assert.equal(extra.calls(), 0);
  } finally {
    for (const g of gates) g.resolve(null);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.deepEqual(guard.stats(), { pending: 0, hung: 0 }, 'o teste não deixa nada pendurado para os outros');
});

test('checkFolder e detectObsAsync: existe / não existe / sem resposta, igual à leitura síncrona quando o disco responde', async () => {
  const guard = require('../src/core/sources/fsGuard');
  const root = tmp('guard');
  try {
    const dir = path.join(root, 'REC');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(root, 'arquivo.txt'), 'x');
    assert.deepEqual(await guard.checkFolder(dir), { exists: true });
    assert.deepEqual(await guard.checkFolder(path.join(root, 'nao-existe')), { exists: false });
    assert.deepEqual(await guard.checkFolder(path.join(root, 'arquivo.txt')), { exists: false }, 'arquivo não é pasta');
    assert.deepEqual(await guard.checkFolder(''), { exists: false });

    // leitura que nunca volta: exists null + nota que explica (nunca "existe" nem "não existe")
    const gate = deferred();
    const realStat = fs.promises.stat;
    fs.promises.stat = (target, ...rest) => (String(target).includes('rede-fora-do-ar') ? gate.promise : realStat.call(fs.promises, target, ...rest));
    try {
      const obsDir = path.join(root, 'obs-studio');
      for (const [name, folder] of [['Local', dir], ['Rede', path.join(root, 'rede-fora-do-ar')], ['Vazio', '']]) {
        fs.mkdirSync(path.join(obsDir, 'basic', 'profiles', name), { recursive: true });
        fs.writeFileSync(path.join(obsDir, 'basic', 'profiles', name, 'basic.ini'), `[General]\nName=${name}\n[Output]\nMode=Simple\n[SimpleOutput]\nFilePath=${folder.replace(/\\/g, '/')}\n`);
      }
      fs.writeFileSync(path.join(obsDir, 'user.ini'), '[Basic]\nProfile=Rede\nProfileDir=Rede\n');
      const started = Date.now();
      const found = await obs.detectObsAsync({ obsDir, timeoutMs: 80 });
      assert.ok(Date.now() - started < 1500);
      const byName = Object.fromEntries(found.profiles.map((p) => [p.name, p]));
      assert.equal(byName.Local.exists, true);
      assert.equal(byName.Rede.exists, null);
      assert.match(byName.Rede.note, /Não consegui acessar a pasta de gravação/);
      assert.equal(byName.Vazio.exists, false);
      assert.equal(byName.Rede.active, true);
      // a leitura "só da configuração" nem encosta nas pastas
      const light = obs.detectObs({ obsDir, checkFolders: false });
      assert.deepEqual(light.profiles.map((p) => p.exists), [null, null, null]);
      assert.deepEqual(obs.candidateFolders(light).map((f) => f.profile), ['Rede', 'Local']);
      // e a leitura síncrona de antes continua igual quando o disco responde (a pasta de rede deste teste é inexistente de verdade)
      fs.promises.stat = realStat;
      const sync = obs.detectObs({ obsDir });
      assert.deepEqual(sync.profiles.map((p) => [p.name, p.exists]), [['Rede', false], ['Local', true], ['Vazio', false]]);
    } finally {
      fs.promises.stat = realStat;
      gate.resolve(null);
      await new Promise((r) => setTimeout(r, 30));
    }
  } finally { rm(root); }
});

test('listRecordings: pasta que não responde no prazo explica o problema em vez de esperar', async () => {
  const root = tmp('list-hang');
  const gate = deferred();
  const realReaddir = fs.promises.readdir;
  try {
    fs.promises.readdir = (target, ...rest) => (String(target).includes('rede-fora-do-ar') ? gate.promise : realReaddir.call(fs.promises, target, ...rest));
    const started = Date.now();
    const res = await listRecordings(path.join(root, 'rede-fora-do-ar'), { readdirTimeoutMs: 80 });
    assert.ok(Date.now() - started < 1500);
    assert.equal(res.exists, false);
    assert.deepEqual(res.files, []);
    assert.match(res.error, /não respondeu a tempo/);
    assert.match(res.error, /Atualizar/);
  } finally {
    fs.promises.readdir = realReaddir;
    gate.resolve([]);
    await new Promise((r) => setTimeout(r, 30));
    rm(root);
  }
});

// ------------------------------------------------------------------ gravações

test('startedAtFromName entende o nome padrão do OBS e recusa o resto', () => {
  const d = startedAtFromName('2026-10-21 03-12-45.mkv');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 9);
  assert.equal(d.getDate(), 21);
  assert.equal(d.getHours(), 3);
  assert.equal(d.getMinutes(), 12);
  assert.equal(d.getSeconds(), 45);
  assert.ok(startedAtFromName('2026-10-21_03.12.45 Replay.mp4'));
  assert.equal(startedAtFromName('minha live.mp4'), null);
  assert.equal(startedAtFromName('2026-13-45 99-99-99.mp4'), null);
});

test('listRecordings: só extensões de vídeo, mais recente primeiro, duração real do ffprobe', { skip: skipMedia }, async () => {
  const dir = tmp('list');
  try {
    sampleVideo(tools.ffmpeg, path.join(dir, '2026-10-19 20-00-00.mp4'), { seconds: 3 });
    sampleVideo(tools.ffmpeg, path.join(dir, '2026-10-21 03-12-45.mkv'), { seconds: 5 });
    fs.copyFileSync(path.join(dir, '2026-10-19 20-00-00.mp4'), path.join(dir, 'sem data no nome.mov'));
    fs.writeFileSync(path.join(dir, 'notas.txt'), 'não é vídeo');
    fs.writeFileSync(path.join(dir, 'capa.png'), 'x');
    fs.mkdirSync(path.join(dir, 'subpasta.mp4')); // pasta com nome de vídeo
    const stamp = new Date(2026, 9, 18, 12, 0, 0); // sem data no nome: vale a data do arquivo (18/10/2026)
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile()) fs.utimesSync(path.join(dir, f), stamp, stamp);

    const res = await listRecordings(dir, { ffprobe: tools.ffprobe });
    assert.equal(res.exists, true);
    assert.equal(res.total, 3);
    assert.equal(res.truncated, false);
    assert.equal(res.recording, 0);
    assert.deepEqual(res.files.map((f) => f.name), ['2026-10-21 03-12-45.mkv', '2026-10-19 20-00-00.mp4', 'sem data no nome.mov'], 'pela data do nome (ou do arquivo), mais recente primeiro');
    assert.ok(Math.abs(res.files[0].durationSec - 5) < 0.6, `duração ${res.files[0].durationSec}`);
    const mp4 = res.files.find((f) => f.name.endsWith('.mp4'));
    assert.ok(Math.abs(mp4.durationSec - 3) < 0.6);
    assert.ok(res.files.every((f) => f.recording === false && f.size > 0 && typeof f.startedAt === 'string'));
    assert.deepEqual([...EXTENSIONS].sort(), ['.flv', '.mkv', '.mov', '.mp4', '.ts']);
  } finally { rm(dir); }
});

test('listRecordings marca "gravando" um arquivo que está crescendo e não o que já terminou', { skip: skipMedia }, async () => {
  const dir = tmp('rec');
  let writer = null;
  try {
    sampleVideo(tools.ffmpeg, path.join(dir, '2026-10-20 10-00-00.mp4'), { seconds: 2 });
    const done = new Date(Date.now() - 600000);
    fs.utimesSync(path.join(dir, '2026-10-20 10-00-00.mp4'), done, done);
    // "OBS": outro processo escrevendo de verdade num .mkv durante a listagem
    const live = path.join(dir, '2026-10-21 04-00-00.mkv');
    writer = spawn(process.execPath, ['-e', `
      const fs = require('fs'); const f = process.argv[1];
      const fd = fs.openSync(f, 'w');
      const t = setInterval(() => fs.writeSync(fd, Buffer.alloc(40000, 1)), 100);
      setTimeout(() => { clearInterval(t); fs.closeSync(fd); process.exit(0); }, 8000);
    `, live], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 700));

    const res = await listRecordings(dir, { ffprobe: tools.ffprobe, sampleMs: 600 });
    const byName = Object.fromEntries(res.files.map((f) => [f.name, f]));
    assert.equal(byName['2026-10-21 04-00-00.mkv'].recording, true, 'cresceu durante a amostragem');
    assert.equal(byName['2026-10-21 04-00-00.mkv'].durationSec, null, 'sem duração enquanto grava');
    assert.equal(byName['2026-10-20 10-00-00.mp4'].recording, false);
    assert.ok(byName['2026-10-20 10-00-00.mp4'].durationSec > 1);
    assert.equal(res.recording, 1);
  } finally {
    if (writer) { writer.kill(); await new Promise((r) => setTimeout(r, 300)); }
    rm(dir);
  }
});

test('listRecordings: arquivo recente mas parado, pasta inexistente e limite da lista', { skip: skipMedia }, async () => {
  const dir = tmp('rec2');
  try {
    sampleVideo(tools.ffmpeg, path.join(dir, 'a.mp4'), { seconds: 1 });
    const t = new Date(Date.now() - 20000); // 20 s atrás: dentro da janela "recente", mas parado e fora do "silêncio"
    fs.utimesSync(path.join(dir, 'a.mp4'), t, t);
    const res = await listRecordings(dir, { ffprobe: tools.ffprobe, sampleMs: 300 });
    assert.equal(res.files[0].recording, false, 'parado há 20 s = terminado');
    assert.ok(res.files[0].durationSec > 0.5);

    const missing = await listRecordings(path.join(dir, 'nao-existe'), {});
    assert.equal(missing.exists, false);
    assert.match(missing.error, /não existe/);
    assert.deepEqual(missing.files, []);

    for (let i = 0; i < 5; i++) fs.copyFileSync(path.join(dir, 'a.mp4'), path.join(dir, `2026-01-0${i + 1} 10-00-00.mp4`));
    const limited = await listRecordings(dir, { ffprobe: tools.ffprobe, limit: 3, sampleMs: 100 });
    assert.equal(limited.total, 6);
    assert.equal(limited.files.length, 3);
    assert.equal(limited.truncated, true);

    const noProbe = await listRecordings(dir, { ffprobe: null, limit: 2, sampleMs: 100 });
    assert.ok(noProbe.files.every((f) => f.durationSec === null), 'sem ffprobe a lista continua, sem duração');
  } finally { rm(dir); }
});

test('pasta com muitas gravações: só as mais recentes têm duração na hora, o resto fica pendente e probeFiles completa', { skip: skipMedia }, async () => {
  const { probeFiles } = require('../src/core/sources/recordings');
  const dir = tmp('many');
  try {
    sampleVideo(tools.ffmpeg, path.join(dir, 'base.mp4'), { seconds: 1, size: '160x90' });
    const old = new Date(2026, 8, 1);
    for (let i = 1; i <= 6; i++) {
      const file = path.join(dir, `2026-09-0${i} 10-00-00.mp4`);
      fs.copyFileSync(path.join(dir, 'base.mp4'), file);
      fs.utimesSync(file, old, old);
    }
    fs.rmSync(path.join(dir, 'base.mp4'));
    const res = await listRecordings(dir, { ffprobe: tools.ffprobe, probeLimit: 2 });
    assert.equal(res.files.length, 6);
    assert.deepEqual(res.files.map((f) => f.durationPending), [false, false, true, true, true, true]);
    assert.ok(res.files[0].durationSec > 0.5 && res.files[1].durationSec > 0.5);
    assert.ok(res.files.slice(2).every((f) => f.durationSec === null), 'pendente não é "0": a interface mostra "…"');

    const pending = res.files.filter((f) => f.durationPending).map((f) => f.path);
    const filled = await probeFiles(tools.ffprobe, [...pending, path.join(dir, 'nao-existe.mp4'), path.join(dir, 'notas.txt'), 42, null]);
    assert.deepEqual(Object.keys(filled).sort(), [...pending, path.join(dir, 'nao-existe.mp4')].sort(), 'só arquivos de vídeo; texto e lixo são ignorados');
    for (const p of pending) assert.ok(filled[p] > 0.5, p);
    assert.equal(filled[path.join(dir, 'nao-existe.mp4')], null);
    assert.deepEqual(await probeFiles(tools.ffprobe, 'não é lista'), {});
    // com o cache cheio, uma nova listagem já traz todas as durações
    const again = await listRecordings(dir, { ffprobe: tools.ffprobe, probeLimit: 2 });
    assert.ok(again.files.every((f) => f.durationPending === false && f.durationSec > 0.5));
    // sem ffprobe: nada pendente (não há o que pedir depois)
    const none = await listRecordings(dir, { ffprobe: null, probeLimit: 2 });
    assert.ok(none.files.every((f) => f.durationSec === null && f.durationPending === false));
  } finally { rm(dir); }
});
