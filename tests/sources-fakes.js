'use strict';

/**
 * Ajudantes dos testes do recurso Fontes (dono: sources).
 *
 *  - makeFakeExe(dir, name): cria `<dir>/<name>.exe` + `<dir>/<name>.js`. O .exe é um lançador mínimo (compilado na hora
 *    com o csc.exe do .NET Framework que acompanha o Windows) que roda `node <name>.js <argumentos>` herdando
 *    stdout/stderr; assim o app executa um "yt-dlp"/"TwitchDownloaderCLI" FALSO como um programa de verdade (spawn
 *    de .exe, cancelamento por taskkill /T, saída em pipe), sem depender de .cmd. É SÓ para testes: o programa
 *    falso imita a saída real (linhas "BFP|…" do yt-dlp, JSON de metadados, erros reais) mas não baixa nada.
 *  - fakeScenario(dir, scenario): grava `<dir>/scenario.json`, lido pelo programa falso a cada execução.
 *  - startMediaServer(file, { rate }): servidor HTTP local de verdade para o yt-dlp REAL baixar (com Range, para
 *    retomar, e velocidade limitada para dar tempo de cancelar).
 *  - sampleVideo(ffmpeg, file): vídeo curto gerado com o ffmpeg (lavfi).
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CS = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
public static class P {
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    int bs = 0;
    foreach (char c in a) {
      if (c == '\\') bs++;
      else if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
      else { sb.Append('\\', bs); bs = 0; sb.Append(c); }
    }
    sb.Append('\\', bs * 2); sb.Append('"');
    return sb.ToString();
  }
  public static int Main(string[] args) {
    string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string script = Path.ChangeExtension(self, ".js");
    string node = Environment.GetEnvironmentVariable("BF_FAKE_NODE");
    if (string.IsNullOrEmpty(node)) node = "node.exe";
    var psi = new ProcessStartInfo(node);
    psi.UseShellExecute = false;
    var sb = new StringBuilder(Quote(script));
    foreach (var a in args) sb.Append(' ').Append(Quote(a));
    psi.Arguments = sb.ToString();
    using (var p = Process.Start(psi)) { p.WaitForExit(); return p.ExitCode; }
  }
}
`;

let compiled = null; // caminho do lançador compilado (uma vez por processo de teste)

function findCsc() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  for (const arch of ['Framework64', 'Framework']) {
    const file = path.join(root, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** Motivo para pular testes que precisam de programa falso, ou false se dá para rodar. */
function fakeExeSkipReason() {
  if (process.platform !== 'win32') return 'o programa falso de teste só existe para Windows (usa o csc.exe do .NET Framework)';
  return findCsc() ? false : 'csc.exe (.NET Framework) não encontrado';
}

function compileLauncher() {
  if (compiled && fs.existsSync(compiled)) return compiled;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-fakeexe-'));
  const src = path.join(dir, 'launcher.cs');
  const out = path.join(dir, 'launcher.exe');
  fs.writeFileSync(src, CS);
  const res = spawnSync(findCsc(), ['/nologo', '/target:exe', `/out:${out}`, src], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`Falha ao compilar o lançador de teste: ${res.stdout}${res.stderr}`);
  compiled = out;
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignorar */ } });
  return compiled;
}

/** Cria `<dir>/<name>.exe` (lançador) e `<dir>/<name>.js` (comportamento). Devolve o caminho do .exe. */
function makeFakeExe(dir, name, scriptSource) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, `${name}.exe`);
  fs.copyFileSync(compileLauncher(), exe);
  fs.writeFileSync(path.join(dir, `${name}.js`), scriptSource);
  return exe;
}

function fakeScenario(dir, scenario) {
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2));
}

// ---------- yt-dlp falso ----------

/**
 * Comportamento do yt-dlp falso (lê `scenario.json` ao lado do script):
 *   { metaFile, metaStderr, metaCode, sampleFile, downloadStderr, downloadCode, steps, stepMs, liveChatFile, liveChatWarn,
 *     version, delayBeforeMetaMs }
 * Imita as linhas reais do yt-dlp: "[info] …: Downloading 1 format(s): fake-1", "BFP|downloading|…", "BFPP|…".
 */
const FAKE_YTDLP = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8')); } catch { return {}; } })();
const args = process.argv.slice(2);
const has = (a) => args.includes(a);
const val = (a) => { const i = args.indexOf(a); return i >= 0 ? args[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = path.join(__dirname, 'calls.log');
fs.appendFileSync(log, JSON.stringify(args) + '\n');

(async () => {
  if (has('--version')) { console.log(cfg.version || '2099.01.01'); return; }
  if (has('-J')) {
    if (cfg.delayBeforeMetaMs) await sleep(cfg.delayBeforeMetaMs);
    if (cfg.metaStderr) process.stderr.write(cfg.metaStderr.replace(/\\n/g, '\n') + '\n');
    if (cfg.metaCode) process.exit(cfg.metaCode);
    process.stdout.write(fs.readFileSync(cfg.metaFile, 'utf8'));
    return;
  }
  if (has('--skip-download')) {
    const out = val('-o');
    if (cfg.downloadStderr) process.stderr.write(cfg.downloadStderr.replace(/\\n/g, '\n') + '\n');
    if (cfg.downloadCode) process.exit(cfg.downloadCode);
    if (cfg.liveChatWarn) { process.stderr.write('WARNING: [youtube] There are no subtitles for the requested languages\n'); return; }
    if (cfg.liveChatFile) {
      const dest = out.replace('%(ext)s', 'live_chat.json');
      console.log('[info] Writing video subtitles to: ' + dest);
      const text = fs.readFileSync(cfg.liveChatFile, 'utf8');
      const half = Math.floor(text.length / 2);
      fs.writeFileSync(dest, text.slice(0, half));
      await sleep(cfg.chatStepMs || 800);
      fs.appendFileSync(dest, text.slice(half));
    }
    return;
  }
  // download de vídeo
  const out = val('-o');
  const dir = path.dirname(out);
  fs.mkdirSync(dir, { recursive: true });
  const final = path.join(dir, 'video.mp4');
  const part = final + '.part';
  const sample = fs.readFileSync(cfg.sampleFile);
  const steps = cfg.steps || 10;
  const stepMs = cfg.stepMs || 100;
  console.log('[youtube] Extracting URL: fake');
  console.log('[info] fake: Downloading 1 format(s): fake-1');
  if (cfg.downloadStderr) process.stderr.write(cfg.downloadStderr.replace(/\\n/g, '\n') + '\n');
  if (cfg.downloadCode) process.exit(cfg.downloadCode);
  let from = 0;
  if (fs.existsSync(part)) { from = fs.statSync(part).size; console.log('[download] Resuming download at byte ' + from); }
  console.log('[download] Destination: ' + final);
  const total = sample.length;
  const chunk = Math.ceil(total / steps);
  for (let pos = from; pos < total; pos += chunk) {
    await sleep(stepMs);
    const end = Math.min(total, pos + chunk);
    fs.appendFileSync(part, sample.subarray(pos, end));
    console.log('BFP|downloading|' + end + '|' + total + '|NA|' + (chunk * 1000 / stepMs) + '|' + Math.ceil((total - end) / (chunk * 1000 / stepMs)) + '|NA|NA|fake-1');
  }
  console.log('BFP|finished|' + total + '|' + total + '|NA|NA|NA|NA|NA|fake-1');
  console.log('BFPP|started|Merger');
  await sleep(cfg.mergeMs || 150);
  fs.renameSync(part, final);
  console.log('BFPP|finished|Merger');
})();
`;

// ---------- TwitchDownloaderCLI falso ----------

/** Comportamento (scenario.json): { chatFile, stderr, code, stepMs }. Cria o JSON de saída em "-o". */
const FAKE_TDL = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json'), 'utf8')); } catch { return {}; } })();
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\n');
const val = (a) => { const i = args.indexOf(a); return i >= 0 ? args[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  if (args.includes('--version')) { console.log('TwitchDownloaderCLI 1.56.5+fake'); return; }
  for (const p of [10, 40, 80]) { await sleep(cfg.stepMs || 60); process.stdout.write('[STATUS] - Downloading ' + p + '%\r'); }
  if (cfg.stderr) { process.stderr.write(cfg.stderr.replace(/\\n/g, '\n') + '\n'); }
  if (cfg.code) process.exit(cfg.code);
  const out = val('-o');
  fs.writeFileSync(out, fs.readFileSync(cfg.chatFile));
  process.stdout.write('[STATUS] - Downloading 100%\n');
})();
`;

function makeFakeYtdlp(dir) { return makeFakeExe(dir, 'yt-dlp', FAKE_YTDLP); }
function makeFakeTwitchDownloader(dir) { return makeFakeExe(dir, 'TwitchDownloaderCLI', FAKE_TDL); }

// ---------- servidor de mídia ----------

/**
 * Servidor HTTP local que serve `file` em /clip.mp4 (com Range) e uma página em /page cujo <title> tem acentos,
 * símbolos e japonês (para testar UTF-8). `rate` = bytes por segundo (0 = sem limite).
 * @returns {Promise<{ url:(p:string)=>string, port:number, requests:Array, setRate(n:number), close():Promise<void> }>}
 */
function startMediaServer(file, { rate = 0 } = {}) {
  const size = fs.statSync(file).size;
  const state = { rate };
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, range: req.headers.range || null });
    if (req.url.startsWith('/page')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><head><title>Ação ✓ 日本語 — teste</title><meta property="og:video" content="http://127.0.0.1:${server.address().port}/clip.mp4"></head><body></body></html>`);
      return;
    }
    if (!req.url.startsWith('/clip.mp4')) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('não existe'); return; }
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      start = Number(m[1]);
      if (m[2]) end = Number(m[2]);
    }
    const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1 };
    if (range) { headers['content-range'] = `bytes ${start}-${end}/${size}`; res.writeHead(206, headers); } else res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file, { start, end, highWaterMark: state.rate ? Math.max(1024, Math.floor(state.rate / 10)) : 65536 });
    res.on('close', () => stream.destroy());
    if (!state.rate) { stream.pipe(res); return; }
    stream.on('data', (chunk) => { stream.pause(); res.write(chunk, () => setTimeout(() => stream.resume(), 100)); });
    stream.on('end', () => res.end());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, requests,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        setRate: (n) => { state.rate = n; },
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); })
      });
    });
  });
}

function sampleVideo(ffmpeg, file, { seconds = 8, size = '640x360' } = {}) {
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-b:v', '1500k', '-c:a', 'aac', '-shortest', file
  ], { windowsHide: true });
}

module.exports = { fakeExeSkipReason, makeFakeExe, makeFakeYtdlp, makeFakeTwitchDownloader, fakeScenario, startMediaServer, sampleVideo };
