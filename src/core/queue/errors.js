'use strict';

/**
 * Erros da fila de exportação: classificação (recuperável ou não) e texto em português com causa e solução.
 * Contrato (docs/arquitetura.md, 3.3): só os códigos RECOVERABLE podem ser repetidos automaticamente.
 */

class QueueError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'QueueError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Falhas passageiras: a fila pode tentar de novo (limitado e com espera crescente). */
const RECOVERABLE = Object.freeze(['FFMPEG_START_FAILED', 'IO_BUSY', 'FFMPEG_CRASH', 'DISK_TRANSIENT']);

/** Falhas que repetir não resolve: vão direto para `failed`. (Qualquer código desconhecido também.) */
const NON_RECOVERABLE = Object.freeze([
  'INPUT_MISSING', 'INVALID_PROFILE', 'INVALID_RANGE', 'NO_DISK_SPACE', 'OUTPUT_EXISTS', 'CANCELLED', 'CODEC_UNSUPPORTED'
]);

/** Erros do sistema de arquivos que o motor de exportação eventualmente deixe passar, traduzidos para o contrato. */
const SYSTEM_CODES = Object.freeze({ ENOSPC: 'NO_DISK_SPACE', EBUSY: 'IO_BUSY', EAGAIN: 'IO_BUSY' });

const DEFAULT_MESSAGES = Object.freeze({
  FFMPEG_START_FAILED: 'Não foi possível iniciar o ffmpeg.',
  IO_BUSY: 'O arquivo ou a pasta está em uso por outro programa.',
  FFMPEG_CRASH: 'O ffmpeg encerrou de forma inesperada.',
  DISK_TRANSIENT: 'O disco falhou por um instante ao gravar o arquivo.',
  INPUT_MISSING: 'O vídeo de origem não foi encontrado.',
  INVALID_PROFILE: 'O perfil de exportação é inválido.',
  INVALID_RANGE: 'O início e o fim do corte são inválidos.',
  NO_DISK_SPACE: 'Não há espaço suficiente em disco para gravar o corte.',
  OUTPUT_EXISTS: 'Já existe um arquivo com este nome.',
  CODEC_UNSUPPORTED: 'O codec do perfil não é suportado por este FFmpeg.',
  NO_FFMPEG: 'O FFmpeg não foi encontrado.',
  RUNNER_UNAVAILABLE: 'O motor de exportação não está disponível.',
  RUNNER_BAD_RESULT: 'O motor de exportação terminou sem informar o arquivo gerado.',
  ABANDONED: 'O cancelamento não foi atendido a tempo.',
  UNKNOWN: 'A exportação falhou por um motivo inesperado.'
});

const SOLUTIONS = Object.freeze({
  FFMPEG_START_FAILED: 'Confira na aba Ferramentas se o FFmpeg está instalado e funcionando; se um antivírus bloqueou o programa, libere-o. A fila já tenta de novo sozinha algumas vezes.',
  IO_BUSY: 'Feche o programa que está usando o vídeo de origem ou a pasta de destino (player, editor, sincronização de nuvem) e tente de novo.',
  FFMPEG_CRASH: 'Se repetir, abra o vídeo de origem em outro programa para ver se o arquivo está íntegro e tente de novo.',
  DISK_TRANSIENT: 'Confira se a unidade de destino está conectada e com espaço livre e tente de novo.',
  INPUT_MISSING: 'Devolva o vídeo ao lugar original (ou reabra-o no app) e use Tentar de novo.',
  INVALID_PROFILE: 'Escolha outro perfil na aba Exportar e envie o corte para a fila de novo.',
  INVALID_RANGE: 'Ajuste o início e o fim do corte (o fim precisa ser maior que o início e caber no vídeo) e exporte de novo.',
  NO_DISK_SPACE: 'Libere espaço na unidade de destino ou escolha outra pasta na aba Exportar e use Tentar de novo.',
  OUTPUT_EXISTS: 'Mude "Se o arquivo já existir" nos Ajustes da fila para Perguntar ou Salvar com outro nome, ou apague/renomeie o arquivo existente.',
  CODEC_UNSUPPORTED: 'Escolha outro perfil (por exemplo H.264, ou codificação por software) na aba Exportar e exporte de novo.',
  NO_FFMPEG: 'Instale o FFmpeg pela página oficial (ffmpeg.org/download.html) e clique em Verificar de novo no aviso do topo; depois use Tentar de novo.',
  RUNNER_UNAVAILABLE: 'Atualize ou reinstale o Braga Frame; os trabalhos continuam na fila.',
  RUNNER_BAD_RESULT: 'Tente de novo; se repetir, avise o suporte com o horário da falha.',
  ABANDONED: 'O trabalho foi marcado como cancelado, mas o programa de codificação pode ter demorado a parar. Confira se não sobrou um arquivo temporário (terminado em .part) na pasta de destino.',
  UNKNOWN: 'Use Tentar de novo. Se repetir, abra o vídeo de origem em outro programa para conferir se o arquivo está íntegro.'
});

/**
 * Detalhes técnicos fixos de alguns códigos: a tela os mostra recolhidos em "Detalhes técnicos"; a mensagem e a solução
 * (linha principal) ficam em português simples, sem PATH, variável de ambiente nem extensão de arquivo.
 */
const TECHNICAL_HINTS = Object.freeze({
  NO_FFMPEG: 'O app procura o FFmpeg nas pastas do PATH do sistema ou no caminho da variável de ambiente CORTE_FFMPEG. Se você acabou de instalar ou de mexer no PATH, reabra o app.',
  ABANDONED: 'O arquivo temporário de uma exportação termina em .part e fica na pasta de destino, ao lado do vídeo de saída.'
});

/** Código no vocabulário do contrato (traduz erros crus do sistema de arquivos). */
function normalizeCode(err) {
  const raw = err && typeof err.code === 'string' && err.code ? err.code : '';
  if (SYSTEM_CODES[raw]) return SYSTEM_CODES[raw];
  return raw || 'UNKNOWN';
}

function isRecoverable(code) {
  return RECOVERABLE.includes(code);
}

/** Últimas linhas do stderr do ffmpeg (só para "detalhes técnicos"; nunca é a mensagem principal). */
function technicalOf(err) {
  const d = err && err.details;
  if (!d || typeof d !== 'object') return null;
  if (typeof d.stderr === 'string' && d.stderr.trim()) {
    const lines = d.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-4).join('\n');
    return lines.length > 600 ? lines.slice(-600) : lines;
  }
  if (d.exitCode !== undefined && d.exitCode !== null) return `código de saída ${d.exitCode}`;
  return null;
}

/** Qualquer erro -> { code, message, solution, recoverable, technical }. A mensagem do motor (já em português) tem prioridade. */
function describeError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const code = normalizeCode(e);
  const known = DEFAULT_MESSAGES[code] ? code : 'UNKNOWN';
  const solutionFromRunner = e.details && typeof e.details.solution === 'string' && e.details.solution ? e.details.solution : null;
  return {
    code,
    message: (typeof e.message === 'string' && e.message.trim()) || DEFAULT_MESSAGES[known],
    solution: solutionFromRunner || SOLUTIONS[code] || SOLUTIONS[known],
    recoverable: !e.noRetry && isRecoverable(code),
    technical: technicalOf(e) || TECHNICAL_HINTS[code] || null
  };
}

/** Erro de pré-verificação (qc.preflight) -> mesmo formato de describeError. */
function describePreflight(item) {
  const code = (item && typeof item.code === 'string' && item.code) || 'PREFLIGHT';
  return {
    code,
    message: (item && item.message) || 'A verificação prévia encontrou um problema.',
    solution: (item && item.solution) || SOLUTIONS[code] || 'Corrija o problema indicado e use Tentar de novo.',
    recoverable: false,
    technical: null
  };
}

module.exports = { QueueError, RECOVERABLE, NON_RECOVERABLE, SOLUTIONS, DEFAULT_MESSAGES, TECHNICAL_HINTS, describeError, describePreflight, isRecoverable, normalizeCode };
