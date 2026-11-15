'use strict';

// Escolhe o tema antes da primeira pintura (a interface é escura por padrão, igual ao Braga Digital Studio).
// Ordem: ?theme=light|dark na URL (quem embute o app pode definir) > escolha guardada pelo usuário > escuro.
(function () {
  let theme = 'dark';
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('theme');
    const stored = window.localStorage.getItem('bf.theme');
    theme = fromUrl === 'light' || fromUrl === 'dark' ? fromUrl : (stored === 'light' ? 'light' : 'dark');
  } catch { /* sem localStorage (janela privada, dados bloqueados): fica no padrão */ }
  document.documentElement.setAttribute('data-theme', theme);
}());
