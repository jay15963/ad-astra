# PROGRESS — Ad Astra (web)

## Estado (nov/2026)
- **Versão 0.7.0 — Fase B: o jogador e suas ferramentas.** Fundar a própria agência (tipo, país, sede no mapa, nome e logo
  editável), emblemas novos para todas as agências, investidores e participação (mandatos no lugar das missões de programa,
  rodadas anuais, autonomia com ≥ 50%, conselho que demite), Hangar (licenciar e editar um foguete existente ou montar do zero,
  desenvolvimento e voos de teste), mapa-múndi por época (Guerra Fria, URSS, colônias) e mapa espacial até o setor estelar e a
  galáxia com névoa de guerra. Telas novas: Conselho, Identidade e logo, Hangar, Finanças, Calendário de lançamentos, Anais.
  Detalhes em "v0.7.0" abaixo.
- **Versão 0.6.0 — Fase A da expansão 1950–3000** (alicerce; contrato em `docs/EXPANSION.md`). Nova **Campanha 1950 → jan/3000**
  jogável de ponta a ponta (7 eras, passo de tempo que cresce de 1 semana a 1 ano, agências que nascem, mudam de nome, se fundem
  e acabam com a história real até 2030 e por geração depois, cartão final em 3000 com Contato · Silêncio · Herança). A
  **Corrida Lunar 2026–2030** continua como Cenário, idêntica à v0.5 (teste golden). O jogador agora **escolhe o foguete e a nave**
  ao aceitar uma missão (item 9). Novo menu ☰ (gaveta no estilo do CSmanager) com registro de telas. Detalhes em "v0.6.0" abaixo.
- Versão 0.4.0: certificação tripulada de foguetes durante o jogo, rotações tripuladas dos rivais (mortes no alvo), programas da IA
  custam caixa, manchetes variadas, PWA instalável e ajustes para celular intermediário. (0.3.0: rivais ativos, chance mostrada =
  chance real, blocos vivos; 0.2.0: Sistema Solar, mapa espacial, grafo de pesquisa, mapa-múndi, SW.) Detalhes em "v0.4.0" abaixo.
- Corte vertical "Corrida Lunar 2026–2030" jogável de ponta a ponta no navegador: novo jogo, briefings, montagem de missão em 3 passos,
  agendamento, Dia de Lançamento (subida e chegada), trânsito, pesquisa, equipe, diplomacia, Tabela da Era, salvar/continuar.
- 9 módulos de simulação + UI integrados. Contratos e desvios aceitos documentados em `ARCHITECTURE.md` ("Integração").
- Testes: `npm test` (`node --test tests/*.test.mjs`) → 277/277 (inclui `calendar-ai`, `geo-blocs`, `diplomacy-blocs`, `narrative-variety`,
  `missions-window`, `ui-layout`, `sw`). Smoke: `node tools/smoke.mjs 4`
  → 20/20 sem erro (o bot ingênuo aceita tudo e às vezes é demitido por dívida: esperado). `node tools/sim-campaign.mjs` → 15/15 campanhas até o fim.
- Checagem no navegador (Chrome headless, 375×812): novo jogo pela tela de título, decisões pelas folhas, montagem em 3 passos,
  cena de subida e de chegada (órbita lunar) até o resultado, recarregar no meio da subida e no meio da chegada (retoma e conclui),
  varredura de todas as abas/segmentos sem "undefined/NaN/null" nem estouro horizontal, sem erros de console.

## Como testar
- `npm test`; `node tools/smoke.mjs 4`; `node tools/sim-campaign.mjs` (balanço por ator).
- Navegador: `python -m http.server 8150` na raiz e abrir `http://localhost:8150/` em 375×812.
- Service worker: o painel de navegador embutido não registra SW; testar no Chrome (headless via CDP: mudar um módulo e recarregar
  mostra o código novo; offline abre a última cópia).

## Balanceamento (tools/sim-campaign.mjs, 4 sementes por ator)
- Voos/ano do bot: NASA 5,8 · CNSA 6,7 · ISRO 4,8 · ESA 6,0 · SpaceX 15,9 (empresa, vive de contratos).
- Dinheiro: NASA fecha anos com caixa entre −0,9 bi e +2 bi; ISRO e ESA sempre apertadas.
- Pouso tripulado chinês (rival): nov/2029 a jan/2030. Artemis IV (rival): mar/2029 a fev/2030. NASA jogadora: fev–abr/2028.
- Apoio e reputação ficam em 65–90 (antes batiam 100). Verba da NASA sobe de 9 para 11–13 bi em 4 anos (antes 14–16 bi).

## Feito na integração
- Sinais: `{...payload, type}` no core; `mission/resolved` usa `missionType` em todos os leitores.
- Artemis: a Orion pousa com um lander pré-posicionado (Starship HLS / Blue Moon Mk2) como módulo de apoio; o Lanyue voa com a Mengzhou.
- Acesso a lançadores: política nacional (NASA, CNSA e Roscosmos só usam foguetes do próprio país). O Tratado do Espaço Exterior não abre
  mais o acesso ao SLS para a China. A Europa não lança para a CNSA.
- Estreia de veículo voada pelo jogador (Longa Marcha 10) agora libera o veículo. Antes o pouso chinês do jogador ficava travado.
- Pouso no polo sul também conta como pouso na Lua (robótico e tripulado).
- Meta da era "Voo orbital tripulado próprio" ligada ao marco certo.
- Economia: retorno decrescente em apoio/reputação, reajuste anual amortecido, hardware genérico mais caro para destinos distantes.
- UI: ícones e tags de notícia em pt-BR, diretor de voo pré-escolhido no montador, lista de naves só com as compatíveis,
  avisos e causas sem duplicata.
- Bot de campanha "esperto" (`tools/sim-campaign.mjs`), smoke voando missões de verdade.

## Revisão de integridade e equilíbrio (nov/2026, lado sim)
- Exploits fechados: marco de programa só com o programa de verdade (destino/tipo travados), verba como fração do custo, `paidM`
  (ajuste e reembolso pelo que foi pago), `'mission/create'` sem campos privilegiados, hardware checado na data do lançamento,
  nada roda depois do fim (e `onGameEnd` roda também quando a direção é demitida), `joinBloc` com trava de recusa.
- Equilíbrio (`tools/sim-campaign.mjs`, 4 sementes): NASA jogadora/maior rival 1,07–1,52; CNSA 0,62–1,07; SpaceX 0,93–1,24.
  Pouso da NASA jogadora mar–out/2028 (pré-requisitos e atraso de prontidão do Artemis IV). Contingência ~40% das intervenções
  (Comando virou estoque). Perda de tripulação ~1 evento a cada 4 campanhas com voo além da LEO. SpaceX termina com 3,3–3,8 bi.
- Rivais fazem missões próprias e reagem aos "primeiros" do jogador; feitos históricos valem 35% ("primeiro do século").
- Tratados IA–IA rompem ~2 vezes por semente depois de 2027; acordos de 2026 (ISS, Artemis III) protegidos. Ainda 0 mudanças de bloco.
- O bot ingênuo do smoke é demitido mais vezes (Comando escasso + mais falhas): esperado, o bot "esperto" termina todas as campanhas.

## Ajustes cruzados sim ↔ UI (verificação final)
- Diplomacia: `refusalTrust`/`counterRefusalTrust` na prévia e nas linhas de proposta (a folha de confirmação mostra o custo real).
- `mission/resolved` traz `final`; `success_party` só dispara no resultado final (não na subida de uma missão com chegada).
  `activeLaunch.outcome.final` também existe.
- A cena de chegada herda estratégia e margem escolhidas no lançamento (`mission.config` atualizado em `launch/finish`).
- Fatores de risco só do dia do lançamento (confiabilidade do foguete, prazo apertado, carga no limite, sanções) têm `stages:['asc']`;
  a chegada os esconde. Rascunhos passam `createdTurn`, então "Prazo apertado" aparece no montador.
- Manchetes com frase de destino (`emLabel`/`toLabel` em destinations.json: "na órbita lunar", "a Marte"), sem repetir o destino
  quando o nome da missão já diz; causas no corpo da notícia separadas por " · " em linha própria. Rádio em metros.
- `draftOptions.autoName`; naves incompatíveis com o foguete escolhido vêm `valid:false` ("Só voa no …").
- UI: data de hardware pronto, aviso de programa com destino/tipo/tripulação definidos, parceiros (`partnersText`),
  "primeiro do século" + recorde histórico na Tabela, reserva de Comando no pré-lançamento, "polo sul" unificado.
- Correções achadas no navegador: "null" solto na folha de agendamento; datas antes de 2026 viravam "undefined/2025";
  chegada em órbita falava em "descida"; "1 voos"; "Diretor" para diretoras; títulos de contrato perdiam maiúsculas ("lua", "gto").

## Sistema Solar, mapas e integração final (nov/2026)
- Dados: 24 corpos novos (Mercúrio a Plutão, cinturões, Troianos, Kuiper), 21 destinos com janelas, 11 programas reais no calendário;
  sondas já em voo (BepiColombo, Hera, JUICE, Psyche, Lucy, Europa Clipper, OSIRIS-APEX, Tianwen-2) entram no turno 0 valendo 35% do prestígio.
- Feitos históricos novos em `scenario.historicalFirsts` (Mariner, Venera, MESSENGER, NEAR, Hayabusa, Dawn, Cassini, Voyager 2, New Horizons).
- Mapa espacial: 4 níveis, cinturões em faixas, anéis, névoa de guerra, missões em trânsito animadas, vista de Rotas (metrô) com
  "Planejar missão aqui" abrindo o montador já com o destino (`store.ui.planMission`).
- Pesquisa: grafo estilo KSP com pan/zoom, folha de detalhes e caminhos destacados.
- Mundo: mapa-múndi recolhível com zonas disputadas, conflitos (Rússia–Ucrânia já em curso), sedes, bases e linha do tempo.
- Montador avisa destinos que chegam depois de 2030; sondas em trânsito mostram "Em trânsito" (não "Sucesso").
- Integração final: rota de Titã passa por "Rumo a Saturno"; textos de dificuldade por destino novo no Dia de Lançamento;
  BepiColombo e JUICE aparecem como "Ariane 5" (`vehicleName`); `research/tree` traz `icon/short/tier/row`.
- Cache: `sw.js` rede-primeiro com revalidação; Ajustes mostra versão, build e estado da atualização automática.
- Verificação no navegador (375×812): novo jogo (ESA), contrato, eventos, sonda a asteroide próximo montada em 3 passos, cena de subida
  até o resultado, pesquisa iniciada pelo grafo, mapa nos 4 níveis + Rotas + planejar Vênus, mapa-múndi, recarregar → continuar.

## Revisão de equilíbrio (nov/2026, v0.3.0)
- Corrida NASA × CNSA (30 campanhas, `sim-campaign 6`): vitórias nasa 77% → ~50–57% / cnsa 23% → ~43–60% conforme a rodada;
  rank médio da IA líder 1,1 → 1,3–1,5. Quem pousa gente na Lua primeiro decide a corrida: pouso tripulado vale 75% como "primeiro do
  século" (`historicalFirsts.crewed_lunar_landing.share`), pessoas no polo sul só 35% (`scenario.firstShares`), landers CLPS pagam como
  contrato (`contract: true`), Artemis IV escorrega em média 5 meses por revisão (era 4) e `crewSafety` não infla mais o sucesso da IA.
- IA: planos de poupança reais para alvos caros (Roscosmos 0 → ~0,5 primeiros por campanha, alvos de Vênus), teto de 2 missões por
  destino (pousos lunares genéricos ~31 → ~9 por campanha), `ai.scienceInterest` (primeiros de espaço profundo de SpaceX/Blue Origin
  como IA: 79 → ~15 em 30 campanhas), adiar uma missão agendada do jogador tira a "ameaça" dela.
- Tripulações dos rivais morrem por `crew.backgroundCrewLoss` nas falhas tripuladas; `legacy_letter` e `failure_inquiry` sem teto de 3.
- Bot do `sim-campaign`: escolhe missão própria por pontos/custo, guarda caixa para os programas e evita voos de rotina sem valor
  (ISRO 6,7 → 5,0 de rank).

## v0.3.0 — integração final (nov/2026)
O que mudou:
- **Rivais** (calendar.js, actors.json, calendar.json): metas do Sistema Solar por agência (Hera, Ramses, MMX, Shukrayaan, DAVINCI…),
  planejador de missões próprias por pontos (prestígio + "primeiros" abertos), fundo discricionário, pressão da corrida (quem está
  atrás aperta), passo de corrida (programa antecipa até 26 semanas para não perder um "primeiro"), planos de poupança para alvos caros,
  teto de 2 missões por destino, `ai.scienceInterest` para empresas. Nenhuma missão com data além do fim do cenário (era até 136).
- **Placar** (scenario.json, helpers.js): `scenario.firstShares` (pessoas no polo sul 0,35), pouso tripulado como "primeiro do século"
  75%, landers CLPS pagam como contrato, Artemis IV escorrega 5 meses por revisão, `crewSafety` não infla o sucesso da IA.
- **Risco** (risk.js, launch.js, crew.js): a chance mostrada é a chance real da cena (`sceneOdds`, exata, com Comando e cartões); a
  cena de chegada mostra só a chegada; risco de perder a tripulação aparece no planejamento e na cena; fuga da tripulação ajustável em
  crew.json; tripulações rivais podem morrer (`crew.backgroundCrewLoss`). `mission.estimate.pCrewLoss` guardado.
- **Mundo** (politics.js, diplomacy.js, narrative.js, geopolitics.json, politics.json, events.json): países assinam Artemis/ILRS e
  escolhem lado (até 3 por campanha), agências saem de blocos por causas reais (alinhamento do governo, governo novo, verba), territórios
  mudam mais em conflito alto; 22 eventos novos (100 no total), teto por campanha, grupos com intervalo comum e variantes de texto.
- **Notícias**: templates com variantes; falhas de voos de teste viram manchete no máximo 1×/ano; marcos "chega ao Nº voo" a cada 250
  depois do 500º (Falcon 9: 8,7 → 3,0 por campanha).
- **UI**: árvore de pesquisa em retrato (visão geral 0,29 → 0,43× num 375×812), mapa encaixado acima dos chips (Vênus visível em
  320×640), janelas que chegam depois de 2030 avisadas e listadas por último (`missions/nextWindow` com `late/lateText`), Ariane 5
  aposentado próprio (`ariane5`). Versão 0.3.0 em package.json, settings.js e sw.js.
- **Ferramentas**: `sim-campaign` com resumo da corrida e bot melhor (escolhe por pontos/custo, guarda caixa para programas);
  `sim-crew.mjs` novo; `sim-world --engine --player=all`; `sim-diplomacy` conta países e mostra nomes de marcos em pt-BR.

Métricas finais:
- Testes 277/277; smoke 20/20 ok (o bot ingênuo ainda é demitido por dívida em parte das campanhas: esperado).
- Corrida (`sim-campaign 6`, 30 campanhas): vitórias cnsa 53% / nasa 47% (rodadas anteriores 50–60% cnsa); distância 1º→3º 40%
  (3/30 com top-3 dentro de 25%). Rank da IA: CNSA 1,4 · NASA 1,5 · ESA 3,8 · SpaceX 4,6 · ISRO 5,0 · JAXA 5,7 · Blue Origin 6,4 ·
  Roscosmos 7,9. Rank do bot jogador: NASA 1,8 · CNSA 1,8 · SpaceX 3,0 · ESA 3,3 · ISRO 5,0.
- "Primeiros" por campanha da IA: NASA 7,8 · CNSA 5,0 · ESA 3,2 · ISRO 3,0 · SpaceX 2,1 · Blue Origin 2,0 · JAXA 1,1 · Roscosmos 0,5.
- Chance mostrada × real (`sim-launches 1500 smart`): erro médio 0,2–0,4 p.p. (subida, chegada, tripulados), pior linha 0,7 p.p.;
  perda de tripulação mostrada 2,5% × real 2,3%.
- Mortes de tripulação (`sim-crew 8`, 40 campanhas): 10% das campanhas (jogador 5%, rivais 5%); esperado pela regra ~13%.
- Mundo (`sim-world 10 --engine --player=all`): 2,3 mudanças de bloco por campanha (agências 0,1, países 2,2); territórios 0,3
  mudanças de controle e 3,6 de status; cartas 74 por campanha, 83 distintas (rival_first 3,0× é a mais repetida).
  `sim-diplomacy 1 5 --seeds=10`: 1,8 mudanças de bloco de países por semente, 3,7 rupturas de tratado por semente.

## v0.4.0 — certificação tripulada, rivais que pagam e perdem gente (nov/2026)
O que mudou:
- **Certificação tripulada** (calendar.js `state.crewCert`, missions.js `vehicle/certify`, vehicles.json `crewCert`/`crewCertRules`):
  foguete sem certificação pode ser certificado em jogo: engenharia (meses) → voos bem-sucedidos + confiabilidade mínima → voo de
  demonstração sem tripulação (missão `source: 'cert'` na LEO). Cliente paga 1,5× e precisa do acordo da operadora. Starship também
  é certificada pelo cronograma real (sucesso do pouso de demonstração do HLS). IA operadora persegue New Glenn e Angara.
  Um único leitor: `calendar.isCrewRated` (validação, montagem, risco, catálogo). Saves antigos ganham fatia vazia.
  - **Como liberar uma nave para missão tripulada:** Missões › Montar › (alvo tripulado) → embaixo do foguete cinza, "Como liberar"
    mostra o que falta (carga, margem de combustível, certificação) e o botão "Certificar"; ou Missões › Frota.
  - Programa parado na demonstração (ou pausado) por `demoExpiryWeeks` (52) sem voar é arquivado sem reembolso e libera o
    foguete: antes um cliente podia bloquear para sempre a certificação de um rival (achado com semente 5, NASA × New Glenn).
    A demo órfã é cancelada sem custo; uma demo agendada/voando nunca é cortada.
  - Montagem: foguetes cinza ordenados por "dá para liberar" (margem menor resolve / certificação que você pode iniciar) e pela
    falta de carga; ajuda recolhida em "Por quê?" (aberta só nos liberáveis); calcula a margem que faz caber ("Com margem de
    combustível de 0% ele leva 28,1 t: cabe") com botão "Usar margem 0%"; foguete fraco demais diz "certificar não resolve" em
    vez de oferecer o programa; botão e confirmação mostram o caixa antes/depois e avisam quando o pagamento deixa a agência no
    vermelho.
- **Mortes de tripulação** (crew.js `state.rivalCrew`, crew.json `rivalCrewFlights`): rotações tripuladas de fundo dos rivais
  (Crew Dragon, Soyuz, Shenzhou 2/ano; Starliner, Gaganyaan, Mengzhou 1/ano após o voo real que as libera), com nomes fictícios,
  efeitos em apoio/reputação/prestígio, 52 semanas em solo e condolências (uma rodada por tragédia).
- **Programas da IA custam caixa** (budget.js `state.finance.programs`, actors.json `finance.programs`): conta acumulada nas 104
  semanas antes do voo, menos a parte financiada; paga só do caixa acima da reserva; crédito a parceiros de programa conjunto
  (diplomacy.js `partnerCredit`, inclusive para o jogador).
- **Manchetes**: balanço anual em 4 versões, caixa no vermelho/dívida/saída do vermelho com variantes e intervalos, rival_first com
  `{milestone}` e intervalo de 52 semanas.
- **PWA/desempenho**: manifest instalável (ícones 192/512 + maskable, iOS), cartão "Instalar" em Ajustes, pré-carga de dados e
  `modulepreload`, `data-perf="lite"` para celulares com ≤ 4 núcleos ou ≤ 3 GB.

Métricas finais:
- Testes 316/317 na última medição: todos os de simulação/UI passam (inclui `crew-cert`, `crew-cert-fixes`, `balance-rivals`, `sw-pwa`); a falha
  restante é `launch-render`, em reescrita pelo trabalho do visual do Dia de Lançamento (import de `textures.js`
  ainda incompleto no momento da medição). Smoke `node tools/smoke.mjs 4` → 20/20 ok.
- Corrida (`sim-campaign 6`, 30 campanhas): vitórias cnsa 47% / nasa 40% / spacex 13% (antes 53/47/0); distância 1º→3º 33%
  (antes 40%; 7/30 com top-3 dentro de 25%). Prestígio da IA: ESA 317, JAXA 240, Roscosmos 165 (antes 271/195/77). Rank do bot
  jogador: SpaceX 1,5 · NASA 1,7 · CNSA 1,8 · ESA 3,3 · ISRO 6,5.
- Mortes de tripulação (`sim-crew 8`, 40 campanhas): 25% das campanhas (jogador 5%, rivais 20%; esperado ~28%; alvo 15–35%);
  ~31 rotações de fundo por campanha; perda por voo: jogador 0,72%, rivais 0,55%.
- Certificação: SpaceX jogadora tem a Starship certificada pelo calendário ~turno 96–105; New Glenn (Blue Origin) certificada nas
  campanhas de teste da SpaceX; com a NASA jogadora a Starship pode não ser certificada (demo do HLS atrasa/falha).

## v0.7.0 — Fase B: o jogador e suas ferramentas (nov/2026)
- **Fundar agência** (B1): cartão "Fundar a sua agência" na escolha da Campanha → assistente de 4 passos (tipo · país e sede
  no mapa, com cidades sugeridas e bases de lançamento · nome, sigla e logo · resumo com números e dificuldade). 93 cidades
  em 37 nações (`data/core/hq-sites.json`); empresa privada só a partir de 1980; só nações vivas em 1950 (URSS sim, Rússia não).
  `agency/found` no sim (antes do primeiro passo), `agency/emblem` para trocar o logo depois (tela Identidade).
- **Emblemas** (B1, `src/ui/emblem.js`): 7 formas, 5 padrões, 11 símbolos, estrelas, órbitas, anel com texto ou fita com lema;
  44 identidades originais para as 33 linhagens reais (nenhum logo oficial copiado); procedural por id para as geradas.
- **Investidores** (B2, `src/sim/investors.js`): até 90% com investidores; ≥ 50% = autonomia; abaixo disso mandatos
  obrigatórios, poucas vagas próprias (K = 6: 100% → 6 próprias, 50% → 2, 10% → 1) e o conselho pode demitir. Missões de
  programa viram mandatos do governo (agências nacionais) ou dos fundadores (empresas). Save v2 → v3.
- **Hangar** (B3, `src/sim/designs.js`, `data/core/parts.json`): licença de foguete do catálogo ou rascunho de modelo (1, 2, 3
  estágios, núcleo e propulsores, reutilizável); motores reais com empuxo/Isp/massa; capacidade por Tsiolkovsky (foguetes do
  catálogo batem com a LEO real em ±10%); desenvolvimento pago por semana, voos de teste com lastro, depois qualquer missão.
- **Mapas** (B4): mapa-múndi com épocas datadas (OTAN, Pacto de Varsóvia, URSS sem fronteiras internas, colônias hachuradas,
  linha do tempo 1950→hoje) e sedes das agências fundadas; mapa espacial com Setor estelar (2200+, 56 estrelas até 41 a.l.) e
  Galáxia (2600+), névoa de guerra (`state.explored`) e marcadores de colônia.
- **Missões** (B5): mandato com selo do acionista, prazo e penalidade; agenda do ano na aba Programa; projetos do Hangar como
  veículos; voos de teste no programa.
- **Telas** (B6): Conselho, Identidade e logo, Finanças, Calendário de lançamentos, Anais (kit comum `screen-kit.js`).
- **Desempenho**: sinais entregues só no 1º sub-passo (antes cada módulo tratava o mesmo sinal até 52 vezes por passo) e caches
  na diplomacia: campanha completa de ~102 s para ~57 s (antes dos sistemas novos entrarem no jogo) e maior save de 392 → 282 KB.
- **Integração final** (esta versão):
  - `investors` e `parts` entraram no pacote `core` de `data/packs.json` (sem isso Conselho e Hangar ficavam inertes no jogo
    real; só os testes carregavam os arquivos). Validador aceita o marcador `{pais}` dos nomes de investidor.
  - Veto do conselho contava contratos pagos como "voos próprios" (NASA demitida em 2010 na semente 7919): agora só missões
    `custom` contam, igual à agenda de `missions.js`.
  - Mandato vencido deixava a missão em planejamento para sempre (155 rascunhos órfãos em 2200, save 430 KB): fecha com o
    mandato (`missions.closeMandateMissions`).
  - Decisão com escolha recusada (ex.: "Aceitar" com a agenda cheia) sumia da fila: agora o cartão volta. O bot de
    `tools/golden.mjs` tenta a próxima escolha; o bot da Fase B recompra de qualquer acionista que não seja o âncora.
  - `app.js` registra os emblemas no boot (`useEmblemData`) e redesenha quando chegam; `sw.js` precacheia `world-eras` e
    `core/stars`; versão 0.7.0 (package.json, `APP_VERSION`, `SW_VERSION`, `BUILD 2026.11.18-2`).
  - Testes `missions-phaseb` "fallback sem designs.js" passam a rodar sem `data.parts` (com o catálogo carregado o designs.js
    assume os voos de teste, como deve).
- **Medições (integração, 18/nov/2026)**: `npm test` → **554/554**; `node tools/validate-data.mjs` → "Dados válidos" (623
  entidades em 9 pacotes, ≈ 771 KB de partida); `node tools/smoke.mjs 2` → 10/10 ok (`--found` ok); `node tools/campaign.mjs 1
  --found --to e2` → fundada a 100%, sem erros; `full-campaign 7919 --compare-eager --to e4` → saves idênticos.
  `node tools/full-campaign.mjs` (pacotes sob demanda, bot da Fase B):

  | Era | 7919 nasa | 15838 nasa |
  |---|---|---|
  | e1 1950–1976 | 545 t · 3,4 ms/t · 92 KB | 545 t · 3,8 ms/t · 94 KB |
  | e2 1976–2000 | 312 t · 6,3 ms/t · 126 KB | 312 t · 7,5 ms/t · 127 KB |
  | e3 2000–2026 | 669 t · 4,9 ms/t · 225 KB | 669 t · 4,4 ms/t · 232 KB |
  | e4 2026–2051 | 859 t · 3,5 ms/t · 306 KB | 896 t · 3,0 ms/t · 302 KB |
  | e5 2051–2200 | 1.961 t · 6,1 ms/t · 322 KB | 2.587 t · 4,6 ms/t · 332 KB |
  | e6 2200–2600 | 4.184 t · 6,4 ms/t · 324 KB | (até 2397) 1.596 t · 7,9 ms/t · 334 KB |
  | e7 2600–3000 | (até 2941) 2.555 t · 7,8 ms/t · 321 KB | — |
  | **Total** | 11.085 t · 121 s · fim **conselho** em 2941 | 6.605 t · 61 s · fim **conselho** em 2397 |

  (KB = maior save numa virada de ano na era; teto 400 KB respeitado.) As duas terminam sem erro, mas o conselho demite o bot:
  ver Pendências 1.
- **Telas conferidas** (Chrome headless 390×844, `tools/_scratch/ref/faseB-final-*.png`): fundação (entrada, 4 passos, editor
  de logo), Painel e gaveta da agência fundada, Conselho e mandatos, missão com mandato, Programa, Hangar e editor, mundo 2026
  e 1962 (com legenda), mapa espacial no Setor (2300) e no Sistema Solar, galeria de emblemas. Sem estouro horizontal, sem
  "undefined/NaN", sem erros de console.

## v0.6.0 — Fase A: alicerce da expansão 1950–3000 (nov/2026)
- **Tempo e eras**: `data/core/eras.json` (7 eras, 9 faixas de passo). Cada toque no disco avança um passo (+1 sem … +1 ano),
  encurtado no próximo compromisso do jogador ("até o lançamento"), na troca de era ou no fim. Chip de data por faixa
  (mar/1962, T3 2087, S1 2300, 2741). Era nova para o tempo até o jogador continuar (cena de era); sem o pacote da era o jogo
  avisa "Carregando a próxima era…".
- **Simulação independente da era**: todos os módulos rodam com passo variável (`src/sim/simtime.js`, `meta.maxDt`,
  `compact`, `appointments`, `onActorBorn/onActorGone`); passo de 1 semana dá o mesmo resultado de antes.
- **Agências vivas** (`src/sim/lifecycle.js`): 33 linhagens, 45 eventos reais 1956–2025 com fonte, 37 nações (URSS até
  dez/1991 → Rússia, Ucrânia, Cazaquistão). Em 1950 só existem NACA e OKB-1; NASA 1958-10, ISRO 1969-08, ESA 1975-05, CNSA
  1993-04, Blue Origin 2000-09, SpaceX 2002-03, JAXA 2003-10. Depois de 2031 nascem agências e empresas geradas (nomes pt-BR,
  emblema com semente), que se fundem e acabam; agências reais podem acabar depois de 2041 (a do jogador nunca). Agência do
  jogador absorvida → cartão e troca para a sobrevivente; URSS dividida sob o jogador → crise com duas escolhas.
- **Dados por era**: `data/packs.json` + `src/core/packs.js` (mescla pura) + carregamento sob demanda (no máx. 3 pacotes de era
  na memória; lazy = eager). Catálogo datado (`src/core/catalog.js`), validador `node tools/validate-data.mjs` → "Dados válidos".
  Pacote e1 com foguetes, naves, calendário e retrato de jan/1950; e2–e7 só com `era.json` (conteúdo é a Fase C).
- **Cenários**: `data/scenarios/index.json` (Campanha, Corrida Lunar). Saves v1 migram para v2; saves inválidos são recusados
  com mensagem pt-BR (`src/core/migrate.js`). Espaços de save (auto, 3 manuais, um por era).
- **Escolha do veículo (item 9)**: aceitar briefing, oportunidade ou contrato cria a missão sem foguete/nave, com a "Sugestão dos
  engenheiros"; agendar sem hardware é recusado ("Escolha o foguete e a nave antes de agendar."); a montagem abre no passo 2 sem
  nada pré-selecionado; selo âmbar "falta o veículo" na lista, no Painel e na gaveta. A IA e os bots seguem com `pickConfig`.
- **Interface**: menu ☰ com gaveta `.gaveta`/`.veu` (deslizar, Esc e voltar fecham; foco preso e devolvido ao ☰), grupos
  Agência · Operações · Universo · Mundo · Arquivo · Sistema; barra inferior Painel · Missões · ◉ · Mapa · Mundo (Pesquisa e
  Equipe foram para a gaveta). Telas novas: Finanças, Calendário de lançamentos, Salvar e capítulos, Sobre, Sair para o título;
  esboços "em breve" para Conselho, Identidade, Hangar (B), Anais, Colônias, Arquivo do Eco (C). Tela de título com
  Campanha 1950–3000 · Cenários · Continuar. Ajustes mostra a era atual.
- **Testes antigos que mudaram por codificarem a hipótese antiga (cenário único / hardware automático)**: `missions`
  (hardware preenchido no aceite), `integrity`, `budget` (teto do ledger), `diplomacy-blocs`, `ui-play-disc` (rótulo do disco
  por faixa), `ui-static` e `sw-pwa` (precache dos pacotes). Durante a Fase A também mudaram testes novos: formato do
  `mission/update` em `ui-shell` e "agências reais nunca acabam" em `lifecycle`. Novos: `golden-lunar`, `time-bands`, `engine-clock`, `migrate`, `campaign-short`, `lifecycle`,
  `dt-equivalence`, `vehicle-choice`, `data-packs`, `data-schema`, `data-validate`, `sim-eras`, `ui-shell`.
- **Medições (integração, 18/nov/2026)**: `npm test` → **445/445**; `node tools/smoke.mjs 2` → 10/10 ok; `node tools/campaign.mjs 1
  --fast` → ok, fim Contato em T1 3000, **95 s** (meta ≤ 60 s não atingida). `node tools/full-campaign.mjs` (pacotes sob demanda):

  | Era | 7919 nasa | 42 roscosmos | 3 nasa |
  |---|---|---|---|
  | e1 1950–1976 | 545 t · 1,4 ms/t · 116 KB | 544 t · 1,4 ms/t · 116 KB | 545 t · 1,4 ms/t · 114 KB |
  | e2 1976–2000 | 312 t · 2,5 ms/t · 159 KB | 312 t · 2,6 ms/t · 157 KB | 312 t · 2,6 ms/t · 161 KB |
  | e3 2000–2026 | 522 t · 3,5 ms/t · 275 KB | 394 t · 4,5 ms/t · 228 KB | 489 t · 3,8 ms/t · 255 KB |
  | e4 2026–2051 | 774 t · 4,0 ms/t · 375 KB | 694 t · 4,4 ms/t · 316 KB | 755 t · 4,2 ms/t · 370 KB |
  | e5 2051–2200 | 865 t · 18 ms/t · 381 KB | 633 t · 25 ms/t · 361 KB | 830 t · 19 ms/t · 380 KB |
  | e6 2200–2600 | 880 t · 44 ms/t · 376 KB | 822 t · 49 ms/t · 379 KB | 842 t · 42 ms/t · 375 KB |
  | e7 2600–3000 | 451 t · 83 ms/t · 372 KB | 437 t · 84 ms/t · 373 KB | 430 t · 77 ms/t · 360 KB |
  | **Total** | 4.349 t · 104,8 s · final 339 KB | 3.836 t · 104,5 s · final 339 KB | 4.203 t · 96,9 s · final 327 KB |

  (t = turnos; KB = maior save numa virada de ano na era; teto 400 KB respeitado nas três.) Todas terminam em Contato.

## Roteiro (expansão 1950–3000 em 4 fases; contrato em docs/EXPANSION.md)
- **Fase A — alicerce: FEITA (v0.6.0).** Motor de tempo/eras 1950–3000, cenários, ciclo de vida dinâmico das agências, simulação
  independente da era, pipeline de dados por era, shell com gaveta ☰ e registro de telas, escolha do veículo pelo jogador (item 9).
- **Fase B — o jogador e suas ferramentas: FEITA (v0.7.0).** Fundar agência (sede, país, logo editável) e emblemas novos para
  todas; investidores e participação (`state.cap`, mandatos, rodadas, conselho; save v3); Hangar (licença ou do zero, voos de
  teste); mapa-múndi por época e mapa espacial até setor/galáxia com névoa; telas Conselho, Identidade, Hangar, Finanças,
  Calendário de lançamentos e Anais.
- **Fase C — conteúdo das 7 eras e o final de 3000 (próxima).** Vocabulário congelado; por era: atores e eventos de ciclo de vida com fonte,
  foguetes/naves com `design`, destinos, calendário, tech tier, ≥ 120 eventos, tom das notícias, investidores, tripulação,
  snapshot e um cenário curto; separar `legacy-e4` em `core/` + `eras/e4/`; geradores para e5+; o mistério do Eco e "O Grande
  Silêncio" com os 3 finais; colônias; Anais.
- **Fase D — equilíbrio, revisão e publicação.** Equilíbrio por era (20 sementes × atores jogáveis), revisão de UX de cada tela
  em 390×844 e 320 px, auditoria de tamanho/desempenho num celular intermediário, publicação.

### Roteiro anterior (corte vertical "Corrida Lunar", plano de 10 turnos do GDD)
- Turnos 1–9: feitos (fundação e dados, núcleo de simulação, calendário vivo, diplomacia, política e guerras, interface mobile,
  Dia de Lançamento, mapa e operações, eventos/equipe/legados).
- **Turno 10 (atual): backend, balanceamento e teste fechado.** Feito: balanceamento em lote (v0.3.0); certificação tripulada de
  veículos, mortes de tripulação no alvo, custos dos programas da IA, variedade de manchetes, PWA instalável e otimização para
  celular intermediário (v0.4.0). Falta: polimento visual do Dia de Lançamento (em andamento), telemetria/replays locais e, se
  aprovado, Supabase (login, saves na nuvem, ligas semanais).
- Depois do turno 10 o corte vertical "Corrida Lunar" fecha; as outras eras do GDD entram como expansões de conteúdo.

## Pendências (por prioridade, atualizado na v0.7.0)
Da Fase B:
1. **O conselho demite o bot nas campanhas longas** (7919 em 2941, 15838 em 2397): o bot vende abaixo de 50% quando o caixa
   aperta, as penalidades de mandato perdido passam ações para o governo (15838 terminou com 10%) e muitos mandatos vencem
   sem voo (o bot não agenda quando o caixa ficaria abaixo de US$ 150 mi, e alguns destinos de mandato ficam fora do alcance
   do hardware da época). Decidir na Fase D se é o bot ou o equilíbrio (penalidade em ações, frequência de mandatos de
   programa em e5+, prazo mínimo); um jogador humano tem a recompra e a autonomia.
2. **Bot sem recompra por décadas**: com caixa de US$ 14 bi desde 1965 a NASA do bot só recomprou ações em ~2003 (agora
   recompra de qualquer acionista não-âncora; conferir `mem.noBuyback` e o preço pelo valor da agência).
3. **Hangar só a partir de 1957** (`unlocks.builder`) e o Conselho aparece depois do primeiro passo (a tabela de acionistas
   nasce no tick): a gaveta de uma agência recém-fundada em jan/1950 não mostra os dois. Conferir se é o esperado.
4. **Nomes repetidos de agências geradas**: em 2300 aparecem três "Tycho …" diferentes com a mesma sigla; o gerador
   (`actor-gen.json`) deve evitar siglas iguais entre agências vivas.
5. **Velocidade**: com os sistemas novos a campanha completa voltou a ~120 s na semente 7919 (meta ≤ 60 s); o custo por turno
   está estável (3–8 ms), o tempo cresce com o número de turnos jogados.
6. Não verificado em celular real: assistente de fundação (mapa por toque), editor de logo em folha e Hangar em 320 px numa
   partida longa (os builders conferiram 320×640 nas próprias telas).

Da Fase A (itens 1, 2 e 7 resolvidos na Fase B: velocidade, saves com folga, esboços de Conselho/Identidade/Hangar e
`agency/found` substituídos):
1. **Velocidade da campanha longa**: `tools/campaign.mjs 1 --fast` leva ~95 s e `full-campaign` ~97–105 s (meta ≤ 60 s). O custo por
   turno cresce com o tempo (1,4 ms em e1 → ~80 ms em e7) mesmo com menos atores vivos em e7: algo acumula (histórico, listas do
   catálogo ou a IA de diplomacia). Medir por módulo na Fase D (ou antes, se e5+ ficarem lentos no celular).
2. **Saves perto do teto**: maior save numa virada de ano ~381 KB (teto 400 KB). Conteúdo da Fase C vai aumentar; a compactação
   precisa de folga.
3. **Datas dos eventos reais** (`data/core/lifecycle.json`, `lineages.json`) vêm de conhecimento geral; a Fase C deve conferir cada
   uma com a `source`.
4. **Hardware depois de 2080** é um tapa-buraco (`untilYear: 2999` nos últimos lançadores de cada bloco e nas naves genéricas) até
   a Fase C trazer veículos das eras 5–7. Eras e2–e7 ainda só têm `era.json`.
5. **Atores no fim da campanha**: em e6/e7 os menores somem (0 em e7 na semente 7919) e o núcleo conta 13 com o teto de 12
   (provavelmente o jogador conta à parte) — conferir no equilíbrio da Fase D.
6. Passos de 13–52 semanas: a IA considera acordos diplomáticos com menos frequência (mudança deliberada, só fora da Corrida Lunar).
7. Esboços "em breve" na gaveta (Conselho, Identidade, Hangar → B; Anais, Colônias, Eco → C); `agency/found` responde "chega numa
   próxima versão". Pele por era (`body[data-era]`) só tem e4.
8. Não verificado em celular real: gaveta com o botão voltar do Android e a cena de era numa campanha longa.
9. Destinos sem data: no Painel de jan/1950 a "Próxima janela" já mostra "Sobrevoo de Plutão" (destinations.json não tem
   `fromYear`); a Fase C deve datar destinos e janelas por era.

Herdadas da v0.4.0 (ainda abertas):
1. Visual do Dia de Lançamento com cara genérica: foguetes, naves, planetas, solo e animações (subida, separação, pouso) precisam
   de texturas e formas realistas por veículo. (Em andamento em outro trabalho.)
2. Certificação: com a NASA jogadora a Starship pode nunca ser certificada (demo do HLS rival atrasa/falha) — o caminho que sobra é
   o programa como cliente (1,5×). IA só certifica como operadora (`crewCert.ai`: New Glenn, Angara); nenhum cliente da IA inicia
   programa. O nó de pesquisa que daria o bônus `crewCert` (mais barato/rápido) ainda não existe em `tech.json`. Bots de
   `smoke`/`sim-campaign` nunca usam `vehicle/certify` (o lado do jogador só é coberto pelos testes).
3. Distância 1º→3º 33% (alvo 25%); JAXA ~1 "primeiro" por campanha, Roscosmos ~0,8.
4. Manchete "X rompe contrato e paga multa" (missions.js) ainda sem variantes.
5. Mudanças de bloco de agências raras (~0,1/campanha; países ~2,2) — deliberado.
6. Não verificado no navegador: losangos de mudança de bloco numa partida avançada; chip de risco à tripulação na tela de lançamento;
   o novo "Por quê?/Como liberar" recolhível e o aviso de caixa da certificação (cobertos só por testes de funções puras).
7. Griffin-1 sem status real de nov/2026 confirmado. Primeira visita antes do SW depende do cache do GitHub Pages (max-age=600).
8. Estimativa de semanas na pesquisa (~16) difere do prazo sorteado (18).
9. Bots de ferramenta: SpaceX bot tenta tripulados sem comandante livre (inofensivo).

## Decisões
- Plataforma: navegador (mobile-first, retrato), GitHub Pages, sem build step, JS puro em ES modules; testes com `node --test`.
- Godot do GDD substituído por web; a separação dados → regras → interface do GDD foi mantida.
- Corte vertical: cenário Corrida Lunar 2026–2030, 1 turno = 1 semana.
- Missões de programa do calendário não são editáveis na UI (só agendar/cancelar); o sim também recusa mudar destino/tipo/tripulação.
- Saves antigos: sem `firstsHistory` e com `grantM` antigo; cena aberta de save antigo assume `final: true`.
