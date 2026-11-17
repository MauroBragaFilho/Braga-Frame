# Atualização do Braga Frame

O app consulta a última Release do GitHub, **baixa o instalador em segundo plano**, **confere** o arquivo e deixa tudo pronto; **quem manda instalar é o usuário**: "Instalar e reiniciar" (agora) ou "Instalar quando eu fechar". Nada é instalado sem essa escolha. Dá para desligar o aviso e o download sozinho em Configurações > Geral > Atualizações.

## Como funciona

1. **Ao abrir**, uns 4 segundos depois de a interface carregar (para não pesar na abertura), o renderer pede `app:updateCheck` (se o aviso não foi desligado). O processo principal faz **uma** chamada `GET https://api.github.com/repos/MauroBragaFilho/Braga-Frame/releases/latest` (o repositório vem de `src/appInfo.js`), com 8 s de prazo, e compara a tag (`vX.Y.Z`) com a versão instalada. O resultado sem erro vale 6 horas.
2. Achando versão nova **e** um instalador que dê para conferir, e com "Baixar a atualização sozinho" ligado (o padrão), o app **baixa** em segundo plano. Sem isso, a faixa oferece "Baixar a atualização".
3. O download passa pelas conferências abaixo. Só um arquivo que passa em tudo chega a **"pronta"**, e a faixa diz: "A versão X do Braga Frame está pronta e verificada" com **Instalar e reiniciar**, **Instalar quando eu fechar** e **Agora não**.
4. **Instalar e reiniciar**: confere de novo o arquivo (tamanho e SHA-256), abre o instalador em silêncio (`/S --updated --force-run`), fecha o app; o instalador espera o app sair, troca os arquivos **por cima** (os projetos e as preferências ficam) e **reabre** o app já na versão nova.
5. **Instalar quando eu fechar**: só agenda. Ao fechar o app (por você), o instalador abre em silêncio (`/S --updated`) e **não** reabre o app. Dá para desfazer ("Não instalar ao fechar").
6. Reabrir o app com uma atualização já baixada: ela volta **pronta** na hora, sem baixar de novo (o `pending.json` guarda a versão, o tamanho e o SHA-256, e o arquivo é conferido outra vez ao reabrir).

Estados: `idle` · `checking` · `downloading` · `ready` · `installing`. A faixa do topo e o cartão da tela Geral mostram o estado e só os botões que fazem sentido naquele momento. Não instala agora se há exportação, análise, legenda, cópia leve ou download de vídeo em andamento (a mensagem oferece "quando eu fechar").

## O que é conferido (e o que recusa a atualização)

| Conferência | Se falhar |
|---|---|
| O instalador está na Release com o nome `braga-frame-<versão da tag>-windows-x64-setup.exe`, tamanho inteiro e o **`digest` sha256 que o próprio GitHub calcula** do arquivo | Não há o que baixar com segurança: a faixa oferece só "Ver e baixar" (a página da Release) |
| O endereço de download é `https://github.com/<repo>/releases/download/<tag>/<nome>` | Não baixa |
| O endereço **final**, depois dos redirecionamentos, é do GitHub (`github.com` ou `*.githubusercontent.com`) | Recusa (`HOST`) |
| O `Content-Length` bate com o tamanho; o fluxo nunca passa do tamanho; há espaço livre | Recusa (`SIZE`, `DISK`) |
| O **tamanho e o SHA-256** do arquivo baixado são exatamente os da Release | Recusa (`SIZE`, `HASH`) e apaga o arquivo |
| A **assinatura digital** (Authenticode, lida com o PowerShell, sem executar o arquivo) passa na política abaixo | Recusa e apaga |
| Antes de executar (agora ou ao fechar): tamanho e SHA-256 **de novo** | Recusa (`TAMPERED`), descarta o arquivo e não executa nada |

O arquivo só tem o nome final depois de conferido (antes é um `.part`, apagado em qualquer falha). Nada é executado antes de a conferência passar.

### Política de assinatura

"Instalador novo" é o arquivo baixado; "programa em uso" é o Braga Frame que está rodando (a assinatura dele só é lida no app instalado; em desenvolvimento não vale).

| Instalador novo | Programa em uso | Resultado |
|---|---|---|
| sem assinatura | sem assinatura | **aceita**, e a tela diz "Sem assinatura digital: a conferência é o SHA-256, que bate com o da Release" (**é o caso de hoje**) |
| assinado | sem assinatura | aceita (a primeira versão assinada) |
| assinado | assinado pelo mesmo emissor | aceita |
| assinado | assinado por **outro** emissor | **recusa** (`SIGNER_CHANGED`) |
| sem assinatura | **assinado** | **recusa** (`DOWNGRADE`): quem hoje é assinado não aceita atualização sem assinatura |
| assinatura inválida (adulterada, cadeia não confiável, arquivo corrompido) | qualquer | **recusa** (`INVALID_SIGNATURE`) |

**Consequência prática:** depois da primeira Release assinada (veja [assinatura-signpath.md](assinatura-signpath.md)), cada app que a instalou passa a **recusar** uma Release sem assinatura. Se a assinatura quebrar numa versão futura, os usuários não recebem essa versão pela atualização (e baixam à mão, ciente do aviso do Windows).

## O que protege, e o que NÃO protege (leia)

- **Protege:** corrupção e interceptação no caminho (HTTPS + tamanho + SHA-256); arquivo trocado no disco depois da conferência; redirecionamento para fora do GitHub; instalador com assinatura inválida; rebaixamento de um app assinado.
- **Não protege (enquanto o instalador não for assinado):** quem controla a **conta do GitHub** do projeto controla a Release **e** o `digest` dela. Sem assinatura, o SHA-256 só prova que o arquivo é o que a Release anuncia, não que a Release é de quem se espera. Por isso instalar **nunca** é automático: é uma escolha do usuário, e a tela diz que a conferência é só o SHA-256. A assinatura digital (SignPath) fecha essa lacuna, porque a chave nunca está no GitHub.
- **SmartScreen:** um arquivo baixado pelo próprio app não carrega a marca "veio da internet" que o navegador põe, então o Windows **não** faz a checagem de reputação dele. A conferência é a descrita acima.
- A conta do mantenedor deve usar autenticação em dois fatores (veja a política em [`CODE_SIGNING_POLICY.md`](../CODE_SIGNING_POLICY.md)).

## O que é enviado e o que fica guardado

- A consulta: uma requisição `GET` sem corpo e sem credenciais; o único dado do app é o `User-Agent` `BragaFrame/<versão> (verificacao-de-versao)`. O download: um `GET` do instalador no GitHub (e no CDN dele, `*.githubusercontent.com`), com o `User-Agent` `BragaFrame (atualizacao)`. Nada do usuário, do computador nem dos projetos. O GitHub, como qualquer site, vê o endereço IP.
- Em disco: `<dados do app>/updates/` com o instalador conferido e o `pending.json`. A pasta é limpa quando a atualização é aplicada, descartada ou fica velha.
- As escolhas (`bf.updateCheck`, `bf.updateAutoDownload`) e a versão dispensada (`bf.updateDismissed`) ficam no armazenamento local do app, como o tema: valem para o app todo, não por jogo nem por canal.
- **Dentro de outro aplicativo** (o BDS) nada disto existe: os canais respondem `disabled`/nada, o cartão não aparece e a pasta não é lida.

## Segurança do código

- Só se abre no navegador uma página de Releases **do próprio repositório**; o endereço **nunca vem do renderer**: `app:updateOpen` abre o que o processo principal conferiu na última consulta. Um `html_url` de fora na resposta é descartado.
- Só entram tags `X.Y.Z`; rascunhos e pré-lançamentos são ignorados.
- O nome do instalador no `pending.json` precisa ser do padrão (`braga-frame-X.Y.Z-windows-x64-setup.exe`, sem caminho, sem `..`) e a versão precisa ser **mais nova** que a instalada; senão a pasta é limpa.
- O caminho do arquivo vai para o PowerShell por variável de ambiente, nunca montado dentro do comando (nome com aspas ou `$(...)` não vira código).
- Variáveis só de teste (`BF_TEST_UPDATE_API`, um servidor local no lugar do GitHub) valem apenas com `NODE_ENV=test` **e** app não empacotado, e só para loopback; em produção são ignoradas. Nesse modo o app também **não executa o instalador nem abre o navegador**: `app:updateInstall` e `app:updateOpen` só devolvem o que fariam.

## Limites conhecidos

- **A v0.1.0 não tem este sistema.** Quem instalou a v0.1.0 precisa instalar **uma vez, à mão**, a primeira versão que o traz (a seguinte); dali em diante o app se atualiza sozinho (com a escolha do usuário).
- Só **Windows 64 bits** (o instalador é NSIS por usuário). Sem instalador conferível na Release, só há a página da Release.
- "Instalar e reiniciar" não funciona com exportação, análise, legenda, cópia leve ou download de vídeo em andamento: a mensagem diz o que está rodando e oferece "quando eu fechar".

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/core/update/check.js` | Versões, endereços, formato da Release (`pickInstaller`, `isAssetUrl`), `checkForUpdate` (nunca lança) |
| `src/core/update/download.js` | Baixa e confere (tamanho, SHA-256, host final, disco, cancelar); nunca deixa arquivo errado |
| `src/core/update/signature.js` | Lê a assinatura (PowerShell), política de confiança, texto para a tela |
| `src/core/update/UpdateManager.js` | Estados, arquivo pendente que sobrevive a reiniciar, instalar agora / ao fechar, adulteração |
| `src/ipc/handlers/app.js` | Canais `app:updateCheck`, `app:updateState`, `app:updateDownload`, `app:updateCancel`, `app:updateInstall`, `app:updateOpen` e o evento `update:state` |
| `renderer/features/update.js` | Faixa do topo, escolhas, `BF.update` |
| `renderer/features/general.js` | Cartão Atualizações |
| `tests/update-*.test.js`, `tests/e2e/update.e2e.js`, `scripts/testar-instalador.js` | Testes (abaixo) |

## Testes e o que foi verificado

- **Unitários** (servidor HTTP local de verdade e `fetch` real): consulta e formato da Release; download com SHA-256, tamanho, redirecionamento, disco, cancelar; a política de assinatura (matriz inteira) e a **leitura real pelo PowerShell** de um arquivo assinado, de um válido sem assinatura e de um corrompido; o gerenciador (todos os caminhos, inclusive adulteração, reiniciar com atualização pendente, instalador que não abre, ocupado); os canais; a faixa e o cartão. Houve controle negativo (desligar a conferência do SHA-256 e a política de assinatura faz os testes certos falharem).
- **E2E** (`tests/e2e/update.e2e.js`, app Electron real com um "GitHub" local): baixa sozinho com progresso, "pronta", escolhas, reabrir com a atualização pendente sem baixar de novo, adulteração, assinatura válida/inválida, SHA-256 errado, cancelar, versão mais nova, aviso desligado.
- **Instalador de verdade** (`npm run test:installer`, e o job `installer` da CI): v1 → v2 por cima à mão → **v3 pelo próprio app**: o programa instalado reconhece a atualização baixada, `app:updateInstall` fecha o app, o instalador NSIS em silêncio troca a versão (a mesma entrada em "Adicionar ou remover programas", o atalho continua) e **reabre** o app já na versão nova.
- **Não verificado:** (1) um download **real** de uma Release do próprio Braga Frame pelo app (os testes usam um "GitHub" local; a API real foi consultada em passos anteriores e o `digest` das Releases existe, mas o fluxo completo contra o GitHub de verdade, com o redirecionamento para o CDN, não foi exercitado); (2) com instalador **assinado** de verdade (a SignPath ainda não está ligada): a leitura de assinatura foi provada com arquivos assinados do Windows, mas não com o certificado da SignPath; (3) a atualização com o app **assinado em uso** recusando um sem assinatura foi provada na política e no gerenciador, não com dois instaladores reais; (4) o "instalar quando eu fechar" com o instalador real: o gatilho (evento `quit` do app) está testado com um instalador de mentira, e a execução em silêncio do NSIS foi provada pelo caminho "agora".
