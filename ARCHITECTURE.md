# Ad Astra — Arquitetura (contrato entre módulos)

Jogo de navegador, mobile-first (retrato), publicado no GitHub Pages. **Sem build step**: HTML + CSS + ES modules
puros, carregados direto pelo navegador. Nenhuma dependência npm em runtime. Testes rodam em Node 24 com `node --test`.

O GDD original (`GDD.md`) foi escrito para Godot; aqui a mesma arquitetura vale para a web:
**dados (data/*.json) → regras (src/core + src/sim, JS puro sem DOM) → interface (src/ui, observa o estado)**.

Escopo atual (v0.6.0, Fase A da expansão): **Campanha 1950 → jan/3000** (7 eras, passo de tempo variável por faixa, agências
que nascem/morrem com a história, final do Eco em 3000 ainda como cartão-esboço) e o cenário **Corrida Lunar (2026 a 2030)**,
Era 4, 1 turno = 1 semana (260 turnos), idêntico à v0.5 (teste golden). O contrato completo da expansão (fases A–D, números,
esquemas, donos de arquivo) está em **[docs/EXPANSION.md](docs/EXPANSION.md)**; a seção "Expansão 1950–3000 (Fase A)" abaixo
resume o que já vale no código.

## Regras invioláveis

1. `src/core` e `src/sim` **nunca** tocam DOM, `window`, `localStorage`, `Date.now()` ou `Math.random()`.
   Aleatoriedade sempre por `ctx.rng(label)` (dentro de tick/actions) ou `rngFor(state.seed, ...labels)` de `src/core/rng.js`.
   O mesmo save + mesma sequência de ações = mesmo resultado (Pilar "Justiça da sorte").
2. O estado (`state`) é **JSON puro** (sem Map/Set/classe/função/undefined significativo). `JSON.parse(JSON.stringify(state))` deve preservar tudo.
3. Dados de conteúdo ficam em `data/*.json`. Código não tem nomes de missões/veículos/eventos escritos dentro (exceto ids de teste).
4. A interface **nunca** muta o estado: chama `store.dispatch(action)` e re-renderiza. Leituras complexas via `store.query(name, ...args)`.
5. Texto ao jogador em **português do Brasil**, curto, com o tom do GDD. Dinheiro em **US$ milhões** (formatar "US$ 1,2 bi" / "US$ 350 mi").
6. Cada módulo **só escreve no seu slice** (tabela abaixo). Exceções permitidas: helpers de `src/core/helpers.js`
   (`changeActor`, `addNews`, `pushDecision`, `emitSignal`, `claimFirst`, `log`, `nextId`) e as funções exportadas listadas aqui.
7. Código defensivo: um módulo deve funcionar (sem lançar exceção) mesmo se outro módulo ainda for stub ou um campo opcional de dado faltar.
8. Sem dependências externas. Arquivos `.js` usam `import` relativo com extensão (`'./x.js'`).

## Mapa de arquivos

```
index.html                 bootstrap (carrega styles.css, src/ui/launch-scene.css, src/ui/map.css, src/ui/app.js)
sw.js                      service worker network-first (revalida tudo, cópia só para offline)  [ui-shell]
styles.css                 estilos globais + temas por era                                  [ui-shell]
manifest.webmanifest       PWA (instalar na tela inicial)                                    [ui-shell]
assets/icon.svg            ícone                                                             [ui-shell]
data/scenario.json         cenário Corrida Lunar (lunar_race; normalizado por packs.js)       [core]
data/packs.json            manifesto dos pacotes de dados (core, legacy-e4, e1..e7, cenários) [data-pipeline]
data/scenarios/            index.json (tela de título) + campaign.json (1950→3000)          [data-pipeline]
data/core/                 eras.json (eras + faixas de passo), ending.json, lineages.json, lifecycle.json,
                           nations.json, actor-gen.json, schemas/ (validador)               [core-time/lifecycle]
data/eras/eN/              pacote de cada era (era.json; e1 também snapshot/vehicles/spacecraft/calendar) [data-pipeline]
data/actors.json           atores, relações iniciais, blocos                                 [diplomacy]
data/vehicles.json         catálogo de lançadores                                            [catalog]
data/spacecraft.json       cápsulas, landers, sondas, módulos                               [catalog]
data/destinations.json     destinos, custo de energia, janelas, marcos de chegada            [catalog]
data/calendar.json         calendário vivo 2026-2030 (+projeções) com camada de veracidade   [catalog]
data/politics.json         economia, governos, eleições, eventos exógenos, templates de notícia [politics]
data/tech.json             tech tree (6 ramos)                                               [research]
data/crew.json             nomes, traços, peças de retrato, elencos iniciais                 [research-crew]
data/events.json           cartões de evento narrativos e de operação, cadeias               [narrative]
data/bodies.json           corpos do Sistema Solar (planetas, luas, cinturões, marcadores), fichas [map/solar-data]
data/geopolitics.json      países por agência, sedes, bases de lançamento, blocos, zonas disputadas [politics]
data/world.json            contornos dos países (só carregado quando o mapa-múndi abre)      [politics/worldmap]
src/core/rng.js            RNG determinístico (hash32, makeRng, rngFor)                      [core]
src/core/time.js           turno <-> data, eras, faixas de passo, rótulos do disco, chip de data [core]
src/core/migrate.js        migração de saves (v1 → v2) e recusa com mensagem pt-BR (SaveError) [core]
src/core/packs.js          mescla pura dos pacotes, normalizeScenario, carimbo fromYear/untilYear [data-pipeline]
src/core/catalog.js        vehicleDef/spacecraftDef/vehicleAvailable/listVehicles por data    [data-pipeline]
src/sim/simtime.js         helpers de passo variável (dtOf, every, chanceInStep, dueIn…)     [sim-agnostic]
src/sim/lifecycle.js       nascimento/renome/fusão/fim de agências e nações, gerador pós-2031 [lifecycle]
src/core/helpers.js        helpers compartilhados                                            [core]
src/core/data.js           carregador de dados (browser e Node)                              [core]
src/core/engine.js         registro de módulos, newGame, tick, advance, dispatch, query      [core]
src/core/outcome.js        sorteio rápido de resultado (IA/background), sem imports          [launch-core]
src/sim/risk.js            cálculo de risco/chance de missão (puro)                          [launch-core]
src/sim/launch.js          Dia de Lançamento: estado do lançamento ativo, marcos, intervenções [launch-core]
src/sim/budget.js          finanças do jogador e das IAs                                     [launch-core]
src/sim/missions.js        ciclo de vida das missões do jogador, briefings, contratos, trânsito, impacto [missions]
src/sim/calendar.js        catálogo dinâmico, calendário vivo, atrasos, lançamentos dos rivais [catalog]
src/sim/diplomacy.js       atores, relações, blocos, tratados, propostas, IA por utilidade, Tabela da Era [diplomacy]
src/sim/politics.js        economia, política interna, escala de tensão 0-4, eventos exógenos, noticiário [politics]
src/sim/research.js        pesquisa e tech tree                                              [research-crew]
src/sim/crew.js            equipe, contratação, experiência, mortes, Memorial, pontos de Comando [research-crew]
src/sim/narrative.js       eventos narrativos/operação, cadeias, Álbum                       [narrative]
src/ui/app.js              entrada da UI: boot, roteador, barra inferior, gaveta, overlays   [ui-shell]
src/ui/screens.js          registro de telas (registerScreen) — única lista de telas          [ui-shell]
src/ui/screen-views.js     telas da gaveta (Finanças, Lançamentos, Salvar, Sobre, esboços "em breve") [ui-shell]
src/ui/drawer.js           gaveta ☰ (.gaveta/.veu), foco preso, deslizar/Esc/voltar fecham    [ui-shell]
src/ui/era-scene.js        cena de troca de era e cartão final de 3000                        [ui-shell]
src/ui/css/shell.css       cabeçalho compacto, gaveta, chip de data                           [ui-shell]
src/ui/store.js            store (estado + dispatch + autosave + settings)                   [ui-shell]
src/ui/components.js       componentes DOM (cartão, chip, barra, botão, modal, toast, fmt)  [ui-shell]
src/ui/portrait.js         retrato SVG composto por peças                                    [ui-shell]
src/ui/dashboard.js        aba Painel                                                        [ui-shell]
src/ui/missions-tab.js     aba Missões + montagem em 3 passos                                [ui-shell]
src/ui/research-tab.js     aba Pesquisa                                                      [ui-shell]
src/ui/world-tab.js        aba Mundo (notícias, rivais, diplomacia, Tabela da Era)           [ui-shell]
src/ui/crew-view.js        tela de equipe, Memorial, Álbum                                   [ui-shell]
src/ui/decisions.js        modal de cartão de decisão                                        [ui-shell]
src/ui/newgame.js          tela inicial / novo jogo / continuar                              [ui-shell]
src/ui/settings.js         acessibilidade e opções                                           [ui-shell]
src/ui/launch-scene.js     cena do Dia de Lançamento (6 atos) — também a cena de chegada     [launch-scene]
src/ui/launch-scene.css                                                                      [launch-scene]
src/ui/audio.js            som adaptativo (WebAudio sintetizado, sem arquivos)               [launch-scene]
src/ui/map.js              aba Mapa: 4 níveis (Terra-Lua, Interno, Externo, Completo) + Rotas (metrô) [map]
src/ui/map.css                                                                               [map]
src/ui/worldmap.js         mapa-múndi da aba Mundo (zonas, conflitos, sedes, linha do tempo)  [worldmap]
src/ui/worldmap.css        (link injetado pelo próprio JS)                                   [worldmap]
src/ui/techtree.css        grafo da aba Pesquisa (link injetado por research-tab.js)          [techtree]
tests/*.test.mjs           testes node:test por módulo
tools/smoke.mjs            bot que joga campanhas inteiras e verifica invariantes            [core]
tools/golden.mjs           grava/compara o golden da Corrida Lunar (bot compartilhado botStep) [core-time]
tools/campaign.mjs         campanha 1950→3000 com pacotes ansiosos e invariantes por era      [core-time]
tools/full-campaign.mjs    campanha 1950→3000 com pacotes sob demanda (como no celular), métricas por era
tools/validate-data.mjs    validador de dados (tools/validate/{schema,rules}.js), sem dependências
tools/sim-*.mjs            simulações em lote por módulo
```

## Motor (src/core/engine.js) — já implementado

> Desde a v0.6.0 o tick é de **passo variável** (`ctx.dt` semanas, 1 a 52) e `MODULES` inclui `lifecycle` logo depois de
> `politics`. O texto abaixo descreve o caso de 1 semana (Corrida Lunar); as regras de passo variável estão na seção
> "Expansão 1950–3000 (Fase A)" e em docs/EXPANSION.md §1.

- `newGame(data, {seed, playerId})` → cria o esqueleto (`createState`) e chama `init(state, data, ctx)` de cada módulo na ordem de `MODULES`.
- `tick(state, data)` → uma semana: expira decisões vencidas (`expiresTurn`, usa `defaultChoice`), move `signalsPending → signals`,
  chama `tick` de cada módulo na ordem **politics → diplomacy → calendar → budget → research → crew → missions → launch → narrative**, `turn++`.
  Ao passar de `endTurn`: `gameOver = {reason:'end'}` e chama `onGameEnd(state,data,ctx)` dos módulos.
- `advance(state, data, weeks, {stopOnEvent})` — para quando `isBlocked(state)` (lançamento ativo, decisão `blocking`, fim de jogo)
  ou, com `stopOnEvent`, quando surge decisão nova ou notícia de `importance >= 3`.
- `dispatch(state, data, action)` — `'time/advance' {weeks, stopOnEvent}`, `'decision/resolve' {id, choiceId}`; o resto vai para `actions[type]` dos módulos
  (`fn(state, data, action, ctx)` → retorna `{ok?, error?, ...}`; tipo duplicado lança erro).
- `resolveDecision` → acha `decisionHandlers[kind]` (ou `decisionHandlers['prefixo/*']`) do módulo dono: `h(state, data, decision, choiceId, ctx)`.
- `query(state, data, name, ...args)` → `queries[name]` de qualquer módulo (função pura).
- `ctx = { data, rng(label), date: {year, week, month, monthName} }`. `ctx.rng(label)` depende só de (seed, turn, módulo, label).
- `serialize/deserialize` (versão `SAVE_VERSION`).

Cada módulo de `src/sim/*.js` exporta: `init`, `tick`, `actions`, `decisionHandlers`, `queries`, opcional `onGameEnd`, e as funções
cross-módulo listadas abaixo. **Imports entre módulos de sim são permitidos só na direção indicada** (para evitar ciclos):

```
outcome.js  ← (sem imports)
calendar.js ← outcome.js, helpers, rng, time
research.js ← helpers
crew.js     ← helpers, rng
politics.js ← helpers, rng, time
diplomacy.js← helpers, rng, politics.js (tensionBetween)
budget.js   ← helpers
risk.js     ← calendar.js, research.js, crew.js, politics.js, outcome.js
narrative.js← helpers, rng, budget.js, crew.js, research.js
missions.js ← risk.js, budget.js, calendar.js, crew.js, research.js, narrative.js, diplomacy.js, helpers
launch.js   ← risk.js, missions.js, crew.js, research.js, helpers, rng
```

## Estado — slices e donos

| Slice | Dono | Forma |
|---|---|---|
| `seed, turn, startYear, endTurn, playerId, gameOver, idCounter, version, scenarioId` | core | — |
| `actors` | diplomacy (init) | `{[id]: Actor}` — campos numéricos alterados por qualquer módulo **só via `changeActor`** |
| `relations` | diplomacy | `{[relKey]: {trust: -100..100, dependence: 0..100, rivalry: 0..100}}` |
| `blocs` | diplomacy | `{[blocId]: {id, name, members: [actorId], leader}}` (ex.: `artemis_accords`, `ilrs`) |
| `treaties` | diplomacy | `[{id, type, name, parties: [ids], signedTurn, status: 'active'|'broken'|'expired', terms}]` |
| `proposals` | diplomacy | propostas em aberto `[{id, from, to, type, terms, createdTurn, expiresTurn}]` |
| `geo` | politics | `{zones: {[id]: {controller, status: 'stable'|'contested'|'conflict'|'ceasefire', since, conflictId, changedTurn, history}}, conflicts: [...], events, shifts, blocChanges: [...], blocNextTurn}` (ver "Geo: mapa-múndi e blocos vivos") |
| `world` | politics | `{globalTension: 0..4, economy: {[actorId]: {growth, crisis: null|{type, untilTurn}}}, conflicts: [...]}` |
| `politics` | politics | `{[actorId]: {government, stance: -1..1 (apoio ao espaço), nextElectionTurn, priority}}` |
| `tension` | politics | `{[relKey]: 0..4}` (0 normal, 1 tensão, 2 crise, 3 conflito regional, 4 guerra aberta) |
| `calendar` | catalog | instâncias do calendário vivo `[CalendarInstance]` |
| `vehicleStats` | catalog | `{[vehicleId]: {flights, failures, lastFlightTurn}}` (inicia com o histórico real do JSON) |
| `finance` | budget | `{ledger: [{turn, amount, category, note}] (cap 300), year: {income, spent: {[category]: n}}, lastYear, debtWeeks}` |
| `research` | research | `{points, projects: [{nodeId, approach, progress, cost, startedTurn}], unlocked: [nodeId], rivals: {[actorId]: [nodeId]}}` |
| `crew` | crew | `{[crewId]: Person}` |
| `memorial` | crew | `[{crewId, name, role, turn, missionId, cause}]` |
| `missions` | missions | `[Mission]` missões do jogador |
| `contracts` | missions | `[Contract]` ofertas/leilões (criar o slice no init de missions) |
| `activeLaunch`, `commandPoints` | launch | ver Dia de Lançamento |
| `events` | narrative | `{history: {[eventId]: {count, lastTurn}}, flags: {}, chains: {[chainId]: step}, scheduled: [{eventId, turn, context}]}` |
| `album` | narrative | `[{id, turn, title, headline, kind, missionId?, crewIds?, rarity}]` |
| `firsts` | qualquer, via `claimFirst` | `{[milestoneId]: {actorId, turn}}` |
| `decisions` | qualquer, via `pushDecision` | fila do jogador |
| `news` | qualquer, via `addNews` | feed (mais recente primeiro, cap 120; 60 em campanhas > 10 anos) |
| `annals` | core, via `addNews` | 3 manchetes de cada ano (agrupadas por década/século em campanhas longas) |
| `clock` | core | era e faixa de passo atuais (`eraId`, `stepWeeks`…) |
| `lifecycle` | lifecycle | `{applied, aliases, tombstones, births, nextGenTurn, booted, lastYear, idents, watch, mergeWatch, once}` |
| `signals`/`signalsPending` | qualquer, via `emitSignal` | ver Sinais |
| `stats` | qualquer, chaves `"modulo.chave"` | contadores |
| `cap` | investors (Fase B) | tabela de acionistas do jogador `{actorId, kind, playerPct 10..100, holders[], lastRoundTurn, valuationM, lowRounds, warned, year, lastPrestige, seen, history}` ou `null` (Corrida Lunar) |
| `mandates` | investors (Fase B) | `[{id, holderId, source: investor|calendar, calendarId?, title, type, destination, count, delivered, deadlineTurn, rewardM, penalty, missionIds, credited, status, …}]` (resolvidos: teto 24) |
| `designs` | designs (Fase B) | `{[dsg_<n>]: Design}` foguetes do Hangar (ver "Fase B") |
| `explored` | explore (Fase B) | ids explorados do mapa espacial (estrelas, regiões), teto 400, só ids |

### Actor (data/actors.json → state.actors)
```
{ id, name, short, kind: 'agency'|'company', country, flag (emoji), color (#hex), bloc: blocId|null,
  budget,       // verba/receita ANUAL para programas espaciais, US$ milhões (ex.: nasa 9000, cnsa 6000, isro 1600, esa 3500,
                //   roscosmos 2200, jaxa 1500, spacex 5000, blueorigin 2500)
  cash,         // caixa atual US$ mi
  fixedCostShare, // 0..1 parte da verba consumida por custos fixos (folha, instalações) — budget usa
  support,      // 0..100 apoio do governo/investidores e opinião pública
  reputation,   // 0..100 confiança de parceiros
  culture,      // -100 (cautelosa) .. 100 (ousada)
  prestige,     // >= 0, pontos da Tabela da Era
  style,        // texto curto do GDD ("Metódica, prazos firmes")
  capabilities: { crewed: bool, launchSites: [..] },
  ai: { cooperation: 0..1, aggression: 0..1, riskTolerance: 0..1, goals: [milestoneId] } }
```
`data/actors.json` = `{ actors: [Actor sem cash (cash = budget*0.25 no init)], relations: [{a, b, trust, dependence, rivalry}], blocs: [...], treaties: [...] }`.
Atores: `nasa, spacex, blueorigin, cnsa, isro, esa, roscosmos, jaxa` (jogáveis: ver `scenario.playableActors`).
`'player'` NÃO é um id; use `state.playerId`.

### Ids de destino (data/destinations.json) — vocabulário fixo
`leo, sso, gto, iss, cislunar, lunar_orbit, lunar_surface, lunar_south_pole, mars_orbit, mars_surface, jupiter, titan`,
mais (nov/2026) `venus_flyby, venus_orbit, venus_atmosphere, mercury_flyby, mercury_orbit, neo_asteroid, neo_sample_return, apophis, didymos,
phobos, ceres, psyche, jupiter_trojans, europa_flyby, ganymede_orbit, saturn_orbit, enceladus_flyby, uranus_orbit, neptune_flyby, pluto_flyby, kuiper`.
`kind`: `orbit|surface|atmosphere|flyby|rendezvous|station`. Campos opcionais: `short`, `missionTypes`, `risk`, `prestige`, `scienceMult`, `profile`.
```
{ id, name, body: 'earth'|'moon'|'mars'|'jupiter'|'saturn', kind, capacityKey: 'leo'|'gto'|'tli'|'mars'|'outer',
  route: [{from, to, dv (km/s)}],  // para o "mapa de metrô" de rotas
  transitWeeks, window: null | { periodWeeks, phaseTurn, openWeeks }  // Marte ~113 semanas (26 meses)
  arrivalMilestones: [MilestoneDef]  // marcos da cena de chegada (vazio = sem cena de chegada)
  firsts: { crewed?: milestoneId, robotic?: milestoneId } }
```

### Ids de marcos "Os Primeiros" (firsts) — vocabulário fixo
`crewed_lunar_flyby, crewed_lunar_orbit, crewed_lunar_landing, lunar_south_pole_landing, lunar_south_pole_crewed, lunar_sample_return,
lunar_resource_demo, lunar_base, mars_landing_robotic, mars_sample_return, titan_arrival, jupiter_arrival, commercial_station, national_station,
crewed_orbit_national`, mais (nov/2026) `venus_flyby, venus_entry_probe, venus_orbit, mercury_flyby, mercury_orbit, asteroid_rendezvous,
asteroid_sample_return, apophis_rendezvous, planetary_defense_survey, phobos_landing, ceres_orbit, psyche_arrival, trojan_flyby, europa_arrival,
ganymede_orbit, saturn_orbit, enceladus_plume, uranus_orbit, neptune_flyby, pluto_flyby, kuiper_flyby`. Os já feitos no século XX/XXI
estão em `scenario.historicalFirsts` (valem 35%); `phobos_landing, psyche_arrival, trojan_flyby, apophis_rendezvous, planetary_defense_survey,
ganymede_orbit, uranus_orbit` são inéditos. Nenhum ator tem esses marcos em `ai.goals` ainda (crewed_orbit_national é por ator: `crewed_orbit_national:<actorId>` — `claimFirst` sempre dá "primeiro" porque é por ator).

### Tipos de missão e veículos
- `type`: `satellite | probe | crewed | cargo | station | lander`.
- Vehicle (data/vehicles.json `{vehicles:[...]}`):
  `{ id, name, operator: actorId, country, availableFrom: {year, month}, availableUntil?: {year, month}, truthLayer, costM, cadencePerYear,
     history: {flights, failures} (até 2025/2026, real), estimatedReliability?: 0..1 (para veículos novos), reusable, crewRated,
     capacity: { leo, gto, tli, mars, outer } (toneladas; 0 = não alcança), notes }`
  Ex.: `falcon9, falconheavy, starship, sls_b1, sls_b1b, new_glenn, vulcan, ariane6, h3, lvm3, long_march_5, long_march_10, soyuz2, angara_a5, electron`;
  `ariane5` é aposentado (`retired: true`, `availableUntil` jul/2023): só histórico (BepiColombo, JUICE), nunca aparece para compra.
- Spacecraft (data/spacecraft.json `{spacecraft:[...]}`):
  `{ id, name, operator, kind: 'capsule'|'lander'|'probe'|'cargo'|'station_module'|'rover'|'satellite', crew (0..n), massT, costM,
     availableFrom, truthLayer, estimatedReliability, destinations: [destId], notes }`
  Ex.: `orion, crew_dragon, starliner, mengzhou, lanyue, gaganyaan, starship_hls, blue_moon_mk1, blue_moon_mk2, change7, change8, cargo_dragon, generic_sat, generic_probe, ...`
- Camada de veracidade (`truthLayer`): `fato | plano_oficial | projecao | especulacao`.

### Calendar (data/calendar.json `{missions: [...]}`)
```
{ id, name, owner: actorId, partners: [actorId], type, destination, vehicleId, spacecraftId, crewed: bool,
  planned: {year, month}, truthLayer, delay: { slipChance: 0..1 /por revisão/, meanMonths, sdMonths, maxMonths },
  prerequisites: [calendarId], milestone: milestoneId|null, statusNov2026: 'texto', source: 'url', description: 'pt-BR' }
```
Instância em `state.calendar`: `{ id, plannedTurn, currentTurn, status: 'planned'|'launched'|'success'|'partial'|'failed'|'cancelled'|'player',
  delayWeeks, revisions, outcome: null|{level, failureType}, resolvedTurn }`. Itens com `owner === state.playerId` ficam `status:'player'` e são
conduzidos pelo módulo missions (briefing → missão do jogador). Os demais o módulo calendar simula (atrasos, lançamento via `quickOutcome`).
Campos opcionais (nov/2026): `inTransit: {launched: {year, month}}` (sonda já em voo; `planned` vira a data de chegada) — de rival vira item
"Em trânsito"; do jogador vira missão `status:'transit'` com `inheritedTransit: true` já no turno 0 (`missions.adoptTransitPrograms`), prestígio
multiplicado por `inheritedShare(data)` (0,35, `scenario.inheritedPrestigeShare`). `vehicleName` (nome exibido quando o foguete é aposentado,
ex.: Ariane 5 com `vehicleId: 'ariane6'` como substituto). `window` (janela própria do programa; `false` = nenhuma; `calendar.itemWindow`).
Naves `calendarOnly: true` em spacecraft.json são únicas (já em voo) e não aparecem no montador. Janela com `periodWeeks >= 260` perdida
cancela o programa rival.

### Mission (state.missions, dono: missions)
```
{ id, name, source: 'calendar'|'custom'|'contract', calendarId?, contractId?, type, destination, vehicleId, spacecraftId,
  crew: { flightDirector: crewId|null, commander: crewId|null, astronauts: [crewId] },
  config: { strategy: 'conservative'|'balanced'|'aggressive', fuelMargin: 0..0.3, payloadT },
  status: 'planning'|'scheduled'|'launch'|'transit'|'arrival'|'operations'|'done'|'cancelled',
  createdTurn, launchTurn, windowTurn?, cost, paid: bool,
  estimate: { p, low, high },        // atualizado por missions via risk.missionRisk
  attempts: 0, transit: null|{ departTurn, arriveTurn, events: [] },
  result: null|{ outcome: OutcomeLevel, failureType: FailureType|null, causes: [Cause], phase: 'ascent'|'arrival',
                 launchedTurn, resolvedTurn, prestige, science, headlines: [string] } }
```
Opcionais: `inheritedTransit` (sonda real já em voo no início), `vehicleName` (nome exibido; UI usa `missions-tab.vehicleLabel`).
OutcomeLevel: `total | partial | recoverable | catastrophic`. FailureType: `propulsion | structure | software | human | environment`.
Cause: `{ kind: 'part'|'decision'|'luck'|'environment'|'crew', label (pt-BR), detail, weight }`.

### Certificação tripulada (state.crewCert, dono: catalog — nov/2026)
`vehicles.json crewRated` é só o dia 1. Quem lê "este foguete leva gente?" usa **`calendar.isCrewRated(state, data, vehicleOrId)`**
(dado OU `state.crewCert.rated[id]`) — missions (validate, pickConfig, draftOptions), risk.missionRisk e os cards `catalog/vehicles`
(`crewRated` já vem efetivo). Slice: `{ rated: {[vehicleId]: {turn, by, source: 'program'|'calendar'}}, programs: {[vehicleId]: {vehicleId,
sponsor, customer, startedTurn, readyTurn, weeks, costM, phase: 'work'|'flights'|'demo', demoTurn, demoMissionId, demoAttempts, paused}} }`
(saves antigos: `ensureSlices` cria vazio). Dados: `vehicle.crewCert = {feasible, flights, costM, weeks, minReliability, ai?, calendarGrant?,
note}` ou `{feasible: false, reason}`; regras gerais em `vehicles.json crewCertRules` (cliente paga `customerCostMult`, precisa de confiança
≥ `minTrust` com a operadora e tensão ≤ `maxTension`; `demoDestination`/`demoPayloadT`; IA a cada `aiPeriod` semanas).
Etapas: engenharia (`weeks`, pago no início) → `flights` voos bem-sucedidos do foguete (histórico + fundo + calendário + jogador, qualquer
cliente) e confiabilidade média ≥ `minReliability` → voo de demonstração sem tripulação. Jogador: missions cria a missão
`source: 'cert'` (`certVehicleId`, carga a LEO, `clientPayload`, foguete/destino/tipo travados) e a subida dela decide
(`calendar.certDemoResult`); cancelar pausa o programa (`pauseCert`), `'vehicle/certify'` retoma de graça. IA: `certTick` sorteia o
demo (quickOutcome-like, `recordFlight`). `calendarGrant` (Starship ← `starship_hls_demo`) certifica no cronograma real quando o item do
calendário termina em sucesso, para jogador ou rival. Certificar dá prestígio/reputação ao patrocinador, notícia e sinal
`vehicle/crewRated {vehicleId, actorId, source}`; vale para todo mundo que pode comprar o foguete.
Expiração: um programa na fase `demo` (desde `demoSince`) ou pausado (desde `pausedTurn`) há `crewCertRules.demoExpiryWeeks` (52)
semanas sem voar é apagado em `certTick` (sem reembolso, notícia) — senão um cliente bloquearia o foguete para sempre (um programa
por veículo). Demo `scheduled`/em voo não expira. Saves antigos sem esses campos usam `demoTurn`/`readyTurn`. missions.certDemos
cancela sem custo a demo `planning` cujo programa sumiu ou não aponta mais para ela; `pauseCert(state, vid, missionId)` só pausa
o programa do jogador dono daquela demo.
- calendar.js exporta `isCrewRated, certRules, certStatus, canStartCert, startCertProgram, grantCrewRating, certDemoResult, linkCertDemo,
  pauseCert, successfulFlights`; queries `'catalog/crewCert' (vehicleId, actorId?)`, `'catalog/fleet' (actorId?)`.
- missions.js: action `'vehicle/certify' {vehicleId}` (paga via budget e chama `startCertProgram`; retoma se pausado). Em
  `missions/draftOptions` cada veículo traz `crewCert` (quando a missão é tripulada e ele não é certificado), `payloadT`, `capacityShortT` e
  `marginFit {margin, capacityT}|null` (maior margem de combustível de 0/10/20%, abaixo da atual, com que a carga cabe).
- UI: Missões › Montar explica sob o card cinza o porquê ("Faltam X t…" / "Certificar: N voos + demo, US$ X mi, ~Y meses" com botão,
  barra de progresso ou "Indisponível: …"); Missões › Frota lista o catálogo com status tripulado; o Painel mostra os programas do jogador.

## Funções cross-módulo (contratos)

**src/core/outcome.js** [launch-core]
- `OUTCOMES`, `FAILURE_TYPES`, `FAILURE_LABELS` (pt-BR), `OUTCOME_LABELS` (pt-BR).
- `quickOutcome(rng, p, {failureWeights?})` → `{level, failureType}` — usado por IA/background. Sucesso total com prob ~p; o restante se divide entre partial/recoverable/catastrophic.

**src/sim/risk.js** [launch-core] (puro, sem slice)
- `missionRisk(state, data, plan)` → `{ p, low, high, factors: [{label, delta}], milestones: [MilestoneRisk], warnings: [string], valid: bool, errors: [string] }`
  `plan = {actorId, type, destination, vehicleId, spacecraftId, crew, config, launchTurn}`.
  Combina: confiabilidade do veículo (`calendar.vehicleReliability`) e da nave, tech (`research.techBonus`), equipe (`crew.crewModifier`),
  cultura, estratégia, margem de combustível, prazo/pressa, tensão política. Faixa `low..high` mais estreita com equipe/pesquisa melhores
  (`research.techBonus(...,'chanceBand')`, skill do diretor de voo). `valid=false` com `errors` se a carga excede a capacidade, nave incompatível, etc.
- `MilestoneRisk = { id, label, pFail, anomalyBand, failureWeights: {propulsion, ...} }`. Marcos de subida padrão:
  `ignition, liftoff, maxq, staging, fairing_or_les, orbit` (+ `tli` se destino lunar/além); marcos de chegada vêm de `destinations.arrivalMilestones`.
- **v0.3.0 — chance mostrada = chance real.** `p` é a chance exata de sucesso (total ou parcial) jogando a cena com a escolha padrão do
  diretor de voo (`standardChoice`), já com Comando, cartões e reduções (`sceneOdds(milestones, opts)` enumera todos os caminhos, sem
  amostragem). Campos novos: `pRaw` (produto bruto dos marcos), `pAscentRaw`, `pArrivalRaw`, `pCrewLoss`, `commandPoints`; numa
  subida de missão com chegada, `p` é só a subida e `pMission` a missão inteira. Marcos tripulados trazem `pEscape`. Para voos
  tripulados `warnings[0]` é "Risco estimado de perder a tripulação: X%". launch.js usa as mesmas regras (`SCENE`, `failureSplit`,
  `failureLevel`, `msGroup`, `escapeChance`, `hintAccuracy`, `initialNerves`, `nervesMult`): nervos congelados na contagem, primeira
  carta garantida é um falso alarme inofensivo (sem olhar o futuro). `mission.estimate` guarda `{p, low, high, pCrewLoss?}`.

**src/sim/calendar.js** [catalog]
- `vehicleReliability(state, data, vehicleId)` → `{mean, low, high, flights}` (Beta a partir de `vehicleStats` + prior estimado).
- `spacecraftReliability(state, data, spacecraftId)` → `{mean, low, high}`.
- `availableVehicles(state, data, actorId)` → `[vehicle]` disponíveis na data atual para esse ator (operador próprio, parceiros, mercado comercial;
  tensão >= 3 com o operador bloqueia acesso — usa `politics.tensionBetween`).
- `availableSpacecraft(state, data, actorId)`.
- `capacityTo(data, vehicleId, destinationId)` → toneladas.
- `nextWindow(state, data, destinationId, fromTurn)` → `{openTurn, closeTurn}` (destino sem janela: `{openTurn: fromTurn, closeTurn: Infinity}`).
- `recordFlight(state, vehicleId, success)`.
- queries: `'catalog/vehicles' (actorId)`, `'catalog/spacecraft' (actorId)`, `'catalog/destinations'`, `'calendar/upcoming' (n)`, `'calendar/all'`, `'catalog/window' (destId)`.

**src/sim/budget.js** [launch-core]
- `canAfford(state, actorId, amount)`, `spend(state, actorId, amount, category, note)` → bool (jogador: lança no ledger; IA: só cash),
  `earn(state, actorId, amount, category, note)`.
- Categorias: `missions, research, crew, facilities, contracts, diplomacy, grants`.
- tick: receita semanal `budget/52` para todos os atores; custos fixos `budget*fixedCostShare/52`; virada de ano fecha `finance.year → lastYear`.
  Dívida prolongada (caixa < 0) corta `support`; `support` 0 → `gameOver = {reason: 'fired'}`.
- queries: `'budget/summary'` → `{cash, budget, weeklyIncome, weeklyCost, yearSpent, lastYear, runwayWeeks}`.

**src/sim/research.js** [research-crew]
- `techBonus(state, actorId, key)` → número somado dos efeitos dos nós desbloqueados (jogador: `state.research.unlocked`; rivais: `state.research.rivals[actorId]`).
  Chaves fixas: `reliability` (+prob), `launchCost` (fração, negativa = mais barato), `payload` (fração), `chanceBand` (fração de estreitamento),
  `commandPoints` (inteiro), `sciencePerMission` (fração), `landingReliability` (+prob), `crewSafety` (+prob de sobreviver a falha), `delayReduction` (fração).
- `addSciencePoints(state, n, source)`.
- actions: `'research/start' {nodeId, approach: 'safe'|'bold'}`, `'research/cancel' {nodeId}`.
- queries: `'research/tree'` → nós com estado (locked/available/active/done, custo, tempo estimado), `'research/points'`.
- data/tech.json: `{ branches: [{id, name}], nodes: [{id, branch, name, description, era: 4, cost, weeks, requires: [nodeId], effects: {key: value}, secret?: bool, unlockedBy?: eventFlag}] }`.
  Ramos: `propulsion, structures, life_support, computing, energy, science`.

**src/sim/crew.js** [research-crew]
- `Person = { id, name, role: 'engineer'|'flight_director'|'astronaut', actorId, skill: 0..100, experience, traits: [traitId], loyalty: 0..100,
   ambition: 0..100, morale: 0..100, status: 'active'|'injured'|'retired'|'dead'|'left', bio, history: [{turn, text}], legend: bool,
   salaryM (por semana), hiredTurn, portrait: { skin: 0..5, hair: 0..9, hairColor: 0..5, eyes: 0..4, brows: 0..3, mouth: 0..4, accessory: 0..5, suit: 0..3, bg: 0..5 } }`
- `crewModifier(state, data, crewSel)` → `{delta, band, factors: [{label, delta}]}` (crewSel = mission.crew).
- `commandPointsFor(state, data, crewSel)` → inteiro 1..5 (diretor de voo + experiência + `techBonus('commandPoints')`).
- `applyMissionToCrew(state, data, mission, outcome)` → experiência, moral, lendas; em falha catastrófica tripulada pode matar (respeita `crewSafety`),
  adiciona ao `memorial`, emite sinal `crew/died`.
- v0.3.0: `survivalBonus(state, data, crewIds)` (traços resistente/pé-quente/saúde frágil), `escapeConfig(data)` (`crew.json config.escape`:
  antes da órbita 0,55, depois 0,25, chegada 0,12; margem, estratégia e `crewSafety` mexem) e `backgroundCrewLoss(data, {phase, landing,
  safety})` (`config.backgroundCrewLoss`: chance de perder a tripulação numa falha resolvida sem cena — usada por calendar.js).
- `availableCrew(state, role)`.
- actions: `'crew/hire' {candidateId}`, `'crew/fire' {crewId}`, `'crew/train' {crewId}`; queries: `'crew/roster'`, `'crew/candidates'`, `'crew/memorial'`, `'crew/person' (id)`.
- data/crew.json: `{ firstNames: {[culture]: [..]}, lastNames: {[culture]: [..]}, actorCulture: {[actorId]: culture}, traits: [{id, name, description, effects}], roster: {[actorId]: [Person parcial]} (pessoas iniciais), portraitParts: {...} }`.

**src/sim/missions.js** [missions]
- `onLaunchResolved(state, data, missionId, phase, outcome)` — chamado pelo launch ao fim de cada cena. Aplica: status (transit/operations/done),
  `recordFlight`, `applyMissionToCrew`, prestígio/`claimFirst`, reputação/apoio, ciência (`addSciencePoints`), notícias, sinal `mission/resolved`.
- `estimateFor(state, data, missionId)` → recalcula `mission.estimate` via `risk.missionRisk`.
- tick: briefings de itens do calendário do jogador (decisão `briefing`), ofertas de contrato (decisão `contract/offer`, leilão contra rivais),
  missões `scheduled` cujo `launchTurn` chegou → decisão **blocking** `launch/ready` (payload `{missionId, phase:'ascent'}`),
  missões em trânsito: eventos de operação via `narrative.pickOperationEvent`, chegada → `launch/ready` com `phase:'arrival'` se o destino tem `arrivalMilestones`,
  senão resolve direto.
- actions: `'mission/create' {draft}` → `{ok, missionId}`, `'mission/update' {missionId, patch}`, `'mission/schedule' {missionId, launchTurn}`
  (cobra o custo via `budget.spend`), `'mission/cancel' {missionId}`, `'mission/estimate' {draft}` → `{estimate}` (não muta).
- queries: `'missions/list'`, `'missions/get' (id)`, `'missions/draftOptions' (draft)` → veículos/naves/destinos válidos, custo, janela e chance (passo 3 do resumo),
  `'missions/nextWindow' (destId?, fromTurn?)`, `'missions/contracts'`. `nextWindow` traz `{destination, name, openTurn, closeTurn, weeks,
  open, launchTurn, arrivalTurn, late, lateText}`; sem destino devolve a janela mais cedo que ainda chega antes do fim (ou a mais cedo,
  marcada `late`). `lateText` é o aviso pt-BR ("Não dá para chegar antes do fim de 2030: …").

**src/sim/launch.js** [launch-core] — ver "Dia de Lançamento".
- decisionHandlers: `'launch/ready'` — choices `go` (abre a sala de controle: cria `state.activeLaunch`) e `scrub` (adia 1-2 semanas, custa apoio).

**src/sim/politics.js** [politics]
- `tensionBetween(state, a, b)` → 0..4. `setTension(state, a, b, level, reason)` (emite `tension/changed` + notícia).
- tick: economia por ator, crises, eleições (`politics[actorId].nextElectionTurn`), mudança de `stance`, ajuste ANUAL de `actor.budget` (virada do ano),
  eventos exógenos de `data/politics.json`, conflitos nascidos do estado (rivalidade alta + tensão + instabilidade), efeitos por nível de tensão
  (nível 2: corta verba de parcerias; 3: bloqueia lançadores/rotas; 4: suspende programas → cancela itens do calendário). Notícias legíveis.
  Para o jogador: decisões `politics/*` quando o governo pede algo (ex.: cortar orçamento ou entregar marco antes da eleição).
- queries: `'politics/tension'` (todas as duplas), `'politics/world'`, `'politics/actor' (id)`.

**src/sim/diplomacy.js** [diplomacy]
- init: copia atores/relações/blocos/tratados de `data/actors.json` para o estado.
- tick: IA por utilidade de cada ator (propor parceria, dividir custos, trocar tripulantes, transferência de tecnologia, aderir a bloco, assinar/romper tratado),
  evolução de `trust/dependence/rivalry` (lê `tension` e sinais `mission/resolved`, `crew/died`, `first`), propostas da IA ao jogador
  (decisão `diplomacy/proposal`). Tudo vira notícia. Sem script: alianças nascem, esfriam e rompem.
- actions: `'diplomacy/propose' {to, type, terms}` → resposta da IA no mesmo turno ou no próximo, `'diplomacy/joinBloc' {blocId}`, `'diplomacy/leaveBloc'`,
  `'diplomacy/breakTreaty' {treatyId}`.
- `relation(state, a, b)`, `isPartner(state, a, b)` (tratado/parceria ativa), `blocOf(state, actorId)`.
- queries: `'diplomacy/relations' (actorId)`, `'diplomacy/treaties'`, `'diplomacy/blocs'`, `'diplomacy/proposalTypes'`, `'league/table'` (Tabela da Era: atores por prestígio + "primeiros").
- Tipos de proposta/tratado: `mission_partnership, cost_sharing, crew_exchange, tech_transfer, peaceful_use, lunar_resources, orbital_traffic, join_bloc`.

**src/sim/narrative.js** [narrative]
- tick: lê `state.signals` e o estado; sorteia eventos narrativos elegíveis (gatilhos, peso, histórico com decaimento, sem repetição), cadeias agendadas.
  Cada evento vira decisão `event/<eventId>` (handler `'event/*'`). Álbum: adiciona cartas para momentos marcantes (sinais `mission/resolved` com sucesso
  notável, `first`, `crew/died`).
- `pickOperationEvent(state, data, mission, rng)` → `null | {eventId}` e já empurra a decisão — usado por missions durante o trânsito.
- `applyEffects(state, data, effects, context)` — interpreta a DSL de efeitos.
- data/events.json: `{ events: [Event] }`,
  `Event = { id, kind: 'narrative'|'operation', title, text (3-5 linhas pt-BR, pode usar {actor}, {person}, {mission}, {rival}), portrait: 'crew'|'actor'|null,
    trigger: {minTurn?, maxTurn?, actors?: [id], requiresFlags?, forbidsFlags?, signal?: type, condition?: Condition}, weight, cooldownWeeks, once?,
    choices: [{ id, label, preview, requires?: Condition, effects: [Effect] }], chain?: {id, step} }`.
  `Effect`: `{actor: 'player'|'rival'|id, field, delta}` | `{relation: actorId|'rival', field, delta}` | `{flag, value}` | `{schedule: eventId, inWeeks}` |
  `{science: n}` | `{cash: n}` | `{crew: 'random'|'subject', field, delta}` | `{crewStatus: 'left'|'injured'}` | `{missionRisk: delta}` (missão de contexto) |
  `{news: headline, importance}` | `{album: title}` | `{tension: actorId, delta}` | `{unlockTech: nodeId}`.
  `Condition`: `{culture: '>20'}`, `{tech: nodeId}`, `{flag: key}`, `{hasRole: 'engineer'}`, `{cash: '>500'}`, `{support: '<40'}`, `{all: [...]}`, `{any: [...]}`.
- queries: `'narrative/album'`, `'narrative/flags'`.
- v0.3.0 (variedade): chaves opcionais de Event `maxCount` (teto por campanha; padrão `DEFAULT_MAX_COUNT` = 2 aleatórios / 3 por sinal,
  `once` = 1), `group` (eventos do mesmo grupo dividem o intervalo `events.json groups[grupo]`, padrão 16 semanas) e `variants:
  [{title?, text?}]` (2ª, 3ª… aparição lê diferente). Marcadores novos `{country}`, `{bloc}`, `{zone}` (vêm dos sinais `geo/*`).
  `validateEvents` checa as três chaves.

## Sinais (cross-módulo)
`emitSignal(state, type, payload)`; ficam visíveis em `state.signals` durante o **próximo** tick, para todos os módulos.
`emitSignal` monta `{...payload, type, turn}` (o tipo do sinal sempre vence). Payload **não** usa a chave `type`.
Tipos: `mission/launched {missionId, actorId}`, `mission/resolved {missionId?, calendarId?, actorId, destination, missionType, crewed, outcome, failureType, phase}`,
`crew/died {crewId, missionId}`, `crew/legend {crewId}`, `first {milestoneId, actorId}`, `treaty/signed {treatyId}`, `treaty/broken {treatyId, by}`,
`tension/changed {a, b, from, to}`, `election {actorId, result}`, `budget/changed {actorId, from, to}`, `research/completed {nodeId, actorId}`,
`calendar/delayed {calendarId, weeks}`, `contract/awarded {contractId, winner}`,
`diplomacy/blocChanged {actorId, blocId, joined}`, `geo/blocSignup {iso, countryName, bloc, blocId, joined, from, to, actorId, withPlayer}`,
`geo/zoneChanged {zoneId, zoneName, from, to, conflictId, actorId, nations}` (ver "Geo").

## Dia de Lançamento (src/sim/launch.js + src/ui/launch-scene.js)

`state.activeLaunch` (null quando não há cena):
```
{ missionId, phase: 'ascent'|'arrival', act: 'prelaunch'|'countdown'|'ascent'|'climax'|'result',
  seed: number|null,                  // travado em 'launch/countdown' (contagem final): hash(state.seed,'launch',missionId,phase,attempt)
  lineup: { flightDirector, commander, strategy, fuelMargin },
  estimate: { p, low, high, factors },  // recalculado a cada 'launch/configure' (só em prelaunch)
  weather: { label, risk },           // sorteado com rngFor(state.seed,'weather',missionId,turn)
  pendingHold: null | { reason, options: [{id:'hold'|'scrub'|'go', label, preview}] },  // durante a contagem
  milestones: [{ id, label, t (segundos de animação), pFail, status: 'pending'|'ok'|'anomaly'|'fail', radio: [string] }],
  current: index do próximo marco,
  pendingIntervention: null | { id, milestoneId, prompt, options: [{id, label, cost (pontos de Comando), preview, disabled?}], seconds: 5, defaultOption: 'maintain' },
  interventions: [{milestoneId, optionId}], commandPoints (no início = crew.commandPointsFor),
  nerves: 0..100, confidence: 0..100,
  log: [{t, kind: 'radio'|'telemetry'|'event', text}],
  outcome: null | { level, failureType, causes: [Cause], headline, crewLost: [crewId] } }
```
Ações (todas determinísticas; o resultado de cada marco = `rngFor(seed,'ms',index)` comparado com `pFail` ajustado pelas escolhas):
- `'launch/configure' {flightDirector?, commander?, strategy?, fuelMargin?}` — só em `prelaunch`.
- `'launch/countdown'` — trava a semente; pode gerar `pendingHold` (clima/sensor) com opções segurar (−nervosismo, risco menor, custa tempo),
  adiar (encerra a cena sem resultado, `mission.launchTurn += 1..2`, `activeLaunch = null`) ou lançar assim mesmo.
- `'launch/hold' {choice}`.
- `'launch/step'` — resolve o próximo marco: retorna `{milestone, status, intervention?}`. No máximo 1 a 3 intervenções por cena, surgem em marcos cujo
  sorteio cai na faixa de anomalia. Após o último marco `act → 'climax' → 'result'` com `outcome` preenchido (relatório de causas: peça, decisão, sorte).
- `'launch/choose' {optionId}` — opções típicas: `reduce` (reduzir empuxo: menos risco agora, menos margem depois), `maintain`, `abort` (salva a tripulação,
  missão perdida = `recoverable`). `'timeout'` = `defaultOption`.
- `'launch/finish'` — chama `missions.onLaunchResolved(...)`, `activeLaunch = null`.
- Fechar o app no meio: o estado salvo tem `activeLaunch`; ao reabrir, a cena continua do mesmo ponto com o mesmo resultado.

A cena (UI) **só apresenta** o que o sim calculou: anima foguete em vista lateral (canvas), telemetria, rádio, barra de nervosismo/confiança,
multidão, rostos da equipe, cartões de intervenção com timer de 5 s, slow motion + silêncio no clímax, resultado com relatório de causas,
manchetes e replay da linha do tempo. Som (WebAudio) e vibração (`navigator.vibrate`) respeitam as opções.

## UI (src/ui)

**store.js** (ui-shell) exporta `createStore()` → `store`:
```
store.state, store.data
store.dispatch(action) → result     // chama engine.dispatch, depois notifica assinantes e autosalva (localStorage 'adastra.save.v1')
store.query(name, ...args)
store.subscribe(fn) → unsubscribe   // fn(state, lastAction, lastResult)
store.settings  { sound, vibrate, reduceMotion, textScale: 1|1.15|1.3, colorblind, }  // localStorage 'adastra.settings'
store.setSettings(patch)
store.newGame({playerId, seed}), store.hasSave(), store.load(), store.deleteSave()
store.vibrate(pattern)              // respeita settings
```
**components.js** exporta helpers `h(tag, props, ...children)`, `fmtMoney(m)`, `fmtPct(p)`, `card`, `chip`, `bar`, `button`, `openModal(content)→close`,
`toast(text)`, `sparkline(values)`, `fmtDate(turn, startYear)`.
**portrait.js** exporta `portraitSVG(portrait, {size, mood})` → string SVG.
Cada tela exporta `render(container, store, route)` (pode retornar função de limpeza) e é registrada em `src/ui/screens.js` (v0.6.0: Pesquisa e
Equipe saíram da barra para a gaveta ☰). `app.js` monta a barra inferior e a gaveta a partir do registro, re-renderiza a aba ativa a cada mudança,
abre `decisions.js` para cartões e chama `openLaunchScene(store)` de `launch-scene.js` sempre que `state.activeLaunch` existir.
**launch-scene.js** exporta `openLaunchScene(store) → close()` (overlay de tela cheia dentro de `#overlay-root`).
**map.js** exporta `render(container, store)`. Monta sozinho 4 níveis (Terra-Lua, Interno, Externo, Completo); de `bodies.json levels` usa só
o `id` para ajustar o enquadramento. "Planejar missão aqui" chama `store.ui.planMission(destId)` (app.js: grava `store.ui.pendingDestination`
e abre `#missoes/nova`; o montador lê e limpa).
**worldmap.js** (aba Mundo, seção recolhível) usa `'geo/state' (turn?)` e `'geo/history'`; `opts.focus` foca um conflito.
**research-tab.js** desenha o grafo estilo KSP; `research/tree` traz também `icon, short, tier, row` de tech.json (opcionais; `tier`/`row`
forçam coluna/linha do layout). v0.3.0: layout em retrato (`pickLayout(nodes, branches, vw, vh)` testa 1–6 ramos por linha e fica com
o que mostra a árvore maior; `layoutGrid`; níveis de cima para baixo, ramos como grupos de colunas); `layoutTree` (antigo, da esquerda
para a direita) segue exportado e igual. **map.js**: `fitLevel()` encaixa cada nível no espaço acima dos chips de janela; janelas que
chegam depois do fim aparecem por último com o aviso `lateText`.
**settings.js** exporta `APP_VERSION` (= package.json = `SW_VERSION` de sw.js), `BUILD_DATE`, `BUILD`; Ajustes mostra versão, build e o
estado do service worker.
**sw.js** (raiz, registrado por app.js com `updateViaCache: 'none'`): GET da mesma origem → rede primeiro com `cache: 'no-cache'`
(revalida), resposta marcada `Cache-Control: no-cache` (o memory cache da página não reaproveita módulo velho), cópia em
`adastra-<versão>` só para quando não há rede. Ao publicar: subir `APP_VERSION`, `SW_VERSION`, package.json e `BUILD`.

Tema por era: `document.body.dataset.era = '4'`; CSS variables por era em styles.css. Fonte do sistema. Retrato, polegar, alvos >= 44px,
`env(safe-area-inset-*)`. Acessibilidade: texto escalável (`--text-scale`), modo daltonismo (sem depender só de vermelho/verde), reduzir movimento, nada só por som.

### Renderizador do Dia de Lançamento (src/ui/launch-render, nov/2026)
Canvas 2D procedural (sem imagens externas) que `launch-scene.js` carrega com `import('./launch-render/index.js')` dinâmico: se o
módulo falhar, a cena segue sem a arte (o resultado nunca depende dele). **Contrato completo: [src/ui/launch-render/README.md](src/ui/launch-render/README.md)**
(API, dados de arte, harness). Módulos:
- `index.js` — `createLaunchRenderer({seed})` → `{ reset, event, update, draw, drawPadWindow, vehicleScreenPos, stats }`; recebe
  da cena um "render state" (modo pad/ascent/descent/orbit, telemetria, marcos, flags) e desenha; prewarm em `requestIdleCallback`
  (plumas, nuvens, mapas da Terra/destino, faixas do limbo) durante contagem e cruzeiro.
- `textures.js` — PRNG/ruído com semente (hash dos ids; nunca `Math.random`), cache LRU de canvases offscreen (48 MB, geração
  preguiçosa com orçamento por quadro), céu, estrelas, limbo da Terra, discos planetários, nuvens, base de lançamento, terreno de pouso.
- `vehicles.js` + **data/vehicle-art.json** — pintor de foguetes/naves a partir de dimensões reais (todo id de vehicles.json e
  spacecraft.json tem arte; ids desconhecidos caem num template por família). Arte nunca vai para vehicles.json.
- `fx.js` — plumas por propelente e pressão ambiente (diamantes de Mach, expansão no vácuo), colar de condensação, paraquedas,
  plasma de reentrada, partículas em pool. `camera.js` — enquadramentos de subida/descida/órbita/plataforma.
Regras: só apresentação (nunca lê/escreve o sim além do `activeLaunch` recebido), DPR ≤ 2, respeita `reduce` (reduzir movimento).
Harness: `tools/launch-preview.html?scene=…&vehicle=…&body=…&t=…` (ver README §6). Testes: `tests/launch-render.test.mjs`.
sw.js não precisa de lista: o crawl do precache segue o `import()` dinâmico e o `new URL('…/vehicle-art.json', import.meta.url)`.

### Design (nov/2026)
O visual segue o sistema derivado do CSmanager — especificação completa em **[docs/DESIGN.md](docs/DESIGN.md)** (tokens, ícones, shell,
componentes, telas). Resumo: "cinza é a interface; cor é significado" — superfícies quase pretas `--s0..--s4`, bordas de 1px
(`--line`/`--line-strong`), texto `--text/--text-2/--text-3`, cor só semântica (`--green`, `--red`, `--amber` = sua agência/ação principal,
`--info`); cards planos com raio 6px; fonte do sistema (Inter se instalada, senão system-ui) + mono em rótulos pequenos em caixa alta
com espaçamento. A barra de abas (`.tabbar`) espelha `.barra-inferior`: barra plana `--s1`, ícone + rótulo, item atual com traço de
3×22px no topo. Os tokens ficam em `styles.css` (`body, body[data-era="4"]` — hoje uma paleta única para todas as eras). Mapa, mapa-múndi
e cena de lançamento mantêm a própria imagem; só o cromo (cabeçalhos, folhas, chips) segue o sistema.

## Testes e ferramentas
- `npm test` → `node --test tests/*.test.mjs` (no Windows `node --test tests/` falha; use o glob) (cada módulo tem `tests/<modulo>.test.mjs`; use `loadDataNode(root)` de `src/core/data.js`).
- `node tools/smoke.mjs [seeds] [actor]` — bot joga campanhas completas com todos os atores jogáveis, faz save/load no meio, falha em exceção ou `log` com "erro".
- `tools/sim-launches.mjs` (10 mil lançamentos por veículo), `tools/sim-calendar.mjs` (20 sementes × 5 anos), `tools/sim-diplomacy.mjs` (log de alianças),
  `tools/sim-world.mjs` (20 sementes, mundos divergentes).
- Rodar localmente: `npx http-server -c-1 .` (ou qualquer servidor estático) e abrir `http://localhost:8080`.

## Integração — desvios aceitos (nov/2026)

Decisões tomadas ao juntar os módulos. Onde este bloco contradiz o texto acima, vale este bloco.

- **Sinais**: `mission/resolved` traz o tipo da missão em `missionType` (calendar e missions emitem assim; diplomacy, politics,
  narrative e missions leem assim). Sinais extras: `crew/left`, `crew/injured`, `diplomacy/techTransfer`, `diplomacy/crewExchange`,
  `diplomacy/blocChanged`, `politics/suspension`, `politics/program_review`.
- **Tempo**: `dateToTurn(year, month0..11)` usa `ceil` (casa com `turnToDate`). `vehicles/spacecraft/destinations/calendar.json`
  têm `monthBase: 1` (meses 1–12); `politics.json` (eleições) usa meses 0–11.
- **Artemis / arquitetura de pouso**: uma nave com `landerRequired: [destId]` (Orion) só pousa com um **módulo de apoio**
  `secondarySpacecraftId` (lander tripulado pré-posicionado: Starship HLS, Blue Moon Mk2; para o Lanyue a Mengzhou). missions escolhe o
  melhor (`companionOf`), cobra nave + lançamento dele, e risk soma a confiabilidade do módulo. Itens do calendário podem declarar
  `secondarySpacecraftId`. Programas apertados (Orion no SLS, Lanyue no LM-10) recebem margem de combustível fina automaticamente.
- **Capacidade**: a única fonte é `calendar.capacityTo` = `capacity[capacityKey] × destination.capacityFactor`; missions e risk usam ela.
- **Acesso a hardware** (`calendar.accessFor`): `embargo`, tensão ≥ 3, `access: own|bloc|open|generic`. `bloc` libera para o mesmo bloco
  ou para quem tem tratado de trabalho ativo (`mission_partnership, cost_sharing, crew_exchange, tech_transfer`; o Tratado do Espaço
  Exterior não conta). Ator com `launchPolicy: 'domestic'` (NASA, CNSA, Roscosmos) só usa lançadores do próprio país.
- **Estreia de veículo**: veículo com `debutCalendarId` fica disponível quando a estreia teve sucesso, também se foi o jogador que voou.
- **Primeiros**: `destination.firsts.crewed|robotic` pode ser string ou lista (polo sul lunar também conta como pouso na Lua).
  Meta da era `crewed_orbit_national` (por ator).
- **Economia**: `changeActor` aplica retorno decrescente a ganhos de `support`/`reputation` acima de 60. Reajuste anual de agências
  amortecido (`budgetModel.raiseDamping`, `max`), empresas com `companyMax`. Na virada do ano budget.js devolve metade do caixa acima
  de 60% da verba (tesouro/investidores). Hardware genérico custa mais para destinos distantes (`GENERIC_COST_SCALE`).
- **UI**: `createStore(data, {storage})`; `store.ui`, `tryQuery`, `trend`, `series`; rota por hash. `'diplomacy/propose'` usa
  `proposalType` (porque `type` é a rota). `news.icon` pode ser emoji ou nome curto (`'failure'`, `'budget'`…): a UI traduz com
  `components.newsIcon`; tags de notícia são internas e só as traduzidas em `world-tab.TAG_LABELS` aparecem.
- **Imports extras** (sem ciclo): research/crew → budget; crew → research; narrative → politics, diplomacy; missions → core/outcome.
  calendar lê a tensão direto de `state.tension` (sem importar politics).
- **Ferramentas**: `tools/sim-campaign.mjs [seeds] [ator] [--verbose|--quiet]` (bot "esperto", exporta `runCampaign`);
  `tools/smoke.mjs` agenda missões e voa as cenas. `tools/sim-calendar.mjs` conta notícias ao nascer (o feed guarda só 200).

## Integridade e equilíbrio (revisão nov/2026)

- **Fim de jogo**: `engine.dispatch` recusa toda ação (exceto `time/advance` e `mission/estimate`) quando `state.gameOver` existe
  ("Campanha encerrada."). Se um módulo encerra a campanha no meio da semana (budget demite a direção), os módulos seguintes não rodam;
  `engine.endGame` limpa a fila de decisões e chama os `onGameEnd` **uma vez** para qualquer motivo (`gameOver.hooksRun`).
  Lançamento não pode ser marcado para a última semana (`launchTurn < endTurn`).
- **Missões** (campos novos em Mission): `paidM` (quanto foi pago de fato; ajustes cobram/devolvem a diferença sempre que `paid`,
  inclusive de volta ao planejamento; cancelar devolve 40% de `paidM`), `grantShare` (verba externa como **fração** do custo, não valor
  fixo; `grantM` só em saves antigos), `readyTurn` (programa do calendário: hardware pronto na data oficial −4 semanas + atraso sorteado
  com o `delay` do item), `scrubs` (contagens de adiamento, escritas por launch). Missões de programa travam `type/destination/crewed`;
  o marco do programa só vale se `missions.matchesCalendar`. `'mission/create'` (público) apaga campos privilegiados
  (`publicDraft`): grant, milestone, calendarId, contractId, prazos, readyTurn, clientPayload. Agendar checa se veículo e naves ainda
  estão em serviço na data (`calendar.inServiceAt`).
- **Risco** (`risk.missionRisk`): `plan.calendarId` aplica pré-requisitos do calendário que não voaram (−12 p.p. cada, com aviso);
  nave tripulada com pouco histórico: hazard × (1 + 0,6/(1+voos)). Estratégia tem multiplicador de prestígio aplicado de verdade
  (conservadora 0,8, agressiva 1,25); conservadora soma 6 semanas de preparo; margem acima de 10% custa 1% do lançamento por ponto.
- **Prestígio numa escala só**: `core/outcome.js` `destPrestige`/`missionPrestige` servem ao jogador (missions) e à IA (calendar).
  `calendar.rivalProgramPrestige` padrão 1,0.
- **Os Primeiros e a história**: `state.firstsHistory` [core] vem de `scenario.historicalFirsts` (Apollo 8/11, Luna 9, Mars 3, Galileo,
  Huygens, Salyut 1, Chandrayaan-3). `claimFirst` marca `era: true` e paga 35% (`HISTORIC_FIRST_SHARE`) por esses; feitos inéditos
  (tripulação no polo sul, estação comercial, amostras de Marte, base lunar...) pagam inteiro. `helpers.isHistoricFirst`, `firstValue`.
  Notícia: `calendar.news.firstEra` ("Primeira vez neste século").
  Ajustes por marco (dados): `scenario.historicalFirsts[id].share` troca os 35% de um feito histórico (pouso tripulado: 0,75, a manchete
  da corrida); `scenario.firstShares[id]` paga só parte dos pontos de "primeiro" do destino (pessoas no polo sul: 0,35, um marco dentro
  do pouso tripulado), via `helpers.milestoneShare(data, id)` em todo `claimFirst` (calendar e missions). Itens do calendário com
  `contract: true` (landers CLPS) pagam prestígio como contrato (metade da novidade) para a IA e para o jogador.
- **Rivais reagem** (calendar, slice `state.rivalOps = {pending, flights, react, raced, fund, score, tries, saving}`): todo mês cada IA
  com caixa pode encomendar uma missão própria (sonda/lander genéricos), paga do caixa, voa após 6–9 meses de construção e pontua na
  mesma escala. Alvos (`opsOptions`): prestígio da missão + "primeiros" abertos (menos se um rival chega antes, mais se é meta ou dá
  para ganhar a corrida). Fora de `ai.goals` o valor é multiplicado por `ai.scienceInterest` (padrão 1 para agências, 0,3 para
  empresas: SpaceX e Blue Origin não caçam ciência planetária); visitas repetidas pesam menos (`opsRepeatK`) e cada IA encomenda no
  máximo `maxOpsPerDest` (2, +1 num destino de meta) missões ao mesmo destino por campanha (`tries`); alvos com nota abaixo de
  `minScore` ficam de fora. Alvo caro demais para o caixa vira **plano de poupança** (`saving[id] = {destination, cost, banked,
  untilTurn, milestoneId}`): a IA tira dinheiro do caixa todo mês para a conta do projeto (fora do gasto abstrato do budget.js) até
  poder pagar; se o alvo some, o "primeiro" é tomado ou passam `saveWeeks` (52), o dinheiro volta. Missões agendadas do jogador
  contam como ameaça em `rivalEta`, exceto as que o jogador já adiou (`mission.redated`, marcado por `scheduleMission`).
  Um "primeiro" do jogador antecipa 4–8 semanas os programas rivais que buscam o mesmo marco e puxa as missões próprias deles.
  Ajuste em `data/calendar.json` `rivalOps`: `enabled`, `startTurn` e qualquer chave de `OPS_TUNING` em calendar.js (`cashShare` e
  `budgetShare` antigos saíram). Exportados: `goalDest(data, goal)` (meta → destino; tira o sufixo `:ator`), `rivalEta`,
  `racePressure` (líder confortável alivia, quem está atrás aperta; mais suave quando o líder é o jogador), `opsOptions`.
  Passo de corrida (`opsRace`): programa da IA que perderia um "primeiro" aberto para um voo rival anterior paga hora extra uma vez
  (`raced`) e antecipa até `raceMaxWeeks` (26). Cada IA tem fundo discricionário (`fund`, cresce com √verba, encolhe com os programas
  próprios nos próximos 2 anos).
- **Notícias do calendário (v0.3.0)**: templates de `calendar.news` podem ser listas de variantes (escolha por hash, não muda
  resultado); chaves novas `reactPlayer`, `raceAccelerate`, `opsAnnounce`, `opsRace`, `opsLost`. Falha de veículo em voo de teste vira
  manchete no máximo 1×/ano, de frota operacional 2×/ano e nunca 2× no mesmo trimestre (o resto vai ao balanço trimestral). Marcos de
  voos do catálogo ("chega ao Nº voo") a cada 100 até 500 e depois a cada 250.
- **Tripulações dos rivais**: um voo tripulado do calendário que falha (recuperável ou catastrófico) perde a tripulação com a chance de
  `crew.backgroundCrewLoss` (subida 0,25, chegada em órbita 0,4, pouso 0,55, menos metade do bônus `crewSafety` do dono), sorteada no
  rng do item; `inst.history[].lostCrew` marca a perda. `crewSafety` não aumenta mais a chance de sucesso do voo da IA (igual ao jogador).
- **Comando** (launch): `state.commandPoints` é um **estoque** da agência; a cena usa min(estoque, teto da escalação) e devolve o que
  sobrou; +1 a cada `CP_REGEN_WEEKS` (4) semanas até o teto do melhor diretor de voo (`state.commandPointsWeeks`). Contingência numa
  anomalia menor queima 8% de margem. Contagem regressiva usa `al.countSeed` (muda a cada adiamento); marcos continuam presos a `al.seed`.
- **Fatias**: narrative não escreve mais `state.tension` nem `state.relations`: usa `politics.nudgeTension` (±1 vira pressão no par de
  nações; 2+ adota o nível) e `diplomacy.bumpRelation`. Imports novos (sem ciclo): narrative → politics, diplomacy; missions → core/outcome.
- **Diplomacia**: tratados iniciais bilaterais têm `terms.protectedUntil` (padrão 26 semanas; ISS e Artemis III em data); tratados
  IA–IA sob tensão (rivalidade acima da confiança) podem romper todo mês (`STRAIN_K`). `diplomacy/joinBloc` tem as mesmas travas das
  propostas (recusa recente, tensão ≥ 3, pedido em aberto).
- **Dinheiro**: empresa do jogador paga dividendos trimestrais (50% do caixa acima de 30% da receita anual) e perde apoio se acumular;
  agência do jogador que deixa > 25% da verba do ano parada leva −5% no reajuste (`budgetModel.unspentShare/unspentPct`).
- **Notícias**: uma manchete por evento de missão (+ reação do rival só quando há "primeiro"); repetições de rotina na Terra e
  agendamentos de rotina só no log; falhas de lançadores no fundo: no máximo 2 por veículo em 52 semanas (o resto vai ao balanço
  trimestral); "caixa no vermelho" com 8 semanas de histerese. Templates do calendário sem concordância de gênero fixa.

### Ajustes cruzados sim ↔ UI
- `missions.needsTransit(data, m)` exportado; `mission/resolved` traz `final`; `activeLaunch.outcome.final` (false quando ainda há chegada).
- Fatores de `risk.missionRisk` podem ter `stages: ['asc']` (só valem no dia do lançamento; a cena de chegada os esconde).
- `diplomacy/preview` e `diplomacy/proposalTypes` trazem `refusalTrust` (e `counterRefusalTrust` na prévia).
- `missions/draftOptions` traz `autoName`; naves fora de `compatibleVehicles` do foguete escolhido vêm `valid: false`.
- destinations.json: `emLabel` ("na órbita lunar") e `toLabel` ("à órbita lunar") para manchetes.

## Expansão 1950–3000 (Fase A, v0.6.0)

Resumo do que já é contrato no código; números, esquemas e o plano das fases B–D em [docs/EXPANSION.md](docs/EXPANSION.md).

- **Tempo** (`data/core/eras.json`, `src/core/time.js`): 7 eras (e1 1950 … e7 2600–3000), 9 faixas de passo (1 sem → 1 ano).
  Uma volta pela grade dá 3.670 turnos; o evento final cai em jan/3000 (turno 54.600 em semanas). `bandAt`, `gridNext`,
  `stepLabel` (+1 sem … +1 ano), `formatTurnEra` (mar/1962, T3 2087, S1 2300, 2741), `yearOf`, `eraAt`.
- **Tick** (§1.6): cada toque avança um passo, encurtado no próximo compromisso do jogador (`appointments` de missions:
  "até o lançamento"), na fronteira de era ou no turno final. `ctx = {data, rng, date, dt, prevTurn, turn, eraId, year,
  hooks:{actorBorn, actorGone}}`. Módulo com `meta.maxDt` menor que o passo roda em sub-passos. Ganchos opcionais:
  `postInit` (chamado depois de todos os `init`), `onEraStart/onEraEnd/onYear/compact/onActorBorn/onActorGone/appointments`.
  Regra de módulo em passo variável: só os helpers de `src/sim/simtime.js` / `helpers.js` (nada de `turn % N`, `?? 2026`
  ou `/52` à mão). Com passo de 1 semana tudo dá exatamente o resultado antigo.
- **Era nova**: bloqueia o tempo (`isBlocked` → `'era'`) até o jogador continuar (`era/transition`, cena `era-scene.js`);
  sem o pacote da era carregado recusa com "Carregando a próxima era…" (`'needsData'`; a UI chama `store.ensureEra`).
- **Final** (jan/3000): cartão bloqueante `ending/final` com Contato · Silêncio · Herança (`ENDINGS`); escolher encerra o jogo.
  Conteúdo do Eco é da Fase C.
- **Cenários** (`data/scenarios/index.json` + `scenarios` de `data/packs.json`): `loadData(reader, {scenarioId, eras})`,
  `normalizeScenario` (lê `start/end/turnWeeks/ending`), `listScenarios`. `lunar_race` = `data/scenario.json` de sempre.
- **Pacotes de dados** (`data/packs.json`, `src/core/packs.js`, `src/core/data.js`): `core` e `legacy-e4` sempre; pacotes de
  era sob demanda (`ensurePacks`, `packsNeeded`: era atual, a anterior e a próxima depois de 85%; no máx. 3 na memória). A
  mescla é pura e determinística (lazy = eager, conferido por `full-campaign --compare-eager`). Itens ganham
  `fromYear/untilYear`; `src/core/catalog.js` responde o que existe numa data. Validador: `node tools/validate-data.mjs`.
- **Ciclo de vida dos atores** (`src/sim/lifecycle.js`, só com `scenario.lifecycle === 'on'`): bootstrap na data inicial
  (1950: NACA e OKB-1), eventos reais datados (nascer, renomear, fundir, dissolver, dividir nação, privatizar…) aplicados no
  mês exato, gerador anual depois de 2031 (teto 12 principais + 24 menores), aliases/tombstones para ids antigos.
  `diplomacy.addActor/retireActor`, `politics.ensureNation/retireNation`; sinais `actor/born|renamed|merged|gone|tier`,
  `nation/split`; consultas `lifecycle/timeline|identity|playable|actors|info`. Leituras de atores vivos sempre por
  `liveActors`/`resolveActor` (helpers). `agency/found` chegou na Fase B (ver abaixo).
- **Escolha do veículo (item 9)**: aceitar briefing/oportunidade/contrato cria a missão em `planning` com
  `vehicleId: null, spacecraftId: null` e `suggestion {vehicleId, spacecraftId, reason}`; `mission/schedule` recusa com
  "Escolha o foguete e a nave antes de agendar."; a UI abre a montagem no passo 2 com "Sugestão dos engenheiros" em destaque
  e nada pré-selecionado, e grava a escolha com `mission/update {missionId, patch:{vehicleId, spacecraftId,
  secondarySpacecraftId}}`. `missions/costRange` dá a faixa de custo dos cartões. Exceção: demo de certificação tripulada.
  A IA e os bots continuam usando `pickConfig`.
- **Saves** (`src/core/migrate.js`, `SAVE_VERSION = 2`; na Fase B o engine grava a versão mais alta que as migrações registradas alcançam, hoje **3**): v1 → v2 → v3 automático; recusa com mensagens pt-BR (códigos `newer`,
  `unreadable`, `scenario`). A Fase B acrescenta passos com `registerMigration`. Store: chaves `adastra.save.auto`,
  `slot1..3`, `era.<id>` e `adastra.save.v1` (legado), índice `adastra.saves.index`.
- **Compactação** (`compact`, só em campanhas > 10 anos): históricos mais curtos (missões, contratos, notícias 60, anais por
  década/século, tombstones, política, zonas, tratados) e limpeza dos dados de agências extintas. Meta: save ≤ 400 KB.
- **UI shell** (`src/ui/screens.js`, `drawer.js`): barra inferior Painel · Missões · ◉ tempo · Mapa · Mundo; gaveta ☰ com
  grupos Agência · Operações · Universo · Mundo · Arquivo · Sistema. Tela nova = 1 arquivo + 1 linha `registerScreen`
  (`nav`, `available`, `badge`, `load`, `go`, `action`, `soon`). Telas `soon` mostram esboço "em breve" até a fase indicada.
  Tela de título: Campanha 1950–3000 · Cenários · Continuar (espaços). `body[data-era]` é o gancho de pele por era (só e4 hoje).
- **Service worker**: o crawl do precache segue `data/packs.json` (todo arquivo de pacote e cenário) e os `import()` dinâmicos
  das telas, então pacote ou tela nova não precisa de edição em sw.js (99 arquivos hoje, teto 250).

## Fase B — o jogador e suas ferramentas (v0.7.0)

Contrato em [docs/EXPANSION.md](docs/EXPANSION.md) §5–§8 e §12. Módulos novos registrados em `MODULES` do engine (ordem: …
`designs` antes de `missions`, `investors` depois de `missions`, `explore` no fim). Todos com `meta.maxDt 52`, rng só por
`ctx.rng`/`rngFor`, slices JSON e tolerância a slice ausente (saves antigos).

- **Dados novos no pacote `core`** (`data/packs.json`): `emblem-parts`, `emblems`, `hq-sites`, `investors`, `parts` →
  `data.emblemParts`, `data.emblems`, `data.hqSites`, `data.investors`, `data.parts`. Fora do manifesto (buscados pela UI e
  listados em `sw.js` DATA): `data/world-eras.json` (épocas do mapa-múndi) e `data/core/stars.json` (setor e galáxia).
- **Fundar agência** (`src/sim/lifecycle.js`): `agency/found {kind, nationId, name, short, hq, emblem}` só antes do primeiro
  passo; cria o ator `custom_<hash>` (`custom: true`, `actor.hq {id?, name, lat, lon, launch?}`) pelo mesmo `addActor` dos
  nascimentos; devolve as 21 missões de calendário do ator anterior para a IA; segunda fundação na mesma partida é recusada.
  `agency/emblem` troca o logo depois. Puras: `sanitizeEmblem`, `foundingOptions`, `validateFound`, `foundPreview`, `customIdFor`
  (também como consultas `agency/*`). Empresas privadas só a partir de 1980; nações só as vivas na data de início.
- **Emblemas** (`src/ui/emblem.js`, SVG puro, roda em Node): forma · campo/padrão · órbitas · símbolo · estrelas · anel/fita ·
  rótulo, com nível de detalhe por tamanho (< 44 px sem texto; ≥ 72 px com lema), contraste checado, cache. Spec da linhagem
  (`emblems.json`, 44 identidades originais de 33 linhagens) > spec do ator > procedural por `hash32(id)` e tipo de ator.
  `portrait.emblemSVG` é só um invólucro. `app.js` registra os dados com `useEmblemData(data)` no boot.
- **Investidores** (`src/sim/investors.js`, slices `cap` e `mandates`; ativo com `scenario.unlocks.investors`): investidores
  somam no máx. 90%; jogador ≥ 50% = autonomia (recusar/adiar mandato uma vez, humor −15, o conselho não demite); abaixo de
  50% mandatos obrigatórios, prazo perdido = humor −25 + multa/ações, humor ponderado < 20 em duas rodadas seguidas →
  `gameOver {reason: 'board'}`. Vagas por ano `K` (por era), mandatadas `M = min(K−1, round(K·s^0,6))`. Rodada anual
  (`investors/round`), recompra 1,15× (`investors/buyback {holderId, pct}`), dividendos, fim de prazo (`investors/term`).
  Itens de programa do calendário viram mandatos do acionista âncora (governo 40% para agências nacionais, fundadores 30% para
  empresas; agência fundada começa com 100%). "Voo próprio" (cota e veto) = missão `source: 'custom'` sem mandato, a mesma
  conta da agenda de `missions.agendaOf`; contratos pagos e itens de programa não contam. Mandato encerrado sem voo fecha os
  rascunhos em planejamento (`missions.closeMandateMissions`). Migração v2 → v3 em `src/core/migrations/v3.js`.
- **Missões com mandato** (`missions.js`): `createMandateMission`, `mission/fromMandate`, selo do acionista, prazo e
  penalidade na lista e no detalhe; `mission/create` e "Aceitar" de oportunidade recusam com a agenda cheia (abaixo de 50%).
  Pares ligados tarde por `bindPeers({investors, designs})` (sem ciclo de import).
- **Hangar** (`src/sim/designs.js`, slice `designs`, catálogo `data/core/parts.json`): licença de um foguete do catálogo
  (`design/license`) ou rascunho de modelo (`design/new`), edição por estágio (motor × N, tanque/diâmetro, módulo pronto,
  propulsores, coifa, aviônica, escape, pintura), `design/save` → `derived` (Tsiolkovsky por estágio, TWR, frações
  estruturais por ano, penalidade de estágio superior fraco), `design/develop` → programa (custo, semanas) → voos de teste
  com lastro (missões `source: 'test'`) → operacional. `licenseKinship` desbota o que a licença herda conforme a mudança.
  `asVehicle` é o que `catalog.vehicleDef` devolve; a IA nunca recebe projetos do jogador.
- **Mapas**: mundo com épocas (`world-eras.json`: URSS, Pacto de Varsóvia, OTAN, Iugoslávia, colônias hachuradas, linha do
  tempo 1950→hoje) e sedes de agências fundadas; mapa espacial com níveis Terra–Lua · Interno · Externo · Completo e, por era,
  Setor (2200+) e Galáxia (2600+) em `src/ui/starmap.js`, névoa de guerra por `state.explored` (`src/sim/explore.js`,
  consulta `explore/state`) e marcadores de colônia (placeholders da Fase C).
- **Telas** (registro em `src/ui/screens.js`, kit comum `src/ui/screen-kit.js`): Conselho (`board.js`, disponível com
  `state.cap`), Identidade e logo (`identidade.js`, editor em folha `openEmblemEditor`), Hangar (`hangar.js`, a partir de
  `unlocks.builder`), Finanças (`financas.js`), Calendário de lançamentos (`lancamentos.js`), Anais (`anais.js`); assistente
  de fundação em 4 passos (`found-agency.js` + `css/found.css`) a partir da escolha de agência da Campanha.
- **Motor**: sinais só no primeiro sub-passo de um passo longo (antes cada módulo tratava o mesmo sinal 52 vezes); uma escolha
  de decisão recusada pelo handler (`ok: false`) devolve o cartão à fila em vez de sumir com ele.

## Geo: mapa-múndi e blocos vivos (state.geo, dono: politics)

- **Forma**: `state.geo = {zones, conflicts, events, shifts, blocChanges, blocNextTurn}`. `zones/conflicts/events/shifts` como na tabela de
  slices. Campos novos (nov/2026, saves antigos ganham os padrões no próximo tick):
  - `blocChanges`: lista datada (teto `blocDynamics.cap`, 60) de mudanças de bloco, de dois tipos:
    - país fora das agências: `{turn, kind: 'country', iso, bloc: 'artemis'|'ilrs', joined, from, to, cause}` (`from/to` são chaves do mapa:
      `artemis|ilrs|both|neutral`);
    - agência do jogo (registrada a partir do sinal `diplomacy/blocChanged`): `{turn, kind: 'agency', actorId, blocId, bloc, joined, isos}`.
  - `blocNextTurn`: turno mínimo para a próxima mudança de país (intervalo `blocDynamics.minGapWeeks`).
  - `events` (linha do tempo) ganha `kind: 'bloc_join' | 'bloc_leave'` (com `iso` ou `actorId`, `bloc`, `text` pronto em pt-BR).
- **Mapa**: `'geo/state' (turn?)` → `countryBloc` agora é datado: listas estáticas de `geopolitics.blocs` + `blocChanges` de países até o
  turno pedido + agências cujo bloco no turno difere do inicial (recolorem os países de `actorCountries`). A forma da resposta não mudou.
- **Dinâmica de países** (`data/geopolitics.json` `blocDynamics`, mensal, sem roteiro): chance base `signupHazard` × impulso (tensão global,
  atração dos blocos = fatia de prestígio do líder + "primeiros" recentes de membros). Candidatos com `lean {artemis, ilrs}`; país já num
  bloco pode assinar o outro (vira "Ambos"). Com tensão >= `sideMinLevel` entre as nações dos dois líderes, um país "Ambos" escolhe um lado.
  Teto `maxChanges` (3) por campanha. Cada mudança: notícia (`news.bloc_*`, nunca cortada pelo teto mensal: `pnews` opção `always`),
  evento na linha do tempo (`timeline.bloc_join/bloc_leave`), reputação ±1 para o líder do bloco e o sinal `geo/blocSignup`.
- **Territórios**: `model.shiftHazard` subiu (2: 0,0004; 3: 0,0045); toda mudança de controle continua com notícia + evento e agora emite
  `geo/zoneChanged`.
- **Sinais novos** (emitidos por politics): `geo/blocSignup {iso, countryName, bloc, blocId, joined, from, to, actorId (líder do bloco),
  withPlayer (o jogador está nesse bloco)}`, `geo/zoneChanged {zoneId, zoneName, from, to, conflictId, actorId (agência do lado que ganhou),
  nations}`. narrative usa os dois (cartas `bloc_*`, `map_redrawn`) e os marcadores `{country}`, `{bloc}`, `{zone}`.
- **Alinhamento de governo**: facções em `data/politics.json` têm `alignment: {blocId: -1..1}`. `politics.blocAlignment(state, data, actorId,
  blocId)` → número ou `null` (empresas, sem nação). diplomacy usa em `leaveUtility` (fator "alinhamento do governo") e na adesão de quem
  está sem bloco; eleição com `result: 'change'` grava `actor.ai.memory.newGovTurn` (fator "governo novo revê compromissos" por 52 semanas).
  Sair de um bloco é decisão estratégica: quando passa do limiar, acontece antes de outras propostas. Empresas não saem por conta própria.
- **Medir**: `node tools/sim-world.mjs 30 --engine --player=all` (eventos de bloco e territórios por campanha, manchetes e cartas mais
  repetidas); `node tools/sim-diplomacy.mjs 1 5 --quiet --seeds=10` (mudanças de bloco de agências e de países por semente).
