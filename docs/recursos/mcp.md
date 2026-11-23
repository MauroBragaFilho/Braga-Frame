# Agentes de IA (MCP)

O Braga Frame tem um **servidor MCP** (Model Context Protocol) local, no mesmo desenho do servidor do Braga Digital Studio. Com ele, um agente de IA externo (Antigravity, Claude e outros que falem MCP) pode **ler** os projetos e **ajudar a revisar cortes** no app aberto: abrir um projeto, criar e decidir cortes, transcrever, analisar e mandar cortes aprovados para a fila de exportação. Tudo o que altera algo **pede a confirmação do usuário no app**.

Dono: base. Código em `src/mcp/` e `src/ipc/handlers/mcp.js`; janela em `renderer/features/mcp.js`; testes em `tests/mcp-*.test.js` e `tests/e2e/mcp.e2e.js`.

## Como o usuário liga

**Configurações > Geral > Agentes de IA (MCP)**:

1. O interruptor **Conectar agentes (MCP)** liga o servidor (vem **desligado**). O cartão mostra a porta, o último agente que conectou e o número de chamadas.
2. Um dos botões copia a configuração pronta (ela leva o token, que é a senha: não se compartilha):
   - **Antigravity**: `{ "mcpServers": { "braga-frame": { "serverUrl": "http://127.0.0.1:<porta>/mcp", "headers": { "Authorization": "Bearer <token>" } } } }` (cole em `mcp_config.json`; no Antigravity: painel do agente > MCP Servers > View raw config);
   - **Claude e outros (HTTP)**: o mesmo com `"type": "http"` e `"url"`;
   - **Comando (stdio)**: `{ "command": "node", "args": ["<pasta de dados>/mcp-bridge.js", "<pasta de dados>/mcp.json"] }`, para agentes que só sabem iniciar um comando (a ponte lê a porta e o token do arquivo, então o token nem aparece na linha de comando).
3. **Não pedir confirmação das ações do agente** (opcional, desligado): dispensa a janela de confirmação; o app continua avisando, na tela, de cada coisa que o agente fez. Exige um aviso claro antes de ligar.
4. **Gerar novo token**: quem usava o antigo perde o acesso.

O Braga Frame precisa estar **aberto** enquanto o agente trabalha. O servidor religa sozinho se o app foi fechado com ele ligado.

## Segurança

O agente é um **terceiro, não confiável**.

- Escuta **só em 127.0.0.1** (porta preferida 47822; o BDS usa a 47821, então os dois podem ficar ligados; se a porta estiver ocupada, usa uma livre). Confere o cabeçalho `Host` (anti DNS rebinding) e **recusa qualquer `Origin`** (navegador).
- Exige **sempre** `Authorization: Bearer <token>` (256 bits aleatórios, comparação em tempo constante). O token fica em `mcp.json` na pasta de dados do usuário e **nunca passa pelo renderer**: o processo principal copia a configuração para a área de transferência.
- A lista de ferramentas é **fixa**: não há ferramenta que apague projeto ou arquivo, escolha pasta ou caminho, leia chave de API, instale ou remova programa ou mexa em Preferências.
- Os resultados saem **sem caminhos de arquivo** (só ids, títulos e números); textos de erro passam por `safeText` (remove caminhos Windows, UNC e Unix, mantém a pontuação da frase). O agente nunca informa um caminho: `project_open` usa o do projeto guardado.
- Títulos, transcrições e nomes que as ferramentas devolvem são **dado**, não instrução (as instruções do servidor dizem isso ao agente).
- Ações: uma por vez (fila), com a janela de confirmação **no app** ("O agente X pede para…", com cortes e tempos), e **antes de perguntar** o app confere tudo (sem projeto aberto, corte inexistente, intervalo fora do vídeo viram erro direto, sem janela). Recusar devolve "nada foi feito: não insista". Enquanto o usuário não responde, a chamada **fica esperando** (testado).
- Limites: corpo de 256 KB, até 20 itens por lote, 8 chamadas simultâneas, até 50 ids por chamada. Se o agente desconectar no meio de uma ação, a espera é cancelada.
- A análise que o agente dispara é **só o algoritmo local**: nada é enviado para fora do computador, mesmo que o usuário tenha uma IA na nuvem configurada.

## As ferramentas

Nomes e parâmetros em inglês, mensagens em português. Resultados em JSON; erro = `{ "error": "…" }` (`isError: true`); recusa = `{ "declined": true, … }`.

| Ferramenta | Tipo | O que faz |
|---|---|---|
| `app_overview` | leitura | versão, programas encontrados (sim/não), transcrição pronta?, fila e o projeto aberto |
| `projects_list` | leitura | projetos salvos (id, título, duração, cortes por status, vídeo sumido?) |
| `project_get` | leitura | um projeto: todos os cortes (id, título, início, fim, status, origem, relevância, motivos) e a transcrição |
| `transcript_get` | leitura | o texto falado em trechos, com janela de tempo e limite de caracteres (`nextFromSec` para continuar) |
| `transcription_status` | leitura | o Whisper está pronto? o que falta? há uma transcrição rodando? |
| `analysis_status` | leitura | a análise rodando e as sugestões ainda não viradas corte (as 30 mais relevantes) |
| `queue_status` | leitura | a fila de exportação: estados e os últimos 30 trabalhos |
| `project_open` | ação | abre um projeto salvo na janela (troca o vídeo da tela) |
| `cut_create` | ação | cria um corte **pendente** no projeto aberto |
| `cut_decide` | ação | aprova, rejeita ou redefine cortes em lote (**um passo de histórico**: um Ctrl+Z desfaz tudo) |
| `cut_edit` | ação | muda título e/ou tempo de um corte (cada um desfazível) |
| `transcribe_run` | ação | começa a transcrever (responde ao começar; acompanhar por `transcription_status`) |
| `analysis_run` | ação | começa a análise local do projeto aberto |
| `analysis_add_cuts` | ação | transforma sugestões em cortes **pendentes** (nunca aprovados), por ids ou as N mais relevantes |
| `export_enqueue` | ação | manda cortes **aprovados** para a fila, com o perfil e a pasta que o usuário já escolheu (os com erro de qualidade ficam de fora e vêm explicados) |

Leituras de projetos pedem à janela para **gravar** o projeto aberto antes (a janela grava com atraso), então o disco já reflete o que está na tela.

## Como funciona por dentro

```
agente ──HTTP/JSON-RPC──▶ McpServer ──▶ toolbox ──┬─▶ ctx.call(canal)     (project:list, analysis:status, analysis:transcriptGenerate…)
 (ou stdio ▶ bridge.js)   (token, Host, fila)     ├─▶ projectStore / transcripts / queue (leitura)
                                                   └─▶ RendererBridge ──mcp:request──▶ janela (renderer/features/mcp.js)
                                                                       ◀──mcp:reply──        confirma, valida e executa
```

- `src/mcp/McpConfig.js` (`mcp.json`: ligado, porta, token, autoConfirm), `McpServer.js` (HTTP, protocolo, segurança, fila de ações), `McpService.js` (configuração pronta, token novo, ligar/desligar), `bridge.js` (ponte stdio, copiada para a pasta de dados porque o Node comum não lê de dentro do `app.asar`), `RendererBridge.js` (pedido e resposta à janela, com prazo e cancelamento), `toolbox.js` (as ferramentas).
- **Por que a janela:** só o renderer grava o projeto (`BF.project.update`). As ações de corte, análise e exportação passam por ele, pelo mesmo motor de revisão da aba Cortes (`BF.review.engine`: entram no histórico e dá para desfazer) e pelo mesmo caminho do botão "Adicionar à fila" (`BF.exportOut.enqueueCuts`). Sem janela aberta, as ações respondem "a janela do Braga Frame não está aberta" e a leitura continua valendo.
- `ctx.call(canal, payload)` (em `src/ipc/context.js`): chama um handler por dentro do processo principal com a mesma conversão do IPC, para o MCP reaproveitar os canais sem duplicar validação.
- Canais (`src/ipc/handlers/mcp.js`): `mcp:status`, `mcp:setEnabled`, `mcp:regenerateToken`, `mcp:setOptions`, `mcp:copyConfig`, `mcp:reply`; eventos `mcp:state` e `mcp:request`.
- **Módulo embutido (dentro do BDS):** não há servidor (`available: false`, cartão escondido); os agentes usam o MCP do BDS.

## ChatGPT

**Não está suportado diretamente.** O ChatGPT só aceita servidor MCP **remoto, por HTTPS público** (não aceita `localhost` nem stdio), e o servidor do Braga Frame fica só neste computador, de propósito. Dá para usar um túnel (Cloudflare Tunnel, ngrok) por conta e risco de quem usar, mas isso põe o app do computador na internet com um token como única barreira: **não é recomendado** e não foi feito nem testado aqui. Para quem usa ChatGPT, o caminho seguro é usar um agente que fale MCP local (Antigravity, Claude) ou esperar uma versão com autenticação própria para acesso remoto.

## Testes e o que não foi verificado

- `tests/mcp-server.test.js`: configuração, servidor HTTP de verdade (autenticação, Host/Origin, protocolo, lote, limites, fila de ações, cancelamento, porta ocupada), serviço (configuração pronta, token novo, ligar e desligar) e a ponte stdio.
- `tests/mcp-toolbox.test.js`: cada ferramenta (sem caminhos nos resultados, validação antes de perguntar, recusa, fluxo da transcrição) e a ponte com a janela.
- `tests/mcp-renderer.test.js`: as operações da janela com o motor de revisão de verdade, o cartão e as respostas.
- `tests/mcp-handler.test.js`: os canais com os handlers reais do app, ferramentas de verdade sobre um projeto salvo de verdade, módulo embutido e `ctx.call`.
- `tests/e2e/mcp.e2e.js` (app Electron de verdade; um "agente" de mentira fala JSON-RPC por HTTP e pela ponte stdio): liga pelo cartão, segurança, a lista fixa de ferramentas, leitura, confirmação no app (recusar não muda nada, aceitar muda e desfaz), erro direto sem janela, análise local de verdade, exportação de verdade pela fila, troca de projeto, confirmação dispensada, token novo, desligar e religar, e o servidor voltando sozinho ao reiniciar.

**Não verificado:** a conexão com o **Antigravity, o Claude ou outro agente de verdade** (o formato da configuração segue a documentação do Antigravity e o que o BDS já usa, mas nenhum agente real foi conectado); `transcribe_run` até o fim com o Whisper de verdade (o fluxo e os erros foram testados; o e2e roda sem o motor instalado); e o uso por vários agentes ao mesmo tempo.
