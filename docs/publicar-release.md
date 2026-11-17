# Publicar uma versão (Release)

Publicar é enviar uma **tag**. O GitHub Actions (`.github/workflows/release.yml`) compila o instalador e cria a Release sozinho.

```bash
git tag v0.2.0
git push origin v0.2.0
```

- A versão do app e do instalador é a **da tag**, sem o "v". O `package.json` não precisa mudar antes.
- A tag tem de ser `vX.Y.Z` e o commit dela tem de estar na `main`; senão o workflow para antes de compilar.
- Pushes na `main` **não** publicam nada (só o CI roda).
- Antes de compilar, o workflow roda o lint e todos os testes, como o CI. Só uma versão que passa chega à Release.
- Para refazer uma versão (por exemplo, depois de corrigir algo): `git push --force origin v0.2.0` troca a Release e o arquivo; a tag é mantida.

## O que sai na Release

**Um arquivo só**, no padrão `braga-frame-<versão>-windows-x64-setup.exe` (versão, sistema e arquitetura no nome, o mais detalhado dos dois padrões que o BDS usa hoje). O texto da Release traz uma frase de instalação, o SHA-256 e a lista de mudanças desde a tag anterior (os títulos dos commits). Não há arquivo de somas à parte: o GitHub mostra o SHA-256 de cada arquivo ao lado dele.

O padrão do nome vem de `build.nsis.artifactName` no `package.json`; `tests/installer-script.test.js` confere que o workflow procura o mesmo nome.

## Sem lixo no GitHub

| O quê | Como |
|---|---|
| Artefatos do Actions | não há: o instalador vai do disco do runner direto para a Release. **Só com a assinatura ligada** ele sobe como artefato (a SignPath precisa lê-lo), por 1 dia, e um passo o apaga logo depois, dê certo ou errado |
| Cache do Actions | o workflow de release não usa (as dependências são baixadas de novo a cada versão: custa uns minutos, não ocupa espaço) |
| Release pela metade | a Release só é criada depois do lint, dos testes e da compilação; se o envio cair no meio, o rascunho é apagado |
| Logs das execuções | ficam pelo prazo do repositório; para encurtar: Settings > Actions > General |

O CI (`ci.yml`) mantém o cache do `npm`, que é pequeno e some sozinho depois de 7 dias sem uso.

## Pré-requisitos

Nenhum segredo: a Release é criada com o `GITHUB_TOKEN` do próprio workflow (`contents: write`, só no job de release). Se o repositório restringir as permissões do token, libere em Settings > Actions > General > Workflow permissions.

## Como o app fica sabendo

O aviso de versão nova ([atualizacao.md](atualizacao.md)) lê a **última Release publicada** (`/releases/latest`) e compara a tag com a versão instalada. Por isso a tag precisa ser `vX.Y.Z`; rascunhos e pré-lançamentos são ignorados. Enquanto não houver nenhuma Release, o app mostra "O projeto ainda não publicou nenhuma versão". **O primeiro teste de verdade do aviso é a primeira tag**: instale uma versão mais antiga e veja a faixa aparecer.

## O que ainda não existe

- **Assinatura digital**: o instalador da v0.1.0 saiu sem assinatura. Os passos de assinatura (SignPath Foundation) **já estão no `release.yml`**, entre "Compilar o instalador" e "Publicar a Release", e ligam sozinhos quando a variável `SIGNPATH_ORGANIZATION_ID` existe no repositório; sem ela o workflow segue publicando sem assinar. Falta a inscrição e a aprovação do projeto na SignPath: [assinatura-signpath.md](assinatura-signpath.md). Com a assinatura ligada, o artefato que a SignPath lê dura 1 dia e é apagado depois, e o workflow espera a sua aprovação manual (até 5 horas).
- **Teste do instalador publicado**: o job `installer` do CI testa um instalador gerado do mesmo código e da mesma configuração, com outra identidade; o arquivo que vai para a Release não é instalado nem aberto pelo workflow.
- **Execução real do workflow**: rodou de verdade na **v0.1.0** (lint, testes, compilação e Release, em cerca de 10 minutos, com 0 artefatos e sem cache). **A parte da assinatura nunca rodou**: só foi validada na sintaxe, em testes de texto (`tests/release-workflow.test.js`) e conferindo que as entradas da ação da SignPath existem na versão fixada.
