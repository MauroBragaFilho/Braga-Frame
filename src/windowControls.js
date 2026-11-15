'use strict';

/**
 * Controles da janela sem moldura (frame:false): o renderer desenha minimizar/maximizar/tela cheia/fechar e chama os
 * canais window:* (src/ipc/handlers/app.js). Este módulo concentra a leitura do estado e os eventos de mudança, para o
 * handler e o main.js usarem a mesma definição. Tudo tolera janela ausente ou já destruída.
 */

const gone = (win) => !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());

/** { maximized, fullscreen, minimized } da janela (tudo false sem janela). */
function windowState(win) {
  if (gone(win)) return { maximized: false, fullscreen: false, minimized: false };
  return { maximized: Boolean(win.isMaximized()), fullscreen: Boolean(win.isFullScreen()), minimized: Boolean(win.isMinimized()) };
}

/** Minimiza. */
function minimize(win) {
  if (!gone(win)) win.minimize();
  return windowState(win);
}

/** Alterna maximizado/restaurado (em tela cheia, só sai da tela cheia). */
function toggleMaximize(win) {
  if (gone(win)) return windowState(win);
  if (win.isFullScreen()) win.setFullScreen(false);
  else if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return windowState(win);
}

/** Alterna tela cheia; com `exit` só sai dela (usado pela tecla Esc). */
function toggleFullscreen(win, { exit = false } = {}) {
  if (gone(win)) return windowState(win);
  if (exit) { if (win.isFullScreen()) win.setFullScreen(false); } else win.setFullScreen(!win.isFullScreen());
  return windowState(win);
}

/** Pede para fechar (o renderer grava o projeto no beforeunload). */
function close(win) {
  if (!gone(win)) win.close();
  return {};
}

const CHANGE_EVENTS = ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'minimize', 'restore'];

/** Avisa o renderer ('window:changed' com o estado novo) a cada mudança da janela. Devolve a função que desliga. */
function watchWindow(win, send) {
  if (gone(win)) return () => {};
  const notify = () => { if (!gone(win)) send('window:changed', windowState(win)); };
  for (const name of CHANGE_EVENTS) win.on(name, notify);
  return () => { if (!gone(win)) for (const name of CHANGE_EVENTS) win.removeListener(name, notify); };
}

module.exports = { windowState, minimize, toggleMaximize, toggleFullscreen, close, watchWindow, CHANGE_EVENTS };
