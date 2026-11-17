'use strict';

/**
 * Assinatura digital (Authenticode) de um instalador, só para DECIDIR e MOSTRAR (dono: base; docs/atualizacao.md). Lê com o `Get-AuthenticodeSignature` do
 * PowerShell do Windows (sem executar o arquivo). Nunca lança: qualquer falha vira `status: 'Unknown'`.
 *
 * Política (trustPolicy), com `running` = a assinatura do programa em uso:
 *   - instalador com assinatura INVÁLIDA (adulterado, cadeia não confiável…): recusa sempre;
 *   - instalador SEM assinatura e programa em uso ASSINADO: recusa (rebaixamento: quem hoje é assinado não aceita atualização sem assinatura);
 *   - instalador assinado por OUTRO emissor que o do programa em uso (ambos assinados): recusa;
 *   - o resto vale: os dois sem assinatura (hoje, como a v0.1.0: o texto avisa para conferir o SHA-256), primeira versão assinada, mesma assinatura.
 */

const { execFile } = require('node:child_process');

const PS_SCRIPT = "$s = Get-AuthenticodeSignature -LiteralPath $env:BF_SIG_FILE; [pscustomobject]@{ status = [string]$s.Status; subject = $(if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }) } | ConvertTo-Json -Compress";

/** { status: 'Valid'|'NotSigned'|'HashMismatch'|'NotTrusted'|…|'Unknown'|'Unsupported', subject: string|null }; nunca lança. */
function readSignature(file, { exec = execFile, platform = process.platform, timeoutMs = 30000 } = {}) {
  if (platform !== 'win32') return Promise.resolve({ status: 'Unsupported', subject: null });
  return new Promise((resolve) => {
    try {
      exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
        { env: { ...process.env, BF_SIG_FILE: String(file) }, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve({ status: 'Unknown', subject: null });
          try {
            const parsed = JSON.parse(String(stdout).trim());
            resolve({ status: typeof parsed.status === 'string' && parsed.status ? parsed.status : 'Unknown', subject: typeof parsed.subject === 'string' ? parsed.subject : null });
          } catch { resolve({ status: 'Unknown', subject: null }); }
        });
    } catch { resolve({ status: 'Unknown', subject: null }); }
  });
}

/** O nome comum (CN) do emissor: "CN=SignPath Foundation, O=…" -> "SignPath Foundation". */
function signerName(subject) {
  const m = /(?:^|,\s*)CN=("([^"]+)"|[^,]+)/i.exec(String(subject || ''));
  return m ? (m[2] || m[1]).trim() : null;
}

const isValid = (s) => Boolean(s) && s.status === 'Valid';
/** Sem assinatura, ou que não deu para ler (PowerShell indisponível…): tratado como "sem assinatura". */
const isUnsigned = (s) => !s || ['NotSigned', 'Unknown', 'Unsupported'].includes(s.status);

/** @returns {{ allow: boolean, reason?: 'INVALID_SIGNATURE'|'DOWNGRADE'|'SIGNER_CHANGED' }} */
function trustPolicy(next, running) {
  if (isValid(next)) {
    const changed = isValid(running) && running.subject && next.subject && running.subject !== next.subject;
    return changed ? { allow: false, reason: 'SIGNER_CHANGED' } : { allow: true };
  }
  if (isUnsigned(next)) return isValid(running) ? { allow: false, reason: 'DOWNGRADE' } : { allow: true };
  return { allow: false, reason: 'INVALID_SIGNATURE' }; // assinatura presente mas inválida (adulterada, cadeia não confiável…)
}

const REASONS = Object.freeze({
  INVALID_SIGNATURE: 'A atualização foi recusada: a assinatura digital do instalador é inválida. Nada foi instalado.',
  DOWNGRADE: 'A atualização foi recusada: o Braga Frame em uso tem assinatura digital e o instalador baixado não. Nada foi instalado.',
  SIGNER_CHANGED: 'A atualização foi recusada: o instalador foi assinado por um emissor diferente do que assinou o Braga Frame em uso. Nada foi instalado.'
});

/** A assinatura em palavras para a tela. */
function describeSignature(sig) {
  if (!sig) return '';
  if (sig.status === 'Valid') {
    const who = signerName(sig.subject);
    return who ? `Assinatura digital válida (${who}).` : 'Assinatura digital válida.';
  }
  if (sig.status === 'NotSigned') return 'Sem assinatura digital: a conferência é o SHA-256, que bate com o da Release.';
  if (sig.status === 'Unknown' || sig.status === 'Unsupported') return 'Assinatura digital não verificada: a conferência é o SHA-256, que bate com o da Release.';
  return 'Assinatura digital inválida.';
}

module.exports = { readSignature, signerName, trustPolicy, describeSignature, REASONS };
