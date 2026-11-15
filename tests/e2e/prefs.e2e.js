'use strict';

/**
 * E2E das preferências, do aprendizado e da correspondência de projetos (dono: prefs): abre o app Electron de
 * verdade (perfil temporário), gera vídeos reais com o ffmpeg e percorre a aba Preferências e os ganchos de abertura:
 *  - preferências por escopo (geral/jogo/canal), selo de origem, "Limpar" e a prioridade;
 *  - decisões simuladas → preferência aprendida com evidência, desativar, desfazer pelo histórico, chave geral;
 *  - abrir a MESMA live em outro caminho: a pergunta aparece (3 saídas); recusar não abre; "Criar novo"; "Abrir o
 *    existente" copia cortes/decisões sem alterar o original;
 *  - fonte regravada mais curta: mostra a diferença, só aplica após confirmar e sinaliza (sem apagar) os cortes fora;
 *  - persistência depois de reiniciar o app e nenhum erro de console.
 * Uso: node tests/e2e/prefs.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const h = require('./helpers');

const { sleep, waitFor, answerModal, modalOpen } = h;
const tools = locateTools();
const step = (m) => console.log(`✔ ${m}`);
const j = JSON.stringify;
const sha = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
const SHOTS = process.env.BF_E2E_SHOTDIR || '';

/** Vídeo de teste pequeno (barras + tom). */
function makeVideo(file, seconds) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=5:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file], { windowsHide: true });
}

// ---------- ajudantes de página ----------

const click = (page, selector) => page.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw new Error('não achei ' + ${j(selector)}); e.click(); return true; })()`);
const setField = (page, selector, value) => page.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw new Error('não achei ' + ${j(selector)}); e.value = ${j(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const check = (page, selector, on) => page.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) throw new Error('não achei ' + ${j(selector)}); e.checked = ${on}; e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const text = (page, selector) => page.eval(`(document.querySelector(${j(selector)}) || {}).textContent || ''`);
const panelText = (page) => text(page, '#tabpanel-prefs');
const prefsGet = (page, key, fallback) => page.eval(`BF.prefs.get(${j(key)}, ${j(fallback)})`);
const explain = (page, key) => page.eval(`BF.prefs.explain(${j(key)})`);
const row = (key) => `#tabpanel-prefs .prefs-row[data-key="${key}"]`;
const learnedCard = (page, label) => page.eval(`(() => { const c = [...document.querySelectorAll('#tabpanel-prefs .prefs-learned')].find((x) => x.textContent.includes(${j(label)})); return c ? { id: c.dataset.id, state: c.dataset.state, text: c.textContent } : null; })()`);
const toastTexts = (page) => page.eval("[...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent)");
const consoleErrors = (page) => page.errors.slice();

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await h.screenshot(page, path.join(SHOTS, `prefs-${name}.png`));
}

/** Dispara BF.openSource sem esperar (o diálogo bloqueia até alguém responder). */
async function startOpen(page, file, origin) {
  await page.eval(`(() => { window.__result = null; window.__open = BF.openSource(${j(file)}, ${origin ? j(origin) : 'null'}).then((r) => { window.__result = { ok: r.ok, code: r.code || null, restored: r.restored === undefined ? null : r.restored }; return r; }); return true; })()`);
}
const finishOpen = async (page) => { await waitFor(page, 'window.__result !== null', 20000, 'abertura concluída'); return page.eval('window.__result'); };
const choose = (page, act) => click(page, `.bf-modal [data-act="${act}"]`);
const modalInfo = (page) => page.eval("(() => { const m = document.querySelector('.bf-modal'); return m ? { title: m.querySelector('h2').textContent, message: m.querySelector('.bf-modal-msg').textContent, buttons: [...m.querySelectorAll('button')].map((b) => b.textContent) } : null; })()");

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-prefs');
  const userData = path.join(tmp, 'userdata');
  const projectsDir = path.join(userData, 'projects');
  const original = path.join(tmp, 'lives', 'live.mp4');
  const dup1 = path.join(tmp, 'backup1', 'live.mp4');
  const dup2 = path.join(tmp, 'backup2', 'copia final.mp4');
  const origin = { type: 'vod', platform: 'youtube', videoId: 'abc123XYZ_1', url: 'https://www.youtube.com/watch?v=abc123XYZ_1', channel: 'Fulano', title: 'Minha live de teste', game: 'Valorant' };
  const projectFiles = () => fs.readdirSync(projectsDir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
  let app = null;

  try {
    makeVideo(original, 60);
    fs.mkdirSync(path.dirname(dup1), { recursive: true });
    fs.mkdirSync(path.dirname(dup2), { recursive: true });
    fs.copyFileSync(original, dup1);
    fs.copyFileSync(original, dup2);
    step('vídeo real de 60 s gerado e duas cópias em outras pastas');

    app = await h.launchApp(userData);
    let page = app.page;

    // ---------- sem projeto: a aba Preferências funciona ----------
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-row')", 15000, 'aba Preferências desenhada');
    assert.equal(await page.eval("document.getElementById('tabpanel-prefs').hidden"), false);
    assert.equal(await page.eval("BF.state.project === null && document.getElementById('app').classList.contains('no-project')"), true);
    let t = await panelText(page);
    assert.match(t, /Abra um vídeo para definir o jogo e o canal do projeto/);
    assert.match(t, /Aprender com minhas decisões/);
    assert.match(t, /Histórico de mudanças/);
    assert.equal(await page.eval("BF.prefs.get('analysis.minRelevance', 0.5)"), 0.5);
    assert.equal((await explain(page, 'analysis.minRelevance')).source, 'default');
    step('aba Preferências funciona sem projeto aberto (valores padrão)');

    // edita uma preferência GERAL pela interface
    await setField(page, `${row('analysis.minRelevance')} input`, '70');
    await waitFor(page, "BF.prefs.get('analysis.minRelevance', 0.5) === 0.7", 8000, 'relevância 0.7');
    await waitFor(page, `document.querySelector(${j(`${row('analysis.minRelevance')} .prefs-clear`)})`, 8000, 'botão Limpar');
    assert.equal((await explain(page, 'analysis.minRelevance')).label, 'geral');
    assert.match(await text(page, `${row('analysis.minRelevance')} .prefs-pill`), /geral/);
    step('preferência geral editada pela tela, com o selo "geral"');

    // escopo Jogo: nome + valor próprio, que vale só para esse jogo
    await click(page, '#tabpanel-prefs .prefs-seg[data-scope="game"]');
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-scope > input')", 8000, 'campo do nome do jogo');
    await setField(page, '#tabpanel-prefs .prefs-scope > input', 'Valorant');
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-row')", 8000);
    await setField(page, `${row('analysis.minRelevance')} input`, '30');
    await waitFor(page, `document.querySelector(${j(`${row('analysis.minRelevance')} .prefs-clear`)})`, 8000);
    // sem projeto aberto o selo mostra o que valeria para esse jogo
    assert.match(await text(page, `${row('analysis.minRelevance')} .prefs-pill`), /jogo Valorant/);
    assert.equal(await prefsGet(page, 'analysis.minRelevance', 0.5), 0.7, 'sem projeto Valorant aberto, continua o geral');
    await click(page, '#tabpanel-prefs .prefs-seg[data-scope="general"]');
    await waitFor(page, "!document.querySelector('#tabpanel-prefs .prefs-scope > input')", 8000);
    step('escopo Jogo gravado separado do geral');

    // ---------- abrir a live (cria o projeto) ----------
    await startOpen(page, original, origin);
    assert.deepEqual(await finishOpen(page), { ok: true, code: null, restored: false });
    assert.equal(await modalOpen(page), false, 'primeira abertura não pergunta nada');
    assert.deepEqual(await page.eval('BF.prefs.scope()'), { game: 'Valorant', channel: 'Fulano' }, 'jogo/canal vêm da origem');
    assert.equal(await prefsGet(page, 'analysis.minRelevance', 0.5), 0.3, 'jogo Valorant vence o geral neste projeto');
    assert.equal((await explain(page, 'analysis.minRelevance')).label, 'jogo Valorant');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, `document.querySelector(${j(`${row('analysis.minRelevance')} .prefs-pill`)}) && document.querySelector(${j(`${row('analysis.minRelevance')} .prefs-pill`)}).textContent.includes('jogo Valorant')`, 8000, 'selo do jogo');
    assert.match(await panelText(page), /Este projeto/);
    assert.equal(await page.eval("document.querySelector('#tabpanel-prefs input[list=\"prefsGames\"]').placeholder"), 'Detectado: Valorant');
    // o usuário define o canal do projeto (project.meta) e a prioridade passa a incluir o canal
    await setField(page, '#tabpanel-prefs input[list="prefsChannels"]', 'Fulano');
    await waitFor(page, "BF.state.project.meta.channel === 'Fulano'", 8000, 'project.meta.channel');
    step('projeto aberto: jogo/canal detectados da origem, meta editável e selo de origem na lista');

    // canal com valor próprio vence jogo e geral
    await click(page, '#tabpanel-prefs .prefs-seg[data-scope="channel"]');
    await waitFor(page, `document.querySelector('#tabpanel-prefs .prefs-scope > input') && document.querySelector('#tabpanel-prefs .prefs-scope > input').value === 'Fulano'`, 8000, 'nome do canal preenchido');
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-row')", 8000);
    // ajustes avançados ficam recolhidos
    assert.equal(await page.eval("document.querySelector('#tabpanel-prefs details.prefs-more').open"), false);
    await page.eval("document.querySelector('#tabpanel-prefs details.prefs-more').open = true");
    await setField(page, `${row('analysis.padBeforeSec')} input`, '6');
    await waitFor(page, "BF.prefs.get('analysis.padBeforeSec', 3) === 6", 8000, 'margem do canal');
    assert.equal((await explain(page, 'analysis.padBeforeSec')).scope, 'channel');
    await setField(page, `${row('analysis.minRelevance')} input`, '80');
    await waitFor(page, "BF.prefs.get('analysis.minRelevance', 0.5) === 0.8", 8000, 'relevância do canal');
    assert.equal((await explain(page, 'analysis.minRelevance')).label, 'canal Fulano');
    await click(page, `${row('analysis.minRelevance')} .prefs-clear`);
    await waitFor(page, "BF.prefs.get('analysis.minRelevance', 0.5) === 0.3", 8000, 'sem o canal, volta ao jogo');
    assert.equal((await explain(page, 'analysis.minRelevance')).scope, 'game');
    await click(page, '#tabpanel-prefs .prefs-seg[data-scope="general"]');
    step('prioridade canal > jogo > geral e "Limpar" voltam a herdar');

    // ---------- aprender com decisões simuladas ----------
    await page.eval(`(() => {
      const durations = [30, 34, 36, 40, 44, 50];
      durations.forEach((d, i) => {
        BF.project.update((p) => { p.cuts.push(BF.model.newCut({ title: 'Momento ' + (i + 1), start: i, end: i + d })); }, { reason: 'e2e' });
      });
      BF.bus.emit('cuts:changed', {});
      return true;
    })()`);
    const ids = await page.eval('BF.state.project.cuts.map((c) => c.id)');
    // quatro aprovações: abaixo da evidência mínima (5), nada vale ainda
    for (const id of ids.slice(0, 4)) {
      await page.eval(`(() => { BF.project.update((p) => { p.cuts.find((c) => c.id === ${j(id)}).status = 'approved'; }, { reason: 'e2e' }); BF.bus.emit('decision', { cutId: ${j(id)}, type: 'approve', before: 'pending', after: 'approved' }); return true; })()`);
    }
    await sleep(900);
    assert.equal(await prefsGet(page, 'analysis.maxDurationSec', 60), 60, 'com 4 cortes ainda é o padrão');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-waiting')", 8000, 'sugestões aguardando evidência');
    assert.match(await text(page, '#tabpanel-prefs .prefs-waiting summary'), /aguardam mais decisões/);
    // a 5ª e a 6ª aprovação fazem a preferência valer
    for (const id of ids.slice(4)) {
      await page.eval(`(() => { BF.project.update((p) => { p.cuts.find((c) => c.id === ${j(id)}).status = 'approved'; }, { reason: 'e2e' }); BF.bus.emit('decision', { cutId: ${j(id)}, type: 'approve', before: 'pending', after: 'approved' }); return true; })()`);
    }
    await waitFor(page, "BF.prefs.explain('analysis.maxDurationSec').source === 'learned'", 10000, 'preferência aprendida em vigor');
    assert.equal(await prefsGet(page, 'analysis.maxDurationSec', 60), 57);
    const ex = await explain(page, 'analysis.maxDurationSec');
    assert.equal(ex.scope, 'general', 'um projeto só: jogo/canal repetiriam a geral, então só a geral é proposta');
    assert.match(ex.evidence, /6 cortes aprovados, mediana 38 s/);
    await waitFor(page, "[...document.querySelectorAll('#toasts .toast')].some((t) => /Preferência aprendida|preferências aprendidas/.test(t.textContent))", 8000, 'aviso visível');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-prefs .prefs-learned')].some((c) => c.textContent.includes('Duração máxima'))", 10000, 'cartão aprendido na aba');
    let card = await learnedCard(page, 'Duração máxima');
    assert.match(card.text, /6 cortes aprovados, mediana 38 s/);
    assert.match(card.text, /aprendida/);
    assert.match(card.text, /em vigor/);
    await page.eval("document.querySelector('#tabpanel-prefs .prefs-learned').scrollIntoView()");
    await shot(page, 'aprendidas');
    step('decisões simuladas: 4 não valem, 6 viram preferência aprendida com evidência legível e aviso');

    // desativar a preferência aprendida (individual)
    await check(page, `#tabpanel-prefs .prefs-learned[data-id="${card.id}"] input[type=checkbox]`, false);
    await waitFor(page, "BF.prefs.explain('analysis.maxDurationSec').source === 'default'", 8000, 'item desativado');
    card = await learnedCard(page, 'Duração máxima');
    assert.equal(card.state, 'disabled');
    assert.match(card.text, /desativada/);
    assert.equal(await prefsGet(page, 'analysis.maxDurationSec', 60), 60, 'a desativada deixa de valer');
    // histórico: a desativação aparece e dá para desfazer (com confirmação)
    await page.eval("document.querySelector('#tabpanel-prefs details.prefs-details').open = true");
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-history li')", 8000, 'histórico');
    assert.match(await text(page, '#tabpanel-prefs .prefs-history li'), /Desativou a preferência aprendida "Duração máxima"/);
    await click(page, '#tabpanel-prefs .prefs-history li button');
    const asked = await answerModal(page, true);
    assert.match(asked.title, /Desfazer alteração/);
    await waitFor(page, "BF.prefs.explain('analysis.maxDurationSec').source === 'learned'", 8000, 'desfazer reativa');
    assert.equal(await prefsGet(page, 'analysis.maxDurationSec', 60), 57);
    await waitFor(page, "[...document.querySelectorAll('#tabpanel-prefs .prefs-history li')].some((li) => /Desfez: Desativou/.test(li.textContent))", 8000, 'reversão no histórico');
    step('desativar e desfazer pelo histórico (individual)');

    // chave geral: desligada, nada aprendido vale
    await check(page, '#prefsLearnOn', false);
    await waitFor(page, "BF.prefs.explain('analysis.maxDurationSec').source === 'default'", 8000, 'aprendizado desligado');
    assert.match(await panelText(page), /Desligado: nada novo é observado/);
    await check(page, '#prefsLearnOn', true);
    await waitFor(page, "BF.prefs.explain('analysis.maxDurationSec').source === 'learned'", 8000, 'aprendizado religado');
    step('chave geral "aprender com minhas decisões" liga e desliga o efeito');

    // editar o valor aprendido
    card = await learnedCard(page, 'Duração máxima');
    await setField(page, `#tabpanel-prefs .prefs-learned[data-id="${card.id}"] input[type=number]`, '75');
    await waitFor(page, "BF.prefs.get('analysis.maxDurationSec', 60) === 75", 8000, 'valor aprendido editado');
    assert.match((await learnedCard(page, 'Duração máxima')).text, /editada/);
    assert.match((await learnedCard(page, 'Duração máxima')).text, /Voltar ao aprendido \(57 s\)/);
    await click(page, `#tabpanel-prefs .prefs-learned[data-id="${card.id}"] button.link`);
    await waitFor(page, "BF.prefs.get('analysis.maxDurationSec', 60) === 57", 8000, 'voltou ao aprendido');
    step('editar o aprendido e voltar ao valor calculado');

    await page.eval('BF.project.flush()');
    const originalProjectFile = path.join(projectsDir, projectFiles()[0]);
    const savedOriginal = JSON.parse(fs.readFileSync(originalProjectFile, 'utf8'));
    assert.equal(savedOriginal.cuts.length, 6);
    assert.equal(projectFiles().length, 1);
    const hashOriginal = sha(originalProjectFile);

    // ---------- fonte duplicada: perguntar, recusar, criar novo, abrir o existente ----------
    await startOpen(page, dup1, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'pergunta da live duplicada');
    const ask = await modalInfo(page);
    assert.equal(ask.title, 'Esta live já foi analisada?');
    assert.match(ask.message, /^Parece a live “Minha live de teste”, já analisada \(6 cortes\)\./);
    assert.match(ask.message, /mesmo vídeo do YouTube \(código abc123XYZ_1\)/);
    assert.deepEqual(ask.buttons, ['Cancelar', 'Criar novo', 'Abrir o projeto existente']);
    await shot(page, 'pergunta');
    await answerModal(page, false); // Cancelar
    assert.deepEqual(await finishOpen(page), { ok: false, code: 'CANCELLED', restored: null });
    assert.equal(await page.eval("BF.state.project.source.path"), path.resolve(original), 'recusar não abre: o projeto aberto continua o mesmo');
    assert.equal(projectFiles().length, 1, 'recusar não cria projeto');
    assert.equal(sha(originalProjectFile), hashOriginal, 'o projeto original não foi tocado');
    assert.equal(await modalOpen(page), false);
    assert.equal(await page.eval("document.getElementById('app').inert"), false, 'o app volta a responder');
    step('fonte duplicada: a pergunta aparece (3 saídas) e Cancelar não abre nem cria nada');

    // Esc também cancela
    await startOpen(page, dup1, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'pergunta de novo');
    await page.press('Escape');
    assert.equal((await finishOpen(page)).code, 'CANCELLED');
    assert.equal(projectFiles().length, 1);

    // Criar novo: projeto vazio para a cópia
    await startOpen(page, dup1, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'pergunta (criar novo)');
    await choose(page, 'new');
    assert.deepEqual(await finishOpen(page), { ok: true, code: null, restored: false });
    assert.equal(await page.eval('BF.state.project.cuts.length'), 0);
    assert.equal(await page.eval('BF.state.project.ext.prefs.match.decision'), 'new');
    assert.equal(sha(originalProjectFile), hashOriginal, 'o original continua intacto');
    await page.eval('BF.project.flush()');
    assert.equal(projectFiles().length, 2);
    step('"Criar novo" abre um projeto vazio e registra a decisão');

    // reabrir a cópia vazia não pergunta de novo
    await startOpen(page, dup1, origin);
    assert.equal((await finishOpen(page)).ok, true);
    assert.equal(await modalOpen(page), false, 'já respondeu: não pergunta de novo');

    // Abrir o existente: outra cópia (nome diferente) adota cortes e decisões
    await startOpen(page, dup2, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'pergunta (abrir o existente)');
    await answerModal(page, true); // Abrir o projeto existente
    assert.deepEqual(await finishOpen(page), { ok: true, code: null, restored: true });
    const adopted = await page.eval('({ path: BF.state.project.source.path, cuts: BF.state.project.cuts.map((c) => [c.id, c.title, c.status]), from: BF.state.project.ext.prefs.adoptedFrom })');
    assert.equal(adopted.path, path.resolve(dup2));
    assert.deepEqual(adopted.cuts, savedOriginal.cuts.map((c) => [c.id, c.title, c.status]), 'mesmos cortes e decisões');
    assert.equal(adopted.from.label, 'Minha live de teste');
    assert.equal(adopted.from.level, 'strong');
    assert.equal(sha(originalProjectFile), hashOriginal, 'o original continua byte a byte igual');
    assert.equal(projectFiles().length, 3);
    assert.ok((await toastTexts(page)).some((x) => /Cortes e decisões copiados de “Minha live de teste”/.test(x)));
    step('"Abrir o existente" copia cortes e decisões sem alterar o original');

    // ---------- fonte atualizada: voltar à live original, que foi regravada mais curta ----------
    makeVideo(original, 40);
    await startOpen(page, original, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'confirmação da fonte atualizada');
    const diff = await modalInfo(page);
    assert.equal(diff.title, 'A fonte mudou desde a última análise');
    assert.match(diff.message, /O vídeo ficou mais curto: 1:00 → 0:40 \(−0:20\)/);
    assert.match(diff.message, /3 cortes ficam fora do novo intervalo/);
    assert.match(diff.message, /nada é apagado/);
    assert.match(diff.message, /Suas decisões, títulos e ajustes manuais continuam como estão/);
    assert.deepEqual(diff.buttons, ['Cancelar', 'Atualizar e abrir']);
    await shot(page, 'fonte-atualizada');
    await answerModal(page, false);
    assert.equal((await finishOpen(page)).code, 'CANCELLED');
    assert.equal(sha(originalProjectFile), hashOriginal, 'recusar a atualização não altera o projeto salvo');
    assert.equal(await page.eval('BF.state.project.source.path'), path.resolve(dup2), 'continua o projeto aberto antes');

    await startOpen(page, original, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'confirmação (aceitar)');
    await answerModal(page, true); // Atualizar e abrir
    assert.deepEqual(await finishOpen(page), { ok: true, code: null, restored: true });
    const refreshed = await page.eval('({ duration: BF.state.project.source.duration, cuts: BF.state.project.cuts.map((c) => [c.id, c.title, c.status, c.start, c.end]), change: BF.state.project.ext.prefs.sourceChange, badge: document.querySelector("#tab-prefs .tab-badge").textContent })');
    assert.ok(Math.abs(refreshed.duration - 40) < 1, `duração nova: ${refreshed.duration}`);
    assert.deepEqual(refreshed.cuts, savedOriginal.cuts.map((c) => [c.id, c.title, c.status, c.start, c.end]), 'cortes, decisões e tempos preservados; nenhum apagado');
    assert.equal(refreshed.change.direction, 'shorter');
    assert.equal(refreshed.badge, '!', 'a aba Preferências chama atenção');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "!document.querySelector('#tabpanel-prefs .prefs-notice').hidden", 8000, 'aviso de fonte atualizada na aba');
    const notice = await text(page, '#tabpanel-prefs .prefs-notice');
    assert.match(notice, /Fonte atualizada/);
    assert.match(notice, /3 cortes estão fora do novo intervalo \(não apagados\)/);
    assert.match(notice, /Momento 4/);
    await shot(page, 'aviso-fonte');
    await click(page, '#tabpanel-prefs .prefs-notice .prefs-outside li button');
    await waitFor(page, "document.getElementById('tabpanel-cuts') && !document.getElementById('tabpanel-cuts').hidden", 8000, 'aba Cortes aberta pelo "Ver"');
    await page.eval("BF.ui.selectTab('prefs')");
    await click(page, '#tabpanel-prefs .prefs-notice > button');
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-notice').hidden", 8000, 'aviso dispensado');
    assert.equal(await page.eval('BF.state.project.cuts.length'), 6);
    step('fonte regravada: diferença mostrada, só aplicada após confirmar, cortes fora sinalizados e preservados');

    // ---------- o MESMO VOD baixado de novo (outro arquivo, mais curto): a pergunta já mostra a diferença ----------
    const redownload = path.join(tmp, 'downloads', 'live (2).mp4');
    makeVideo(redownload, 30);
    await page.eval('BF.project.flush()');
    const hashesBefore = Object.fromEntries(projectFiles().map((f) => [f, sha(path.join(projectsDir, f))]));
    await startOpen(page, redownload, origin);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 20000, 'pergunta com a diferença do arquivo novo');
    const redo = await modalInfo(page);
    assert.equal(redo.title, 'Esta live já foi analisada?');
    assert.match(redo.message, /Este arquivo é diferente do que foi analisado:/);
    assert.match(redo.message, /• O vídeo ficou mais curto: /);
    assert.match(redo.message, /• 5 cortes ficam fora do novo intervalo/);
    assert.match(redo.message, /nada é apagado/);
    assert.deepEqual(redo.buttons, ['Cancelar', 'Criar novo', 'Abrir o projeto existente']);
    await shot(page, 'pergunta-diferente');
    await answerModal(page, true); // Abrir o projeto existente
    assert.deepEqual(await finishOpen(page), { ok: true, code: null, restored: true });
    const shortAdopted = await page.eval('({ path: BF.state.project.source.path, cuts: BF.state.project.cuts.length, change: BF.state.project.ext.prefs.sourceChange, badge: document.querySelector("#tab-prefs .tab-badge").textContent })');
    assert.equal(shortAdopted.path, path.resolve(redownload));
    assert.equal(shortAdopted.cuts, 6, 'todos os cortes vieram, inclusive os que passam do fim do arquivo novo');
    assert.equal(shortAdopted.change.direction, 'shorter');
    assert.equal(shortAdopted.change.dismissed, false);
    assert.equal(shortAdopted.badge, '!', 'a aba Preferências chama atenção');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "!document.querySelector('#tabpanel-prefs .prefs-notice').hidden", 8000, 'aviso de fonte atualizada na aba (arquivo novo)');
    assert.match(await text(page, '#tabpanel-prefs .prefs-notice'), /5 cortes estão fora do novo intervalo \(não apagados\)/);
    assert.ok((await toastTexts(page)).some((x) => /copiados de “Minha live de teste”.*5 cortes ficaram fora do novo intervalo/.test(x)), 'um aviso só: copiou e há cortes fora');
    await shot(page, 'adocao-fonte-diferente');
    for (const [file, hash] of Object.entries(hashesBefore)) assert.equal(sha(path.join(projectsDir, file)), hash, `${file}: os projetos de origem não foram tocados`);
    step('o mesmo VOD baixado de novo em outro arquivo: a pergunta mostra a diferença e a adoção sinaliza os cortes fora do intervalo');

    await shot(page, 'final');
    await page.eval('BF.project.flush()');
    assert.deepEqual(consoleErrors(page), [], 'sem erros de console até aqui');

    // ---------- reiniciar: tudo persiste ----------
    await app.stop();
    app = null;
    const prefsFile = path.join(userData, 'preferences.json');
    const learnedFile = path.join(userData, 'learned.json');
    const saved = JSON.parse(fs.readFileSync(prefsFile, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.general.values['analysis.minRelevance'], 0.7);
    assert.equal(saved.games.valorant.values['analysis.minRelevance'], 0.3);
    assert.equal(saved.channels.fulano.values['analysis.padBeforeSec'], 6);
    assert.ok(saved.history.length >= 8);
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(learnedFile, 'utf8')).observations).length >= 1);
    assert.deepEqual(fs.readdirSync(userData).filter((f) => f.endsWith('.tmp')), [], 'nenhum temporário sobra');

    app = await h.launchApp(userData);
    page = app.page;
    await waitFor(page, "BF.prefs.ready.then(() => true)", 15000, 'BF.prefs pronto');
    assert.equal(await prefsGet(page, 'analysis.minRelevance', 0.5), 0.7, 'preferência geral persistiu');
    await page.eval("BF.ui.selectTab('prefs')");
    await waitFor(page, "document.querySelector('#tabpanel-prefs .prefs-history li')", 10000, 'histórico depois de reiniciar');
    await page.eval(`(async () => { await BF.openSource(${j(dup2)}); return true; })()`);
    await waitFor(page, "BF.state.project && BF.prefs.scope().game === 'Valorant'", 15000, 'projeto reaberto');
    assert.equal(await prefsGet(page, 'analysis.maxDurationSec', 60), 57, 'aprendizado persistiu e vale para o jogo/canal do projeto');
    assert.equal((await explain(page, 'analysis.maxDurationSec')).source, 'learned');
    assert.equal(await modalOpen(page), false, 'reabrir um projeto que já tem trabalho não pergunta nada');
    assert.deepEqual(consoleErrors(page), [], 'sem erros de console depois de reiniciar');
    step('depois de reiniciar: preferências, aprendizado e histórico persistem');

    await app.stop();
    app = null;
    console.log('\nE2E das preferências: tudo certo.');
  } finally {
    await h.cleanupAll();
    h.removeDir(tmp);
  }
}

main().then(() => process.exit(0), (err) => { console.error(err); h.cleanupAll().finally(() => process.exit(1)); });
