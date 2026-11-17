# Preparação comercial (Etapa 6): avaliação

Escopo do plano: atualização automática, assinatura e distribuição, assinatura digital do instalador, compatibilidade de hardware, documentação para usuários, política de licenciamento e testes de instalação e atualização em máquinas diferentes. **Nenhum modelo comercial ou pagamento foi implementado** (o plano exige uma decisão específica sobre isso).

Esta etapa é, por natureza, de **avaliação e decisão**: quase tudo o que falta depende de uma escolha sua (dinheiro, licença, fonte do FFmpeg). Foi entregue o que não depende de escolha; o resto está aqui com recomendação, risco e critério de aceite, esperando aprovação (regra do plano para mudanças estruturais).

## Resumo

| Item | Situação | Depende de você? |
|---|---|---|
| Instalar, atualizar por cima e desinstalar | **Testado** de verdade com o script nesta máquina, dados preservados; o job equivalente da CI foi criado, mas ainda não rodou numa máquina limpa | não |
| Avisos de licença de terceiros | **Entregue** (`THIRD-PARTY-NOTICES.md` e textos das licenças dentro do instalador) | não |
| Suporte: informações do computador e registro | **Entregue** (Configurações > Geral > Suporte) | não |
| Guia do usuário | **Entregue** ([guia-do-usuario.md](guia-do-usuario.md)); falta um atalho dentro do app | não |
| FFmpeg | **Resolvido**: botão "Instalar o FFmpeg" (baixa a compilação de terceiros, GPL v3, só no clique, com SHA-256 conferido). A instalação real do pacote **não foi executada** aqui (veja o fim deste item) | não |
| Aviso de versão nova | **Entregue** ([atualizacao.md](atualizacao.md)): só avisa e abre a página da Release; atualizar sozinho depende da assinatura | não |
| Assinatura digital do instalador | Não existe; o Windows avisa ao instalar | **sim** (decisão 3) |
| Licença do Braga Frame | Não definida | **sim** (decisão 4) |
| Hardware: AMD, Intel, Windows 10, ARM | Não verificado | precisa de máquinas/testadores |

## 1. Atualização

**Decidido e entregue: A (só avisar).** Detalhes, privacidade e segurança em [atualizacao.md](atualizacao.md). A opção B (instalar sozinho, `electron-updater`) continua para **depois da assinatura**. O texto abaixo é a avaliação original.

**Estado antes.** Não existia. `build.publish` é `null`, não há nenhum release no GitHub e a versão é `0.1.0`. O instalador é NSIS **por usuário** (sem administrador), o que é bom para atualizar: o teste mostra que instalar uma versão nova por cima mantém a mesma entrada em "Adicionar ou remover programas" e os projetos.

**Problemas.** O usuário só fica sabendo de uma versão nova se alguém avisar; corrigir um erro em campo exige que cada pessoa baixe e instale à mão.

**Opções.**

| | A. Só avisar | B. Atualizar sozinho (`electron-updater`) |
|---|---|---|
| Como | o app consulta o último release do GitHub (uma chamada, pode ser desligada) e mostra "Nova versão X: baixar", abrindo a página | o app baixa e instala o novo instalador ao fechar |
| Dependência nova | nenhuma (usa `fetch`) | `electron-updater` (a primeira dependência de runtime do projeto) |
| Segurança sem assinatura | boa: quem instala é o usuário, com o aviso do Windows | **fraca**: instalar sozinho um binário da internet sem assinatura confia só no SHA-512 do `latest.yml`, publicado no mesmo lugar do instalador |
| Com assinatura | igual | forte: dá para exigir que o instalador novo tenha a assinatura do mesmo editor |

**Recomendação.** **A agora, B depois da assinatura (decisão 3).** O repositório é público, então o feed no GitHub não exige nenhuma chave. Para A seria preciso: publicar releases com o instalador e o SHA-256 (o formato de versão é `X.Y.Z`, com etiqueta `vX.Y.Z`), uma preferência "verificar atualizações" (ligada, com opção de desligar, e dizendo que consulta o GitHub) e a checagem com prazo curto e silenciosa se não houver rede.
**Arquivos:** `src/ipc/handlers/app.js` (canal `app:update`), um módulo pequeno em `src/core/update/`, `renderer/features/general.js` (aviso), `src/core/preferences/keys.js`, testes e docs. **Risco:** baixo (só leitura e um link). **Aceite:** com um release de teste mais novo o aviso aparece e abre a página; sem rede nada aparece nem trava; desligado, não faz nenhuma chamada.

## 2. Assinatura e distribuição

**Estado.** O instalador não é assinado. O Windows mostra "O Windows protegeu o computador" (SmartScreen) a quem baixa da internet, e antivírus podem implicar com um executável novo sem assinatura. O guia do usuário explica o aviso, mas para vender isso não serve: o aviso afasta quem não é técnico.

**Opções de assinatura** (valores e regras mudam; **não consultei os preços de hoje**, confira antes de decidir):

| Caminho | Custo, ordem de grandeza | Observações |
|---|---|---|
| Certificado de assinatura de código (OV) de uma autoridade certificadora | centenas de dólares por ano | a chave fica em dispositivo físico ou nuvem de assinatura (regra do setor), o que complica assinar na CI; a reputação no SmartScreen vem aos poucos |
| Serviço de assinatura da Microsoft (Trusted Signing / Artifact Signing) | dezenas de dólares por mês | funciona bem com CI; **a elegibilidade depende do país e do tipo de conta** (confira se atende pessoa física no Brasil) |
| SignPath Foundation | grátis | só para projetos de **código aberto**: exige uma licença aberta (decisão 4) |
| Microsoft Store (MSIX) | taxa única pequena de conta | a Loja assina e dispensa o SmartScreen, mas exige empacotar em MSIX, passar na análise e resolver o FFmpeg (decisão 1) |

**Distribuição.** O canal é o **GitHub Releases** do próprio repositório, publicado por um fluxo disparado por **tag** (`vX.Y.Z`), no mesmo molde do Braga Digital Studio, mas com **um arquivo só** por versão e um único padrão de nome (`braga-frame-<versão>-windows-x64-setup.exe`), sem artefatos nem cache do Actions. Como usar e o que ainda não foi testado: [publicar-release.md](publicar-release.md). Nenhuma tag foi enviada, então **ainda não existe Release**.
**Aceite (assinatura):** o instalador e o `Braga Frame.exe` mostram o editor correto nas propriedades do arquivo e o SmartScreen não bloqueia a instalação numa máquina limpa. **Dependência:** decisão 3 e as chaves guardadas como segredos da CI (nunca no repositório).

## 3. Compatibilidade de hardware

**O que existe no código:** libx264/libx265 por software (qualquer processador), NVENC (placa NVIDIA, testado de verdade com um mini-encode antes de usar), Whisper por processador (qualquer máquina) e Whisper CUDA (NVIDIA), proxy de visualização para o que o player não toca, limites de processos, de memória livre (1 GB) e prioridade baixa da exportação.

**Matriz.**

| Configuração | Situação |
|---|---|
| Windows 11 x64, Intel Iris Xe + NVIDIA GTX 1650 (a máquina de desenvolvimento) | **Verificado** (NVENC, Whisper CUDA, software) |
| Windows (máquina limpa da CI do GitHub), sem placa de vídeo | **Verificado**: suíte unitária e teste do instalador. Os e2e não rodam na CI |
| Windows 10 x64 | **Não verificado**: não foi aberto lá (pelo que conheço do Electron ele deve funcionar, mas não confirmei a lista de sistemas da versão 43) |
| Placa AMD ou só gráficos Intel | **Funciona só por software** (sem AMF nem QSV): mais lento, mas exporta. Não verificado em máquina real |
| Windows no ARM | **Não verificado**; o instalador é só x64 (rodaria por emulação) |
| Pouca memória (menos de 8 GB) | **Não verificado**; o limite de memória livre da fila existe, mas nunca foi medido nessa faixa |
| Linux e macOS | código escrito, **nunca executado**; sem instalador |

**Recomendação.** (a) **Aceleração AMD e Intel** (`h264_amf`, `h264_qsv`) só deve ser feita com uma máquina de cada marca para testar, no mesmo molde do NVENC; sem isso, entra código que ninguém executou. (b) Um **teste beta com 3 a 5 máquinas** diferentes, usando o botão **Copiar informações** (agora existe) para anexar o relatório de cada uma. O roteiro está no fim deste documento.

## 4. Documentação para usuários

**Estado.** O README é de desenvolvedor. **Entregue:** [guia-do-usuario.md](guia-do-usuario.md) (instalar, o aviso do Windows, instalar o FFmpeg, o fluxo principal, atalhos, onde ficam os dados e como remover, problemas comuns, como pedir ajuda) e a tela **Configurações > Geral > Suporte** (copia a versão, o sistema, as placas de vídeo e o que o FFmpeg codifica, sem o nome de usuário do Windows nem chaves, e mostra o arquivo de registro). O comando `winget install Gyan.FFmpeg` do guia confere com o catálogo do winget (o pacote existe, "static full build" da Gyan), mas **não o instalei numa máquina sem FFmpeg** para ver se o app o encontra depois de reabrir. **Falta:** abrir o guia de dentro do app (um item "Ajuda") e um tutorial na primeira abertura; ambos mudam a interface, então ficam para depois da decisão 1 (o primeiro passo do tutorial depende de o FFmpeg já estar resolvido).

## 5. Política de licenciamento

**Estado.** O repositório é **público** e **não tem arquivo de licença** (`"license": "UNLICENSED"` no `package.json`). Na prática, todos os direitos ficam reservados: qualquer pessoa pode ler o código no GitHub, mas ninguém tem permissão de usar, copiar ou redistribuir. Os componentes de terceiros estão inventariados em [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md) (que agora vai dentro do instalador, com os textos das licenças das fontes), e as licenças declaradas no GitHub foram conferidas hoje (yt-dlp Unlicense; Deno, TwitchDownloader, whisper.cpp, Whisper e Electron MIT; Inter e Montserrat OFL 1.1).

**Opções para o Braga Frame.**

| Caminho | Efeito |
|---|---|
| Proprietário (todos os direitos reservados, com contrato de uso) | combina com vender; **incoerente com repositório público**: o código teria de passar a ser privado |
| Código aberto permissivo (MIT) e ganhar com serviços, suporte ou versão paga à parte | libera a assinatura gratuita (SignPath); qualquer um pode vender cópias |
| Código aberto com copyleft (GPL/AGPL) | combina com embutir o FFmpeg GPL (decisão 1); obriga quem redistribuir a abrir o código |
| Código disponível com restrição comercial (PolyForm, BSL) | o código segue visível e o uso comercial por terceiros fica proibido; não é "código aberto" para fins de assinatura gratuita |

**Pontos que merecem um advogado antes de vender** (não é parecer jurídico): (a) redistribuir o FFmpeg em versão GPL traz obrigações (texto da licença e oferta do código-fonte); (b) codificadores **H.264 e H.265** têm patentes (consórcios de licenciamento): o app só os **executa**, a partir do FFmpeg que o usuário instala, o que reduz a exposição mas não a elimina se o FFmpeg passar a ir no instalador; (c) a marca "Braga Frame" é nome de trabalho (INPI, domínio e redes não verificados).

## Decisões que preciso de você

**1. FFmpeg. DECIDIDO (opção a) e entregue.** Texto da avaliação: hoje o usuário precisa instalá-lo à mão (por exemplo `winget install Gyan.FFmpeg`), o que um usuário comum não faz. Opções: **(a) Botão "Instalar FFmpeg" em Configurações > Ferramentas** que baixa de uma versão **fixa**, com tamanho e SHA-256 conferidos, só quando o usuário clica (o mesmo mecanismo do yt-dlp e do Whisper); o app não redistribui nada, e o aviso diz que é uma compilação GPL de terceiros. **(b) Embutir no instalador** (da ordem de uma centena de MB a mais, não medi; traz as obrigações da GPL e a questão das patentes). **(c) Manter como está** e só documentar. **Recomendo (a)**: tira o obstáculo sem trazer obrigações de redistribuição, mas **reverte uma decisão registrada** (o README diz que o app não baixa o FFmpeg, por o projeto oficial não publicar programas prontos), e a fonte (qual compilação, qual versão fixa) precisa de escolha sua.

**O que foi e o que NÃO foi verificado no FFmpeg real.** Verificado: o pacote (`ffmpeg-9.0.2-full_build-shared.zip`, 99.899.672 bytes, SHA-256 `8d31e162…`) tem tamanho e hash iguais aos que o GitHub informa (o teste de rede `tests/ffmpeg-network.test.js` confere isso na API); a estrutura do zip (uma pasta de topo, `bin/ffmpeg.exe`, `bin/ffprobe.exe` e as DLLs ao lado); e, **lendo as DLLs como dados**, a configuração GPL v3 sem `nonfree` com libx264, libx265, libass e NVENC. O fluxo do botão (confirmação, progresso, os dois programas, aviso que some, remover) foi testado de ponta a ponta com **pacotes de mentira** num servidor local. **Não foi verificado: executar o `ffmpeg.exe` baixado** (o sistema bloqueou, com razão, que eu rodasse um programa de terceiros baixado, e eu não contornei). Para fechar essa lacuna, rode você: `BF_NETWORK_TESTS=1 BF_NETWORK_FFMPEG=1 node --test tests/ffmpeg-network.test.js` (baixa ~100 MB, instala pela mesma entrada, executa o programa, confere versão, filtros, codificadores, um encode real e que o app o enxerga).

**2. Atualização. DECIDIDO (A, só avisar) e entregue.** B (instalar sozinho) fica para depois da assinatura.

**3. Assinatura. Direção decidida: código aberto (SignPath Foundation, gratuita para projetos abertos).** Depende da decisão 4: a SignPath exige uma licença de código aberto reconhecida e um pedido de inscrição do projeto. O fluxo de releases já existe ([publicar-release.md](publicar-release.md)); o ponto de encaixe da assinatura está marcado nele.

**4. Licença do Braga Frame. EM ABERTO.** Direção: código aberto; a GPL v3 foi proposta pelo autor e recebeu parecer favorável (compatível com o FFmpeg GPL v3 que o app baixa e com a SignPath). Falta confirmar para eu criar o `LICENSE` e ajustar o `package.json` (`GPL-3.0-or-later` ou `GPL-3.0-only`). Sem isso o repositório público segue com todos os direitos reservados.

## Testes de instalação e atualização

**Automático** (`npm run test:installer`, e o job `installer` da CI): gera o instalador de duas versões com uma **identidade própria** ("Braga Frame Teste", outro `appId`, outro atalho e outra chave no "Adicionar ou remover programas": não toca numa instalação real); instala em silêncio; confere arquivos e avisos de licença, a entrada em "Adicionar ou remover programas" e o atalho do Menu Iniciar; **abre o programa instalado** (versão, nenhum módulo com falha, um vídeo aberto, um projeto gravado); instala a versão seguinte **por cima** (a mesma entrada, versão nova, o projeto e a decisão lidos pela versão nova); desinstala (entrada, atalho e arquivos saem; as pastas de dados padrão e os projetos ficam). Medidas nesta máquina: instalador de 109 MB, 365 MB instalado, o teste leva uns 4 minutos gerando os instaladores e 1 minuto reaproveitando-os (`--reuse`).

**O que ele não prova:** outra máquina além da de desenvolvimento e da CI; Windows 10; usuário sem permissão de escrita; nome de usuário com acento ou espaço; antivírus de terceiros; o SmartScreen (só aparece com o arquivo baixado); a atualização **com o programa aberto** (o instalador pede para fechar); instalação para todos os usuários (o instalador é por usuário). A checagem de que desinstalar não apaga os dados usa marcadores nas duas pastas de dados padrão (%APPDATA%\nome do programa e \nome do pacote); **foi comprovada**: com `deleteAppDataOnUninstall` ligado o desinstalador apagou o marcador e o teste falhou. A pasta de dados do app real, `%APPDATA%\braga-frame`, tem o nome do pacote: corresponde à segunda pasta marcada.

**Roteiro manual para outras máquinas** (peça a 3 a 5 pessoas; cada uma anexa o resultado do botão **Copiar informações**):

1. Baixar o instalador e anotar o que o Windows mostra. Instalar. Abrir o programa pelo Menu Iniciar.
2. Instalar o FFmpeg (guia), clicar em "Verificar de novo" na Ferramentas e ver o aviso sumir.
3. Abrir um vídeo de uns 10 minutos, analisar, aprovar 2 cortes e exportar um deles. Anotar o tempo e se usou a placa de vídeo.
4. Fechar, instalar a versão nova por cima (quando houver), abrir de novo e ver se o projeto continua.
5. Desinstalar. Conferir se a pasta `%APPDATA%\braga-frame` ficou (deve ficar) e se algo sobrou em "Aplicativos instalados".

## Ordem sugerida

Decisão 4 (a licença: destrava a assinatura) → decisão 3 (pedir a inscrição na SignPath e ligá-la ao fluxo de releases) → primeira tag (o primeiro teste do fluxo e do aviso de versão) → teste beta com o roteiro acima.
