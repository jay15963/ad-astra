# PROGRESS — Ad Astra (web)

## Estado (nov/2026)
- Versão 0.2.0 (build 2026.11.17-1): Sistema Solar inteiro, mapa espacial novo, árvore de pesquisa em grafo, mapa-múndi, service worker.
- Corte vertical "Corrida Lunar 2026–2030" jogável de ponta a ponta no navegador: novo jogo, briefings, montagem de missão em 3 passos,
  agendamento, Dia de Lançamento (subida e chegada), trânsito, pesquisa, equipe, diplomacia, Tabela da Era, salvar/continuar.
- 9 módulos de simulação + UI integrados. Contratos e desvios aceitos documentados em `ARCHITECTURE.md` ("Integração").
- Testes: `npm test` (`node --test tests/*.test.mjs`) → 237/237 (inclui `solar`, `datafix`, `geopolitics`, `techtree`, `ui-review-fixes`, `sw`). Smoke: `node tools/smoke.mjs 4`
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

## Pendências (por prioridade)
1. Mudanças de bloco continuam raras (0 em 10 sementes) e rupturas IA–IA ~2,3 por semente (alvo 3–6).
2. Notícias: ~1,7 por semana e falhas de teste da Starship ainda frequentes no feed; margens de contrato não escalam com a fatia de mercado.
3. Chance mostrada fica ~6 p.p. abaixo da real em chegadas difíceis com Comando cheio.
4. Griffin-1 sem status real de nov/2026 confirmado (título agora diz "baseado no calendário real de 2026").
5. Primeira visita (antes do service worker) ainda depende do cache HTTP do GitHub Pages (max-age=600).
6. A estimativa de semanas na pesquisa (~16) difere do prazo sorteado (18).
7. NASA IA ainda supera a CNSA na Tabela mesmo sem sondas herdadas; marcos novos não estão em `ai.goals` dos atores.
8. Ariane 5 é um substituto (`ariane6` + `vehicleName`); um veículo aposentado próprio seria mais limpo.
9. Mapa: Vênus fica meio coberta pelo cartão em 320×640; animação parada em segundo plano não verificada no navegador.

## Decisões
- Plataforma: navegador (mobile-first, retrato), GitHub Pages, sem build step, JS puro em ES modules; testes com `node --test`.
- Godot do GDD substituído por web; a separação dados → regras → interface do GDD foi mantida.
- Corte vertical: cenário Corrida Lunar 2026–2030, 1 turno = 1 semana.
- Missões de programa do calendário não são editáveis na UI (só agendar/cancelar); o sim também recusa mudar destino/tipo/tripulação.
- Saves antigos: sem `firstsHistory` e com `grantM` antigo; cena aberta de save antigo assume `final: true`.
