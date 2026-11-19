# Ad Astra 1950–3000: expansion contract (phases A–D)

Status: **binding spec** for the expansion workflow. It is the synthesis of `docs/proposals/expansion-1.md`
(simulation-first), `expansion-2.md` (player pacing, **base of this document**) and `expansion-3.md` (content
pipeline). Where this file and a proposal disagree, this file wins. ARCHITECTURE.md rules still hold everywhere:
data → rules (`src/core`, `src/sim`: deterministic, `ctx.rng` only, JSON state, save/load identical) → UI (observes
state, `store.dispatch`). No build step, no runtime deps, no runtime downloads, player text in pt-BR, no `git commit`.

Roadmap items (user, pt-BR, translated) and where they land:

| # | Item | Phase |
|---|---|---|
| 1 | Better world map and space map | B (shell hooks in A) |
| 2 | All content, campaign 1950 → exactly 3000 with a final event (Eco: Contato / Silêncio / Herança) | A engine + stub ending, C content |
| 3 | Agencies born dynamically (real dates to ~2030, speculative after) | **A** |
| 4 | Player creates own agency (country, HQ, logo) | B |
| 5 | Better logos for all agencies | B |
| 6 | Investors and shareholding; story missions become investor missions | B |
| 7 | Rocket builder (buy + edit, or from scratch) | B (catalog accessor in A) |
| 8 | Clearer screens, CSmanager hamburger drawer | **A** shell, B/C screens |
| 9 | Accepting a mission must not pick the vehicle/craft: the player decides | **A** (explicit user request this round) |

---

## 0. Measured baseline (nov/2026)

- Weekly tick 2.3–2.9 ms with 8 actors (calendar ≈ 0.98, diplomacy ≈ 0.64). Save after 260 weeks ≈ 210–220 KB.
- ~19 hard cadence/date assumptions in `src` (`turn % 4/13/52`, `isMonthStart`, `?? 2026`, `/ 52` year math).
- Auto-pick of hardware: `missions.js` `pickConfig` used by `calendarDraft` (l.957), `pushOpportunity` (l.1183),
  contract bid estimate (l.1326, estimate only, keep) and `awardToPlayer` (l.1491); plus the builder UI preselects
  the cheapest spacecraft at step 2 (`missions-tab.js` l.473).
- `vehicleDef/spacecraftDef` are local consts in `missions.js` (l.158–159); `data.index.vehicles[...]` direct reads in
  calendar, dashboard, missions-tab.
- `SAVE_VERSION = 1`, `deserialize` throws `'save incompatível'`; key `adastra.save.v1`.
- Data: 12 files in `DATA_FILES` + lazy `world.json`, `vehicle-art.json`. Vehicles already carry `availableFrom`;
  tech nodes carry `era`; events use `trigger.minTurn` (relative to scenario start).

---

## 1. Time model

### 1.1 Clock
- **Internal unit stays the week**, 52 per year (`time.js` simplified calendar). `state.turn` = absolute week since
  `state.startYear`. Every scheduled field (`launchTurn`, `arriveTurn`, `expiresTurn`, `plannedTurn`, `readyTurn`,
  `untilTurn`…) keeps its unit. No save field changes unit.
- Campaign: `startYear = 1950`. `dateToTurn(3000, 0, 1950) = (3000−1950)·52 = **54,600**` = the final turn.
- Each `tick` advances **`dt` weeks** (`ctx.dt`). One player "turn" (one tap on the disc) = one tick.
- `state.clock` (owner: core) =
  `{ eraId: 'e1'..'e7', stepWeeks, bandIdx, steps, eraStartTurn, pendingEra: null|{from,to}, paceMult: 1 }`.
  `paceMult` is reserved (always 1 until Phase D decides on a "Rápido" option); if used it is state, so determinism is
  per `(seed, actions, pace)`.

### 1.2 Step bands (Normal pace) — exact numbers

Every band starts on 1 January, every turn at a year start is a multiple of 52, and every step divides 52, so the grid
never drifts. Data lives in `data/core/eras.json` (`bands`), not in code.

| Band | Years | Era | stepWeeks | Turns | Disc label |
|---|---|---|---|---|---|
| b1 | 1950–1955 | e1 prologue | 13 | 24 | "+1 trimestre" |
| b2 | 1956–1975 | e1 A Corrida | 2 | 520 | "+2 sem" |
| b3 | 1976–1999 | e2 Estações e Sondas | 4 | 312 | "+4 sem" |
| b4 | 2000–2025 | e3 A Era Comercial | 4 | 338 | "+4 sem" |
| b5 | 2026–2050 | e4 A Década Lunar | 2 (campaign) · **1 in the Corrida Lunar scenario** | 650 | "+2 sem" |
| b6 | 2051–2199 | e5 Expansão do Sistema | 13 | 596 | "+1 trimestre" |
| b7 | 2200–2599 | e6 Interplanetária e Interestelar | 26 | 800 | "+1 semestre" |
| b8 | 2600–2989 | e7 Galáctica | 52 | 390 | "+1 ano" |
| b9 | 2990–2999 | e7 final decade (slow-down before the Silence) | 13 | 40 | "+1 trimestre" |
| — | jan/3000 | final event | — | — | — |
| **Total** | | | | **3,670 turns** | |

Grid checks (tested): 1956 → 312 (÷13), 1976 → 1,352, 2000 → 2,600, 2026 → 3,952, 2051 → 5,252 (÷13), 2200 → 13,000
(÷26), 2600 → 33,800 (÷52), 2990 → 54,080 (÷13), 3000 → 54,600.

Why: ~15–25 s of play per turn (Corrida Lunar today) gives a 15–25 h campaign, and every era has 300–650 turns (3–6 h).
The 1950–55 prologue avoids ~150 empty taps before Sputnik. A scenario may set `turnWeeks` (Corrida Lunar = 1; a future
"A Corrida 1957–1969" scenario may also use 1).

### 1.3 Truncated step (launch day lands on the right week in any era)
`stepFor(state, data)`:
```
gridNext  = next multiple of band.stepWeeks after state.turn (band of state.turn; ≥ turn+1)
appoint   = min over modules' appointments(state, data) of turns > state.turn   (player appointments only)
dt        = max(1, min(gridNext, appoint, eraBoundary, finalTurn) − state.turn)
```
Appointments (exported by modules as `appointments(state, data) → number[]`): player missions `scheduled.launchTurn`,
player `transit.arriveTurn`, scheduled scenes. Decision expiry is **not** an appointment; instead every
`pushDecision` with an expiry uses `expiresTurn = turn + max(weeks, ctx.dt)` (helper `expiryIn(ctx, weeks)`).
After a truncated step the next step completes the grid ("+1 ano" in 2234 may stop in mar/2234 for a launch, the
next tap finishes the year). The disc label says "até o lançamento" when the step is truncated.

### 1.4 Module rules under variable `dt` (helpers.js, the only allowed tools)
```js
every(ctx, periodWeeks, phase = 0)   // count of t ≡ phase (mod period) in [ctx.prevTurn, ctx.prevTurn + ctx.dt)
crossed(ctx, periodWeeks, phase = 0) // every(...) > 0  — replaces `state.turn % N === k`
perStep(weeklyAmount, ctx)           // weeklyAmount * ctx.dt   (income, salaries, research progress)
chanceInStep(pWeek, ctx)             // 1 − (1 − pWeek) ** ctx.dt   (one draw per tick)
decay(x, perWeekFactor, ctx)         // x * perWeekFactor ** ctx.dt
dueIn(ctx, t)                        // t != null && t < ctx.prevTurn + ctx.dt   (scheduled thing is due this tick)
cadence(ctx, { weeks, minSteps = 1 })// effective period max(weeks, minSteps*dt), returns crossed() on it
expiryIn(ctx, weeks)                 // ctx.turn + max(weeks, ctx.dt)
```
- At `dt = 1` each helper reduces **exactly** to the old expression (`every(ctx,52,51)` fires when `turn%52===51`).
  This is what keeps the Corrida Lunar bit-identical.
- `x === state.turn` checks become `dueIn` plus a consumed flag; windows shorter than `dt` are "open during the tick
  that contains them".
- Multi-fire processes (AI proposals, AI mission orders) draw `min(every(...), cap)` times with **at most one
  news-worthy event per actor per process per tick**.

### 1.5 Safety net: per-module `maxDt` substepping (from proposal 1)
Each sim module exports `meta = { maxDt: 1|2|4|13|26|52 }` (default 1). If `ctx.dt > meta.maxDt` the engine calls that
module's `tick` `ceil(dt/maxDt)` times, temporarily setting `state.turn` (and the sub-ctx `prevTurn/dt/rng`) to each
sub-window and restoring it after. A module not yet converted stays correct (only slower). Phase A targets:

| Module | maxDt at end of A |
|---|---|
| politics, diplomacy, budget, research, crew, narrative, lifecycle | 52 (dt-native) |
| calendar | 13 |
| missions | 4 |
| launch, risk | n/a (no time logic / scene-driven) |

Era-7 tick target ≤ 10 ms with these values.

### 1.6 Engine tick (exact order)
```
tick(state, data):
  if gameOver: return
  ctx base: dt = stepFor(); prevTurn = turn; date = turnToDate(turn) (date at START of step); eraId; year
  expire decisions with expiresTurn <= turn
  signals ← signalsPending
  for module in MODULES (lifecycle right after politics): substepped tick
  turn += dt; clock.steps += 1
  every(ctx, 52) > 0  → each module's onYear(state,data,ctx) then compact(state,data,ctx)
  eraAt(year(turn)) != clock.eraId → clock.pendingEra = {from,to}; onEraEnd hooks; push blocking 'era/transition'
  scenario.ending.type === 'final' && turn >= finalTurn → push blocking 'ending/final' (once)
  scenario.ending.type === 'end'   && turn >  endTurn   → gameOver {reason:'end'} (today's behaviour)
```
- `advance(state, data, turns, {stopOnEvent})` counts **turns**. `{type:'time/advance', turns}` is the new action;
  `{weeks}` stays accepted (converted to turns, equal at dt=1) so tools/tests keep working.
- `isBlocked` gains `'era'` (pending transition) and `'needsData'` (next era's pack not loaded).
- `'era/transition'` resolution (built-in engine handler; choice `continue`): refuses with
  `{ok:false, needsData:'eN', error:'Carregando a próxima era…'}` if the pack is missing, else runs `onEraStart` hooks,
  sets `clock.eraId/eraStartTurn`, clears `pendingEra`.
- `'ending/final'` built-in fallback handler (Phase A stub, replaced by `src/sim/eco.js` in C, which registers the same
  decision kind): choices `contato | silencio | heranca`, sets `gameOver = {reason:'ending', ending, turn}`.
- Optional module hooks: `onEraStart`, `onEraEnd`, `onYear`, `compact`, `onActorBorn(state,data,ctx,id,info)`,
  `onActorGone(state,data,ctx,id,{into,reason})`, `appointments`, `onGameEnd` (exists). The engine exposes
  `ctx.hooks.actorBorn(id, info)` / `ctx.hooks.actorGone(id, info)`, which call every module's hook in MODULES order —
  this is how lifecycle notifies other modules without circular imports.
- RUN ("Próximo evento", long-press): `RUN_MAX_STEPS = 12` turns or 26 weeks, whichever is longer.

---

## 2. Scenarios and campaign

### 2.1 Scenario file (`data/scenarios/<id>.json`; legacy `data/scenario.json` = `lunar_race`)
```jsonc
{ "id": "campaign", "kind": "campaign",              // 'campaign' | 'scenario'
  "name": "Campanha", "subtitle": "1950 a 3000",
  "start": {"year": 1950, "month": 0}, "end": {"year": 3000, "month": 0},
  "turnWeeks": null,                                  // null = bands; number = fixed step
  "eras": ["e1","e2","e3","e4","e5","e6","e7"],
  "snapshot": "e1",                                   // initial actor values from data/eras/e1/snapshot.json
  "playable": {"rule": "alive", "actors": ["nasa","roscosmos"], "found": true},   // found = Phase B
  "history": "faithful",                              // rivals' 'fato' items fly on real dates with real outcomes
  "lifecycle": "on",
  "ending": {"type": "final", "event": "ending/final"},
  "unlocks": {"builder": {"fromYear": 1957}, "investors": {"fromYear": 1950}, "colonies": {"fromYear": 2051}},
  "historicalFirsts": null }
```
- The loader **normalizes** the legacy file without editing it: `kind:'scenario'`, `start/end` from
  `startYear/endYear`, `turnWeeks: 1`, `eras: ['e4']`, `lifecycle: 'off'`, `ending: {type:'end'}`,
  `playable: {rule:'list', actors: playableActors}`. `endTurn` keeps today's formula for `type:'end'`
  (`(endYear−startYear+1)·52−1`); for `type:'final'` `endTurn = finalTurn = dateToTurn(end)`.
- `loadDataNode(root)` with no options = Corrida Lunar exactly as today (the 327 tests keep their world).
- Phase C adds one short scenario per era (1–2 h, 150–300 turns): A Corrida 1957–1969, Estações 1981–1998,
  Nova Economia 2008–2020, (Corrida Lunar 2026–2030 exists), Fronteira Marciana 2051–2100, Primeira Estrela 2380–2420,
  O Grande Silêncio 2950–3000 (unlocked after finishing the campaign once).
- Scenarios that start mid-history are **built from data, not simulated** (`snapshot` of the era: live actors from the
  lifecycle up to the start date, budgets/relations/blocs, `historicalFirsts`, vehicle history).

### 2.2 History with the player in it
- Default `history: 'faithful'`: rival items with `truthLayer: 'fato'` fly on their real date with `historicalOutcome`
  (as today: `slipChance 0`). If the player got there first, the rival still flies and takes second place.
- Items owned by the player's lineage become **mandates** (§5): if the player fails, history diverges from there.
- Calendar items that depend on other items carry `canon: {requires: {...}, onBreak: 'drop'|'reassign'|'retarget'}`
  (Phase C authors must fill it for 1957+ dependent items; e.g. Apollo-Soyuz requires `actorAlive: roscosmos` and
  tension < 3, else it drops with a news item).
- Soft anchors: `fato` actors' budgets drift 10%/year toward `budgetSeries` of their lineage (data), so 75 years of real
  history don't wander off.
- A "Fiel / Divergente" selector is **not** in scope (open question for the user, §15).

### 2.3 Era table
| id | Era | Years | Truth layer | Closing milestone (narrative, not a gate) |
|---|---|---|---|---|
| e1 | A Corrida | 1950–1975 | fato | Pouso na Lua e Apollo-Soyuz |
| e2 | Estações e Sondas | 1976–1999 | fato | Primeiros módulos da ISS |
| e3 | A Era Comercial | 2000–2025 | fato | Reuso de foguetes vira rotina |
| e4 | A Década Lunar | 2026–2050 | plano_oficial (≤2035), projecao (2036–2050) | Base lunar permanente |
| e5 | Expansão do Sistema | 2051–2199 | especulacao | Primeira colônia autônoma |
| e6 | Interplanetária e Interestelar | 2200–2599 | especulacao | Primeiro pouso em outro sol |
| e7 | Galáctica | 2600–3000 | especulacao | O Grande Silêncio |

Truth layers in the sim (validator-enforced): `fato` ≤ 2025, `source` required, anchored; `plano_oficial` 2026–~2035,
slip drawn from history (today's model); `projecao` ~2036–2050, happens with `chance` inside `window {from,to}`;
`especulacao` ≥ 2031, authored or generated.

### 2.4 Era transition
Engine-driven (§1.6). UI: full-screen `era-scene.js` overlay, 4 cards (swipe or "Próximo"): (1) "Fim da Era N: …" with
the Tabela da Era trophy and rank; (2) "O que você fez" (≤ 3 firsts, best Album card, launches); (3) "Quem ficou"
(faces from the start of the era, Memorial names); (4) "A próxima era": "Agora cada toque = +1 trimestre", unlocked
systems, actors born/gone, an Eco fragment (C). Button "Começar a Era N+1" dispatches `decision/resolve`.
Respects reduced motion. The store writes an **era checkpoint** save before card 4 and preloads the next pack while
the scene is open. `state.eraHistory[] = {eraId, turn, standings:[{id, prestigeEra}], firsts, survivors, headline}`;
`actor.prestigeEra` resets at each transition (lifetime prestige carries over).

### 2.5 Chapters
`era.json.chapters: [{from:{year,month}, title}]` (2–4 per era). A chapter change is an importance-3 news item with a
light, non-blocking card: a natural session end.

---

## 3. Actor lifecycle

### 3.1 Model
- **Lineage id is stable; identity changes with the date.** The 8 current ids stay and become lineage ids
  (`nasa` is "NACA (EUA)" in 1950; `roscosmos` is "OKB-1 / Programa espacial soviético"; `cnsa` is "Quinta Academia";
  `isro` is "INCOSPAR"; `esa` is "ESRO"; `jaxa` is "NASDA"). Relations, treaties, calendar owners, saves and tests keep
  working.
- **On rename, lifecycle writes the current identity into `state.actors[id]`** (`name, short, flag, country, emblem,
  kind`). Every existing reader of `actor.name` keeps working; old news keep their baked text.
- Predecessors that merge into a lineage (ABMA → nasa, ELDO → esa, ISAS → jaxa) are absorbed: `state.lifecycle.aliases
  [old] = into`, `helpers.resolveActor(state, id)` follows aliases.
- **Dead actors leave `state.actors`** and become tombstones `state.lifecycle.tombstones[id] = {id, name, short, emblem,
  born, died, into, cause, prestigeTotal}` (≤ 200 B, cap 200). Relations/tension/proposals/treaties with them are
  removed by diplomacy/politics in `onActorGone`. `helpers.actorInfo(state, id)` returns live actor or tombstone (UI).
- **Tiers**: `actor.tier = 'core' | 'minor'`. Core = full AI (relations, calendar, research, proposals); **cap 12 core AI
  + the player**. Minor = background (yearly budget/prestige/aggregate commercial flights, flag on the map, Tabela
  row), **cap 24**, no relation row. `liveActors(state, {tier})` replaces `Object.keys(state.actors)` in loops.
  Promotion/demotion yearly by prestige+budget rank (top 12 = core). The player is always core.
- Nations are a parallel lifecycle (`data/core/nations.json`): `{id, name, from, to?, successors?, isos:[{iso,from,to?}]}`
  (`ussr` 1950–1991 → `russia`, `ukraine`, `kazakhstan`; `europe` bloc-nation). Politics runs per live nation.

### 3.2 Data schemas
`data/core/lineages.json`
```jsonc
{ "lineages": [
  { "id": "nasa", "kind": "agency", "tier": "core", "nation": [{"from":1950,"id":"usa"}],
    "born": {"year": 1915, "month": 2}, "truthLayer": "fato", "playableFrom": 1950,
    "identities": [
      {"from": {"year":1950,"month":0}, "name": "NACA (EUA)", "short": "NACA", "flag": "🇺🇸", "country": "EUA"},
      {"from": {"year":1958,"month":9}, "name": "NASA (EUA)", "short": "NASA"} ],
    "budgetSeries": [[1950, 50], [1959, 145], [1966, 5900]],
    "eraProfiles": {"e1": {"ai": {"goals": ["first_satellite","first_crewed_orbit","crewed_lunar_landing"]}}} } ] }
```
`data/core/lifecycle.json` (`month` is 0-based like `time.js`)
```jsonc
{ "events": [
  {"id": "naca_to_nasa", "date": {"year":1958,"month":9}, "op": "rename", "actor": "nasa", "to": 1, "truthLayer": "fato", "source": "…"},
  {"id": "abma_into_nasa", "date": {"year":1960,"month":6}, "op": "merge", "from": ["abma"], "into": "nasa",
   "inherit": {"crew": "transfer", "cash": 0.5, "prestige": "sum", "vehicles": ["redstone","jupiter_c"]}},
  {"id": "ussr_end", "date": {"year":1991,"month":11}, "op": "nationSplit", "nation": "ussr", "into": ["russia","ukraine","kazakhstan"],
   "actors": {"roscosmos": {"nation": "russia", "budgetShock": -0.7}}},
  {"id": "spacex_born", "date": {"year":2002,"month":2}, "op": "birth", "actor": "spacex"} ] }
```
`op ∈ birth | rename | merge | split | dissolve | nationSplit | privatize | nationalize`.

`data/core/actor-gen.json` (procedural, ≥ 2031): `caps {core: 12, minor: 24}`, `archetypes[]` (`emerging_agency`,
`megacorp`, `mining_consortium`, `colony_gov` (needs colony stage ≥ 5), `colegio_silencio` (scripted, once, Eco
piece 2)), each with `eras`, `kind`, `weight`, `needs`, pt-BR name grammar, `start` values and emblem grammar;
`successors {fromYear: 2051, hazardPerYear: 0.01}` (real lineages get speculative successor identities, never removed);
`dissolve {cashNegativeYears: 3, supportBelow: 10, hazardPerYear: 0.05}`; `merge {trust: 80, dependence: 60, years: 10}`.

### 3.3 Real dates to seed (1950–2030) — Phase C must verify each with a `source`
| Date | Op | Lineage | Tier |
|---|---|---|---|
| 1950 | alive: NACA (1915) | `nasa` (identity 0) | core |
| 1950 | alive: OKB-1 (Korolev, 1946) | `roscosmos` (identity 0) | core |
| 1956-02 | birth ABMA (US Army) → merge into nasa 1960-07 | `abma` | core until merge |
| 1956-10 | birth Quinta Academia (China) | `cnsa` | core |
| 1958-10 | rename NACA → NASA (JPL dez/1958) | `nasa` | |
| 1961-12 | birth CNES | `cnes` | minor |
| 1962-02 | birth INCOSPAR → rename ISRO 1969-08 | `isro` | core |
| 1964 | birth ESRO (`esa` identity 0) and ELDO (`eldo`) → ELDO merges, ESA name 1975-05 | `esa`, `eldo` | core |
| 1964 | birth ISAS → merges into jaxa 2003-10 | `isas` | minor |
| 1969-10 | birth NASDA (`jaxa` identity 0) → rename JAXA 2003-10 | `jaxa` | core |
| 1969 | birth DFVLR/DLR | `dlr` | minor |
| 1980-03 | birth Arianespace | `arianespace` | minor |
| 1982 | birth Orbital Sciences (→ Orbital ATK 2015, Northrop Grumman 2018: renames) | `orbital` | minor |
| 1983 / 1988 / 1989-03 / 1989-10 | ISA (Israel) / ASI / CSA / KARI (→ KASA 2024-05) | `isa_il`,`asi`,`csa`,`kasa` | minor |
| 1991-12 | USSR ends; `roscosmos` → Russia (RKA 1992-02, Roscosmos 2004-03); SSAU born 1992 | | |
| 1993-04 | rename → CNSA (CMSA/Project 921 is a program flag) | `cnsa` | |
| 1994-02 | birth AEB (Brasil) | `aeb` | minor (playable "emerging") |
| 2000-09 / 2002-03 | birth Blue Origin / SpaceX | `blueorigin`, `spacex` | core |
| 2006 | birth Rocket Lab (jun), ULA (dez) | `rocketlab`, `ula` | minor |
| 2014 | birth UAE Space Agency | `uaesa` | minor (playable "emerging") |
| 2015–2018 | LandSpace, iSpace, Firefly, Relativity, Skyroot, ASA (2018-07) | | minor (cap-limited) |
| 2016 / 2021 | Axiom / Vast | `axiom`, `vast` | minor |
| 2023/2025 | AfSA (Cairo) | `afsa` | minor |
| 2026–2030 | only `plano_oficial` changes (from the e4 pack) | | |

### 3.4 The player inside the lifecycle
- `rename`: news + identity card, transparent.
- Merge where the player's lineage is absorbed (rare: e.g. player runs ISAS): blocking card "Fusão: você agora dirige
  a JAXA", `state.playerId` moves to the survivor; missions, crew, cash carried.
- Non-rename real ops affecting the player's lineage (optional merge, privatization) become a **proposal** decision with
  the historical choice as default. The player's lineage is exempt from hazard dissolution (it ends only via gameOver).
- v0.9.13: the player can leave the lifecycle's player seat without ending the campaign. Fired (budget) or removed by the board
  (investors), the director chooses another live agency or founds one at today's date; the old agency stays in the world as an AI
  actor (ARCHITECTURE.md "Demitido não é fim de jogo", src/sim/director.js).
- `nationSplit` affecting the player: crisis card (budget shock from data, engineer emigration decision).
- Lunar Race: `lifecycle: 'off'` → module is a no-op (golden unchanged).

---

## 4. Data packs, loader, catalog, validator

### 4.1 Layout (Phase A moves **no** existing file)
```
data/
  packs.json                manifest (new)
  scenario.json             = lunar_race (unchanged) ; actors.json, vehicles.json, … = pack "legacy-e4" (unchanged)
  core/                     era-agnostic: eras.json, lineages.json, lifecycle.json, nations.json, actor-gen.json,
                            ending.json, vocab.json (C0), schemas/*.schema.json; (B) parts.json, investors.json,
                            emblem-parts.json, hq-sites.json; (C) eco.json, colonies.json
  eras/e1 … e7/             era.json (meta, chapters, palette), snapshot.json (e1 in A), and optional
                            vehicles/spacecraft/destinations/calendar/tech/events/politics/geopolitics/crew/
                            investors/parts/patches.json — Phase A ships them absent or empty-valid
  scenarios/                index.json, campaign.json (Phase C adds era scenarios)
  world.json, vehicle-art.json   presentation, lazy, unchanged
```
`data/packs.json`:
```jsonc
{ "version": 1,
  "packs": [
    {"id": "core", "always": true, "dir": "core/", "files": ["eras","lineages","lifecycle","nations","actor-gen","ending"]},
    {"id": "legacy-e4", "era": "e4", "always": true, "dir": "", "files": ["actors","vehicles","spacecraft","destinations",
       "calendar","politics","geopolitics","tech","events","crew","bodies"]},
    {"id": "e1", "era": "e1", "dir": "eras/e1/", "files": ["era","snapshot"]},
    {"id": "e2", "era": "e2", "dir": "eras/e2/", "files": ["era"]}, "… e3, e5, e6, e7 …" ],
  "scenarios": {"lunar_race": "scenario.json", "campaign": "scenarios/campaign.json"} }
```
`legacy-e4` is `always` in Phase A because it also carries era-agnostic vocabulary (bodies, destinations, crew pools).
Phase C4 splits it into `core/` + `eras/e4/` and removes the alias in D.

### 4.2 Merge rules (`src/core/packs.js`, pure)
- Output = **today's `data` shape** (`data.vehicles.vehicles`, `data.index…`) + `data.eras`, `data.lineages`,
  `data.lifecycle`, `data.nations`, `data.actorGen`, `data.ending`, `data.packsLoaded`, `data.scenario` (normalized).
  Sim modules don't know packs exist.
- Lists with `id` merge by id in manifest order. A duplicate id outside `patches.json` is a validation error;
  `patches.json` items use `"$op": "patch"|"replace"|"remove"`. Lists without id concatenate; config objects merge deep.
- **Stamping**: each entity from a pack with `era` gets `era` (if absent) and `fromYear = era.from` when it has no
  absolute date (`availableFrom`, `date`, `plannedDate`, `trigger.fromYear`). Sim modules must honour
  `fromYear/untilYear` (narrative triggers, tech availability, crew pools, destinations). For Corrida Lunar every
  stamped year is ≤ 2026, so nothing changes.
- **Determinism rule**: sim results must not depend on which packs are loaded. Guaranteed by (a) the validator: no
  entity of pack `eN` has an effective date before `eN.from` (except `patches.json`); (b) sim filters by date, never by
  "is loaded"; (c) the engine refuses to enter an era whose pack is missing (`needsData`). Node loads all packs; the
  browser loads core + legacy-e4 + current era (+ previous) and preloads the next at 85% of the era.
- `state.dataPacks = {id: hash}` is saved; a changed hash on load logs to `state.log` (not a rejection).

### 4.3 Catalog accessor (`src/core/catalog.js`, Phase A)
```js
vehicleDef(data, id, state?)      // data.index.vehicles[id] ?? state?.designs?.[id]?.asVehicle ?? null
spacecraftDef(data, id, state?)   // same for craft
vehicleAvailable(data, state, id, turn) // availableFrom/availableUntil vs the date, alive operator (aliases)
listVehicles(data, state, {turn, actorId}) // catalog + player designs, filtered by date
```
Every vehicle/craft lookup in `src/sim` and `src/ui` goes through it (replaces `missions.js` l.158–159 locals and direct
`data.index.vehicles[...]` reads). Phase B4 fills `state.designs` without touching callers.

### 4.4 Validator (`tools/validate-data.mjs` + `tools/validate/{schema,rules}.js`, no deps)
Mini JSON-Schema subset (type, required, enum, min/max, pattern, items, properties, local `$ref`) + rules with pt-BR
messages and `file#id.field` paths: unique ids `^[a-z0-9_]+$`; references resolve (operator, owner, partners,
vehicleId, spacecraftId, destination, milestone, requires, `into`) **respecting the lifecycle** (no reference to an
actor before birth / after death unless via `into`); dates inside the pack's era window; truth layer × year (§2.3);
`fato`/`plano_oficial` need `source`; `capacity` monotone (leo ≥ gto ≥ tli ≥ mars ≥ outer); lifecycle without merge
cycles and identities covering continuous intervals; scenario playable actors alive at start; pt-BR text checks
(no `TODO`, known placeholders only, length caps). Runs as `node tools/validate-data.mjs [--pack e2] [--json]` and
inside `node --test` (`tests/data-validate.test.mjs`). Prints per-year density for authors.

### 4.5 Budgets
Pack ≤ 350 KB raw (art and world stay in lazy files); boot data ≤ 1.2 MB raw (core + legacy-e4 + one era).

---

## 5. Player agency, investors and mandates (Phase B; numbers are binding)

### 5.1 Cap table (`src/sim/investors.js`, slice `state.cap`, only for the player)
```
state.cap = { playerPct: 10..100,
  holders: [{ id, kind: 'government'|'founders'|'fund'|'corporation'|'consortium'|'colony', name, pct, sinceTurn,
              profile, mood: 0..100, emblem }],
  lastRoundTurn, valuationM,
  history: [{ year, playerPct, raisedM, delivered, failed }] }   // cap 60, then decade means
state.mandates = [{ id, holderId, title, type, destination, count, deadlineTurn, rewardM,
                    penalty: {mood, cashM?, pct?}, missionIds: [], status: 'open'|'flying'|'done'|'failed'|'expired' }]
```
### 5.2 Rules
- **Investors together hold at most 90%** → `playerPct ≥ 10`. An offer that would cross the cap is never generated.
- **Autonomy at `playerPct ≥ 50`**: the player may decline or postpone a mandate once (mood −15 for that holder);
  the board cannot remove the director.
- **Below 50%**: mandates are binding; a missed deadline costs mood −25 and the holder's penalty. If the
  pct-weighted mean mood < 20 at two consecutive rounds, the board removes the director:
  `gameOver {reason: 'board'}` with a warning card one round before (same path as today's dismissal). Since v0.9.13 both dismissals
  remove only the director (`helpers.removeDirector`): the campaign goes on with another agency.
- **Mandate share of the agenda.** `K` = mission slots per year (pads × crews × era tunable, ≥ 2). With
  `s = 1 − playerPct/100` (investor share):
  `M = min(K − 1, round(K · s^0.6))` mandated slots per year; own slots `= K − M` (always ≥ 1: "quase nenhum espaço").
  Reference (K = 6): player 100% → M 0 (6 own) · 90% → 2 (4) · 75% → 3 (3) · 60% → 3 (3) · 50% → 4 (2) ·
  30% → 5 (1) · 10% → 5 (1). Tunables `exponent 0.6`, `minOwn 1` in `data/core/investors.json`.
- **Story missions become investor missions.** Calendar program items owned by the player's lineage are mandates of
  the anchor holder: `government` for national agencies, `founders` for real companies. The briefing shows the
  holder's emblem and deadline; the item's real date + slip is the deadline. One rule covers real agencies, companies
  and founded agencies. AI actors have no cap table.
- **Starting stakes** (tunable, open question §15): real national agencies government 40% (player 60%, autonomous, the
  government program is still its mandate list); real companies founders/early funds 30% (player 70%); founded agency
  100% with a small seed (must sell to grow).
- **Yearly round**: `cadence(ctx, {weeks: 52, minSteps: 5})` → once a year in eras 1–5, every 5 turns in eras 6–7.
  Non-blocking decision `investors/round`, expires `expiryIn(ctx, 8)`, 1–3 offers from era archetypes
  (ministries e1–e2; funds/telecom/defense from e3; mining/tourism e4–e5; colonies/consortia e5+):
  `{holderKind, name, pct 1..30, cashM, profile (mandate template), termYears}`. Buy-back `investors/buyback
  {holderId, pct}` at `pct × valuation × 1.15` when cash allows. Valuation = f(prestige, reputation, fleet, cash).
- Integration: `missions.js` exports `createMandateMission(state, data, mandate)`; `investors.onMissionResolved` is
  called from `missions.onLaunchResolved` (one line). Budget gains categories `investors` (capital in), `dividends`.

### 5.3 Founding an agency (Phase B, item 4)
New game → "Dirigir uma agência existente" (playable lineages alive at start) **or** "Fundar a sua" (4-step wizard, one
decision per screen): (1) kind: state agency (any year) or private company (from 1980 in the campaign; before that the
card says "Empresas privadas de lançamento só surgem nos anos 80"); (2) country (nations alive at start) and HQ
(suggested cities from `data/core/hq-sites.json` with lat/lon and launch-site option, or tap on the world map);
(3) name, short (≤ 6 letters), colours and logo editor; (4) summary with derived difficulty and "Fundar agência".
Action `agency/found {name, short, kind, nationId, hq:{id}|{lat,lon}, emblem}` valid only at turn 0; lifecycle creates
a normal lineage `custom_<hash>` (`custom: true`, tier core) through `diplomacy.addActor`, and `politics.ensureNation`
creates a generic nation if the country has none.

### 5.4 Logos (item 5)
`emblem = {shape: 'roundel'|'shield'|'hex'|'chevron'|'wing'|'star'|'wordmark', field, field2?, division:
'none'|'half'|'band'|'chevron'|'quarter', ring?: {color, text?}, glyph: 'rocket'|'orbit'|'star'|'planet'|'comet'|
'capsule'|'atom'|'globe'|'wreath', glyphColor, stars: 0..12, label}` (≤ 200 B). `src/ui/emblem.js`
`emblemSVG(spec, {size})` (pure, cached by `(specHash,size)`); `portrait.emblemSVG` becomes a wrapper. Parts in
`data/core/emblem-parts.json` (small SVG paths). Real agencies get a designed, era-styled spec per identity (never an
official logo); procedural actors draw from their archetype grammar seeded by `hash32(id)`; the founder edits 5
controls + "Sortear". Shown in header, Tabela, map HQs, news, briefings (holder emblem).

---

## 6. Rocket builder (Phase B, item 7)

- `data/core/parts.json` (+ `data/eras/eN/parts.json`): `engines [{id, name, prop, thrustKN, ispSL, ispVac, massT,
  costM, reliability, availableFrom, tech, family}]`, `tanks {prop: {densityT_m3, structFrac by era}}` with sizes
  S/M/L/XL, `boosters`, `fairings`, `escape`, `avionics`; `deltaV {leo 9.4, gto 11.8, tli 12.5, mars 13.1, outer 15.5}`
  km/s (losses included); `rules {maxStages 4, maxEnginesPerStage 30, minTWR 1.2}`.
- `src/sim/designs.js` (slice `state.designs`): `{id:'dsg_<n>', name, owner, baseVehicleId|null, origin:
  'license'|'scratch', stages:[{engineId, engines, tank, size}], boosters:{id,count 0/2/4/6}, fairingId, avionicsId,
  derived:{capacity, costM, reliabilityPrior, devCostM, devWeeks, heightM, diaM} (cache), program: null|{phase:
  'work'|'testFlights'|'operational', startedTurn, readyTurn, testFlights, needFlights}, stats:{flights, failures}}`.
  Cap 12 live designs per player.
- `designStats(data, spec, techCtx)` is pure: Tsiolkovsky per stage, TWR check, structural fractions by era. Catalog
  rockets get a `design` decomposition; **test: every catalog `design` reproduces its `capacity` within ±10%** (`calib`
  per family allowed).
- **Buy and edit**: `design/license {vehicleId}` (fee from vehicle cost and relation; same `access`/`embargo` rules;
  tension ≤ 2) → design with `baseVehicleId`, inheriting flight history (stronger reliability prior).
  **From scratch**: family templates (2-stage, 3-stage, core+boosters, reusable) with unlocked parts.
- Development reuses the crewed-certification shape (`work → testFlights → operational`); test flights are missions
  `source: 'test'` with ballast (the only case besides `cert` where the vehicle is locked). Editing an operational
  design makes a revision ("Andorinha II-B") with smaller cost/time.
- Mobile UI "Hangar" (drawer): vertical stack of stage cards, engine sheet showing deltas ("+0,8 t LEO, −2% confiança,
  +US$ 4 mi"), tank steps, booster count, live bars (LEO/GTO/Lua/Marte, chance, cost/flight, dev cost/time), silhouette
  from the launch painter. Every change ≤ 2 taps; time does not pass; `query('designs/preview', draft)` is pure;
  `design/save`, `design/develop` are the actions.
- Eras 6–7 reuse the same model as a ship builder (`drive`, `habitat`, `shield`, `probeBus`; Δv table → "anos até o
  alvo"). AI in e5+ uses the same `designStats` via generators.

---

## 7. Mission vehicle choice (item 9 — **Phase A**)

1. Accepting any briefing/opportunity creates the mission in `planning` with **`vehicleId: null, spacecraftId: null`**
   and `suggestion: {vehicleId, spacecraftId, reason}` where reason ∈ `'Plano do programa'` (calendar hardware) |
   `'Mais barato que leva a carga'` (`pickConfig`). Type/destination/milestone/crew-lock of programs stay locked.
2. Awarded contracts: same (`vehicleId: null` + suggestion). The bid estimate keeps using `pickConfig` for the price
   (estimate only); choosing a pricier rocket later eats the margin.
3. Locked cases (vehicle is the object of the mission): crewed-certification demo (`certVehicleId`, today) and
   builder test flights (B).
4. `mission/schedule` refuses without hardware: **"Escolha o foguete e a nave antes de agendar."**
   `mission/update {vehicleId, spacecraftId}` recomputes cost/estimate and, for programs, the fuel-margin fit
   (moved from `calendarDraft` into the update path).
5. Briefing cards show the cost as a range over valid options: "US$ 120–310 mi conforme o foguete" (min/max of
   `draftOptions`); `grantShare` is a fraction so funding doesn't depend on the pick.
6. UI: the accept button reads **"Aceitar e escolher o veículo"**; the decision result returns
   `{openBuilder: missionId, step: 2}` and the UI navigates to `#missoes/m/<id>` at step 2 with the suggestion
   highlighted ("Sugestão dos engenheiros") and **nothing preselected** (remove the spacecraft preselect at
   `missions-tab.js` l.473; the flight-director preselect stays — it is crew, not hardware). Missions without
   hardware show an amber "falta o veículo" badge in the list and on the Painel.
7. AI and bots: `pickConfig` stays for AI and for the suggestion. `tools/smoke.mjs` / `tools/sim-campaign.mjs` dispatch
   `mission/update` with the suggestion after accepting.
8. Tests that assert auto-filled hardware are **old assumptions** and get updated (report them): expected in
   `missions.test.mjs`, `briefing-end.test.mjs`, `integrity.test.mjs`, `missions-window.test.mjs`, `crossfix.test.mjs`,
   `ui-fixes.test.mjs` (builder preselect).

---

## 8. Maps (Phase B, item 1)

- **Space map** (`map.js`): zoom levels system (today) → **sector** (real nearby stars: α Cen, Barnard, Wolf 359,
  Lalande 21185, Sirius, ε Eri, τ Ceti + generated planets; e6+) → **galaxy** (colonization nodes, e7). `bodies.json`
  gains `level`. Fog of war from `state.explored` (ids only), written via `explore()` in a tiny `src/sim/explore.js`.
  Colony routes (C). Era-styled skin.
- **World map** (`worldmap.js`): nation timeline from `nations.json` (USSR as the union of 15 ISO3 until 1991,
  Yugoslavia, Czechoslovakia; the two Germanys shown merged with a label — declared simplification, no second
  outline file) via `data/world-eras.json`; historical blocs tint (NATO / Warsaw Pact until 1991, then today's);
  HQs that are born/die with the lifecycle, with emblems; year slider for the Anais; "escolher sede" pick mode for the
  founding wizard. `world.json` does not grow.

---

## 9. Final event, year 3000 (Phase C content, Phase A stub)

- `src/sim/eco.js` owns `state.eco = {pieces: [{id, eraId, turn}], lean: {contato, silencio, heranca}, colegio: {rel}}`.
  One **Eco piece per era**, unlocked by milestones (e1: first radio-astronomy anomaly after a probe milestone; e2:
  deep-space probe telemetry glitch; e3: the pattern in archived data; e4: lunar far-side receiver; e5: the
  Colégio Silêncio is born (scripted actor, `actor-gen` `colegio_silencio`); e6: signal from beyond the heliopause;
  e7: the Silence intensifies in the final decade, 13-week steps). Player choices on each piece shift `lean`.
- Jan/3000 (`turn 54,600`): blocking `ending/final` with **all three** choices always available: **Contato**
  (responder), **Silêncio** (calar e seguir sozinho), **Herança** (deixar tudo preparado para quem vier depois). Each
  shows requirements met/unmet and an epilogue preview coloured by `lean`; unmet requirements change the epilogue
  tone, never hide the choice. Resolution → `gameOver {reason: 'ending', ending}` → `src/ui/ending.js` epilogue
  (legacy surnames, survivors, the agency's annals).
- If the player is gone before 3000 (fired, board, bankrupt), the world's ending is computed from `lean` (AI) and shown
  as a news epilogue.
- Phase A stub: engine built-in handler + `data/core/ending.json` with the three titles and one-paragraph pt-BR texts,
  so the headless campaign reaches a valid end.

---

## 10. Size, compaction, performance

- Every module that appends to a list implements `compact(state, data, ctx)` (called yearly and at era change).
  Binding caps:

| Slice (owner) | Cap / compaction |
|---|---|
| `news` (core) | 120 live; each year's top-3 headlines → `state.annals[year]` (≤ 90 chars each); after 100 years annals compress to decade top-5 |
| `log` (core) | 60 |
| `finance.ledger` (budget) | 120; `finance.years` 60 entries then decade means |
| `calendar` instances (calendar) | resolved > 3 years → removed (outcome lives in `vehicleStats`, annals, firsts); planned items instantiated lazily within a 10-year horizon |
| `contracts` (missions) | resolved removed after 52 weeks; cap 30 |
| `missions` (missions) | done/cancelled > 5 years → `missionsArchive` stub ≤ 80 B; stubs > 50 years → per-destination counters |
| `crew` (crew) | living ≤ ~60; retired removed after 2 years unless legend; `crew.legacy` surnames cap 80 |
| `memorial` (crew) | 300 full, then `{name, year, mission}` |
| `album` (narrative) | 150, drop commons first |
| `events.history` (narrative) | past-era entries pruned at era change (keep `once` flags) |
| `treaties` (diplomacy) | broken/expired > 10 years removed |
| `relations`/`tension` | live core actors only (≤ 13 → ≤ 78 pairs) |
| `lifecycle.tombstones` | 200 |
| `research` | unlocked ids of past eras → `research.eraDone[eraId] = n` + cached bonus totals |
| `vehicleStats` | retired > 20 years → `{flights, failures}` |
| `designs` (B) | 12 live |

- Budgets: tick median ≤ 4 ms, p99 ≤ 15 ms (Node desktop); mid phone tap (dispatch + render) ≤ 120 ms p95; full
  headless campaign 1950→3000 (3,670 turns, fast bot) ≤ 60 s; **save ≤ 400 KB raw at every year boundary**;
  ≤ 3 era packs in memory; boot data ≤ 1.2 MB raw.
- Pacing metric (bot): **stops per turn 0.15–0.35** (decision, briefing, launch, news importance ≥ 3), 25–60 turns
  between natural closes; failure if outside by > 20% of an era (Phase D enforces; Phase A only reports).
- Save slots: `adastra.saves.index`, `adastra.save.auto`, `adastra.save.slot1..3`, `adastra.save.era.<eraId>` (keep the
  last 2 era checkpoints). Autosave throttled to once per turn and after decisions. Modo Lenda (later) disables
  checkpoints.

---

## 11. Save migration

- `SAVE_VERSION = 2`. `src/core/migrate.js`: `migrate(raw, data) → state` or throws `SaveError {code, message}`.
  `engine.deserialize(json, data)` runs it.
- **v1 → v2** (all v1 saves are Corrida Lunar): `scenarioId ??= 'lunar_race'`; `clock = {eraId:'e4', stepWeeks:1,
  bandIdx: <b5>, steps: turn, eraStartTurn: 0, pendingEra: null, paceMult: 1}`; `eraHistory = []`;
  `lifecycle = {applied: {}, tombstones: {}, aliases: {}}`; `annals = {}`; `dataPacks = {}`. Phase B adds v2 → v3
  (`cap`, `mandates`, `designs`) and Phase A missions in `planning` keep their hardware (no retro-nulling).
  Modules' `ensureSlices` must tolerate missing optional slices (mandatory pattern).
- Rejections (store shows a card with "Começar de novo" and "Exportar o save"; raw JSON kept under
  `adastra.save.backup.v<N>`, never silently deleted):
  - newer version: **"Este save é de uma versão mais nova do Ad Astra. Atualize o jogo para continuar."**
  - unreadable / missing fields / migration exception: **"Não foi possível ler este save. Ele pode estar corrompido
    ou ser de uma versão antiga demais."**
  - unknown scenario: **"Este save usa um cenário que não existe nesta versão."**
- `adastra.save.v1` is read on first boot, migrated into `adastra.save.auto`, and deleted only after the v2 write
  succeeds. Export = local Blob download (no network).

---

## 12. UI navigation (item 8)

- **Shell (CSmanager `movel.css` / `responsivo.tsx` model)**: compact header (☰ hamburger · screen title · agency
  emblem · date chip `mar/1962`, `T3 2087`, `2741`) + ticker; **bottom bar with 4 destinations + centre disc = 5 equal
  slots**: Painel · Missões · ◉ tempo · Mapa · Mundo (`DISC_AT = 2`). Disc shows the step label (`time/stepLabel`).
- **Drawer** `.gaveta` from the left over `.veu` (tap closes, horizontal drag closes, `Esc` closes, Android back closes
  the drawer first, focus trap, `aria-expanded` on ☰, focus on the current item, amber "precisa de você" dots on items
  and on ☰). DESIGN.md §7 "Not ported: drawer" is revised to "ported".
- **Screen registry** `src/ui/screens.js` — `app.js` no longer has `TABS`, `SCREEN_TITLES`, `VIEW_PARENT`:
```js
registerScreen({ id: 'hangar', title: 'Hangar', icon: 'wrench', group: 'operacoes', order: 30,
  nav: 'bottom' | 'drawer' | 'hidden', parent: null,
  available: (state, data) => true,          // hidden from drawer/router when false
  badge: (state, store) => 0 | true | n,
  load: () => import('./hangar.js') });      // module exports render(container, store, route) -> cleanup?
```
  `screens.js` holds only descriptors (one line each). Adding a screen = 1 file + 1 `registerScreen` line. Routes stay
  `#<id>/<sub>`.
- **Screens and groups** (pt-BR titles; phase that delivers the screen):

| Group | Screen id → title | nav | Phase |
|---|---|---|---|
| — | `painel` Painel | bottom | exists |
| — | `missoes` Missões | bottom | exists |
| — | `mapa` Mapa espacial | bottom | exists (B upgrades) |
| — | `mundo` Mundo | bottom | exists (B upgrades) |
| Agência | `equipe` Equipe | drawer | exists (moves from bottom) |
| Agência | `conselho` Conselho (acionistas, mandatos) | drawer, available when `state.cap` | B |
| Agência | `identidade` Identidade e logo | drawer | B |
| Agência | `financas` Finanças | drawer | A (wraps the existing finance view if any, else stub list of ledger) |
| Operações | `pesquisa` Pesquisa | drawer | exists (moves from bottom) |
| Operações | `hangar` Hangar (construtor) | drawer, available from `unlocks.builder` | B |
| Operações | `lancamentos` Calendário de lançamentos (`.agenda-do-mes`) | drawer | B |
| Universo | `colonias` Colônias | drawer, e5+ | C |
| Mundo | `noticias` Notícias | drawer | A (existing feed) |
| Mundo | `diplomacia` Rivais e diplomacia | drawer | A (existing world sub-view) |
| Mundo | `tabela` Tabela da Era | drawer | A (existing) |
| Arquivo | `anais` Anais (linha do tempo de atores, eras, feitos) | drawer | A stub, C content |
| Arquivo | `memorial` Memorial, `album` Álbum | drawer | A (existing views if present) |
| Arquivo | `eco` Arquivo do Eco | drawer, when a piece exists | C |
| Sistema | `salvar` Salvar e capítulos | drawer | A |
| Sistema | `ajustes` Ajustes | drawer | exists |
| Sistema | `titulo` Sair para o título | drawer (action) | A |

- Title screen: **Campanha 1950–3000** · **Cenários** (from `data/scenarios/index.json` + Corrida Lunar) ·
  **Continuar** (slots). Era skin: `body[data-era="e1".."e7"]` token blocks (accent, texture, surface tone only;
  DESIGN.md system unchanged); Phase A ships the hook and e4 = current look.

---

## 13. Test plan

1. **Golden (first file written, before any refactor)**: `tools/golden.mjs` records
   `tests/fixtures/golden-lunar.json` = hash32 of the serialized **projection of the v1 top-level keys** at turns
   26/52/130/260 for 3 seeds × 5 playable actors with a scripted bot (the bot picks the suggested hardware explicitly,
   so the fixture is valid before and after item 9). After Phase A, dt = 1 must give identical hashes. Plus
   `tests/fixtures/save-v1-t120.json` (a real v1 save mid-transit) recorded now.
   *Note*: item 9 changes the player flow; the bot dispatches explicit choices, so hashes stay comparable. Any
   intended change regenerates the fixture with a written reason.
2. `tests/time-bands.test.mjs`: 3,670 turns 1950→3000, grid checks of §1.2, `turnToDate/dateToTurn` round-trip
   1950–3000, helper tables (`every/crossed/dueIn/cadence` at dt 1, 2, 4, 13, 26, 52), truncated steps, substepping.
3. **Rate equivalence**: per dt-native module, 2,000 seeds × 4 years at dt = 1 vs 13 vs 52: money exact, research and
   mean tension ±5%, event counts ±15%.
4. **Determinism**: same seed + actions → same hash with save/load at every era boundary, with lazy vs eager packs.
5. **Lifecycle**: 1950→2031 headless — every §3.3 row on its exact month (NASA 1958-10, ISRO 1969-08, ESA 1975-05,
   USSR split 1991-12, CNSA 1993-04, Blue Origin 2000-09, SpaceX 2002-03, JAXA 2003-10…); aliases resolve; no orphan
   relation keys; caps never exceeded; after 2031 (5 seeds) ≥ 1 procedural birth and ≥ 1 dissolution by 2200.
6. **Compaction**: every slice under its cap after a 200-year run; save ≤ 400 KB sampled yearly.
7. **Migration**: v1 fixture loads and plays 20 turns; garbage, version 99 and unknown scenario give the pt-BR messages.
8. **Data**: validator clean on all packs; `loadDataNode(root)` deep-equals today's data shape for legacy keys.
9. **Item 9**: accepting a briefing/opportunity/contract yields `vehicleId === null` and a `suggestion`; scheduling
   without hardware fails with the pt-BR message; certification demo stays locked.
10. **Headless campaign** `tools/campaign.mjs [seeds] [--fast] [--from e1] [--to e7] [--actor id]`: plays 1950→3000,
    save/load at each era, invariants (no NaN, no "erro" in log, caps, ending reached with one of 3 endings), prints per
    era: turns, ms/turn, save KB, live core/minor actors, births/merges/dissolutions, stops per turn. `npm test` runs a
    short variant (`tests/campaign-short.test.mjs`: 1950→1962 + 2595→3000, ≤ 10 s); the full run is
    `npm run test:campaign`.
11. **UI static**: every registered screen has pt-BR title, existing icon, resolvable `load` exporting `render`; drawer
    classes/aria/focus; 5-slot bar; step label for every stepWeeks; era scene has no "undefined/NaN"; no horizontal
    scroll at 320 px.

Existing tests: default scenario stays `lunar_race`, so most pass untouched. Allowed updates (report each as "old
single-scenario assumption"): `SAVE_VERSION === 1` checks, `ui-play-disc` (`DISC_AT`, 7 → 5 slots), tab-list
assertions in `ui-layout`, sw/sw-pwa file lists, and the item-9 list in §7.8.

---

## 14. Phases and file ownership

Rule: **one owner per file per phase**. Need a change in someone else's file → use the published API/hook, or write the
request in your report. ARCHITECTURE.md, PROGRESS.md and this file belong to the integrator.

### Phase A — 5 builders

Order: **core-time records the golden + v1 fixture first (before anyone edits `src`)** → core-time and data-pipeline
publish their APIs (stubs with final signatures within the first hour) → lifecycle, sim-agnostic, ui-shell in parallel
→ integrator.

#### A1 core-time
Owns: `src/core/time.js`, `src/core/engine.js`, `src/core/helpers.js`, `src/core/rng.js`, `src/core/migrate.js` (new),
`data/core/eras.json` (new: eras + bands of §1.2/§2.3), `data/core/ending.json` (new, stub texts),
`tools/golden.mjs` (new), `tools/campaign.mjs` (new), `package.json` (scripts), `tests/fixtures/golden-lunar.json`,
`tests/fixtures/save-v1-t120.json`, `tests/golden-lunar.test.mjs`, `tests/time-bands.test.mjs`,
`tests/engine-clock.test.mjs`, `tests/migrate.test.mjs`, `tests/campaign-short.test.mjs` (new).
Exposes:
- time.js: `WEEKS_PER_YEAR`, `turnToDate`, `dateToTurn`, `formatTurn*` (unchanged), `yearOf(state, turn?)`,
  `eraAt(data, year) → eraDef`, `bandAt(data, state, turn) → {stepWeeks, eraId, idx}`, `gridNext(data, state, turn)`,
  `stepLabel(weeks) → '+2 sem'|'+4 sem'|'+1 trimestre'|'+1 semestre'|'+1 ano'|'+1 sem'`,
  `formatTurnEra(turn, startYear, stepWeeks)`, `weeksToText` (decades/centuries).
- helpers.js: §1.4 helpers, `liveActors(state, {tier}?)`, `resolveActor(state, id)`, `actorInfo(state, id)`,
  `addNews` with annals hook; existing exports unchanged.
- engine.js: `MODULES` (adds `['lifecycle', lifecycle]` after politics), `SAVE_VERSION = 2`, `createState` (reads
  normalized scenario: `start/end/turnWeeks/ending`), `stepFor`, `tick` (§1.6), `advance(state,data,turns,opts)`,
  `isBlocked` (+`'era'`, `'needsData'`), `dispatch` (`time/advance {turns|weeks}`, `decision/resolve`), built-in
  handlers `era/transition`, `ending/final`, `query('time/stepLabel')`, `query('time/clock')`, ctx fields
  `{data, rng, date, dt, prevTurn, turn, eraId, year, hooks:{actorBorn, actorGone}}`, module contract
  `meta.maxDt`, hooks `onEraStart/onEraEnd/onYear/compact/onActorBorn/onActorGone/appointments`,
  `serialize`, `deserialize(json, data)` via migrate.
- migrate.js: `migrate(raw, data)`, `SaveError`, pt-BR messages of §11.

#### A2 lifecycle
Owns: `src/sim/lifecycle.js` (new), `data/core/lineages.json`, `data/core/lifecycle.json`, `data/core/nations.json`,
`data/core/actor-gen.json` (new), `data/eras/e1/snapshot.json` (new: 1950 start values for live lineages),
`tests/lifecycle.test.mjs` (new).
Exposes: module `{meta:{maxDt:52}, init, tick, onYear, compact, queries, actions}`; slice `state.lifecycle =
{applied:{[eventId]:turn}, aliases, tombstones, births: n, nextGenTurn}`; signals `actor/born|renamed|merged|gone`;
queries `lifecycle/timeline(fromYear,toYear)`, `lifecycle/identity(id, turn)`, `lifecycle/playable(scenario)`;
function `identityAt(data, id, turn, startYear)`; Phase B reserve: action `agency/found` (B1 takes ownership then).
Uses (does not edit): `diplomacy.addActor/retireActor`, `politics.ensureNation/retireNation`, `ctx.hooks`.

#### A3 sim-agnostic
Owns: `src/sim/budget.js`, `calendar.js`, `crew.js`, `diplomacy.js`, `launch.js`, `missions.js`, `narrative.js`,
`politics.js`, `research.js`, `risk.js`, `src/core/outcome.js`; `tools/smoke.mjs`, `tools/sim-*.mjs`; module tests
(`tests/{budget,calendar,calendar-ai,crew,crew-cert,crew-cert-fixes,diplomacy,diplomacy-blocs,geo-blocs,geopolitics,
launch,missions,missions-window,briefing-end,narrative,narrative-variety,politics,research,risk,solar,balance-rivals,
crossfix,datafix,integrity}.test.mjs`) and new `tests/dt-equivalence.test.mjs`, `tests/vehicle-choice.test.mjs`.
Delivers: §1.4 sweep (no `turn % N`, no `?? 2026`, no `/52` year math), `meta.maxDt` per §1.5, `compact` per §10,
`appointments` (missions), `onActorBorn/onActorGone` per module, `liveActors` everywhere, date-honouring of stamped
`fromYear/untilYear`, catalog accessor use, item 9 sim side (§7.1–7.5, 7.7, 7.8).
Exposes: `diplomacy.addActor(state, data, def, ctx)`, `diplomacy.retireActor(state, data, id, {into, reason}, ctx)`,
`politics.ensureNation(state, data, nationId, ctx)`, `politics.retireNation(state, data, nationId, {into}, ctx)`,
`missions` decision result `{openBuilder, step}`, query `missions/costRange(draft)`, mission field `suggestion`,
reserved `missions.createMandateMission` signature (B).

#### A4 data-pipeline
Owns: `src/core/data.js`, `src/core/packs.js` (new), `src/core/catalog.js` (new), `data/packs.json`,
`data/scenario.json` (read-only in A; normalized by packs.js), `data/scenarios/index.json`,
`data/scenarios/campaign.json`, `data/eras/e1..e7/era.json` (meta, chapters, palette names) and empty-valid pack files,
`data/core/schemas/**`, `tools/validate-data.mjs`, `tools/validate/**`, `sw.js` (precache list for new data paths),
`tests/data-packs.test.mjs`, `tests/data-validate.test.mjs`, `tests/sw.test.mjs`, `tests/sw-pwa.test.mjs`.
Exposes: `loadData(reader, {scenarioId='lunar_race', eras='auto'|'all'})`, `loadDataNode(root, opts?)`,
`browserReader`, `nodeReader`, `ensurePacks(data, reader, eraIds) → Promise<data>`, `packsNeeded(state, data)`,
`normalizeScenario(raw)`, `listScenarios(data)`, `data.packsLoaded`, catalog `vehicleDef/spacecraftDef/
vehicleAvailable/listVehicles`, validator CLI.

#### A5 ui-shell
Owns: everything under `src/ui/**` (`app.js`, new `screens.js`, `drawer.js`, `era-scene.js`, `css/shell.css`;
`store.js` (slots, rejection card, `ensureEra`, step label, `RUN_MAX_STEPS`), `newgame.js` (Campanha/Cenários/
Continuar), `components.js` (`fmtDate` without 2026 default), `missions-tab.js` + `decisions.js` + `dashboard.js`
(item 9 UI §7.6, era/chapter chip), map/worldmap/launch-scene only for `yearOf` fixes), `styles.css`, `index.html`,
`docs/DESIGN.md` (drawer section), tests `ui-fixes`, `ui-layout`, `ui-play-disc`, `launch-scene`, `launch-render`,
`map`, `techtree` (+ new `tests/ui-shell.test.mjs`).
Exposes: `registerScreen(desc)`, `screens()`, `navigate(id, sub)`, drawer `open/close`, `store.ensureEra(eraId)`,
`store.saveSlot(name)`, `store.loadSlot(name)`, era-scene overlay for `era/transition`, stub final card for
`ending/final`.

Phase A done when: all tests pass (± reported assumption updates); golden identical; validator clean;
`node tools/campaign.mjs 1 --fast` reaches jan/3000 with an ending, ≤ 60 s, save ≤ 400 KB; Corrida Lunar plays in the
browser with the new shell and item 9; `node tools/smoke.mjs 2` green.

### Phase B — 6 builders
| Builder | Owns |
|---|---|
| B1 agency-found + logos | `src/ui/found-agency.js`, `src/ui/emblem.js`, `src/ui/portrait.js` (wrapper), `data/core/emblem-parts.json`, `data/core/hq-sites.json`, `data/core/emblems.json` (specs per lineage identity, keyed by id to avoid editing lineages.json), `src/sim/lifecycle.js` (`agency/found` only; ownership transfers from A2), `newgame.js` founding branch |
| B2 investors | `src/sim/investors.js`, `data/core/investors.json`, `src/ui/board.js` (Conselho), `tests/investors.test.mjs`; migration v2→v3 entry in `migrate.js` via an exported `MIGRATIONS` table entry file `src/core/migrations/v3.js` |
| B3 rocket builder | `src/sim/designs.js`, `data/core/parts.json`, `design` fields in vehicles (`data/eras/e4/patches.json`), `src/ui/hangar.js`, `src/ui/launch-render/vehicles.js` (design adapter), `tests/designs.test.mjs` |
| B4 maps | `src/ui/map.js`, `map.css`, `worldmap.js`, `worldmap.css`, `src/sim/explore.js`, `data/world-eras.json`, `data/core/stars.json`, `bodies` patches |
| B5 missions | `src/sim/missions.js` (mandate source via B2's API, test flights for B3), `src/ui/missions-tab.js`, bots |
| B6 shell screens | `src/ui/screens.js` entries, `lancamentos`, `identidade`, `financas` screens, `styles.css` |

### Phase C — content of 7 eras + ending
C0 vocabulary steward first (`data/core/vocab.json`, freezes destination/milestone/type/kind/tech-tier/part-family
ids; later requests go to `data/eras/eN/vocab-requests.json`). C1…C7 one era each, exclusive owner of
`data/eras/eN/**`, `tests/pack-eN.test.mjs`, `src/ui/css/era-N.css`, and that era's scenario; C4 also splits
`legacy-e4` into `core/` + `eras/e4/`. C8 generators (`src/gen/**`, `data/gen/**`, `tools/gen-preview.mjs`: agencies,
vehicles, destinations, programs, events for e5+). C9 Eco and ending (`src/sim/eco.js`, `data/core/eco.json`,
`src/ui/ending.js`). C10 colonies (`src/sim/colonies.js`, `src/ui/colonies.js`, `data/core/colonies.json`). Each era
delivers actors/lifecycle rows with sources, vehicles/craft with `design`, destinations, calendar in the right truth
layer with `canon`, tech tier, ≥ 120 events with year triggers, news tone, investors, starting crew, snapshot, one
short scenario; validator clean.

#### C0 vocabulary (delivered)
Owns: `data/core/vocab.json`, `data/core/schemas/vocab.schema.json`, `data/core/schemas/vocab-requests.schema.json`,
`tools/validate/vocab.js` (+ its wiring in `tools/validate/rules.js` and `tools/validate-data.mjs`),
`tests/vocab.test.mjs`; created the empty `data/eras/eN/vocab-requests.json` (ownership passes to Cn with the folder).
- **What is frozen** (keys of `vocab.json`): `destinations` (Earth orbits and stations, Lagrange points, Moon sites,
  Sun/heliosphere, every planet, moons, asteroids, comets; `body`/`kind`/`era`/`label` per id) +
  `destinationFamilies` (interstellar ids derived from `data/core/stars.json`: `<star>_system`, `<exoplanet>_orbit`,
  `<exoplanet>_surface`, `region_<region>`; such destinations may use the star/exoplanet/region id as `body` without a
  `bodies.json` row), `bodies`, `milestones` (the "os primeiros" of all 7 eras with `era`, `kind` place|capability|
  colony|science, `scope: actor` for per-agency firsts), `missionTypes`, `spacecraftKinds`, `vehicleClasses`,
  `destinationKinds`, `eventKinds`, `eventGroups`, `eventTags`, `techBranches`, `techTiers` (`t1`…`t7`, one per era, with
  per-branch themes from the GDD; a node may carry `techTier` and must match its era), `partKinds`, `partFamilies`,
  `rocketTemplates`, `colonyStages` (`survey` 1 … `sovereign` 6 with outcomes `independent|allied`), `holderKinds`,
  `investorProfiles`, `investorArchetypes` (kind, profile, allowed eras), `ecoFragments` (≥ 1 per era, exactly one
  `main` per era, `order` within the era), `endings`, `scenarios` (ids of the per-era scenarios of §2.1).
- **Stability**: every id the data used at freeze time keeps its name and definition (`titan` keeps body `saturn`).
  New milestone ids: places are `<place>_<feat>` (`mars_flyby`), capabilities are `first_<feat>` (`first_eva`).
  `gen_` is reserved for runtime generators (C8) and refused in authored data. `status: "reserved"` = frozen id whose
  code/schema support does not exist yet (`colony`/`mining`/`interstellar` mission types, `eco`/`colony` event kinds,
  ship part kinds, interstellar craft kinds, `suborbital` destination kind): using it warns; the schema enum may still
  refuse it until the owning builder adds support.
- **Validator** (errors, pt-BR, `file#id.field` paths): ids of defined destinations/bodies/investor archetypes must be
  in the vocabulary and match its frozen `body`/`kind`/`kind+eras`; typed fields anywhere in any pack, scenario or
  `core/eco.json`/`core/colonies.json` (`milestone(s)`, `goals` (`id` or `id:actor`), `destination(s)`,
  `landerRequired`, `missionType(s)`, `ecoPiece(s)`/`ecoFragment(s)`, `colonyStage` (id or 1..6), `techTier`,
  `investorArchetype`, `ending`) must be known; also checked: calendar `type`, spacecraft `kind`, vehicle `class`,
  event `kind/group/tags`, `events.groups`/`events.milestones`/`milestoneLabels` keys, tech `branch` and `era` = pack era,
  part `kind/family`, `templates`, investor `profiles`/`anchors`, ending choices, scenario ids and `historicalFirsts`.
  `vocab.json` is a tool file (not in `packs.json`, not loaded by the game); in-memory validator input without `vocab`
  skips these checks.
- **Requests** `data/eras/eN/vocab-requests.json` = `{era, requests: [{id, category, entry, reason, status}]}`
  (`category` = a key above, `entry` = same shape as that category's entries, `status` pending|accepted|rejected).
  A `pending` request makes the id usable at once (warning "id provisório"); errors: requesting an id that is
  already frozen, two eras requesting the same id with different entries, `accepted` without the id in `vocab.json`.
  The integrator (or a C0 pass) moves pending ids into `vocab.json`, then deletes the request.

### Phase D — balance, review, publish
D1 balance per era with `tools/campaign.mjs` (20 seeds × playable actors: runway, mandates vs free slots per stake,
births per century, firsts pacing, stops per turn in target); D2 UX review of every registry screen at 390×844 and
320 px; D3 save-size/perf audit on a mid phone (4× throttle); D4 publish (remove legacy-e4 alias, per-era precache,
`APP_VERSION/SW_VERSION/BUILD`, PROGRESS.md, ARCHITECTURE.md).

---

## 15. Open questions for the user (defaults in force until answered)
1. Government's starting stake in real national agencies: **40%** (player autonomous). Alternative: 60% (no autonomy).
2. Private company founded before 1980: **blocked** (state agency always allowed).
3. History selector "Fiel / Divergente": **not offered**; past is faithful for rivals, divergent through the player.
4. Campaign length ~3,670 turns (~15–25 h) at Normal; a "Rápido" pace (`paceMult 2`) is a Phase D option.
5. Real agencies also get private-partner rounds from Era 3 (government ≥ 51%)? **Off** by default.
