'use strict';

/**
 * E2E do proxy de visualização, no app Electron de verdade (perfil temporário, vídeos gerados):
 *  - um vídeo que o Chromium NÃO toca (MPEG-4 parte 2 em .avi, sem decodificador no navegador) dá erro no player; o app, em vez de só avisar, cria a cópia leve
 *    (H.264 até 720p), troca o player para ela na mesma posição e o projeto continua apontando para o ARQUIVO ORIGINAL;
 *  - um vídeo com áudio AC-3 (o Chromium toca o vídeo mudo, sem erro) já pede a cópia ao abrir, sem esperar erro nenhum;
 *  - um vídeo comum (H.264 + AAC) não cria nada.
 * Uso: node tests/e2e/proxy.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const { ffmpeg, ffprobe } = locateTools();
const { waitFor } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;

function makeVideo(file, videoArgs, audioArgs, { seconds = 6, size = '1280x720', rate = 15 } = {}) {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, ...videoArgs, ...audioArgs, '-shortest', file], { windowsHide: true });
}

const probe = (file) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true }).toString());

async function main() {
  const tmp = h.mkTemp('proxy-');
  let app = null;
  try {
    const avi = path.join(tmp, 'gravacao-mpeg4.avi');
    makeVideo(avi, ['-c:v', 'mpeg4', '-q:v', '5'], ['-c:a', 'mp3']);
    const ac3 = path.join(tmp, 'gravacao-ac3.mkv');
    makeVideo(ac3, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'ac3']);
    const plain = path.join(tmp, 'comum.mp4');
    makeVideo(plain, ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], ['-c:a', 'aac']);

    app = await h.launchApp(path.join(tmp, 'ud'), {});
    const { page } = app;
    const ev = (x) => page.eval(x);
    const proxyDir = () => path.join(tmp, 'ud', 'cache', 'proxy');
    const readyProxies = () => (fs.existsSync(proxyDir()) ? fs.readdirSync(proxyDir()).filter((f) => f.endsWith('.mp4')) : []);

    // ---- vídeo que o player não toca: erro -> cópia leve -> o player troca
    await ev(`BF.openSource(${j(avi)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('gravacao-mpeg4.avi')", 30000, 'o .avi aberto');
    await waitFor(page, 'BF.proxy.state.using === true', 90000, 'o player trocar para a cópia leve');
    assert.equal(await ev("BF.state.project.source.path.endsWith('gravacao-mpeg4.avi')"), true, 'o projeto continua apontando para o original');
    assert.equal(await ev("BF.state.url.endsWith('.avi')"), true, 'BF.state.url é a do original; só o player usa a cópia');
    assert.equal(await ev("/\\/proxy\\/[0-9a-f]+\\.mp4$/.test(document.getElementById('video').getAttribute('src'))"), true, 'o <video> toca a cópia da pasta de cache');
    await waitFor(page, "document.getElementById('video').readyState >= 1", 20000, 'a cópia carregar no player');
    const proxies = readyProxies();
    assert.equal(proxies.length, 1);
    const info = probe(path.join(proxyDir(), proxies[0]));
    const v = info.streams.find((s) => s.codec_type === 'video');
    assert.equal(v.codec_name, 'h264');
    assert.deepEqual([v.width, v.height], [1280, 720]);
    const original = probe(avi);
    assert.ok(Math.abs(Number(info.format.duration) - Number(original.format.duration)) < 0.25, `duração da cópia ${info.format.duration} x original ${original.format.duration}`);
    const playerDuration = await ev("document.getElementById('video').duration");
    assert.ok(Math.abs(playerDuration - Number(original.format.duration)) < 0.25, 'o player mede a mesma duração do original');
    step('MPEG-4 em .avi: o erro do player cria a cópia leve (H.264 720p, mesma duração), o player troca e o projeto segue no original');

    // ---- áudio AC-3: pede a cópia ao abrir, sem erro
    await ev(`BF.openSource(${j(ac3)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('gravacao-ac3.mkv')", 30000, 'o .mkv aberto');
    await waitFor(page, 'BF.proxy.state.using === true', 90000, 'o player trocar para a cópia do vídeo com AC-3');
    assert.equal(readyProxies().length, 2);
    const ac3Proxy = readyProxies().map((f) => probe(path.join(proxyDir(), f))).find((i) => Math.abs(Number(i.format.duration) - 6) < 0.3 && i.streams.some((s) => s.codec_name === 'aac'));
    assert.ok(ac3Proxy, 'a cópia do AC-3 tem áudio AAC (o Chromium toca)');
    step('áudio AC-3: já ao abrir o app cria a cópia, e o áudio da cópia é AAC');

    // ---- vídeo comum: nada é criado
    await ev(`BF.openSource(${j(plain)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('comum.mp4')", 30000, 'o .mp4 aberto');
    await waitFor(page, "document.getElementById('video').readyState >= 1", 20000, 'o vídeo comum carregar');
    assert.equal(await ev('BF.proxy.state.using'), false);
    assert.equal(readyProxies().length, 2, 'nenhuma cópia nova para o vídeo comum');
    assert.equal(await ev("document.getElementById('video').getAttribute('src').endsWith('comum.mp4')"), true);
    step('H.264 + AAC: toca direto, sem cópia');

    // ---- reabrir o .avi usa a cópia que já existe (sem ffmpeg novo)
    await ev(`BF.openSource(${j(avi)})`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('gravacao-mpeg4.avi')", 30000, 'o .avi reaberto');
    await waitFor(page, 'BF.proxy.state.using === true', 30000, 'o player usar a cópia já pronta');
    assert.equal(readyProxies().length, 2, 'a cópia do cache foi reaproveitada');
    step('reabrir o mesmo vídeo reaproveita a cópia do cache');

    h.assertNoConsoleErrors(page, [/Autofill|favicon|Failed to load resource|MEDIA_ELEMENT_ERROR|Media/i]);
    await app.stop(); app = null;
    console.log('\nE2E DO PROXY OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });
