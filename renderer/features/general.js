'use strict';

/**
 * Tela "Geral" (aba `general`; a primeira de Configurações, tela larga, funciona sem vídeo aberto): o que vale para o app todo, só com o que o app tem.
 *   - Aparência: Escuro ou Claro (BF.ui.setTheme, o mesmo botão do rodapé do menu; guarda a escolha). Dentro do Braga Digital Studio o tema é dele
 *     (`.theme-locked`): as opções ficam desabilitadas e o texto diz por quê.
 *   - Pasta de projetos: onde o app guarda os projetos (a do perfil do app; não dá para trocar) e "Mostrar na pasta".
 *   - Sobre: nome, versão e a frase do app (app:info) e quem desenvolveu.
 * Preferências (análise, revisão, exportação) e Ferramentas são as outras abas de Configurações.
 */
(function () {
  const BF = window.BF;
  const { el } = BF.util;

  const THEMES = [['dark', 'Escuro'], ['light', 'Claro']];
  const box = {};

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
    box.name = el('strong', { class: 'gen-about-name' });
    box.version = el('span', { class: 'gen-about-version muted' });
    box.tagline = el('p', { class: 'gen-about-tagline muted' });
    return el('div', { class: 'gen' },
      el('p', { class: 'muted gen-lead' }, 'O que vale para o app todo. A análise, a revisão e a exportação têm as suas escolhas em Preferências, e os programas de apoio ficam em Ferramentas.'),
      el('div', { class: 'gen-grid' },
        el('div', { class: 'gen-main' },
          el('section', { class: 'card gen-card', dataset: { section: 'appearance' } }, el('h3', {}, 'Aparência'), box.themes, box.themeNote),
          box.folder),
        el('aside', { class: 'card gen-card gen-about', dataset: { section: 'about' }, 'aria-label': 'Sobre' },
          el('h3', {}, 'Sobre'),
          el('span', { class: 'gen-mark', 'aria-hidden': 'true' }, 'BF'),
          box.name, box.version, box.tagline,
          el('p', { class: 'muted small gen-credit' }, 'Desenvolvido por ', el('strong', {}, 'Braga Dev')))));
  }

  async function reveal() {
    const dir = appInfo().projectsDir;
    if (dir) await BF.api('shell:reveal', { path: dir }, { toast: true });
  }

  function draw() {
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
})();
