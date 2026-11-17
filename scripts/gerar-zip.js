'use strict';

// Gera dist/braga-frame-codigo-AAAAMMDD-HHMM.zip com o codigo atual (inclusive
// alteracoes ainda nao commitadas) para enviar a outra IA analisar.
// Usa a lista do git (rastreados + novos nao ignorados), entao node_modules,
// dist, logs e .tmp ficam de fora. Binarios, lockfile e arquivos com cara de
// segredo tambem sao excluidos.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const raiz = path.resolve(__dirname, '..');

const EXTENSOES_BINARIAS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf',
  '.mp4', '.mkv', '.mov', '.mp3', '.wav', '.zip', '.exe', '.dll',
]);
const NOMES_EXCLUIDOS = new Set(['package-lock.json']);
const PADRAO_SEGREDO = /(^|\/)(\.env(\..*)?|.*\.(pem|key|pfx|p12)|.*secret.*|.*credentials.*)$/i;

function listarArquivos() {
  const saida = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: raiz,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(saida.split('\0').filter(Boolean))].filter((rel) => {
    if (!fs.existsSync(path.join(raiz, rel))) return false; // apagado e ainda nao commitado
    const ext = path.extname(rel).toLowerCase();
    if (EXTENSOES_BINARIAS.has(ext)) return false;
    if (NOMES_EXCLUIDOS.has(path.basename(rel))) return false;
    if (PADRAO_SEGREDO.test(rel)) return false;
    return true;
  });
}

function carimbo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function main() {
  const arquivos = listarArquivos();
  if (!arquivos.length) throw new Error('Nenhum arquivo encontrado (isto e um repositorio git?).');

  const destinoDir = path.join(raiz, 'dist');
  fs.mkdirSync(destinoDir, { recursive: true });
  const zip = path.join(destinoDir, `braga-frame-codigo-${carimbo()}.zip`);
  const lista = path.join(destinoDir, '.zip-lista.txt');
  fs.writeFileSync(lista, arquivos.join('\n') + '\n', 'utf8');

  try {
    const tarExe = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe')
      : 'tar';
    // tar.exe do Windows 10+ (bsdtar) cria .zip com -a; caminhos ficam relativos a raiz.
    execFileSync(tarExe, ['-a', '-cf', zip, '-C', raiz, '-T', lista], { stdio: 'inherit' });
  } finally {
    fs.rmSync(lista, { force: true });
  }

  const kb = Math.round(fs.statSync(zip).size / 1024);
  console.log(`\nZip gerado: ${zip}`);
  console.log(`${arquivos.length} arquivos, ${kb} KB.`);
  return zip;
}

let zip;
try {
  zip = main();
} catch (erro) {
  console.error(`Falha ao gerar o zip: ${erro.message}`);
  process.exit(1);
}
if (process.argv.includes('--abrir') && process.platform === 'win32') {
  // explorer.exe devolve codigo 1 mesmo funcionando; ignora o resultado.
  require('node:child_process').spawnSync('explorer.exe', [`/select,${zip}`], { stdio: 'ignore' });
}
