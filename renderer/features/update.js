'use strict';

/**
 * Aviso de versão nova no renderer (dono: base; docs/atualizacao.md). SÓ AVISA: nunca baixa nem instala; "Ver e baixar" abre a página da Release no
 * navegador e o usuário instala por cima (os projetos continuam).
 *  - Alguns segundos depois de abrir, consulta o main (app:updateCheck) se o usuário não desligou o aviso;
 *  - se há versão mais nova e o usuário ainda não disse "Agora não" para ELA, mostra a faixa #updateNote (a próxima versão volta a avisar);
 *  - a tela Geral (cartão Atualizações) usa BF.update: liga e desliga o aviso, "Verificar agora" e o texto do resultado.
 * A escolha de ligar/desligar fica no armazenamento local do app (BF.local), como o tema: vale para o app todo, não por jogo nem por canal.
 * Dentro de outro aplicativo (BDS) nada disso acontece: o hospedeiro é quem atualiza.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const STARTUP_DELAY_MS = 4000;
  const state = { result: null, checking: false };

  const enabled = () => BF.local.get('updateCheck', '1') !== '0';
  const dismissedVersion = () => BF.local.get('updateDismissed', '');
  const changed = () => BF.bus.emit('update:changed', state);

  /** O resultado em palavras para a tela: { text, kind: 'ok' | 'info' | 'warn' | '', canOpen }. */
  function describe(result) {
    if (!result) return { text: '', kind: '', canOpen: false };
    switch (result.status) {
      case 'available': return { text: `Nova versão ${result.latest.version} disponível (você usa a ${result.current}).`, kind: 'info', canOpen: true };
      case 'current': return { text: `Você está na versão mais recente (${result.current}).`, kind: 'ok', canOpen: false };
      case 'none': return { text: 'O projeto ainda não publicou nenhuma versão para comparar.', kind: '', canOpen: false };
      case 'error': return { text: result.message || 'Não consegui verificar agora.', kind: 'warn', canOpen: false };
      default: return { text: '', kind: '', canOpen: false };
    }
  }

  /** A faixa do topo: só com o aviso ligado e uma versão nova que o usuário ainda não dispensou. */
  function render() {
    const box = document.getElementById('updateNote');
    if (!box) return;
    const r = state.result;
    const show = enabled() && r && r.status === 'available' && dismissedVersion() !== r.latest.version;
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    box.replaceChildren(
      el('span', {}, `Nova versão ${r.latest.version} do Braga Frame disponível (você usa a ${r.current}). Instale por cima: seus projetos continuam como estão.`),
      el('button', { type: 'button', class: 'primary sm', dataset: { act: 'update-open' }, onclick: open }, 'Ver e baixar'),
      el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'update-dismiss' }, onclick: dismiss }, 'Agora não')
    );
  }

  /** Consulta o main. `force` = o botão "Verificar agora" (sem ele, o main reaproveita uma consulta recente). Nunca lança. */
  async function check({ force = false } = {}) {
    if (state.checking) return state.result;
    state.checking = true;
    changed();
    let res;
    try { res = await BF.api('app:updateCheck', { force }); } catch (err) { res = { ok: false, message: String(err && err.message) }; }
    state.checking = false;
    state.result = res.ok === false ? { status: 'error', reason: 'ipc', message: res.message, current: (BF.state.app && BF.state.app.version) || '' } : res;
    render();
    changed();
    return state.result;
  }

  async function open() {
    await BF.api('app:updateOpen', {}, { toast: true });
  }

  /** "Agora não": esta versão não avisa de novo (a próxima, sim). */
  function dismiss() {
    const r = state.result;
    if (r && r.latest) BF.local.set('updateDismissed', r.latest.version);
    render();
    changed();
  }

  function setEnabled(on) {
    BF.local.set('updateCheck', on ? '1' : '0');
    render();
    changed();
    if (on && !state.result) check();
  }

  BF.update = { state, enabled, setEnabled, check, open, dismiss, describe };

  // Ao abrir, sem pesar na abertura. Dentro de outro aplicativo o main responde "disabled" e a faixa nunca aparece.
  if (!BF.embedded) {
    Promise.resolve(BF.ready).then(() => { setTimeout(() => { if (enabled()) check(); }, STARTUP_DELAY_MS); });
  }
})();
