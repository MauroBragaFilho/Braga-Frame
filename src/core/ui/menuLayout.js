'use strict';

/**
 * O menu lateral: poucos itens, cada um abrigando uma ou mais telas (as "abas" que as features registram com BF.ui.registerTab).
 *
 *   Início · Projetos · Cortes · Exportações · Configurações
 *
 *   - Cortes abriga Análise, Cortes, Legendas, Áudio e Exportar (primeiro se analisa, depois se corta): tudo o que trabalha sobre o vídeo aberto, ao lado do player, vira aba interna.
 *   - Configurações abriga Geral, Preferências e Ferramentas.
 *   - Projetos tem uma tela sem aba própria, Novo projeto (`hidden`): ela abre por botões (Início, Projetos) e acende o item Projetos.
 *   - Uma tela que este layout não conhece (um recurso novo) ganha um item próprio, na posição do seu `order`: registrar uma aba continua
 *     bastando para ela aparecer no menu.
 *
 * Este arquivo é "universal", como o timecode.js: funciona como módulo CommonJS (testado no Node) e, carregado por <script>, expõe `window.BFMenu`.
 */
(function () {
  /**
   * De cima para baixo. `tabs`: as telas do item, na ordem das abas internas (a primeira é a que o item abre). `hidden`: telas do item que não têm
   * aba interna nem botão no menu. `order` é a posição do item entre os demais (e entre itens de recursos novos).
   */
  const LAYOUT = Object.freeze([
    { id: 'home', title: 'Início', icon: 'home', order: 1, tabs: ['home'], hidden: [] },
    { id: 'projects', title: 'Projetos', icon: 'folder_special', order: 5, tabs: ['projects'], hidden: ['sources'] },
    { id: 'editor', title: 'Cortes', icon: 'content_cut', order: 10, tabs: ['analysis', 'cuts', 'subtitles', 'audio', 'export'], hidden: [] },
    { id: 'queue', title: 'Exportações', icon: 'queue', order: 30, tabs: ['queue'], hidden: [] },
    { id: 'settings', title: 'Configurações', icon: 'settings', order: 80, tabs: ['general', 'prefs', 'tools'], hidden: [] }
  ].map((item) => Object.freeze(item)));

  /**
   * Os itens do menu para as telas registradas: `registered` = [{ id, title?, order?, icon? }]. Devolve, em ordem,
   * `{ id, title, icon, order, tabs, hidden, kind, defaultTab }` onde `tabs`/`hidden` só têm telas registradas e `kind` é 'group' (várias telas,
   * com abas internas) ou 'single'. Item sem nenhuma tela registrada não aparece.
   */
  function plan(registered) {
    const known = new Map();
    for (const tab of Array.isArray(registered) ? registered : []) if (tab && typeof tab.id === 'string') known.set(tab.id, tab);
    const claimed = new Set();
    const items = [];
    for (const spec of LAYOUT) {
      for (const id of [...spec.tabs, ...spec.hidden]) claimed.add(id);
      let tabs = spec.tabs.filter((id) => known.has(id));
      let hidden = spec.hidden.filter((id) => known.has(id));
      if (!tabs.length && hidden.length) { tabs = hidden; hidden = []; } // só a tela sem aba própria existe: ela passa a ser a do item
      if (!tabs.length) continue;
      items.push({ id: spec.id, title: spec.title, icon: spec.icon, order: spec.order, tabs, hidden, kind: tabs.length > 1 ? 'group' : 'single', defaultTab: tabs[0] });
    }
    for (const tab of known.values()) {
      if (claimed.has(tab.id)) continue;
      items.push({
        id: tab.id, title: tab.title || tab.id, icon: tab.icon || 'circle', order: Number.isFinite(tab.order) ? tab.order : 100,
        tabs: [tab.id], hidden: [], kind: 'single', defaultTab: tab.id
      });
    }
    return items.sort((a, b) => a.order - b.order);
  }

  /** O item que abriga a tela `tabId` (com ou sem aba interna), ou null. */
  function itemOf(items, tabId) {
    return (items || []).find((item) => item.tabs.includes(tabId) || item.hidden.includes(tabId)) || null;
  }

  const api = { LAYOUT, plan, itemOf };
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else globalThis.BFMenu = api;
})();
