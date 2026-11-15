# Fontes empacotadas: origem e licenças

Fontes de interface do Braga Frame (offline, carregadas por `renderer/fonts.css` e `renderer/material-symbols.css`).
São **as mesmas do Braga Digital Studio (BDS)**: os arquivos foram copiados, sem alteração, de `renderer/assets/fonts/` do BDS,
que por sua vez os baixou dos repositórios/releases oficiais de cada projeto (detalhes e SHA-256 no `FONTES_ORIGEM.md` do BDS).
Nada de CDN, pacote de terceiros ou conversão local.

| Arquivo | Fonte | Origem oficial | Licença | SHA-256 |
|---|---|---|---|---|
| `Inter-Regular.woff2` | Inter 4.1 (texto, peso 400) | https://github.com/rsms/inter (release v4.1, `web/`) | SIL OFL 1.1 (`OFL-Inter.txt`) | `e06f6b1bc553aaea4e4668023ed0ab0a147129c3107f511bc7d03d361b0ae085` |
| `Inter-SemiBold.woff2` | Inter 4.1 (pesos 600/700) | idem | idem | `5cb7103e4e605989afebc03d989c79201e54b21b5183db33981f70db9178a301` |
| `Montserrat-Bold.woff2` | Montserrat 7.222 (títulos, peso 700) | https://github.com/JulietaUla/Montserrat (tag v7.222, `fonts/webfonts/`) | SIL OFL 1.1 (`OFL-Montserrat.txt`) | `294653dc1466dcda027c8ff4d80f7bc8fb074fc0daacab9afde68c1f7646bb1d` |
| `material-symbols-rounded.woff2` | Material Symbols Rounded (ícones por ligadura; instância opsz 24, wght 400, FILL 1) | https://fonts.google.com/icons e https://github.com/google/material-design-icons | Apache 2.0 (`APACHE-MaterialSymbols.txt`) | `381818aa7bd782cf923c85e90931a3aeb9e1e0bc2ecf72ed09252fd9f1675cf3` |

Observação honesta: o SHA-256 acima é dos arquivos como estão aqui (copiados do BDS). Para as duas primeiras fontes e a Montserrat ele
coincide com o registrado no BDS; para a fonte de ícones o BDS não registra o hash do download original, então a origem é a
declarada por ele (Google, Apache 2.0) e não foi reverificada contra o site do Google.
