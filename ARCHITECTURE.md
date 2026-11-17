# Ad Astra — Arquitetura (contrato entre módulos)

Jogo de navegador, mobile-first (retrato), publicado no GitHub Pages. **Sem build step**: HTML + CSS + ES modules
puros, carregados direto pelo navegador. Nenhuma dependência npm em runtime. Testes rodam em Node 24 com `node --test`.

O GDD original (`GDD.md`) foi escrito para Godot; aqui a mesma arquitetura vale para a web:
**dados (data/*.json) → regras (src/core + src/sim, JS puro sem DOM) → interface (src/ui, observa o estado)**.

Escopo atual: **corte vertical "Corrida Lunar" (2026 a 2030)**, Era 4, 1 turno = 1 semana (260 turnos).

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
styles.css                 estilos globais + temas por era                                  [ui-shell]
manifest.webmanifest       PWA (instalar na tela inicial)                                    [ui-shell]
assets/icon.svg            ícone                                                             [ui-shell]
data/scenario.json         cenário (anos, atores jogáveis, metas)                            [core]
data/actors.json           atores, relações iniciais, blocos                                 [diplomacy]
data/vehicles.json         catálogo de lançadores                                            [catalog]
data/spacecraft.json       cápsulas, landers, sondas, módulos                               [catalog]
data/destinations.json     destinos, custo de energia, janelas, marcos de chegada            [catalog]
data/calendar.json         calendário vivo 2026-2030 (+projeções) com camada de veracidade   [catalog]
data/politics.json         economia, governos, eleições, eventos exógenos, templates de notícia [politics]
data/tech.json             tech tree (6 ramos)                                               [research]
data/crew.json             nomes, traços, peças de retrato, elencos iniciais                 [research-crew]
data/events.json           cartões de evento narrativos e de operação, cadeias               [narrative]
data/bodies.json           corpos do mapa (Terra, Lua, Marte, ...), posições e fichas        [map]
src/core/rng.js            RNG determinístico (hash32, makeRng, rngFor)                      [core]
src/core/time.js           turno <-> data                                                    [core]
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
src/ui/app.js              entrada da UI: boot, roteamento de abas, overlays                 [ui-shell]
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
src/ui/map.js              aba Mapa (Terra, Lua, Marte; zoom por pinça; janelas; trânsito)   [map]
src/ui/map.css                                                                               [map]
tests/*.test.mjs           testes node:test por módulo
tools/smoke.mjs            bot que joga campanhas inteiras e verifica invariantes            [core]
tools/sim-*.mjs            simulações em lote por módulo
```

## Motor (src/core/engine.js) — já implementado

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
| `news` | qualquer, via `addNews` | feed (mais recente primeiro, cap 200) |
| `signals`/`signalsPending` | qualquer, via `emitSignal` | ver Sinais |
| `stats` | qualquer, chaves `"modulo.chave"` | contadores |

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
`leo, sso, gto, iss, cislunar, lunar_orbit, lunar_surface, lunar_south_pole, mars_orbit, mars_surface, jupiter, titan`
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
crewed_orbit_national` (este último é por ator: `crewed_orbit_national:<actorId>` — `claimFirst` sempre dá "primeiro" porque é por ator).

### Tipos de missão e veículos
- `type`: `satellite | probe | crewed | cargo | station | lander`.
- Vehicle (data/vehicles.json `{vehicles:[...]}`):
  `{ id, name, operator: actorId, country, availableFrom: {year, month}, availableUntil?: {year, month}, truthLayer, costM, cadencePerYear,
     history: {flights, failures} (até 2025/2026, real), estimatedReliability?: 0..1 (para veículos novos), reusable, crewRated,
     capacity: { leo, gto, tli, mars, outer } (toneladas; 0 = não alcança), notes }`
  Ex.: `falcon9, falconheavy, starship, sls_b1, sls_b1b, new_glenn, vulcan, ariane6, h3, lvm3, long_march_5, long_march_10, soyuz2, angara_a5, electron`.
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
OutcomeLevel: `total | partial | recoverable | catastrophic`. FailureType: `propulsion | structure | software | human | environment`.
Cause: `{ kind: 'part'|'decision'|'luck'|'environment'|'crew', label (pt-BR), detail, weight }`.

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
  `'missions/nextWindow'`, `'missions/contracts'`.

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

## Sinais (cross-módulo)
`emitSignal(state, type, payload)`; ficam visíveis em `state.signals` durante o **próximo** tick, para todos os módulos.
Tipos: `mission/launched {missionId, actorId}`, `mission/resolved {missionId?, calendarId?, actorId, destination, type, crewed, outcome, failureType, phase}`,
`crew/died {crewId, missionId}`, `crew/legend {crewId}`, `first {milestoneId, actorId}`, `treaty/signed {treatyId}`, `treaty/broken {treatyId, by}`,
`tension/changed {a, b, from, to}`, `election {actorId, result}`, `budget/changed {actorId, from, to}`, `research/completed {nodeId, actorId}`,
`calendar/delayed {calendarId, weeks}`, `contract/awarded {contractId, winner}`.

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
Cada aba exporta `render(container, store)` (pode retornar função de limpeza). Abas: `dashboard` (Painel), `missions` (Missões), `research` (Pesquisa),
`map` (Mapa — `src/ui/map.js`), `world` (Mundo). `app.js` monta a barra de 5 abas na base, re-renderiza a aba ativa a cada mudança,
abre `decisions.js` para cartões e chama `openLaunchScene(store)` de `launch-scene.js` sempre que `state.activeLaunch` existir.
**launch-scene.js** exporta `openLaunchScene(store) → close()` (overlay de tela cheia dentro de `#overlay-root`).
**map.js** exporta `render(container, store)`.

Tema por era: `document.body.dataset.era = '4'`; CSS variables por era em styles.css. Fonte do sistema. Retrato, polegar, alvos >= 44px,
`env(safe-area-inset-*)`. Acessibilidade: texto escalável (`--text-scale`), modo daltonismo (sem depender só de vermelho/verde), reduzir movimento, nada só por som.

## Testes e ferramentas
- `npm test` → `node --test tests/` (cada módulo tem `tests/<modulo>.test.mjs`; use `loadDataNode(root)` de `src/core/data.js`).
- `node tools/smoke.mjs [seeds] [actor]` — bot joga campanhas completas com todos os atores jogáveis, faz save/load no meio, falha em exceção ou `log` com "erro".
- `tools/sim-launches.mjs` (10 mil lançamentos por veículo), `tools/sim-calendar.mjs` (20 sementes × 5 anos), `tools/sim-diplomacy.mjs` (log de alianças),
  `tools/sim-world.mjs` (20 sementes, mundos divergentes).
- Rodar localmente: `npx http-server -c-1 .` (ou qualquer servidor estático) e abrir `http://localhost:8080`.
