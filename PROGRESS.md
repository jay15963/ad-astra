# PROGRESS — Ad Astra (web)

## Estado (nov/2026)
- Versão 0.3.0 (build 2026.11.17-2): rivais ativos e corrida equilibrada, chance mostrada = chance real, blocos e fronteiras vivos,
  árvore de pesquisa em retrato, mapa encaixado acima dos chips. (0.2.0: Sistema Solar, mapa espacial, grafo de pesquisa, mapa-múndi, SW.)
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

## Pendências (por prioridade)
1. Mortes de tripulação em ~10% das campanhas (alvo 15–35%): os rivais voam ~5,7 tripulados por campanha, quase todos na LEO.
   Decisão de design pendente: modelar rotações na LEO como voos de fundo que sorteiam `crew.backgroundCrewLoss`, ou aceitar ~10–13%.
2. A corrida depende de quem pousa gente na Lua primeiro (CNSA × NASA oscila entre 50/50 e 60/40). Programas do calendário não custam
   caixa à IA, mas o jogador paga os seus (NASA jogadora rank 1,8 × IA 1,5): decidir se a IA deve pagar os próprios programas.
3. Distância 1º→3º ~40% (alvo 25%): sem a ciência planetária de SpaceX/Blue Origin, as agências médias não fecharam a distância.
   JAXA ~1 "primeiro" por campanha, Roscosmos ~0,5.
4. Mudanças de bloco de agências raras (~0,1 por campanha; países ~2,2). Deliberado, por plausibilidade.
5. Manchetes repetidas: "Balanço de AAAA" (anual, 3,8×), "X rompe contrato e paga multa" (~1,5× por ator), rival_first (3×).
6. Briefing de programa pode ser aceito quando o hardware só fica pronto no último turno (ex.: `starship_mars_cargo`): a missão fica
   em planejamento para sempre. Não oferecer ou avisar.
7. UI: linha do tempo do mapa-múndi desenha `bloc_join/bloc_leave` como marca genérica; Missões/Painel ainda não usam `lateText` nem
   um chip de `estimate.pCrewLoss`. Árvore só refaz o layout ao redesenhar a aba (girar o celular). Nível Externo em 320×640 pode
   cortar Netuno. Nada disso foi verificado no navegador nesta rodada.
8. Griffin-1 sem status real de nov/2026 confirmado. Primeira visita (antes do SW) depende do cache HTTP do GitHub Pages (max-age=600).
9. A estimativa de semanas na pesquisa (~16) difere do prazo sorteado (18).
10. Bots: o bot do `sim-campaign` às vezes agenda missão própria para depois do último turno, e como SpaceX tenta tripulados sem
    comandante livre ("Escolha o comandante", 14× numa semente). Inofensivo, só ferramenta.

## Decisões
- Plataforma: navegador (mobile-first, retrato), GitHub Pages, sem build step, JS puro em ES modules; testes com `node --test`.
- Godot do GDD substituído por web; a separação dados → regras → interface do GDD foi mantida.
- Corte vertical: cenário Corrida Lunar 2026–2030, 1 turno = 1 semana.
- Missões de programa do calendário não são editáveis na UI (só agendar/cancelar); o sim também recusa mudar destino/tipo/tripulação.
- Saves antigos: sem `firstsHistory` e com `grantM` antigo; cena aberta de save antigo assume `final: true`.
