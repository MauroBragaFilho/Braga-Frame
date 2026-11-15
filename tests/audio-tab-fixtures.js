'use strict';

/**
 * Ambiente mínimo para rodar renderer/features/audio.js num contexto `vm` sem abrir o Electron: um DOM falso (só o
 * que a aba usa), o `BF` com o mesmo comportamento do app.js (barramento, projeto, abas, debounce), um <video> e uma
 * Web Audio falsa que guarda o que foi agendado no ganho. As regras (audioFilter.js e audioHistory.js) são as REAIS,
 * e o relógio (setTimeout) é virtual: `env.advance(ms)` dispara os temporizadores, sem esperar de verdade.
 * O som, o CSS e o foco de verdade são conferidos em tests/e2e/audio.e2e.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const featureCode = read('renderer', 'features', 'audio.js');
const AF = require('../src/core/audio/audioFilter');
const AH = require('../src/core/audio/audioHistory');
const model = require('../src/core/projects/model');

// ---------- DOM falso ----------

class FakeText {
  constructor(text) { this.data = String(text); }
}

class FakeEl {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.doc = doc;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.title = '';
    this.id = '';
    this.parent = null;
  }

  get type() { return this.attrs.type || ''; }

  get textContent() { return this.children.map((c) => (c instanceof FakeText ? c.data : c.textContent)).join(''); }

  set textContent(text) { this.children = [new FakeText(text)]; }

  append(...kids) {
    for (const kid of kids.flat(Infinity)) {
      const node = typeof kid === 'string' ? new FakeText(kid) : kid;
      if (node instanceof FakeEl) node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...kids) { this.children = []; this.append(...kids); }

  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'id') this.id = String(value);
  }

  getAttribute(key) { return key in this.attrs ? this.attrs[key] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  /** Dispara os ouvintes do elemento (como o navegador faz com o evento de verdade). */
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn({ type, target: this, preventDefault() {}, ...event });
  }

  click() { this.fire('click'); }

  focus() { this.doc.activeElement = this; }

  get classList() {
    const self = this;
    const names = () => self.className.split(/\s+/).filter(Boolean);
    return {
      contains: (c) => names().includes(c),
      add: (c) => { if (!names().includes(c)) self.className = [...names(), c].join(' '); },
      toggle: (c, on) => {
        const has = names().includes(c);
        const want = on === undefined ? !has : Boolean(on);
        self.className = want ? (has ? self.className : [...names(), c].join(' ')) : names().filter((n) => n !== c).join(' ');
        return want;
      }
    };
  }

  find(match) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (!(child instanceof FakeEl)) continue;
        if (match(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  byClass(name) { return this.find((n) => n.className.split(/\s+/).includes(name)); }

  byId(id) { return this.find((n) => n.id === id)[0] || null; }
}

const DOM_PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate']);

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

// ---------- Web Audio falsa ----------

/** AudioParam: guarda os eventos agendados; `valueAt(t)` diz qual ganho está valendo no instante `t` do relógio do áudio. */
class FakeParam {
  constructor(ctx) { this.ctx = ctx; this.base = 1; this.events = []; }

  get value() { return this.valueAt(this.ctx.currentTime); }

  valueAt(t) {
    let v = this.base;
    for (const e of [...this.events].sort((a, b) => a.time - b.time)) if (e.time <= t) v = e.value;
    return v;
  }

  cancelScheduledValues(t) { this.base = this.valueAt(t); this.events = this.events.filter((e) => e.time < t); }

  setValueAtTime(value, time) { this.events.push({ op: 'set', value, time }); }

  linearRampToValueAtTime(value, time) { this.events.push({ op: 'ramp', value, time }); }
}

function makeAudioContextClass(counter) {
  return class FakeAudioContext {
    constructor() {
      counter.contexts += 1;
      this.currentTime = 0;
      this.state = 'running';
      this.destination = {};
    }

    createMediaElementSource(video) { counter.sources += 1; return { mediaElement: video, connect() {} }; }

    createGain() { const gain = { gain: new FakeParam(this), connect() {} }; counter.gains.push(gain); return gain; }

    createAnalyser() { return { fftSize: 0, connect() {}, getFloatTimeDomainData() {} }; }

    resume() { this.state = 'running'; return Promise.resolve(); }

    close() { return Promise.resolve(); }
  };
}

// ---------- ambiente completo ----------

const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Carrega a aba Áudio num contexto isolado. `cuts`: lista de { id, title, start, end, audio? }.
 * Devolve o ambiente: { BF, panel, ui(id), advance(ms), show(), hide(), respond(i, res), measureCalls, logs, ... }.
 */
async function createEnv({ cuts = [], sourcePath = 'C:\\gravacoes\\jogo.mp4', ffmpeg = 'ffmpeg', webAudio = true, mutationObserver = false } = {}) {
  const doc = { activeElement: null, listeners: { capture: [], bubble: [] } };
  doc.createElement = (tag) => new FakeEl(tag, doc);
  doc.addEventListener = (type, fn, capture) => { if (type === 'keydown') doc.listeners[capture ? 'capture' : 'bubble'].push(fn); };
  doc.querySelector = (selector) => (selector === '.bf-modal' ? env.modal : null);
  doc.head = { append() {} };
  const el = makeEl(doc);

  // temporizadores virtuais
  const timers = new Map();
  let timerSeq = 0;
  let clock = 0;
  const setTimeoutFake = (fn, ms) => { timerSeq += 1; timers.set(timerSeq, { at: clock + (ms || 0), fn }); return timerSeq; };
  const clearTimeoutFake = (id) => { timers.delete(id); };

  // <video> falso
  const videoListeners = {};
  const video = {
    paused: true, currentTime: 0, playbackRate: 1, volume: 1,
    addEventListener(name, fn) { (videoListeners[name] = videoListeners[name] || []).push(fn); },
    emit(name) { for (const fn of videoListeners[name] || []) fn({ type: name }); }
  };

  const counter = { contexts: 0, sources: 0, gains: [] };
  const listeners = new Map();
  const bus = {
    on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); },
    emit(evt, data) { events.push([evt, data]); for (const fn of [...(listeners.get(evt) || [])]) fn(data); }
  };
  const events = [];
  const logs = [];
  const measureCalls = [];
  let tabDef = null;
  let panel = null;
  const observers = [];

  const project = {
    version: 2, id: 'proj', source: { path: sourcePath, duration: 600, width: 1920, height: 1080, origin: null },
    cuts: cuts.map((c) => model.newCut({ ...c }))
  };

  const BF = {
    util: {
      el,
      fmt: (sec) => { const s = Math.max(0, sec || 0); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; },
      debounce(fn, ms) {
        let timer = null;
        let lastArgs = [];
        const wrapped = (...args) => { lastArgs = args; clearTimeoutFake(timer); timer = setTimeoutFake(() => { timer = null; fn(...lastArgs); }, ms); };
        wrapped.cancel = () => { clearTimeoutFake(timer); timer = null; };
        wrapped.flush = () => { if (timer !== null) { clearTimeoutFake(timer); timer = null; fn(...lastArgs); } };
        wrapped.pending = () => timer !== null;
        return wrapped;
      }
    },
    bus,
    state: { project, info: { hasAudio: true }, url: null, tools: { ffmpeg } },
    api(channel, payload) {
      if (channel === 'audio:measure') {
        return new Promise((resolve) => { measureCalls.push({ payload, resolve }); });
      }
      return Promise.resolve({ ok: false, code: 'UNKNOWN', message: `canal sem simulação: ${channel}` });
    },
    project: {
      update(fn, { reason = 'update' } = {}) { const r = fn(project); bus.emit('project:changed', { reason }); return r; },
      cut: (id) => project.cuts.find((c) => c.id === id) || null
    },
    ui: {
      log(message, kind) { logs.push({ message, kind }); },
      toast() {},
      registerTab(def) {
        tabDef = def;
        panel = new FakeEl('section', doc);
        panel.hidden = true; // como o app: a aba nasce escondida
        def.render(panel);
      }
    },
    player: {
      video,
      seek(t) { video.currentTime = t; },
      playRange(start) { video.currentTime = start; video.paused = false; env.played.push(start); },
      pause() { video.paused = true; }
    }
  };

  const sandbox = {
    console,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    document: doc,
    BFAudioFilter: AF,
    BFAudioHistory: AH
  };
  sandbox.window = sandbox;
  sandbox.BF = BF;
  if (webAudio) sandbox.AudioContext = makeAudioContextClass(counter);
  if (mutationObserver) {
    sandbox.MutationObserver = class { constructor(cb) { observers.push(cb); } observe() {} };
  }

  const env = {
    BF, doc, video, project, logs, events, measureCalls, counter, observers, modal: null, played: [],
    get panel() { return panel; },
    get tabDef() { return tabDef; },
    ui: (id) => panel.byId(id),
    byClass: (name) => panel.byClass(name),
    cls: (name) => panel.byClass(name)[0],
    /** Avança o relógio virtual disparando os temporizadores vencidos (e deixa as promessas andarem). */
    async advance(ms) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].fn();
        await flush();
      }
      clock = end;
      await flush();
    },
    /** Mostra/esconde a aba como o app faz (o painel perde o `hidden` e o `onShow` é chamado). */
    async show() { panel.hidden = false; tabDef.onShow(); await flush(); },
    hide() { panel.hidden = true; },
    /** Responde ao pedido `i` de audio:measure. */
    async respond(i, res) { measureCalls[i].resolve(res); await flush(); },
    /** Envia um keydown pelos ouvintes do documento (captura primeiro, depois bolha), como o navegador. */
    key(init) {
      let prevented = false;
      const event = { type: 'keydown', key: 'z', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, target: doc.activeElement || panel, ...init };
      Object.defineProperty(event, 'defaultPrevented', { get: () => prevented });
      event.preventDefault = () => { prevented = true; };
      for (const fn of doc.listeners.capture) fn(event);
      for (const fn of doc.listeners.bubble) fn(event);
      return event;
    },
    /** Ganho que estará valendo logo depois do agendamento atual (relógio do áudio ~50 ms à frente). */
    gainNow() { const g = counter.gains[0]; return g ? g.gain.valueAt(0.05) : null; }
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(featureCode, context, { filename: 'renderer/features/audio.js' });
  await flush(); // as regras já estão no window: a aba fica pronta (state.ready) na primeira volta das promessas
  return env;
}

/** Resposta do audio:measure no formato do handler. */
const measureResult = (peakDb, meanDb, extra = {}) => ({ ok: true, hasAudio: true, peakDb, meanDb, samples: 480000, start: 0, end: 10, cached: false, ...extra });

module.exports = { createEnv, measureResult, flush, FakeEl };
