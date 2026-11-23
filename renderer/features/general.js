'use strict';

/**
 * Tela "Geral" (aba `general`; a primeira de Configurações, tela larga, funciona sem vídeo aberto): o que vale para o app todo, só com o que o app tem.
 *   - Aparência: Escuro ou Claro (BF.ui.setTheme, o mesmo botão do rodapé do menu; guarda a escolha). Dentro do Braga Digital Studio o tema é dele
 *     (`.theme-locked`): as opções ficam desabilitadas e o texto diz por quê.
 *   - Pasta de projetos: onde o app guarda os projetos (a do perfil do app; não dá para trocar) e "Mostrar na pasta".
 *   - Atualizações: avisa de versão nova (liga/desliga, "Verificar agora"; só avisa, não instala; features/update.js).
 *   - Agentes de IA (MCP): liga o servidor local que deixa um agente de IA externo ler os projetos e ajudar nos cortes (features/mcp.js).
 *   - Suporte: copia as informações do computador para mandar ao suporte (app:support) e mostra o arquivo de registro.
 *   - Sobre: nome, versão e a frase do app (app:info) e quem desenvolveu.
 * Preferências (análise, revisão, exportação) e Ferramentas são as outras abas de Configurações.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const THEMES = [['dark', 'Escuro'], ['light', 'Claro']];
  const box = {};
  const state = { logFile: null };

  const icon = (name) => el('span', { class: 'material-symbols-rounded', 'aria-hidden': 'true' }, name);
  const appInfo = () => BF.state.app || {};
  const locked = () => Boolean(document.getElementById('app') && document.getElementById('app').classList.contains('theme-locked'));

  /** Miniatura de uma janela do app no tema (o atributo data-theme dá os tokens daquele tema ao próprio elemento). */
  const swatch = (theme) => el('span', { class: 'gen-swatch', 'aria-hidden': 'true', dataset: { theme } },
    el('span', { class: 'gen-sw-side' }), el('span', { class: 'gen-sw-body' }, el('span', { class: 'gen-sw-line wide' }), el('span', { class: 'gen-sw-line' }), el('span', { class: 'gen-sw-dot' })));

  function build() {
    box.themes = el('div', { class: 'gen-themes', role: 'radiogroup', 'aria-label': 'Aparência' }, THEMES.map(([id, label]) => el('button', {
      type: 'button', class: 'gen-theme', role: 'radio', 'aria-checked': 'false', dataset: { theme: id }, onclick: () => BF.ui.setTheme(id)
    }, swatch(id), el('span', { class: 'gen-theme-name' }, label))));
    box.themeNote = el('p', { class: 'muted small gen-note', hidden: true }, 'Aqui o tema é o do Braga Digital Studio, onde o Braga Frame está aberto.');
    box.path = el('input', { type: 'text', class: 'gen-path', readOnly: true, 'aria-label': 'Pasta de projetos', value: '' });
    box.reveal = el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'reveal' }, onclick: reveal }, icon('folder_open'), 'Mostrar na pasta');
    box.folder = el('section', { class: 'card gen-card', dataset: { section: 'folder' } },
      el('h3', {}, 'Pasta de projetos'),
      el('div', { class: 'gen-folder' }, box.path, box.reveal),
      el('p', { class: 'muted small gen-note' }, 'Cada vídeo que você abre vira um projeto guardado aqui, e o app salva sozinho a cada mudança. Os vídeos e os cortes exportados ficam onde estão: aqui ficam só os dados do projeto.'));
    // Atualizações (BF.update, features/update.js): avisa, baixa em segundo plano e confere; instalar é SEMPRE escolha do usuário. Dentro de outro
    // aplicativo (BDS) o cartão nem existe. Os botões são todos secundários: a tela de ajustes não tem ação principal solta.
    const act = (name, label, iconName, onclick) => el('button', { type: 'button', class: 'secondary sm', dataset: { act: name }, hidden: true, onclick }, icon(iconName), label);
    box.updSwitch = el('input', { type: 'checkbox', id: 'genUpdateSwitch', class: 'bds-switch', role: 'switch', onchange: () => BF.update.setEnabled(box.updSwitch.checked) });
    box.updAutoSwitch = el('input', { type: 'checkbox', id: 'genUpdateAutoSwitch', class: 'bds-switch', role: 'switch', onchange: () => BF.update.setAutoDownload(box.updAutoSwitch.checked) });
    box.updCheck = el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'check-update' }, onclick: () => BF.update.check({ force: true }) }, icon('refresh'), 'Verificar agora');
    box.updDownload = act('download-update', 'Baixar a atualização', 'download', () => BF.update.download());
    box.updInstall = act('install-update', 'Instalar e reiniciar', 'system_update_alt', () => BF.update.install('now'));
    box.updInstallQuit = act('install-update-quit', 'Instalar quando eu fechar', 'schedule', () => BF.update.install(BF.update.state.installOnQuit ? 'none' : 'quit'));
    box.updCancel = act('cancel-update', 'Cancelar o download', 'close', () => BF.update.cancel());
    box.updOpen = act('open-update', 'Ver novidades', 'open_in_new', () => BF.update.open());
    box.updStatus = el('p', { class: 'gen-update-status small', role: 'status' });
    box.updSub = el('p', { class: 'gen-update-sub muted small', hidden: true });
    box.updates = BF.update && !BF.embedded
      ? el('section', { class: 'card gen-card', dataset: { section: 'updates' } },
        el('h3', {}, 'Atualizações'),
        el('p', { class: 'muted small gen-note' }, 'O Braga Frame pode avisar quando sai uma versão nova e baixá-la em segundo plano. Para isso ele consulta a página de versões do projeto no GitHub ao abrir e envia só o nome e a versão do app, nada seu. O arquivo baixado é conferido (tamanho, SHA-256 da Release e, quando houver, a assinatura digital) e nada é instalado sem você escolher: instalar e reiniciar agora, ou quando você fechar o app. Seus projetos continuam como estão.'),
        el('label', { class: 'gen-switch-row', for: 'genUpdateSwitch' }, box.updSwitch, el('span', {}, 'Avisar quando houver versão nova')),
        el('label', { class: 'gen-switch-row', for: 'genUpdateAutoSwitch' }, box.updAutoSwitch, el('span', {}, 'Baixar a atualização sozinho (você escolhe quando instalar)')),
        el('div', { class: 'gen-actions' }, box.updCheck, box.updDownload, box.updInstall, box.updInstallQuit, box.updCancel, box.updOpen),
        box.updStatus, box.updSub)
      : null;
    box.mcp = BF.mcp && !BF.embedded ? BF.mcp.card() : null; // Agentes de IA (MCP): features/mcp.js
    box.copy = el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'copy-support' }, onclick: copySupport }, icon('content_copy'), 'Copiar informações');
    box.log = el('button', { type: 'button', class: 'secondary sm', dataset: { act: 'show-log' }, onclick: showLog }, icon('folder_open'), 'Mostrar o registro');
    box.report = el('textarea', { class: 'gen-report', readOnly: true, rows: 9, hidden: true, 'aria-label': 'Informações para o suporte', spellcheck: 'false' });
    box.support = el('section', { class: 'card gen-card', dataset: { section: 'support' } },
      el('h3', {}, 'Suporte'),
      el('p', { class: 'muted small gen-note' }, 'Se algo não funcionar, copie as informações do seu computador (versão, sistema, placa de vídeo, programas de apoio) e envie junto com a descrição do problema. Elas não incluem seus vídeos, seus projetos nem suas chaves, e o seu nome de usuário do Windows sai como "~".'),
      el('div', { class: 'gen-actions' }, box.copy, box.log),
      box.report);
    box.name = el('strong', { class: 'gen-about-name' });
    box.version = el('span', { class: 'gen-about-version muted' });
    box.tagline = el('p', { class: 'gen-about-tagline muted' });
    return el('div', { class: 'gen' },
      el('p', { class: 'muted gen-lead' }, 'O que vale para o app todo. A análise, a revisão e a exportação têm as suas escolhas em Preferências, e os programas de apoio ficam em Ferramentas.'),
      el('div', { class: 'gen-grid' },
        el('div', { class: 'gen-main' },
          el('section', { class: 'card gen-card', dataset: { section: 'appearance' } }, el('h3', {}, 'Aparência'), box.themes, box.themeNote),
          box.folder,
          box.updates,
          box.mcp,
          box.support),
        el('aside', { class: 'card gen-card gen-about', dataset: { section: 'about' }, 'aria-label': 'Sobre' },
          el('h3', {}, 'Sobre'),
          el('span', { class: 'gen-mark', 'aria-hidden': 'true' }, 'BF'),
          box.name, box.version, box.tagline,
          el('p', { class: 'muted small gen-license' }, 'Software livre: licença GPL v3 ou posterior, sem garantia. O texto da licença acompanha o instalador.'),
          el('p', { class: 'muted small gen-credit' }, 'Desenvolvido por ', el('strong', {}, 'Braga Dev')))));
  }

  async function reveal() {
    const dir = appInfo().projectsDir;
    if (dir) await BF.api('shell:reveal', { path: dir }, { toast: true });
  }

  /** Pede o relatório ao app e o põe na área de transferência; se o sistema recusar, mostra o texto selecionado para o usuário copiar à mão. */
  async function copySupport() {
    box.copy.disabled = true;
    try {
      const res = await BF.api('app:support', {}, { toast: true });
      if (res.ok === false) return;
      state.logFile = res.logFile || null;
      box.log.disabled = !state.logFile;
      try {
        await navigator.clipboard.writeText(res.text);
        box.report.hidden = true;
        BF.ui.toast('Informações copiadas. Cole na mensagem de suporte.', 'ok');
      } catch {
        box.report.value = res.text;
        box.report.hidden = false;
        box.report.focus();
        box.report.select();
        BF.ui.toast('Não consegui copiar sozinho: o texto está selecionado, use Ctrl+C.', 'warn');
      }
    } finally {
      box.copy.disabled = false;
    }
  }

  /** Mostra o arquivo de registro do app no Explorer (o caminho vem do último relatório; sem ele, pede o relatório antes). */
  async function showLog() {
    if (!state.logFile) {
      const res = await BF.api('app:support', {}, { toast: true });
      if (res.ok === false) return;
      state.logFile = res.logFile || null;
    }
    if (!state.logFile) { BF.ui.toast('Ainda não há registro para mostrar.', 'warn'); return; }
    await BF.api('shell:reveal', { path: state.logFile }, { toast: true });
  }

  /** O cartão Atualizações: os dois interruptores, o estado em palavras (e a assinatura do arquivo baixado) e só os botões que fazem sentido agora. */
  function drawUpdates() {
    if (!box.updates || !BF.update) return;
    const u = BF.update;
    const v = u.view();
    box.updSwitch.checked = u.enabled();
    box.updAutoSwitch.checked = u.autoDownload();
    box.updAutoSwitch.disabled = !u.enabled();
    box.updCheck.disabled = v.busy;
    box.updStatus.textContent = v.text;
    box.updStatus.dataset.kind = v.busy && v.kind !== 'info' ? '' : v.kind;
    box.updSub.textContent = v.sub;
    box.updSub.hidden = !v.sub;
    box.updDownload.hidden = !v.show.download || v.busy;
    box.updInstall.hidden = !v.show.install;
    box.updInstallQuit.hidden = !v.show.install;
    box.updInstallQuit.replaceChildren(icon('schedule'), u.state.installOnQuit ? 'Não instalar ao fechar' : 'Instalar quando eu fechar');
    box.updCancel.hidden = !v.show.cancel;
    box.updOpen.hidden = !v.show.open || v.busy;
  }

  function draw() {
    drawUpdates();
    if (!box.themes) return;
    const theme = BF.ui.theme ? BF.ui.theme() : 'dark';
    const frozen = locked();
    for (const button of box.themes.children) {
      const on = button.dataset.theme === theme;
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('on', on);
      button.disabled = frozen;
    }
    box.themeNote.hidden = !frozen;
    const info = appInfo();
    box.folder.hidden = !info.projectsDir;
    box.path.value = info.projectsDir || '';
    box.path.title = info.projectsDir || '';
    box.name.textContent = info.name || 'Braga Frame';
    box.version.textContent = info.version ? `Versão ${info.version}` : '';
    box.version.hidden = !info.version;
    box.tagline.textContent = info.tagline || '';
    box.tagline.hidden = !info.tagline;
  }

  BF.ui.registerTab({
    id: 'general',
    title: 'Geral',
    order: 75, // a primeira aba de Configurações (o layout do menu a põe antes de Preferências, que é a 80)
    render(container) {
      container.append(build());
      draw();
      if (BF.ready && typeof BF.ready.then === 'function') BF.ready.then(draw);
    },
    onShow: draw
  });
  BF.bus.on('theme:changed', draw);
  BF.bus.on('update:changed', drawUpdates);
})();
