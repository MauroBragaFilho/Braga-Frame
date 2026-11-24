'use strict';

/**
 * E2E do cartão "Exportar para o editor de vídeo" (aba Exportar): abre o app Electron de verdade, cria cortes com legenda num vídeo
 * real (quadros por segundo medidos pelo ffprobe), clica em exportar com a pasta já escolhida e confere os arquivos gravados:
 * XML (Final Cut 7), EDL, lista de tempos, .srt/.ass alinhados à timeline e o estilo; nada sobrescrito na segunda vez; erro claro sem aprovados.
 * Uso: node tests/e2e/export-editor.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const fx = require('../export-fixtures');

const { waitFor } = h;
const { tools } = fx;
const step = (m) => console.log(`✔ ${m}`);
const J = JSON.stringify;

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-export-editor');
  const userData = path.join(tmp, 'userdata');
  const source = path.join(tmp, 'minha live.mp4');
  const out = path.join(tmp, 'Para o editor');
  fs.mkdirSync(out, { recursive: true });
  try {
    fx.makeCodedSource(source, { width: 1280, height: 720, fps: 25, seconds: 30 });
    step('vídeo de teste (1280x720, 25 quadros/s, 30 s) gerado');

    const app = await h.launchApp(userData);
    const page = app.page;
    const ev = (expr) => page.eval(expr);
    await ev(`BF.openSource(${J(source)})`);
    await waitFor(page, 'BF.state.project && BF.state.info && BF.state.info.duration > 20', 30000, 'vídeo aberto');
    await ev(`(() => {
      const mk = (title, start, end, status) => { const c = BF.project.addCut({ title, start, end }); BF.project.update(() => { c.status = status; }, { reason: 'teste' }); return c; };
      const a = mk('Primeiro & "melhor"', 2, 8, 'approved');
      mk('Segundo', 12, 20.4, 'approved');
      mk('Pendente', 22, 28, 'pending');
      BF.project.update((p) => { p.cuts.find((c) => c.id === a.id).subtitles = { enabled: true, basedOn: { start: 2, end: 8 }, cues: [{ start: 0.5, end: 2, text: 'Olá, tudo bem?' }, { start: 3, end: 4.5, text: 'Segunda fala' }], style: {} }; }, { reason: 'teste' });
      BF.bus.emit('cuts:changed', {});
      BF.ui.selectTab('export');
    })()`);
    await waitFor(page, "!!document.getElementById('exp-editor') && !document.getElementById('exp-ed-run').disabled", 15000, 'cartão do editor habilitado');
    assert.match(await ev("document.getElementById('exp-ed-info').textContent"), /2 cortes · 1 com legenda gerada/);
    assert.equal(await ev("document.getElementById('exp-ed-xml').checked && !document.getElementById('exp-ed-edl').checked && document.getElementById('exp-ed-subs').checked"), true, 'XML e legendas ligados por padrão');
    step('cartão mostra 2 cortes aprovados e 1 com legenda');

    // a pasta já escolhida: o diálogo do sistema não abre no teste
    await ev(`(() => { window.__api = BF.api; BF.api = async (c, p, o) => (c === 'export:pickDir' ? { ok: true, path: ${J(out)} } : window.__api(c, p, o)); })()`);
    await ev("document.getElementById('exp-ed-edl').click(); document.getElementById('exp-ed-times').click()");
    await ev("document.getElementById('exp-ed-run').click()");
    await waitFor(page, "/arquivos gravados/.test(document.getElementById('exp-ed-msg').textContent)", 30000, 'exportação concluída');
    const files = fs.readdirSync(out).sort();
    assert.deepEqual(files, ['minha live - estilo da legenda.json', 'minha live - tempos.txt', 'minha live.ass', 'minha live.edl', 'minha live.srt', 'minha live.xml']);
    step(`arquivos gravados: ${files.join(', ')}`);

    const xml = fs.readFileSync(path.join(out, 'minha live.xml'), 'utf8');
    assert.match(xml, /<timebase>25<\/timebase><ntsc>FALSE<\/ntsc>/, 'quadros por segundo medidos pelo ffprobe');
    assert.match(xml, /<width>1280<\/width><height>720<\/height>/);
    assert.equal((xml.match(/<clipitem id="clipitem-v-/g) || []).length, 2, 'só os 2 aprovados');
    assert.match(xml, /<name>Primeiro &amp; &quot;melhor&quot;<\/name>/);
    assert.match(xml, /<in>50<\/in><out>200<\/out>/, '2 s a 8 s a 25 quadros/s');
    assert.match(xml, /<pathurl>file:\/\/localhost\/[A-Za-z]%3a\/.*minha%20live\.mp4<\/pathurl>/);
    assert.equal(fs.readFileSync(path.join(out, 'minha live - tempos.txt'), 'utf8'), '00:00:02.000 -> 00:00:08.000\n00:00:12.000 -> 00:00:20.400\n');
    assert.match(fs.readFileSync(path.join(out, 'minha live.edl'), 'utf8'), /001 {2}AX {7}B {5}C {8}00:00:02:00 00:00:08:00 00:00:00:00 00:00:06:00/);
    const srt = fs.readFileSync(path.join(out, 'minha live.srt'), 'utf8');
    assert.match(srt, /1\n00:00:00,500 --> 00:00:02,000\nOlá, tudo bem\?\n/);
    assert.match(srt, /2\n00:00:03,000 --> 00:00:04,500\nSegunda fala\n/);
    assert.match(fs.readFileSync(path.join(out, 'minha live.ass'), 'utf8'), /PlayResX: 1280/);
    assert.ok(JSON.parse(fs.readFileSync(path.join(out, 'minha live - estilo da legenda.json'), 'utf8')).fontFamily);
    assert.equal(await ev("document.getElementById('exp-ed-reveal').hidden"), false, 'Mostrar na pasta aparece');
    assert.match(await ev("document.getElementById('exp-ed-warn').textContent"), /1 corte\(s\) não têm legenda/);
    step('XML, EDL, tempos, legendas e estilo conferidos (acentos e aspas escapados, tempos em quadros)');

    // segunda vez: nada é sobrescrito
    const before = fs.readFileSync(path.join(out, 'minha live.xml'), 'utf8');
    await ev("document.getElementById('exp-ed-run').click()");
    const until = Date.now() + 30000;
    while (Date.now() < until && !fs.existsSync(path.join(out, 'minha live (2).srt'))) await h.sleep(100);
    const after = fs.readdirSync(out).sort();
    assert.ok(after.includes('minha live (2).xml'), `(2) criado: ${after.join(', ')}`);
    assert.equal(fs.readFileSync(path.join(out, 'minha live.xml'), 'utf8'), before, 'o primeiro conjunto continua igual');
    step('segunda exportação: conjunto "(2)", o primeiro intacto');

    // sem aprovados: aviso claro e nada gravado
    await ev("BF.project.update((p) => { for (const c of p.cuts) c.status = 'pending'; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', {})");
    await waitFor(page, "document.getElementById('exp-ed-run').disabled", 5000, 'botão parado sem aprovados');
    assert.match(await ev("document.getElementById('exp-ed-info').textContent"), /Nenhum corte aprovado/);
    step('sem cortes aprovados o botão fica parado e diz por quê');

    assert.deepEqual(await ev('BF.state.loadErrors'), []);
    await app.stop();
    console.log('\nE2E OK');
  } finally {
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => {
  console.error(`\n✖ E2E FALHOU: ${err.message}`);
  h.cleanupAll().finally(() => process.exit(1));
});
