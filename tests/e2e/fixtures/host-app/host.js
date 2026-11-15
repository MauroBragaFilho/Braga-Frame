'use strict';

/* global window, document */

// Página do hospedeiro de teste: o equivalente ao screens/frame.js do BDS (docs/modulo-bds.md).
(function () {
  const api = window.hostApi;
  const root = document.documentElement;
  const state = { embed: null, themeFromFrame: null, errors: [] };
  window.__host = state;

  api.config().then((config) => {
    state.config = config;
    state.embed = window.BfEmbedHost.create({
      container: document.getElementById('frameHost'),
      src: config.frameSrc,
      invoke: (channel, payload) => api.invoke(channel, payload),
      subscribe: (handler) => api.onEvent(handler),
      pathForFile: (file) => api.pathForFile(file),
      theme: () => root.getAttribute('data-theme'),
      onThemeChange: (theme) => { state.themeFromFrame = theme; root.setAttribute('data-theme', theme); },
      onError: (err) => state.errors.push(err.message)
    });
  });

  document.getElementById('hostTheme').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    if (state.embed) state.embed.setTheme(next);
  });
  document.getElementById('hostFocus').addEventListener('click', () => { if (state.embed) state.embed.focus(); });
}());
