'use strict';

/**
 * E2E da análise por IA na nuvem: app Electron de verdade (perfil temporário) falando com um servidor HTTP LOCAL que imita a API
 * `chat/completions` (tests/ai-fakes.js). Cobre: o seletor de motor, configurar o provedor (Personalizado apontando para o servidor local),
 * a chave em campo protegido que nunca reaparece, "Testar conexão", importar uma transcrição, a estimativa, o aviso de privacidade
 * (recusar não envia nada; aceitar libera), a análise em duas passadas, as sugestões (pendentes, com título, motivos, categoria e
 * enquadramento), a conferência local descartando alucinação, adicionar como cortes pendentes (nunca aprovados), cancelar no meio,
 * a falha do provedor com a opção "Usar o algoritmo", a persistência depois de reiniciar e que a CHAVE nunca aparece na tela, no
 * projeto, no armazenamento do navegador nem em arquivo.
 * Uso: node tests/e2e/analysis-ia.e2e.js   (BF_E2E_SHOTDIR=<pasta> guarda capturas 1360x840 nos temas escuro e claro)
 * Rede real com provedor de verdade: só com BF_AI_TEST_KEY + BF_AI_TEST_URL + BF_AI_TEST_MODEL (veja o fim do arquivo).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { locateTools } = require('../../src/core/ffmpeg/locate');
const F = require('../ai-fakes');
const h = require('./helpers');

const { sleep, waitFor, answerModal } = h;
const tools = locateTools();
const step = (m) => console.log(`✔ ${m}`);
const q = (s) => JSON.stringify(s);

const text = (page, sel) => page.eval(`document.querySelector(${q(sel)}) ? document.querySelector(${q(sel)}).textContent : null`);
const click = (page, sel) => page.eval(`document.querySelector(${q(sel)}).click()`);
const setValue = (page, sel, value, events = ['input', 'change']) => page.eval(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(String(value))}; ${events.map((ev) => `e.dispatchEvent(new Event(${q(ev)}, { bubbles: true }))`).join('; ')}; })()`);
const visible = (page, sel) => page.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false; for (let n = e; n; n = n.parentElement) if (n.hidden) return false; return true; })()`);

const lastContent = (call) => call.body.messages[call.body.messages.length - 1].content;
const isPick = (call) => lastContent(call).includes('=== CANDIDATOS ===');

/** Procura a chave em tudo o que a tela, o projeto e o navegador guardam. */
async function leaks(page) {
  return page.eval(`(() => {
    const KEY = ${q(F.KEY)};
    let ls = ''; let ss = '';
    try { ls = JSON.stringify(localStorage); ss = JSON.stringify(sessionStorage); } catch (e) { /* sem acesso */ }
    return {
      html: document.documentElement.outerHTML.includes(KEY),
      text: document.body.innerText.includes(KEY),
      inputs: [...document.querySelectorAll('input,textarea,select')].some((i) => String(i.value).includes(KEY) || String(i.placeholder).includes(KEY)),
      project: JSON.stringify(BF.state.project).includes(KEY),
      state: JSON.stringify({ app: BF.state.app, tools: BF.state.tools, info: BF.state.info }).includes(KEY),
      storage: ls.includes(KEY) || ss.includes(KEY),
      log: String(document.getElementById('log') ? document.getElementById('log').textContent : '').includes(KEY)
    };
  })()`);
}
const assertNoLeak = async (page, where) => {
  const l = await leaks(page);
  assert.deepEqual(Object.entries(l).filter(([, v]) => v).map(([k]) => k), [], `a chave apareceu (${where}): ${JSON.stringify(l)}`);
};

function scanFiles(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { if (fs.statSync(p).size < 64 * 1024 * 1024 && fs.readFileSync(p).toString('latin1').includes(needle)) hits.push(p); } catch { /* arquivo em uso: o app já fechou, então é raro */ }
      }
    }
  };
  walk(dir);
  return hits;
}

async function main() {
  assert.ok(tools.ffmpeg && tools.ffprobe, 'ffmpeg/ffprobe necessários para o teste');
  const tmp = h.mkTemp('e2e-analysis-ia');
  const userData = path.join(tmp, 'userdata');
  const video = path.join(tmp, 'live-ia.mp4');
  const srt = path.join(tmp, 'live-ia.srt');
  let mock = null;

  try {
    // vídeo de 12 min (pequeno) e transcrição sintética com três momentos conhecidos
    require('node:child_process').execFileSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5:duration=720',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=720', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest', video], { windowsHide: true });
    const tr = F.makeTranscript({ minutes: 12, moments: [{ at: 120, punch: 'o bicho nem dropou couro' }, { at: 300, punch: 'obrigado jogo eu morri afogado' }, { at: 520, punch: 'vinte e um reais uma espada' }] });
    const stamp = (s) => `00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')},${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
    fs.writeFileSync(srt, tr.cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));
    step('vídeo de 12 min e legenda .srt sintéticos gerados');

    // servidor "OpenAI" local: o modo muda de um passo para o outro
    let mode = 'ok';
    mock = await F.startMockAi((call) => {
      if (mode === 'unauthorized') return { status: 401, json: { error: { message: `Incorrect API key provided: ${F.KEY}` } } };
      if (call.body.max_tokens === 16) return { json: F.chatBody('ok') }; // "Testar conexão"
      if (isPick(call)) {
        const ids = [...lastContent(call).matchAll(/id=(c\d+)/g)].map((x) => x[1]);
        return { json: F.chatBody(JSON.stringify({ picks: ids.map((id, k) => ({ id, relevance: 0.92 - k * 0.1, title: `Momento final ${k + 1}`, category: 'Hype', reasons: ['escolhido na 2ª passada'] })) })) };
      }
      if (mode === 'hang') return { hang: true };
      const m = tr.moments;
      return { json: F.chatBody(F.cutsJson([
        { start: m[0].start + 1, end: m[0].end, punchline: m[0].punch, title: 'O rato que não dropou couro', layout: 'conversa', reasons: ['arco completo', 'reação espontânea'], relevance: 0.9 },
        { start: m[1].start, end: m[1].end, punchline: m[1].punch, title: 'Obrigado, jogo', layout: 'jogo', flags: ['revisar_sensivel'], relevance: 0.8 },
        { start: m[2].start, end: m[2].end, punchline: m[2].punch, title: 'Vinte e um reais', relevance: 0.7 },
        { start: 9000, end: 9040, punchline: 'horário que não existe no vídeo', title: 'Inventado: fora do vídeo', relevance: 0.99 },
        { start: 60, end: 100, punchline: 'frase que ninguém disse na live', title: 'Inventado: desfecho', relevance: 0.97 }
      ])) };
    });

    let app = await h.launchApp(userData);
    let page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await page.eval('BF.state.loadErrors'), []);
    await page.eval(`BF.openSource(${q(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'projeto aberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "!document.getElementById('tabpanel-analysis').hidden", 5000, 'aba Análise visível');
    await waitFor(page, "document.getElementById('anProvider').textContent.length > 0 && !/Carregando/.test(document.getElementById('anProvider').textContent)", 10000, 'estado da IA carregado');

    // ---- seletor de motor: sem provedor o padrão é o algoritmo ----
    assert.equal(await page.eval("document.getElementById('anEngine-algorithm').getAttribute('aria-selected')"), 'true');
    assert.equal(await visible(page, '#anSignals'), true, 'controles do algoritmo à mostra');
    assert.equal(await visible(page, '#anAi'), false, 'bloco da IA escondido');
    assert.match(await text(page, '#anEngineHint'), /escolhido automaticamente/);
    step('sem provedor configurado, o motor padrão é o algoritmo (e a tela diz que foi escolha automática)');

    // ---- IA na nuvem: transcrição ausente, provedor por configurar ----
    await click(page, '#anEngine-ai');
    await waitFor(page, "document.getElementById('anEngine-ai').getAttribute('aria-selected') === 'true'", 5000, 'motor IA');
    assert.equal(await visible(page, '#anAi'), true);
    assert.equal(await visible(page, '#anSignals'), false, 'sinais do algoritmo somem no modo IA');
    assert.equal(await visible(page, '#anAdvanced'), false);
    assert.equal(await text(page, '#anTChip'), 'Ausente');
    assert.match(await text(page, '#anTLine'), /Sem transcrição/);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true, 'sem transcrição e sem provedor não dá para analisar');
    assert.match(await text(page, '#anAiWarn'), /transcrição/);
    assert.equal(await page.eval("document.getElementById('anAiConfig').open"), true, 'sem provedor pronto o cartão de configuração já vem aberto');
    assert.equal(await page.eval("document.getElementById('anCfgProvider').value"), '', 'nenhum provedor vem pré-selecionado');
    assert.equal(await page.eval("document.querySelector('#anCfgProvider option').textContent"), 'Escolha um provedor…');
    assert.equal(await page.eval("document.querySelector('#anCfgProvider option').disabled"), true);
    assert.equal(await page.eval("document.getElementById('anCfgModel').value"), '', 'o modelo também é escolha do usuário');
    assert.equal(await page.eval("['anCfgModel', 'anCfgKey', 'anCfgKeySave', 'anCfgAccept', 'anCfgTest'].every((id) => document.getElementById(id).disabled)"), true, 'sem provedor escolhido não há o que configurar');
    assert.match(await text(page, '#anProvider'), /Escolha o provedor e o modelo de IA\. Nada é enviado antes/);
    assert.match(await text(page, '#anAiWarn'), /Escolha o provedor de IA/);
    assert.equal(await page.eval("document.getElementById('anHints')"), null, 'não existe mais a opção "Dicas de volume"');
    assert.equal(mock.calls.length, 0, 'nada foi enviado antes de o usuário escolher');
    assert.equal(await page.eval("document.getElementById('anCfgKey').type"), 'password', 'a chave vai num campo protegido');
    assert.equal(await page.eval("document.getElementById('anCfgKey').getAttribute('autocomplete')"), 'off');
    assert.match(await text(page, '#anCfgEnc'), /cifrada pelo Windows|sem cifra/);
    step('modo IA: transcrição ausente, Analisar travado com o motivo, configuração aberta e campo de chave protegido');

    // ---- configurar o provedor (Personalizado → servidor local) ----
    await setValue(page, '#anCfgProvider', 'custom', ['change']);
    await waitFor(page, "document.getElementById('anCfgUrl') && !document.getElementById('anCfgUrl').closest('label').hidden", 5000, 'campo de endereço do Personalizado');
    await setValue(page, '#anCfgUrl', mock.base, ['change']);
    await waitFor(page, `document.getElementById('anCfgUrl').value === ${q(mock.base)}`, 5000, 'endereço salvo');
    await setValue(page, '#anCfgModel', 'fake-model', ['change']);
    await waitFor(page, "/fake-model/.test(document.getElementById('anProvider').textContent) || document.getElementById('anCfgModel').value === 'fake-model'", 5000, 'modelo salvo');
    assert.match(await text(page, '#anCfgKeyState'), /Nenhuma chave guardada/);
    // digita a chave e guarda: o campo é limpo na hora e a chave nunca volta
    await page.eval(`(() => { const e = document.getElementById('anCfgKey'); e.value = ${q(F.KEY)}; })()`);
    await click(page, '#anCfgKeySave');
    await waitFor(page, "/Chave guardada neste computador/.test(document.getElementById('anCfgKeyState').textContent)", 10000, 'chave guardada');
    assert.equal(await page.eval("document.getElementById('anCfgKey').value"), '', 'o campo foi limpo');
    await assertNoLeak(page, 'depois de guardar a chave');
    assert.equal(mock.calls.length, 0, 'guardar a chave não fala com o provedor');
    step('provedor Personalizado configurado; a chave foi guardada e o campo limpo; a chave não aparece na tela, no projeto nem no navegador');

    // ---- testar conexão ----
    await click(page, '#anCfgTest');
    await waitFor(page, "/Conexão ok/.test(document.getElementById('anCfgTestOut').textContent)", 15000, 'teste de conexão');
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].headers.authorization, `Bearer ${F.KEY}`);
    assert.ok(mock.calls[0].raw.length < 400, 'o teste manda só um pedido fixo e minúsculo');
    assert.ok(!mock.calls[0].raw.includes('conversa tranquila'), 'nenhum dado do projeto no teste');
    await assertNoLeak(page, 'depois do teste de conexão');
    step('"Testar conexão" fala com o servidor com a chave só no cabeçalho, sem dado do projeto');

    // ---- importar a transcrição ----
    await page.eval(`BF.api('analysis:transcriptImport', { projectId: BF.state.project.id, path: BF.state.project.source.path, size: BF.state.project.source.size, duration: BF.state.project.source.duration, subtitlePath: ${q(srt)} }).then((r) => { window.__imp = r; })`);
    assert.equal(await page.eval('window.__imp.ok'), true, JSON.stringify(await page.eval('window.__imp')));
    await page.eval("BF.ui.selectTab('cuts')");
    await page.eval("BF.ui.selectTab('analysis')");
    await waitFor(page, "document.getElementById('anTChip').textContent === 'Importada'", 10000, 'transcrição importada na tela');
    assert.match(await text(page, '#anTLine'), /Cobre \d+:\d{2} de 12:00 \(\d+%\)/);
    assert.match(await text(page, '#anTSub'), /Importada de live-ia\.srt/);
    assert.match(await text(page, '#anTLine'), /risada/);
    await waitFor(page, "/Estimativa: ~\\d+ chamadas?, ~\\d+ mil tokens/.test(document.getElementById('anEstimate').textContent)", 10000, 'estimativa');
    assert.match(await text(page, '#anEstimate'), /Estimativa: ~2 chamadas, ~\d+ mil tokens\. Nada é enviado antes de você confirmar/);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false, 'com transcrição e provedor o botão libera');
    assert.equal(await page.eval("document.getElementById('anEngine-ai').getAttribute('aria-selected')"), 'true');
    assert.equal(mock.calls.length, 1, 'estimar e importar não enviam nada');
    step('transcrição importada: estado "Importada", cobertura, falas e risadas, estimativa honesta antes de rodar (nada enviado)');

    // ---- aviso de privacidade: recusar não envia nada ----
    const before = mock.calls.length;
    await click(page, '#anRun');
    const shown = await answerModal(page, false);
    assert.equal(shown.title, 'Enviar trechos para a IA?');
    assert.match(shown.message, /transcrição deste vídeo, as mensagens do chat do mesmo período e o título, o canal e o jogo/);
    assert.match(shown.message, /vídeo e o áudio nunca saem do seu computador/);
    assert.match(shown.message, /Quem recebe: Personalizado \(127\.0\.0\.1:\d+\)/);
    assert.match(shown.message, /treinar modelos/);
    assert.match(shown.message, /para este provedor e este endereço até você revogar/);
    assert.match(shown.message, /Não tem prazo\./);
    await sleep(500);
    assert.equal(mock.calls.length, before, 'recusar o aviso não envia nada');
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    assert.equal(await page.eval("document.getElementById('anRun').textContent"), 'Analisar');
    assert.equal(await page.eval('(BF.state.project.ext.analysis && BF.state.project.ext.analysis.suggestions || []).length'), 0);
    assert.equal(await page.eval("document.getElementById('anCfgAccept').checked"), false);
    step('aviso de privacidade mostrado (o que sai, quem recebe, treino); recusar não envia nada');

    // ---- aceitar e analisar ----
    await page.eval("window.__done = 0; BF.on('analysis:done', () => { window.__done += 1; }); BF.on('analysis:failed', () => { window.__done += 1; }); true");
    await click(page, '#anRun');
    await answerModal(page, true);
    await waitFor(page, 'window.__done >= 1', 60000, 'fim da análise por IA');
    await waitFor(page, "!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 10000, 'interface liberada');
    assert.equal(await page.eval("document.getElementById('anCfgAccept').checked"), true, 'aceite lembrado');
    const calls = mock.calls.slice(before);
    assert.equal(calls.length, 2, 'um bloco e a escolha final (duas passadas)');
    assert.ok(calls.every((c) => c.headers.authorization === `Bearer ${F.KEY}`));
    assert.ok(lastContent(calls[0]).includes('=== TRANSCRIÇÃO') && !lastContent(calls[0]).includes('=== CANDIDATOS'));
    assert.ok(!/DICAS|subida de volume|volume/i.test(lastContent(calls[0])) && !/volume/i.test(calls[0].body.messages[0].content), 'nenhuma dica de volume/áudio vai para a IA');
    assert.ok(isPick(calls[1]) && !lastContent(calls[1]).includes('conversa tranquila'), 'a 2ª passada não leva o texto inteiro');
    const list = await page.eval(`[...document.querySelectorAll('#anList .an-item')].map((li) => ({ start: Number(li.dataset.start), end: Number(li.dataset.end), title: (li.querySelector('.an-cut-title') || {}).textContent, chips: [...li.querySelectorAll('.an-reasons li')].map((r) => r.textContent), rel: li.querySelector('.an-rel').textContent }))`);
    assert.equal(list.length, 3, JSON.stringify(list));
    assert.deepEqual(list.map((x) => x.title), ['Momento final 1', 'Momento final 2', 'Momento final 3'], 'ordem e títulos vieram da 2ª passada');
    assert.ok(list.every((x) => x.chips.includes('Hype')), 'categoria como chip');
    assert.ok(list.every((x) => /^\d+%$/.test(x.rel)));
    assert.ok(list.every((x) => x.start >= 0 && x.end <= 720.5));
    const first = tr.moments[0];
    assert.ok(list.some((x) => Math.abs(x.start - first.start) <= 6 && x.end <= first.end + 4), 'um corte cai no primeiro momento');
    assert.match(await text(page, '#anSummary'), /3 sugestão\(ões\) encontrada\(s\) · IA: Personalizado · fake-model · 2 chamadas/);
    assert.match(await text(page, '#anSummary'), /2 descartada\(s\) na conferência local/);
    // conferência local: as invenções ficaram fora e a lista diz por quê
    assert.equal(await visible(page, '#anAiDrops'), true);
    await page.eval("document.getElementById('anAiDrops').open = true");
    const drops = await text(page, '#anAiDrops');
    assert.match(drops, /Inventado: fora do vídeo/);
    assert.match(drops, /Inventado: desfecho/);
    assert.match(drops, /fora do vídeo|não existe na transcrição/);
    assert.ok(!(await text(page, '#anList')).includes('Inventado'), 'nenhuma invenção virou sugestão');
    assert.equal(await page.eval('BF.state.project.cuts.length'), 0, 'analisar não cria corte');
    assert.equal(await page.eval('BF.state.project.ext.analysis.engine'), 'ai');
    assert.equal(await page.eval('BF.state.project.analysis.lastRun.signals.join()'), 'ai');
    await assertNoLeak(page, 'depois da análise');
    step('análise por IA: duas passadas, 3 sugestões ordenadas pela 2ª passada com título/categoria/relevância, 2 invenções descartadas pela conferência local');

    // ---- perfil de humor do canal: cartão recolhido; salvar nas Preferências; vai no pedido da IA e nas listas do algoritmo ----
    assert.equal(await page.eval("document.getElementById('anHConfig').open"), false, 'o cartão do perfil vem recolhido');
    assert.equal(await text(page, '#anHChip'), 'Não definido');
    assert.equal(await visible(page, '#anHSave'), false, 'nada para salvar');
    assert.equal(await visible(page, '#anHClear'), false, 'nada para limpar');
    assert.equal(await page.eval("document.getElementById('anHExamples').checked"), true, 'os exemplos nascem ligados');
    await page.eval("document.getElementById('anHConfig').open = true");
    const humorCriteria = 'Humor seco e inesperado. Não gosto de grito sem graça nem de explicação longa.';
    await setValue(page, '#anHCriteria', humorCriteria, ['input']);
    await setValue(page, '#anHPhrases', 'Beco moleque, dropou couro', ['input']);
    await setValue(page, '#anHReactions', 'eita, tenso', ['input']);
    assert.equal(await visible(page, '#anHSave'), true, 'editar mostra o Salvar');
    assert.match(await text(page, '#anHStatus'), /Alterações ainda não salvas/);
    assert.equal(await page.eval(`(() => { const c = document.getElementById('anHumor'); const p = c.parentElement; return c.scrollWidth <= c.clientWidth + 1 && p.scrollWidth <= p.clientWidth + 1; })()`), true, 'o cartão aberto cabe na largura do painel (sem rolagem lateral)');
    await click(page, '#anHSave');
    await waitFor(page, "document.getElementById('anHChip').textContent === 'Em uso'", 10000, 'perfil salvo');
    assert.equal(await visible(page, '#anHSave'), false, 'depois de salvar não há mais o que salvar');
    assert.equal(await visible(page, '#anHClear'), true);
    assert.equal(await text(page, '#anHLine'), 'critérios · 2 bordões · 2 palavras de reação · salvo para todos os vídeos');
    assert.deepEqual(await page.eval("JSON.parse(JSON.stringify(BF.prefs.get('analysis.humor', null)))"),
      { criteria: humorCriteria, catchphrases: ['Beco moleque', 'dropou couro'], reactions: ['eita', 'tenso'], themes: [], examples: true });
    assert.ok(fs.readFileSync(path.join(userData, 'preferences.json'), 'utf8').includes('"analysis.humor"'), 'gravado nas Preferências, em disco');
    assert.ok(!JSON.stringify(await page.eval('BF.state.project')).includes('Humor seco'), 'o perfil não vai para o projeto');
    // os exemplos que iriam: nenhum projeto antigo do canal com cortes decididos e transcrição, então a caixa diz isso (nada é enviado ao consultar)
    const callsBeforeExamples = mock.calls.length;
    await page.eval("document.getElementById('anHExamplesBox').open = true");
    await waitFor(page, "/Ainda não há cortes aprovados ou rejeitados/.test(document.getElementById('anHExamplesNote').textContent)", 10000, 'caixa dos exemplos');
    assert.equal(mock.calls.length, callsBeforeExamples, 'mostrar os exemplos não envia nada');
    await page.eval("document.getElementById('anHExamplesBox').open = false");
    // a próxima análise leva o perfil nos blocos e o resumo na escolha final
    const beforeProfile = mock.calls.length;
    await page.eval("window.__done = 0; true");
    await click(page, '#anRun');
    await waitFor(page, 'window.__done >= 1', 60000, 'análise por IA com o perfil');
    await waitFor(page, "!document.getElementById('anRun').disabled && document.getElementById('anRun').textContent === 'Analisar'", 10000, 'interface liberada');
    const withProfile = mock.calls.slice(beforeProfile);
    assert.equal(withProfile.length, 2, 'um bloco e a escolha final');
    const profiled = lastContent(withProfile[0]);
    assert.ok(profiled.includes('=== PERFIL DE HUMOR DESTE CANAL') && profiled.includes(humorCriteria), 'o bloco leva os critérios');
    assert.ok(profiled.includes('Bordões e expressões do canal: “Beco moleque”, “dropou couro”') && profiled.includes('Palavras e reações do canal: “eita”, “tenso”'));
    assert.ok(!profiled.includes('APROVOU') && !profiled.includes('REJEITOU'), 'sem projetos antigos do canal não há exemplos');
    assert.ok(profiled.indexOf('=== PERFIL DE HUMOR') < profiled.indexOf('=== TRANSCRIÇÃO'));
    assert.ok(lastContent(withProfile[1]).includes('Perfil de humor do canal') && lastContent(withProfile[1]).includes(humorCriteria), 'a escolha final leva o resumo do perfil');
    assert.ok(!/volume/i.test(profiled), 'nenhuma dica de volume');
    assert.match(await text(page, '#anSummary'), /perfil do canal enviado: critérios · 2 bordões · 2 palavras de reação/);
    assert.ok(!(await text(page, '#anSummary')).includes('Humor seco'), 'o resultado mostra só as contagens, nunca o texto do perfil');
    assert.ok(!JSON.stringify(await page.eval('BF.state.project')).includes('Humor seco'), 'nem o resultado guardado no projeto');
    await assertNoLeak(page, 'depois da análise com o perfil');
    step('perfil de humor: cartão recolhido; salvar grava nas Preferências (limpo) e não no projeto; a caixa dos exemplos não envia nada; a IA recebe critérios e listas nos blocos e o resumo na escolha final');

    if (process.env.BF_E2E_SHOTDIR) {
      fs.mkdirSync(process.env.BF_E2E_SHOTDIR, { recursive: true });
      const shot = (name) => h.screenshot(page, path.join(process.env.BF_E2E_SHOTDIR, name));
      await sleep(8000); // os avisos (toasts) somem sozinhos
      await page.eval("document.querySelectorAll('.toast').forEach((t) => t.remove()); document.getElementById('anHConfig').open = false; document.activeElement.blur(); true");
      for (const theme of ['dark', 'light']) {
        await page.eval(`BF.ui.setTheme(${q(theme)})`);
        await sleep(400);
        await page.eval('document.getElementById("anStep-method").click(); document.getElementById("anAiConfig").open = false; document.getElementById("tabpanel-analysis").scrollTop = 0');
        await sleep(200);
        await shot(`analise-ia-${theme}-1-visao.png`);
        await page.eval('document.getElementById("anStep-results").click(); document.getElementById("anResults").scrollIntoView()');
        await sleep(300);
        await shot(`analise-ia-${theme}-2-resultado.png`);
        await page.eval('document.getElementById("anStep-method").click(); document.getElementById("anAiConfig").open = true; document.getElementById("anAiConfig").scrollIntoView()');
        await sleep(300);
        await shot(`analise-ia-${theme}-3-config.png`);
        await page.eval('document.getElementById("anStep-settings").click(); document.getElementById("anAiConfig").open = false; document.getElementById("anHConfig").open = true; document.getElementById("anHumor").scrollIntoView()');
        await sleep(300);
        await shot(`analise-ia-${theme}-4-perfil.png`);
        await page.eval('document.getElementById("anHStatus").scrollIntoView({ block: "center" })');
        await sleep(300);
        await shot(`analise-ia-${theme}-5-perfil-fim.png`);
        await page.eval('document.getElementById("anHConfig").open = false; document.getElementById("tabpanel-analysis").scrollTop = 0');
      }
      await page.eval("BF.ui.setTheme('dark')");
    }

    // ---- adicionar: pendentes, nunca aprovados; título/categoria/enquadramento/sensível guardados ----
    await page.eval("window.__ev = []; BF.bus.on('decision', (d) => window.__ev.push(d.type)); true");
    await click(page, '#anList .an-item .an-add');
    await waitFor(page, 'BF.state.project.cuts.length === 1', 5000, 'um corte criado');
    await click(page, '#anAddAll');
    await waitFor(page, 'BF.state.project.cuts.length === 3', 5000, 'todos criados');
    const created = await page.eval('JSON.parse(JSON.stringify(BF.state.project.cuts))');
    assert.ok(created.every((c) => c.status === 'pending' && c.origin === 'auto' && typeof c.relevance === 'number' && c.reasons.length > 0), JSON.stringify(created.map((c) => [c.status, c.origin])));
    assert.deepEqual(created.map((c) => c.title).sort(), ['Momento final 1', 'Momento final 2', 'Momento final 3']);
    assert.ok(created.every((c) => c.category === 'Hype'));
    assert.ok(created.some((c) => c.layout === 'jogo' || c.layout === 'conversa'), 'enquadramento sugerido guardado no corte');
    assert.ok(created.some((c) => Array.isArray(c.flags) && c.flags.includes('revisar_sensivel')), 'marca de conteúdo sensível guardada');
    assert.ok(created.some((c) => c.reasons.some((r) => /revisar: conteúdo sensível/.test(r))), 'e visível como motivo');
    assert.equal(await page.eval('BF.state.project.cuts.filter((c) => c.status === "approved").length'), 0, 'nada aprovado automaticamente');
    assert.equal((await page.eval('window.__ev')).filter((t) => t === 'create').length, 3);
    step('"Adicionar" e "Adicionar todas" criam cortes PENDENTES (origem auto) com título, categoria, enquadramento e marca sensível; nada aprovado');

    // ---- cancelar no meio ----
    mode = 'hang';
    await page.eval(`BF.project.update((p) => { p.cuts = []; }, { reason: 'teste' }); BF.bus.emit('cuts:changed', {}); true`);
    const beforeCancel = mock.calls.length;
    await page.eval("window.__done = 0; true");
    await click(page, '#anRun');
    await waitFor(page, `document.getElementById('anProgressText').textContent.length > 0 && !document.getElementById('anCancel').hidden`, 10000, 'progresso da análise');
    for (let i = 0; i < 100 && mock.calls.length === beforeCancel; i += 1) await sleep(50);
    assert.equal(mock.calls.length, beforeCancel + 1, 'o bloco foi enviado e está pendurado');
    assert.match(await text(page, '#anProgressText'), /bloco 1 de 1/);
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), true, 'durante a análise Analisar fica travado');
    assert.equal(await page.eval("document.getElementById('anCfgKey').disabled"), true, 'e a configuração também');
    await click(page, '#anCancel');
    await waitFor(page, "/Análise cancelada/.test(document.getElementById('anNotice').textContent)", 10000, 'cancelamento');
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false);
    await sleep(300);
    assert.equal(mock.calls.length, beforeCancel + 1, 'nada mais foi enviado depois do cancelamento');
    assert.equal(await page.eval('BF.state.project.cuts.length'), 0);
    step('cancelar no meio: a requisição é abortada, nada mais é enviado e o projeto não muda');

    // ---- falha do provedor: mensagem clara e opção de usar o algoritmo ----
    mode = 'unauthorized';
    await click(page, '#anRun');
    await waitFor(page, "!!document.getElementById('anFallback')", 20000, 'falha da IA com a opção do algoritmo');
    const failText = await text(page, '#anFallback');
    assert.match(failText, /recusou a chave/);
    assert.match(failText, /Usar o algoritmo/);
    assert.ok(!failText.includes(F.KEY), 'o eco do servidor foi retirado da mensagem');
    await assertNoLeak(page, 'depois da falha 401');
    await page.eval("window.__done = 0; true");
    await click(page, '#anUseAlgorithm');
    await waitFor(page, "document.getElementById('anEngine-algorithm').getAttribute('aria-selected') === 'true'", 5000, 'motor trocado para o algoritmo');
    await waitFor(page, "BF.state.project.ext.analysis.engine === 'algorithm' && !!BF.state.project.ext.analysis.runAt && /sinais usados/.test(document.getElementById('anSummary').textContent)", 120000, 'algoritmo rodou');
    assert.equal(await page.eval('BF.state.project.ext.analysis.settings.engine'), 'algorithm');
    assert.equal(await visible(page, '#anSignals'), true);
    step('falha do provedor (401): mensagem clara sem a chave, "Usar o algoritmo" troca o motor e analisa');

    // ---- o algoritmo de reserva também usa a transcrição importada (sinal de texto) ----
    assert.equal(await visible(page, '#anTranscript'), true, 'a transcrição aparece nos dois motores');
    assert.equal(await text(page, '#anTChip'), 'Importada');
    assert.equal(await page.eval("document.getElementById('anSignal-text').disabled"), false);
    assert.match(await text(page, '#anSummary'), /sinais usados: .*texto/, 'o texto entrou nos sinais usados');
    const onSaved = await page.eval('JSON.parse(JSON.stringify(BF.state.project.ext.analysis.suggestions))');
    assert.ok(onSaved.length >= 1, 'o algoritmo achou algo na transcrição sintética');
    assert.ok(onSaved.some((s) => s.reasons.includes('risada')), `motivos: ${JSON.stringify(onSaved.map((s) => s.reasons))}`);
    // e o perfil de humor salvo acima: o bordão "dropou couro" foi achado na fala e vira motivo de uma sugestão; o resumo conta quantas
    assert.equal(await page.eval('BF.state.project.ext.analysis.signals.text.humorHits'), 1, 'o bordão foi achado uma vez na transcrição');
    assert.ok(onSaved.some((s) => s.reasons.includes('expressão do canal: “dropou couro”')), `motivos: ${JSON.stringify(onSaved.map((s) => s.reasons))}`);
    assert.match(await text(page, '#anSummary'), /perfil do canal: 1 expressão achada na fala/);
    assert.ok(onSaved.every((s) => s.start >= 0 && s.end <= 720.5 && s.end - s.start >= 15 - 0.05 && s.end - s.start <= 60 + 0.05));
    step('algoritmo de reserva com a transcrição importada: sinal "Texto" usado, motivos legíveis ("risada") e durações das preferências');

    // ---- persistência: reabre o app ----
    await app.stop();
    app = await h.launchApp(userData);
    page = app.page;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 840, deviceScaleFactor: 1, mobile: false });
    await page.eval(`BF.openSource(${q(video)})`);
    await waitFor(page, "!document.getElementById('app').classList.contains('no-project')", 20000, 'projeto reaberto');
    await page.eval("BF.ui.selectTab('analysis')");
    await page.eval("document.getElementById('anEngine-ai').click()");
    await waitFor(page, "document.getElementById('anTChip').textContent === 'Importada'", 10000, 'transcrição lembrada');
    await waitFor(page, "/Chave guardada neste computador/.test(document.getElementById('anCfgKeyState').textContent)", 10000, 'chave lembrada');
    assert.equal(await page.eval("document.getElementById('anCfgAccept').checked"), true, 'aceite lembrado');
    assert.equal(await page.eval("document.getElementById('anCfgKey').value"), '');
    await assertNoLeak(page, 'depois de reiniciar');
    // mudar o endereço do Personalizado = outro destinatário: o aceite é pedido de novo e nada é enviado
    await page.eval("document.getElementById('anAiConfig').open = true");
    const callsBeforeUrl = mock.calls.length;
    await setValue(page, '#anCfgUrl', `${mock.base}/outro`, ['change']);
    const urlModal = await answerModal(page, true);
    assert.match(urlModal.message, /Outro endereço é outro destinatário: o aviso de privacidade precisa ser aceito de novo/);
    await waitFor(page, "document.getElementById('anCfgAccept').checked === false && /outro$/.test(document.getElementById('anCfgUrl').value)", 10000, 'aceite pedido de novo');
    assert.match(await text(page, '#anCfgKeyState'), /Chave guardada neste computador/, 'mesmo servidor: a chave fica');
    assert.equal(mock.calls.length, callsBeforeUrl, 'trocar o endereço não envia nada');
    // voltar ao endereço de antes NÃO traz o aceite de volta; aceitar de novo é decisão do usuário
    await setValue(page, '#anCfgUrl', mock.base, ['change']);
    await answerModal(page, true);
    await waitFor(page, `document.getElementById('anCfgUrl').value === ${q(mock.base)} && document.getElementById('anCfgAccept').checked === false`, 10000, 'endereço original, sem aceite');
    await click(page, '#anCfgAccept');
    const again = await answerModal(page, true);
    assert.match(again.message, /Não tem prazo/);
    await waitFor(page, "document.getElementById('anCfgAccept').checked === true", 5000, 'aceite dado de novo');
    step('aceite sem prazo; trocar o endereço do Personalizado (mesmo servidor ou outro) o pede de novo, nada é enviado e a chave só some se o servidor mudar');
    // revogar o aceite: a próxima análise pergunta de novo
    await click(page, '#anCfgAccept');
    await waitFor(page, "document.getElementById('anCfgAccept').checked === false", 5000, 'aceite revogado');
    // remover a chave
    await click(page, '#anCfgKeyClear');
    await answerModal(page, true);
    await waitFor(page, "/Nenhuma chave guardada/.test(document.getElementById('anCfgKeyState').textContent)", 10000, 'chave removida');
    assert.equal(await page.eval("document.getElementById('anRun').disabled"), false, 'o provedor Personalizado não exige chave: continua liberado');
    h.assertNoConsoleErrors(page);
    await app.stop();
    step('persistência: provedor, chave guardada, aceite e transcrição sobrevivem ao reinício; revogar o aceite e remover a chave funcionam; zero erros no console');

    // ---- a chave nunca ficou em arquivo ----
    const hits = scanFiles(userData, F.KEY);
    assert.deepEqual(hits, [], `a chave apareceu em arquivo(s): ${hits.join(', ')}`);
    const secrets = path.join(userData, 'ai', 'secrets.json');
    step(`a chave não está em nenhum arquivo do perfil (${fs.existsSync(secrets) ? 'secrets.json existe, mas cifrado' : 'secrets.json vazio/ausente'})`);

    // ---- provedor de verdade (opcional) ----
    if (process.env.BF_AI_TEST_KEY && process.env.BF_AI_TEST_URL && process.env.BF_AI_TEST_MODEL) {
      step('BF_AI_TEST_* definidas: rede real é verificada por tests/ai-real-network.test.js (não por este e2e)');
    } else {
      console.log('! rede real com provedor de verdade NÃO verificada aqui (sem BF_AI_TEST_KEY/BF_AI_TEST_URL/BF_AI_TEST_MODEL)');
    }
    console.log('\nanalysis-ia.e2e: tudo certo');
  } finally {
    await h.cleanupAll();
    if (mock) await mock.close();
    h.removeDir(tmp);
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
