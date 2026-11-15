'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Preferences } = require('../../core/preferences');
const { cleanName, projectScopeNames } = require('../../core/preferences/scope');
const { findMatches } = require('../../core/projects/matcher');
const { compareSource, describeComparison, knownDuration } = require('../../core/projects/compare');
const { probeMedia } = require('../../core/ffmpeg/probe');

const MAX_SUGGESTIONS = 3;

function problem(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Perfis de exportação para o seletor (embutidos + do usuário). Sem o módulo de exportação, a lista padrão. */
function profileOptions(ctx) {
  try {
    const profiles = require('../../core/export/profiles');
    const store = new profiles.ProfileStore(path.join(ctx.paths.userData, 'profiles.json'));
    return profiles.allProfiles(store).map((p) => ({ id: p.id, name: p.name }));
  } catch {
    const out = [];
    for (const kind of ['vertical', 'horizontal']) {
      for (const res of ['1080', '1440', '2160']) {
        for (const codec of ['h264', 'h265']) out.push({ id: `${kind}-${res}-${codec}`, name: `${kind === 'vertical' ? 'Vertical 9:16' : 'Horizontal 16:9'} · ${res}p · ${codec === 'h264' ? 'H.264' : 'H.265'}` });
      }
    }
    return out;
  }
}

/** Mensagens do chat salvo com o projeto (para "chat novo"); sem chat legível, undefined. */
function chatInfo(project) {
  if (!project || !project.chat || typeof project.chat.path !== 'string' || !project.chat.path) return undefined;
  try {
    const { readChatSync } = require('../../core/sources/chatFormat');
    const chat = readChatSync(project.chat.path);
    const oldEnd = knownDuration(project.source);
    return {
      recorded: Number(project.chat.count) || 0,
      actual: chat.messages.length,
      afterOldEnd: oldEnd > 0 ? chat.messages.filter((m) => m.t > oldEnd).length : 0
    };
  } catch {
    return undefined;
  }
}

/**
 * Compara o arquivo que está abrindo com o projeto de uma live parecida (a melhor correspondência): o vídeo mudou de
 * duração/tamanho, ficam cortes fora do novo intervalo? Sem projeto legível, sem cortes ou sem diferença: null.
 * O chat não entra (a adoção não o leva), então só duração, tamanho, resolução e cortes.
 */
function compareWithMatch(ctx, projectId, incoming) {
  let project = null;
  try { project = ctx.projectStore.loadById(projectId); } catch { project = null; }
  if (!project || !project.cuts.length) return null;
  const comparison = compareSource(project, incoming);
  if (!comparison.changed && !comparison.cuts.outside.length) return null;
  return comparison;
}

function register(ctx) {
  // nome do perfil de exportação para os textos do histórico e dos avisos (sem ele, apareceria o id técnico)
  const profileName = (id) => {
    const hit = profileOptions(ctx).find((p) => p.id === id);
    return hit ? hit.name : null;
  };
  const prefs = new Preferences({ dir: ctx.paths.userData, log: (level, msg) => ctx.log(level, `prefs: ${msg}`), profileName });
  ctx.preferences = prefs; // atalho para outros módulos do processo principal (opcional)

  const scopeNames = (p) => ({ game: cleanName(p && p.game), channel: cleanName(p && p.channel) });
  const changed = (what, extra = {}) => ctx.bus.emit('prefs:changed', { what, ...extra });

  // esquema das chaves + perfis de exportação + avisos de arquivos recuperados (ilegíveis, preservados como .corrupt)
  ctx.handle('prefs:schema', () => ({ ...prefs.schema(), profiles: profileOptions(ctx), notices: prefs.notices }));

  // valores em vigor para um projeto (jogo/canal) e de onde cada um vem
  ctx.handle('prefs:resolve', (payload) => ({ ...prefs.resolve(scopeNames(payload)), scope: scopeNames(payload) }));

  ctx.handle('prefs:get', ({ key, ...rest }) => ({ key, ...prefs.explain(key, scopeNames(rest)) }));

  ctx.handle('prefs:set', ({ scope, key, value }) => {
    const res = prefs.set(scope, key, value);
    if (res.changed) changed('set', { key, scope });
    return res;
  });

  ctx.handle('prefs:unset', ({ scope, key }) => {
    const res = prefs.unset(scope, key);
    if (res.changed) changed('unset', { key, scope });
    return res;
  });

  ctx.handle('prefs:list', ({ scope }) => prefs.list(scope));

  // nomes de jogos e canais conhecidos (preferências, aprendizado e projetos salvos), para sugestões
  let projectList = { at: 0, value: [] }; // ler todos os projetos custa: a lista de nomes aceita 3 s de atraso
  ctx.handle('prefs:names', () => {
    const known = prefs.names();
    const games = new Map(known.games.map((n) => [n.toLowerCase(), n]));
    const channels = new Map(known.channels.map((n) => [n.toLowerCase(), n]));
    if (Date.now() - projectList.at > 3000) projectList = { at: Date.now(), value: ctx.projectStore.list() };
    for (const summary of projectList.value) {
      const names = projectScopeNames(summary);
      if (names.game && !games.has(names.game.toLowerCase())) games.set(names.game.toLowerCase(), names.game);
      if (names.channel && !channels.has(names.channel.toLowerCase())) channels.set(names.channel.toLowerCase(), names.channel);
    }
    const sorted = (map) => [...map.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { games: sorted(games), channels: sorted(channels) };
  });

  // aprendizado: estado atual de cortes decididos -> { changes } (o que passou a valer agora)
  // `onlyKnown`: desfazer/refazer/restaurar só corrigem o que já era observado (nunca criam evidência nova)
  ctx.handle('prefs:observe', ({ projectId, game, channel, cuts, onlyKnown }) => {
    if (typeof projectId !== 'string' || !projectId) throw problem('INVALID_ARGS', 'Informe o projeto observado.');
    const res = prefs.observe({ projectId, game: cleanName(game), channel: cleanName(channel), cuts, onlyKnown: onlyKnown === true });
    if (res.changes.length) changed('learned', { keys: res.changes.map((c) => c.key) });
    return res;
  });

  ctx.handle('prefs:learned', (payload) => prefs.learnedView(scopeNames(payload)));

  ctx.handle('prefs:learnedSet', ({ id, ...patch }) => {
    if (typeof id !== 'string' || !id) throw problem('INVALID_ARGS', 'Informe a preferência aprendida.');
    const res = prefs.setLearned(id, patch);
    if (res.changed) changed('learnedSet', { id });
    return res;
  });

  ctx.handle('prefs:learning', (payload) => {
    const res = prefs.learning(payload && (payload.enabled !== undefined || payload.minEvidence !== undefined) ? payload : undefined);
    if (payload && (payload.enabled !== undefined || payload.minEvidence !== undefined)) changed('learning');
    return res;
  });

  ctx.handle('prefs:history', ({ limit }) => ({ entries: prefs.history(limit) }));

  ctx.handle('prefs:revert', ({ id }) => {
    const res = prefs.revert(id);
    changed('revert', { id });
    return res;
  });

  ctx.handle('prefs:forget', () => {
    const res = prefs.forget();
    changed('forget');
    return res;
  });

  /**
   * Antes de abrir um vídeo: o que o app já sabe sobre ele.
   *  - own: projeto salvo para este mesmo caminho;
   *  - compare: o arquivo mudou desde a última análise (duração/tamanho) e o projeto tem cortes;
   *  - matches: lives já analisadas parecidas (só quando o caminho ainda não tem trabalho salvo); cada uma traz
   *    `compare` (a mesma comparação, do arquivo novo contra o projeto parecido) quando o vídeo difere do analisado.
   * Não grava nada.
   */
  ctx.handle('prefs:inspect', async ({ path: file, origin }) => {
    if (typeof file !== 'string' || !file) throw problem('INVALID_PATH', 'Informe o caminho do vídeo.');
    const resolved = path.resolve(file);
    const originScope = scopeNames(origin || {});
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { stat = null; }
    if (!stat || !stat.isFile()) return { exists: false, own: null, matches: [], compare: null, scope: originScope };

    let probe = null;
    let probeError = null;
    if (ctx.tools.ffprobe) {
      try { probe = await probeMedia(ctx.tools.ffprobe, resolved); } catch (err) { probeError = err.message; }
    } else {
      probeError = 'ffprobe não encontrado';
    }
    const incoming = {
      path: resolved,
      size: (probe && probe.size) || stat.size,
      duration: probe && probe.duration > 0 ? probe.duration : null,
      width: probe ? probe.width : 0,
      height: probe ? probe.height : 0,
      origin: origin && typeof origin === 'object' ? origin : null
    };

    let ownProject = null;
    try { ownProject = ctx.projectStore.load(resolved); } catch { ownProject = null; } // versão não suportada etc.: quem avisa é o source:open

    const result = {
      exists: true,
      file: { path: resolved, name: path.basename(resolved), size: incoming.size, duration: incoming.duration, probeError },
      own: null, matches: [], compare: null, scope: originScope
    };

    if (ownProject) {
      const names = projectScopeNames(ownProject);
      result.scope = { game: names.game || originScope.game, channel: names.channel || originScope.channel };
      result.own = {
        id: ownProject.id, cutCount: ownProject.cuts.length, source: ownProject.source,
        decided: Boolean(ownProject.ext && ownProject.ext.prefs && ownProject.ext.prefs.match)
      };
      if (ownProject.cuts.length > 0 && probe) {
        const comparison = compareSource(ownProject, incoming, { chat: chatInfo(ownProject) });
        if (comparison.changed) {
          result.compare = { ...comparison, ...describeComparison(comparison, path.basename(resolved)), before: ownProject.source };
        }
      }
    }

    const shouldMatch = !ownProject || (ownProject.cuts.length === 0 && !result.own.decided);
    if (shouldMatch) {
      const found = findMatches(incoming, ctx.projectStore.list()).slice(0, MAX_SUGGESTIONS);
      result.matches = found.map((m) => ({
        level: m.level, score: m.score, reasons: m.reasons, label: m.label, cutCount: m.cutCount,
        compare: probe ? compareWithMatch(ctx, m.project.id, incoming) : null, // sem ffprobe não há duração para comparar
        project: {
          id: m.project.id, sourcePath: m.project.source.path, sourceExists: fs.existsSync(m.project.source.path), meta: m.project.meta, origin: m.project.source.origin || null,
          counts: m.project.counts, updatedAt: m.project.updatedAt
        }
      }));
      if (found.length) {
        const names = projectScopeNames(found[0].project);
        result.matchScope = { game: names.game, channel: names.channel };
      }
    }
    return result;
  });
}

module.exports = { register };
