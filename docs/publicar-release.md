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
| Artefatos do Actions | não há: o instalador vai do disco do runner direto para a Release |
| Cache do Actions | o workflow de release não usa (as dependências são baixadas de novo a cada versão: custa uns minutos, não ocupa espaço) |
| Release pela metade | a Release só é criada depois do lint, dos testes e da compilação; se o envio cair no meio, o rascunho é apagado |
| Logs das execuções | ficam pelo prazo do repositório; para encurtar: Settings > Actions > General |

O CI (`ci.yml`) mantém o cache do `npm`, que é pequeno e some sozinho depois de 7 dias sem uso.

## Pré-requisitos

Nenhum segredo: a Release é criada com o `GITHUB_TOKEN` do próprio workflow (`contents: write`, só no job de release). Se o repositório restringir as permissões do token, libere em Settings > Actions > General > Workflow permissions.

## O que ainda não existe

- **Assinatura digital**: o instalador sai sem assinatura. O ponto de encaixe é entre "Compilar o instalador" e "Publicar a Release" (o BDS assina pela SignPath; veja `release-bds.yml` no repositório dele). Depende da licença de código aberto (decisão pendente).
- **Teste do instalador publicado**: o job `installer` do CI testa um instalador gerado do mesmo código e da mesma configuração, com outra identidade; o arquivo que vai para a Release não é instalado nem aberto pelo workflow.
- **Execução real do workflow**: ele foi escrito e validado só quanto à sintaxe e aos trechos que dá para rodar localmente (nome do instalador, texto da Release). A primeira tag enviada é o primeiro teste de verdade.
