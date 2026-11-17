'use strict';

/**
 * FFmpeg: teste de REDE REAL que EXECUTA o programa baixado. Fica DESLIGADO por padrão (baixa ~100 MB e roda um programa de terceiros);
 * ligue com
 *     BF_NETWORK_TESTS=1 BF_NETWORK_FFMPEG=1 node --test tests/ffmpeg-network.test.js
 * (ou `BF_NETWORK_FFMPEG=1 npm run test:network`). Só Windows 64 bits: é o único sistema para o qual a entrada tem pacote.
 *
 * O que confere de verdade, com o pacote REAL da entrada `ffmpeg` do catálogo (src/core/tools/entries/ffmpeg.js):
 *  - a entrada bate com a API de releases do GitHub (tamanho e SHA-256 do "digest"), para avisar se a release mudar;
 *  - o ToolInstaller baixa, confere tamanho e SHA-256, extrai e instala o ffmpeg E o ffprobe do mesmo pacote;
 *  - os programas respondem com a versão fixada e a configuração é GPL v3 sem "nonfree", com libx264, libx265 e libass;
 *  - a lista de filtros tem `subtitles` (legenda incorporada) e a de codificadores tem libx264, libx265 e os dois NVENC;
 *  - um encode de verdade (1 s de vídeo de teste em libx264) sai e o ffprobe o lê;
 *  - o app enxerga os dois como instalados pelo app (resolveTools) e a detecção de codificadores do app (detectEncoders) acha o software.
 * O que NÃO confere: o NVENC de fato (precisa de placa NVIDIA; a detecção do app o testa com um mini-encode e diz o motivo se faltar).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const registry = require('../src/core/tools/registry');
const { ToolInstaller } = require('../src/core/tools/ToolInstaller');
const { resolveTools } = require('../src/ipc/context');
const encoders = require('../src/core/export/encoders');

const NET = process.env.BF_NETWORK_TESTS === '1';
const supported = process.platform === 'win32' && process.arch === 'x64';
// só consulta a API do GitHub: basta a rede ligada
const skipApi = NET ? false : 'rede real desligada (BF_NETWORK_TESTS=1 liga)';
// baixa ~100 MB e EXECUTA o programa baixado: precisa também de BF_NETWORK_FFMPEG=1
const skip = !NET || process.env.BF_NETWORK_FFMPEG !== '1' ? 'desligado (BF_NETWORK_TESTS=1 e BF_NETWORK_FFMPEG=1 ligam; baixa ~100 MB e executa o ffmpeg baixado)' : (!supported ? 'só Windows 64 bits' : false);
const run = (exe, args, timeout = 120000) => execFileSync(exe, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'braga-frame-test', Accept: 'application/vnd.github+json' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

test('a entrada ffmpeg bate com a release do GitHub (tamanho e SHA-256 do digest)', { skip: skipApi, timeout: 60000 }, async () => {
  const entry = registry.getEntry('ffmpeg');
  const asset = registry.assetFor(entry, 'win32', 'x64');
  const rel = await getJson(`https://api.github.com/repos/GyanD/codexffmpeg/releases/tags/${entry.version}`);
  const file = (rel.assets || []).find((a) => a.name === asset.name);
  assert.ok(file, `a release ${entry.version} tem o arquivo ${asset.name}`);
  assert.equal(file.size, asset.size, 'tamanho');
  assert.equal(String(file.digest).replace(/^sha256:/, ''), asset.sha256, 'SHA-256');
});

test('instala o FFmpeg REAL pelo ToolInstaller e confere o que o app usa', { skip, timeout: 20 * 60 * 1000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-ffmpeg-net-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));
  const toolsDir = path.join(base, 'tools');
  const entry = registry.getEntry('ffmpeg');
  const installer = new ToolInstaller({ toolsDir, entries: [entry] });
  const res = await installer.install('ffmpeg');
  assert.equal(res.alreadyInstalled, false);
  const extras = registry.resolveExtras(toolsDir, 'ffmpeg', { entries: [entry] });
  assert.ok(extras.ffprobe && fs.existsSync(extras.ffprobe), 'o ffprobe veio do mesmo pacote');

  // versão e configuração (GPL v3, sem nonfree, com as bibliotecas que o app usa)
  const version = run(res.exe, ['-version']);
  assert.match(version.split(/\r?\n/)[0], new RegExp(`ffmpeg version ${entry.version.replace(/\./g, '\\.')}`));
  for (const flag of ['--enable-gpl', '--enable-version3', '--enable-libx264', '--enable-libx265', '--enable-libass']) assert.ok(version.includes(flag), flag);
  assert.ok(!version.includes('--enable-nonfree'), 'sem componentes não redistribuíveis');
  assert.match(run(extras.ffprobe, ['-version']), /^ffprobe version /);

  // filtros e codificadores
  assert.match(run(res.exe, ['-hide_banner', '-filters']), /\bsubtitles\b/, 'filtro de legenda incorporada');
  const enc = run(res.exe, ['-hide_banner', '-encoders']);
  for (const name of ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc']) assert.match(enc, new RegExp(`\\b${name}\\b`), name);

  // um encode de verdade e a leitura pelo ffprobe do mesmo pacote
  const out = path.join(base, 'teste.mp4');
  run(res.exe, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x180:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', out]);
  const probe = JSON.parse(run(extras.ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', out]));
  assert.equal(probe.streams[0].codec_name, 'h264');
  assert.deepEqual([probe.streams[0].width, probe.streams[0].height], [320, 180]);
  assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.2, 'duração de ~1 s');

  // o app enxerga os dois como instalados por ele e a detecção de codificadores do app acha o software
  const found = resolveTools({ paths: { tools: toolsDir }, env: {}, entries: [entry] });
  assert.equal(found.ffmpeg, res.exe);
  assert.equal(found.ffprobe, extras.ffprobe);
  const detection = await encoders.detectEncoders({ ffmpeg: res.exe, force: true });
  assert.equal(detection.software.h264, true);
  assert.equal(detection.software.h265, true);
});
