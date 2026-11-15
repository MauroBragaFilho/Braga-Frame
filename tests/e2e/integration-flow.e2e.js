'use strict';

/**
 * E2E de INTEGRAÇÃO entre recursos, no app Electron de verdade (perfil temporário, vídeos gerados com o ffmpeg):
 *
 *   A. console limpo (zero erros E avisos) em cada aba, com e sem projeto; nenhum botão visível sem ação; sem projeto só
 *      Início, Projetos, Novo projeto, Exportações, Preferências e Ferramentas funcionam e as outras ficam desabilitadas com a dica;
 *   B. aprendizado x eventos: o 'decision' real da revisão (aprovar, desfazer, refazer, restaurar) e os 'adjust' de áudio e de
 *      legendas não contaminam o que o app aprende;
 *   C. preferências reais que os outros recursos leem e acompanham ao mudar (revisão, exportação, fila, análise, legendas) e os
 *      perfis do usuário na lista de `export.profileId`;
 *   D. Novo projeto x abertura: um VOD baixado pela tela Novo projeto e aberto depois pelo diálogo é reconhecido como a mesma live (a origem
 *      chega às Preferências antes da pergunta); fonte atualizada que só tem `origin.duration` para comparar; selo "Fora da fonte"
 *      na aba Cortes;
 *   E. gravações concorrentes: tempestade de edições + exportações concluídas + sugestões da análise sem perder nada no disco;
 *      edição feita durante a troca de vídeo; exportação concluída enquanto o corte estava removido.
 * Uso: node tests/e2e/integration-flow.e2e.js     (BF_E2E_SHOTDIR=C:\pasta guarda capturas da janela)
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');
const fx = require('../export-fixtures');

const { sleep, waitFor } = h;
const J = JSON.stringify;
const step = (m) => console.log(`✔ ${m}`);

const TABS_FREE = ['home', 'projects', 'sources', 'queue', 'general', 'prefs', 'tools'];
const TABS_LOCKED = ['editor', 'cuts', 'export', 'subtitles', 'audio', 'analysis']; // o item Cortes do menu e as abas internas dele
const ALL_TABS = ['home', 'projects', 'sources', 'cuts', 'export', 'queue', 'subtitles', 'audio', 'analysis', 'general', 'prefs', 'tools'];

async function main() {
  assert.ok(fx.tools.ffmpeg && fx.tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-integ-flow');
  const userData = path.join(tmp, 'userdata');
  const videoA = path.join(tmp, 'live-a.mp4');
  const videoB = path.join(tmp, 'Live Baixada [987654321].mp4');
  const videoC = path.join(tmp, 'live-c.mp4');
  const shots = process.env.BF_E2E_SHOTDIR;
  if (shots) fs.mkdirSync(shots, { recursive: true });

  try {
    h.makeSampleVideo(fx.tools.ffmpeg, videoA, { seconds: 24, size: '640x360', rate: 10 });
    h.makeSampleVideo(fx.tools.ffmpeg, videoB, { seconds: 17, size: '480x270', rate: 10 });
    h.makeSampleVideo(fx.tools.ffmpeg, videoC, { seconds: 20, size: '640x360', rate: 10 });
    step('vídeos de teste gerados (A: 24 s, B: 17 s em outra resolução, C: 20 s)');

    // o VOD "B" foi baixado pela tela Novo projeto (registro em sources.json, lido pelo app ao abrir)
    const vodOrigin = {
      type: 'vod', platform: 'twitch', videoId: '987654321', url: 'https://www.twitch.tv/videos/987654321',
      channel: 'CanalTeste', title: 'Live de teste', game: 'Jogo Teste', uploadDate: '2026-10-01', fetchedAt: '2026-10-02T10:00:00.000Z', duration: 24
    };
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'sources.json'), J({
      version: 1, obsFolder: null, downloadDir: null, cookiesBrowser: '',
      downloads: [{ path: videoB, origin: vodOrigin, chat: null, meta: { game: 'Jogo Teste', channel: 'CanalTeste' }, at: '2026-10-02T10:05:00.000Z' }]
    }));

    const app = await h.launchApp(userData, { args: ['--mute-audio'] });
    const { page } = app;
    app.proc.on('exit', (code, signal) => { if (!app.stopping) console.error(`O app terminou sozinho (código ${code}, sinal ${signal}).`); });
    const ev = (expr) => page.eval(expr);
    const click = (selector) => ev(`document.querySelector(${J(selector)}).click()`);
    const setValue = (selector, value, events = ['input', 'change']) => ev(`(() => { const e = document.querySelector(${J(selector)}); e.value = ${J(String(value))}; for (const t of ${J(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); })()`);
    const shot = async (name) => { if (shots) await h.screenshot(page, path.join(shots, `integration-flow-${name}.png`)); };
    const project = () => ev('JSON.parse(JSON.stringify(BF.state.project))');
    const selectTab = async (id) => { await ev(`BF.ui.selectTab(${J(id)})`); await sleep(120); };

    // avisos de console também contam (os erros o helper já junta em page.errors)
    const warnings = [];
    page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'warning') warnings.push(`console.warn: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`); });
    page.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'warning') warnings.push(`log: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`); });
    await page.send('Page.reload');
    await waitFor(page, "document.readyState === 'complete' && window.BF ? BF.ready.then(() => true) : false", 30000, 'interface recarregada');
    await sleep(500);
    page.errors.length = 0; // o que veio antes do recarregamento já foi visto pelo helper; daqui em diante nada pode aparecer

    /** Botões visíveis e habilitados de uma aba que não têm NENHUM ouvinte de clique nem em si nem nos ancestrais. */
    async function deadButtons(tabId) {
      const expression = `(() => {
        const panel = document.getElementById('tabpanel-${tabId}');
        const listensClick = (n) => { try { const l = getEventListeners(n); return Boolean(l.click && l.click.length) || typeof n.onclick === 'function'; } catch { return false; } };
        const dead = [];
        for (const b of panel.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')) {
          if (b.disabled || b.getClientRects().length === 0 || b.closest('[hidden]')) continue;
          let node = b; let ok = false;
          while (node && !ok) { ok = listensClick(node); node = node.parentNode; }
          ok = ok || listensClick(window);
          if (!ok) dead.push((b.id ? '#' + b.id : b.tagName.toLowerCase()) + ' "' + (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 40) + '"');
        }
        return dead;
      })()`;
      const r = await page.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true });
      if (r.error || r.result.exceptionDetails) throw new Error(`auditoria de botões falhou: ${J(r.error || r.result.exceptionDetails)}`);
      return r.result.result.value;
    }
    const visibleButtons = (tabId) => ev(`[...document.getElementById('tabpanel-${tabId}').querySelectorAll('button')].filter((b) => !b.disabled && b.getClientRects().length > 0).length`);
    const assertClean = (what) => {
      h.assertNoConsoleErrors(page);
      assert.deepEqual(warnings, [], `avisos de console em ${what}`);
    };

    // ======================================================================== A. sem projeto
    assert.equal(await ev('BF.state.project'), null);
    for (const id of TABS_LOCKED) {
      assert.equal(await ev(`document.getElementById('tab-${id}').disabled`), true, `a aba ${id} fica desabilitada sem projeto`);
      assert.equal(await ev(`document.getElementById('tab-${id}').title`), 'Abra um vídeo para usar esta aba');
    }
    for (const id of TABS_FREE) {
      const button = id === 'sources' ? 'projects' : id; // Novo projeto não tem botão no menu: abre pelos botões e acende o item Projetos
      assert.equal(await ev(`document.getElementById('tab-${button}').disabled`), false, `a aba ${id} funciona sem projeto`);
      await selectTab(id);
      assert.equal(await ev(`document.getElementById('tabpanel-${id}').hidden`), false);
      assert.equal(await ev(`document.getElementById('tab-${button}').getAttribute('aria-selected')`), 'true');
      await sleep(400); // as abas buscam seus dados ao aparecer
      assert.ok((await ev(`document.getElementById('tabpanel-${id}').textContent.trim().length`)) > 20, `a aba ${id} desenhou algo`);
      assert.deepEqual(await deadButtons(id), [], `botões sem ação em ${id} (sem projeto)`);
      assertClean(`aba ${id} sem projeto`);
    }
    // controle negativo: a auditoria de verdade enxerga um botão sem ação (e aceita um com ação)
    await ev("(() => { const p = document.getElementById('tabpanel-tools'); const dead = document.createElement('button'); dead.id = '__morto'; dead.textContent = 'Sem ação'; p.append(dead); const live = document.createElement('button'); live.id = '__vivo'; live.textContent = 'Com ação'; live.addEventListener('click', () => {}); p.append(live); })()");
    assert.deepEqual(await deadButtons('tools'), ['#__morto "Sem ação"'], 'a auditoria acusa o botão sem ouvinte e só ele');
    await ev("document.getElementById('__morto').remove(); document.getElementById('__vivo').remove()");
    // tentar abrir uma aba bloqueada não troca de aba nem quebra
    assert.equal(await ev("BF.ui.selectTab('cuts')"), false);
    assert.equal(await ev("document.getElementById('tab-tools').getAttribute('aria-selected')"), 'true');
    step('sem projeto: Início, Projetos, Novo projeto, Exportações, Preferências e Ferramentas funcionam; as outras ficam desabilitadas com a dica; console limpo e nenhum botão sem ação');

    // ======================================================================== abrir o vídeo A (VOD já analisado)
    await ev(`BF.openSource(${J(videoA)}, ${J(vodOrigin)})`);
    await waitFor(page, "BF.state.project && !document.getElementById('app').classList.contains('no-project') && document.getElementById('video').readyState >= 1", 30000, 'vídeo A carregado');
    const projectA = await project();
    assert.equal(projectA.source.origin.videoId, '987654321', 'o projeto nasce com a origem do VOD');
    const cutIds = [];
    for (let i = 0; i < 6; i++) {
      cutIds.push(await ev(`BF.project.addCut({ start: ${i * 3}, end: ${i * 3 + 2 + (i % 3)}, title: 'Corte ${i + 1}' }).id`));
    }
    await waitFor(page, "document.querySelectorAll('#cuts li.cut').length === 6", 15000, 'seis cortes na aba Cortes');
    await sleep(900); // o aprendizado agrupa as decisões por ~0,4 s: o "create" dos seis cortes sai antes do que vem a seguir

    // ======================================================================== B. aprendizado x eventos
    await ev(`(() => {
      window.__obs = []; window.__decisions = [];
      const api = BF.api;
      BF.api = (channel, payload, opts) => { if (channel === 'prefs:observe') window.__obs.push(JSON.parse(JSON.stringify(payload))); return api(channel, payload, opts); };
      BF.bus.on('decision', (d) => window.__decisions.push(JSON.parse(JSON.stringify(d))));
    })()`);
    const observed = async () => (await ev("BF.api('prefs:learned', {}).then((r) => r.observed)"));
    const approveInUi = (id) => ev(`[...document.querySelector('#cuts li.cut[data-id="${id}"]').querySelectorAll('button')].find((b) => b.textContent === 'Aprovar').click()`);
    const groups = () => ev('BF.review.engine.groups().map((g) => g.label)');
    await ev('BF.review.engine.flushExternal()'); // fecha o grupo "Criou 6 cortes" antes de contar
    const labelsBefore = await groups();

    await selectTab('cuts');
    await approveInUi(cutIds[0]);
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).status === 'approved'`, 10000, 'corte aprovado');
    await waitFor(page, 'window.__obs.length === 1', 5000, 'observação enviada');
    assert.equal(await observed(), 1, 'a aprovação do usuário conta');
    const approveEvent = (await ev('window.__decisions')).find((d) => d.type === 'approve');
    assert.deepEqual([approveEvent.cutId, approveEvent.before, approveEvent.after, approveEvent.source], [cutIds[0], 'pending', 'approved', 'user']);
    assert.ok(approveEvent.reviewGroup, 'o formato real do review traz reviewGroup/source/label para o histórico');

    // áudio: o ganho emite 'decision' adjust com scope 'audio' - não é decisão sobre o corte
    await selectTab('audio');
    await ev(`BF.bus.emit('cut:selected', { id: ${J(cutIds[0])} })`);
    await waitFor(page, "document.getElementById('audioGainNum') && !document.querySelector('#tabpanel-audio .audio-body').hidden", 15000, 'painel de áudio');
    await setValue('#audioGainNum', '4', ['change']);
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).audio.gainDb === 4`, 10000, 'ganho gravado');
    // legendas: ligar a legenda e mudar a entrega emitem 'adjust' com what 'subtitles'
    await selectTab('subtitles');
    await ev(`BF.bus.emit('cut:selected', { id: ${J(cutIds[0])} })`);
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles [data-fid=\"enabled\"]')", 20000, 'aba Legendas');
    await ev("(() => { const box = document.querySelector('#tabpanel-subtitles [data-fid=\"enabled\"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).subtitles && BF.project.cut(${J(cutIds[0])}).subtitles.enabled === true`, 10000, 'legenda ligada');
    await sleep(900);
    const adjusts = (await ev('window.__decisions')).filter((d) => d.type === 'adjust');
    assert.ok(adjusts.some((d) => d.scope === 'audio'), 'o áudio emitiu adjust com scope');
    assert.ok(adjusts.some((d) => d.before && d.before.what === 'subtitles'), 'as legendas emitiram adjust com what');
    assert.equal((await ev('window.__obs')).length, 1, 'nenhum ajuste de áudio/legendas chegou ao aprendizado');
    assert.equal(await observed(), 1);
    const labelsAfter = await groups();
    assert.equal(labelsAfter.length, labelsBefore.length + 1, `só a aprovação entrou no histórico: ${J(labelsAfter)}`);
    assert.ok(!labelsAfter.some((l) => /Ajustou/.test(l)), `o histórico da revisão não ganhou entradas vazias de áudio/legendas: ${J(labelsAfter)}`);
    step('aprovação do usuário conta; ajustes de áudio e de legendas não chegam ao aprendizado nem ao histórico da revisão');

    // desfazer / refazer / restaurar: o review emite 'decision' com source undo/redo/restore
    const decisionsBefore = (await ev('window.__decisions')).length;
    await ev('BF.review.engine.undo()');
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).status === 'pending'`, 10000, 'aprovação desfeita');
    await waitFor(page, 'window.__obs.length === 2', 5000, 'observação do desfazer');
    const afterUndo = (await ev('window.__decisions')).slice(decisionsBefore);
    assert.ok(afterUndo.some((d) => d.source === 'undo' && d.type === 'reset' && d.before === 'approved' && d.after === 'pending'), `decision do desfazer: ${J(afterUndo)}`);
    assert.equal((await ev('window.__obs'))[1].onlyKnown, true);
    assert.equal(await observed(), 0, 'a aprovação desfeita deixou de contar');
    await ev('BF.review.engine.redo()');
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).status === 'approved'`, 10000, 'aprovação refeita');
    await waitFor(page, 'window.__obs.length === 3', 5000, 'observação do refazer');
    assert.equal(await observed(), 0, 'refazer não é decisão nova');
    const plan = await ev(`(() => { const g = BF.review.engine.groups().find((x) => /Aprovou/.test(x.label)); const p = BF.review.engine.planRestore(g.id); return Boolean(p && p.items.length); })()`);
    assert.equal(plan, true);
    await ev(`(() => { const g = BF.review.engine.groups().find((x) => /Aprovou/.test(x.label)); BF.review.engine.restore(BF.review.engine.planRestore(g.id)); })()`);
    await waitFor(page, `BF.project.cut(${J(cutIds[0])}).status === 'pending'`, 10000, 'estado restaurado');
    await waitFor(page, 'window.__obs.length === 4', 5000, 'observação da restauração');
    assert.equal(await observed(), 0, 'restaurar não contamina o aprendizado');
    const sources = (await ev('window.__decisions')).map((d) => d.source).filter(Boolean);
    assert.ok(['user', 'undo', 'redo', 'restore'].every((s) => sources.includes(s)), `fontes dos eventos: ${J(sources)}`);
    step('desfazer, refazer e restaurar: o evento real traz source undo/redo/restore e o aprendizado só retira, nunca soma');

    // nova aprovação do usuário depois disso volta a contar; ajuste de tempo do corte também chega
    await approveInUi(cutIds[1]);
    await waitFor(page, 'window.__obs.length === 5', 5000, 'nova aprovação observada');
    assert.equal(await observed(), 1);
    await ev(`BF.review.adjust(${J(cutIds[1])}, { end: BF.project.cut(${J(cutIds[1])}).end + 1 })`);
    await waitFor(page, 'window.__obs.length === 6', 5000, 'ajuste de tempo observado');
    const last = (await ev('window.__obs')).pop();
    assert.equal(last.cuts[0].state.duration, (await ev(`BF.project.cut(${J(cutIds[1])}).end - BF.project.cut(${J(cutIds[1])}).start`)));
    step('ajuste de TEMPO do corte (adjust com start/end) chega ao aprendizado com a duração nova');

    // ======================================================================== auditoria de todas as abas com projeto
    for (const id of ALL_TABS) {
      await selectTab(id);
      await sleep(500);
      assert.equal(await ev(`document.getElementById('tabpanel-${id}').hidden`), false);
      if (id !== 'queue') assert.ok((await visibleButtons(id)) > 0, `a aba ${id} tem botões visíveis`); // a Fila vazia não mostra nenhum (tela limpa)
      await ev(`document.querySelectorAll('#tabpanel-${id} details').forEach((d) => { d.open = true; })`); // ajustes recolhidos também têm de ter ação
      await sleep(300);
      assert.deepEqual(await deadButtons(id), [], `botões sem ação em ${id} (com projeto)`);
      assertClean(`aba ${id} com projeto`);
      await shot(`aba-${id}`);
    }
    // timeline detalhada (forma de onda) ligada e desligada
    await selectTab('cuts');
    await click('.tl-toggle');
    await waitFor(page, "document.querySelector('.tl-toggle').getAttribute('aria-pressed') === 'true'", 10000, 'timeline aberta');
    await sleep(1500);
    assert.deepEqual(await deadButtons('cuts'), [], 'botões sem ação na aba Cortes com a timeline aberta');
    await click('.tl-toggle');
    assertClean('timeline');
    step(`console limpo (sem erros e sem avisos) e nenhum botão sem ação nas ${ALL_TABS.length} abas com projeto (ajustes recolhidos abertos) e na timeline`);

    // ======================================================================== C. preferências que os outros recursos leem
    const pref = (key) => `[data-focus="pref-${key}"]`;
    const prefsTab = async () => { await selectTab('prefs'); await waitFor(page, "!!document.querySelector('.prefs-row')", 15000, 'lista de preferências'); };
    // dois cortes sugeridos (origin auto) para a ordem por relevância
    const [autoLow, autoHigh] = await ev(`(() => {
      const made = [];
      BF.project.update((p) => {
        made.push(BF.model.newCut({ title: 'Sugestão baixa', start: 16, end: 20, origin: 'auto', relevance: 0.3 }, { index: 6 }));
        made.push(BF.model.newCut({ title: 'Sugestão alta', start: 21, end: 23.5, origin: 'auto', relevance: 0.95 }, { index: 7 }));
        p.cuts.push(...made); p.cuts.sort((a, b) => a.start - b.start);
      }, { reason: 'teste' });
      BF.bus.emit('cuts:changed', { ids: made.map((c) => c.id) });
      return made.map((c) => c.id);
    })()`);
    assert.ok(autoLow && autoHigh);

    // perfil do usuário criado pela aba Exportar (fluxo real: "Salvar como meu perfil…")
    await selectTab('export');
    await waitFor(page, "[...document.querySelectorAll('#exp-profile option')].length > 3", 15000, 'perfis na aba Exportar');
    await ev("document.getElementById('exp-details').open = true");
    await click('#exp-save-profile');
    await h.answerModal(page, true, { text: 'Meu perfil de teste' });
    await waitFor(page, "BF.state.project.ext.export && /^user-/.test(BF.state.project.ext.export.profileId || '')", 15000, 'perfil do usuário salvo e escolhido');
    const userProfileId = await ev('BF.state.project.ext.export.profileId');
    // o projeto passa a não ter escolha própria: as preferências decidem
    await ev("BF.project.update((p) => { delete p.ext.export.profileId; p.profileId = 'vertical-1080-h264'; }, { reason: 'export:profile' })");
    await prefsTab();
    const options = await ev(`[...document.querySelector('${pref('export.profileId')}').options].map((o) => [o.value, o.textContent])`);
    assert.ok(options.some(([id, name]) => id === userProfileId && /Meu perfil de teste/.test(name)), `a lista de export.profileId traz o perfil do usuário: ${J(options)}`);
    assert.ok(options.some(([id]) => id === 'horizontal-1080-h264'), 'e os embutidos');
    await setValue(pref('export.profileId'), userProfileId, ['change']);
    await waitFor(page, `BF.prefs.get('export.profileId') === ${J(userProfileId)}`, 10000, 'preferência de perfil gravada');
    await selectTab('export');
    await waitFor(page, `document.getElementById('exp-profile').value === ${J(userProfileId)}`, 10000, 'a aba Exportar usa o perfil das preferências');
    assert.equal(await ev('BF.state.project.ext.export.profileId || null'), null, 'o projeto continua sem escolha própria');
    // mudar a preferência com a aba Exportar já carregada: acompanha na hora (sem reabrir o vídeo)
    await prefsTab();
    await setValue(pref('export.profileId'), 'horizontal-1080-h264', ['change']);
    await waitFor(page, "BF.prefs.get('export.profileId') === 'horizontal-1080-h264'", 10000, 'preferência trocada');
    await waitFor(page, "document.getElementById('exp-profile').value === 'horizontal-1080-h264'", 10000, 'a aba Exportar acompanhou a mudança');
    // enquadramento
    await prefsTab();
    await setValue(pref('export.framing.mode'), 'blur', ['change']);
    await waitFor(page, "BF.prefs.get('export.framing.mode') === 'blur'", 10000, 'modo de enquadramento gravado');
    await waitFor(page, "document.querySelector('#tabpanel-export [data-mode=\"blur\"]').getAttribute('aria-pressed') === 'true'", 10000, 'a aba Exportar mostra o enquadramento das preferências');
    await prefsTab();
    await setValue(pref('export.framing.mode'), 'center', ['change']);
    step('Preferências -> Exportar: lista com o perfil do usuário (export:listProfiles), perfil e enquadramento acompanham a mudança com a aba aberta');

    // fila
    await setValue(pref('queue.parallel'), '3', ['change']);
    await waitFor(page, "BF.prefs.get('queue.parallel') === 3", 10000, 'preferência de paralelismo gravada');
    await waitFor(page, 'BF.queue.state.settings && BF.queue.state.settings.defaultParallel === 3', 10000, 'a Fila acompanhou queue.parallel sem abrir a aba');
    assert.equal((await ev("BF.api('queue:getSettings', {}).then((r) => r.settings)")).defaultParallel, 3, 'o processo principal também recebeu');
    await setValue(pref('queue.parallel'), '1', ['change']);
    await waitFor(page, 'BF.queue.state.settings.defaultParallel === 1', 10000, 'a Fila voltou para 1');
    step('Preferências -> Fila: queue.parallel chega ao processo principal na hora (evento prefs:changed)');

    // revisão: ordem padrão e categorias
    await prefsTab();
    await setValue(pref('review.defaultSort'), 'relevance', ['change']);
    await waitFor(page, "BF.prefs.get('review.defaultSort') === 'relevance'", 10000, 'ordem gravada');
    await selectTab('cuts');
    await waitFor(page, `document.querySelector('#cuts li.cut').dataset.id === ${J(autoHigh)} && document.querySelector('select.sort').value === 'relevance'`, 10000, 'a lista passou a ser por relevância');
    await prefsTab();
    await setValue(pref('review.defaultSort'), 'chrono', ['change']);
    await selectTab('cuts');
    await waitFor(page, `document.querySelector('#cuts li.cut').dataset.id === ${J(cutIds[0])}`, 10000, 'a lista voltou à ordem da live');
    await prefsTab();
    await setValue(pref('review.categories'), 'Alfa, Beta', ['change']);
    await waitFor(page, "BF.prefs.get('review.categories').join() === 'Alfa,Beta'", 10000, 'categorias gravadas');
    await selectTab('cuts');
    await waitFor(page, "[...document.querySelectorAll('#cutCategories option')].some((o) => o.value === 'Alfa') && [...document.querySelectorAll('#cutCategories option')].some((o) => o.value === 'Beta')", 10000, 'categorias sugeridas na aba Cortes');
    await ev("BF.prefs.unset('review.categories')");
    step('Preferências -> Cortes: review.defaultSort e review.categories valem na hora');

    // análise: margens/durações/relevância e palavras-chave
    await ev("BF.prefs.set('analysis.padBeforeSec', 7)");
    // as Preferências aceitam a mesma faixa da análise (5 a 180 s): 300 s é recusado na origem, em vez de a análise limitar sem avisar
    const tooLong = await ev("BF.prefs.set('analysis.maxDurationSec', 300)");
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.code, 'INVALID_VALUE');
    assert.match(tooLong.message, /entre 5 e 180 segundos/);
    await ev("BF.prefs.set('analysis.maxDurationSec', 150)");
    await ev("BF.prefs.set('analysis.keywords', ['foo', 'bar'])");
    await selectTab('analysis');
    await waitFor(page, "document.getElementById('anKeywords').value === 'foo, bar' && /7 s antes/.test(document.getElementById('anPrefsNote').textContent)", 10000, 'Análise mostra as preferências');
    const note = await ev("document.getElementById('anPrefsNote').textContent");
    assert.match(note, /entre 15 e 150 s/, 'a duração máxima das Preferências é a que a análise usa');
    assert.doesNotMatch(note, /fora do que a análise aceita/, 'e não há o que avisar: a faixa das Preferências é a da análise');
    // mexer em outro ajuste NÃO congela as palavras-chave; mudar a preferência depois ainda chega
    await setValue('#anSensitivity', '4', ['change']);
    assert.equal(await ev('BF.state.project.ext.analysis.settings.chat.keywords === undefined'), true, 'palavras-chave iguais às das Preferências não são gravadas no projeto');
    await ev("BF.prefs.set('analysis.keywords', ['baz'])");
    await waitFor(page, "document.getElementById('anKeywords').value === 'baz'", 10000, 'palavras-chave acompanham as Preferências');
    // uma lista própria do projeto vale mais que a das Preferências
    await setValue('#anKeywords', 'meu, proprio', ['change']);
    assert.deepEqual(await ev('BF.state.project.ext.analysis.settings.chat.keywords'), ['meu', 'proprio']);
    await ev("BF.prefs.set('analysis.keywords', ['outra'])");
    await sleep(300);
    assert.equal(await ev("document.getElementById('anKeywords').value"), 'meu, proprio');
    await ev("BF.prefs.unset('analysis.keywords'); BF.prefs.unset('analysis.padBeforeSec'); BF.prefs.unset('analysis.maxDurationSec'); true");
    step('Preferências -> Análise: margens, durações, relevância e palavras-chave acompanham a mudança; fora da faixa da análise a Preferência recusa');

    // legendas: um corte SEM legenda mostra (e nasce com) a entrega e o estilo das Preferências
    await ev("BF.prefs.set('subtitles.mode', 'sidecar')");
    await ev("BF.prefs.set('subtitles.style', { fontFamily: 'Verdana', fontSize: 80, color: '#FFFF00' })");
    await selectTab('subtitles');
    await ev(`BF.bus.emit('cut:selected', { id: ${J(cutIds[3])} })`);
    await waitFor(page, "!!document.querySelector('#tabpanel-subtitles select[data-fid=\"mode\"]')", 15000, 'aba Legendas do corte sem legenda');
    assert.equal(await ev(`BF.project.cut(${J(cutIds[3])}).subtitles`), null, 'o corte ainda não tem legenda');
    assert.equal(await ev("document.querySelector('#tabpanel-subtitles select[data-fid=\"mode\"]').value"), 'sidecar', 'a entrega mostrada é a das Preferências');
    await ev("document.querySelector('#tabpanel-subtitles details[data-section=\"style\"]').open = true");
    assert.equal(await ev("document.querySelector('#tabpanel-subtitles [data-fid=\"size\"]').value"), '80', 'o tamanho mostrado é o das Preferências');
    await ev("(() => { const box = document.querySelector('#tabpanel-subtitles [data-fid=\"enabled\"]'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor(page, `BF.project.cut(${J(cutIds[3])}).subtitles && BF.project.cut(${J(cutIds[3])}).subtitles.mode === 'sidecar'`, 10000, 'legenda criada com a entrega das Preferências');
    assert.equal(await ev(`BF.project.cut(${J(cutIds[3])}).subtitles.style.fontSize`), 80);
    assert.equal(await ev(`BF.project.cut(${J(cutIds[3])}).subtitles.style.color`), '#FFFF00');
    await ev("BF.prefs.unset('subtitles.mode'); BF.prefs.unset('subtitles.style'); true");
    step('Preferências -> Legendas: entrega e estilo mostrados e usados ao criar a legenda do corte');
    assertClean('preferências');

    // ======================================================================== D. Novo projeto x abertura
    const fileOf = (id) => path.join(userData, 'projects', `${id}.json`);
    const sha = (file) => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const idA = projectA.id;
    await ev('BF.project.flush()');
    const hashA = sha(fileOf(idA));
    // B foi baixado pela tela Novo projeto e é aberto agora pelo diálogo (sem origem): a origem chega do registro das Fontes antes da pergunta
    const opening = ev(`BF.openSource(${J(videoB)}).then((r) => r.ok)`);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 30000, 'a pergunta "esta live já foi analisada?"');
    const modalText = await ev("document.querySelector('.bf-modal').textContent");
    assert.match(modalText, /Esta live já foi analisada/);
    assert.match(modalText, /Parece a live/, 'correspondência forte (não "pode ser")');
    assert.match(modalText, /mesmo vídeo d[ao] Twitch \(código 987654321\)/, 'o motivo vem da origem (código do vídeo), que só existe porque a tela Novo projeto a preencheu antes');
    assert.match(modalText, /Live de teste/);
    await h.answerModal(page, true);
    assert.equal(await opening, true);
    const projectB = await project();
    assert.equal(projectB.source.path, videoB);
    assert.equal(projectB.source.origin.videoId, '987654321', 'o projeto novo nasce com a origem do VOD');
    assert.equal(projectB.ext.prefs.adoptedFrom.projectId, idA);
    assert.equal(projectB.cuts.length, 8, 'os cortes e as decisões foram copiados');
    assert.equal(projectB.meta.game, 'Jogo Teste', 'o jogo veio do registro da tela Novo projeto (afterOpen)');
    assert.equal(projectB.meta.channel, 'CanalTeste');
    assert.equal(sha(fileOf(idA)), hashA, 'o projeto original não foi alterado');
    step('VOD baixado pela tela Novo projeto e aberto pelo diálogo: reconhecido como a mesma live, projeto copiado, original intacto');

    // fonte atualizada: o projeto guardado só tem a duração que a plataforma informou (origin.duration)
    const projectC = {
      version: 2,
      source: { path: videoC, size: 0, duration: 0, width: 640, height: 360, origin: { type: 'vod', platform: 'youtube', videoId: 'abcDEF12345', title: 'Outra live', duration: 40 } },
      cuts: [
        { id: 'cc1', title: 'Dentro', start: 0, end: 10, status: 'approved' },
        { id: 'cc2', title: 'Parcial', start: 12, end: 25, status: 'pending' },
        { id: 'cc3', title: 'Fora', start: 30, end: 38, status: 'pending' }
      ]
    };
    const saved = await ev(`BF.api('project:save', { project: BF.model.normalizeProject(${J(projectC)}) })`);
    assert.equal(saved.ok, true);
    assert.equal(saved.project.source.duration, 0);
    const opening2 = ev(`BF.openSource(${J(videoC)}).then((r) => r.ok)`);
    await waitFor(page, "!!document.querySelector('.bf-modal')", 30000, 'a confirmação "a fonte mudou"');
    const changeText = await ev("document.querySelector('.bf-modal').textContent");
    assert.match(changeText, /A fonte mudou desde a última análise/);
    assert.match(changeText, /mais curto/, 'comparou 0:40 (origin.duration) com 0:20 (o arquivo)');
    assert.match(changeText, /2 cortes ficam fora do novo intervalo/);
    await h.answerModal(page, true);
    assert.equal(await opening2, true);
    assert.equal(await ev('BF.state.project.source.duration'), 20, 'a fonte foi atualizada');
    assert.equal(await ev('BF.state.project.cuts.length'), 3, 'nenhum corte foi apagado');
    assert.equal(await ev('BF.state.project.ext.prefs.sourceChange.dismissed'), false);
    await selectTab('cuts');
    await waitFor(page, "document.querySelectorAll('#cuts li.cut .chip.outside').length === 2", 15000, 'selos "Fora da fonte"');
    assert.deepEqual(await ev("[...document.querySelectorAll('#cuts li.cut')].filter((li) => li.querySelector('.chip.outside')).map((li) => li.dataset.id).sort()"), ['cc2', 'cc3']);
    assert.match(await ev("document.querySelector('#cuts .chip.outside').title"), /Ele foi mantido \(nada é apagado\)/);
    await shot('fora-da-fonte');
    // ajustar o tempo de um deles tira o selo daquele; dispensar o aviso (Preferências) tira o resto
    await ev("BF.review.adjust('cc2', { end: 19 })");
    await waitFor(page, "document.querySelectorAll('#cuts li.cut .chip.outside').length === 1", 10000, 'o selo saiu do corte ajustado');
    await prefsTab();
    await waitFor(page, "!document.querySelector('.prefs-notice').hidden", 10000, 'aviso de fonte atualizada nas Preferências');
    await ev("[...document.querySelectorAll('.prefs-notice button')].find((b) => b.textContent === 'Dispensar aviso').click()");
    await selectTab('cuts');
    await waitFor(page, "document.querySelectorAll('#cuts li.cut .chip.outside').length === 0", 10000, 'dispensar o aviso tira os selos');
    assert.equal(await ev("BF.state.project.cuts.find((c) => c.id === 'cc3').end"), 38, 'o corte fora continua como estava (só o aviso foi dispensado)');
    step('fonte atualizada comparada por origin.duration; selo "Fora da fonte" na aba Cortes enquanto o aviso não é dispensado');

    // ======================================================================== E. gravações concorrentes
    const projectId = await ev('BF.state.project.id');
    const readDisk = () => JSON.parse(fs.readFileSync(fileOf(projectId), 'utf8'));
    // E1. tempestade: edições da revisão, exportações concluídas da fila, sugestões da análise e ajustes de áudio, tudo misturado
    await ev(`(async () => {
      const sleep0 = () => new Promise((r) => setTimeout(r, 0));
      const engine = BF.review.engine;
      for (let i = 0; i < 160; i++) {
        const cut = BF.state.project.cuts[i % BF.state.project.cuts.length];
        if (i % 5 === 0) engine.retitle(cut.id, 'T' + i);
        else if (i % 5 === 1) engine.recategorize(cut.id, 'C' + (i % 7));
        else if (i % 5 === 2) BF.queue.applyDone({ id: 'job' + i, projectId: BF.state.project.id, key: 'k' + i, finishedAt: new Date().toISOString(), cut: { id: cut.id, start: cut.start, end: cut.end, revision: cut.revision }, profile: { id: 'vertical-1080-h264' } }, 'D:/saida/' + i + '.mp4');
        else if (i % 5 === 3) BF.project.update(() => { cut.audio = { ...cut.audio, gainDb: (i % 10) / 2 }; cut.updatedAt = new Date().toISOString(); }, { reason: 'audio:adjust' });
        else BF.analysis.addSuggestions([{ id: 's' + i, start: 100 + i, end: 105 + i, peak: 102 + i, relevance: 0.7, reasons: ['teste'] }]);
        if (i % 7 === 0) await sleep0();
        if (i % 40 === 0) await new Promise((r) => setTimeout(r, 350));
      }
    })()`);
    await ev('BF.project.flush()');
    const memory = await project();
    const disk = readDisk();
    assert.deepEqual(disk.cuts, memory.cuts, 'o arquivo em disco tem exatamente os mesmos cortes da memória');
    assert.deepEqual(disk.ext, memory.ext);
    const exportsCount = memory.cuts.reduce((n, c) => n + c.exports.length, 0);
    assert.equal(exportsCount, 32, '32 exportações concluídas anotadas, nenhuma perdida');
    assert.ok(memory.cuts.some((c) => c.origin === 'auto' && /^Sugestão/.test(c.title)), 'as sugestões da análise entraram');
    step(`tempestade de edições + exportações + sugestões + áudio: disco == memória (${memory.cuts.length} cortes, ${exportsCount} exportações)`);

    // E2. edição feita no projeto antigo DURANTE a troca de vídeo (depois do flush do BF.openSource, antes do projeto novo assumir)
    const oldCutId = await ev("BF.state.project.cuts.find((c) => c.status === 'pending').id");
    assert.equal(await ev(`BF.project.cut(${J(oldCutId)}).status`), 'pending');
    // um evento assíncrono (fila, análise, legenda, um clique) chega exatamente quando o source:open responde: o flush do
    // BF.openSource já passou e o projeto novo ainda não assumiu, ou seja, o projeto aberto ainda é o antigo
    await ev(`(() => {
      window.__realApi = BF.api;
      BF.api = async (channel, payload, opts) => {
        const res = await window.__realApi(channel, payload, opts);
        if (channel === 'source:open') {
          BF.review.engine.setStatus(${J(oldCutId)}, 'approved');
          BF.project.update(() => { BF.project.cut(${J(oldCutId)}).notes = 'escrita durante a troca'; }, { reason: 'teste' });
        }
        return res;
      };
    })()`);
    assert.equal(await ev(`BF.openSource(${J(videoA)}).then((r) => r.ok)`), true);
    await ev('BF.api = window.__realApi; true');
    assert.equal(await ev('BF.state.project.source.path'), videoA, 'o projeto novo assumiu');
    await sleep(600);
    const oldDisk = readDisk();
    const oldCut = oldDisk.cuts.find((c) => c.id === oldCutId);
    assert.equal(oldCut.status, 'approved', 'a aprovação feita durante a troca está no arquivo do projeto antigo');
    assert.equal(oldCut.notes, 'escrita durante a troca');
    step('edição feita durante a troca de vídeo não se perde (rede de segurança do shell)');

    // E3. exportação que termina enquanto o corte está removido: ao desfazer a remoção, a exportação volta ao corte
    const target = await ev('BF.state.project.cuts[0].id');
    const job = { id: 'job-remove', state: 'done', projectId: await ev('BF.state.project.id'), key: 'kk', finishedAt: new Date().toISOString(), output: 'D:/saida/removido.mp4', cut: { id: target, start: 0, end: 2, revision: 1 }, profile: { id: 'vertical-1080-h264' } };
    await ev(`BF.queue.state.jobs = [${J(job)}]; BF.review.engine.remove(${J(target)}); true`);
    assert.equal(await ev(`BF.queue.applyDone(BF.queue.state.jobs[0], ${J(job.output)})`), false, 'o corte não existe: nada a anotar');
    await ev('BF.review.engine.undo()');
    await waitFor(page, `(BF.project.cut(${J(target)}) || { exports: [] }).exports.some((e) => e.path === ${J(job.output)})`, 10000, 'a exportação foi anotada quando o corte voltou');
    assert.equal(await ev(`BF.project.cut(${J(target)}).exports.filter((e) => e.path === ${J(job.output)}).length`), 1, 'uma vez só');
    await ev('BF.queue.state.jobs = []; true');
    step('exportação concluída enquanto o corte estava removido é anotada quando ele volta (desfazer)');

    assertClean('fluxo completo');

    h.assertNoConsoleErrors(page);
    app.stopping = true;
    await app.stop();
  } finally {
    await h.cleanupAll();
    try { h.removeDir(tmp); } catch (err) { console.error(`(não foi possível apagar ${tmp}: ${err.message})`); }
  }
}

main().then(() => console.log('OK: integration-flow'), (err) => { console.error(err); process.exitCode = 1; });
