'use strict';

/**
 * Utilidades puras do renderer, sem estado e sem BF: `el` (cria elementos), `debounce` e os helpers de caminho. Tiradas de app.js
 * (Etapa 2, 17/11/2026) sem mudar o comportamento; carrega ANTES de app.js (renderer/index.html), que as expõe em `BF.util`.
 */
(function () {
  const DOM_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate']);

  /**
   * Cria um elemento: el('button', { class: 'primary', onclick: fn, dataset: { id } }, 'Texto', outroNo).
   * Atributos null/undefined/false são ignorados; filhos podem ser textos, nós ou listas.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (DOM_PROPS.has(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child);
    }
    return node;
  }

  /** Adia `fn` até `ms` sem chamadas. Tem .cancel(), .flush() (executa já, se houver pendência) e .pending(). */
  function debounce(fn, ms) {
    let timer = null;
    let lastArgs = [];
    const wrapped = (...args) => {
      lastArgs = args;
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms);
    };
    wrapped.cancel = () => { clearTimeout(timer); timer = null; };
    wrapped.flush = () => { if (timer !== null) { clearTimeout(timer); timer = null; fn(...lastArgs); } };
    wrapped.pending = () => timer !== null;
    return wrapped;
  }

  function dirOf(file) {
    return file.slice(0, Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')));
  }
  /** Nome do arquivo com extensão. */
  function nameOf(file) {
    return file.slice(Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/')) + 1);
  }
  /** Nome do arquivo sem extensão. */
  function baseOf(file) {
    return nameOf(file).replace(/\.[^.]+$/, '');
  }
  /** Junta pasta e nome usando o mesmo separador do caminho (Windows usa "\"). */
  function joinPath(dir, name) {
    return `${dir}${dir.includes('\\') || !dir.includes('/') ? '\\' : '/'}${name}`;
  }

  window.BFUtil = { el, debounce, dirOf, nameOf, baseOf, joinPath };
})();
