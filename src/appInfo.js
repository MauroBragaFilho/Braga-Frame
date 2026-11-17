'use strict';

/**
 * Identidade do app. "Braga Frame" é o nome de trabalho (ainda sem verificação de marca/domínio):
 * trocar o nome é mudar este arquivo, o título em renderer/index.html e o package.json.
 */
const appInfo = Object.freeze({
  name: 'Braga Frame',
  tagline: 'Cortes verticais para criadores: analisa, revisa e exporta (a publicação é sua).',
  appId: 'com.bragadev.bragaframe',
  repo: 'MauroBragaFilho/Braga-Frame' // onde as versões são publicadas (GitHub Releases): o aviso de versão nova consulta aqui
});

module.exports = appInfo;
