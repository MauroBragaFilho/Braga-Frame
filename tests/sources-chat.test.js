'use strict';

/**
 * Fontes: formato unificado de chat bf-chat-1 e os conversores (TwitchDownloader JSON, replay de chat do YouTube).
 * As fixtures de chat foram montadas à mão seguindo o formato dos programas (não há VOD/live público estável para
 * capturar): veja docs/recursos/sources.md, "O que não foi verificado em rede real".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chatFormat = require('../src/core/sources/chatFormat');
const { convertTwitchChat, chatDownloadArgs } = require('../src/core/sources/twitchChat');
const { convertYoutubeLiveChat, runsToText } = require('../src/core/sources/youtubeChat');
const { loadChat } = require('../src/core/analysis/chatSignal');

const FIX = path.join(__dirname, 'sources-fixtures');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bf-src-chat-'));
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ------------------------------------------------------------------ chatFormat

test('writeChat/readChat: ida e volta, ordena por t e grava de forma atômica', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'sub', 'chat.json');
    const res = await chatFormat.writeChat(file, {
      platform: 'twitch', videoId: '1', fetchedAt: '2026-10-21T00:00:00.000Z',
      messages: [{ t: 5, user: 'b', text: 'depois' }, { t: 1.23456, user: 'a', text: 'antes' }, { t: 5, user: 'c', text: 'empate' }]
    });
    assert.deepEqual(res, { path: file, count: 3 });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['chat.json'], 'nenhum .tmp sobra');
    const chat = await chatFormat.readChat(file);
    assert.equal(chat.format, 'bf-chat-1');
    assert.equal(chat.platform, 'twitch');
    assert.equal(chat.videoId, '1');
    assert.equal(chat.fetchedAt, '2026-10-21T00:00:00.000Z');
    assert.deepEqual(chat.messages.map((m) => m.text), ['antes', 'depois', 'empate'], 'ordem por tempo; empate mantém a ordem de chegada');
    assert.equal(chat.messages[0].t, 1.235, 'tempo arredondado ao milissegundo');
    assert.deepEqual(chatFormat.readChatSync(file), chat);

    // regravar substitui por inteiro, sem deixar lixo
    await chatFormat.writeChat(file, { platform: 'twitch', videoId: '1', messages: [{ t: 0, user: 'x', text: 'novo' }] });
    assert.equal((await chatFormat.readChat(file)).messages.length, 1);
    chatFormat.writeChatSync(file, { messages: [] });
    assert.equal((await chatFormat.readChat(file)).messages.length, 0);
  } finally { rm(dir); }
});

test('normalizeChat descarta o que não tem tempo válido e corta textos enormes', () => {
  const { chat, dropped } = chatFormat.normalizeChat({
    format: 'bf-chat-1',
    messages: [
      { t: -1, user: 'a', text: 'negativo' }, { t: 'abc', user: 'a', text: 'texto' }, { t: NaN, text: 'nan' }, null, 'lixo',
      { t: '12.5', user: 7, text: 'tempo em texto, usuário inválido' }, { t: 3, user: 'u'.repeat(300), text: 'x'.repeat(5000) }
    ]
  });
  assert.equal(dropped, 5);
  assert.equal(chat.messages.length, 2);
  assert.deepEqual(chat.messages[1], { t: 12.5, user: '', text: 'tempo em texto, usuário inválido' });
  assert.equal(chat.messages[0].user.length, 100);
  assert.equal(chat.messages[0].text.length, 2000);
});

test('readChat: erros em português, com código (arquivo ausente, JSON ruim, formato errado)', async () => {
  const dir = tmp();
  try {
    await assert.rejects(chatFormat.readChat(path.join(dir, 'nao.json')), (e) => e.code === 'CHAT_NOT_FOUND' && /não foi encontrado/.test(e.message) && /Baixe o chat de novo/.test(e.message));
    fs.writeFileSync(path.join(dir, 'ruim.json'), '{ não é json');
    await assert.rejects(chatFormat.readChat(path.join(dir, 'ruim.json')), (e) => e.code === 'CHAT_UNREADABLE' && /JSON inválido/.test(e.message));
    fs.writeFileSync(path.join(dir, 'outro.json'), JSON.stringify({ format: 'outra-coisa', messages: [] }));
    await assert.rejects(chatFormat.readChat(path.join(dir, 'outro.json')), (e) => e.code === 'CHAT_BAD_FORMAT' && /outra-coisa/.test(e.message));
    fs.writeFileSync(path.join(dir, 'semformato.json'), JSON.stringify({ messages: [] }));
    await assert.rejects(chatFormat.readChat(path.join(dir, 'semformato.json')), (e) => e.code === 'CHAT_BAD_FORMAT');
    fs.writeFileSync(path.join(dir, 'semlista.json'), JSON.stringify({ format: 'bf-chat-1' }));
    await assert.rejects(chatFormat.readChat(path.join(dir, 'semlista.json')), (e) => e.code === 'CHAT_BAD_FORMAT' && /lista de mensagens/.test(e.message));
    await assert.rejects(chatFormat.readChat(''), (e) => e.code === 'CHAT_BAD_ARGS');
    assert.throws(() => chatFormat.readChatSync(path.join(dir, 'nao.json')), (e) => e.code === 'CHAT_NOT_FOUND');
    // BOM no início (arquivo editado no Bloco de Notas) é aceito
    fs.writeFileSync(path.join(dir, 'bom.json'), `\uFEFF${JSON.stringify({ format: 'bf-chat-1', messages: [{ t: 1, user: 'a', text: 'b' }] })}`);
    assert.equal((await chatFormat.readChat(path.join(dir, 'bom.json'))).messages.length, 1);
  } finally { rm(dir); }
});

test('messagesPerWindow conta por janela, aceita lista e preenche até a duração', () => {
  const chat = { messages: [{ t: 0.5 }, { t: 9.99 }, { t: 10 }, { t: 25 }, { t: 25.5 }, { t: 25.9 }] };
  assert.deepEqual(chatFormat.messagesPerWindow(chat, 10), [2, 1, 3], 'cada janela [i*10, (i+1)*10)');
  assert.deepEqual(chatFormat.messagesPerWindow(chat.messages, 10), [2, 1, 3], 'também aceita só a lista');
  assert.deepEqual(chatFormat.messagesPerWindow(chat, 10, 60), [2, 1, 3, 0, 0, 0], 'até o fim do vídeo');
  assert.deepEqual(chatFormat.messagesPerWindow(chat, 10, 5), [2, 1, 3], 'duração menor não corta mensagens');
  assert.deepEqual(chatFormat.messagesPerWindow(chat, 100), [6]);
  assert.deepEqual(chatFormat.messagesPerWindow({ messages: [] }, 10), []);
  assert.deepEqual(chatFormat.messagesPerWindow({ messages: [] }, 10, 25), [0, 0, 0]);
  assert.deepEqual(chatFormat.messagesPerWindow({ messages: [{ t: -3 }, { t: NaN }] }, 10), [], 'tempos inválidos não contam');
  assert.throws(() => chatFormat.messagesPerWindow(chat, 0), (e) => e.code === 'CHAT_BAD_ARGS');
  assert.throws(() => chatFormat.messagesPerWindow(chat, -5), (e) => e.code === 'CHAT_BAD_ARGS');
  assert.throws(() => chatFormat.messagesPerWindow(null, 10), (e) => e.code === 'CHAT_BAD_ARGS');
});

test('tempo absurdo numa mensagem não aloca memória nem derruba o processo (limite de 7 dias e de janelas)', () => {
  const WEEK = 7 * 24 * 3600;
  // antes: 10 milhões de janelas (84 MB); com 4e9 o Node abortava por falta de memória
  const huge = chatFormat.messagesPerWindow([{ t: 10 }, { t: 1e7 }], 1);
  assert.equal(huge.length, 11, 'a mensagem fora do intervalo plausível é ignorada e não aumenta o vetor');
  assert.equal(huge[10], 1);
  assert.equal(chatFormat.messagesPerWindow([{ t: 10 }, { t: 4e9 }], 1, 20).length, 20, 'com a duração do vídeo, o vetor vai só até ela');
  assert.equal(chatFormat.messagesPerWindow([{ t: WEEK }, { t: WEEK + 1 }], 1).length, WEEK + 1, 'até 7 dias vale; um segundo a mais não');
  assert.equal(chatFormat.messagesPerWindow([{ t: WEEK }, { t: WEEK + 1 }], 1)[WEEK], 1);
  // janela pequena demais para o intervalo: erro claro em vez de gigabytes
  assert.throws(() => chatFormat.messagesPerWindow([{ t: 100 }], 0.0001, 3600), (e) => e.code === 'CHAT_BAD_ARGS' && /pequena demais/.test(e.message));
  assert.throws(() => chatFormat.messagesPerWindow([], 1, 1e12), (e) => e.code === 'CHAT_BAD_ARGS');
  // o conversor/leitor também descarta e conta
  const { chat, dropped } = chatFormat.normalizeChat({ format: 'bf-chat-1', messages: [{ t: 5, text: 'ok' }, { t: 4e9, text: 'absurdo' }, { t: WEEK + 1, text: 'passou' }, { t: WEEK, text: 'limite' }] });
  assert.deepEqual(chat.messages.map((m) => m.text), ['ok', 'limite']);
  assert.equal(dropped, 2);
});

test('messagesPerWindow com tempo de 4e9 segundos termina rápido em outro processo (antes: "heap out of memory")', () => {
  const { spawnSync } = require('node:child_process');
  const script = `const c = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'core', 'sources', 'chatFormat.js'))});
    const a = c.messagesPerWindow([{ t: 10 }, { t: 4e9 }], 1);
    process.stdout.write(String(a.length));`;
  const started = Date.now();
  const res = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(res.status, 0, `o processo deveria terminar normalmente: ${res.stderr.slice(0, 300)}`);
  assert.equal(res.stdout, '11');
  assert.ok(Date.now() - started < 10000);
});

// ------------------------------------------------------------------ Twitch

test('convertTwitchChat: lê o JSON do TwitchDownloader e ignora o que não é mensagem publicada', () => {
  const json = JSON.parse(fs.readFileSync(path.join(FIX, 'twitchdownloader-chat.json'), 'utf8'));
  const { chat, skipped } = convertTwitchChat(json, { videoId: '2345678901', now: Date.parse('2026-10-21T10:00:00Z') });
  assert.equal(chat.format, 'bf-chat-1');
  assert.equal(chat.platform, 'twitch');
  assert.equal(chat.videoId, '2345678901');
  assert.equal(chat.fetchedAt, '2026-10-21T10:00:00.000Z');
  assert.match(chat.source, /TwitchDownloaderCLI/);
  // 7 comentários: 1 apagado (state) e 1 com tempo negativo ficam de fora
  assert.equal(skipped, 2);
  assert.deepEqual(chat.messages.map((m) => [m.t, m.user, m.text]), [
    [1.5, 'Maria', 'oi pessoal'],
    [3, 'joao', 'Kappa que jogada'], // sem display_name: usa o nome de login
    [61.2, 'Ana', 'PogChamp'], // body vazio: monta pelos fragmentos
    [61.9, 'Pedro', 'clipa isso!'],
    [120.25, 'Zé 😀', 'ação ✓ 日本語']
  ]);
});

test('convertTwitchChat: erro claro quando o arquivo não é um chat do TwitchDownloader; videoId vem do arquivo se faltar', () => {
  assert.throws(() => convertTwitchChat({ foo: 1 }), (e) => e.code === 'CHAT_BAD_SOURCE' && /comments/.test(e.message));
  assert.throws(() => convertTwitchChat(null), (e) => e.code === 'CHAT_BAD_SOURCE');
  const { chat } = convertTwitchChat({ video: { id: '77' }, comments: [] });
  assert.equal(chat.videoId, '77');
  assert.deepEqual(chat.messages, []);
});

test('chatDownloadArgs: sobrescrever é seguro porque o arquivo de saída é nosso (e o padrão "Prompt" travaria)', () => {
  const args = chatDownloadArgs({ videoId: '2345678901', outFile: 'C:\\tmp\\out.json', tempDir: 'C:\\tmp\\t' });
  assert.deepEqual(args.slice(0, 3), ['chatdownload', '--id', '2345678901']);
  assert.ok(args.includes('--collision') && args[args.indexOf('--collision') + 1] === 'Overwrite');
  assert.equal(args[args.indexOf('-o') + 1], 'C:\\tmp\\out.json');
  assert.equal(args[args.indexOf('--banner') + 1], 'false');
  assert.equal(args[args.indexOf('--temp-path') + 1], 'C:\\tmp\\t');
});

// ------------------------------------------------------------------ YouTube

test('convertYoutubeLiveChat: texto, emojis, Super Chat; ignora sistema/membros, tempo negativo e linhas ruins', () => {
  const text = fs.readFileSync(path.join(FIX, 'youtube-live-chat.jsonl'), 'utf8');
  const { chat, skipped } = convertYoutubeLiveChat(text, { videoId: 'AAAAAAAAAAA', now: Date.parse('2026-10-21T10:00:00Z') });
  assert.equal(chat.platform, 'youtube');
  assert.equal(chat.videoId, 'AAAAAAAAAAA');
  assert.equal(skipped, 2, 'a linha que não é JSON e a mensagem com tempo negativo');
  assert.deepEqual(chat.messages.map((m) => [m.t, m.user, m.text]), [
    [2, 'Maria', 'oi pessoal'],
    [3.5, 'João', 'que jogada 😀 :kappa:'], // emoji Unicode vira o caractere; emoji do canal vira o atalho
    [10, 'Ana', '[R$ 10,00] Continua assim!'],
    [61.9, 'Pedro', 'primeira'],
    [61.9, 'Lia', 'segunda, no mesmo instante'],
    [120.25, 'Zé', 'ação ✓ 日本語']
  ]);
});

test('runsToText e conversão tolerantes a entradas estranhas', () => {
  assert.equal(runsToText(null), '');
  assert.equal(runsToText([{ text: 'a' }, null, 5, { emoji: { shortcuts: [':x:'] } }, { emoji: {} }, { text: 'b' }]), 'a:x:b');
  assert.deepEqual(convertYoutubeLiveChat('').chat.messages, []);
  assert.deepEqual(convertYoutubeLiveChat('{"outra":1}\n[]\n').chat.messages, []);
  assert.equal(convertYoutubeLiveChat('{"replayChatItemAction":{"actions":[]}}').skipped, 0);
});

// ------------------------------------------------------------------ integração com a análise

test('o chat gravado aqui é lido pela análise (chatSignal.loadChat usa o readChat deste recurso)', async () => {
  const dir = tmp();
  try {
    const json = JSON.parse(fs.readFileSync(path.join(FIX, 'twitchdownloader-chat.json'), 'utf8'));
    const { chat } = convertTwitchChat(json, { videoId: '2345678901' });
    const file = path.join(dir, 'twitch-2345678901.json');
    await chatFormat.writeChat(file, chat);
    const loaded = await loadChat(file);
    assert.equal(loaded.platform, 'twitch');
    assert.equal(loaded.messages.length, 5);
    assert.deepEqual(loaded.messages[0], { t: 1.5, text: 'oi pessoal' });
    // arquivo no formato errado é recusado pela análise com a mensagem dela
    fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ format: 'x', messages: [] }));
    await assert.rejects(loadChat(path.join(dir, 'x.json')), (e) => e.code === 'CHAT_UNREADABLE');
  } finally { rm(dir); }
});
