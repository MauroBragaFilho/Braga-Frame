'use strict';

/**
 * Lado da PÁGINA DO HOSPEDEIRO (renderer do Braga Digital Studio): cria o <iframe> do Braga Frame e faz a ponte entre ele e o
 * processo principal. Este arquivo é feito para ser COPIADO para o hospedeiro (no BDS: renderer/utils/bfEmbedHost.js) e
 * carregado por <script> ou import; não depende de nada do Braga Frame além do protocolo descrito em renderer/bridge.js.
 *
 *   const host = BfEmbedHost.create({
 *     container: document.getElementById('frameHost'),
 *     src: 'file:///…/braga-frame/renderer/index.html',
 *     invoke: (canal, payload) => window.bds.bfInvoke(canal, payload),        // -> module.invoke(...) no processo principal
 *     subscribe: (handler) => window.bds.onBfEvent(handler),                  // handler({ channel, payload }); devolve cancelar()
 *     pathForFile: (file) => window.bds.getPathForFile(file),                 // arrastar e soltar
 *     theme: () => document.documentElement.getAttribute('data-theme')        // 'light' | 'dark' (ou texto)
 *     accent: () => ({ '--accent': '#ff0000', … })   // opcional: variáveis --accent* do hospedeiro (cor de destaque)
 *     themeLocked: true                               // opcional: esconde o botão de tema do Braga Frame (o hospedeiro manda)
 *   });
 *   …
 *   host.destroy();   // ao sair da tela: tira o iframe, solta os ouvintes
 *
 * Segurança: só aceita mensagens vindas de `iframe.contentWindow` (e, na origem esperada), valida o formato e o canal
 * (/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/) ANTES de chamar `invoke`, e nunca executa nada do que recebe.
 */
(function (root) {
  const SOURCE = 'braga-frame';
  const VERSION = 1;
  const CHANNEL_RE = /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/;

  const isTheme = (value) => value === 'light' || value === 'dark';

  /**
   * URL do iframe: a de renderer/index.html com ?embedded=1 (modo embutido), &theme= (sem piscar no tema errado) e
   * &hostOrigin= (a ponte só aceita mensagens dessa origem).
   */
  function buildFrameUrl(src, { theme, hostOrigin, themeLocked } = {}) {
    const url = new URL(src, root.location && root.location.href ? root.location.href : undefined);
    url.searchParams.set('embedded', '1');
    if (themeLocked) url.searchParams.set('themeLocked', '1');
    if (isTheme(theme)) url.searchParams.set('theme', theme);
    if (typeof hostOrigin === 'string' && hostOrigin) url.searchParams.set('hostOrigin', hostOrigin);
    return url.href;
  }

  /** Origem que o navegador informa nas mensagens do iframe: arquivos locais têm origem opaca ("null"). */
  function expectedFrameOrigin(src, sandbox) {
    const url = new URL(src, root.location && root.location.href ? root.location.href : undefined);
    if (url.protocol === 'file:') return 'null';
    if (typeof sandbox === 'string' && !/\ballow-same-origin\b/.test(sandbox)) return 'null';
    return url.origin;
  }

  function create(options = {}) {
    const { container, src, invoke } = options;
    if (!container || typeof container.appendChild !== 'function') throw new TypeError('BfEmbedHost.create: informe "container" (elemento).');
    if (typeof src !== 'string' || !src) throw new TypeError('BfEmbedHost.create: informe "src" (URL de renderer/index.html do Braga Frame).');
    if (typeof invoke !== 'function') throw new TypeError('BfEmbedHost.create: informe "invoke(canal, payload)".');

    const doc = container.ownerDocument;
    const win = doc.defaultView;
    // sem `sandbox` por padrão: o Braga Frame é código do próprio produto, e 'allow-scripts allow-same-origin' juntos não isolam nada
    // (o Chromium até avisa disso no console). `options.sandbox` aceita o texto do atributo, para quem quiser restringir.
    const sandbox = typeof options.sandbox === 'string' ? options.sandbox : '';
    const frameOrigin = options.frameOrigin || expectedFrameOrigin(src, sandbox || undefined);
    const forwardKeys = options.forwardKeys === true;
    const isAllowed = typeof options.isChannelAllowed === 'function' ? options.isChannelAllowed : () => true;
    const subscribed = new Set(); // canais de evento que o iframe assinou
    let destroyed = false;
    let ready = false;
    let theme = null;
    let unsubscribe = null;
    let closeWaiter = null; // { resolve } enquanto close() espera o iframe gravar o projeto

    const currentTheme = () => {
      let value = null;
      try { value = typeof options.theme === 'function' ? options.theme() : options.theme; } catch { value = null; }
      return isTheme(value) ? value : (isTheme(theme) ? theme : 'dark');
    };
    theme = currentTheme();

    /** Variáveis de cor de destaque do hospedeiro: só nomes --accent* e valores curtos de cor (o iframe confere de novo). */
    const currentAccent = () => {
      let value = null;
      try { value = typeof options.accent === 'function' ? options.accent() : options.accent; } catch { value = null; }
      if (!value || typeof value !== 'object') return null;
      const out = {};
      for (const [name, v] of Object.entries(value)) {
        if (/^--accent(-[a-z]+)*$/.test(name) && typeof v === 'string' && v.length <= 60 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v)) out[name] = v;
      }
      return Object.keys(out).length ? out : null;
    };

    const accentField = () => { const a = currentAccent(); return a ? { accent: a } : {}; };

    const iframe = doc.createElement('iframe');
    iframe.className = options.className || 'bf-frame';
    iframe.title = options.title || 'Braga Frame';
    if (sandbox) iframe.setAttribute('sandbox', sandbox);
    iframe.setAttribute('allow', 'fullscreen');
    iframe.style.cssText = 'border:0;width:100%;height:100%;display:block;background:transparent;';

    function post(message) {
      const target = iframe.contentWindow;
      if (destroyed || !target) return;
      try {
        target.postMessage({ source: SOURCE, version: VERSION, ...message }, frameOrigin === 'null' ? '*' : frameOrigin);
      } catch (err) {
        reportError(err);
      }
    }

    function reportError(err) {
      if (typeof options.onError === 'function') { try { options.onError(err); } catch { /* o aviso nunca derruba a ponte */ } }
    }

    async function answer(id, work) {
      try {
        const value = await work();
        post({ kind: 'result', id, ok: true, value });
      } catch (err) {
        reportError(err);
        post({ kind: 'result', id, ok: false, error: (err && err.message) || 'Falha ao atender a chamada.' });
      }
    }

    function onMessage(event) {
      if (destroyed || event.source !== iframe.contentWindow) return;
      if (event.origin !== frameOrigin) return;
      const m = event.data;
      if (!m || typeof m !== 'object' || m.source !== SOURCE || typeof m.kind !== 'string') return;
      const validId = Number.isSafeInteger(m.id) && m.id > 0;

      switch (m.kind) {
        case 'ready':
          ready = true;
          subscribed.clear(); // a página (re)carregou e assina de novo
          post({ kind: 'init', theme: currentTheme(), forwardKeys, ...accentField() });
          if (typeof options.onReady === 'function') { try { options.onReady(); } catch (err) { reportError(err); } }
          break;
        case 'invoke':
          if (!validId) return;
          if (typeof m.channel !== 'string' || !CHANNEL_RE.test(m.channel) || !isAllowed(m.channel)) {
            post({ kind: 'result', id: m.id, ok: false, error: `Canal inválido ou não permitido: ${String(m.channel).slice(0, 80)}` });
            return;
          }
          answer(m.id, () => invoke(m.channel, m.payload));
          break;
        case 'pick-path':
          if (!validId) return;
          if (typeof options.pathForFile !== 'function') {
            post({ kind: 'result', id: m.id, ok: false, error: 'O programa que abriu o Braga Frame não informa o caminho de arquivos soltos.' });
            return;
          }
          answer(m.id, async () => {
            const file = m.file;
            if (!file || typeof file !== 'object' || typeof file.name !== 'string') throw new Error('Arquivo inválido.');
            const path = await options.pathForFile(file);
            if (typeof path !== 'string' || !path) throw new Error('Não foi possível descobrir o caminho do arquivo solto.');
            return path;
          });
          break;
        case 'on':
          if (typeof m.channel === 'string' && CHANNEL_RE.test(m.channel) && isAllowed(m.channel)) subscribed.add(m.channel);
          break;
        case 'off':
          if (typeof m.channel === 'string') subscribed.delete(m.channel);
          break;
        case 'theme-changed':
          if (isTheme(m.theme)) {
            theme = m.theme;
            if (typeof options.onThemeChange === 'function') { try { options.onThemeChange(m.theme); } catch (err) { reportError(err); } }
          }
          break;
        case 'close-ready':
          if (closeWaiter) closeWaiter.resolve(true);
          break;
        case 'key':
          if (forwardKeys && typeof m.key === 'string' && m.key.length <= 32) {
            doc.dispatchEvent(new win.KeyboardEvent('keydown', {
              key: m.key, code: typeof m.code === 'string' ? m.code : '', ctrlKey: m.ctrlKey === true, shiftKey: m.shiftKey === true,
              altKey: m.altKey === true, metaKey: m.metaKey === true, bubbles: true, cancelable: true
            }));
          }
          break;
        default:
          break;
      }
    }

    win.addEventListener('message', onMessage);
    if (typeof options.subscribe === 'function') {
      unsubscribe = options.subscribe((evt) => {
        if (destroyed || !ready || !evt || typeof evt.channel !== 'string' || !subscribed.has(evt.channel)) return;
        post({ kind: 'event', channel: evt.channel, payload: evt.payload });
      });
    }

    // o ouvinte já existe quando o iframe começa a carregar: o primeiro "ready" não se perde
    // origem do hospedeiro como o navegador a informa nas mensagens: páginas file:// têm origem opaca ("null")
    const hostOrigin = win.location.protocol === 'file:' ? 'null' : win.location.origin;
    iframe.src = buildFrameUrl(src, { theme, hostOrigin, themeLocked: options.themeLocked === true });
    container.appendChild(iframe);

    return {
      iframe,
      /** Muda o tema do Braga Frame ('light' | 'dark'). */
      setTheme(value) {
        if (!isTheme(value)) return;
        theme = value;
        post({ kind: 'theme', theme: value, ...accentField() });
      },
      /** Reenvia a cor de destaque do hospedeiro (chame quando ela mudar). */
      setAccent() {
        post({ kind: 'theme', theme, ...accentField() });
      },
      /** Avisa o Braga Frame que a tela dele foi mostrada ou escondida (escondida: o vídeo é pausado). */
      setVisible(visible) {
        post({ kind: 'visibility', visible: visible !== false });
      },
      /**
       * Fecha com segurança: pede ao Braga Frame para gravar o projeto aberto (o salvamento dele espera 300 ms), espera a
       * confirmação (até `timeout`) e só então chama destroy(). Resolve true se o projeto foi gravado a tempo.
       * Use ao sair da tela; destroy() sozinho descarta o que ainda não foi gravado.
       */
      async close({ timeout = 4000 } = {}) {
        if (destroyed) return true;
        if (!ready) { this.destroy(); return true; }
        const saved = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), timeout);
          closeWaiter = { resolve: (value) => { clearTimeout(timer); resolve(value); } };
          post({ kind: 'prepare-close' });
        });
        closeWaiter = null;
        this.destroy();
        return saved;
      },
      /** Dá o foco do teclado ao Braga Frame (chame ao voltar para a tela). */
      focus() {
        try { iframe.focus(); if (iframe.contentWindow) iframe.contentWindow.focus(); } catch { /* sem foco */ }
      },
      /** Tira o iframe, solta o ouvinte de mensagens e a assinatura de eventos. Idempotente. Prefira close() ao sair da tela. */
      destroy() {
        if (destroyed) return;
        if (closeWaiter) closeWaiter.resolve(false);
        win.removeEventListener('message', onMessage);
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch { /* já solto */ } }
        unsubscribe = null;
        subscribed.clear();
        try { iframe.src = 'about:blank'; } catch { /* sendo removido */ }
        iframe.remove();
        destroyed = true;
      },
      get destroyed() { return destroyed; },
      get ready() { return ready; }
    };
  }

  const api = Object.freeze({ create, buildFrameUrl, expectedFrameOrigin, PROTOCOL: Object.freeze({ SOURCE, VERSION, CHANNEL_RE }) });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BfEmbedHost = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
