'use strict';

/**
 * Ponte do renderer para quando o Braga Frame roda DENTRO de outra janela (iframe do Braga Digital Studio), onde não existe
 * preload e, portanto, nem `window.bf`. Ela cria um `window.bf` com a mesma forma do preload (invoke, on, pathForFile), mas
 * em vez de falar com o processo principal, troca mensagens (`postMessage`) com a página que embute o app; essa página
 * (src/host/bfEmbedHost.js) repassa as chamadas ao módulo do processo principal (src/host/index.js).
 *
 * Em janela própria (o preload já definiu `window.bf`) este arquivo não faz nada.
 *
 * PROTOCOLO (versão 1). Toda mensagem é um objeto simples { source: 'braga-frame', version: 1, kind, ... }:
 *
 *   iframe -> hospedeiro
 *     ready                              o app carregou (o hospedeiro responde com `init`)
 *     invoke   { id, channel, payload }  chamar um canal "<recurso>:<acao>" (resposta: `result` com o mesmo id)
 *     on       { channel }               passar a receber os eventos desse canal
 *     off      { channel }               parar de receber
 *     pick-path { id, file }             descobrir o caminho real de um arquivo solto (File); resposta: `result`
 *     theme-changed { theme }            o usuário trocou o tema dentro do app
 *     key      { key, code, ctrlKey, shiftKey, altKey, metaKey }   atalho de teclado (só se o hospedeiro pediu em `init`)
 *     close-ready                        resposta a `prepare-close`: o projeto aberto já foi gravado
 *
 *   hospedeiro -> iframe
 *     init     { theme, forwardKeys }    confirma a conexão (sem isto as chamadas expiram) e traz o tema do hospedeiro
 *     result   { id, ok, value | error } `ok:true` -> `value` é a resposta do canal ({ ok:true, … } ou { ok:false, code, message });
 *                                        `ok:false` -> falha de transporte, `error` = texto
 *     event    { channel, payload }      evento do processo principal para um canal assinado
 *     theme    { theme }                 o hospedeiro mudou o tema ('light' | 'dark')
 *     visibility { visible }             a tela do Braga Frame foi mostrada/escondida no hospedeiro (escondida: pausa o player)
 *     prepare-close                      o hospedeiro vai remover o iframe: grava o projeto e responde `close-ready`
 *
 * Segurança: só são aceitas mensagens cuja origem é `window.parent` (a janela que embute) e, se a URL trouxe
 * `?hostOrigin=…`, cuja origem bate com ela; objetos fora do formato e canais fora de /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/
 * são descartados. Nada da mensagem é executado.
 *
 * Arrastar e soltar: um arquivo solto num iframe não revela o caminho a quem está dentro dele. A ponte intercepta o `drop`,
 * pede o caminho ao hospedeiro (`pick-path`, que usa o `webUtils.getPathForFile` do preload dele) e só então abre o vídeo.
 */
(function () {
  if (window.bf) return; // janela própria: o preload já fez a ponte
  if (window.parent === window) return; // sem preload e sem hospedeiro: o app.js mostra o aviso de erro

  const SOURCE = 'braga-frame';
  const VERSION = 1;
  const CHANNEL_RE = /^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9]+$/;
  const HOST_TIMEOUT_MS = 8000;
  const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

  const expectedOrigin = (() => {
    try { return new URLSearchParams(window.location.search).get('hostOrigin') || null; } catch { return null; }
  })();

  const pending = new Map(); // id -> { resolve, reject }
  const subscribers = new Map(); // canal -> Set(callback)
  let nextId = 0;
  let acked = false;
  let ackTimer = null;
  let forwardKeys = false;
  let hostTheme = null;

  function assertChannel(channel) {
    if (typeof channel !== 'string' || !CHANNEL_RE.test(channel)) {
      throw new Error(`Canal IPC inválido: "${String(channel)}". Use "<recurso>:<acao>".`);
    }
  }

  function post(message) {
    // '*' porque a página que embute pode ter origem opaca (file:); o destino é sempre window.parent, nunca outra janela
    window.parent.postMessage({ source: SOURCE, version: VERSION, ...message }, '*');
  }

  function rejectAll(error) {
    for (const entry of [...pending.values()]) entry.reject(error);
    pending.clear();
  }

  /** Sem `init` do hospedeiro a tempo, as chamadas pendentes falham com uma mensagem clara (em vez de a tela ficar parada). */
  function armTimeout() {
    if (acked || ackTimer) return;
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (!acked) rejectAll(new Error('O programa que abriu o Braga Frame não respondeu. Feche e abra o módulo de novo.'));
    }, HOST_TIMEOUT_MS);
  }

  function request(kind, fields) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        post({ kind, id, ...fields });
      } catch (err) { // payload que não pode ser copiado (função, símbolo…)
        pending.delete(id);
        reject(new Error(`Não foi possível enviar a chamada: ${err.message}`));
        return;
      }
      armTimeout();
    });
  }

  const api = {
    /** Chama um handler do processo principal. Resolve com { ok:true, … } ou { ok:false, code, message }. */
    invoke(channel, payload) {
      try { assertChannel(channel); } catch (err) { return Promise.reject(err); }
      return request('invoke', { channel, payload });
    },
    /** Escuta um evento do processo principal; devolve a função que cancela a escuta. */
    on(channel, callback) {
      assertChannel(channel);
      if (typeof callback !== 'function') throw new Error('on(canal, callback): o callback precisa ser uma função.');
      let set = subscribers.get(channel);
      if (!set) { set = new Set(); subscribers.set(channel, set); }
      const first = set.size === 0;
      set.add(callback);
      if (first) post({ kind: 'on', channel });
      return () => {
        const current = subscribers.get(channel);
        if (!current || !current.delete(callback)) return;
        if (current.size === 0) { subscribers.delete(channel); post({ kind: 'off', channel }); }
      };
    },
    /**
     * Caminho real de um arquivo solto na janela. DIFERENÇA para o preload: aqui devolve uma Promise (o caminho vem do
     * hospedeiro, por mensagem). O arrastar-e-soltar já é tratado abaixo; não é preciso chamar isto à mão.
     */
    pathForFile(file) {
      if (!file || typeof file !== 'object' || typeof file.name !== 'string') return Promise.reject(new Error('pathForFile(file): informe um File.'));
      return request('pick-path', { file }).then((value) => {
        if (typeof value !== 'string' || !value) throw new Error('O programa que abriu o Braga Frame não informou o caminho do arquivo.');
        return value;
      });
    },
    /** Como a ponte funciona nesta janela (o preload não tem esta propriedade). */
    transport: 'postMessage'
  };
  window.bf = Object.freeze(api);

  // ---------- recepção ----------

  /** Cor de destaque do hospedeiro: só variáveis --accent* com valor de cor curto. */
  function applyAccent(accent) {
    if (!accent || typeof accent !== 'object') return;
    for (const [name, value] of Object.entries(accent)) {
      if (/^--accent(-[a-z]+)*$/.test(name) && typeof value === 'string' && value.length <= 60 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(value)) {
        document.documentElement.style.setProperty(name, value);
      }
    }
  }

  function applyTheme(theme, accent) {
    applyAccent(accent);
    if (theme !== 'light' && theme !== 'dark') return;
    hostTheme = theme;
    const BF = window.BF;
    if (BF && BF.ui && typeof BF.ui.setTheme === 'function') {
      if (BF.ui.theme() !== theme) BF.ui.setTheme(theme);
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }

  function pausePlayer() {
    const BF = window.BF;
    if (BF && BF.player && typeof BF.player.pause === 'function') {
      try { BF.player.pause(); } catch { /* sem player carregado */ }
    }
  }

  function fromHost(event) {
    if (event.source !== window.parent) return null;
    if (expectedOrigin && event.origin !== expectedOrigin) return null;
    const message = event.data;
    if (!message || typeof message !== 'object' || message.source !== SOURCE || typeof message.kind !== 'string') return null;
    return message;
  }

  window.addEventListener('message', (event) => {
    const message = fromHost(event);
    if (!message) return;
    switch (message.kind) {
      case 'init':
        acked = true;
        clearTimeout(ackTimer);
        ackTimer = null;
        forwardKeys = message.forwardKeys === true;
        applyTheme(message.theme, message.accent);
        for (const channel of subscribers.keys()) post({ kind: 'on', channel }); // o hospedeiro começou do zero
        break;
      case 'result': {
        const entry = pending.get(message.id);
        if (!entry) break;
        pending.delete(message.id);
        if (message.ok === true) entry.resolve(message.value);
        else entry.reject(new Error(typeof message.error === 'string' && message.error ? message.error : 'Falha na comunicação com o programa que abriu o Braga Frame.'));
        break;
      }
      case 'event': {
        if (typeof message.channel !== 'string' || !CHANNEL_RE.test(message.channel)) break;
        for (const callback of [...(subscribers.get(message.channel) || [])]) {
          try { callback(message.payload); } catch (err) { console.error(`Erro ouvindo "${message.channel}":`, err); }
        }
        break;
      }
      case 'theme':
        applyTheme(message.theme, message.accent);
        break;
      case 'visibility':
        if (message.visible === false) pausePlayer();
        break;
      case 'prepare-close':
        // o hospedeiro vai tirar o iframe: o salvamento do projeto (que espera 300 ms) precisa terminar antes
        pausePlayer();
        Promise.resolve(window.BF && window.BF.project ? window.BF.project.flush() : true)
          .catch(() => false)
          .then(() => post({ kind: 'close-ready' }));
        break;
      default:
        break; // tipo desconhecido (versão futura do protocolo): ignora
    }
  });

  // ---------- arrastar e soltar ----------

  window.addEventListener('drop', (event) => {
    const transfer = event.dataTransfer;
    if (!transfer || ![...(transfer.types || [])].includes('Files')) return;
    // fase de captura na janela: roda antes do tratamento do shell (que pediria o caminho de forma síncrona, o que aqui não existe)
    event.preventDefault();
    event.stopImmediatePropagation();
    // o shell conta dragenter/dragleave para o destaque da área de soltar; como ele não verá o drop, zera a contagem
    for (let i = 0; i < 8; i += 1) window.dispatchEvent(new Event('dragleave'));
    const file = transfer.files && transfer.files[0];
    if (!file) return;
    const count = transfer.files.length;
    api.pathForFile(file).then((path) => {
      if (!window.BF) return;
      window.BF.openSource(path);
      // vários arquivos soltos: só o primeiro abre; o app avisa quantos ficaram de fora (e a falta dessa função nunca vira "não foi possível abrir")
      if (window.BF.ui && typeof window.BF.ui.droppedMany === 'function') window.BF.ui.droppedMany(count);
    }).catch((err) => {
      const message = `Não foi possível abrir o arquivo solto (${err.message}). Use o botão "Abrir vídeo".`;
      if (window.BF && window.BF.ui) window.BF.ui.toast(message, 'error');
      else console.error(message);
    });
  }, true);

  // ---------- teclado, tema e aviso de pronto ----------

  window.addEventListener('keydown', (event) => {
    if (!forwardKeys || event.defaultPrevented || MODIFIER_KEYS.has(event.key)) return;
    if (!(event.ctrlKey || event.metaKey || event.altKey)) return;
    post({ kind: 'key', key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey });
  });

  document.addEventListener('DOMContentLoaded', () => {
    // todos os scripts já rodaram: o BF existe. Aplica o tema que chegou cedo demais e avisa o hospedeiro das trocas do usuário.
    if (hostTheme) applyTheme(hostTheme);
    if (window.BF && window.BF.bus) {
      window.BF.bus.on('theme:changed', ({ theme }) => {
        if (theme === hostTheme) return; // veio do próprio hospedeiro (applyTheme): não devolve
        hostTheme = theme;
        post({ kind: 'theme-changed', theme });
      });
    }
  });

  post({ kind: 'ready' });
})();
