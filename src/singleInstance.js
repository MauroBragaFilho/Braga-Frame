'use strict';

/**
 * Trava de instância única (por pasta de dados do usuário).
 *
 * Duas janelas no mesmo perfil disputariam os mesmos arquivos de estado: a fila (`queue.json`, com a recuperação que
 * marca como interrompido o que a outra janela ainda está exportando), os projetos (o último a gravar vence e a edição
 * da outra se perde), `profiles.json`, as preferências e o `.part` de uma exportação. Por isso só a primeira instância
 * continua; abrir o app de novo (um segundo clique no atalho) apenas traz a janela que já existe para a frente.
 * O Electron guarda a trava por `userData`, então perfis diferentes (os testes e2e em paralelo) não se atrapalham.
 *
 * @param {object} app o `app` do Electron (ou um falso nos testes): requestSingleInstanceLock, quit, on
 * @param {Function} onSecondInstance chamada na primeira instância quando o usuário tenta abrir outra, com { argv, workingDirectory,
 *   additionalData } da SEGUNDA (é assim que `BragaFrame.exe "vídeo.mp4"` chega à instância que já está aberta; veja src/host/cli.js)
 * @returns {boolean} true = esta é a instância principal e deve seguir; false = já havia outra, e este processo vai encerrar
 */
function setupSingleInstance(app, onSecondInstance) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on('second-instance', (_event, argv, workingDirectory, additionalData) => {
    try { onSecondInstance({ argv, workingDirectory, additionalData }); } catch { /* trazer a janela para a frente nunca pode derrubar o app */ }
  });
  return true;
}

/** Restaura (se minimizada), mostra e foca a janela. Sem janela, não faz nada. */
function focusWindow(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

module.exports = { setupSingleInstance, focusWindow };
