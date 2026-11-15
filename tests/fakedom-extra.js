'use strict';

/**
 * Complementos do DOM de mentira (tests/prefs-fakedom.js, feito para a aba Preferências) para testar as telas que usam mais DOM do que ela
 * (Projetos e Exportações): classList completo, textContent de verdade, parentElement, insertBefore e replaceWith, seletores compostos e com
 * descendentes (".a .b", "button[data-x][data-y]", "[data-id=x] .prj-thumb"), closest e o clique que SOBE pelos pais (delegação de eventos;
 * botão desabilitado não responde ao clique, como no navegador).
 *
 * `extendFakeDom()` ajusta o protótipo do FakeNode uma vez. Cada arquivo de teste roda no seu próprio processo, então o ajuste só vale para o
 * teste que o chamar e não muda o comportamento dos outros.
 */
const { FakeNode } = require('./prefs-fakedom');

/** Um seletor composto ("button.prj-thumb[data-act=x]") em partes: tag, .classe, #id, [attr] ou [attr="v"]. */
const compoundParts = (sel) => sel.match(/\.[\w-]+|#[\w-]+|\[[\w-]+(?:="[^"]*")?\]|[a-zA-Z][\w-]*/g) || [];

function matchPart(node, part) {
  if (part[0] === '.') return node.className.split(/\s+/).includes(part.slice(1));
  if (part[0] === '#') return node.id === part.slice(1);
  if (part[0] === '[') {
    const [, name, value] = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(part);
    let actual = name.startsWith('data-') ? node.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : node.attrs[name];
    if (actual === undefined && name === 'value' && node.tag === 'option') actual = node.value; // no navegador o value do <option> é também o atributo
    return value === undefined ? actual !== undefined : actual === value;
  }
  return node.tag === part;
}

/** O nó casa com a cadeia "a b c" (descendentes, como o CSS). */
function matchesChain(node, chain) {
  if (!compoundParts(chain[chain.length - 1]).every((part) => matchPart(node, part))) return false;
  let at = chain.length - 2;
  for (let up = node.parent; up && at >= 0; up = up.parent) {
    if (up.tag !== 'body' && compoundParts(chain[at]).every((part) => matchPart(up, part))) at -= 1;
  }
  return at < 0;
}

const chainOf = (selector) => selector.trim().match(/(?:\[[^\]]*\]|[^\s[])+/g) || [];

function extendFakeDom() {
  const proto = FakeNode.prototype;
  if (proto.extendedByTests) return;
  proto.extendedByTests = true;

  Object.defineProperty(proto, 'classList', {
    configurable: true,
    get() {
      const self = this;
      const names = () => self.className.split(/\s+/).filter(Boolean);
      const api = {
        contains: (c) => names().includes(c),
        add: (c) => { if (!names().includes(c)) self.className = [...names(), c].join(' '); },
        remove: (c) => { self.className = names().filter((n) => n !== c).join(' '); },
        toggle: (c, force) => { const on = force === undefined ? !names().includes(c) : Boolean(force); if (on) api.add(c); else api.remove(c); return on; }
      };
      return api;
    }
  });
  Object.defineProperty(proto, 'parentElement', { configurable: true, get() { return this.parent || null; } });
  Object.defineProperty(proto, 'textContent', {
    configurable: true,
    get() { return this.textContentDeep; },
    set(value) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      if (value !== '' && value !== null && value !== undefined) this.append(String(value));
    }
  });

  proto.insertBefore = function insertBefore(node, ref) {
    if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
    node.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  };
  proto.replaceWith = function replaceWith(node) {
    const parent = this.parent;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    parent.children.splice(at, 1, node);
    node.parent = parent;
    this.parent = null;
  };

  proto.matches = function matches(selector) { return matchesChain(this, chainOf(selector)); };
  proto.querySelectorAll = function querySelectorAll(selector) {
    const chain = chainOf(selector);
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeNode)) continue;
        if (matchesChain(child, chain)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  };
  proto.closest = function closest(selector) {
    const chain = chainOf(selector);
    for (let node = this; node; node = node.parent) if (matchesChain(node, chain)) return node;
    return null;
  };

  /** O clique sobe pelos pais (os ouvintes de cada um recebem `target` = quem foi clicado). Botão desabilitado não responde. */
  proto.click = function click() {
    if (this.disabled) return;
    const event = { target: this, preventDefault() {}, stopPropagation() { event.stopped = true; } };
    for (let node = this; node && !event.stopped; node = node.parent) {
      event.currentTarget = node;
      for (const fn of node.listeners.click || []) fn(event);
    }
  };
}

module.exports = { extendFakeDom, FakeNode };
