# Braga Frame: guia do usuário

O Braga Frame transforma gravações e lives em **cortes verticais prontos para publicar**. Ele analisa o vídeo, sugere os melhores momentos, deixa você revisar e exporta os arquivos. **A publicação é sua**: o app só gera arquivos no seu computador.

## 1. Instalar

1. Baixe o instalador (`braga-frame-X.Y.Z-windows-x64-setup.exe`) na página **Releases** do projeto (github.com/MauroBragaFilho/Braga-Frame/releases) e abra. A instalação é só para o seu usuário, **não pede administrador**, e você pode escolher a pasta.
2. **O aviso do Windows.** Enquanto o instalador não tiver assinatura digital, o Windows pode mostrar "O Windows protegeu o computador". Isso acontece com qualquer programa novo sem assinatura. Só continue se você baixou do endereço oficial do Braga Frame: clique em **Mais informações** e depois em **Executar assim mesmo**.
3. Abra pelo **Menu Iniciar** (Braga Frame).

Para atualizar, é só instalar a versão nova por cima: **seus projetos continuam como estavam**. Antes, feche o Braga Frame. O app **avisa** quando sai uma versão nova (uma faixa no topo, com o botão **Ver e baixar**); dá para desligar o aviso em **Configurações › Geral › Atualizações**. Ele só avisa: nunca instala sozinho.

## 2. Primeiro uso: instalar o FFmpeg

O Braga Frame precisa do **FFmpeg** (um programa gratuito que lê e grava vídeos) e ele **não vem junto com o instalador**. Sem ele, o app abre, mas não consegue abrir nem exportar vídeos, e mostra um aviso vermelho no topo. Dá para instalar com um clique.

1. Clique em **Instalar o FFmpeg** no aviso vermelho do topo (ou em **Configurações › Ferramentas**).
2. Confirme. O app baixa o FFmpeg do GitHub (uns 100 MB; depois de instalado ocupa uns 260 MB), confere o tamanho e o código de verificação (SHA-256) e instala. Você acompanha a barra de progresso e pode cancelar. Quando termina, o aviso vermelho some.

O FFmpeg é um programa de terceiros (a compilação "full" de Gyan Doshi, com licença GPL v3), não do Braga Frame, e **só é baixado quando você clica**.

**Se preferir instalar por conta própria** (ou se o botão não aparecer porque o seu sistema não é um Windows de 64 bits): no Terminal do Windows digite `winget install Gyan.FFmpeg`, aperte Enter, feche o Braga Frame e abra de novo. Também dá para baixar em ffmpeg.org/download.html e pôr a pasta dele no PATH do Windows.

Ainda em **Ferramentas** você pode instalar, com um clique, os programas opcionais: **yt-dlp** (baixar vídeos do YouTube e da Twitch), **Deno** (ajuda o yt-dlp), **TwitchDownloaderCLI** (chat da Twitch) e **Whisper** (legendas automáticas).

## 3. O caminho principal, em cinco passos

O menu lateral tem cinco itens: **Início**, **Projetos**, **Cortes**, **Exportações** e **Configurações**.

1. **Abrir um vídeo.** Na **Início**, clique em **Novo projeto** (ou arraste o arquivo para a janela). Dá para usar um arquivo seu, um link do YouTube ou da Twitch, ou as gravações do OBS. Cada vídeo vira um projeto, **salvo sozinho**.
2. **Analisar.** Em **Cortes › Análise**, escolha **Algoritmo** (roda no seu computador) ou **IA na nuvem** (precisa de uma chave de um provedor e do seu aceite do aviso de privacidade) e inicie. As sugestões entram na lista como **pendentes**: nada é aprovado sozinho.
3. **Revisar.** Em **Cortes**, ouça cada sugestão, ajuste início e fim se quiser e **aprove** ou **rejeite**. Pelo teclado é bem mais rápido (veja os atalhos abaixo).
4. **Exportar.** Em **Cortes › Exportar**, confira o perfil (o padrão é vertical 9:16, 1080p), o enquadramento e a pasta de destino, e clique em **Adicionar à fila**. Você pode mudar o enquadramento de cada corte olhando a prévia.
5. **Acompanhar.** Em **Exportações** a fila mostra o andamento. Os arquivos saem na pasta **Cortes**, ao lado do vídeo (ou na que você escolheu). **Nada é sobrescrito sem a sua escolha.**

## 4. Atalhos da revisão

Valem na aba **Cortes**, com o cursor fora de campos de texto.

| Tecla | O que faz |
|---|---|
| `A` | aprova o corte aberto e abre o próximo pendente |
| `R` | rejeita o corte aberto e abre o próximo pendente |
| `J` ou `↓` | abre o próximo corte da lista |
| `K` ou `↑` | abre o corte anterior |
| `V` | toca o trecho do corte aberto |
| `I` e `O` | marcam início e fim na barra do player |
| `Espaço` | toca ou pausa |
| `Ctrl+Z` e `Ctrl+Y` | desfazem e refazem a última decisão |

As letras podem ser trocadas em **Configurações › Preferências** (opções avançadas, grupo Revisão).

## 5. Onde ficam seus dados

- Os **projetos** (cortes, decisões, ajustes) ficam em `%APPDATA%\braga-frame`. Para abrir: aperte `Win + R`, digite `%APPDATA%\braga-frame` e Enter. **Configurações › Geral** mostra a pasta e abre ela para você.
- Seus **vídeos** e os **cortes exportados** ficam onde sempre estiveram: o app não mexe neles.
- **Desinstalar não apaga seus projetos.** Se quiser apagar tudo mesmo, depois de desinstalar apague a pasta `%APPDATA%\braga-frame`. Para apagar só um projeto, use a lixeira em **Projetos**.
- O app **não envia seus vídeos** para a internet e só usa a rede quando você pede: baixar uma ferramenta, baixar um vídeo ou usar a **IA na nuvem**. A única consulta por conta própria é a do aviso de versão nova, ao abrir (leva só o nome e a versão do app; dá para desligar em Configurações › Geral › Atualizações). A IA na nuvem recebe texto (a transcrição), só depois que você aceita o aviso de privacidade da tela de Análise, que diz o que vai. A chave do provedor fica só neste computador.

## 6. Quando algo não funciona

| O que aparece | O que fazer |
|---|---|
| Aviso vermelho no topo: FFmpeg não encontrado | Siga o passo 2 e **reabra o app** depois. |
| O vídeo não toca na prévia (HEVC, alguns MKV) | O app prepara sozinho uma cópia leve só para assistir. A exportação usa o vídeo original. |
| A exportação está lenta | Sem placa NVIDIA o app codifica pelo processador, que é mais lento. A fila usa prioridade baixa para não travar o computador; em **Exportações** você pode ajustar quantas rodam ao mesmo tempo. |
| Não baixa o vídeo do YouTube ou da Twitch | Às vezes a fonte pede "confirme que você não é um robô" ou o vídeo é privado. O app explica a causa; ele não contorna isso. |
| A análise por IA demora ou perde um trecho | Modelos gratuitos são irregulares: o app tenta de novo e usa os modelos de reserva. A tela avisa o que aconteceu. |

## 7. Pedir ajuda

Em **Configurações › Geral › Suporte**, clique em **Copiar informações** e cole na sua mensagem. O texto traz a versão do app, o sistema, a placa de vídeo e os programas encontrados. **Não inclui seus vídeos, seus projetos nem suas chaves**, e o seu nome de usuário do Windows sai como `~`. O botão **Mostrar o registro** abre o arquivo de registro do app, caso peçam.
