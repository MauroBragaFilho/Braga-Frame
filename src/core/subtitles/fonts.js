'use strict';

/**
 * Fontes oferecidas para a legenda e se cada uma existe de fato neste computador (Windows: confere a pasta de
 * fontes do sistema e a do usuário). Uma fonte que não existe aqui não é oferecida como se existisse: o libass cairia
 * numa fonte padrão e a legenda sairia diferente da prévia.
 */

const fs = require('node:fs');
const path = require('node:path');
const { FONT_CHOICES } = require('./shared');

/** Arquivos (nome em minúsculas) que cada fonte do Windows instala. */
const WINDOWS_FONT_FILES = Object.freeze({
  Arial: ['arial.ttf'],
  'Arial Black': ['ariblk.ttf'],
  Impact: ['impact.ttf'],
  'Segoe UI': ['segoeui.ttf'],
  'Segoe UI Black': ['seguibl.ttf'],
  Verdana: ['verdana.ttf'],
  Tahoma: ['tahoma.ttf'],
  'Trebuchet MS': ['trebuc.ttf'],
  Calibri: ['calibri.ttf'],
  Bahnschrift: ['bahnschrift.ttf'],
  'Comic Sans MS': ['comic.ttf'],
  Georgia: ['georgia.ttf'],
  Consolas: ['consola.ttf']
});

/** Pastas onde o Windows guarda fontes (sistema e usuário). */
function windowsFontDirs(env = process.env) {
  const dirs = [path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts')];
  if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));
  return dirs;
}

/**
 * @param {{ platform?:string, dirs?:string[] }} [opts]
 * @returns {Array<{ name:string, available:boolean }>}
 *   Fora do Windows não há como conferir sem o fontconfig: tudo vem como disponível e a escolha vale pelo nome.
 */
function listFonts({ platform = process.platform, dirs = windowsFontDirs() } = {}) {
  return FONT_CHOICES.map((name) => {
    if (platform !== 'win32') return { name, available: true };
    const files = WINDOWS_FONT_FILES[name] || [];
    const found = files.some((file) => dirs.some((dir) => { try { return fs.existsSync(path.join(dir, file)); } catch { return false; } }));
    return { name, available: found };
  });
}

module.exports = { listFonts, windowsFontDirs, WINDOWS_FONT_FILES };
