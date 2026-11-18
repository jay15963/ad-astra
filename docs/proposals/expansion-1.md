# Ad Astra 1950–3000: expansion proposal #1 (simulation-first)

Author: architect #1. Status: proposal for Phase A (covers A–D). Scope: every item of the user's roadmap.
Angle: **a deterministic, cheap simulation that can run 1,051 years** (1950 → 3000) in a phone browser and in
a headless Node test, with bounded memory and save size. Content, UI and design come after and
plug into it.

Everything below respects ARCHITECTURE.md's rules: data → rules (src/core, src/sim; ctx.rng only; JSON
state; save/load identical) → UI (observes, dispatches). No build step, no runtime deps, pt-BR player text.

---

## 0. What the code assumes today (measured, nov/2026)

| Fact | Where | Consequence for 1950–3000 |
|---|---|---|
| `state.turn` = week index since `state.startYear`; `endTurn = years×52−1` | engine.createState, time.js | Keep this meaning (it is the internal clock). Only the step size changes. |
| One `tick` = exactly one week, `turn += 1` | engine.tick | Needs a variable step (`dt` weeks). |
| ~40 cadence checks `turn % 4/13/52 === k` | budget 350/362, calendar 812/881/1436/1450, crew 792/859, diplomacy 471/475/486, missions 2148, politics `isMonthStart` | Break as soon as a tick spans more than 1 week. Must go through one helper. |
| Fallback year `?? 2026` / `/ 52` year math | budget 38, crew 634, diplomacy 39, narrative 334, risk 466, components.fmtDate, map.js, launch-scene | Move to `time.js` (`yearOf(state)`), no literal years. |
| Static actor set (8 ids in actors.json); nations layer already exists (`politics.json nations` + `world.actorNation`) | diplomacy.init, politics | Nations persist across 1,051 years; agencies come and go. The nation layer is the anchor we need. |
| Auto-chosen hardware on briefings/opportunities/contracts (`pickConfig` cheapest valid) | missions.js 698, 957, 1183, 1326, 1491 | Roadmap item 9: becomes a suggestion, not a decision (Phase B). |
| Direct catalog lookups `data.index.vehicles[...]` | calendar 1, missions 3, dashboard 1, missions-tab 1 | Few: one accessor will make player-built rockets (item 7) cheap to add. |
| Cost: **2.3–2.7 ms/tick** with 8 actors (Node, desktop): calendar 0.98, diplomacy 0.64, missions 0.24, politics 0.19, rest < 0.11 | bench on seed 11/ESA | 54,652 weekly ticks would take about 2.5 min headless and far longer on a phone. A variable step is required. |
| Save after 5 years: **217 KB** (news 45, finance 26, world 22, calendar 22, contracts 20, missions 18) | bench | Without compaction, 1,051 years would mean tens of MB. Compaction is required. |
| Data load: 710 KB of JSON (vehicle-art 5.4k lines, events 7.7k lines) | loadData | Per-era packs, loaded ahead of time. |
| `SAVE_VERSION = 1`, deserialize throws on mismatch; key `adastra.save.v1` | engine, store | We need a migration chain plus a pt-BR rejection message. |

---

## 1. Time model

### 1.1 Internal clock
- **Internal unit stays the week.** One year = 52 weeks (current simplified calendar). `state.turn` keeps its
  meaning: **absolute week since the scenario epoch `state.startYear`**. All existing `launchTurn`, `readyTurn`,
  `expiresTurn`, `untilTurn` and similar fields stay valid. No mass rename, no unit change in saves.
- Campaign epoch = 1950, so `endTurn = (3000−1950+1)·52 − 1 = 54,651`.
- What changes is the **step**: each tick advances `dt` weeks, where `dt` comes from the active *time band*.
  `turnToDate/dateToTurn` stay as they are (years up to 3000 fit easily in doubles; weeks fit in int32).

### 1.2 Time bands (player turn length = sim tick length)
One player turn equals one sim tick. That keeps the engine simple: no hidden sub-turns, and the save
is always on the grid. Bands always start on a year boundary, and 52 is divisible by every step, so the grid
never drifts.

| Band | Years | Era | Turn = tick | Turns | Why |
|---|---|---|---|---|---|
| P | 1950–1956 | 1 (prologue) | 4 weeks | 91 | Before Sputnik nothing flies. This is the setup phase: rocket programs, the bureau race, the first budgets. |
| 1 | 1957–1975 | 1 A Corrida | 1 week | 988 | Weekly launches and firsts. The GDD says "semanas nos anos 50". |
| 2 | 1976–1999 | 2 Estações e Sondas | 2 weeks | 624 | Long programs, few firsts. |
| 3 | 2000–2025 | 3 Era Comercial | 2 weeks | 676 | High cadence, but mostly background (aggregate commercial flights). |
| 4 | 2026–2050 | 4 Década Lunar | 1 week | 1,300 | Same as the current Corrida Lunar (balance, tests, 260-turn scenario unchanged). |
| 5 | 2051–2199 | 5 Expansão | 13 weeks (quarter) | 596 | Transits last months to years; colonies grow over decades. |
| 6 | 2200–2599 | 6 Interplanetária/Interestelar | 26 weeks | 800 | Interstellar travel takes decades. |
| 7 | 2600–3000 | 7 Galáctica | 52 weeks (year) | 401 | The GDD says "anos no século 30". |
| **Total** | | | | **5,476 turns / ticks** | vs 54,652 weekly ticks: **10× fewer**. |

Turn-count justification: the Corrida Lunar is 260 turns and plays in 1–2 h with "Próximo evento". 5,476 turns
is about 21× that, roughly 25–45 h for the full campaign. That fits "Campanha: muitas horas", and the
heaviest eras (1 and 4) are also the ones with real history to play. With ~5.5k ticks at ≤ 8 ms, a full
headless campaign takes ≤ 45 s (see §10).

Data: `data/core/time.json`
```json
{ "epochNote": "...", "bands": [
  { "id": "p",  "era": 1, "fromYear": 1950, "turnWeeks": 4 },
  { "id": "b1", "era": 1, "fromYear": 1957, "turnWeeks": 1 },
  { "id": "b2", "era": 2, "fromYear": 1976, "turnWeeks": 2 },
  { "id": "b3", "era": 3, "fromYear": 2000, "turnWeeks": 2 },
  { "id": "b4", "era": 4, "fromYear": 2026, "turnWeeks": 1 },
  { "id": "b5", "era": 5, "fromYear": 2051, "turnWeeks": 13 },
  { "id": "b6", "era": 6, "fromYear": 2200, "turnWeeks": 26 },
  { "id": "b7", "era": 7, "fromYear": 2600, "turnWeeks": 52 } ],
  "eras": [ { "id": 1, "name": "A Corrida", "fromYear": 1950, "toYear": 1975, "truth": "fato" }, ... ] }
```
A scenario can override `turnWeeks` per band (e.g. a "quick" option, or a scenario that is weekly throughout).

### 1.3 New time API (src/core/time.js, pure)
```js
bandAt(data, year) -> band             // from data.time.bands (fallback: weekly, era from scenario)
eraAt(data, year) -> eraId
yearOf(state, turn = state.turn) -> number         // replaces every `startYear ?? 2026 + floor(turn/52)`
clockFor(state, data) -> { dt, bandId, era, year } // engine calls once per tick and stores in state.clock
snapTurn(state, data, turn) -> turn                // next turn on the grid (scheduling in coarse bands)
crossings(prev, next, period, phase = 0) -> n      // how many t ≡ phase (mod period) fall in [prev, next)
```

### 1.4 Rules for modules under a variable `dt` (the only hard refactor in Phase A)
`ctx` gains `dt`, `prevTurn`, `clock`. helpers.js gets:
- `every(ctx, periodWeeks, phase=0)` → number of crossings in `[prevTurn, turn)`. It replaces `turn % N === k`.
  It works the same at dt=1 (returns 0/1 exactly when the old check fired), so **Corrida Lunar behaviour
  stays bit-identical**. This is the regression test.
- `perTurn(weeklyAmount, ctx)` = `weeklyAmount × dt` (income, salaries, fixed costs, research progress, decay).
- `hazard(pPerWeek, ctx)` = `1 − (1 − p)^dt` (one draw per tick for "did it happen at least once").
- `decay(x, perWeekFactor, ctx)` = `x × f^dt` (pressure integrators, morale drift).
- Event processes that can fire more than once (diplomacy proposals, AI mission orders) use
  `min(every(...), cap)` draws. The rule is **at most one news-worthy event per actor per process per tick**,
  so a year-long tick in Era 7 doesn't flood the feed.

**Module granularity declaration and automatic substepping.** Each sim module exports
`meta = { id, eras: [1..7] | 'all', maxDt: 1|4|13|52, phase?: 'world'|'actors'|'player'|'story' }`.
If `ctx.dt > meta.maxDt`, the engine calls that module's `tick` `ceil(dt/maxDt)` times with a sub-ctx
(`turn` advanced inside the window, `ctx.rng` labelled with the substep index). This lets Phase A ship
safely: a module that isn't rewritten yet keeps `maxDt: 1` and stays correct, just slower. Then
we raise `maxDt` per module as it becomes dt-native:

| Module | Cost now | Phase A target maxDt | Note |
|---|---|---|---|
| calendar | 0.98 ms | 13 (native) | Heaviest. Revisions/AI ops via `every`. Background flights scale by dt. |
| diplomacy | 0.64 ms | 52 (native) | Monthly AI → `every(4)` with cap 1. O(n²) relations bounded by the actor cap. |
| politics | 0.19 ms | 52 (native) | `isMonthStart` → `every(4)`; integrators via `decay`. |
| missions | 0.24 ms | 1 → 4 | Substepping is cheap. Transit/arrival checks use `launchTurn ∈ [prev, turn)`. |
| budget | 0.11 ms | 52 (native) | `perTurn`; year close via `every(52)`. |
| research, crew, narrative | < 0.06 ms | 52 (native) | Trivial. |
| launch | ~0 | n/a | Scene-driven. |
| lifecycle (new) | — | 52 | Yearly births/merges, see §3. |

Worst case Era 7 (dt=52) with every module substepped at maxDt=1 is about 52 × 2.5 ms = 130 ms/tick, which
is what we have if nothing is optimised. With the targets above it is under 10 ms/tick.

### 1.5 Scheduling on a coarse grid
- `mission/schedule` snaps `launchTurn` with `snapTurn`. The launch decision fires on the tick whose window
  contains it. The scene happens "inside" the turn, and the UI shows the real date (week-level) of the launch.
- Transit times stay in weeks (data), and arrival fires on the tick containing `arriveTurn`. In Era 6–7 transits
  are measured in decades (`transitWeeks` up to ~5,000), which is fine.
- Decision expiry: `expiresTurn` compared with `>=` already works for any dt.
- `advance(weeks)` becomes `advance(turns)`. The UI's "1 turno" button sends `{turns: 1}`, and the store
  converts to weeks for display ("+1 trimestre"). `'time/advance' {weeks}` stays accepted for tools/tests
  (`weeks` → `ceil(weeks/dt)` turns).

---

## 2. Scenario / campaign model and era transitions

### 2.1 Scenario files
`data/scenarios/index.json` = list of `{id, file, name, subtitle, mode: 'campaign'|'scenario', order, hidden?}`.
Each scenario (`data/scenarios/<id>.json`):
```json
{ "id": "campaign", "name": "Campanha", "subtitle": "1950 a 3000", "mode": "campaign",
  "startYear": 1950, "endYear": 3000,
  "bandsOverride": null,
  "packs": "auto",                     // eras covered by [startYear, endYear] (+1 lookahead)
  "actors": { "source": "timeline" },  // who exists at startYear comes from data/core/agencies.json
  "snapshot": null,                    // optional state overrides at start (relations, treaties, firsts history, budgets)
  "playable": { "rule": "alive", "kinds": ["agency","company"], "minEra": { "company": 3 }, "custom": true },
  "historicalFirsts": {},              // nothing pre-1950 is "done"; the fact layer replays it
  "victory": { "type": "ending", "event": "eco/final" },
  "eraTrophies": true }
```
`lunar_race.json` = today's `data/scenario.json` plus `mode: 'scenario'`, `startYear 2026`, `endYear 2030`,
`snapshot: "snapshots/2026.json"` (the current actors.json relations/blocs/treaties/budgets, moved there unchanged),
`playable.rule: "list"` with the current 5 ids, `bandsOverride` weekly. **Corrida Lunar stays playable
unchanged.** Phase C adds era scenarios: `corrida_espacial` (1957–1975), `estacoes` (1976–1999),
`comercial` (2000–2025), `fronteira` (2051–2120), etc.

`createState` reads the scenario: `scenarioId`, `startYear`, `endTurn`, `clock`, `eraHistory: []`.
`loadDataNode(root)` keeps defaulting to `lunar_race`, so the 327 existing tests keep their world.

### 2.2 Era transitions
Engine-level, deterministic, data-driven:
1. In `tick`, after computing the new clock, if `clock.era !== state.clock.era`: emit signal `era/changed {from,to}`,
   call each module's optional `onEraChange(state, data, ctx, {from, to})` (tech tree unlocks, AI goals refresh,
   rules overrides, compaction pass), and push a **blocking** decision `era/transition` (choices: `continue`).
2. The UI opens the reflection scene for it: summary of the agency's era, the trophy from the Tabela da Era
   (`league/table` snapshot stored in `state.eraHistory[] = {era, turn, standings:[{id,prestige}], firsts:n,
   survivors:[crewIds], headline}`), who's left from the original team. Body `data-era` switches skin.
3. Per-era rule overrides: `data/eras/eN/rules.json` = `{ moduleId: { tunableKey: value } }`. Modules read
   tunables through `cfg(data, state, 'calendar', 'opsPeriod', DEFAULT)`, which merges core default ← era override
   ← scenario override. No `if (era === 5)` in code.
4. Trophies: the end of era closes the "Tabela da Era". Prestige carries over (legacy), and the table shows
   **per-era prestige** (`actor.prestigeEra`, reset at transition) plus lifetime.

### 2.3 The ending (year 3000)
- `scenario.victory = {type: 'ending', event: 'eco/final'}`. The eco module (Phase C) owns `state.eco`
  (pieces collected per era, `lean: {contact, silence, heritage}`, Colégio Silêncio relation).
- On the first tick of year 3000 the engine (via eco's `onYear`) pushes a blocking `eco/final` decision whose
  choices are **Contato / Silêncio / Herança** (always all three, with requirements shown and costs/epilogue
  previews coloured by `lean`). Resolving it sets `gameOver = {reason: 'ending', ending: 'contact'|'silence'|'heritage'}`,
  and the UI plays the epilogue. If the player is gone before 3000 (fired, dissolved), the ending is computed
  for the world (AI choice by `lean`) and shown as a news epilogue. Scenarios that end earlier use `reason: 'end'`.

---

## 3. Actor lifecycle (agencies born, renamed, merged, dissolved)

### 3.1 Principles
- **Nations are permanent; actors are not.** `politics` already has a nation layer (`usa, china, india, europe,
  russia, japan` + `world.actorNation`). It expands to a **nation timeline** (`data/core/nations.json`: `{id, name,
  from, to?, successor?, isos: [{iso, from, to?}]}`: `ussr` 1950–1991 → `russia` (+ `ukraine`, `kazakhstan`);
  `europe` as an economic/political bloc nation from 1957/1993; up to ~24 nations plus post-2050 speculative polities
  (Marte, Cinturão...) born by colonies). Elections/economy run per live nation.
- **Stable lineage ids.** An actor id is a *lineage*, and its display identity is time-varying. Renames never change
  the id, so relations, treaties, calendar owners, history, saves and tests keep working. The current 8 ids stay the
  lineage ids (`roscosmos` is the lineage that is called "OKB-1" in 1950).
- **Merges create a new lineage** only when the real successor is a genuinely new body (NASA, ESA, JAXA, ULA).
  Predecessors become tombstones with `successor`, and `state.actorAlias[old] = new` resolves any stale reference.
- **Dissolution** compacts the actor to a tombstone (§9). Relations/tension entries with it are deleted.

### 3.2 Data: `data/core/agencies.json` (real, 1950–2030) and `data/core/actor-gen.json` (procedural, 2031+)
```json
{ "lineages": [
  { "id": "roscosmos", "kind": "agency", "nation": [{"from":1950,"id":"ussr"},{"from":1992,"id":"russia"}],
    "born": {"year": 1950, "month": 1}, "truthLayer": "fato",
    "identity": [
      {"from": {"year":1950}, "name": "OKB-1 (URSS)", "short": "OKB-1", "emblem": {...}},
      {"from": {"year":1966}, "name": "TsKBEM (URSS)", "short": "TsKBEM"},
      {"from": {"year":1974}, "name": "NPO Energia (URSS)", "short": "Energia"},
      {"from": {"year":1992,"month":2}, "name": "Agência Espacial Russa", "short": "RKA"},
      {"from": {"year":2004,"month":3}, "name": "Roscosmos", "short": "Roscosmos"} ],
    "start": { "budget": 400, "support": 70, "culture": 40, "ai": {...}, "capabilities": {...} },
    "eraProfiles": { "1": {"ai": {"goals": ["first_satellite","first_crewed_orbit","crewed_lunar_landing"]}}, "4": {...} } },
  { "id": "nasa", "born": {"year":1958,"month":10}, "mergeOf": ["naca","us_army_abma"], "absorbLater": [{"id":"jpl","year":1958,"month":12}] , ... },
  ...
], "events": [ { "year": 1991, "month": 12, "kind": "nationSplit", "nation": "ussr", ... } ] }
```
Lifecycle kinds: `born`, `rename` (identity entry), `merge` (`mergeOf`), `absorb` (one into existing),
`split` (nation split moves the lineage to a successor nation + optional spin-off lineage, e.g. Yuzhnoye → Ukraine),
`dissolve` (`died: {year, month, successor?}`).

**Real dates to seed (1950–2030). The Phase C content team verifies each one and adds a source URL:**

| Date | Event | Lineage handling |
|---|---|---|
| 1950 | NACA (1915) exists; US Army/ABMA (1956-02), NRL Vanguard (1955) | `naca`, `us_army_abma` (from 1956), `nrl` (1955–1958) |
| 1950 | OKB-1 Korolev (NII-88 dept, independent 1956); OKB-586 Yangel (1954); OKB-52 Chelomei (1955) | `roscosmos` lineage = OKB-1; the other two are rival bureaus in Era 1 and merge back into the Soviet program by 1974 (NPO Energia) |
| 1956-10-08 | China: Fifth Academy (Ministry of National Defence) | `cnsa` lineage, name "Quinta Academia" |
| 1958-10-01 | NASA born (NACA absorbed; JPL Dec/1958; ABMA team Jul/1960) | merge → `nasa` |
| 1961-12-19 | CNES (France) | `cnes`; Diamant 1965 (third nation in orbit) |
| 1962-02 | INCOSPAR (India) → **ISRO 1969-08-15** | `isro` lineage, rename |
| 1964 | ESRO and ELDO (Europe) | `esro`, `eldo` |
| 1964-04 | ISAS (Tokyo, Itokawa; Pencil rocket 1955) | `isas` |
| 1969-10-01 | NASDA (Japan) | `nasda` |
| 1975-05-30 | **ESA** (ESRO + ELDO) | merge → `esa` |
| 1980-03-26 | Arianespace | `arianespace` (company) |
| 1982 | Orbital Sciences | `orbital` → merged into Northrop Grumman 2018 |
| 1983 | Israel Space Agency | `isa_il` |
| 1985 | UK BNSC → UK Space Agency 2010-04-01 | `uksa`, rename |
| 1988 | ASI (Italy) | `asi` |
| 1989-03-01 | CSA (Canada) | `csa` |
| 1989-10-10 | KARI (Korea) → KASA 2024-05-27 | `kasa`, rename |
| 1991-12-26 | USSR dissolves → Russian Space Agency 1992-02-25; SSAU (Ukraine) 1992 | nation split; `roscosmos` moves to `russia` |
| 1992-09-21 | China Manned Space (Project 921) | folded into `cnsa` as a program flag |
| 1993-04-22 | **CNSA** | rename of `cnsa` lineage |
| 1994-02-10 | AEB (Brazil) (INPE 1971) | `aeb` |
| 2000-09-08 | Blue Origin | `blueorigin` |
| 2002-03-14 | SpaceX | `spacex` |
| 2003-10-01 | **JAXA** (ISAS + NASDA + NAL) | merge → `jaxa` |
| 2004 | Rosaviakosmos → **Roscosmos** (state corp. 2015-12) | rename |
| 2004-02 | Iranian Space Agency | `isa_ir` |
| 2006-06 | Rocket Lab | `rocketlab` |
| 2006-12-01 | ULA (Boeing + Lockheed launch units) | `ula` (company, merge of two company stubs, or born) |
| 2014-07 | UAE Space Agency (MBRSC 2006/2015) | `uaesa` |
| 2014–2018 | Firefly, LandSpace, Relativity, iSpace (CN), Axiom (2016), Skyroot, Galactic Energy | companies, cap-limited (only those with gameplay weight) |
| 2018-07-01 | Australian Space Agency; 2018 Turkish TUA; 2018-12 Saudi Space Commission (SSA 2023) | `asa`, `tua`, `ssa` |
| 2021 | Vast | `vast` |

Only lineages with `playable: true` or `ai.weight >= threshold` are simulated as full actors. Minor ones are
**background actors** (`tier: 'minor'`: no relations matrix row, no research, no rivalOps, just the calendar owner
and flag on the map). This is the main performance lever (§10).

### 3.3 Procedural births after 2030 (`src/sim/lifecycle.js`, yearly via `every(52)`)
`data/core/actor-gen.json`:
```json
{ "caps": { "byEra": {"1":8,"2":10,"3":14,"4":16,"5":18,"6":18,"7":14}, "hard": 20, "minorHard": 24 },
  "archetypes": [
    { "id": "emerging_agency", "eras": [4,5], "kind": "agency", "weight": 1,
      "needs": { "nationWithoutAgency": true, "nationGrowth": ">0.02" },
      "names": ["Agência Espacial {gentilico}", "Instituto {gentilico} do Espaço"], "start": {...} },
    { "id": "megacorp_mining", "eras": [5,6], "kind": "company", "needs": { "flag": "asteroid_mining" }, ... },
    { "id": "consortium", "eras": [5,6,7], "kind": "consortium", "from": "merge", "needs": {"blocCohesion": ">80"} },
    { "id": "colony_gov", "eras": [5,6,7], "kind": "colony", "from": "colony", "needs": {"colonyStage": ">=5"} },
    { "id": "colegio_silencio", "eras": [5], "kind": "order", "scripted": "eco/piece2", "once": true } ],
  "successors": [ { "lineage": "*", "fromYear": 2051, "hazardPerYear": 0.01, "rename": "successorNames" } ],
  "dissolve": { "cashNegativeYears": 3, "prestigeBottomShare": 0.15, "hazardPerYear": 0.05 },
  "merge": { "trust": 80, "dependence": 60, "years": 10, "weakShare": 0.3 } }
```
Rules (all through `rngFor(seed, 'lifecycle', year, archetypeId)`):
- **Birth hazard** per archetype per year = `weight × f(world)` (nation growth, tension, colonies, Eco flags),
  rejected if the live cap is reached. The new actor's emblem is procedural from its id hash (§6).
- **Successor transformation** after 2050 (GDD: "os atores reais se transformam em sucessores"): rename with a
  speculative identity (`truthLayer: 'especulacao'`), never removing the lineage.
- **Merge**: two actors in the same bloc, trust/dependence over threshold for N years, one weak → consortium
  lineage (new id, `mergeOf`), assets summed (cash, prestige, research union, vehicles operator alias).
- **Dissolve**: insolvency for N years or bottom of the table under the cap. The tombstone keeps
  `{id, name, short, emblem, born, died, successor, prestigeTotal}` for the Tabela/Anais.
- Each change: news (`importance 3`), signal `actor/born|renamed|merged|dissolved {actorId, from?, into?}`,
  timeline entry on the world map.

### 3.4 Who owns what
- New module **`lifecycle`** (src/sim/lifecycle.js, `meta.phase: 'world'`, ticks right after politics). Owns
  `state.lifecycle = {applied: {[eventKey]: turn}, nextCheckTurn, tombstones: {[id]: Tomb}, aliases: {[old]: new}}`.
- `diplomacy` (owner of `actors/relations/blocs/treaties`) exports **`addActor(state, data, def, ctx)`** and
  **`retireActor(state, data, id, {successor, reason}, ctx)`**. Lifecycle calls only these. Other modules seed or clear
  their per-actor slices by reading the `actor/*` signals next tick, and they must already iterate
  **`liveActors(state)`** (helpers) instead of `Object.keys(state.actors)`.
- `helpers.resolveActor(state, id)` follows `aliases` (used by calendar owner/partners, vehicle operator/access,
  treaty parties when displayed).

### 3.5 The player's agency in the lifecycle
- **Real agency**: the player follows its lineage. A rename is an event card. A merge into a successor (NASDA →
  JAXA) moves `state.playerId` to the successor, with an event card "Sua agência agora é a JAXA" (crew, missions,
  research, cash carried over). A forced dissolution of the player's lineage is suppressed: the player's actor
  is exempt from hazard dissolution and only ends via `gameOver` (fired/ousted/bankrupt).
- **USSR 1991**: the lineage changes nation. The player sees a crisis card (budget collapse, which data controls).
- **Player-created agency** (Phase B, §5): a normal lineage with `custom: true`, `born: start`, id `pa_<hash32(seed,name)>`.

---

## 4. Player-owned agencies: investors and shareholding (roadmap item 6)

### 4.1 Model (new module `src/sim/investors.js`, Phase B, `meta.eras: 'all'`)
Slice `state.ownership` (exists only for the player's actor; AI actors stay abstract):
```
{ playerPct: 10..100,                 // the director's (player's) stake
  holders: [{ id, kind: 'government'|'fund'|'corporation'|'consortium'|'colony', name, pct, sinceTurn,
              mandate: { missionsPerYear, themes: ['leo_comms','lunar','science',...], minSuccess: 0..1 },
              satisfaction: 0..100, contractId }],
  round: null | { openTurn, closeTurn, offers: [Offer] },   // yearly window
  mandates: [ Mandate ],                                     // generated investor missions
  history: [{ year, playerPct, raised, delivered, failed }] (cap 60, then decade summaries) }
Offer   = { id, holderId, holderName, pct (1..30), cashM, mandate, termYears, votes: bool }
Mandate = { id, holderId, title, type, destination, deadlineTurn, rewardM, penalty: {pct?, cashM?, satisfaction},
            missionId: null|id, status: 'open'|'flying'|'done'|'failed'|'expired' }
```

### 4.2 Rules
- Hard limit: `sum(holders.pct) <= 90` so `playerPct >= 10`. Autonomy: `playerPct >= 50` lets the player
  veto/reschedule mandates (at a satisfaction cost). `< 50`: the board can force a mandate's deadline and vote out the
  director (`gameOver {reason: 'ousted'}`) when weighted satisfaction stays below a threshold for N years.
- **Program capacity** `K` (missions per year the agency can field: facilities + crew + era tunable). Mandated
  missions per year `M = round(K × (1 − playerPct/100)^0.75 × 1.15)`, clamped to `[0, K]`. Free slots `K − M`.
  At 90% investors: 10% stake, so M ≈ K and almost no own missions. At 50%: M ≈ 0.68 K. At 100%: M = 0.
  This is the exact behaviour the user asked for. Tunables live in `data/core/investors.json`.
- **Yearly round** (`every(52)`, phase = the agency's fiscal month): a non-blocking decision `investors/round` with
  2–4 offers drawn from investor archetypes of the era (government ministries in Era 1–2, funds/corporations from
  Era 3, colonies/consortia in Era 5+). Accepting an offer adds a holder, cash and that holder's mandate. A buy-back
  (`investors/buyback {holderId, pct}`) is allowed at a premium when the player is cash-rich.
- **Story missions become investor missions.** Calendar program items owned by the player's lineage
  (`status: 'player'`) are no longer "briefings from history". They are **mandates of the anchor holder**
  (`government` for agencies, `founders/fund` for real companies). The briefing card turns into an offer of a
  mandate. Deadline = the real date + slip. Delivering pays `rewardM` + satisfaction, and failing or abandoning costs
  satisfaction or pct (the holder takes a larger stake as a penalty). One rule covers real agencies, companies and
  custom agencies.
- **Starting stakes** (scenario/lineage data): real national agencies start with `government` at 49% (player 51%, so
  autonomy, but the government's program is mandatory), real companies founders 60%/funds 40%, custom agencies 100%
  with a small cash pile (they must sell shares to grow). The Corrida Lunar scenario uses the same rule with the
  current calendar items as the government's mandates (balance check in Phase D).
- AI actors do not get shareholding (performance + clarity). Their programs stay `calendar`/`rivalOps`.

### 4.3 Integration points
`missions.js` (owner) creates missions with `source: 'mandate'`, `mandateId`. `investors.onMissionResolved` is called
from `missions.onLaunchResolved` (one-line hook). Budget categories gain `investors` (capital in) and `dividends`.
UI: Agência › Acionistas screen (pie of stakes, offers, mandates with deadlines).

---

## 5. Player agency creation and logos (roadmap items 4–5)

- New-game flow (newgame.js → new screen `agency-create`): scenario → "Dirigir uma agência existente" (list of
  `playable` lineages alive at start) **or** "Fundar a sua". Founding asks: **name + short (≤ 6 letters)**,
  **country** (nations alive at startYear from `nations.json`, with an economic profile preview), **HQ** (cities from
  `geopolitics.hqs` + `data/core/hq-sites.json` per nation, each with a lat/lon and a launch site option:
  coastal/equatorial bonus), **kind** (agency or, from Era 3, company), **logo editor**.
- Action `'agency/create' {name, short, nationId, hqId, kind, emblem}` is valid only at turn 0 (before modules run
  per-actor init). Implementation: `newGame(data, {seed, playerId: 'custom', custom: {...}})` → lifecycle `addActor`
  with a template from `actor-gen.json archetypes.player_founded` (scaled by nation economy), and the
  `ownership` slice at 100%.
- **Emblem spec (data, JSON, renderable by one pure SVG function)**:
  `emblem = { shape: 'disc'|'shield'|'hex'|'roundel'|'wing'|'star', field: '#hex', field2?: '#hex',
  division: 'none'|'half'|'band'|'chevron'|'quarter', ring: { color, text?: 'AGÊNCIA ...' },
  glyph: 'rocket'|'orbit'|'star'|'planet'|'comet'|'capsule'|'atom'|'wreath'|..., glyphColor, stars: 0..12,
  label: 'ABC' }` (≤ ~200 bytes). `src/ui/emblem.js` exports `emblemSVG(spec, {size})` (replaces
  `portrait.emblemSVG`, keeping the old export as a wrapper). **No official logos**: real agencies get a
  designed "inspired" spec in `agencies.json` (colours/shape), never trademarks (settings.js already states this).
  Procedural actors get `emblemFromSeed(hash32(id))`. The editor is a sheet with chips per field and a live preview.
- The emblem is rendered everywhere actors appear (header, Tabela, map HQs, news). It is cached as a string per
  `(id, specHash, size)`.

---

## 6. Rocket construction (roadmap item 7)

### 6.1 Data model
`data/core/parts.json` (Phase B, extended per era in C):
```json
{ "engines": [ { "id": "rd107", "name": "RD-107", "era": 1, "from": {"year":1957}, "prop": "kerolox",
    "thrustKN": 1000, "ispSL": 256, "ispVac": 313, "massT": 1.2, "costM": 1.5, "reliability": 0.93,
    "techReq": null, "throttle": false, "restart": false, "crewSafe": true } ],
  "tanks": { "kerolox": { "densityT_m3": 1.0, "structFrac": {"1": 0.09, "3": 0.06, "5": 0.04} } , ... },
  "fairings": [...], "escape": [...], "boosters": "engines with role 'srb'",
  "deltaV": { "leo": 9.4, "gto": 11.9, "tli": 12.5, "mars": 13.3, "outer": 15.5, "losses": "kept in these numbers" },
  "rules": { "maxStages": 4, "maxEnginesPerStage": 30, "devWeeksPerNewEngine": 104, "devCostPerChangedStageM": ... } }
```
State, owned by new module **`designs`** (src/sim/designs.js):
```
state.designs = { [designId]: { id: 'd_<n>', name, owner: actorId, baseVehicleId: null|id, licensed: bool,
   stages: [{ engineId, engines: n, propT, tankTech, role: 'core'|'upper'|'booster', boosters?: n }],
   fairingId, escapeId?, reusable: bool,
   program: null|{ startedTurn, readyTurn, costM, paidM, phase: 'dev'|'test'|'ready' },
   derived: { capacity: {leo,gto,tli,mars,outer}, costM, reliabilityPrior, crewFeasible, heightM, diaM } } }
```
- `designStats(data, design, techCtx)` is **pure** (Tsiolkovsky per stage with thrust/weight check, staging and the
  era's structural fractions). `derived` is a cache recomputed on edit/load, so saves hold only the spec plus the cache.
- **Buy and edit**: `'design/license' {vehicleId}` (fee scales with vehicle cost and operator relation; bloc/embargo
  rules from `calendar.accessFor`). That gives a design with `baseVehicleId` and fixed stages read from the vehicle's new
  `design` field (Phase C fills `design` for catalog rockets; vehicles without it are "buy-only").
- **From scratch / derivative**: `'design/create' {spec}`, `'design/edit' {designId, patch}`, `'design/develop'`
  (starts a dev program: weeks/cost from the delta vs base; new engines take the longest). The first flights use the
  Beta prior from part reliabilities, so a new rocket is shaky until flown, which matches the existing reliability
  model (`vehicleStats` keyed by design id).
- **One accessor**: `calendar.vehicleDef(state, data, id)` (data.index.vehicles OR state.designs → vehicle-shaped
  object `{id, name, operator, capacity, costM, crewRated, cadencePerYear, availableFrom, truthLayer: 'jogador'}`).
  The 6 direct lookups found in §0 switch to it in Phase A (cheap, unblocks B).
- Art: launch-render's vehicle painter already draws from dimensions. Designs map stages → art segments
  (`heightM/diaM` from prop volume), and unknown ids already fall back to a family template.
- Caps: ≤ 12 active designs per player (archived designs → `{id, name, flights}` only).

---

## 7. Mission vehicle choice (roadmap item 9)

- `pickConfig` stays for the **AI and for the "Sugestão" chip only**. Briefing/opportunity/contract acceptance
  creates a mission in `planning` with `vehicleId: null, spacecraftId: null` (program items keep **locked**
  type/destination/crew, plus `suggested: {vehicleId, spacecraftId}`). If the program's real hardware exists, it is
  pre-*suggested*, not pre-selected.
- Cards show cost as a range: `"US$ 120–310 mi conforme o foguete"` (min/max over valid options, computed by the
  same `draftOptions`). Grants become a **share** (already `grantShare`), so nothing depends on the hardware pick.
- `mission/schedule` refuses without hardware ("Escolha o foguete e a nave antes de agendar."). Acceptance
  navigates to Missões › Montar step 2 (`store.ui.navigate('missoes', 'montar/<id>')`).
- Contracts (auctions) bid on price/deadline before hardware is chosen. The bid uses the player's estimate, and
  choosing a pricier rocket later eats the margin (a real trade-off).
- Tests that assert auto-filled `vehicleId` on accepted briefings are the *old assumption* and get updated
  (expected: missions.test, briefing-end, missions-window, crossfix). The builder sends the choices explicitly.

---

## 8. Data pack layout and loader

### 8.1 Layout
```
data/
  core/                       era-agnostic, always loaded
    time.json  nations.json  agencies.json  actor-gen.json  investors.json  parts.json
    destinations.json (base vocabulary; eras add more)  bodies.json  crew.json (names/traits/portrait)
    rules.json (default tunables per module)  emblem-parts.json  hq-sites.json
  eras/e1 … e7/               one pack per era; each file optional
    vehicles.json spacecraft.json calendar.json events.json tech.json politics.json geopolitics.json
    destinations.json (adds e.g. 'mars_colony', 'alpha_cen') rules.json news.json firsts.json
  scenarios/  index.json  campaign.json  lunar_race.json  snapshots/2026.json
  vehicle-art.json  world.json   (presentation, unchanged, lazy)
```
Phase A moves today's files unchanged into `eras/e4/` (and `core/` for crew/bodies/destinations). Era 1–3 packs start
**empty but valid**, so the campaign runs (procedural AI and lifecycle only) before Phase C content lands.

### 8.2 Loader (src/core/data.js)
```js
loadData(reader, { scenarioId = 'lunar_race', eras = 'auto' }) -> data
ensurePacks(data, reader, eraIds) -> Promise<data>   // idempotent, merges more eras
packsNeeded(state, data) -> eraIds                   // [eraAt(year)..eraAt(year)+1] ∪ eras of in-service items
```
- **Merge rule**: list files are concatenated by `id` (later era wins on duplicate id only for fields it sets; dupes
  are logged by `tools/validate-packs.mjs`). Each item gets `era` from its pack. `data.index` is rebuilt
  incrementally. Non-list keys merge shallowly by module (`data.calendar.rivalOps` etc.). `data.rules` merges
  core → era → scenario.
- **Determinism rule**: the set of packs visible to the sim at turn t is a **function of t only**:
  `eras ≤ eraAt(year(t)) + 1`. The engine asserts this before ticking (`advance` returns `stoppedBy: 'needsData'`
  if a pack is missing). The store then awaits `ensurePacks` and resumes. Node tools load all packs. Sim code must
  filter by dates (`availableFrom/Until`, `trigger.minYear`), never by "is it loaded".
- Lookahead: the store preloads era n+1 when entering era n (packs are ≤ 350 KB raw each). The SW precache crawl
  covers them (add the pack list to `data/scenarios/index.json` so the crawler finds them).
- Old flat `data/*.json` paths: the loader keeps a fallback map for one release so a stale SW cache doesn't break boot.

---

## 9. State compaction, memory caps and save size

Engine calls `compact(state, data, ctx)` on every module at **each year boundary** (`every(52)`) and at era change.
Core compacts shared slices. Targets: **save ≤ 400 KB JSON at any point of the campaign, median ≤ 250 KB**,
serialize ≤ 10 ms on desktop.

| Slice (owner) | Today | Cap / compaction |
|---|---|---|
| `news` (core) | cap 200 (45 KB) | 120 live items. Each year's top-3 headlines go to `state.annals[year] = [h1,h2,h3]` (strings ≤ 90 chars). After 100 years, annals compress to per-decade top-5. Max ≈ 30 KB. |
| `log` (core) | small | cap 60 |
| `finance` (budget) | ledger cap 300 | ledger cap 120 (current + last year). `finance.years: [{y, income, spent}]` 60 entries, then per-decade means |
| `calendar` instances (calendar) | 22 KB for 5 y | resolved instances older than 3 years → removed; outcome kept in `vehicleStats` + annals + `firsts`. Planned items enter the state only within a **10-year horizon** (lazy instantiation from data by year) |
| `contracts` (missions) | 20 KB | resolved contracts removed after 52 weeks; cap 30 |
| `missions` (missions) | 18 KB | `done/cancelled` older than 5 years → `missionsArchive` stub `{id,name,y,dest,type,outcome,prestige}` (≤ 80 B). Stubs older than 50 years → per-destination counters only |
| `crew` (crew) | 6.5 KB | living people ≤ ~60. Retired/left people removed after 2 years unless `legend`. Dead → memorial entry. **Legacy pool** `crew.legacy = [{surname, culture, role, legendScore, year}]` cap 80 (GDD's "netos" use it) |
| `memorial` (crew) | grows | full entries up to 300, then `{name, year, mission}` strings. `memorialCount` total |
| `album` (narrative) | grows | cap 150, keep by rarity, drop commons first |
| `events.history` (narrative) | per event id | entries for events of past eras pruned at era change (keep `once` flags in `flags`) |
| `treaties` (diplomacy) | 10 KB | broken/expired older than 10 years removed (a summary goes to annals) |
| `relations`/`tension` | O(n²) | only live, non-minor actors. ≤ 20 → ≤ 190 pairs |
| `actors` | 9.5 KB | live ≤ 20 full + ≤ 24 minor. Dead → `lifecycle.tombstones` (≤ 120 B each, cap 200) |
| `politics`/`world`/`geo` | 28 KB | existing HISTORY_CAPs. `geo.events` cap 80 → annals. Nations alive only |
| `research` | 4 KB | unlocked ids of past eras collapse into `research.eraDone[era] = n` plus effect totals cached in `bonus` (techBonus reads the cache) |
| `vehicleStats` | 5 KB | retired vehicles > 20 years → `{flights, failures}` only |
| `designs` (new) | — | ≤ 12 live designs |
| `colonies` (new, C) | — | ≤ 40 colonies. Population etc. as numbers, events in annals |
| `firsts` | small | permanent (≈ 200 milestones × 40 B) |

Rule for builders: **any list a module appends to needs a cap in its own `compact`.** A test enforces it by running a
200-year accelerated campaign and asserting the size of every slice (§11).

Multiple saves: the store moves to slots (`adastra.saves.index` + `adastra.save.<slot>`; 3 slots + autosave). At
≤ 400 KB × 4 this stays far below the ~5 MB localStorage quota. Autosave is throttled to once per turn (and after
decisions), skipping when nothing changed.

---

## 10. Performance budgets

| Budget | Target | How we hold it |
|---|---|---|
| Sim tick, desktop Node | median ≤ 4 ms, p99 ≤ 15 ms with 20 live actors | dt-native heavy modules, actor caps, minor actors outside the O(n²) loops |
| Sim tick, mid phone (≈ 4× slower) | ≤ 20 ms median | same. "Próximo evento" yields to the UI every turn (already does) |
| Full headless campaign 1950→3000 (5,476 ticks, fast bot, scenes auto-resolved) | ≤ 60 s Node (aim 30–45 s) | `tools/campaign-smoke.mjs --fast` |
| Era 7 tick (dt = 52) | ≤ 10 ms | modules at maxDt 52 except missions (substep 4) |
| Save size | ≤ 400 KB at every year, median ≤ 250 KB | §9 |
| serialize + localStorage write | ≤ 15 ms desktop | size cap, throttled autosave |
| Data on boot | ≤ 1.2 MB raw JSON (core + current era + next) | packs, lazy world.json / vehicle-art |
| Live JS heap of state | ≤ 3 MB | caps |
| UI render after an action | ≤ 16 ms per screen at 390×844 | unchanged (screen registry lazy-loads) |

`tools/era-bench.mjs` prints ms/tick per module per era plus save KB, and fails if a budget is exceeded by > 25%.

---

## 11. Testing strategy

1. **Bit-identical regression for Corrida Lunar**: before the refactor, record `hash32(serialize(state))` every
   26 turns for 3 seeds × 5 actors with a scripted bot (`tests/fixtures/lunar-race-hashes.json`). After Phase A the
   same seeds must give the same hashes (dt = 1, `every()` equals the old `%`). This is the strongest guarantee that the
   era-agnostic refactor changed nothing. Any intended change regenerates the fixture with a note.
2. **Time**: `tests/time-bands.test.mjs`: 5,476 ticks total, band starts on the grid, `dateToTurn/turnToDate`
   round-trip 1950–3000, `crossings()` table tests, `snapTurn`.
3. **dt equivalence (statistical)**: for each dt-native module, run 2,000 seeds of a 4-year window at dt = 1 and at
   dt = 13/52 and compare aggregate rates (income totals exact, hazard event counts within 3σ).
4. **Determinism across save/load and pack loading**: run campaign A straight through; run B with save → load at
   every era boundary and with packs loaded lazily (`ensurePacks` only when asked). Final state hashes are equal.
5. **Lifecycle**: real dates (NASA live exactly from oct/1958, ESA from mai/1975, JAXA from out/2003, OKB-1 →
   RKA nation switch in 1992), aliases resolve, the player follows a merge, caps never exceeded, no orphan
   relations/tension keys, tombstones present.
6. **Compaction**: every slice under its cap after a 200-year run; save ≤ 400 KB sampled yearly.
7. **Migration**: a committed v1 save fixture (Corrida Lunar, mid-launch scene and mid-transit) loads into v2
   and plays 20 turns. Garbage, a v0 save, or an unknown scenario give the pt-BR message (§13).
8. **Investors/builder/vehicle choice (B)**: mandate quotas vs playerPct table, 90% cap, ousting, design physics
   sanity (stock R-7 spec ≈ real LEO capacity ±15%), acceptance leaves hardware null.
9. **Headless full campaign** `tools/campaign-smoke.mjs [seeds] [--fast] [--actor=id|custom]`: plays 1950→3000,
   saves/loads at every era, checks invariants (no NaN in actors/finance, no "erro" log, caps, the ending reached with
   one of 3 endings). It prints per-era KPIs (ticks, ms/tick, save KB, live actors, births/merges/dissolutions, player
   missions, firsts). `npm test` runs a **short** variant (each era scenario × 5 years, ≤ 10 s total). The full run is
   `npm run test:long` (CI nightly / before publishing).
10. UI static/layout tests: the screen registry has every screen reachable in ≤ 2 taps (drawer counts as 1), no
    horizontal scroll at 320 px, drawer focus trap and Esc/back close.

Existing tests: the default scenario stays `lunar_race`, so most pass untouched. Expected updates (old
single-scenario assumptions, to be reported as such): tests importing `data/scenario.json` paths directly,
`SAVE_VERSION === 1` checks, `sw-pwa` file lists (new data paths), and in Phase B the auto-picked-hardware asserts.

---

## 12. UI navigation (roadmap item 8)

- **Shell** (CSmanager mobile layout, `movel.css` model): compact header (hamburger ☰ · screen title · date chip
  `mar/1962 · sem 3`, or `T2 2140` in coarse bands · agency emblem), **bottom bar with 4 tabs + centre disc**
  (Painel, Missões, ◉ tempo, Mapa, Mundo: the 5 most used). Everything else lives in the **drawer** (`.gaveta`
  sliding from the left over a `.veu` scrim, same easing tokens). DESIGN.md §"Not ported" is revised: the drawer is
  now ported.
- **Drawer groups** (pt-BR):
  - *Agência*: Painel, Equipe, Acionistas, Instalações, Identidade (logo)
  - *Operações*: Missões, Frota, Construtor de foguetes, Pesquisa
  - *Universo*: Mapa espacial, Colônias (Era 5+), Mapa-múndi, Diplomacia, Tabela da Era
  - *Arquivo*: Anais (linha do tempo 1950→hoje), Memorial, Álbum, O Eco (when unlocked)
  - *Jogo*: Salvar/Carregar, Ajustes, Sair para o título
- **Screen registry** `src/ui/screens.js` (owned by ui-shell; each screen in its own file, lazily imported):
```js
registerScreen({ id: 'acionistas', title: 'Acionistas', group: 'agencia', icon: 'pie', order: 30,
  load: () => import('./investors-screen.js'),           // module exports render(container, store, route)
  visible: (state, data) => !!state.ownership,           // era/feature gating
  badge: (state, store) => openMandates(state),           // drawer/tab dot
  tab: false, parent: null });
```
  `app.js` builds the tabbar, drawer, header titles, `VIEW_PARENT` and hash routing from the registry. Builders add
  screens **without editing app.js**. Hash routes stay `#<id>/<sub>`.
- Era skin: `body[data-era]` follows `state.clock.era`. Each era has a token override block in `styles.css`
  (Phase C/D). The era transition reflection scene is an overlay like the launch scene (`era-scene.js`).
- Time control in coarse bands: the disc's single tap = 1 turn ("+1 trimestre"), long-press = "Próximo evento"
  (it already stops on decisions/news). `RUN_MAX_WEEKS` becomes `RUN_MAX_TURNS` per band (26 turns).

---

## 13. Save migration

- `SAVE_VERSION = 2`. `src/core/migrate.js` exports `MIGRATIONS = {1: (s, data) => s2}` and
  `migrate(raw, data) → {state} | {error: 'pt-BR message'}`. `deserialize(json, data)` runs the chain.
- **v1 → v2** (all v1 saves are Corrida Lunar 2026–2030): set `scenarioId ||= 'lunar_race'`,
  `clock = {bandId: 'b4', dt: 1, era: 4}`, `eraHistory = []`, `lifecycle = {applied: {}, tombstones: {}, aliases: {}}`,
  `annals = {}`. `ownership` stays absent until Phase B (B's migration 2 → 3 adds the government holder from the
  scenario rule). Module `ensureSlices` already tolerate missing optional slices (this pattern stays mandatory).
- **Rejection**: unknown/newer version, unknown `scenarioId`, or a migration exception →
  *"Este jogo salvo é de uma versão antiga do Ad Astra e não pode ser aberto nesta versão. Comece uma nova campanha;
  o arquivo antigo foi guardado."* The raw JSON is kept under `adastra.save.backup.v<N>` (never silently deleted),
  and the title screen shows a "Baixar o save antigo" export (local Blob download, no network).
- Storage key moves from `adastra.save.v1` to the slot index. On first boot the old key is migrated into slot
  "autosave".

---

## 14. Which existing modules change, and how (Phase A unless noted)

| File | Change |
|---|---|
| core/time.js | bands, `yearOf`, `clockFor`, `snapTurn`, `crossings`, `eraAt`. Comment no longer says "Lunar Race" |
| core/engine.js | clock + `dt` in ctx. Module `meta` (eras gating, maxDt substepping). `onEraChange`, `compact`, `onYear` hooks. `advance(turns)`. `needsData` stop. `registerModule()` so B/C modules plug in without editing MODULES (order by `meta.phase`). Migrations via migrate.js. Ending handling |
| core/helpers.js | `every`, `perTurn`, `hazard`, `decay`, `liveActors`, `resolveActor`, `isMinor`. News → annals compaction |
| core/data.js | packs, scenarios, merge, incremental index, `ensurePacks`, rules merge, default scenario lunar_race |
| core/migrate.js (new) | migration chain + rejection messages |
| sim/budget.js | `perTurn` for income/costs/salaries, `every(52)` year close, `every(13)` payouts, ledger caps |
| sim/calendar.js | `every` everywhere. Lazy instantiation with a 10-year horizon. Compaction. `vehicleDef` accessor. Owners via `resolveActor`. maxDt 13. After 2050 (C) a **procedural program generator** (`data/eras/eN/programs.json` templates) replaces the authored calendar |
| sim/diplomacy.js | `addActor`/`retireActor`, `liveActors`, `every(4)` capped, maxDt 52, minor actors skipped |
| sim/politics.js | nation timeline (alive nations, splits), `isMonthStart` → `every(4)`, decay by dt, elections per era data |
| sim/research.js | era-gated nodes (field exists), rivals per live non-minor actor, `eraDone` compaction |
| sim/crew.js | aging via `every(52)`, generations and legacy pool, compaction |
| sim/missions.js | `every`, snap scheduling, archive compaction. **B**: vehicle choice (§7), mandates (§4) |
| sim/narrative.js | `{year}` via time.js, era filter in triggers (`minYear/maxYear` alongside minTurn), compaction |
| sim/risk.js, launch.js | `yearOf` instead of the 2026 fallback. Launch scheduling on the grid |
| sim/lifecycle.js (new) | §3 |
| sim/investors.js (new, B), designs.js (new, B), colonies.js + eco.js (new, C) | §4, §6, GDD colonization, Eco |
| ui/app.js | registry-driven shell, drawer, 4 tabs + disc |
| ui/screens.js, drawer.js, css/drawer.css (new) | registry + drawer |
| ui/newgame.js | scenario picker, "fundar agência" (B), save slots |
| ui/components.js | `fmtDate(turn, startYear)` without a 2026 default (reads state) |
| ui/map.js, worldmap.js (B) | sector/galaxy levels + fog (`state.explored`), nation timeline + year slider + HQ emblems |
| styles.css | per-era token blocks (C/D) |

---

## 15. Phases and file ownership for parallel builders

Rule: one owner per file per phase. Cross-file needs go through exported functions listed in the builder's brief.
ARCHITECTURE.md and PROGRESS.md belong to the integrator only.

### Phase A: foundation (this workflow)
| Builder | Owns | Delivers |
|---|---|---|
| A1 core-clock | src/core/time.js, src/core/engine.js, src/core/helpers.js, data/core/time.json, tests/time-bands, tests/engine-clock, tests/fixtures/lunar-race-hashes.json (recorded **first**, before any refactor) | bands, dt ctx, `every/perTurn/hazard/decay`, meta/substepping, era change + compaction hooks, `registerModule`, advance(turns) |
| A2 data-packs | src/core/data.js, data/** restructure (move files, empty e1–e3/e5–e7 packs, scenarios/index + campaign + lunar_race + snapshot 2026), tools/validate-packs.mjs, tests/data-packs, sw.js precache list | loader, merge, determinism assert support (`packsNeeded`) |
| A3 lifecycle | src/sim/lifecycle.js, data/core/agencies.json (§3.2 table), data/core/nations.json, data/core/actor-gen.json, tests/lifecycle; **diplomacy.js only for `addActor/retireActor/liveActors` use** (A4b reviews) | births/renames/merges/dissolutions 1950–2030 + procedural stub, aliases, tombstones |
| A4a sim-sweep-1 | budget.js, research.js, crew.js, narrative.js, risk.js, launch.js | `every`/`perTurn`/`yearOf` sweep, `compact`, `meta.maxDt` |
| A4b sim-sweep-2 | calendar.js, politics.js, diplomacy.js, missions.js | same + `vehicleDef` accessor, lazy calendar horizon, nation timeline in politics, `liveActors` in diplomacy |
| A5 ui-shell | src/ui/app.js, screens.js, drawer.js, css/drawer.css, styles.css (shell part), newgame.js (scenario picker + slots UI), components.js (fmtDate), docs/DESIGN.md (drawer section) | hamburger drawer, registry, 4 tabs + disc, era skin hook, era transition overlay stub |
| A6 save-tools | src/core/migrate.js, src/ui/store.js (slots, rejection, backup), tools/campaign-smoke.mjs, tools/era-bench.mjs, tests/save-migration (+ v1 fixtures), package.json scripts | migration v1→v2, pt-BR rejection, headless 1950→3000 run with KPIs |

Order: A1 records the hash fixture → A1/A2 land the APIs (half a day ahead) → A3/A4a/A4b/A5/A6 in parallel → integrator.
Done when: 327 tests (± reported assumption updates) + new ones pass, Corrida Lunar hashes identical, and
`campaign-smoke --fast 1` reaches year 3000 (no content, a living lifecycle) within the budgets.

### Phase B: player agency, investors, builder, maps, vehicle choice
| Builder | Owns |
|---|---|
| B1 agency-create | src/ui/agency-create.js, newgame.js (founding branch), lifecycle `agency/create` action, data/core/hq-sites.json |
| B2 emblems | src/ui/emblem.js, data/core/emblem-parts.json, emblem specs for every lineage in agencies.json (coordinate with A3's file through a dedicated `emblems.json` keyed by lineage, to avoid co-editing), portrait.js wrapper |
| B3 investors | src/sim/investors.js, data/core/investors.json, src/ui/investors-screen.js, tests/investors. Exposes `mandatesFor`, `onMissionResolved` |
| B4 rocket builder | src/sim/designs.js, data/core/parts.json, `design` fields for current vehicles (vehicles.json in e4: B4 owns during B), src/ui/builder-screen.js, launch-render/vehicles.js design adapter, tests/designs |
| B5 maps | src/ui/map.js (+sector/galaxy, fog), src/ui/worldmap.js (+year slider, nation timeline, emblems), map.css, worldmap.css, `state.explored` written by missions via an exported `explore()` in a tiny new `src/sim/explore.js` owned by B5 |
| B6 missions | src/sim/missions.js (vehicle choice §7 + mandate integration calling B3's API), src/ui/missions-tab.js, tests updated for auto-pick removal |

### Phase C: content of the 7 eras and the ending
One builder per era pack (`data/eras/eN/**` + era scenario file + era skin tokens in a per-era CSS file
`src/ui/css/era-N.css`): C1 1950–1975 (incl. bureau race, Sputnik/Gagarin/Apollo calendar, fact layer), C2 1976–1999,
C3 2000–2025, C4 2031–2050 (extend e4), C5 2051–2199 (+ colonies module `src/sim/colonies.js`), C6 2200–2599
(interstellar transit, sector map data), C7 2600–3000 (+ `src/sim/eco.js`, the Colégio Silêncio, `eco/final` and the
three epilogues, `src/ui/ending.js`). Shared vocabularies (firsts ids, destination ids) are reserved up front in
`data/core/vocabulary.json` by the integrator, so era builders don't collide.

### Phase D: balance, review, publish
D1 balance per era (`tools/era-bench`, `campaign-smoke` KPIs: money runway, mandates vs free slots per stake, births per
century, firsts pacing); D2 UX review at 390×844 / 320 px for every registry screen; D3 save-size and perf audit on a
real mid-range phone; D4 publish (APP_VERSION/SW_VERSION/BUILD bump, PROGRESS, ARCHITECTURE).

---

## 16. Risks and open questions
1. **Fact-layer replay vs player agency.** From 1957 to 2025 real programs must happen "on time" for the AI but can be
   beaten by the player. The proposal: real calendar items are AI-owned unless the player owns that lineage. Then they
   are mandates (§4) the player may fail. Confirm with the user that the past can diverge once the player plays it.
2. **Government stake for real agencies (49%)** is a design guess. It keeps autonomy while making history mandatory.
   This needs the user's view in Phase B.
3. **Turn lengths per band** are tunable data. If Era 4 at 1,300 weekly turns feels long inside a campaign, set its
   `turnWeeks` to 2 for the campaign only (`bandsOverride`) and keep weekly for the Corrida Lunar scenario.
4. **Content volume** (Phase C) is the real schedule risk. The sim must be fun with procedural programs and events
   alone, which is why A ships empty packs and B/C are additive.
5. Real agency names stay as historical reference without official logos (designed emblems only).
