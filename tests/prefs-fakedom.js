'use strict';

/**
 * DOM mínimo para rodar renderer/features/prefs.js sem o Electron (tests/prefs-renderer.test.js). Só o que a feature
 * usa: criar elementos, filhos, atributos, eventos, seletores simples (.classe, #id, [attr="v"], tag), foco.
 * O desenho real (CSS, foco, teclado) é conferido em tests/e2e/prefs.e2e.js.
 */

class FakeText {
  constructor(text) { this.textContent = String(text); this.parent = null; }
}

class FakeNode {
  constructor(tag, doc) {
    this.tag = tag;
    this.doc = doc;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.parent = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.inert = false;
    this.open = false;
    this.id = '';
  }

  append(...kids) {
    for (const kid of kids.flat(Infinity)) {
      // como o DOM de verdade: append(null) escreve o texto "null"; é por isso que a feature filtra os vazios
      const node = typeof kid === 'string' || kid === null || kid === undefined ? new FakeText(String(kid)) : kid;
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...kids) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...kids);
  }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'id') this.id = String(value);
  }

  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }

  click() { this.dispatch('click'); }

  focus() { this.doc.activeElement = this; }

  select() {}

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n === this.doc.body;
  }

  get classList() {
    const self = this;
    return { contains: (c) => self.className.split(/\s+/).includes(c), add: (c) => { if (!self.className.split(/\s+/).includes(c)) self.className = `${self.className} ${c}`.trim(); } };
  }

  get textContentDeep() {
    return this.children.map((c) => (c instanceof FakeText ? c.textContent : c.textContentDeep)).join('');
  }

  matches(selector) {
    const sel = selector.trim();
    if (sel.startsWith('.')) return this.className.split(/\s+/).includes(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const attr = /^\[([\w-]+)(?:="(.*)")?\]$/.exec(sel);
    if (attr) {
      const [, name, value] = attr;
      const actual = name.startsWith('data-') ? this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : this.attrs[name];
      return value === undefined ? actual !== undefined : actual === value;
    }
    return this.tag === sel;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child instanceof FakeText) continue;
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  closest() { return null; }

  contains(node) {
    for (let n = node; n; n = n.parent) if (n === this) return true;
    return false;
  }
}

function createDocument() {
  const doc = { activeElement: null, listeners: {}, byId: new Map() };
  doc.body = new FakeNode('body', doc);
  doc.createElement = (tag) => new FakeNode(tag, doc);
  doc.addEventListener = (type, fn) => { (doc.listeners[type] = doc.listeners[type] || []).push(fn); };
  doc.removeEventListener = (type, fn) => { doc.listeners[type] = (doc.listeners[type] || []).filter((f) => f !== fn); };
  doc.dispatch = (type, event = {}) => { for (const fn of [...(doc.listeners[type] || [])]) fn({ target: doc, preventDefault() {}, stopPropagation() {}, ...event }); };
  doc.getElementById = (id) => doc.byId.get(id) || null;
  doc.register = (id, tag = 'div') => {
    const node = new FakeNode(tag, doc);
    node.id = id;
    doc.body.append(node);
    doc.byId.set(id, node);
    return node;
  };
  return doc;
}

const DOM_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate', 'open']);

/** Mesma semântica do `el` de renderer/app.js. */
function makeEl(doc) {
  return function el(tag, attrs, ...children) {
    const node = doc.createElement(tag);
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
  };
}

module.exports = { FakeNode, FakeText, createDocument, makeEl };
