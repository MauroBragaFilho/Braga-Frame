#!/usr/bin/env node
'use strict';

/**
 * Tira de um projeto do Braga Frame o que o USUÁRIO decidiu: um gabarito humano para o benchmark (scripts/benchmark-analise.js) e a taxa de aprovação das
 * sugestões. As decisões (aprovar, rejeitar) são a avaliação humana mais barata que existe: acontecem na revisão de qualquer jeito.
 *
 *   node scripts/exportar-gabarito.js --project <projeto.json> [--out <gabarito.json>] [--origin manual|auto|all] [--json]
 *
 * O que sai:
 *   - gabarito (--out): os cortes APROVADOS, no formato [{ s, e, t, o }] que o benchmark lê (o = origem: manual ou auto)
 *   - resumo: por origem, quantos cortes estão aprovados, rejeitados e pendentes, e a TAXA DE APROVAÇÃO das sugestões (aprovados / (aprovados + rejeitados),
 *     só entre as que o usuário já decidiu)
 *
 * COMO LER (o limite que importa): corte APROVADO que veio de uma sugestão (origem auto) só diz que a sugestão era boa (serve à precisão); não diz nada sobre o que
 * o motor deixou de achar. Para a REVOCAÇÃO o gabarito precisa ser feito SEM ver as sugestões: os cortes de origem manual (`--origin manual`), marcados
 * pelo usuário antes de rodar a análise, ou uma lista feita à mão. Misturar os dois infla a revocação (o motor "acerta" o que o próprio usuário aprovou dele).
 */

const fs = require('node:fs');

function readProject(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(new RegExp('^' + String.fromCharCode(0xFEFF)), ''));
  if (!data || !Array.isArray(data.cuts)) throw new Error('O arquivo não parece um projeto do Braga Frame (falta a lista "cuts").');
  return data;
}

/** { gold: [{ s, e, t, o }], summary: { <origem>: { approved, rejected, pending, approvalRate } , total } } */
function extract(project, { origin = 'all' } = {}) {
  const cuts = project.cuts.filter((c) => c && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  const by = {};
  for (const c of cuts) {
    const o = c.origin === 'auto' ? 'auto' : 'manual';
    by[o] = by[o] || { approved: 0, rejected: 0, pending: 0 };
    if (c.status === 'approved') by[o].approved += 1;
    else if (c.status === 'rejected') by[o].rejected += 1;
    else by[o].pending += 1;
  }
  for (const v of Object.values(by)) v.approvalRate = v.approved + v.rejected > 0 ? v.approved / (v.approved + v.rejected) : null;
  const wanted = (c) => origin === 'all' || (origin === 'auto' ? c.origin === 'auto' : c.origin !== 'auto');
  const gold = cuts.filter((c) => c.status === 'approved' && wanted(c)).map((c) => ({ s: c.start, e: c.end, t: String(c.title || ''), o: c.origin === 'auto' ? 'auto' : 'manual' }));
  return { gold, summary: by, total: cuts.length, duration: project.source && project.source.duration ? project.source.duration : null };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };
  const file = opt('project');
  if (!file || !fs.existsSync(file)) { console.error('Uso: node scripts/exportar-gabarito.js --project <projeto.json> [--out <gabarito.json>] [--origin manual|auto|all] [--json]'); process.exit(2); }
  const origin = opt('origin', 'all');
  if (!['manual', 'auto', 'all'].includes(origin)) { console.error('--origin: use manual, auto ou all.'); process.exit(2); }
  const out = extract(readProject(file), { origin });
  const target = opt('out');
  if (target) fs.writeFileSync(target, JSON.stringify(out.gold, null, 2));
  if (args.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`${out.total} cortes no projeto${out.duration ? ` (${Math.round(out.duration / 60)} min de vídeo)` : ''}`);
  for (const [o, v] of Object.entries(out.summary)) {
    console.log(`  origem ${o === 'auto' ? 'sugestão (auto)' : 'manual'}: ${v.approved} aprovados, ${v.rejected} rejeitados, ${v.pending} pendentes${v.approvalRate !== null ? ` · taxa de aprovação ${(v.approvalRate * 100).toFixed(1).replace('.', ',')}% (das decididas)` : ''}`);
  }
  console.log(`gabarito: ${out.gold.length} cortes aprovados (origem ${origin})${target ? ` -> ${target}` : ' (use --out para gravar)'}`);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { extract, readProject };
