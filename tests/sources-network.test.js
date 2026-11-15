'use strict';

/**
 * Fontes: testes de REDE REAL. Ficam DESLIGADOS por padrão (o conjunto normal não depende de internet nem do humor do
 * YouTube); ligue com  BF_NETWORK_TESTS=1 node --test tests/sources-network.test.js
 *   BF_NETWORK_TOOLS_ALL=1  também instala de verdade o TwitchDownloaderCLI (52 MB) e o Deno (42 MB).
 *
 * O que confere de verdade:
 *  - as entradas fixadas (ytdlp, twitchdownloader, deno) batem com a API oficial de releases do GitHub (URL, tamanho, SHA-256) e,
 *    no yt-dlp, com o arquivo oficial SHA2-256SUMS; assim ficam avisados quando uma atualização mexer nos valores;
 *  - o ToolInstaller baixa o yt-dlp da release oficial, confere tamanho e SHA-256 e o programa instalado responde com a versão fixada;
 *  - com esse yt-dlp: metadados e um download curto do vídeo público histórico "Me at the zoo" (19 s) numa pasta temporária;
 *  - chat de um vídeo que não foi live (resposta honesta de "sem chat") e o erro REAL do TwitchDownloaderCLI para um VOD inexistente.
 * Se o YouTube pedir confirmação de robô (acontece de forma intermitente), o teste diz isso e se marca como pulado: não é falha do app.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { locateTools } = require('../src/core/ffmpeg/locate');
const registry = require('../src/core/tools/registry');
const { ToolInstaller } = require('../src/core/tools/ToolInstaller');
const { SourcesManager } = require('../src/core/sources/SourcesManager');
const { downloadTwitchChat } = require('../src/core/sources/twitchChat');

const ON = process.env.BF_NETWORK_TESTS === '1';
const ALL = process.env.BF_NETWORK_TOOLS_ALL === '1';
const skip = ON ? false : 'rede real desligada (BF_NETWORK_TESTS=1 liga)';
const tools = locateTools();
const ZOO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `bf-src-net-${name}-`));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'braga-frame-tests', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} em ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function getText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'braga-frame-tests' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && redirects > 0) { res.resume(); resolve(getText(new URL(res.headers.location, url).toString(), redirects - 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} em ${url}`)); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

const REPOS = { ytdlp: 'yt-dlp/yt-dlp', twitchdownloader: 'lay295/TwitchDownloader', deno: 'denoland/deno' };

test('as entradas fixadas batem com a release oficial no GitHub (URL, tamanho e SHA-256)', { skip, timeout: 120000 }, async () => {
  const { entries, errors } = registry.loadRegistry({ strict: true });
  assert.deepEqual(errors, []);
  for (const id of Object.keys(REPOS)) {
    const entry = entries.find((e) => e.id === id);
    assert.ok(entry, `entrada ${id}`);
    const tagUrl = Object.values(entry.assets)[0].url.split('/releases/download/')[1].split('/')[0];
    const release = await getJson(`https://api.github.com/repos/${REPOS[id]}/releases/tags/${tagUrl}`);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, false);
    const sums = id === 'ytdlp' ? Object.fromEntries((await getText(`https://github.com/${REPOS[id]}/releases/download/${tagUrl}/SHA2-256SUMS`)).trim().split(/\r?\n/).map((l) => { const [hash, name] = l.split(/\s+/); return [name, hash]; })) : null;
    for (const [key, asset] of Object.entries(entry.assets)) {
      const remote = release.assets.find((a) => a.name === asset.name);
      assert.ok(remote, `${id} ${key}: arquivo ${asset.name} existe na release ${tagUrl}`);
      assert.equal(remote.browser_download_url, asset.url, `${id} ${key}: URL`);
      assert.equal(remote.size, asset.size, `${id} ${key}: tamanho`);
      assert.equal(remote.digest, `sha256:${asset.sha256}`, `${id} ${key}: SHA-256 (API)`);
      if (sums) assert.equal(sums[asset.name], asset.sha256, `${id} ${key}: SHA-256 (SHA2-256SUMS)`);
      if (id === 'deno') {
        const sidecar = release.assets.find((a) => a.name === `${asset.name}.sha256sum`);
        assert.ok(sidecar, `${id} ${key}: arquivo .sha256sum oficial existe`);
        assert.match((await getText(sidecar.browser_download_url)).toLowerCase(), new RegExp(asset.sha256), `${id} ${key}: SHA-256 (.sha256sum)`);
      }
    }
  }
});

let installedYtdlp = null;
let installRoot = null;

test('o ToolInstaller instala o yt-dlp da release oficial (tamanho + SHA-256) e ele responde com a versão fixada', { skip, timeout: 300000 }, async () => {
  installRoot = tmp('tools');
  const installer = new ToolInstaller({ toolsDir: installRoot });
  const phases = [];
  installer.on('progress', (ev) => phases.push(ev.phase));
  const res = await installer.install('ytdlp');
  assert.equal(res.alreadyInstalled, false);
  assert.ok(phases.includes('download') && phases.includes('verify') && phases.includes('done'));
  const entry = registry.getEntry('ytdlp');
  const asset = registry.assetFor(entry);
  assert.equal(fs.statSync(res.exe).size, asset.size);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(res.exe)).digest('hex'), asset.sha256);
  assert.equal(registry.resolveInstalled(installRoot, 'ytdlp'), res.exe);
  const version = execFileSync(res.exe, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(version, entry.version);
  installedYtdlp = res.exe;
  const again = await installer.install('ytdlp');
  assert.equal(again.alreadyInstalled, true, 'instalação íntegra não baixa de novo');
});

test('metadados e download real do vídeo público "Me at the zoo" com o yt-dlp instalado pelo app', { skip, timeout: 400000 }, async (t) => {
  assert.ok(installedYtdlp, 'o teste anterior instala o yt-dlp');
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários');
  const root = tmp('zoo');
  try {
    const events = [];
    const manager = new SourcesManager({
      paths: { userData: path.join(root, 'ud'), cache: path.join(root, 'cache') },
      getTools: () => ({ ytdlp: installedYtdlp, ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }),
      getDenoPath: () => null, findSystemDeno: () => null
    });
    manager.on('progress', (e) => events.push(e));

    let meta = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && !meta; attempt++) {
      try { meta = await manager.fetchVod(ZOO, { refresh: true }); } catch (err) { lastError = err; await sleep(4000); }
    }
    if (!meta) {
      assert.match(lastError.message, /robô|conexão|bloque|indispon/i, `falha inesperada: ${lastError.message}`);
      t.skip(`NÃO verificado: a consulta real falhou nas 3 tentativas (${lastError.code}: ${lastError.message.slice(0, 120)})`);
      return;
    }
    assert.equal(meta.meta.title, 'Me at the zoo');
    assert.equal(meta.meta.channel, 'jawed');
    assert.equal(meta.meta.duration, 19);
    assert.equal(meta.meta.uploadDate, '2005-04-24');
    assert.equal(meta.meta.videoId, 'jNQXAC9IVRw');
    assert.ok(meta.qualities.length >= 2);
    assert.equal(meta.chat.available, false, 'não foi uma live');
    assert.equal(meta.warnings.filter((w) => w.level === 'block').length, 0);

    const smallest = meta.qualities[meta.qualities.length - 1].id;
    const dest = path.join(root, 'VODs');
    let result = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try { result = await manager.download({ url: ZOO, dir: dest, quality: smallest }); } catch (err) { lastError = err; await sleep(4000); }
    }
    if (!result) {
      t.skip(`NÃO verificado: o download real falhou (${lastError.code}: ${lastError.message.slice(0, 120)})`);
      return;
    }
    assert.equal(path.basename(result.path), 'Me at the zoo [jNQXAC9IVRw].mp4');
    const dur = Number(execFileSync(tools.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', result.path], { encoding: 'utf8', windowsHide: true }).trim());
    assert.ok(Math.abs(dur - 19) < 2, `duração ${dur}`);
    assert.deepEqual(fs.readdirSync(dest), ['Me at the zoo [jNQXAC9IVRw].mp4'], 'sem pasta de trabalho nem .part');
    // vídeo + áudio vêm em arquivos separados: o percentual junta os dois e nunca recua
    const percents = events.filter((e) => e.percent !== null && e.phase !== 'done').map((e) => e.percent);
    for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], `percentual recuou: ${percents}`);
    assert.equal(events[events.length - 1].phase, 'done');
    assert.equal(result.origin.channel, 'jawed');

    // chat de um vídeo que não foi live: resposta honesta da fonte, sem erro nem arquivo
    await assert.rejects(manager.downloadChat({ url: ZOO }), (e) => e.code === 'NO_CHAT' && /não tem replay de chat/.test(e.message));
    assert.equal(fs.existsSync(path.join(root, 'ud', 'chats')), false, 'nenhum arquivo de chat foi criado');
  } finally { rm(root); }
});

test('TwitchDownloaderCLI real: VOD inexistente devolve a explicação em português (instala só com BF_NETWORK_TOOLS_ALL=1)', { skip: skip || (ALL ? false : 'defina BF_NETWORK_TOOLS_ALL=1 (baixa 52 MB)'), timeout: 600000 }, async () => {
  const root = tmp('tdl');
  try {
    const installer = new ToolInstaller({ toolsDir: path.join(root, 'tools') });
    const res = await installer.install('twitchdownloader');
    const entry = registry.getEntry('twitchdownloader');
    assert.equal(fs.statSync(res.exe).size > 1000000, true);
    const ver = spawnSync(res.exe, ['--version'], { encoding: 'utf8', windowsHide: true }); // sai com 1 e escreve a versão no stderr
    assert.ok(`${ver.stdout}${ver.stderr}`.includes(`TwitchDownloaderCLI ${entry.version}`), `versão: ${ver.stdout}${ver.stderr}`);
    await assert.rejects(
      downloadTwitchChat({ exe: res.exe, videoId: '99999999999', workDir: path.join(root, 'work') }),
      (e) => e.code === 'CHAT_VOD_GONE' && /apagado ou expirado/.test(e.message) && e.details.dependsOnAccess === true
    );
    assert.deepEqual(fs.readdirSync(path.join(root, 'work')).filter((n) => n.endsWith('.json')), [], 'nenhum JSON sobra');
  } finally { rm(root); }
});

test('Deno real: instala da release oficial e o yt-dlp o reconhece em --js-runtimes (BF_NETWORK_TOOLS_ALL=1)', { skip: skip || (ALL ? false : 'defina BF_NETWORK_TOOLS_ALL=1 (baixa 42 MB)'), timeout: 600000 }, async () => {
  assert.ok(installedYtdlp);
  const root = tmp('deno');
  try {
    const installer = new ToolInstaller({ toolsDir: path.join(root, 'tools') });
    const res = await installer.install('deno');
    const entry = registry.getEntry('deno');
    assert.match(execFileSync(res.exe, ['--version'], { encoding: 'utf8', windowsHide: true }), new RegExp(entry.version.replace(/\./g, '\\.')));
    assert.equal(registry.resolveInstalled(path.join(root, 'tools'), 'deno'), res.exe);
    // o yt-dlp sai com erro (URL inválida), mas escreve no cabeçalho do -v quais runtimes JS encontrou
    const run = spawnSync(installedYtdlp, ['-v', '--ignore-config', '--js-runtimes', `deno:${res.exe}`, '-s', 'https://invalid.invalid/x'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    assert.match(`${run.stdout}${run.stderr}`, /JS runtimes: deno-\d/, 'o yt-dlp lista o Deno instalado pelo app');
  } finally { rm(root); }
});

test.after(() => { if (installRoot) rm(installRoot); });
