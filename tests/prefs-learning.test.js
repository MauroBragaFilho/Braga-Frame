'use strict';

/**
 * Aprendizado: acumula o estado dos cortes decididos, propõe preferências por escopo com evidência legível,
 * só vale com evidência mínima e pode ser consultado, editado, desativado e desfeito. Arquivos reais em pasta temporária.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Preferences } = require('../src/core/preferences');
const learning = require('../src/core/preferences/learning');
const { LearnedStore } = require('../src/core/preferences/learnedStore');
const { mkTmp, rm, clock, cutsOf, cutState } = require('./prefs-helpers');

const G = { type: 'general' };
const DURATIONS = [30, 34, 36, 40, 44, 50]; // mediana 38 -> mín 19, máx 57

function withPrefs(fn, opts = {}) {
  const dir = mkTmp('prefs-learn');
  try { return fn(new Preferences({ dir, now: clock(), ...opts }), dir); } finally { rm(dir); }
}

const observe = (p, cuts, extra = {}) => p.observe({ projectId: 'proj0000000001', game: '', channel: '', cuts, ...extra });
const view = (p, names) => p.learnedView(names || {});
const item = (p, key, names) => view(p, names).items.find((i) => i.key === key);

// ---------- funções puras ----------

test('quantis e faixa de duração: o miolo das aprovações sempre cabe', () => {
  assert.equal(learning.quantile([10, 20, 30, 40], 0.5), 25);
  assert.equal(learning.median([5, 1, 3]), 3);
  const r = learning.durationRange(DURATIONS);
  assert.equal(r.median, 38);
  assert.deepEqual([r.min, r.max], [19, 57]);
  // durações muito curtas e muito longas respeitam os limites
  const tiny = learning.durationRange([2, 2, 2, 2, 2]);
  assert.equal(tiny.min, 3);
  assert.ok(tiny.max >= tiny.min + 5);
  assert.ok(learning.durationRange([900, 900, 900, 900, 900]).max <= 600);
  // faixa sempre contém o 1º e o 3º quartis
  const skew = learning.durationRange([10, 12, 14, 50, 55, 58, 60]);
  assert.ok(skew.min <= 14 && skew.max >= 55);
});

// ---------- evidência mínima ----------

test('abaixo da evidência mínima nada vale: a sugestão fica "aguardando" com a contagem', () => {
  withPrefs((p) => {
    const res = observe(p, cutsOf(DURATIONS.slice(0, 4)));
    assert.deepEqual(res.changes, [], 'nada foi anunciado');
    const max = item(p, 'analysis.maxDurationSec');
    assert.equal(max.state, 'waiting');
    assert.equal(max.n, 4);
    assert.equal(max.needed, 5);
    assert.equal(p.get('analysis.maxDurationSec', {}), 60, 'continua o padrão');
    assert.equal(p.explain('analysis.maxDurationSec', {}).source, 'default');
    assert.equal(p.history().length, 0, 'sem evidência não há efeito, então não há histórico');
  });
});

test('ao atingir N=5 a preferência passa a valer, marcada como aprendida, com evidência legível', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS.slice(0, 4)));
    const res = observe(p, cutsOf([DURATIONS[4]]));
    assert.equal(res.changes.length, 2, 'mínima e máxima');
    const maxChange = res.changes.find((c) => c.key === 'analysis.maxDurationSec');
    assert.equal(maxChange.fresh, true);
    assert.match(maxChange.text, /Duração máxima.*geral/);

    const max = item(p, 'analysis.maxDurationSec');
    assert.equal(max.state, 'active');
    assert.equal(max.evidence, '5 cortes aprovados, mediana 36 s');
    assert.equal(max.value, 54); // mediana 36 -> 1,5x = 54
    const ex = p.explain('analysis.maxDurationSec', {});
    assert.equal(ex.source, 'learned');
    assert.equal(ex.scope, 'general');
    assert.equal(ex.value, 54);
    assert.equal(ex.label, 'aprendida · geral');
    assert.match(ex.evidence, /5 cortes aprovados, mediana 36 s/);
    assert.equal(p.get('analysis.maxDurationSec', {}), 54);

    const h = p.history();
    assert.equal(h.length, 2);
    assert.ok(h.every((e) => e.auto === true && e.kind === 'learned'));
    assert.match(h[0].label, /^Nova preferência aprendida: .*5 cortes aprovados, mediana 36 s/);
  });
});

test('evidência mínima é configurável (3 a 100), registrada no histórico, e ao baixar passa a valer o que já havia', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS.slice(0, 4)));
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'waiting');
    const res = p.learning({ minEvidence: 4 });
    assert.equal(res.minEvidence, 4);
    assert.equal(res.changes.length, 2, 'com 4 cortes já basta: o que passou a valer é anunciado');
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'active');
    assert.ok(p.history().some((e) => /Evidência mínima para aprender: 5 → 4/.test(e.label)));
    for (const bad of [2, 101, 4.5, 'x']) assert.throws(() => p.learning({ minEvidence: bad }), (err) => err.code === 'INVALID_VALUE', String(bad));
    assert.equal(p.learning().minEvidence, 4);
    p.learning({ minEvidence: 9 });
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'waiting', 'subir a exigência tira a preferência de vigor');
    assert.equal(p.get('analysis.maxDurationSec', {}), 60);
  });
});

test('contar o mesmo corte duas vezes não aumenta a evidência (estado, não evento)', () => {
  withPrefs((p) => {
    const cuts = cutsOf([30, 34, 36, 40]);
    observe(p, cuts);
    observe(p, cuts); // aprovou de novo
    observe(p, cuts.map((c) => ({ id: c.id, state: { ...c.state } })));
    assert.equal(item(p, 'analysis.maxDurationSec').n, 4);
    // redefinir (voltou a pendente, sem categoria) tira o corte da contagem
    observe(p, [{ id: cuts[0].id, state: cutState({ status: 'pending' }) }]);
    assert.equal(item(p, 'analysis.maxDurationSec').n, 3);
    // remover o corte também
    observe(p, [{ id: cuts[1].id, state: null }]);
    assert.equal(item(p, 'analysis.maxDurationSec').n, 2);
    // ajustar o tempo atualiza a duração
    observe(p, [{ id: cuts[2].id, state: cutState({ duration: 100 }) }]);
    assert.match(item(p, 'analysis.maxDurationSec').evidence, /2 cortes aprovados, mediana 70 s/);
  });
});

// ---------- escopos ----------

test('aprende por escopo: geral, jogo e canal, cada um com a sua evidência', () => {
  withPrefs((p) => {
    observe(p, cutsOf([20, 22, 24, 26, 28]), { projectId: 'proj0000000001', game: 'Valorant', channel: 'Fulano' });
    observe(p, cutsOf([70, 80, 90, 100, 110]), { projectId: 'proj0000000002', game: 'Minecraft', channel: 'Beltrano' });

    const names = { game: 'Valorant', channel: 'Fulano' };
    const items = view(p, names).items.filter((i) => i.key === 'analysis.maxDurationSec');
    assert.deepEqual(items.map((i) => i.scope.type), ['channel', 'game', 'general']);
    const byScope = Object.fromEntries(items.map((i) => [i.scope.type, i]));
    assert.match(byScope.game.evidence, /5 cortes aprovados, mediana 24 s/);
    assert.match(byScope.channel.evidence, /5 cortes aprovados, mediana 24 s/);
    assert.match(byScope.general.evidence, /10 cortes aprovados/);
    assert.equal(byScope.game.scope.name, 'Valorant');

    // a prioridade vale também para o aprendido: canal > jogo > geral
    assert.equal(p.explain('analysis.maxDurationSec', names).scope, 'channel');
    assert.equal(p.explain('analysis.maxDurationSec', { game: 'Valorant' }).scope, 'game');
    assert.equal(p.get('analysis.maxDurationSec', { game: 'Valorant' }), 36); // 1,5 x 24
    assert.equal(p.explain('analysis.maxDurationSec', { game: 'Outro' }).scope, 'general');
    // jogo sem observações não tem item próprio
    assert.equal(view(p, { game: 'Outro' }).items.filter((i) => i.scope.type === 'game').length, 0);
  });
});

test('proposta de jogo/canal idêntica à geral (mesmos cortes, mesmo valor) não é listada; passa a aparecer quando difere', () => {
  withPrefs((p) => {
    observe(p, cutsOf([20, 22, 24, 26, 28]), { projectId: 'proj0000000001', game: 'Valorant', channel: 'Fulano' });
    const names = { game: 'Valorant', channel: 'Fulano' };
    const only = view(p, names).items.filter((i) => i.key === 'analysis.maxDurationSec');
    assert.deepEqual(only.map((i) => i.scope.type), ['general'], 'um projeto só: jogo e canal repetiriam a geral');
    assert.equal(p.explain('analysis.maxDurationSec', names).scope, 'general');
    assert.equal(p.history().filter((e) => e.key === 'analysis.maxDurationSec').length, 1, 'e não geram entradas repetidas no histórico');
    // outro jogo muda a geral: a de Valorant passa a ser diferente e aparece
    observe(p, cutsOf([70, 80, 90, 100, 110]), { projectId: 'proj0000000002', game: 'Minecraft', channel: 'Beltrano' });
    const now = view(p, names).items.filter((i) => i.key === 'analysis.maxDurationSec').map((i) => i.scope.type);
    assert.deepEqual(now, ['channel', 'game', 'general']);
  });
});

test('valor do usuário no mesmo escopo vence o aprendido; aprendido mais específico vence o geral do usuário', () => {
  withPrefs((p) => {
    observe(p, cutsOf([20, 22, 24, 26, 28]), { projectId: 'proj0000000001', game: 'Valorant' });
    observe(p, cutsOf([70, 80, 90, 100, 110]), { projectId: 'proj0000000002', game: 'Minecraft' });
    p.set(G, 'analysis.maxDurationSec', 90);
    // aprendido do jogo (36 s) é mais específico que o geral definido pelo usuário (90 s)
    let ex = p.explain('analysis.maxDurationSec', { game: 'Valorant' });
    assert.deepEqual([ex.scope, ex.source, ex.value], ['game', 'learned', 36]);
    // sem o jogo no projeto, vale o geral do usuário
    ex = p.explain('analysis.maxDurationSec', {});
    assert.deepEqual([ex.scope, ex.source, ex.value], ['general', 'explicit', 90]);
    // no MESMO escopo o valor do usuário ganha do aprendido
    p.set({ type: 'game', name: 'Valorant' }, 'analysis.maxDurationSec', 45);
    ex = p.explain('analysis.maxDurationSec', { game: 'Valorant' });
    assert.deepEqual([ex.scope, ex.source, ex.value], ['game', 'explicit', 45]);
  });
});

// ---------- desativar, editar, desfazer ----------

test('desativar uma preferência aprendida tira do efeito, aparece como desativada e pode ser religada', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS));
    const before = item(p, 'analysis.maxDurationSec');
    assert.equal(before.state, 'active');
    const off = p.setLearned(before.id, { enabled: false });
    assert.equal(off.changed, true);
    assert.match(off.entry.label, /Desativou a preferência aprendida "Duração máxima" \(geral\)/);
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'disabled');
    assert.equal(p.explain('analysis.maxDurationSec', {}).source, 'default');
    assert.equal(p.get('analysis.maxDurationSec', {}), 60);
    assert.equal(p.get('analysis.minDurationSec', {}), 19, 'só a desativada saiu; as outras seguem');
    // novas decisões não reativam sozinhas nem anunciam de novo
    const res = observe(p, cutsOf([46, 48]));
    assert.equal(res.changes.some((c) => c.key === 'analysis.maxDurationSec'), false);
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'disabled');
    assert.equal(p.setLearned(before.id, { enabled: false }).changed, false, 'repetir não muda');
    p.setLearned(before.id, { enabled: true });
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'active');
  });
});

test('editar o valor aprendido: vale o editado (marcado como editado) e "restore" volta ao calculado', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS));
    const id = item(p, 'analysis.maxDurationSec').id;
    assert.throws(() => p.setLearned(id, { value: 9999 }), (err) => err.code === 'INVALID_VALUE');
    const edited = p.setLearned(id, { value: 75 });
    assert.match(edited.entry.label, /Editou a preferência aprendida "Duração máxima" \(geral\): 57 s → 75 s/);
    const it = item(p, 'analysis.maxDurationSec');
    assert.equal(it.edited, true);
    assert.equal(it.value, 75);
    assert.equal(it.computed, 57);
    assert.equal(p.explain('analysis.maxDurationSec', {}).source, 'learned');
    assert.equal(p.get('analysis.maxDurationSec', {}), 75);
    // novas decisões atualizam o calculado, mas não passam por cima do que o usuário editou
    observe(p, cutsOf([60, 62, 64]));
    assert.equal(p.get('analysis.maxDurationSec', {}), 75);
    assert.notEqual(item(p, 'analysis.maxDurationSec').computed, 57);
    const back = p.setLearned(id, { restore: true });
    assert.match(back.entry.label, /Voltou ao valor aprendido/);
    assert.equal(item(p, 'analysis.maxDurationSec').edited, false);
    assert.equal(p.get('analysis.maxDurationSec', {}), item(p, 'analysis.maxDurationSec').computed);
    assert.equal(p.setLearned(id, { restore: true }).changed, false);
  });
});

test('desfazer pelo histórico: a entrada automática desativa; a de desativar reativa; a de editar restaura', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS));
    const auto = p.history().find((e) => e.auto && e.key === 'analysis.maxDurationSec');
    p.revert(auto.id);
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'disabled', 'desfazer o aprendizado desliga aquele item');
    assert.equal(p.get('analysis.maxDurationSec', {}), 60);
    const offEntry = p.history()[0];
    assert.match(offEntry.label, /^Desfez: Nova preferência aprendida/);
    p.revert(offEntry.id);
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'active', 'desfazer o desfazer religa');

    const id = item(p, 'analysis.maxDurationSec').id;
    const e = p.setLearned(id, { value: 80 }).entry;
    p.revert(e.id);
    assert.equal(item(p, 'analysis.maxDurationSec').edited, false);
    assert.equal(p.get('analysis.maxDurationSec', {}), 57);
  });
});

test('chave geral "aprender com minhas decisões": desligada, nada novo é observado e nada aprendido vale', () => {
  withPrefs((p) => {
    observe(p, cutsOf(DURATIONS));
    assert.equal(p.get('analysis.maxDurationSec', {}), 57);
    const off = p.learning({ enabled: false });
    assert.equal(off.enabled, false);
    assert.equal(p.get('analysis.maxDurationSec', {}), 60, 'tudo aprendido deixa de valer');
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'paused');
    const observed = p.learnedView().observed;
    const res = observe(p, cutsOf([10, 11, 12, 13, 14, 15]));
    assert.equal(res.ignored, true);
    assert.equal(p.learnedView().observed, observed, 'nada foi guardado enquanto estava desligado');
    assert.match(p.history()[0].label, /Desligou "Aprender com minhas decisões"/);
    // religar devolve o efeito; desfazer o desligar também
    p.revert(p.history()[0].id);
    assert.equal(p.learnedView().enabled, true);
    assert.equal(p.get('analysis.maxDurationSec', {}), 57);
    assert.throws(() => p.learning({ enabled: 'sim' }), (err) => err.code === 'INVALID_VALUE');
  });
});

test('esquecer apaga observações e estados, registra no histórico e não é reversível', () => {
  withPrefs((p, dir) => {
    observe(p, cutsOf(DURATIONS));
    p.setLearned(item(p, 'analysis.maxDurationSec').id, { enabled: false });
    const res = p.forget();
    assert.equal(res.forgotten, DURATIONS.length);
    assert.equal(p.learnedView().observed, 0);
    assert.deepEqual(p.learnedView().items, []);
    const last = p.history()[0];
    assert.equal(last.revertible, false);
    assert.throws(() => p.revert(last.id), (err) => err.code === 'NOT_REVERSIBLE');
    assert.equal(new Preferences({ dir }).learnedView().observed, 0, 'também no disco');
  });
});

// ---------- o que é aprendido ----------

test('relevância mínima: o maior limite abaixo do qual a maioria foi rejeitada', () => {
  withPrefs((p) => {
    const auto = (rel, status) => ({ id: `r${rel}${status}`, state: cutState({ origin: 'auto', relevance: rel, status, duration: 30 }) });
    const cuts = [
      ...[0.1, 0.2, 0.25, 0.3, 0.35].map((r) => auto(r, 'rejected')),
      ...[0.45, 0.5, 0.6, 0.7, 0.9].map((r) => auto(r, 'approved'))
    ];
    observe(p, cuts);
    const it = item(p, 'analysis.minRelevance');
    assert.equal(it.state, 'active');
    assert.equal(it.value, 0.6);
    assert.equal(it.evidence, '5 de 7 cortes com relevância abaixo de 60% foram rejeitados (71%)');
    assert.equal(p.get('analysis.minRelevance', {}), 0.6);
  });
});

test('relevância: quem rejeita tudo não gera limite; faltando decisões acima também não', () => {
  withPrefs((p) => {
    const auto = (rel, status, i) => ({ id: `x${i}`, state: cutState({ origin: 'auto', relevance: rel, status }) });
    observe(p, [0.1, 0.3, 0.5, 0.7, 0.9, 0.95].map((r, i) => auto(r, 'rejected', i)));
    assert.equal(item(p, 'analysis.minRelevance'), undefined, 'rejeitou tudo, em todas as faixas: não é questão de relevância');
  });
  withPrefs((p) => {
    observe(p, [0.1, 0.2, 0.3].map((r, i) => ({ id: `y${i}`, state: cutState({ origin: 'auto', relevance: r, status: 'rejected' }) })));
    assert.equal(item(p, 'analysis.minRelevance'), undefined, 'sem nenhum corte decidido acima do limite');
  });
});

test('categorias: as mais usadas primeiro, depois as padrão que faltam; rejeitados não contam', () => {
  withPrefs((p) => {
    const cat = (c, status = 'approved') => ({ id: `c${Math.random()}`, state: cutState({ category: c, status }) });
    observe(p, [cat('Hype'), cat('hype'), cat('Hype'), cat('Fail'), cat('Fail'), cat('Clutch'), cat('Besteira', 'rejected')]);
    const it = item(p, 'review.categories');
    assert.equal(it.state, 'active');
    assert.deepEqual(it.value, ['Hype', 'Fail', 'Clutch', 'Jogada', 'Engraçado', 'Dica']);
    assert.equal(it.evidence, '6 cortes categorizados; mais usadas: Hype (3), Fail (2), Clutch (1)');
    assert.deepEqual(p.get('review.categories', {}), it.value);
  });
});

test('categoria em corte pendente conta como uso (o usuário digitou); sem categoria e pendente não é guardado', () => {
  withPrefs((p, dir) => {
    observe(p, [{ id: 'k1', state: cutState({ status: 'pending', category: 'Dica' }) }, { id: 'k2', state: cutState({ status: 'pending' }) }]);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'learned.json'), 'utf8'));
    assert.deepEqual(Object.keys(stored.observations.proj0000000001.cuts), ['k1']);
  });
});

test('perfil de exportação: o mais usado nas aprovações, se tiver pelo menos metade', () => {
  withPrefs((p) => {
    observe(p, [...cutsOf([30, 31, 32, 33, 34, 35], { profileId: 'vertical-1440-h264' }), ...cutsOf([30, 31], { profileId: 'vertical-1080-h264' })]);
    const it = item(p, 'export.profileId');
    assert.equal(it.value, 'vertical-1440-h264');
    assert.equal(it.evidence, '6 de 8 cortes aprovados usaram este perfil (75%)');
    assert.equal(p.get('export.profileId', {}), 'vertical-1440-h264');
  });
  withPrefs((p) => {
    observe(p, [...cutsOf([30, 31], { profileId: 'vertical-1440-h264' }), ...cutsOf([30, 31], { profileId: 'vertical-2160-h264' }), ...cutsOf([30, 31], { profileId: 'horizontal-1080-h264' })]);
    assert.equal(item(p, 'export.profileId'), undefined, 'nenhum perfil domina');
  });
});

test('proposta igual ao padrão não é mostrada (não mudaria nada)', () => {
  withPrefs((p) => {
    observe(p, cutsOf([30, 30, 30, 30, 30], { profileId: 'vertical-1080-h264' }));
    assert.equal(item(p, 'export.profileId'), undefined, 'perfil igual ao padrão');
    assert.equal(item(p, 'analysis.minDurationSec'), undefined, 'mínima calculada = 15 = padrão');
    assert.equal(item(p, 'analysis.maxDurationSec').value, 45, 'a máxima (45) difere do padrão (60) e aparece');
  });
});

// ---------- persistência e limites ----------

test('o aprendizado sobrevive ao reiniciar: observações em learned.json (atômico) e estado dos itens', () => {
  const dir = mkTmp('prefs-learn-persist');
  try {
    let p = new Preferences({ dir, now: clock() });
    observe(p, cutsOf(DURATIONS), { game: 'Valorant' });
    p.setLearned(item(p, 'analysis.minDurationSec', { game: 'Valorant' }).id, { enabled: false });
    assert.equal(item(p, 'analysis.minDurationSec', { game: 'Valorant' }).scope.type, 'general', 'só a geral é listada (jogo idêntico à geral)');
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
    p = new Preferences({ dir });
    const names = { game: 'Valorant' };
    assert.equal(item(p, 'analysis.maxDurationSec', names).state, 'active');
    assert.equal(item(p, 'analysis.minDurationSec', names).state, 'disabled');
    assert.equal(p.get('analysis.maxDurationSec', names), 57);
    assert.equal(p.explain('analysis.minDurationSec', names).source, 'default', 'a desativada continua desativada depois de reiniciar');
    assert.equal(p.get('analysis.minDurationSec', names), 15);
    assert.equal(p.history().length, 3, '2 anúncios (mín. e máx.) + 1 desativação');
  } finally { rm(dir); }
});

test('learned.json corrompido é preservado e o aprendizado recomeça vazio', () => {
  const dir = mkTmp('prefs-learn-corrupt');
  try {
    fs.writeFileSync(path.join(dir, 'learned.json'), 'lixo{');
    const p = new Preferences({ dir });
    assert.equal(p.learnedView().observed, 0);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.corrupt')).length, 1);
    observe(p, cutsOf(DURATIONS));
    assert.equal(item(p, 'analysis.maxDurationSec').state, 'active');
  } finally { rm(dir); }
});

test('falha ao gravar o aprendizado: erro claro e a memória volta ao que estava no disco', () => {
  withPrefs((p) => {
    observe(p, cutsOf([30, 34]));
    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('sem permissão'); e.code = 'EACCES'; throw e; };
    try {
      assert.throws(() => observe(p, cutsOf([40, 44, 50])), (err) => err.code === 'WRITE_FAILED' && /sem permissão/.test(err.message));
    } finally { fs.renameSync = realRename; }
    assert.equal(item(p, 'analysis.maxDurationSec').n, 2, 'só os 2 primeiros ficaram');
  });
});

test('ids e estados malformados são ignorados (nada de __proto__, números absurdos ou textos enormes)', () => {
  const dir = mkTmp('prefs-learn-bad');
  try {
    const store = new LearnedStore(path.join(dir, 'learned.json'));
    store.apply('proj0000000001', { game: 'X', channel: '' }, [
      { id: '__proto__', state: cutState() },
      { id: 'ok1', state: cutState({ duration: -5 }) },
      { id: 'ok2', state: cutState({ duration: 9e9 }) },
      { id: 'ok3', state: cutState({ category: 'x'.repeat(500), status: 'pending' }) },
      { id: 'ok4', state: cutState({ relevance: 7, origin: 'auto' }) },
      { id: 'ok5', state: { status: 'approved', duration: '30', profileId: '../etc' } },
      { id: 'a b', state: cutState() },
      null
    ]);
    const cuts = store.all().proj0000000001.cuts;
    assert.deepEqual(Object.keys(cuts).sort(), ['ok1', 'ok2', 'ok3', 'ok4', 'ok5']);
    assert.equal(cuts.ok1.duration, 0);
    assert.equal(cuts.ok2.duration, 0);
    assert.equal(cuts.ok3.category.length, 40);
    assert.equal(cuts.ok4.relevance, 1);
    assert.equal(cuts.ok5.duration, 30);
    assert.equal(cuts.ok5.profileId, null);
    assert.equal(store.apply('../mau', {}, []), false);
    assert.equal({}.polluted, undefined);
  } finally { rm(dir); }
});

test('limites: no máximo 300 projetos (descarta os mais antigos) e 500 cortes por projeto', () => {
  const dir = mkTmp('prefs-learn-cap');
  try {
    const store = new LearnedStore(path.join(dir, 'learned.json'), { now: clock() });
    for (let i = 0; i < 305; i++) store.apply(`p${String(i).padStart(4, '0')}`, {}, [{ id: 'c1', state: cutState() }]);
    const ids = Object.keys(store.all());
    assert.equal(ids.length, 300);
    assert.equal(ids.includes('p0000'), false, 'o mais antigo saiu');
    assert.equal(ids.includes('p0304'), true);
    const many = Array.from({ length: 520 }, (_, i) => ({ id: `k${i}`, state: cutState() }));
    store.apply('pgrande', {}, many);
    assert.equal(Object.keys(store.all().pgrande.cuts).length, 500);
  } finally { rm(dir); }
});

test('nomes conhecidos incluem os do aprendizado', () => {
  withPrefs((p) => {
    observe(p, cutsOf([30]), { game: 'Valorant', channel: 'Fulano' });
    assert.deepEqual(p.names(), { games: ['Valorant'], channels: ['Fulano'] });
  });
});

// ---------- proposta de canal/jogo igual ao padrão do app ----------

test('proposta de canal igual ao PADRÃO do app continua valendo quando a geral propõe outro valor (o geral não passa por cima)', () => {
  withPrefs((p) => {
    // Canal A aprova cortes de 40 s (propõe máx 60 s = o padrão); Canal B aprova cortes de 20 s. A geral junta os dois (máx 45 s).
    observe(p, cutsOf([40, 40, 40, 40, 40, 40]), { projectId: 'proj000000000a', channel: 'Canal A' });
    observe(p, cutsOf([20, 20, 20, 20, 20, 20]), { projectId: 'proj000000000b', channel: 'Canal B' });
    const mine = { channel: 'Canal A' };
    const shown = view(p, mine).items.filter((i) => i.key === 'analysis.maxDurationSec').map((i) => [i.scope.type, i.value, i.n]);
    assert.deepEqual(shown, [['channel', 60, 6], ['general', 45, 12]], 'o canal propõe 60 s (igual ao padrão) e isso precisa aparecer');
    const why = p.explain('analysis.maxDurationSec', mine);
    assert.equal(why.value, 60, 'vale o que o canal aprendeu, não a média geral');
    assert.equal(why.scope, 'channel');
    assert.equal(why.source, 'learned');
    assert.equal(why.label, 'aprendida · canal Canal A');
    assert.equal(p.get('analysis.maxDurationSec', { channel: 'Canal B' }), 30, 'o outro canal continua com o dele');
    assert.equal(p.get('analysis.maxDurationSec', {}), 45, 'sem canal vale a geral');
  });
});

test('proposta de canal igual ao padrão do app SEM outra geral diferente continua não sendo listada', () => {
  withPrefs((p) => {
    observe(p, cutsOf([40, 40, 40, 40, 40, 40]), { projectId: 'proj000000000a', channel: 'Canal A' });
    // um canal só: a geral tem os mesmos cortes (máx 60 = padrão) e o canal não diz nada além do padrão
    assert.equal(view(p, { channel: 'Canal A' }).items.filter((i) => i.key === 'analysis.maxDurationSec').length, 0);
    assert.equal(p.explain('analysis.maxDurationSec', { channel: 'Canal A' }).source, 'default');
  });
});

test('computeItems: a geral só some quando é igual ao padrão; jogo/canal comparam com o que herdariam', () => {
  const state = (duration) => ({ status: 'approved', duration, category: '', relevance: null, origin: 'manual', profileId: null });
  const cuts = (n, duration) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, state(duration)]));
  const obs = {
    a: { game: 'Jogo A', channel: 'Canal A', updatedAt: '2026-10-21T10:00:00Z', cuts: cuts(6, 40) },
    b: { game: 'Jogo B', channel: 'Canal B', updatedAt: '2026-10-21T11:00:00Z', cuts: cuts(6, 20) }
  };
  const rows = learning.computeItems(obs).filter((i) => i.key === 'analysis.maxDurationSec').map((i) => `${i.scope.type}:${i.scope.name}=${i.value}`).sort();
  assert.deepEqual(rows, ['channel:Canal A=60', 'channel:Canal B=30', 'game:Jogo A=60', 'game:Jogo B=30', 'general:=45']);
  const alone = learning.computeItems({ a: obs.a }).filter((i) => i.key === 'analysis.maxDurationSec');
  assert.deepEqual(alone, [], 'um projeto só, com o valor do padrão: nada a dizer em nenhum escopo');
});

// ---------- avisos e histórico: a mediana que anda ----------

test('160 aprovações seguidas: a mediana anda a cada corte, mas o aviso e o histórico não crescem a cada decisão', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.padBeforeSec', 5); // alteração feita à mão: precisa continuar no histórico
    let seed = 7;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    let valueChanges = 0;
    let notices = 0;
    for (let i = 0; i < 160; i++) {
      const res = observe(p, [{ id: `a${i}`, state: cutState({ duration: 15 + Math.round(random() * 50) }) }]);
      valueChanges += res.changes.length;
      notices += res.changes.filter((c) => c.notify).length;
    }
    assert.ok(valueChanges > 50, `o valor mudou muitas vezes (${valueChanges}) e todas as mudanças chegam à tela (para atualizar o cache)`);
    assert.ok(notices <= 8, `mas só as relevantes viram aviso (${notices})`);
    const history = p.history(300);
    assert.ok(history.length <= 8, `uma entrada por preferência, atualizada no lugar (${history.length})`);
    assert.ok(history.some((e) => e.label === 'Definiu "Margem antes do momento" = 5 s (geral)'), 'a alteração feita à mão continua lá');
  });
});

test('o valor aprendido que deriva só avisa de novo quando a mudança é relevante, e atualiza a MESMA entrada do histórico', () => {
  withPrefs((p) => {
    // cortes aprovados cada vez mais longos (30 s, 31 s, … 70 s): a duração máxima aprendida sobe um pouco a cada corte
    const steps = [];
    for (let d = 30; d <= 70; d++) steps.push(...observe(p, cutsOf([d])).changes.filter((c) => c.key === 'analysis.maxDurationSec'));
    const [first, ...later] = steps;
    assert.deepEqual([first.fresh, first.notify, first.value], [true, true, 48], 'a primeira vez é sempre avisada');
    assert.ok(later.length > 20 && later.every((c) => c.fresh === false), 'o valor mudou a cada corte novo');
    const notices = later.filter((c) => c.notify);
    assert.ok(notices.length >= 1, 'a deriva acumulada passa de 20% do último valor avisado: avisa de novo');
    assert.ok(notices.length <= 4, `mas não a cada corte (${notices.length} avisos em ${later.length} mudanças)`);
    assert.ok(notices.every((c, i) => c.value >= (i === 0 ? first.value : notices[i - 1].value) * 1.2 - 0.5), 'cada aviso é ≥ 20% acima do anterior');
    const mine = p.history(300).filter((e) => e.itemId === first.itemId);
    assert.equal(mine.length, 1, 'uma entrada só para o item, atualizada no lugar');
    assert.match(mine[0].label, /^Preferência aprendida atualizada: "Duração máxima" = 75 s \(geral\)/);
    assert.equal(p.history(300).length, 2, 'duas preferências aprendidas (mínima e máxima), uma entrada cada, em vez de uma por corte');
    assert.equal(p.get('analysis.maxDurationSec', {}), 75, 'o valor em vigor é sempre o último, avisado ou não');
    // desfazer a entrada automática continua desativando o item
    p.revert(mine[0].id);
    assert.equal(p.explain('analysis.maxDurationSec', {}).source, 'default');
  });
});

test('o aprendizado nunca empurra para fora do histórico o que o usuário alterou à mão', () => {
  withPrefs((p) => {
    p.set(G, 'analysis.padAfterSec', 6);
    // 310 canais, cada um com a sua preferência aprendida: bem mais entradas automáticas que o limite de 300
    for (let i = 0; i < 310; i++) {
      observe(p, cutsOf([20 + (i % 40), 40, 41, 42, 43, 44]), { projectId: `proj${String(i).padStart(10, '0')}`, channel: `Canal ${i}` });
    }
    const history = p.history(300);
    assert.equal(history.length, 300, 'o histórico respeita o limite');
    assert.ok(history.filter((e) => e.auto).length >= 200, 'há muitas entradas automáticas');
    assert.ok(history.some((e) => e.label === 'Definiu "Margem depois do momento" = 6 s (geral)'), 'a alteração do usuário continua nele e pode ser desfeita');
    const mine = history.find((e) => e.key === 'analysis.padAfterSec');
    assert.equal(mine.revertible, true);
    assert.equal(p.revert(mine.id).entry.kind, 'pref');
  });
});

test('o texto do aviso e do histórico mostra o NOME do perfil de exportação, não o id técnico', () => {
  const names = { 'vertical-1440-h264': 'Vertical 9:16 · 1440p (2K) · H.264' };
  withPrefs((p) => {
    const res = observe(p, cutsOf([30, 31, 32, 33, 34, 35], { profileId: 'vertical-1440-h264' }));
    const change = res.changes.find((c) => c.key === 'export.profileId');
    assert.match(change.text, /"Perfil de exportação" = Vertical 9:16 · 1440p \(2K\) · H\.264 \(geral\)/);
    assert.ok(!change.text.includes('vertical-1440-h264'));
    assert.ok(p.history().some((e) => e.label.includes('Vertical 9:16 · 1440p (2K) · H.264') && !e.label.includes('vertical-1440-h264')));
    const set = p.set(G, 'export.profileId', 'vertical-2160-h264'); // sem nome conhecido: o id (nada se perde)
    assert.match(set.entry.label, /Definiu "Perfil de exportação" = vertical-2160-h264 \(geral\)/);
  }, { profileName: (id) => names[id] || null });
  withPrefs((p) => {
    const set = p.set(G, 'export.profileId', 'vertical-1440-h264');
    assert.match(set.entry.label, /= vertical-1440-h264 \(geral\)/, 'sem tradutor de nomes continua funcionando com o id');
  });
  withPrefs((p) => {
    const set = p.set(G, 'export.profileId', 'vertical-1440-h264');
    assert.match(set.entry.label, /= vertical-1440-h264 \(geral\)/, 'um tradutor que falha não derruba a gravação');
  }, { profileName: () => { throw new Error('perfis ilegíveis'); } });
});

// ---------- faixas de duração e limites do aprendizado ----------

test('as durações propostas ficam dentro das faixas que a análise aceita (3-120 e 5-180)', () => {
  const huge = learning.durationRange([900, 900, 900, 900, 900]);
  assert.deepEqual([huge.min, huge.max], [120, 180]);
  const tiny = learning.durationRange([2, 2, 2, 2, 2]);
  assert.deepEqual([tiny.min, tiny.max], [3, 8]);
  withPrefs((p) => {
    observe(p, cutsOf([400, 420, 450, 500, 520]));
    assert.equal(p.get('analysis.maxDurationSec', {}), 180, 'o aprendido nunca passa do que a análise usaria');
    assert.equal(p.get('analysis.minDurationSec', {}), 120);
    assert.ok(p.get('analysis.minDurationSec', {}) <= p.get('analysis.maxDurationSec', {}));
  });
});

test('learned.json é gravado sem indentação e há um teto de cortes observados no total (os projetos mais antigos saem, o atual fica)', () => {
  const { MAX_TOTAL_CUTS } = require('../src/core/preferences/learnedStore');
  assert.ok(Number.isInteger(MAX_TOTAL_CUTS) && MAX_TOTAL_CUTS > 0, 'existe um teto de cortes observados no total');
  const dir = mkTmp('prefs-learn-total');
  try {
    const file = path.join(dir, 'learned.json');
    const store = new LearnedStore(file, { now: clock() });
    const perProject = 500;
    const projects = Math.ceil(MAX_TOTAL_CUTS / perProject) + 2;
    for (let i = 0; i < projects; i++) {
      store.apply(`p${String(i).padStart(4, '0')}`, {}, Array.from({ length: perProject }, (_, k) => ({ id: `k${k}`, state: cutState() })));
    }
    assert.ok(store.count() <= MAX_TOTAL_CUTS, `total ${store.count()}`);
    const ids = Object.keys(store.all());
    assert.equal(ids.includes('p0000'), false, 'o mais antigo saiu');
    assert.equal(ids.includes(`p${String(projects - 1).padStart(4, '0')}`), true, 'o que acabou de mudar fica');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('\n'), false, 'uma linha só: sem indentação');
    assert.equal(JSON.parse(text).version, 1);

    // gravação que falha depois de o limite descartar um projeto: nada some da memória
    const before = Object.keys(store.all()).sort();
    const realRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('sem permissão'); e.code = 'EACCES'; throw e; };
    try {
      assert.throws(() => store.apply('pnovo', {}, Array.from({ length: perProject }, (_, k) => ({ id: `k${k}`, state: cutState() }))), /sem permissão/);
    } finally { fs.renameSync = realRename; }
    assert.deepEqual(Object.keys(store.all()).sort(), before, 'a memória voltou ao que o disco tem (inclusive o projeto que o limite ia descartar)');
  } finally { rm(dir); }
});
