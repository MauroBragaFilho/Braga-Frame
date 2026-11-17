# Aviso de versão nova

O Braga Frame **só avisa** quando sai uma versão nova. Ele não baixa nem instala nada: "Ver e baixar" abre a página da Release no navegador, o usuário baixa o instalador e instala **por cima** (os projetos continuam; isso é testado em `npm run test:installer`). A atualização automática (instalar sozinho) ficou de fora de propósito: instalar sozinho um programa baixado da internet só é seguro com o instalador **assinado**, e a assinatura ainda não existe (veja [comercial.md](comercial.md)).

## Como funciona

1. **Ao abrir**, uns 4 segundos depois de a interface carregar (para não pesar na abertura), o renderer pede `app:updateCheck`, se o usuário não desligou o aviso.
2. O processo principal faz **uma** chamada `GET https://api.github.com/repos/MauroBragaFilho/Braga-Frame/releases/latest` (o repositório vem de `src/appInfo.js`, campo `repo`), com 8 s de prazo, e compara a tag (`vX.Y.Z`) com a versão instalada.
3. Se há versão mais nova e o usuário ainda não disse **"Agora não"** para ela, aparece a faixa no topo: "Nova versão X do Braga Frame disponível (você usa a Y). Instale por cima: seus projetos continuam como estão." com **Ver e baixar** e **Agora não**. A próxima versão volta a avisar.
4. **Configurações > Geral > Atualizações** mostra o resultado em palavras, tem o interruptor "Avisar quando houver versão nova" e o botão **Verificar agora** (que sempre consulta e funciona mesmo com o aviso desligado).

Resultados: **nova versão** (`available`), **na mais recente** (`current`), **nenhuma versão publicada** (`none`: hoje, antes da primeira tag), **erro** (`error`: sem rede, prazo, limite do GitHub, resposta estranha; sempre com texto em português e sem travar nada).

## O que é enviado e o que fica guardado

- Uma requisição sem corpo e sem credenciais; o único dado do app é o `User-Agent`: `BragaFrame/<versão> (verificacao-de-versao)`. Nada do usuário, do computador nem dos projetos. O GitHub, como qualquer site, vê o endereço IP.
- Sem erro, o resultado vale **6 horas** no processo principal (abrir o app várias vezes não consulta várias vezes); "Verificar agora" ignora isso.
- A escolha de ligar ou desligar (`bf.updateCheck`) e a versão dispensada (`bf.updateDismissed`) ficam no armazenamento local do app, como o tema: valem para o app todo, não por jogo nem por canal.
- **Dentro de outro aplicativo** (o BDS) o aviso não existe: o `app:updateCheck` responde `disabled` e o cartão não aparece, porque quem atualiza é o hospedeiro.

## Segurança

- Só se abre no navegador uma página de Releases **do próprio repositório** (`https`, `github.com`, caminho `/<dono>/<repo>/releases…`, sem usuário nem porta). O endereço **nunca vem do renderer**: `app:updateOpen` abre o que o processo principal conferiu na última consulta. Um `html_url` de fora do repositório na resposta é descartado e o endereço é montado pela tag.
- Só entram tags `X.Y.Z` (com ou sem `v`); rascunhos e pré-lançamentos são ignorados.
- Variáveis só de teste (`BF_TEST_UPDATE_API`, um servidor local no lugar do GitHub) valem apenas com `NODE_ENV=test` **e** app não empacotado, e só para endereços de loopback; em produção são ignoradas. Nesse modo o app também não abre o navegador da máquina (`app:updateOpen` devolve `opened: false`).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/update/check.js` | Versões, endereços, formato da Release, `checkForUpdate` (nunca lança). Sem Electron: testável com `fetch` de mentira |
| `src/ipc/handlers/app.js` | Canais `app:updateCheck` (guarda 6 h, `force`) e `app:updateOpen` |
| `renderer/features/update.js` | Faixa `#updateNote`, "Agora não", interruptor, consulta ao abrir, `BF.update` |
| `renderer/features/general.js` | Cartão Atualizações |
| `tests/update-check.test.js`, `update-ipc.test.js`, `update-ui.test.js` | Unitários |
| `tests/e2e/update.e2e.js` | App real com um "GitHub" local |

## O que foi verificado e o que não

- Os testes unitários e o e2e passam. A função foi rodada **contra a API real do GitHub**: o repositório do Braga Frame responde `none` (ainda não há Release) e o do BDS, que tem Releases reais, é lido certo (`available`/`current`).
- **Não foi verificado** o caso `available` contra uma Release do próprio Braga Frame, porque ela ainda não existe: o primeiro teste de verdade é enviar uma tag (veja [publicar-release.md](publicar-release.md)). O nome do instalador na Release só serve para mostrar o tamanho (`sizeBytes`), que a faixa ainda não usa.
- O botão "Ver e baixar" abrindo o navegador de verdade só foi exercitado com `shell.openExternal` de mentira (e, no e2e, sem abrir nada).
