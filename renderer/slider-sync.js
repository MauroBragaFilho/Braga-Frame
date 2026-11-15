'use strict';

/**
 * Preenchimento das barras deslizantes (input[type=range]), igual ao do Braga Digital Studio.
 * app.css desenha o trecho já percorrido com um gradiente controlado por --slider-value (0%..100%); este arquivo
 * mantém essa variável certa para QUALQUER range da interface, sem a feature precisar fazer nada:
 *  - interação do usuário (arrastar, teclado): eventos input/change;
 *  - valor mudado por código (slider.value = x): o setter de `value` dos inputs é envolvido e sincroniza ao atribuir;
 *  - mudança de min/max/step/value por atributo e sliders criados depois: MutationObserver.
 * (A variável é definida pelo CSSOM, que a CSP `style-src 'self'` permite.)
 */
(function () {
  const SELECTOR = 'input[type="range"]';

  function percent(el) {
    const min = el.min === '' ? 0 : parseFloat(el.min);
    const max = el.max === '' ? 100 : parseFloat(el.max);
    const value = parseFloat(el.value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  }

  function sync(el) {
    el.style.setProperty('--slider-value', `${percent(el)}%`);
  }

  function syncAll(root) {
    if (root.matches && root.matches(SELECTOR)) sync(root);
    if (root.querySelectorAll) root.querySelectorAll(SELECTOR).forEach(sync);
  }

  document.addEventListener('input', (event) => { if (event.target.matches && event.target.matches(SELECTOR)) sync(event.target); }, true);
  document.addEventListener('change', (event) => { if (event.target.matches && event.target.matches(SELECTOR)) sync(event.target); }, true);

  // valor atribuído por código: sincroniza na hora (sem esperar nenhum temporizador)
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (descriptor && descriptor.set) {
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(next) {
        descriptor.set.call(this, next);
        if (this.type === 'range') sync(this);
      }
    });
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') { if (record.target.matches(SELECTOR)) sync(record.target); continue; }
      for (const node of record.addedNodes) if (node.nodeType === 1) syncAll(node);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'step', 'value', 'type'] });

  syncAll(document);
})();
