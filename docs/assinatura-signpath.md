# Assinatura de código com a SignPath Foundation — guia

A SignPath Foundation assina de graça os instaladores de projetos de **código aberto**. O Braga Frame agora é GPL v3 ou posterior e já tem uma Release (v0.1.0, sem assinatura), então pode se inscrever. O molde é o do Braga Digital Studio (BDS), que já passou por isso (`.docs/ASSINATURA_SIGNPATH.md` no repositório dele).

**Estado:** o repositório está **preparado**, mas **a assinatura não está ligada e nunca foi testada de ponta a ponta**: ela depende de uma aprovação sua no portal da SignPath. Nada aqui foi enviado à SignPath.

## O que já está no repositório

| Arquivo | Para quê |
|---|---|
| [`CODE_SIGNING_POLICY.md`](../CODE_SIGNING_POLICY.md) | A política de assinatura pública que a SignPath exige (papéis, quando assina, revisão, segredos, privacidade) |
| [`.signpath/artifact-configuration.xml`](../.signpath/artifact-configuration.xml) | O que assinar: o instalador, com o nome fixo `braga-frame-setup.exe` (o workflow o envia assim e depois devolve o nome com a versão) |
| [`.github/workflows/release.yml`](../.github/workflows/release.yml) | Os passos de assinatura, entre "Compilar o instalador" e "Publicar a Release" |
| `README.md` (seção Assinatura de código) | O aviso que a SignPath pede, a ser ativado depois da aprovação |

## Como o workflow assina

1. A assinatura **liga sozinha** quando a variável `SIGNPATH_ORGANIZATION_ID` existe no repositório. Sem ela, o workflow publica sem assinatura (como a v0.1.0) e o log mostra um aviso.
2. Com ela: o instalador sobe como artefato do Actions com nome fixo, a SignPath o lê, **espera a sua aprovação manual no portal** (até 5 horas), e o workflow baixa o assinado.
3. O workflow **confere a assinatura** (`Get-AuthenticodeSignature` precisa dar `Valid`); se não der, falha e **nada é publicado**.
4. O instalador assinado substitui o outro, e **é ele** que vai para a Release (o SHA-256 do texto da Release é o do arquivo assinado).
5. **Sem lixo:** o artefato intermediário dura 1 dia no máximo e é apagado logo depois da assinatura (`actions: write` só para isso).

Só são assinadas tags `vX.Y.Z` cujo commit está na `main` (o workflow já recusa as outras).

## 1. Antes de pedir: confirme estes pontos

A política em `CODE_SIGNING_POLICY.md` afirma coisas sobre você e o projeto. **Leia e confirme, porque eu não tenho como verificar:**

- [ ] **Autenticação em dois fatores** ligada na sua conta do GitHub (e na da SignPath, quando existir). A política diz que usa.
- [ ] **Contribuições de terceiros só entram por pull request revisado por você.** É um compromisso novo para o projeto; hoje você publica direto na `main`.
- [ ] Você é o **único mantenedor e aprovador** (a tabela de papéis diz isso).
- [ ] O repositório é **público** (é) e **sem componentes proprietários** no que será assinado (o instalador só leva o app, o Electron e as fontes; veja `THIRD-PARTY-NOTICES.md`).
- [ ] As ferramentas que o app baixa (FFmpeg, yt-dlp, …) **não são assinadas por você**. Diga isso com clareza no pedido (a política já diz).

**Não verifiquei as regras atuais da SignPath Foundation** (critérios de elegibilidade, texto exigido, limite de projetos por organização). Os critérios completos estão em <https://signpath.org/terms>. Em especial, confirme se uma **mesma organização aceita dois projetos** (BDS e Braga Frame) ou se o Braga Frame precisa de uma inscrição à parte.

## 2. O pedido no portal

Formulário em <https://signpath.org/apply>. Campos essenciais:

| Campo | O que colocar |
|---|---|
| Project name | Braga Frame |
| Project homepage / Repository URL | `https://github.com/MauroBragaFilho/Braga-Frame` |
| License | GNU GPL v3 ou posterior (link para o `LICENSE` no repositório) |
| Description | Aplicativo de desktop (Electron) que analisa gameplays e lives, ajuda a revisar cortes e exporta em vertical com controle de qualidade. |
| Code signing policy URL | Link do `CODE_SIGNING_POLICY.md` no repositório |
| Build system | GitHub Actions (hospedado pelo GitHub), workflow `release.yml` |
| Artifact type | Instalador Windows `.exe` (NSIS), assinatura Authenticode |
| Maintainer / approver | Mauro Braga (conta do GitHub e e-mail) |
| Download page | `https://github.com/MauroBragaFilho/Braga-Frame/releases` |

## 3. Depois da aprovação: configurar o portal

No portal (<https://app.signpath.io>):

1. **Project**: defina o *slug* `braga-frame` (é o padrão do workflow; se usar outro, ajuste a variável `SIGNPATH_PROJECT_SLUG`).
2. **Artifact Configurations**: crie a configuração padrão colando o conteúdo de `.signpath/artifact-configuration.xml`.
3. **Signing Policies**: use a de release (slug `release-signing`, o padrão do workflow) com **aprovação manual** (você).
4. **Trusted Build Systems**: vincule o **GitHub.com** e instale o **SignPath GitHub App** no repositório (<https://github.com/apps/signpath>); confirme que o projeto está associado ao repositório.
5. **Users**: crie um usuário **submitter** só para a CI e gere o **API Token** dele.
6. Anote o **Organization ID** (na página da organização).

## 4. Secrets e variáveis no GitHub

`Settings → Secrets and variables → Actions`:

| Tipo | Nome | Valor |
|---|---|---|
| **Secret** | `SIGNPATH_API_TOKEN` | API Token do usuário submitter |
| **Variable** | `SIGNPATH_ORGANIZATION_ID` | Organization ID (**é esta que liga a assinatura**) |
| Variable (opcional) | `SIGNPATH_PROJECT_SLUG` | slug do projeto; padrão `braga-frame` |
| Variable (opcional) | `SIGNPATH_SIGNING_POLICY` | slug da política; padrão `release-signing` |

Crie o **secret antes** da variável `SIGNPATH_ORGANIZATION_ID`: é a variável que liga a assinatura, e sem o token o workflow falharia na hora de assinar.
Recomendado: proteger a `main` e restringir quem cria tags `v*` (Settings → Rules → Rulesets).

## 5. A primeira Release assinada

1. Envie uma tag nova (por exemplo `git tag -a v0.1.1 -m "Braga Frame 0.1.1"` e `git push origin v0.1.1`). Se algo der errado, corrija e refaça com `git push --force origin v0.1.1` (a Release é refeita; a tag fica).
2. Quando o workflow chegar em "Assinar na SignPath", **aprove o pedido** no portal (e-mail ou *Signing Requests*).
3. Confira a Release: o texto diz "Instalador assinado digitalmente" e, no Windows, *Propriedades → Assinaturas Digitais* do `.exe` mostra a SignPath Foundation. O SmartScreen ainda pode avisar por um tempo: a reputação de um certificado novo se constrói com o uso.
4. **Atualize o README**: troque o texto "ainda não é assinado" da seção Assinatura de código pelo texto exigido, "Free code signing provided by SignPath.io, certificate by SignPath Foundation", e o `CODE_SIGNING_POLICY.md` (tire o aviso de "ainda não é assinado").

## Depois da primeira Release assinada: o que muda para os apps instalados

O sistema de atualização ([atualizacao.md](atualizacao.md)) confere a assinatura do instalador baixado contra a do app em uso. Na prática:

- Quem instalou a **primeira versão assinada** passa a aceitar **só** atualizações assinadas **pelo mesmo emissor**. Uma Release sem assinatura (por exemplo, se você apagar `SIGNPATH_ORGANIZATION_ID` para publicar sem assinar, ou se a assinatura falhar) **não chega** a esses usuários pela atualização: o app recusa como rebaixamento.
- Trocar o certificado por outro de **outro emissor** também é recusado (`SIGNER_CHANGED`). Renovações do mesmo emissor passam.
- A atualização **de uma versão sem assinatura para a primeira assinada** é aceita (o app em uso não tem assinatura para comparar).

## Se der errado

| Sintoma | Causa provável |
|---|---|
| O workflow publica **sem** assinatura | A variável `SIGNPATH_ORGANIZATION_ID` não existe (o log avisa); é o comportamento de antes da aprovação |
| Falha em "Assinar na SignPath" por autenticação | Token ou Organization ID errados; ou o usuário não é *submitter* da política |
| Falha esperando a aprovação | Passaram 5 horas sem aprovar; refaça a tag |
| "Assinatura inválida" | O que a SignPath devolveu não passa em `Get-AuthenticodeSignature`; nada é publicado |
| Quer voltar a publicar sem assinar | Apague a variável `SIGNPATH_ORGANIZATION_ID` |

## O que NÃO foi verificado

Nada disto rodou de ponta a ponta: a assinatura depende da aprovação do projeto. O que foi verificado: a sintaxe do workflow e a estrutura dele (`tests/release-workflow.test.js`: assinatura opcional e condicionada à variável, ações fixadas por SHA, artefato de 1 dia e apagado depois, nome fixo igual ao da configuração), e que as entradas da ação da SignPath (`api-token`, `organization-id`, `project-slug`, `signing-policy-slug`, `github-artifact-id`, `wait-for-completion`, `output-artifact-directory`) existem na versão fixada. **Não foi verificado**: que a SignPath aceita o `pe-file path="braga-frame-setup.exe"` dessa configuração, nem a ordem exata dos cliques no portal, que mudam com o tempo.
