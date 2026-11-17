# Política de Assinatura de Código — Braga Frame

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> **Situação:** o instalador **ainda não é assinado** (a v0.1.0 saiu sem assinatura). Esta política descreve como a assinatura vai funcionar a partir da
> aprovação do projeto pela SignPath Foundation. Enquanto isso, confira o arquivo pelo SHA-256 que o GitHub mostra ao lado dele na Release.

*(English summary at the end of this file.)*

## Escopo

Esta política vale para o instalador Windows (`braga-frame-<versão>-windows-x64-setup.exe`) do **Braga Frame**, publicado em
<https://github.com/MauroBragaFilho/Braga-Frame/releases>. O projeto é software livre, licenciado sob a [GPL v3 ou posterior](LICENSE). Só são assinados binários
construídos a partir do código-fonte deste repositório. O Braga Frame não assina nem redistribui binários de terceiros como se fossem seus: o FFmpeg, o yt-dlp e as
demais ferramentas são baixados pelo próprio usuário, de fontes de terceiros, e **não** passam por esta assinatura.

## Papéis e permissões

| Papel | Quem | O que pode |
|---|---|---|
| Autor / mantenedor | [Mauro Braga](https://github.com/MauroBragaFilho) | Escreve e aprova o código; cria as tags de release |
| Revisor | Mauro Braga | Revisa as alterações que entram na `main` |
| Aprovador de assinatura | Mauro Braga | Aprova no SignPath cada pedido de assinatura de produção |

Hoje o projeto tem um único mantenedor, que acumula os três papéis. Se entrarem novos colaboradores, esta tabela será atualizada antes de eles receberem qualquer
permissão de escrita, aprovação ou assinatura.

## Quando um build é assinado

- Somente builds de **produção** disparados por uma **tag de versão** (`vX.Y.Z`) criada a partir da branch `main` são enviados para assinatura.
- Pushes comuns, pull requests e branches de teste **não** geram binários assinados.
- O pedido de assinatura sai exclusivamente do workflow [`.github/workflows/release.yml`](.github/workflows/release.yml), rodando em **runners hospedados pelo GitHub**.
  O SignPath confere a origem (repositório, commit, workflow) com o GitHub; esses metadados não podem ser forjados pelo script de build.
- A política de assinatura de produção no SignPath exige **aprovação manual** do aprovador acima antes de o certificado ser usado.
- Se a assinatura não for aprovada ou não chegar válida, o workflow falha e **nada é publicado**.

## Como o código é revisado antes de assinar

1. As alterações entram na `main` por commit do mantenedor ou por pull request, e o CI ([`ci.yml`](.github/workflows/ci.yml)) roda o lint, os testes e o teste de instalação
   e atualização do instalador numa máquina limpa.
2. Contribuições de terceiros só entram por pull request revisado pelo mantenedor.
3. Antes de criar a tag, o mantenedor confere o que mudou desde a última versão.
4. O workflow de release repete o lint e os testes e só prossegue se passarem. As dependências de desenvolvimento são instaladas com `npm ci` (versões travadas no
   `package-lock.json`); o aplicativo não tem dependências de runtime do npm.
5. O workflow confere que o commit da tag pertence à `main`; tags fora dela são rejeitadas antes de qualquer build.

## Proteção dos segredos

- O token de API do SignPath (`SIGNPATH_API_TOKEN`) fica **apenas** em *GitHub Actions secrets* do repositório. Nunca é gravado no código, em logs ou em arquivos de configuração.
- O token pertence a um usuário do SignPath com permissão de **submitter** apenas nesta política de assinatura.
- A chave privada do certificado **nunca sai** do HSM do SignPath; o Braga Frame e o GitHub nunca têm acesso a ela.
- Segredos não são expostos a builds de pull requests (o workflow de release roda só em tags e o GitHub não entrega segredos a PRs de forks). A conta do mantenedor usa
  autenticação em dois fatores.
- Em caso de suspeita de vazamento, o token é revogado no SignPath e recriado, e a ocorrência é registrada nas Releases.

## Privacidade

O Braga Frame não envia dados do usuário a ninguém por causa da assinatura. O programa só usa a internet para o que o usuário pede (baixar ferramentas e vídeos, IA na nuvem)
e para a consulta de versão nova ao abrir, que leva só o nome e a versão do app e pode ser desligada em Configurações > Geral > Atualizações. Veja o [README](README.md)
e [docs/atualizacao.md](docs/atualizacao.md).

## Verificação pelo usuário

Cada Release traz o instalador e o GitHub mostra o SHA-256 dele ao lado do arquivo (o texto da Release o repete). Depois da aprovação do projeto, o instalador também
terá a assinatura digital. No Windows: *botão direito no `.exe` → Propriedades → Assinaturas Digitais*, ou em PowerShell:

```powershell
Get-AuthenticodeSignature .\braga-frame-0.1.1-windows-x64-setup.exe
Get-FileHash .\braga-frame-0.1.1-windows-x64-setup.exe -Algorithm SHA256
```

## English summary

Free code signing provided by SignPath.io, certificate by SignPath Foundation. Braga Frame is GPL-3.0-or-later software. The installer is **not signed yet**; this policy
describes how signing will work once the project is approved. Only release builds triggered by a version tag (`vX.Y.Z`) on the `main` branch, built on GitHub-hosted
runners by `release.yml`, are submitted for signing, and each signing request requires manual approval by the maintainer (Mauro Braga) in SignPath. Code is reviewed by
the maintainer and checked by CI (lint, tests, installer install/update test) before tagging. The `SIGNPATH_API_TOKEN` is stored only as a GitHub Actions secret; the
private key never leaves SignPath's HSM. Third-party tools downloaded by the user (FFmpeg, yt-dlp, …) are not signed by this process.
