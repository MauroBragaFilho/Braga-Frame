'use strict';

/**
 * Atualização no renderer (dono: base; docs/atualizacao.md). O processo principal (UpdateManager) consulta a última Release, baixa o instalador em segundo
 * plano e CONFERE (tamanho, SHA-256 da Release e assinatura digital); aqui só se mostra o estado (evento update:state) e se pede o que o usuário escolhe.
 * NADA é instalado sem a escolha dele: "Instalar e reiniciar" (agora) ou "Instalar quando eu fechar".
 *  - Alguns segundos depois de abrir, consulta (app:updateCheck) se o usuário não desligou o aviso; achando versão nova e com "baixar sozinho" ligado,
 *    baixa em segundo plano. Uma atualização já baixada numa execução anterior volta pronta ao abrir (app:updateState).
 *  - A faixa #updateNote acompanha o estado: nova versão → baixando → pronta → instalando. "Agora não" cala a faixa daquela versão (a próxima avisa).
 *  - A tela Geral (cartão Atualizações) usa BF.update: os dois interruptores, "Verificar agora" e os botões do momento.
 * As escolhas (avisar, baixar sozinho) ficam no armazenamento local do app (BF.local), como o tema. Dentro de outro aplicativo (BDS) nada disto existe.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const STARTUP_DELAY_MS = 4000;
  /** `result` e `checking` seguem existindo para o cartão da Geral; o resto espelha o snapshot do main. */
  const state = { snap: null, result: null, checking: false, phase: 'idle', download: null, ready: null, error: null, installOnQuit: false };

  const enabled = () => BF.local.get('updateCheck', '1') !== '0';
  const autoDownload = () => BF.local.get('updateAutoDownload', '1') !== '0';
  const dismissedVersion = () => BF.local.get('updateDismissed', '');
  const changed = () => BF.bus.emit('update:changed', state);

  const latestVersion = () => (state.result && state.result.latest ? state.result.latest.version : (state.ready ? state.ready.version : ''));
  const currentVersion = () => (state.result && state.result.current) || (BF.state.app && BF.state.app.version) || '';

  /** O resultado da CONSULTA em palavras: { text, kind: 'ok' | 'info' | 'warn' | '', canOpen }. */
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

  /**
   * O que a tela mostra AGORA (cartão da Geral): { text, sub, kind, show: { download, install, open, cancel }, busy }.
   * `sub` é a segunda linha (a assinatura do arquivo baixado, ou o que acontece ao fechar).
   */
  function view() {
    const base = { text: '', sub: '', kind: '', show: { download: false, install: false, open: false, cancel: false }, busy: false };
    const v = latestVersion();
    if (state.phase === 'checking' || state.checking) return { ...base, text: 'Verificando…', busy: true };
    if (state.phase === 'downloading') {
      const pct = state.download ? Math.floor(state.download.percent) : 0;
      return { ...base, text: `Baixando a versão ${v}… ${pct}%`, kind: 'info', busy: true, show: { ...base.show, cancel: true } };
    }
    if (state.phase === 'installing') return { ...base, text: `Instalando a versão ${state.ready ? state.ready.version : v}… o Braga Frame vai reiniciar.`, kind: 'info', busy: true };
    if (state.phase === 'ready' && state.ready) {
      const sub = [state.ready.signature && state.ready.signature.text, state.installOnQuit ? 'Será instalada quando você fechar o Braga Frame.' : ''].filter(Boolean).join(' ');
      return { ...base, text: `A versão ${state.ready.version} está pronta e verificada (tamanho e SHA-256 conferidos).`, sub, kind: 'info', show: { ...base.show, install: true, open: true } };
    }
    if (state.error) return { ...base, text: state.error.message, kind: 'warn', show: { ...base.show, download: Boolean(state.result && state.result.status === 'available' && state.result.latest.asset), open: Boolean(state.result && state.result.status === 'available') } };
    const d = describe(state.result);
    const available = Boolean(state.result && state.result.status === 'available');
    return { ...base, text: d.text, kind: d.kind, show: { ...base.show, download: available && Boolean(state.result.latest.asset), open: available } };
  }

  /** A faixa do topo: só com o aviso ligado; "Agora não" a cala para ESTA versão. */
  function render() {
    const box = document.getElementById('updateNote');
    if (!box) return;
    const v = latestVersion();
    const hiddenByUser = dismissedVersion() === v && state.phase !== 'installing';
    const available = Boolean(state.result && state.result.status === 'available');
    const show = enabled() && !hiddenByUser && (['downloading', 'ready', 'installing'].includes(state.phase) || (state.phase === 'idle' && available && !state.error));
    box.hidden = !show;
    if (!show) { box.replaceChildren(); return; }
    const btn = (label, act, onclick, primary = false) => el('button', { type: 'button', class: `${primary ? 'primary' : 'secondary'} sm`, dataset: { act }, onclick }, label);
    let text;
    let buttons = [];
    if (state.phase === 'downloading') {
      text = `Baixando a versão ${v}… ${state.download ? Math.floor(state.download.percent) : 0}%`;
      buttons = [btn('Cancelar', 'update-cancel', cancel)];
    } else if (state.phase === 'installing') {
      text = `Instalando a versão ${state.ready ? state.ready.version : v}… o Braga Frame vai reiniciar.`;
    } else if (state.phase === 'ready') {
      text = state.installOnQuit
        ? `A versão ${state.ready.version} será instalada quando você fechar o Braga Frame.`
        : `Versão ${state.ready.version} pronta para instalar (seus projetos continuam como estão).`;
      buttons = state.installOnQuit
        ? [btn('Instalar e reiniciar agora', 'update-install-now', () => install('now'), true), btn('Não instalar ao fechar', 'update-install-none', () => install('none'))]
        : [btn('Instalar e reiniciar', 'update-install-now', () => install('now'), true), btn('Instalar quando eu fechar', 'update-install-quit', () => install('quit')), btn('Agora não', 'update-dismiss', dismiss)];
    } else {
      const canDownload = Boolean(state.result.latest.asset);
      text = `Nova versão ${state.result.latest.version} do Braga Frame disponível (você usa a ${state.result.current}). ${canDownload ? 'Seus projetos continuam como estão.' : 'Instale por cima: seus projetos continuam como estão.'}`;
      buttons = canDownload
        ? [btn('Baixar a atualização', 'update-download', download, true), btn('Ver novidades', 'update-open', open), btn('Agora não', 'update-dismiss', dismiss)]
        : [btn('Ver e baixar', 'update-open', open, true), btn('Agora não', 'update-dismiss', dismiss)];
    }
    box.replaceChildren(el('span', {}, text), ...buttons);
  }

  /** Aplica o snapshot que o main mandou (evento update:state ou app:updateState). */
  function apply(snap) {
    if (!snap || typeof snap !== 'object') return;
    state.snap = snap;
    state.phase = snap.phase || 'idle';
    state.result = snap.check || null;
    state.checking = state.phase === 'checking';
    state.download = snap.download || null;
    state.ready = snap.ready || null;
    state.error = snap.error || null;
    state.installOnQuit = Boolean(snap.installOnQuit);
    render();
    changed();
  }

  /** Consulta o main. `force` = o botão "Verificar agora". Achando versão nova com "baixar sozinho" ligado, já começa a baixar. Nunca lança. */
  async function check({ force = false } = {}) {
    if (state.phase === 'checking') return state.result;
    let res;
    try { res = await BF.api('app:updateCheck', { force }); } catch (err) { res = { ok: false, message: String(err && err.message) }; }
    if (res.ok === false) {
      state.result = { status: 'error', reason: 'ipc', message: res.message, current: currentVersion() };
      render();
      changed();
      return state.result;
    }
    state.result = res;
    state.checking = false;
    if (state.phase === 'checking') state.phase = 'idle'; // o evento "idle" do main pode chegar depois da resposta: não depende da ordem
    render();
    changed();
    if (res.status === 'available' && res.latest && res.latest.asset && enabled() && autoDownload() && state.phase === 'idle' && !state.ready) download();
    return res;
  }

  async function download() { await BF.api('app:updateDownload', {}, { toast: true }); }
  async function cancel() { await BF.api('app:updateCancel', {}, { toast: true }); }
  /** @param {'now'|'quit'|'none'} when */
  async function install(when) { return BF.api('app:updateInstall', { when }, { toast: true }); }
  async function open() { await BF.api('app:updateOpen', {}, { toast: true }); }

  /** "Agora não": esta versão não avisa de novo (a próxima, sim). */
  function dismiss() {
    const v = latestVersion();
    if (v) BF.local.set('updateDismissed', v);
    render();
    changed();
  }

  function setEnabled(on) {
    BF.local.set('updateCheck', on ? '1' : '0');
    render();
    changed();
    if (on && !state.result) check();
  }

  function setAutoDownload(on) {
    BF.local.set('updateAutoDownload', on ? '1' : '0');
    changed();
    if (on && enabled() && state.result && state.result.status === 'available' && state.result.latest.asset && state.phase === 'idle' && !state.ready) download();
  }

  BF.update = { state, enabled, autoDownload, setEnabled, setAutoDownload, check, download, cancel, install, open, dismiss, describe, view, apply };

  // Os eventos do main e, ao abrir, o que já estava baixado de uma execução anterior. Dentro de outro aplicativo (BDS) nada disto existe.
  if (!BF.embedded) {
    BF.on('update:state', apply);
    Promise.resolve(BF.ready).then(async () => {
      try { const snap = await BF.api('app:updateState'); if (snap && snap.ok !== false) apply(snap); } catch { /* sem estado: segue sem */ }
      setTimeout(() => { if (enabled()) check(); }, STARTUP_DELAY_MS);
    });
  }
})();
