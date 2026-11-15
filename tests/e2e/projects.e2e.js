'use strict';

/**
 * E2E da aba Projetos: abre o app Electron de verdade (perfil temporário) com projetos reais gravados em disco e confere
 *  - a aba (aberta pelo menu: a inicial é Início) mostra um cartão por projeto, com o estado certo (Novo, Em revisão, Pronto para
 *    exportar, Exportado) e os números de cortes;
 *  - busca por título e filtros por estado;
 *  - "Abrir" carrega o projeto e vai para Cortes, com as decisões preservadas;
 *  - vídeo movido/apagado: aviso "Vídeo não encontrado" e "Localizar vídeo…" (sem botão Abrir);
 *  - MINIATURAS: cada cartão mostra um quadro de verdade do vídeo (320x180, tirado com o ffmpeg do sistema) com o play por cima; sem vídeo, o ícone;
 *  - ordenar a lista;
 *  - LIXEIRA (perfil à parte, com arquivos de verdade em pasta temporária): "Manter" não apaga nada; com a caixa marcada saem o projeto, seus
 *    dados (histórico, transcrição, miniatura), os cortes exportados com a legenda ao lado, a pasta Cortes que ficou vazia e o vídeo/chat que o
 *    próprio app baixou; desmarcada, saem só o projeto e os dados; o vídeo e a legenda do usuário NUNCA saem; apagar o projeto ABERTO solta o
 *    player (o vídeo baixado é apagado mesmo assim), recarrega a tela com o aviso e nada é regravado depois;
 *  - estado vazio (sem nenhum projeto) e nenhum erro de console.
 * Uso: node tests/e2e/projects.e2e.js
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ProjectStore, newProject } = require('../../src/core/projects/projectStore');
const { HistoryStore } = require('../../src/core/history/store');
const { newCut } = require('../../src/core/projects/model');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const ffmpeg = locateTools().ffmpeg;

const { waitFor } = h;
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;
const sleep = h.sleep;

/** Expressão (JavaScript da página) do cartão do projeto com este título. */
const cardOf = (title) => `[...document.querySelectorAll('#tabpanel-projects .prj-card')].find((c) => c.querySelector('.prj-title').textContent === ${j(title)})`;
const titlesOf = async (page) => JSON.parse(await page.eval("JSON.stringify([...document.querySelectorAll('#tabpanel-projects .prj-card .prj-title')].map((t) => t.textContent))"));

/** O que o modal de confirmação aberto mostra (título, texto, caixa de marcar e botões). */
async function modalInfo(page) {
  await waitFor(page, "!!document.querySelector('.bf-modal')", 15000, 'o modal de confirmação');
  return JSON.parse(await page.eval(`JSON.stringify((() => {
    const m = document.querySelector('.bf-modal');
    const box = m.querySelector('.bf-modal-check input');
    const text = (sel) => { const n = m.querySelector(sel); return n ? n.textContent : null; };
    return { title: text('h2'), message: text('.bf-modal-msg'), hasCheck: Boolean(box), checked: box ? box.checked : null, label: text('.bf-modal-check strong'), hint: text('.bf-modal-check .muted'), ok: text('[data-act=ok]'), cancel: text('[data-act=cancel]') };
  })())`));
}

function makeProject(store, file, title, cuts, duration = 6) {
  const p = newProject(file, { size: fs.existsSync(file) ? fs.statSync(file).size : 1, duration, width: 1920, height: 1080 }, title ? { type: 'vod', platform: 'youtube', title, channel: 'Canal Teste' } : null);
  p.cuts = cuts.map((c, i) => newCut({ id: `c${i}${Math.abs(file.length)}`, title: `Corte ${i + 1}`, start: i * 5, end: i * 5 + 4, status: c.status, exports: c.exported ? [{ path: 'x.mp4', at: new Date().toISOString(), start: 0, end: 4, profile: 'p' }] : [] }));
  store.save(p);
  return p;
}

/**
 * A lixeira de verdade: perfil próprio e arquivos de verdade numa pasta temporária (nada fora dela é tocado).
 *   A "com arquivos"  vídeo do usuário + legenda dele ao lado + corte exportado (com a legenda gravada ao lado) na pasta Cortes + dados do app
 *   B "so projeto"    igual, para apagar SEM a caixa dos arquivos
 *   C "manter"        só o vídeo (para recusar)
 *   D "aberto"        vídeo baixado pelo app (registro em sources.json), é o projeto ABERTO na hora de apagar
 *   E "VOD baixado"   vídeo + chat baixados pelo app
 *   F "sumido"        o vídeo não existe mais
 */
async function deleteScenario(tmp) {
  const ud = path.join(tmp, 'ud3');
  const root = path.join(tmp, 'lixeira');
  const dir = { a: path.join(root, 'a'), b: path.join(root, 'b'), c: path.join(root, 'c'), dl: path.join(root, 'baixados') };
  for (const d of Object.values(dir)) fs.mkdirSync(d, { recursive: true });
  const projectsDir = path.join(ud, 'projects');
  const store = new ProjectStore(projectsDir);
  const history = new HistoryStore(path.join(ud, 'history'));
  const transcripts = path.join(ud, 'transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  const video = (d, name) => { const f = path.join(d, name); h.makeSampleVideo(ffmpeg, f, { seconds: 3, size: '640x360' }); return f; };
  const exported = (d, name) => { // um corte exportado de verdade, com a legenda gravada ao lado
    fs.mkdirSync(path.join(d, 'Cortes'), { recursive: true });
    const f = path.join(d, 'Cortes', `${name}.mp4`);
    h.makeSampleVideo(ffmpeg, f, { seconds: 2, size: '320x180' });
    fs.writeFileSync(path.join(d, 'Cortes', `${name}.srt`), '1\n00:00:00,000 --> 00:00:01,000\nolá\n');
    return f;
  };
  const make = async (file, { origin = null, exports = [] } = {}) => {
    const p = newProject(file, { size: fs.existsSync(file) ? fs.statSync(file).size : 1, duration: 3, width: 640, height: 360 }, origin);
    p.cuts = [newCut({ id: 'k0', title: 'Corte 1', start: 0, end: 2, status: 'approved', exports: exports.map((f) => ({ path: f, at: new Date().toISOString(), start: 0, end: 2, profile: 'p' })) })];
    store.save(p);
    await history.append(p.id, [{ id: 'g1', items: [] }]);
    fs.writeFileSync(path.join(transcripts, `${p.id}.json`), '{}');
    return p;
  };
  const exists = (f) => fs.existsSync(f);

  const aVideo = video(dir.a, 'com arquivos.mp4');
  const aSub = path.join(dir.a, 'com arquivos.srt'); fs.writeFileSync(aSub, '1\n00:00:00,000 --> 00:00:01,000\nlegenda do usuário\n');
  const aCut = exported(dir.a, 'com arquivos - corte 1');
  const bVideo = video(dir.b, 'so projeto.mp4');
  const bCut = exported(dir.b, 'so projeto - corte 1');
  const cVideo = video(dir.c, 'manter.mp4');
  const dVideo = video(dir.dl, 'aberto.mp4');
  const eVideo = video(dir.dl, 'vod baixado.mp4');
  const eChat = path.join(dir.dl, 'vod baixado.chat.json'); fs.writeFileSync(eChat, '{"comments":[]}');
  const fVideo = path.join(dir.c, 'sumido.mp4');
  const A = await make(aVideo, { exports: [aCut] });
  const B = await make(bVideo, { exports: [bCut] });
  const C = await make(cVideo);
  const D = await make(dVideo);
  const E = await make(eVideo, { origin: { type: 'vod', platform: 'youtube', title: 'VOD baixado', channel: 'Canal Teste' } });
  const F = await make(fVideo);
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(ud, 'sources.json'), JSON.stringify({
    version: 1,
    downloads: [
      { path: dVideo, origin: null, chat: null, meta: {}, at: now },
      { path: eVideo, origin: { type: 'vod', platform: 'youtube', title: 'VOD baixado', channel: 'Canal Teste' }, chat: { path: eChat }, meta: {}, at: now }
    ]
  }));
  const thumbsDir = path.join(ud, 'cache', 'thumbs');
  const thumbFiles = (p) => (exists(thumbsDir) ? fs.readdirSync(thumbsDir).filter((f) => f.startsWith(`${p.id}.`)) : []);
  const leftovers = (p) => [projectsDir, path.join(ud, 'history'), transcripts, thumbsDir].flatMap((d) => (exists(d) ? fs.readdirSync(d).filter((f) => f.startsWith(`${p.id}.`)) : []));
  const downloadsLeft = () => JSON.parse(fs.readFileSync(path.join(ud, 'sources.json'), 'utf8')).downloads.map((d) => path.basename(d.path));

  let app = null;
  try {
    app = await h.launchApp(ud, {});
    const { page } = app;
    const trash = (title) => page.eval(`${cardOf(title)}.querySelector('[data-act=delete]').click()`);
    const gone = (title) => waitFor(page, `!(${cardOf(title)})`, 30000, `o cartão "${title}" sair da lista`);
    const closed = () => waitFor(page, "!document.querySelector('.bf-modal')", 5000, 'o modal fechar');
    await page.eval("BF.ui.selectTab('projects')"); // a tela inicial é a Início: as miniaturas só são pedidas com a lista à vista
    await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-card').length === 6", 25000, '6 cartões de projeto');
    try {
      await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-thumb img').length === 5", 40000, 'as 5 miniaturas (o vídeo sumido não tem)');
    } catch (err) {
      const state = await page.eval(`JSON.stringify({ h: window.innerHeight, cards: [...document.querySelectorAll('#tabpanel-projects .prj-card')].map((c) => { const r = c.getBoundingClientRect(); return { t: c.querySelector('.prj-title').textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), img: Boolean(c.querySelector('img')), miss: c.classList.contains('missing') }; }) })`);
      throw new Error(`${err.message}\n${state}\nerros: ${j(page.errors)}`);
    }
    assert.equal(thumbFiles(A).length, 1);
    step('lixeira: 6 projetos com arquivos de verdade e as miniaturas no cache');

    // recusar não apaga nada (a confirmação simples e a com a caixa dos arquivos)
    await trash('manter');
    let info = await modalInfo(page);
    assert.equal(info.title, 'Apagar “manter”?');
    assert.equal(info.hasCheck, false, 'sem arquivos do projeto a apagar não há caixa');
    assert.match(info.message, /O projeto sai da lista e tudo o que o app guardou dele é apagado: os cortes e as decisões, o histórico, a transcrição e a miniatura\./);
    assert.match(info.message, /O vídeo “manter\.mp4” não é apagado\./);
    assert.match(info.message, /Isto não pode ser desfeito\.$/);
    assert.deepEqual([info.ok, info.cancel], ['Apagar projeto', 'Manter']);
    await h.answerModal(page, false); await closed();
    await trash('com arquivos');
    info = await modalInfo(page);
    assert.deepEqual({ hasCheck: info.hasCheck, checked: info.checked, label: info.label }, { hasCheck: true, checked: true, label: 'Apagar também os arquivos do projeto' }, 'a caixa já vem marcada');
    assert.match(info.hint, /^1 corte exportado \(e 1 legenda ao lado\) · \d/);
    await h.answerModal(page, false); await closed();
    await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-card').length === 6 && ![...document.querySelectorAll('#tabpanel-projects [data-act=delete]')].some((b) => b.disabled)", 10000, 'a lista inteira e os botões livres');
    for (const f of [aVideo, aSub, aCut, aCut.replace(/\.mp4$/, '.srt'), cVideo, path.join(projectsDir, `${A.id}.json`), path.join(projectsDir, `${C.id}.json`)]) assert.ok(exists(f), `recusar não apaga ${path.basename(f)}`);
    step('"Manter" não apaga nada (nem o projeto, nem os arquivos)');

    // apagar com a caixa marcada (padrão): o projeto, os dados, o corte exportado com a legenda ao lado e a pasta Cortes que ficou vazia
    await trash('com arquivos');
    await modalInfo(page);
    await h.answerModal(page, true);
    await gone('com arquivos');
    assert.deepEqual(leftovers(A), [], 'nenhum dado do projeto (projeto, histórico, transcrição, miniatura) ficou');
    assert.ok(!exists(aCut) && !exists(aCut.replace(/\.mp4$/, '.srt')), 'o corte exportado e a legenda gravada ao lado saíram');
    assert.ok(!exists(path.join(dir.a, 'Cortes')), 'a pasta Cortes, que ficou vazia, também');
    assert.ok(exists(aVideo) && exists(aSub), 'o vídeo e a legenda do usuário ficam');
    await waitFor(page, "[...document.querySelectorAll('#toasts .toast')].some((t) => /^Projeto apagado\\. Liberou /.test(t.textContent))", 10000, 'o aviso com o espaço liberado');
    step('apagar com a caixa marcada: projeto, dados e cortes exportados saem; o vídeo e a legenda do usuário ficam');

    // apagar com a caixa DESmarcada: só o projeto e os dados
    await trash('so projeto');
    await modalInfo(page);
    await page.eval("document.querySelector('.bf-modal-check input').click()");
    assert.equal(await page.eval("document.querySelector('.bf-modal-check input').checked"), false);
    await h.answerModal(page, true);
    await gone('so projeto');
    assert.deepEqual(leftovers(B), []);
    assert.ok(exists(bCut) && exists(bCut.replace(/\.mp4$/, '.srt')) && exists(bVideo) && exists(path.join(dir.b, 'Cortes')), 'sem a caixa os arquivos ficam');
    step('apagar com a caixa desmarcada: saem só o projeto e os dados');

    // vídeo e chat baixados pelo app saem junto, e o registro de downloads também
    await trash('VOD baixado');
    info = await modalInfo(page);
    assert.match(info.hint, /^o vídeo baixado pelo app \(vod baixado\.mp4\) e o chat baixado · \d/);
    assert.doesNotMatch(info.message, /não é apagado/, 'o vídeo baixado sai junto: nada a dizer sobre ficar');
    await h.answerModal(page, true);
    await gone('VOD baixado');
    assert.deepEqual(leftovers(E), []);
    assert.ok(!exists(eVideo) && !exists(eChat), 'o vídeo e o chat que o app baixou saíram');
    assert.deepEqual(downloadsLeft(), ['aberto.mp4'], 'o registro de downloads esqueceu o vídeo apagado');
    step('vídeo e chat baixados pelo app saem junto, e o registro de downloads também');

    // vídeo que já sumiu: o projeto sai e a mensagem não finge que o vídeo "fica"
    await trash('sumido');
    info = await modalInfo(page);
    assert.equal(info.hasCheck, false);
    assert.doesNotMatch(info.message, /não é apagado/);
    await h.answerModal(page, true);
    await gone('sumido');
    assert.deepEqual(leftovers(F), []);
    step('projeto cujo vídeo sumiu também pode ser apagado');

    // o projeto ABERTO: abre pela miniatura, apaga (o vídeo baixado também, mesmo com o player tendo acabado de carregá-lo) e a tela recomeça
    await page.eval(`${cardOf('aberto')}.querySelector('.prj-thumb').click()`);
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('aberto.mp4')", 30000, 'projeto aberto pela miniatura');
    await waitFor(page, "document.getElementById('tab-cuts').getAttribute('aria-selected') === 'true'", 10000, 'aba Cortes');
    await page.eval("BF.ui.selectTab('projects')");
    await waitFor(page, `!!(${cardOf('aberto')}) && !!(${cardOf('aberto')}).querySelector('.bds-chip-accent')`, 10000, 'o cartão marcado como aberto');
    await page.eval('window.__antesDeApagar = true');
    await trash('aberto');
    info = await modalInfo(page);
    assert.match(info.hint, /^o vídeo baixado pelo app \(aberto\.mp4\) · \d/);
    await h.answerModal(page, true);
    await waitFor(page, "window.__antesDeApagar === undefined && !!window.BF && !!BF.state && BF.state.project === null", 40000, 'a tela recarregada sem projeto aberto');
    await waitFor(page, "[...document.querySelectorAll('#toasts .toast')].some((t) => /^Projeto apagado\\. Liberou /.test(t.textContent))", 20000, 'o aviso guardado aparecer depois da recarga');
    assert.ok(!exists(dVideo), 'o vídeo baixado que estava aberto no player foi apagado (o player o soltou)');
    assert.deepEqual(downloadsLeft(), []);
    await sleep(2500); // uma gravação tardia do projeto aberto o recriaria
    assert.deepEqual(leftovers(D), [], 'nada do projeto apagado foi regravado');
    await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-card').length === 1", 15000, 'só sobrar o projeto que foi mantido');
    assert.deepEqual(await titlesOf(page), ['manter']);
    assert.ok(exists(cVideo) && exists(path.join(projectsDir, `${C.id}.json`)), 'o projeto mantido continua inteiro');
    step('apagar o projeto aberto: o player solta o vídeo, a tela recomeça com o aviso e nada é regravado');

    h.assertNoConsoleErrors(page, [/Autofill|favicon/i]);
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
  }
}

async function main() {
  const tmp = h.mkTemp('prj-');
  let app = null;
  try {
    const ud = path.join(tmp, 'ud');
    const projectsDir = path.join(ud, 'projects');
    const store = new ProjectStore(projectsDir);
    const v1 = path.join(tmp, 'live novo.mp4'); h.makeSampleVideo(ffmpeg, v1, { seconds: 6 });
    const v2 = path.join(tmp, 'live em revisao.mp4'); h.makeSampleVideo(ffmpeg, v2, { seconds: 6 });
    const v3 = path.join(tmp, 'live pronta.mp4'); h.makeSampleVideo(ffmpeg, v3, { seconds: 6 });
    const v4 = path.join(tmp, 'live exportada.mp4'); h.makeSampleVideo(ffmpeg, v4, { seconds: 6 });
    const gone = path.join(tmp, 'live sumida.mp4');
    makeProject(store, v1, null, []);
    makeProject(store, v2, 'Maratona de Minecraft', [{ status: 'pending' }, { status: 'approved' }]);
    makeProject(store, v3, null, [{ status: 'approved' }, { status: 'approved', exported: true }]);
    makeProject(store, v4, null, [{ status: 'approved', exported: true }, { status: 'rejected' }]);
    makeProject(store, gone, null, [{ status: 'approved' }]);

    app = await h.launchApp(ud, {});
    const { page } = app;
    const ev = (x) => page.eval(x);
    await waitFor(page, "document.querySelectorAll('#tabpanel-projects .prj-card').length === 5", 20000, '5 cartões de projeto');

    assert.equal(await ev("document.getElementById('tab-home').getAttribute('aria-selected')"), 'true', 'Início é a aba inicial sem vídeo aberto');
    await ev("BF.ui.selectTab('projects')");
    assert.equal(await ev("document.getElementById('tab-projects').getAttribute('aria-selected')"), 'true');
    assert.equal(await ev("document.getElementById('app').dataset.viewKind"), 'wide', 'tela larga');
    step('Projetos (aberta pelo menu: a inicial é Início) tem um cartão por projeto');

    const states = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tabpanel-projects .prj-card')].map((c) => [c.querySelector('.prj-title').textContent, c.dataset.state, c.classList.contains('missing')]))"));
    const byTitle = Object.fromEntries(states.map(([t, s, m]) => [t, { s, m }]));
    assert.deepEqual(byTitle['live novo'], { s: 'new', m: false });
    assert.deepEqual(byTitle['Maratona de Minecraft'], { s: 'review', m: false }, 'título vem da origem quando existe');
    assert.deepEqual(byTitle['live pronta'], { s: 'ready', m: false });
    assert.deepEqual(byTitle['live exportada'], { s: 'done', m: false });
    assert.equal(byTitle['live sumida'].m, true);
    const labels = JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tabpanel-projects .prj-card')].map((c) => c.querySelector('.bds-chip').textContent))"));
    for (const l of ['Novo', 'Em revisão', 'Pronto para exportar', 'Exportado']) assert.ok(labels.includes(l), `estado "${l}" aparece`);
    const maratona = await ev("[...document.querySelectorAll('#tabpanel-projects .prj-card')].find((c) => c.querySelector('.prj-title').textContent === 'Maratona de Minecraft').textContent");
    assert.match(maratona, /1 pendente/);
    assert.match(maratona, /1 aprovado/);
    assert.match(maratona, /Canal Teste/);
    step('estados (Novo, Em revisão, Pronto para exportar, Exportado) e números de cortes corretos');

    // miniaturas: um quadro de verdade de cada vídeo que existe (1920x1080 -> 320x180), com o play por cima; o que sumiu fica com o ícone
    await waitFor(page, "(() => { const imgs = [...document.querySelectorAll('#tabpanel-projects .prj-thumb img')]; return imgs.length === 4 && imgs.every((i) => i.complete && i.naturalWidth > 0); })()", 40000, 'as 4 miniaturas carregadas');
    const thumbs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#tabpanel-projects .prj-card')].map((c) => {
      const t = c.querySelector('.prj-thumb'); const img = t.querySelector('img');
      return { title: c.querySelector('.prj-title').textContent, missing: c.classList.contains('missing'), disabled: t.disabled, img: Boolean(img), w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0, play: Boolean(t.querySelector('.prj-play')), icon: Boolean(t.querySelector('.material-symbols-rounded')), label: t.getAttribute('aria-label') };
    }))`));
    for (const t of thumbs.filter((x) => !x.missing)) {
      assert.deepEqual({ img: t.img, w: t.w, h: t.h, play: t.play, disabled: t.disabled }, { img: true, w: 320, h: 180, play: true, disabled: false }, `miniatura de "${t.title}"`);
      assert.equal(t.label, `Abrir o projeto ${t.title}`);
    }
    const noVideo = thumbs.find((x) => x.missing);
    assert.deepEqual({ img: noVideo.img, play: noVideo.play, icon: noVideo.icon, disabled: noVideo.disabled }, { img: false, play: false, icon: true, disabled: true }, 'sem o vídeo: ícone no lugar e a miniatura não abre');
    const cached = fs.readdirSync(path.join(ud, 'cache', 'thumbs')).filter((f) => f.endsWith('.jpg'));
    assert.equal(cached.length, 4, 'um JPEG no cache por vídeo');
    assert.ok(cached.every((f) => /^[0-9a-f]{16}\./.test(f)), 'o nome do arquivo começa com o id do projeto');
    step('cada cartão mostra a miniatura do vídeo (320x180 com o play por cima); sem o vídeo, o ícone');

    // ordenar
    const order = async (value) => {
      await ev(`(() => { const s = document.querySelector('#tabpanel-projects [data-act=sort]'); s.value = ${j(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      return titlesOf(page);
    };
    assert.deepEqual(JSON.parse(await ev("JSON.stringify([...document.querySelectorAll('#tabpanel-projects [data-act=sort] option')].map((o) => o.textContent))")), ['Mais recentes', 'Mais antigos', 'Nome (A–Z)', 'Mais cortes', 'Mais longos']);
    assert.deepEqual(await order('name'), ['live exportada', 'live novo', 'live pronta', 'live sumida', 'Maratona de Minecraft'], 'A–Z sem diferenciar maiúscula');
    const byCuts = await order('cuts');
    assert.deepEqual([byCuts[3], byCuts[4]], ['live sumida', 'live novo'], 'menos cortes por último (1 e 0)');
    assert.deepEqual(byCuts.slice(0, 3).sort(), ['live exportada', 'live pronta', 'Maratona de Minecraft'].sort(), 'os de 2 cortes primeiro');
    assert.equal((await order('recent')).length, 5);
    step('ordenar a lista (nome, mais cortes…)');

    // vídeo sumido: aviso e "Localizar vídeo…", sem botão Abrir
    const missing = await ev("(() => { const c = document.querySelector('#tabpanel-projects .prj-card.missing'); return { chip: !!c.querySelector('.bds-chip-bad'), locate: !!c.querySelector('[data-act=locate]'), open: !!c.querySelector('[data-act=open]'), reveal: !!c.querySelector('[data-act=reveal]') }; })()");
    assert.deepEqual(missing, { chip: true, locate: true, open: false, reveal: false });
    step('vídeo movido ou apagado: "Vídeo não encontrado" e "Localizar vídeo…", sem Abrir');

    // busca e filtros
    await ev("(() => { const i = document.querySelector('#tabpanel-projects [data-act=search]'); i.value = 'maratona'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-projects .prj-card').length"), 1);
    await ev("(() => { const i = document.querySelector('#tabpanel-projects [data-act=search]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-projects .prj-card').length"), 5);
    await ev("document.querySelector('#tabpanel-projects [data-filter=ready]').click()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-projects .prj-card').length"), 2, 'Para exportar: a pronta e a que teve o vídeo movido');
    await ev("document.querySelector('#tabpanel-projects [data-filter=done]').click()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-projects .prj-card').length"), 1);
    await ev("document.querySelector('#tabpanel-projects [data-filter=review]').click()");
    assert.equal(await ev("document.querySelectorAll('#tabpanel-projects .prj-card').length"), 2, 'Em revisão inclui os novos');
    await ev("document.querySelector('#tabpanel-projects [data-filter=all]').click()");
    step('busca por título e filtros por estado');

    // abrir: carrega o projeto, vai para Cortes e mantém as decisões
    await ev("[...document.querySelectorAll('#tabpanel-projects .prj-card')].find((c) => c.querySelector('.prj-title').textContent === 'Maratona de Minecraft').querySelector('[data-act=open]').click()");
    await waitFor(page, "BF.state.project && BF.state.project.source.path.endsWith('live em revisao.mp4')", 30000, 'projeto aberto');
    await waitFor(page, "document.getElementById('tab-cuts').getAttribute('aria-selected') === 'true'", 10000, 'aba Cortes');
    assert.deepEqual(JSON.parse(await ev("JSON.stringify(BF.state.project.cuts.map((c) => c.status))")), ['pending', 'approved']);
    step('Abrir carrega o projeto, vai para Cortes e preserva as decisões');

    // voltando à lista: o projeto aberto fica marcado
    await ev("BF.ui.selectTab('projects')");
    await waitFor(page, "!!document.querySelector('#tabpanel-projects .prj-card .bds-chip-accent')", 10000, 'marca "Aberto agora"');
    assert.match(await ev("document.querySelector('#tabpanel-projects .prj-card .bds-chip-accent').textContent"), /Aberto agora/);
    assert.equal(await ev("[...document.querySelectorAll('#tabpanel-projects .prj-card')].filter((c) => c.querySelector('.bds-chip-accent')).length"), 1);
    step('o projeto aberto aparece como "Aberto agora" (botão Continuar)');

    // mudar uma decisão atualiza o estado na lista
    await ev("BF.project.update((p) => { p.cuts[0].status = 'approved'; }, { reason: 'teste' })");
    await ev('BF.project.flush()');
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-projects .prj-card')].find((c) => c.querySelector('.prj-title').textContent === 'Maratona de Minecraft').dataset.state === 'ready'", 15000, 'estado atualizado na lista');
    step('decidir um corte atualiza o estado na lista');

    assert.deepEqual(app.errors.filter((e) => !/Autofill|favicon/i.test(e)), [], `erros de console: ${j(app.errors)}`);
    await app.stop(); app = null;

    // estado vazio
    const ud2 = path.join(tmp, 'ud2');
    app = await h.launchApp(ud2, {});
    await waitFor(app.page, "!!document.querySelector('#tabpanel-projects .prj-empty')", 20000, 'estado vazio');
    assert.match(await app.page.eval("document.querySelector('#tabpanel-projects .prj-empty').textContent"), /Nenhum projeto ainda/);
    assert.match(await app.page.eval("document.querySelector('#tabpanel-projects .prj-empty').textContent"), /Use Novo projeto para começar/, 'o texto aponta para o botão do cabeçalho');
    assert.equal(await app.page.eval("document.querySelectorAll('#tabpanel-projects .prj-empty button').length"), 0, 'o estado vazio não repete o botão');
    // o botão "Novo projeto" do cabeçalho (a tela não tem item no menu) é a ação principal, à vista com a lista vazia
    await app.page.eval("BF.ui.selectTab('projects')");
    assert.deepEqual(await app.page.eval("(() => { const b = document.querySelector('#tabpanel-projects .prj-head [data-act=new]'); const r = b.getBoundingClientRect(); return [b.textContent, b.classList.contains('primary'), r.width > 0 && r.height > 0, document.querySelectorAll('#tabpanel-projects .primary').length]; })()"),
      ['addNovo projeto', true, true, 1]);
    await app.page.eval("document.querySelector('#tabpanel-projects .prj-head [data-act=new]').click()");
    await waitFor(app.page, "document.getElementById('app').dataset.activeTab === 'sources' && document.getElementById('tab-projects').getAttribute('aria-selected') === 'true' && !document.getElementById('tabpanel-sources').hidden", 10000, 'o botão leva à tela Novo projeto');
    assert.equal(await app.page.eval("document.getElementById('pageTitle').textContent"), 'Novo projeto');
    step('sem nenhum projeto: estado vazio que aponta para o botão "Novo projeto" do cabeçalho, que abre a tela Novo projeto (acendendo Projetos)');
    await app.stop(); app = null;

    await deleteScenario(tmp);
    console.log('\nE2E DA ABA PROJETOS OK');
  } finally {
    try { if (app) await app.stop(); } catch { /* já fechado */ }
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(`\n✖ E2E FALHOU: ${err.stack || err.message}`); h.cleanupAll().finally(() => process.exit(1)); });
