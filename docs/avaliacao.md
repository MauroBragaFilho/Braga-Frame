# Avaliação da qualidade dos cortes (Etapa 4)

Objetivo: **demonstrar com dados que as sugestões ajudam o usuário a achar os momentos que importam**, e não só que o motor encontra muitos candidatos. Este documento define a estratégia, as métricas e o protocolo; a seção "O que já foi medido" mostra o que existe hoje e o que **ainda não** dá para afirmar.

## 1. Princípios

1. **Achar mais candidatos não é ser melhor.** Comparar motores só com o **mesmo número de sugestões por hora** (`--budget`). Um motor que devolve 40 sugestões por hora vai sempre acertar mais do que um que devolve 5; o que interessa é o que cada um acerta *com o mesmo orçamento* e quanto de vídeo o usuário precisa assistir.
2. **Referência humana.** O gabarito é feito por pessoas: a lista de momentos que o dono marcou sozinho (para a revocação) e as decisões de aprovar e rejeitar nas sugestões (para a precisão). Gabarito de *proxy* (o gráfico de "mais reassistidos" do YouTube) serve para triagem e fica sempre identificado como `proxy`.
3. **Sempre contra o acaso.** Um gabarito pequeno é acertado ao acaso com frequência; todo número de revocação sai ao lado do que trechos sorteados com as mesmas durações acertariam (`R/acaso`).
4. **Separar ajuste de teste.** Ajustar o motor numa metade da live (`--from/--to` do `scripts/eval-analysis.js`) e medir na outra; reportar as duas.
5. **IA varia.** Rodar cada motor com IA pelo menos 3 vezes por amostra e reportar a média e a faixa, não a melhor rodada.

## 2. Amostras representativas

Mínimo proposto: **3 lives por categoria**, com pelo menos **12 itens de gabarito por live** (menos que isso, a precisão não diz nada).

| Categoria | Por que entra |
|---|---|
| Gameplay com chat ativo | o caso em que o chat é pista forte |
| Gameplay com chat parado | a pista de chat some; áudio e fala carregam tudo |
| Podcast / conversa | pouca mudança de imagem; o humor está na fala |
| Momentos engraçados | o alvo principal do canal |
| Reações (react, surpresa, susto) | picos de voz e exclamação |
| Acontecimentos importantes (conquista, derrota, virada) | relevantes sem humor |
| Relevantes sem chat | o que um filtro de chat perderia |
| Live longa (> 3 h) | custo, tempo e limites de provedor |

Cada amostra tem: id, categoria, duração, vídeo (não vai ao repositório), transcrição, chat (se houver), gabarito e o tipo dele (`humano` ou `proxy`).

## 3. Como fazer o gabarito humano com pouco trabalho

- **Revocação (o que o motor deixou de achar)**: o dono marca os melhores momentos **antes** de ver qualquer sugestão. Duas formas: criar cortes à mão na aba Cortes (ficam com `origin: manual`) ou escrever uma lista `[{ "s": início, "e": fim, "t": "título" }]`.
- **Precisão (o que o motor mostrou)**: as decisões de aprovar e rejeitar sugestões na revisão normal. `node scripts/exportar-gabarito.js --project <projeto.json>` mostra a **taxa de aprovação** por origem e grava os aprovados como gabarito (`--origin manual` para a revocação, sem misturar com os aprovados que vieram do motor).
- **Cuidado com a circularidade**: um corte aprovado que veio de uma sugestão só prova que a sugestão era boa; usá-lo como gabarito de revocação do mesmo motor infla o número.

**Estado hoje**: nos 3 projetos do dono neste computador há **1 corte aprovado e 0 rejeitados** (os demais estão pendentes). Não existe ainda gabarito humano suficiente: **falta o dono revisar** (veja a seção 7).

## 4. Métricas

Regra de "bater" (a mesma do app e dos scripts, `src/core/analysis/metrics.js`): o **início** da sugestão difere do item do gabarito em até 5 s, **ou** a sobreposição é de pelo menos 50% da menor das duas durações. Pareamento **1:1** (cada sugestão serve a um item).

| Métrica | Definição |
|---|---|
| **Precisão** | pares / sugestões. Quantas das sugestões mostradas são boas |
| **Revocação** | pares / itens do gabarito. Quantos dos bons momentos o motor mostrou |
| **F1** | média harmônica de precisão e revocação |
| **Repetidas** | sugestões que repetem um momento já coberto por outra, mais relevante (início a ≤ 8 s ou 30% de sobreposição) / sugestões |
| **Relevância** | quão bem a ordem de relevância do motor concorda com o gabarito: a revocação das N mais relevantes (`atBudget`) e a curva abaixo |
| **Tempo de análise** | `tookMs` do resultado (inclui o que veio de cache: reportar quando é a 1ª execução) |
| **Ganho de tempo** | fração do gabarito que a lista mostra ÷ fração do vídeo que ela pede para assistir (união dos trechos). Olhar à toa dá 1,0×; 4,0× quer dizer "o mesmo que assistir 4 vezes mais vídeo sem critério" |
| **R/acaso** | revocação (qualquer sugestão que bate) ÷ o que o acaso acerta (20 mil sorteios com as mesmas durações) |

`reviewCurve` (em `metrics.js`) dá a curva completa (revocação × segundos assistidos, da sugestão mais relevante para a menos) e o tempo para chegar a 25%, 50% e 75% do gabarito, contra percorrer o vídeo à mão.

## 5. Como rodar

```bash
# um motor contra um gabarito (o que já existia, agora com F1 e repetidas)
node scripts/eval-analysis.js --result resultado.json --gold gabarito.json --chance <duração em s>

# vários motores, várias lives, por categoria; --budget iguala o número de sugestões
node scripts/benchmark-analise.js --manifest manifesto.json --budget 5 --draws 2000

# decisões do usuário num projeto -> taxa de aprovação e gabarito
node scripts/exportar-gabarito.js --project <projeto.json> --origin manual --out gabarito.json
```

Manifesto (caminhos relativos à pasta dele; nada disso vai ao repositório):

```json
{ "nome": "Rodada 1", "tolerancia": 5, "sobreposicao": 0.5,
  "amostras": [ { "id": "live-1", "categoria": "gameplay-chat-ativo", "duracao": 11089, "tipoGabarito": "humano",
                  "gabarito": "gold/live-1.json",
                  "motores": { "algoritmo": "motor/live-1.json", "ia": "ia/live-1.json", "algoritmo+ia": "ambos/live-1.json" } } ] }
```

## 6. O que já foi medido (e o que NÃO prova)

**Dados**: 17 lives de 3 canais (31 h), legenda automática do YouTube, **sem chat e sem IA**; gabarito **proxy** = as 5 faixas mais reassistidas de cada live (85 itens). Motores: o **algoritmo** (quantidade automática), o modo **"só os melhores"** (4 por hora) e o conjunto de **janelas candidatas** que a IA veria (20% de orçamento, `windowsFromSuggestions`). Gabarito proxy: a precisão **não** pode passar de ~10%, porque só 5 faixas por live contam como "boas"; vale para **comparar** motores, não como número absoluto.

Mesmo orçamento de **5 sugestões por hora** (as mais relevantes de cada motor):

| Motor | Sugestões | Precisão | Revocação | F1 | Repetidas | Vídeo a assistir | Revocação ÷ acaso | Ganho de tempo |
|---|---|---|---|---|---|---|---|---|
| algoritmo (5 melhores por hora) | 153 | 14,4% | 25,9% | 18,5% | 0,0% | 6,6% | 2,8× | **3,9×** |
| "só os melhores" | 149 | 12,1% | 21,2% | 15,4% | 0,0% | 5,3% | 2,4× | 4,0× |
| janelas para a IA | 153 | 16,3% | 29,4% | 21,0% | 0,7% | 9,3% | 2,8× | 3,2× |

Sem corte (cada motor com tudo o que devolve): o algoritmo, com 642 sugestões (20,7 por hora), mostra **54%** dos picos assistindo **21,9%** do vídeo (**2,5×** de ganho; análise de 4,7 min no total), e o conjunto de janelas, com 13% do vídeo, tem **38%** dos picos dentro (o teto do que a IA pode achar nele).

**O que isso mostra**
1. **A ordem de relevância funciona**: com o mesmo orçamento, pegar as 5 mais relevantes por hora do algoritmo vale tanto (F1 18,5% contra 15,4%) quanto o modo "só os melhores"; o modo não acrescenta nada além do corte.
2. **As sugestões ajudam, contra este gabarito**: para o mesmo tempo assistindo, a lista mostra 3 a 4 vezes mais dos momentos que o público mais reassistiu do que olhar o vídeo sem critério, e acerta 2,8 vezes o que o acaso acertaria (sorte < 0,1% no estudo anterior, mesmas lives).
3. **Quase não há sugestão repetida** (0% no algoritmo; ~1% nas janelas).

**O que isso NÃO prova**
- O gráfico mede o que o **público reassiste na live inteira**, não o que funciona como **short**; as duas réguas discordaram no estudo anterior (os shorts que o canal publicou ficam abaixo do meio do gráfico).
- **Não é gabarito humano**, não separa as categorias da seção 2 (as 3 "categorias" do relatório são canais) e não tem chat.
- **Nada sobre a IA**: nenhuma chave de provedor foi usada. Precisão, revocação, F1 e repetidas da IA (e do modo Algoritmo + IA) continuam **sem medição**.
- O critério "demonstrar que ajuda" **não está cumprido com gabarito humano**.

## 7. O que falta e quem faz

| Item | Quem | Observação |
|---|---|---|
| Marcar à mão os melhores momentos de 3 a 8 lives (≥ 12 por live), **antes** de rodar a análise | dono | é o que dá a revocação humana; 1 a 2 h por live com a legenda do app |
| Revisar (aprovar/rejeitar) as sugestões dessas lives | dono | dá a precisão e a taxa de aprovação (`exportar-gabarito.js`) |
| Rodar IA e Algoritmo + IA 3 vezes por amostra com provedor real | dono (chave) + Claude | custo e tempo reais entram no relatório |
| Chat baixado nas lives de teste | dono | sem ele a categoria "chat ativo" não existe |

**Critérios de aceite propostos** (para o dono aprovar ou mudar): com gabarito humano de pelo menos 8 lives (1 por categoria) e orçamento de até 10 sugestões por hora, (a) ganho de tempo ≥ 2,0×; (b) revocação ≥ 1,5× o acaso, com sorte < 1%; (c) repetidas ≤ 5%; (d) para dizer que a IA melhora o algoritmo, F1 maior no mesmo orçamento em pelo menos 2 de cada 3 categorias, na média de 3 rodadas.
