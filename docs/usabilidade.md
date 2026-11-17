# Usabilidade e acessibilidade (Etapa 5)

Auditoria da interface e o que mudou com ela. Critério de pronto da etapa: **uma pessoa nova entende o fluxo principal sem explicação técnica**.
O fluxo principal é: **abrir um vídeo (Início ou Projetos) → Analisar → revisar os cortes (Cortes) → Exportar → acompanhar (Exportações)**.

## Como a auditoria foi feita

- Capturas de todas as telas, nos dois temas, no app de verdade (`helpers.screenshot`, `BF_E2E_SHOTDIR`).
- Verificação automática no app aberto (a mesma que ficou no teste `tests/e2e/ux.e2e.js`): contraste de todo texto visível (4,5:1; ícones e texto grande 3:1), altura dos alvos de clique (mínimo de 24 px, WCAG 2.2 critério 2.5.8), foco visível em todo controle focável e controles sem nome para leitor de tela.
- Cada tela foi aberta e os controles foram contados e lidos nas capturas; **o percurso completo do fluxo principal só com o teclado não foi feito à mão**: só o que o `ux.e2e` exercita (revisão, foco visível em todos os controles).

## O que a auditoria achou e o que foi feito

| Achado | Correção | Onde fica provado |
|---|---|---|
| Todas as telas dividem **um painel que rola**: a rolagem de uma aba passava para a seguinte (a Análise abria em 487 px, o Exportar e as Legendas também no meio da página) | Cada tela lembra a própria rolagem e abre no topo da primeira vez; trocar de projeto zera a lembrança (`renderer/app.js`, `activateTab`) | `ux.e2e` |
| Revisar sugestões pedia o mouse para cada corte (Aprovar, depois clicar no próximo) | **Atalhos de revisão**: `A` aprova, `R` rejeita (os dois já abrem o próximo pendente), `J`/`K` ou `↓`/`↑` andam pela lista, `V` toca o trecho. No fim avisa "Todos os cortes da lista já foram decididos." | `review-shortcuts.test`, `ux.e2e` |
| Recolhíveis (`summary`) e links tinham 14 a 20 px de altura | Mínimo de 24 px (`min-height` no `summary` e no `.link`) | `ux.e2e` |
| Selo numérico do menu/aba selecionada: branco de 11 px sobre o vermelho puro, 4,0:1 | Fundo `--accent-solid` (4,6:1) | `ux.e2e` |
| Ícone do estado vazio, tema claro: vermelho puro sobre rosa claro, 2,9:1 | `--accent-text` no tema claro | `ux.e2e` |
| Nenhum controle sem nome acessível; o anel de foco já era global (`:focus-visible`) | Nada a corrigir; o teste impede que isso se perca | `ux.e2e` |

## Atalhos da revisão

Valem só com a aba **Cortes** à vista, fora de campos de texto, e não competem com `Ctrl`/`Alt`. `I` e `O` (marcar início e fim), `Espaço` (tocar/pausar) e `Ctrl+Z`/`Ctrl+Y` continuam como antes.

| Tecla | Faz | Preferência (Avançado, grupo Revisão) |
|---|---|---|
| `A` | Aprova o corte aberto e abre o próximo pendente | `review.key.approve` |
| `R` | Rejeita o corte aberto e abre o próximo pendente | `review.key.reject` |
| `V` | Toca o trecho do corte aberto | `review.key.view` |
| `J` ou `↓` | Abre o próximo corte da lista | `review.key.next` |
| `K` ou `↑` | Abre o corte anterior | `review.key.prev` |

- As setas só valem com o foco fora dos controles (num campo, no player ou num controle deslizante elas têm outro uso).
- As letras mudam em Preferências. `I` e `O` não podem ser escolhidas. Duas ações na mesma letra: a primeira da tabela fica com ela, a outra volta à letra padrão dela e, se esta também estiver ocupada, fica sem atalho em vez de disputar a tecla (`src/core/review/shortcuts.js`).
- O quadro "Atalhos do teclado" da aba mostra as letras em vigor.

## Os critérios da etapa, um a um

| Critério | Situação |
|---|---|
| Navegação simples (Início, Projetos, Cortes, Exportações, Configurações) | Já entregue na base (`menuLayout.js`); mantida |
| Cortes: player, lista de sugestões, timeline, aprovar/rejeitar rápido, atalhos | Atalhos entregues agora. **Timeline continua opcional** (botão "Timeline"), ver pendências |
| Exportações: codec, resolução e qualidade em controles visuais, avançado recolhido | **Parcial.** Na frente fica o seletor **Perfil**; largura, altura, codec, bitrate, codificador e quadros por segundo ficam num bloco recolhido. Não há controle "de qualidade" visual (barra) além do bitrate numérico; ver pendências |
| Fila com estados e ações corretas | Já existia: cada estado tem as próprias ações (Cancelar, Remover da fila, Tentar de novo, Mostrar na pasta, Pausar fila, Retomar). Não reauditado nesta etapa além do contraste, alvos e foco |
| Teclado, contraste, foco, retorno de operação, notificações discretas, consistência | Teclado, contraste e foco: auditados e cobertos por `ux.e2e` (tabela acima). Retorno de operação e avisos usam o registro da tela e avisos (`BF.ui.log`, `BF.ui.toast`) sem diálogos bloqueantes; **não foram reauditados um a um** |

## O que NÃO foi verificado

- **Teste com pessoas.** O critério "uma pessoa nova entende o fluxo sem explicação" não foi medido com ninguém: só se verificou que o caminho existe, está legível e funciona só com o teclado. O teste de verdade é pôr alguém que nunca viu o app diante da tela e anotar onde hesita (sugestão: 3 pessoas, 10 minutos, sem ajuda).
- **Leitor de tela real** (NVDA/Narrador): foi checado que os controles têm nome e papel, não a experiência de ouvir a tela.
- **Contraste só dos textos que o app desenha em HTML.** Legendas queimadas no vídeo e o frame do vídeo não entram.
- **Alta densidade (DPI > 1)** e zoom do sistema acima de 100%.

## Pendências desta etapa (decisão do usuário ou trabalho futuro)

- **Timeline começa oculta.** Quem não a procura não a descobre. Mostrar por padrão custa espaço vertical na aba Cortes; é uma decisão de produto.
- **Densidade da aba Análise**: muitos controles na mesma página; vale agrupar em "Básico" e "Avançado" depois de ver pessoas usando.
- **Exportar sem controle visual de qualidade**: hoje é o seletor Perfil e, recolhido, o bitrate em número. Uma escolha "Rascunho / Boa / Máxima" que preencha codec e bitrate seria o desenho pedido; fica para quando houver decisão sobre quais níveis oferecer (muda o que sai em disco, por isso não foi feito sem alinhar).
- **Teste de uso com gente de fora** (acima).

## Testes

```bash
node --test tests/review-shortcuts.test.js tests/review-renderer.test.js tests/prefs-keys.test.js
node tests/e2e/ux.e2e.js        # app Electron de verdade
```
