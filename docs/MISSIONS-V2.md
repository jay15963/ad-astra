# Ad Astra: Missões v2, tech tree 1950–3000 and rocket market (contract)

Status: **binding spec** for the "Missões v2" phase (after v0.8.0, commit fd3d645). It answers the player's requests in
`docs/requests/missoes-v2.md` (9 items, numbered R1–R9 below). ARCHITECTURE.md and docs/EXPANSION.md still hold
everywhere: data → rules (`src/core`, `src/sim`: deterministic, `ctx.rng`/`rngFor` only, JSON state, save/load
identical) → UI (observes state, `store.dispatch`). No build step, no runtime deps, player text in pt-BR, design system
of docs/DESIGN.md at 390×844 and 320×640, budgets of EXPANSION §10, **no `git commit`**. Where this file and
EXPANSION.md disagree, this file wins for the topics it covers (amendments listed in §13).

| # | Player request | Section |
|---|---|---|
| R1 | "Pouso" → **Rover** (long-lived surface science); probe to a surface = landing | §1.1–1.3, §10 |
| R2 | Contracts only when they make sense | §2 |
| R3 | Stations module by module, from scratch or helping (treaty) | §3 |
| R4 | Satellite subtypes, observatories give science until end of life | §1.2, §3.6 |
| R5 | Cargo types incl. surface base modules and vehicles | §1.4, §3 |
| R6 | Stations and bases yield science, need maintenance cargo, degrade | §3.4–3.5 |
| R7 | Launch scene: docking / module release; surface delivery with the base behind, scaled, vehicles | §7 |
| R8 | BIG tech tree, unlock nodes coloured by kind + legend, player catalog gated by research | §4, §5, §6 |
| R9 | Rocket market: treaty-gated buying; AI asks to buy the player's rockets | §8 |
| — | Missions UI, vocab/validator, migration, tests, file ownership | §11, §9, §10, §12, §14 |

Measured baseline (v0.8.0, nov/2026): 176 tech nodes (45 legacy `data/tech.json` + 131 in `data/eras/e*/tech.json`);
none unlocks anything (effects only; 6 parts carry a `tech` field honoured by `designs.partAccess`). Mission types
`satellite probe crewed cargo station lander` (`lander` = "Pouso robótico", 72 calendar items use it). Contracts and
opportunities are code tables in `missions.js` (`CONTRACT_KINDS`, `OPPORTUNITIES`) filtered only by year. Stations
are fixed destinations (`iss`, `mir`, `salyut`, `skylab`, `tiangong`, `commercial_leo_station`, `lunar_gateway`,
`earth_orbital_habitat`); a "station" mission is a one-off with 8 weeks of ops. Vehicle access = `calendar.accessFor`
(`access` open/bloc/own, `embargo`, tension ≥ 3, `launchPolicy`, bloc OR any of 4 working treaties).
Pack sizes: always (core + legacy-e4) = 849 KB, biggest era e3 = 358 KB (budget per pack 350 KiB = 358,400 B:
**e3 has < 1 KB left**), boot = 1,207 KB of 1,258 KB. SAVE version 3. 679 tests.

---

## 0. Principles and global switches

1. **Unlock keys.** Everything the player can build/buy/fly is guarded by one or more *unlock keys*
   (`<kind>:<id>`, e.g. `vehicle:heavy`, `satellite:observatory`, `module:station.lab`, `missionType:rover`).
   Tech nodes grant keys (`node.unlocks`); catalog items, mission subtypes, payloads, modules and Hangar
   parts/templates *require* keys (data rules, §5.2). The key vocabulary is frozen in `vocab.json` (§9).
2. **Player vs AI.** Keys gate **only the player**, and only when `scenario.techGating === true`. AI rivals keep
   history/date rules (they "have" a key from its `keyYear`, §5.1). With `techGating` false (Corrida Lunar) the
   player uses the same date rule. One API (`gating.keyHeld`) serves all cases.
3. **Assets are the infrastructure.** Satellites, rovers, stations and surface bases that outlive their launch are
   *assets* in one slice (`state.assets`, §3). Bases that grow become colonies.js colonies; the asset stays as their
   physical body (modules, vehicles, renderer input).
4. **Data-driven.** New tables live in data (`data/core/missions.json`, `contracts.json`, `modules.json`,
   `stations.json`, `market.json`, `techtree.json`, `data/tech/eN/tech.json`); code keeps only fallbacks.
5. **Scenario switches** (in scenario files; normalized defaults in `packs.normalizeScenario`):
   `techGating` (campaign + 6 era scenarios: `true`; legacy `lunar_race`: `false`),
   `unlocks.market {fromYear}` (campaign 1962; era scenarios their start; lunar_race 2026),
   `techStart: 'historical'` (grant at new game, §5.5). Infra and the v2 mission taxonomy are active in every
   scenario (Corrida Lunar included).
6. **Golden.** v2 changes the Corrida Lunar on purpose (taxonomy, contracts, assets, treaty access). The golden
   fixture (`tests/fixtures/golden*.json`, `tools/golden.mjs --record`) is **re-recorded once, at integration, by
   the missions-sim owner**, with the reason "Missões v2 (MISSIONS-V2.md §0.6)" written in PROGRESS.md. Before that,
   each builder runs the golden only to check that divergence is limited to the slices it owns.

---

## 1. Mission taxonomy

### 1.1 Types (`missions.TYPES`, `vocab.missionTypes`, `calendar-mission.schema.json` enum)

| id | label (pt-BR) | creates | spacecraft kinds | destination kinds | key |
|---|---|---|---|---|---|
| `satellite` | Satélite | satellite asset (fleet) | satellite | orbit, station-orbit points (L1/L2) | `missionType:satellite` |
| `probe` | Sonda | — (ops period as today) | probe, lander, satellite | flyby, orbit, rendezvous, surface, atmosphere, interstellar | `missionType:probe` |
| `rover` | Rover | rover asset | rover | surface, atmosphere (rotorcraft) | `missionType:rover` |
| `crewed` | Tripulada | crew on a target asset (rotation) or ops | capsule, lander (crew > 0), habitat | any crew-capable | `missionType:crewed` |
| `cargo` | Carga | payload into a target asset (or a new base) | cargo, capsule, lander (carrier) | station, orbit (asset), surface | `missionType:cargo` |
| `station` | Estação | station module into a new or existing station | none (the module flies itself) | orbit kinds with `stationOk` | `missionType:station` |
| `colony`, `mining`, `interstellar` | (reserved, unchanged) | | | | |

- **`lander` is retired as a type** (R1). It stays in `vocab.missionTypes` with `status: 'legacy', aliasOf:
  {type: 'probe', sub: 'lander'}`. `missions.missionTypeOf(raw)` maps it everywhere: drafts, calendar items, AI
  programs, gen programs (`src/gen/programs.js`, `hardware.js`), saves (§10). Data files are rewritten by the
  missions-sim owner (`"type": "lander"` → `"type": "probe", "sub": "lander"`), but the alias stays forever.
- Labels on UI: `satellite: 'Satélite', probe: 'Sonda', rover: 'Rover', crewed: 'Tripulada', cargo: 'Carga',
  station: 'Estação'` (`components.TYPE_LABELS`, `missions.TYPE_LABELS`, `NAME_TYPE.rover = 'Rover'`).

### 1.2 Subtypes (`data/core/missions.json` → `subtypes`, vocab `missionSubtypes`)

Every draft has `sub` (string, required for satellite/probe/rover/crewed/cargo; derived for station). A subtype row:
```jsonc
{ "id": "observatory", "type": "satellite", "label": "Observatório espacial", "key": "satellite:observatory",
  "dest": {"kinds": ["orbit"], "ids": ["leo", "sun_earth_l2", "earth_moon_l2"]},   // optional narrowing
  "sc": {"kinds": ["satellite"], "match": {"sub": "observatory"}},                  // spacecraft filter
  "asset": {"kind": "satellite", "lifeYears": 20, "serviceable": true},
  "yield": {"scienceYr": 18, "supportYr": 0.4, "refT": 11},                         // §3.6 size factor
  "science": {"onArrival": 10},                                                      // one-shot, as SCIENCE_BASE
  "leadWeeks": 10, "opsWeeks": 0, "histYear": 1968 }
```
Binding list (ids frozen; `histYear` = year the earliest node granting `key` is historically anchored, §4.3):

| type | sub ids (label) |
|---|---|
| satellite | `science` (Científico, 1958) · `weather` (Meteorológico, 1960) · `navigation` (Navegação, 1960) · `comms` (Comunicações, 1962) · `earth_obs` (Observação da Terra, 1972) · `observatory` (Observatório espacial, 1968, Hubble-type) · `deep_observatory` (Observatório profundo em L2, 2021, JWST-type) · `relay` (Retransmissor lunar/planetário, 2018) · `constellation` (Megaconstelação, 2019) · `power` (Energia solar orbital, 2045) · `gravity_lens` (Telescópio de lente solar, 2200) · `interstellar_relay` (Retransmissor interestelar, 2350) · `power_swarm` (Segmento de enxame solar, 2650) |
| probe | `flyby` (Sobrevoo) · `orbiter` (Orbitador) · `impactor` (Impactador) · `lander` (Pouso de sonda, 1966) · `atmospheric` (Sonda atmosférica, 1967) · `sample_return` (Retorno de amostras, 1970) · `small_body` (Asteroides e cometas, 1996) · `interstellar_precursor` (Precursora interestelar, 2080) · `interstellar` (Sonda interestelar, 2250) · `beamed_sail` (Vela a laser, 2300) |
| rover | `light` (Rover leve, Lunokhod, 1970) · `micro` (Microrrover, Sojourner, 1997) · `medium` (Rover médio, MER, 2004) · `heavy` (Rover pesado, Curiosity, 2012) · `rotorcraft` (Helicóptero/aeronave, 2021) · `swarm` (Enxame de microrrovers, 2070) · `cryobot` (Criorrobô de gelo, 2120) · `submarine` (Submarino de mares alienígenas, 2150) |
| crewed | `orbital` (Voo orbital) · `rotation` (Rodízio de tripulação, needs a station/base target, 1971) · `flyby` · `landing` (Pouso tripulado) · `servicing` (Manutenção em órbita, 1984/1993) · `tourism` (Turismo espacial, 2001) |
| cargo | `supply` (Suprimentos/manutenção, 1978) · `experiments` (Experimentos/cargas científicas) · `base_module` (Módulo de base, needs surface) · `base_vehicle` (Veículo de superfície) · `propellant` (Propelente para depósito, 2035) · `servicing` (Kit de reparo de observatório, robotic, 2030) · `client` (Carga de cliente: contracts only) |
| station | derived: `found` (target = new station) · `expand` (target = existing station) |

Probe subtypes are **derived from the destination kind when not given** (surface → `lander`, atmosphere →
`atmospheric`, flyby → `flyby`, orbit → `orbiter`, rendezvous → `small_body`), so "Sonda + superfície lunar" is the
landing (R1). The UI still shows the chip so the player sees it.

### 1.3 What each type does on success (owner missions-sim, calls infra §3)

- `satellite` → science on arrival (as today) + `infra.deliver` creates/extends a satellite fleet asset (§3.6). No
  `ops` period (OPS_WEEKS 0 as today).
- `probe` → unchanged ops model (`OPS_WEEKS.probe`, `lander` sub uses today's lander values: science base 45, ops 6).
- `rover` → science on arrival (base 30 × body mult) + rover asset with `lifeYears` (sub table: light 1, micro 0.25,
  medium 3, heavy 10, rotorcraft 2, swarm 6, cryobot 5, submarine 4), yearly science (light 8, micro 4, medium 14,
  heavy 22, rotorcraft 10, swarm 25, cryobot 30, submarine 35; × body `scienceMult` × health). Milestones: existing
  `lunar_rover_robotic`, `mars_rover`, `mars_helicopter` fire from rover missions (dest/sub `firsts` in
  missions.json).
- `crewed` → today's flow; with a station/base target: `rotation` puts `seats` crew on the asset for
  `rotationWeeks` (26 default; data per asset kind) and the crew members stay busy (mission stays in `operations`
  until `ops.untilTurn = arrival + rotationWeeks`). `servicing` on a serviceable satellite asset: life +5 years,
  health 100.
- `cargo` → payload delivered into the target asset (`supply` tonnes, `experiments` science boost, `base_module`,
  `base_vehicle`, `propellant`, `servicing`); `client` = contract payload (today's clientPayload).
- `station` → the module joins the target station (new or existing).

### 1.4 Payload (draft and mission field `payload`)

```js
draft.payload = {
  kind: 'supply'|'experiments'|'station_module'|'base_module'|'base_vehicle'|'propellant'|'servicing'|'client'|null,
  moduleId: null,        // station_module / base_module: id in modules.json
  vehicleTypeId: null,   // base_vehicle: id in modules.json vehicles
  qty: 1,                // base_vehicle count (1..4), supply/propellant: tonnes are qty × 1 t
  targetAssetId: null,   // existing asset; null + newAsset → found a new station/base
  newAsset: false, newAssetName: null,                    // ≤ 32 chars, pt-BR default from modules.json names
}
```
Mass rules (validate): `payloadT` for the launcher = carrier mass (spacecraft `massT`, 0 for `station`) +
payload mass (`module.massT`, `vehicle.massT × qty`, `qty` tonnes for supply/propellant, 0.5 t servicing kit,
experiments 0.3–2 t from contract or `config.payloadT`). A carrier must hold the payload: spacecraft `cargoT`
(new optional field; default `round1(massT × 0.35)` for kind cargo/capsule, `massT × 0.25` for kind lander) ≥
payload mass, else error **"A {nave} leva no máximo {x} t de carga."** Surface payloads need a carrier of kind
`lander` (or `cargo` with surface in `destinations`); orbit payloads a carrier of kind `cargo|capsule`. The
missions-sim owner adds generic carriers to `data/spacecraft.json`/era packs with `access: 'generic'` and gates:
`generic_cargo_lander_s` (2 t, 2024), `_m` (8 t, 2030), `_l` (40 t, 2040), `_xl` (200 t, 2090),
`generic_cargo_ship` (orbit, 2008), `generic_heavy_cargo_ship` (2060), and generic rovers per sub
(`generic_rover_light/micro/medium/heavy/rotorcraft/swarm/cryobot/submarine`) so a player can fly every subtype
without a historical one-off.

`PRIVILEGED_DRAFT_KEYS` gains nothing: `sub` and `payload` are public, but `payload.kind === 'client'` is
privileged (contracts only).

### 1.5 Validation additions (missions.validate, pt-BR errors, binding texts)

| check | error |
|---|---|
| type/sub/payload key not held (`gating.missionGate`) | `Pesquise {nó} para liberar {rótulo}.` |
| sub not valid for type/destination | `{Sub} não serve para {destino}.` |
| `rotation`/`supply`/`expand`/`servicing` without target | `Escolha a estação ou base de destino.` |
| target not deliverable (`infra.canDeliver`) | its reason, e.g. `Precisa de uma parceria de estação com {ator}.` / `{Base} está abandonada.` |
| module/vehicle not available | `Pesquise {nó} para liberar o módulo {nome}.` |
| surface payload without lander carrier | `Carga na superfície precisa de um módulo de pouso de carga.` |
| production queue full (§8.4) | `Produção do {foguete} ocupada até {data}.` (error only when launchTurn < nextFreeTurn) |

`computeCost` adds the module/vehicle price (`module.costM`, `vehicle.costM × qty`, supply `supplyCostPerT ×
t` by era from missions.json) as line "Módulo {nome}" / "Veículos ({n})" / "Suprimentos ({t} t)".

---

## 2. Contract and opportunity gating (R2)

`CONTRACT_KINDS` and `OPPORTUNITIES` move to **`data/core/contracts.json`** (era packs may add rows in
`contracts.json` files of the same shape; core rows keep code constants only as fallback when the file is absent).
Row shape:
```jsonc
{ "kind": "station_supply", "type": "cargo", "sub": "supply", "payload": [1.5, 4], "weight": 3,
  "title": "Suprimentos para {asset}", "clients": ["{owner}"], "body": "…",
  "target": {"assetKind": "station", "owner": "other", "status": ["active", "degraded"], "supplyBelow": 0.6},
  "needs": {"fromYear": 1978, "untilYear": null, "firstsAny": [], "playerKeys": ["missionType:cargo", "missionType:docking"],
            "relation": {"minTrust": 10}, "noTensionAbove": 2},
  "deadline": [26, 52], "valueMult": [1.25, 1.6] }
```
Rules (`missions.contractEligible(state, data, row)` → `{ok, why}`; same for opportunities):
1. **Date**: `needs.fromYear ≤ year ≤ needs.untilYear`.
2. **Place reached**: every id in `needs.firstsAny` must have been achieved by *someone* (`state.firsts[id]` or
   `state.firstsHistory[id]`, new helper `helpers.achievedAny(state, id)`). Lunar cargo needs `lunar_surface_robotic`;
   Mars cargo `mars_landing_robotic`; GEO comms `first_geostationary_satellite`; constellation
   `first_megaconstellation`; tourism `first_space_tourist`; orbital refuel `first_orbital_refueling`.
3. **Something to supply**: rows with `target` are generated **per concrete asset** from `infra.listAssets` (owner
   ≠ player for `owner: 'other'`; `status`; `supplyBelow` = supplyT/storageT; `minModules`; `kind`). Destination =
   the asset's site, client = owner name, `targetAssetId` written into the contract. No asset → no contract
   ("carga para a Lua" cannot exist before someone has a base or a lander target there).
4. **Player can do the job**: the player holds all `needs.playerKeys` (keys of type/sub/payload are added
   automatically). Missing hardware (not research) keeps today's behaviour: offered with disabled bids and the reason.
5. **Relation**: for asset contracts the client's trust ≥ `minTrust` and tension ≤ `noTensionAbove`.
6. **Demand caps**: ≤ 2 open offers (today), ≤ 1 per asset per 26 weeks, asset owners generate supply demand only if
   their supply reserve < 60% (AI owners resupply themselves otherwise, §3.4).
Opportunities: same `needs`; `followUp` (NEXT_STEP) only proposes a destination when the follow-up row is eligible
(the next step of a lunar orbiter is a `probe/lander`, of a lander a `rover`, of a first station module an `expand`
or `supply`). `windowOpportunity`/`rivalOpportunity`/`customOpportunity` pick only eligible types (`lander` → probe).

Binding contract kinds (authored in contracts.json; numbers are starting values for Phase D):
`gto_comms` (1965, firstsAny first_geostationary_satellite) · `sso_obs` (1972, first_weather_satellite) ·
`leo_constellation` (2019, first_megaconstellation) · `station_supply` (asset station other) · `station_crew`
(crewed/rotation, asset station other, playerKeys crewed + docking) · `station_module_assist` (station/expand,
asset station other with `plannedModules > modules`, needs treaty §3.3 or the contract itself) ·
`commercial_station_cargo` (2028, asset station kind commercial) · `lunar_delivery` (cargo/experiments,
lunar_surface, firstsAny lunar_surface_robotic) · `base_supply` (asset base other) · `base_module_assist` ·
`mars_delivery` (2035, mars_landing_robotic) · `observatory_servicing` (asset satellite sub observatory other,
life < 30%) · `orbital_tourism` (crewed/tourism, 2001, first_space_tourist) · `propellant_depot` (2035,
first_orbital_refueling, asset station with module depot). The old `clps` becomes `lunar_delivery`
(type cargo/experiments, carrier lander).

### 2.1 The tender board (tela Contratos, v0.9.12)

Contracts are no longer pushed as `contract/offer` cards: clients publish **tenders** on a public board (drawer ›
Operações › Contratos, also Missões › Contratos). Numbers live in `contracts.json` `board` (defaults in
`missions.BOARD_DEFAULTS`); slice `state.tenders = {next, record: {actorId: {won, ok, bad}}}`.

- **Supply**: a new tender every `gapWeeks` 3–7 weeks (3 at once on a new board) while fewer than `openMax` 5 are open;
  bidding stays open `bidWeeks` 10–24 weeks and never closes before the player's next stop. Candidates follow §2 rules
  1–3 in the *world's* view (`contractEligible(…, {world: true})`: no player research or relation check — the card shows
  them instead) plus colony clients (`colony: true` rows, one per settled colony of another owner, era 5+). Era rows:
  sounding experiments (1950–1990, probe `sounding`, suborbital), science/weather/navigation satellites (1958/1961/1964),
  GTO comms (1965), SSO (1972), foreign science probes (1985), constellations (2019), station/base/lunar/Mars jobs (§2),
  solar power modules (2045), outer-planet probes (2060), colony equipment (2051), interstellar probes (2250).
- **Size and feasibility**: a size (small/medium/large, weights 3/2/1) picks the payload inside the row's range; client
  payloads are capped by the biggest rocket in the world at that date. A tender exists only if some live agency (the
  player included) can fly it now (`pickConfig` per actor); otherwise smaller sizes are tried, then another row.
- **Price**: `costM` = mean cost of flying it over the capable agencies (rocket + craft + operations + goods + crew), never
  below the open market (`marketCost`); reference `valueM = costM × U(1.8, 2.2)`. Bids are 60–140% of the reference, so
  even the lowest bid pays ≥ 1.08× the typical cost. The bid sheet shows the player's own probable cost with the rocket
  chosen (`computeCost`) and the margin; a rocket that costs more than 60% of the reference gets an amber warning.
- **Rivals**: every capable agency (not the client) may bid (first always; others with p = 0.6 + 0.35·need); price =
  own cost × (1.45 + 0.45·(1 − need) − 0.2·aggression) × U(0.95, 1.05), clamped to the range; need = 1 − cash/(budget/2).
- **Chance**: score = 60·(ref/price) + 0.35·reputation + 40·(reliability − 0.8) + clamp(2·(delivered − 2·failed), −12, 10);
  P(win) = softmax(score / 10) over the bidders. The board shows the live chance for any price and rocket
  (`contracts/odds`), the competitor count and the favourite; at the close one winner is drawn with exactly those odds
  (`rngFor(seed, 'tenders', 'award', id)`). Rival prices stay sealed until the close.
- **Feasibility** (`tenderFeasibility`, "Você consegue entregar?"): red for missing research (the mission's own gate),
  a client that does not trust the agency, no rocket/craft that carries it ("Nenhum foguete seu leva 3 t à órbita de
  transferência (o maior leva 1,2 t); pesquise X ou contrate um lançador (Y, de Z)"), no time before the deadline, or a
  binding investors' agenda with no own slot left; amber for a shaky rocket (< 85%), a cost above 60% of the reference,
  a tight deadline or short cash. Red tenders take no bids.
- **Award**: 30% on signing, the rest on delivery; the mission is created without hardware (item 9), the rocket of the
  bid suggested (`Foguete da proposta`). A contract counts as one own mission of the year for the investors' agenda.
  Late launch: −30% pay; no launch 13 weeks (× step scale) after the deadline: default, fine 25% of the price, −8
  reputation. A failed launch with ≥ 6 weeks to the deadline gets one more attempt (new mission, −2 reputation); a
  second failure, or one with no time left, fails the contract: fine 25%, −5 reputation. Deadlines scale with long steps
  (× stepWeeks/4, max 6) and always fit the next launch window of the destination.
- **Rivals fly theirs** off-screen: delivery at 30–85% of the time to the deadline, one roll on the bid rocket's
  reliability; success pays the rest, failure costs the fine and −4 reputation; both update the record and make news
  (successes only for large jobs or tenders the player bid on).
- **Old saves**: pending `contract/offer` cards are removed on the first tick (a stale card still resolves as a bid at
  85/100/115% of the reference); their contracts stay on the board as tenders.

---

## 3. Infrastructure: assets (R3, R5, R6)

Owner: **infrastructure-sim** (`src/sim/infra.js`, new; registered in `engine.MODULES` right after `missions`).
`meta.maxDt = 13` (continuous parts dt-native via `perStep`/`decay`; quarterly events at `every(ctx, 13)`).

### 3.1 Slice
```js
state.assets = { seq: 0, list: [Asset], past: [{name, kind, ownerId, year, cause}] /* cap 30 */, notified: {} }
Asset = {
  id: 'as_<n>', kind: 'station'|'base'|'satellite'|'rover', sub: null|<satellite/rover sub>,
  name, ownerId, partners: [{actorId, massT, crewWeeks}],      // contributions (shares, §3.3)
  site: <destination id>,  bodyId, histId: null|<stations.json id>,
  foundedTurn, status: 'active'|'degraded'|'derelict'|'ended',
  modules: [{id, n, addedTurn, by}],          // station/base: module type ids from modules.json, grouped
  vehicles: [{id, n, by}],                    // base only: surface vehicle ids
  units: [{endTurn, n}],                      // satellite fleets (cap 12 rows, merged by endTurn bucket of 26 wks)
  lifeEndTurn: null|number,                   // rover / single satellite
  health: 0..100, supplyT, crew: {n, untilTurn, missionId},
  colonyId: null, stageN: 0, sizeTier: 0,     // base ↔ colonies.js (§3.7), cached
  sciYr: 0, lastNotice: null, derelictTurn: null }
```
Deterministic ids (`nextId(state,'as')`), JSON only. Caps: player live assets ≤ 60 (satellites merged into fleets per
`(ownerId, sub, site)`), AI live assets ≤ 40 (only stations and bases), `past` 30. `compact`: ended assets are removed
after 5 years (their name goes to `past` and annals).

### 3.2 Modules, vehicles (`data/core/modules.json`, owner infrastructure-sim)
```jsonc
{ "tuning": { /* §3.4 numbers */ },
  "station": [{ "id": "st_lab", "label": "Laboratório", "key": "module:station.lab", "histYear": 1973,
     "massT": 15, "costM": 900, "power": -1, "life": 0, "ports": 1, "crew": 0, "storageT": 2, "upkeepTYr": 2,
     "science": 8, "crewNeed": 2, "lifeYears": 25, "traits": [] }],
  "base": [ … same fields + "isruTYr", "food", "housing", "infraNeed": "vida"|"energia"|"alimento"|"moradia" … ],
  "vehicles": [{ "id": "vh_lrv", "label": "Jipe lunar", "key": "rover:vh_lrv", "histYear": 1971, "massT": 0.5,
     "costM": 40, "science": 3, "unload": 0, "bodies": ["moon"] }],
  "names": {"station": ["Aurora", "Horizonte", …], "base": ["Base {place}", "Posto {place}", …]},
  "stageRules": { /* §3.7 */ } }
```
Binding ids (labels pt-BR; histYear for the key):
- **Station**: `st_core` Núcleo (1971: power 2, life 3, ports 2, crew 3, storage 4 t, science 2) · `st_lab`
  Laboratório (1973) · `st_multiport` Núcleo de duas portas (1977, ports +2: enables resupply while crewed) ·
  `st_hab` Habitação (1986, crew +3) · `st_node` Nó de conexão (1998, ports +4) · `st_solar` Treliça solar (2000,
  power +4) · `st_airlock` Câmara de ar (2001, trait `eva`: health decay −30%) · `st_arm` Braço robótico (2001,
  trait `arm`: berthing visual, docking risk −10%) · `st_logistics` Módulo logístico (2011, storage +12 t) ·
  `st_cupola` Cúpula (2010, science +1, support) · `st_inflatable` Módulo inflável (2016, crew +2, light) ·
  `st_depot` Depósito de propelente (2035, trait `depot`: +5% payload for missions departing that orbit) ·
  `st_centrifuge` Centrífuga (2070, crew +4, life +3, trait `gravity`) · `st_shipyard` Estaleiro orbital (2110,
  trait `shipyard`: −10% cost for ships launched from that orbit, milestone `first_orbital_shipyard`) · `st_ring`
  Anel habitacional (2250, crew +200, milestone `first_rotating_habitat`) · `st_cylinder` Segmento de cilindro
  O'Neill (2650, crew +5000).
- **Base**: `bs_hab_small` Habitat compacto (2028; alt-history from fromYear) · `bs_solar` Painéis solares (2028)
  · `bs_comms` Torre de comunicação (2030) · `bs_lab` Laboratório de superfície (2030) · `bs_fission` Reator de
  fissão compacto (2032, milestone `first_fission_surface_power`) · `bs_isru` Usina de oxigênio do regolito (2033,
  isruTYr 6) · `bs_pad` Área de pouso (2034, landing risk −10% at that site, renderer pad) · `bs_garage` Garagem e
  oficina (2036, vehicles health) · `bs_hab_large` Habitat enterrado (2038) · `bs_greenhouse` Estufa (2040, food,
  isruTYr 3) · `bs_dome` Cúpula pressurizada (2060) · `bs_factory` Fábrica de regolito (2070) · `bs_mass_driver`
  Lançador eletromagnético (2090) · `bs_arcology` Arcologia (2250) · `bs_megastructure` Estrutura colossal (2600).
- **Surface vehicles** (`key` kind `rover`): `vh_lrv` Jipe não pressurizado (1971) · `vh_drone` Drone de
  reconhecimento (2030, atmosphere bodies) · `vh_crane` Guindaste de descarga (2034, unload) · `vh_excavator`
  Escavadeira de regolito (2035, isru +2) · `vh_pressurized` Jipe pressurizado (2032) · `vh_truck` Caminhão de carga
  (2036, unload) · `vh_hopper` Saltador (2045) · `vh_crawler` Rastejador gigante (2200).
Validator (techtree-data implements, §9): every module is deliverable at `histYear + 5` by ≥ 1 vehicle in the
catalog (`capacity` to its typical site ≥ massT + carrier); every `key` is granted by ≥ 1 node.

### 3.3 Ownership, shares and treaties
- A new station/base belongs to the mission's actor. `partners[]` records delivered mass and crew-weeks per actor.
  **Share** of an actor = `(massT + crewWeeks × 0.05) / Σ` over owner + partners. Science, prestige and upkeep cost
  of the asset are split by share.
- `infra.canDeliver(state, data, actorId, assetId)` → `{ok, reason}`: own asset ok; another actor's asset needs an
  **active treaty** between the two of type `station_partnership` (new, §8.2, terms `{assetId}`), or
  `mission_partnership`/`cost_sharing`/`crew_exchange`, **or** an awarded contract naming the asset; tension ≥ 3
  blocks; derelict/ended assets block (`'{nome} está abandonada.'`), except `servicing`/`supply` rescue of a
  derelict own asset.
- Historical stations (`data/core/stations.json`, owner infrastructure-sim) become AI assets **by date**, built by
  `ensure` deterministically from data: `{id: 'iss', destination: 'iss', owner: 'nasa', partners: ['roscosmos',
  'esa','jaxa','csa'], name, from, until, modules: [{id: 'st_core', at: {year:1998,month:11}}, …], plannedModules,
  crew: 6, reentry: {year:2030,month:12}}` (Salyut 1971, Skylab 1973, Mir 1986, ISS 1998, Tiangong 2021, commercial
  2029, Gateway 2036, orbital habitat e5). The asset's module list grows on the listed dates; it ends at `until`
  (deorbit news) unless the player has a share ≥ 25% and keeps supplying, which extends `until` by 5 years per year
  supplied (alt history). The destination row gets `assetHist: '<id>'`; missions to `iss` target that asset.
- AI bases: when an AI calendar item (or rival ops) succeeds with milestone `lunar_base`, `mars_outpost`,
  `mars_base`, `ceres_base` (signal `first` / `calendar/flown`), infra creates an AI base asset at that site with
  generic modules from `stageRules` (outpost set). AI assets are supplied abstractly (§3.4) and grow one module per
  `growYears` (data) while the owner's budget pressure < 0.6.
- Owner gone (`onActorGone`): asset passes to `into` if any, else to the partner with the largest share, else
  `derelict`.

### 3.4 Maintenance and degradation (numbers in `modules.json.tuning`)
- **Upkeep (t/yr)** = Σ module `upkeepTYr` + crew × `crewTYr` (2.5) − Σ `isruTYr` (floor 0). **Storage** =
  Σ `storageT` (min 2 t). Every tick `supplyT -= perStep(upkeep/52, ctx)`.
- **Health**: with supply > 0: `+healYr` (8/yr, +4 with trait `eva`) up to 100; after module `lifeYears` (mean of
  modules, weighted by mass) aging −`ageYr` (6/yr). With `supplyT ≤ 0`: crew evacuates after `graceWeeks` (4) →
  `crew.n = 0`; health `−starveYr` (30/yr). Satellites/rovers: no supply; health falls only by age after
  `lifeEndTurn − 2 years` and they end at `lifeEndTurn`.
- **Status**: active ≥ 40; degraded 15–40 (science × 0.5, one importance-2 news "{nome} se degrada sem
  suprimentos"); derelict < 15 (science 0; decision card for the owner player `infra/derelict`: "Resgatar" =
  prefilled supply mission, "Abandonar"); 3 years derelict → ended (station reentry / base abandoned; news, `past`).
- **Money upkeep** (ground ops) = Σ module `upkeepM` × era scale, paid yearly (`onYear`) by owner and partners by share
  through `budget.spend(..., 'infra', ...)` (new budget category, §14 B4).
- **AI owners** auto-supply (`supplyT` refilled to 80% each quarter) while their budget pressure < 0.6; above it,
  supply decays like the player's and the asset spawns `station_supply`/`base_supply` contracts (§2).
- Reminder: when the player's asset reserve < 13 weeks: Infra badge + one importance-2 news per asset per 26 weeks
  ("{nome}: suprimentos para {n} semanas").

### 3.5 Science and yields
`sciYr(asset)` (cached each quarter):
- station/base: `Σ module.science × n × crewFactor × (health/100) × statusMult × bodyMult × (1 + techBonus(owner,
  'stationScience'|'baseScience'))` with `crewFactor = 0.4 + 0.6 × min(1, crew.n / Σ crewNeed)`, `bodyMult` =
  destination `scienceMult` ?? `SCIENCE_BODY`. Vehicles add their `science`.
- Paid continuously: `research.addSciencePoints(state, perStep(sciYr × share / 52, ctx), 'Infraestrutura')` for the
  player; AI owners get prestige `+0.02 × sciYr` per year instead (no AI science points exist).
- `experiments` cargo: +50% station/base science for 26 weeks (`boostUntilTurn`).
- Yearly prestige/support (owner player): station 0.5 + 0.01·crew, base 0.8 + stage, observatories 0.3.

### 3.6 Satellites and rovers as assets
- `infra.deliver` for satellite: fleet key `(ownerId, sub, site)`; adds `{endTurn: arrive + lifeYears × 52 × (1 +
  techBonus 'lifetime'), n: 1}`. Yields per unit per year from the sub `yield`, scaled by `size = clamp(sc.massT /
  refT, 0.5, 3) ** 0.6`: `scienceYr` (science, observatory 18, deep_observatory 40, gravity_lens 120, science 5,
  earth_obs 2), `revenueMYr` (comms 30, constellation 4 per unit, navigation 0, power 80; × `budget` era price index
  from missions.json `eraPrice`), `supportYr`, `reputationYr`. Observatories "dão ciência até o fim da vida útil"
  (R4): their yield continues until `endTurn`, then news "{nome} encerra a missão após {n} anos".
- `relay` gives +15% science to the player's probes in ops, rovers and bases on its body (sat site `lunar_orbit`,
  `mars_orbit`, …); required (not only bonus) for `bs_*` science on the Moon's far side and beyond Mars
  (`needsRelay` in destinations).
- `servicing` (crewed or cargo/servicing) on a fleet with `serviceable` sub: the oldest unit +5 years, health 100.
- Rovers: single asset per mission, `lifeEndTurn`, yearly science (§1.3), `distanceKm` cosmetic counter
  (`+ perStep(kmYr/52)` by sub) shown in the Infra screen.

### 3.7 Bases and colonies.js (stages, size tier)
- Derived **stageN** of a base (modules.json `stageRules`, binding): 1 = only vehicles/probes; **2 outpost** = ≥ 1
  hab + power ≥ 1 + a crew visit ever; **3 base** = ≥ 3 habs (`housing ≥ 12`), power ≥ 3, life ≥ 2 (`isru` or
  `greenhouse`), ≥ 1 lab; ≥ 4 only through colonies.js (population).
- **Adopt**: from `colonies.unlockYear(data)`, when a base reaches stageN ≥ 2 at a site whose destination matches a
  colonies.json site (`site.destination`) and the owner can found there (`colonies.foundCheck` without cost/convoy),
  infra calls **`colonies.adoptBase(state, data, assetId)`** (new, infrastructure-sim edits colonies.js): creates
  the colony immediately (no convoy), `stage = stageN`, `population = crew.n` (min 4), infra levels from modules
  (`vida` = life, `energia` = power/2, `alimento` = greenhouse×2 + isru, `moradia` = housing/16, each capped at
  `tuning.infra.max`), links `colony.assetId`/`asset.colonyId`, emits `colony/founded`.
- After adoption: every base module delivered calls `colonies.addInfra(state, data, colonyId, need, levels)` (new;
  same effect as `invest`, no cash). colonies.js keeps population, needs, opinion, crises; the asset keeps modules,
  vehicles and supply (supply shortage → colony `shock.vida`). A colony founded by the old abstract path
  (`foundColony` arrival) creates its base asset through `infra.ensureBaseFor(state, data, colony)` with the
  stage's generic module set, so the renderer always has a base.
- **sizeTier** (renderer, §7.3) = max(tier by module score, tier by colony stage): score = Σ module `size` (hab 1,
  dome 4, arcology 30, megastructure 100…) → tier 0 (≤ 2), 1 (≤ 6), 2 (≤ 15), 3 (≤ 40), 4 (≤ 120), 5 (> 120);
  colony stage 2→1, 3→2, 4→3, 5→4, 6→5.

### 3.8 infra.js API (exports used by other builders)
```js
export const meta = { maxDt: 13 };
export function init(state, data) / tick(state, data, ctx) / onYear / compact / onActorGone / onActorBorn
export function listAssets(state, { ownerId, kind, site, status, other } = {}) → Asset[]   // read-only copies not needed
export function assetById(state, id) → Asset|null
export function targetsFor(state, data, { type, sub, destination, payloadKind }, actorId) → [{assetId, name, ownerId, ok, reason, kind}]
export function canDeliver(state, data, actorId, assetId) → { ok, reason }
export function deliver(state, data, mission, level) → { assetId, created: boolean }     // called by missions on arrival success
export function sceneTarget(state, data, mission) → SceneTarget|null                       // §7.1 snapshot for launch.js
export function ensureBaseFor(state, data, colony) → assetId
export function sizeTier(state, data, asset) → 0..5 ; stageOf(state, data, asset) → 0..3
queries: 'infra/list' (views with health, supplyWeeks, sciYr, share, status, alerts), 'infra/get', 'infra/summary'
actions: 'infra/rename' {assetId, name}, 'infra/abandon' {assetId}
decisionHandlers: 'infra/derelict' (choices 'rescue' | 'abandon')
signals: 'infra/created', 'infra/module', 'infra/degraded', 'infra/ended'
```

---

## 4. Tech tree 1950–3000 (R8)

### 4.1 Size and shape (targets, ±10%)
6 branches (`vocab.techBranches`, unchanged) × 7 tiers (`techTiers` t1..t7 = eras e1..e7).

| tier | era years | kept v0.8 nodes | new unlock nodes | generated efficiency | new authored efficiency | total |
|---|---|---|---|---|---|---|
| t1 | 1950–1975 | 23 | 32 | 20 | 5 | ≈ 80 |
| t2 | 1976–1999 | 23 | 22 | 28 | 2 | ≈ 75 |
| t3 | 2000–2025 | 18 | 22 | 28 | 2 | ≈ 70 |
| t4 | 2026–2050 | 45 legacy + 14 | 22 | 9 | 0 | ≈ 90 |
| t5 | 2051–2199 | 20 | 24 | 36 | 0 | ≈ 80 |
| t6 | 2200–2599 | 14 | 22 | 39 | 0 | ≈ 75 |
| t7 | 2600–3000 | 19 | 18 | 33 | 0 | ≈ 70 |
| **total** | | **176** | **≈ 162** | **≈ 193** | **9** | **≈ 540** |

About 30% unlock nodes, 70% efficiency (R8: "a maioria melhora a eficiência").

### 4.2 Node format (schema `tech-node.schema.json`, extended)
```jsonc
{ "id": "t1_vehicle_heavy", "branch": "propulsion", "era": 1, "techTier": "t1",
  "fromYear": 1961, "untilYear": null, "histYear": 1965,          // histYear: required for every node from v2 on
  "name": "Integração de cargas pesadas", "short": "Lançador pesado", "icon": "🚀",
  "description": "≤ 160 caracteres.", "cost": 220, "science": 40, "weeks": 40,
  "requires": ["t1_vehicle_medium", "e1_struct_tank_al"],
  "effects": {"payload": 0.02},                                   // unlock nodes may also carry small effects
  "unlocks": [{"key": "vehicle:heavy", "label": "Lançadores pesados (Titan, Proton, Saturn IB)"}],
  "lane": 2,                                                      // optional column hint inside the branch
  "initialFor": ["nasa"], "secret": false, "unlockedBy": null }
```
- `kind` is **derived**: `unlocks.length > 0` → `'unlock'`, else `'efficiency'`. `unlockKind` = kind part of
  `unlocks[0].key` (colour, §5.6). A node may unlock several keys of different kinds; the first is primary.
- `fromYear` (researchable from) = `histYear − lead`: lead 3 y (t1–t3), 5 y (t4), 10 y (t5), 25 y (t6–t7). The
  player can be early, never absurdly early.
- `untilYear` only for nodes made obsolete (e3 already uses it); obsolete unlock nodes are never given
  `untilYear` (a key must stay obtainable).
- Ids of the 176 kept nodes **never change**; they may gain `unlocks`, `histYear`, `lane`, extra `requires` (only
  ids of the same or earlier tier). Authored new ids: `t<n>_<branch-short>_<slug>`; generated ids
  `g<n>_<branch>_<template>_<i>` (prefix `g\d_` reserved for techgen; validator refuses it in authored nodes).

### 4.3 Where nodes live, loading and budgets
- **Moves**: `data/eras/eN/tech.json` → **`data/tech/eN/tech.json`** (same merge key `tech`), one manifest pack per
  era: `{"id": "tech-e3", "era": "e3", "dir": "tech/e3/", "files": ["tech"], "exclude": ["lunar_race"]}`. Era packs
  drop `tech` from `files`. `CATALOG_FILES` keeps `tech` (past-era tech stays merged: prerequisites, keys and
  migration need it). Reason: e3 has < 1 KB of budget left and the tree must grow.
- **Review fix**: every tech pack is merged whatever eras are loaded (`src/core/data.js` activeIds: `kind: "tech"` is
  always active, `exclude` still applies). A key granted only by a not-yet-loaded era would otherwise be "unknown, so
  held by everyone" for the gated player, and gating/AI key years would depend on which packs the phone had loaded
  (lazy ≠ eager). The boot rule counts all tech packs as always loaded (~153 KB).
- `legacy-e4`'s `data/tech.json` (45 nodes) stays where it is (Corrida Lunar keeps exactly its tree); the campaign
  sees them as t4 nodes. They gain `histYear` and optional `unlocks` (harmless where `techGating` is false).
- `exclude` (new manifest field, packs.js): the pack is not active for the listed scenario ids.
- **Generation** (`src/core/techgen.js`, pure, no rng): each `data/tech/eN/tech.json` has `templates[]`:
  ```jsonc
  { "id": "lc", "branch": "propulsion", "effect": "launchCost", "values": [-0.02, -0.02, -0.03],
    "names": ["Turbobombas mais leves", "Injetores coaxiais", "Bocais regenerativos"],   // exactly values.length, authored pt-BR
    "shorts": ["Turbobombas leves", "Injetores", "Bocais"], "icon": "🔥",
    "after": "e1_prop_turbopump", "alsoAfter": [],                                       // chain start + extra prereqs
    "years": [1952, 1974], "cost": [40, 90], "science": [8, 20], "weeks": [12, 24],
    "desc": "{name}: {effect}." }
  ```
  → `values.length` nodes `g1_propulsion_lc_1..k`, chained (`_i` requires `_{i-1}`, `_1` requires `after` +
  `alsoAfter`), `fromYear`/`histYear` and cost/science/weeks interpolated linearly (rounded: years to int, cost to
  5, science to 1, weeks to 1), `description` from `desc` with `describeEffects` text. `packs.assemble` expands
  templates right after merging each tech file (before indexing), so `data.tech.nodes` and `data.index.tech`
  contain generated nodes like authored ones; hashes (`packHash`) cover the templates. Generated nodes are stable as
  long as the template id and index are stable (never reorder `values`; append only).
- Budgets: each `tech-eN` pack ≤ 40 KB raw; authored descriptions ≤ 160 chars. Validator boot rule changes to
  `always + max over eras of Σ packs of that era` (so `e3 + tech-e3` count together); expected boot ≈ 849 + 351
  + 19 ≈ 1,219 KB (< 1,258 KB). techtree.json (always, core) ≤ 15 KB.

### 4.4 Kept nodes and merging rules
- Kept nodes become efficiency nodes unless the node's theme *is* an unlock (then `unlocks` is added). Binding
  conversions: `prop_e3_vertical_landing` → also `vehicle:reusable`, `part:reuse.legs`; `prop_depot_ops` → also
  `module:station.depot`, `cargo` sub `propellant` key `missionType:propellant`; `e6_fusao_madura` → also
  `part:prop.fusion_mature`; `e7_prop_antimatter_catalyzed` → also `vehicle:antimatter`. Other conversions are the
  techtree-data owner's call, listed in its report.
- No node is deleted. Two nodes that say the same thing are **not merged by id**; the later one gets `requires`
  on the earlier and a distinct effect (or `untilYear` if obsolete).
- `initialFor` stays (AI start); the player's start is §5.5.

### 4.5 Unlock nodes per tier (binding keys; names are suggestions)
t1 (1950–75): `vehicle:sounding` (start), `part:prop.alcolox` (start), `vehicle:small` + `missionType:satellite`
+ `satellite:science` (1957), `part:prop.kerolox` (1957), `vehicle:medium` (1959), `vehicle:three_stage` (1959),
`missionType:probe` + `probe:lunar` (1959), `probe:impactor` (1959), `satellite:weather` (1960),
`satellite:navigation` (1960), `part:prop.hypergolic` (1960), `missionType:crewed` + `spacecraft:capsule_1` +
`vehicle:crew_rated` (1961), `part:escape.tower` (1961), `probe:interplanetary` (1961), `vehicle:core_boosters`
(1962), `satellite:comms` (1962), `part:prop.hydrolox` (1962), `satellite:geo` (1964), `spacecraft:capsule_2_3`
(1964), `part:prop.solid_large` (1964), `vehicle:heavy` (1965), `part:avionics.digital` (1965),
`missionType:docking` (1966), `probe:lander` (1966), `probe:atmospheric` (1967), `vehicle:superheavy` (1967),
`spacecraft:lander_crewed` (1968), `satellite:observatory` (1968), `probe:sample_return` (1970), `rover:light` +
`missionType:rover` (1970), `missionType:station` + `module:station.core` (1971), `rover:vh_lrv` (1971),
`probe:outer` (1972), `satellite:earth_obs` (1972), `module:station.lab` (1973), `probe:gravity_assist` (1973).
t2 (1976–99): `module:station.multiport` (1977), `missionType:cargo` + `cargo:supply` key
`missionType:supply` + `spacecraft:cargo_capsule` (1978), `missionType:rotation` (1977), `vehicle:spaceplane`
(1981), `spacecraft:capsule_crew4plus` (1981), `missionType:servicing` (1984), `module:station.hab` (1986),
`module:station.node` (1986/1998), `part:fairing.large` (1980), `probe:small_body` (1996), `rover:micro` (1997),
`probe:ion_drive` (1998), plus 10 more of the owner's choice in t2 themes (RTG power, autonomous probes…).
t3 (2000–25): `module:station.solar` (2000), `module:station.airlock` + `module:station.arm` (2001),
`missionType:tourism` (2001), `rover:medium` (2004), `module:station.cupola` (2010), `part:prop.methalox` (2010s),
`module:station.logistics` (2011), `spacecraft:cargo_reusable` (2012), `rover:heavy` (2012), `vehicle:reusable` +
`part:reuse.legs` (2015), `module:station.inflatable` (2016), `satellite:relay` (2018), `satellite:constellation`
(2019), `rover:rotorcraft` (2021), `satellite:deep_observatory` (2021), `part:reuse.catch` + `vehicle:rapid_reuse`
(2024), `spacecraft:cargo_lander` (2024).
t4 (2026–50): `missionType:base` + `cargo` subs `base_module`/`base_vehicle` (2028), `module:base.hab_small`,
`module:base.solar` (2028), `module:base.comms`, `module:base.lab` (2030), `rover:vh_drone` (2030),
`spacecraft:tug` (2030), `module:base.fission` (2032), `rover:vh_pressurized` (2032), `module:base.isru` (2033),
`module:base.pad` + `rover:vh_crane` (2034), `rover:vh_excavator` (2035), `module:station.depot` +
`missionType:propellant` (2035), `part:prop.nuclear_thermal` (2035), `module:base.garage` + `rover:vh_truck`
(2036), `module:base.hab_large` (2038), `module:base.greenhouse` (2040), `satellite:power` (2045), `rover:vh_hopper`
(2045), `spacecraft:habitat` (2028), `missionType:servicing_robotic` (2030).
t5 (2051–2199): `missionType:colony` (2051, activates the reserved type with colonies.js), `vehicle:ship_interplanetary`
+ `spacecraft:interplanetary_ship` (2060), `module:base.dome` (2060), `module:station.centrifuge` (2070),
`module:base.factory` (2070), `rover:swarm` (2070), `missionType:mining` (2080), `probe:interstellar_precursor`
(2080), `module:base.mass_driver` (2090), `module:station.shipyard` (2110), `part:prop.fusion` (2120),
`rover:cryobot` (2120), `rover:submarine` (2150), plus 11 of the owner's choice (fusion drives, sails, AI…).
t6 (2200–2599): `satellite:gravity_lens` (2200), `rover:vh_crawler` (2200), `vehicle:sail_probe` +
`spacecraft:sail_probe` (2250), `probe:interstellar` + `missionType:interstellar` (2250), `module:station.ring`
(2250), `module:base.arcology` (2250), `probe:beamed_sail` (2300), `vehicle:ship_interstellar` +
`spacecraft:interstellar_ship` (2300), `satellite:interstellar_relay` (2350), `vehicle:generation_ship` +
`spacecraft:generation_ship` (2400), plus the owner's choice.
t7 (2600–3000): `module:base.megastructure` (2600), `module:station.cylinder` (2650), `part:prop.antimatter` +
`vehicle:antimatter` (2650), `satellite:power_swarm` (2650), plus the owner's choice (≥ 10 more, galactic themes).

### 4.6 Efficiency effect keys (existing 13 + new; consumers)
| key | unit | read by |
|---|---|---|
| reliability, launchCost, payload, chanceBand, commandPoints, sciencePerMission, landingReliability, crewSafety, delayReduction, sciencePerWeek, researchSlots, crewMorale, injuryReduction | (existing) | (existing) |
| `lifetime` | pct | infra (satellite/rover life, module lifeYears) |
| `maintenance` | pctNeg | infra (upkeep t/yr and US$) |
| `stationScience`, `baseScience`, `roverScience`, `observatoryScience` | pct | infra |
| `satRevenue` | pct | infra (comms/constellation/power revenue) |
| `dockingReliability` | pp | risk (milestone group `dock`) |
| `moduleMass` | pctNeg | missions (payload mass of modules) |
| `isru` | pct | infra (isruTYr) |
| `transitTime` | pctNeg | missions (dest transitWeeks) |
| `devTime` | pctNeg | designs (Hangar dev weeks) |
| `production` | pct | market (cadence) |
| `marketInterest` | num | market (interest target +) |
`effectLabels` for the new keys go in `techtree.json` (pt-BR). **Caps** (`techtree.json.effectCaps`, applied in
`research.recompute` after summing): launchCost ≥ −0.7, payload ≤ 1.5, reliability ≤ 0.12, delayReduction ≤ 0.6,
maintenance ≥ −0.7, moduleMass ≥ −0.5, transitTime ≥ −0.6, devTime ≥ −0.6, lifetime ≤ 2, others ≤ 3 (sciences) —
Phase D tunes.

### 4.7 Rival research at this scale
Rivals pick from ~540 nodes; to stay inside the tick budget `advanceRival` caches its option list per actor
(module-level `Map` keyed by `actorId|year|has.length`, invalidated when those change; no effect on results).
Target: research tick ≤ 0.6 ms at e7 with 12 core rivals. Rivals still research unlock nodes (bonus only; their
catalog is history-gated).

---

## 5. Gating (player catalog) — `src/core/gating.js` (pure, new)

### 5.1 Keys held
- `research.keys` (state cache, sorted array of keys, owner research.js) = union of `unlocks[].key` of the player's
  unlocked nodes; recomputed with `bonus` in `recompute`/`unlockNode`/completion and after migration.
- `keyYear(data, key)` = min `histYear` of nodes granting the key (∞ if none; memoized per data).
- `keyHeld(state, data, key, actorId = state.playerId)`:
  `actorId === playerId && scenario.techGating` → `research.keys.includes(key)`; otherwise
  `yearAt(state) ≥ keyYear(data, key)` (AI and non-gated player). Unknown key (not in any node) → true (data
  safety; validator forbids it).

### 5.2 Rules that map items to keys (`data/core/techtree.json.gates`, owner techtree-data)
```jsonc
"gates": {
  "vehicle":   [{"match": {"class": "small"}, "key": "vehicle:small"}, {"match": {"class": "medium"}, "key": "vehicle:medium"},
                {"match": {"class": "heavy"}, "key": "vehicle:heavy"}, {"match": {"class": "superheavy"}, "key": "vehicle:superheavy"},
                {"match": {"class": "sounding"}, "key": "vehicle:sounding"}, {"match": {"reusable": true}, "key": "vehicle:reusable"},
                {"match": {"ship": true}, "key": "vehicle:ship_interplanetary"} …],
  "template":  [{"match": {"id": "two_stage"}, "key": "vehicle:small"}, {"match": {"id": "three_stage"}, "key": "vehicle:three_stage"},
                {"match": {"id": "core_boosters"}, "key": "vehicle:core_boosters"}, {"match": {"id": "reusable"}, "key": "vehicle:reusable"} …],
  "part":      [{"match": {"prop": "hydrolox"}, "key": "part:prop.hydrolox"}, {"match": {"kind": "escape"}, "key": "part:escape.tower"} …],
  "spacecraft":[{"match": {"kind": "capsule", "crewMax": 1}, "key": "spacecraft:capsule_1"}, {"match": {"kind": "capsule", "crewMin": 2, "crewMax": 3}, "key": "spacecraft:capsule_2_3"},
                {"match": {"kind": "lander", "crewMin": 1}, "key": "spacecraft:lander_crewed"}, {"match": {"kind": "satellite"}, "subKey": "satellite"},
                {"match": {"kind": "rover"}, "subKey": "rover"}, {"match": {"kind": "probe", "destClass": "outer"}, "key": "probe:outer"} …]
},
"destClass": {"lunar": ["moon"], "inner": ["venus","mars","mercury","sun"], "outer": ["jupiter","saturn","uranus","neptune","pluto","kuiper"], …}
```
- `match` fields: any item field by equality, plus derived `crewMin/crewMax` (on `crew`), `destClass` (any of the
  item's `destinations` bodies in that class), `crewRated` (vehicles: also key `vehicle:crew_rated` when the
  mission is crewed). `subKey: 'satellite'` → the key `satellite:<item.sub>` (spacecraft entries get `sub`,
  missions-sim owner tags the 61 satellites and 11 rovers).
- **All** matching rules apply (AND). Item override: `"gate": ["key", …]` replaces the rules; `"gate": []` = ungated.
- `gatesOf(data, kind, item)` memoized per item object (WeakMap).
- `itemGate(state, data, kind, item, actorId)` → `{ok, key, nodeId, reason: 'Pesquise {node.name}'}` (first
  missing key; `nodeId` = cheapest open node granting it, for the UI link).
- `missionGate(state, data, {type, sub, payloadKind, moduleId, vehicleTypeId, crewed})` → same shape: checks
  `missionType:<type>` (except `probe`→also sub key), the subtype `key`, payload kind key, module/vehicle `key`,
  and `missionType:docking` when the target is a station asset.

### 5.3 Where gating is applied (owner techtree-ui+gating)
- `calendar.availableVehicles/availableSpacecraft(state, data, actorId)`: for the player with `techGating`, also
  `itemGate(...).ok`. Variant `availableVehicles(state, data, actorId, {withLocked: true})` returns
  `{item, ok, reason, nodeId}` for the UI.
- `designs.partAccess` (`part` rules + existing `tech` field), `designs.fillTemplate`/`designs/new` (`template`
  rules), licensing (`licenseQuote` requires the vehicle's keys too: "Pesquise {nó} para licenciar").
- `missions` (missions-sim) calls `gating.missionGate` in `validate` and `draftOptions` (lists include locked
  entries with `locked: {reason, nodeId}`).
- **Grandfathering**: hardware already in a player mission in `scheduled`+ or an operational design keeps working
  (validate skips the gate when `m.status !== 'planning'` or `design.program.phase === 'operational'`).

### 5.4 AI
AI catalog: unchanged history/date rules (`keyHeld` date fallback is used only for mission subtypes and modules,
e.g. an AI calendar item with `sub: 'observatory'`). AI never reads `research.keys`.

### 5.5 Player start and historical grant
`gating.historicalGrant(data, year, {have = []})` → node ids: every **unlock** node with `histYear < year`
(strictly earlier year) plus the `requires` closure of each (efficiency ancestors included), sorted by id.
- New game with `scenario.techStart === 'historical'`: `research.unlocked = union(initialFor-of-player,
  historicalGrant(data, startYear))` (campaign 1950 → `vehicle:sounding`, `part:prop.alcolox` and their roots only;
  era scenarios get everything before their start year). Founded agencies (Phase B) use the same rule.
- Migration v3→v4 (§10) uses it with the save's year.

### 5.6 Unlock kinds, colours, legend (`techtree.json.kinds`, DESIGN.md addendum by techtree-ui owner)
| kind | label (legend) | colour token | value | glyph (stroke icon) |
|---|---|---|---|---|
| vehicle | Foguete | `--uk-vehicle` | `#ff8a4c` | foguete |
| spacecraft | Nave | `--uk-spacecraft` | `#f472b6` | capsula |
| satellite | Satélite | `--uk-satellite` | `#38bdf8` | satelite |
| probe | Sonda | `--uk-probe` | `#818cf8` | sonda |
| rover | Rover e veículos | `--uk-rover` | `#a3e635` | rodas |
| module | Módulo de estação ou base | `--uk-module` | `#2dd4bf` | modulo |
| missionType | Tipo de missão | `--uk-mission` | `#f5f5f4` (+ dashed band) | alvo |
| part | Peça do Hangar | `--uk-part` | `#d6b98c` | chave |
DESIGN.md rule 1 exception (added as §4.x "Unlock kinds"): these are **category** colours, used only on the
tech tree (tile band, corner badge, legend, unlock chips in sheets) and on "Libera:" chips elsewhere; never on
buttons, borders of state, or text. State keeps its own encoding (amber available, info active, green done, muted
locked). Kind is never colour-only: glyph + label always present; colorblind mode keeps the same kind colours
(categorical) because glyphs disambiguate. Missing glyphs are added to `components.js` icon set by missions-ui
owner on request (list them in the report).

---

## 6. Research UI at this scale (owner techtree-ui+gating: `src/ui/research-tab.js`, `src/ui/techtree.css`)

### 6.1 Layout (390×844 and 320×640)
- **Header** (unchanged science KPI) + **era bar**: horizontally scrollable segmented chips `E1 1950–75` … `E7
  2600–3000` (current era preselected, `aria-pressed`), each with a mono count `12/80`. Future eras beyond the loaded
  packs show `prévia` and render from the summary (§6.4).
- **Toolbar** (4 tool buttons of 44px, 34px at ≤ 640px height, as today): Buscar · Legenda · Só liberações (toggle)
  · Grafo/Lista.
- **"Próximas liberações"** strip (above the graph, collapsible): up to 3 available unlock nodes of the selected era,
  each a row with kind badge, name, what it unlocks, ETA.
- **Graph per era**: the selected era's nodes only, laid out by the existing `layoutGrid` (branch groups, 3 per row
  on phones); depth computed on the era subgraph (`computeTiers` over nodes of that era; prerequisites from
  earlier eras become **stubs**: a ghost 56px chip at the top of the branch column "◂ E3 · {short}", tap = jump).
- **Tiles**: unlock nodes 80px (as today) + 4px top band in kind colour + 16px corner badge with glyph; efficiency
  nodes **60px** compact tiles (icon, short, mono effect chip e.g. `−3% lanç.`). `GEOM`/`VGEOM` get per-kind tile
  sizes; `layoutGrid` takes `tileOf(n)`.
- **Chain highlight**: existing `chainOf` over the whole tree; in-lane nodes highlighted, out-of-lane ancestors
  listed in the sheet as "Exige (outras eras)" links.
- **Sheet** (unchanged approach cards) adds for unlock nodes a "Libera" block: kind chips + concrete catalog names now
  matched (`gating.unlockTargets(data, state, key)` → ≤ 6 names + "e mais {n}").
- **Search**: input in a top sheet, accent/case-insensitive over `name`, `short`, unlock labels and target names;
  ≤ 20 results (kind badge, era chip, state); tap → select era, center and open the node. Pure exported
  `searchNodes(nodes, q)` (tested).
- **Legend** sheet: the 8 kinds (badge, label, researched/total per kind), plus state legend (existing).
- **Lista mode**: rows grouped by branch for the selected era; same filters; accessible fallback for 320×640.

### 6.2 Performance (binding)
Render ≤ 100 tiles at a time (one era); era switch ≤ 60 ms on a mid phone; search ≤ 5 ms over 600 nodes; no layout
or re-render during pan/zoom (transform only, as today); layout memoized per `(eraId, unlocked.length,
projects ids, filter)`; `research/tree` view list memoized in the tab per `(state.turn, unlocked.length, points)`.

### 6.3 Queries (research.js, same owner)
`research/tree` view gains `kind`, `unlockKind`, `unlocks` (labels), `histYear`, `eraId`, `stubs` (cross-era
requires); new `research/era` (eraId → views of that era only), `research/nextUnlocks` (eraId, n),
`research/kinds` (legend counts), `research/keys` (player keys).

### 6.4 Unloaded future eras
`techtree.json.preview[eraId] = {count, unlockCount, highlights: [{name, kind}] ≤ 8}` (authored by techtree-data,
≤ 1 KB per era) is shown as a card "Era 6 — 75 tecnologias, 22 liberações (ex.: …). Carrega ao chegar mais perto."

---

## 7. Launch-scene visuals (R7) — owner launch-visuals

### 7.1 Sim side (owner missions-sim): milestones and the snapshot
- `launch.openScene` stores `al.target = infra.sceneTarget(state, data, mission)`:
  ```js
  SceneTarget = { kind: 'station'|'base', assetId, name, newAsset: bool, sequence: 'dock'|'berth'|'release'|'surface',
    modules: [{id, n}], vehicles: [{id, n}], sizeTier: 0..5, stageN, bodyId, site,
    payload: {kind, moduleId|null, vehicleTypeId|null, qty}, traits: ['arm', …] }
  ```
  `sequence`: crewed/cargo to an existing station → `dock` (`berth` if the station has trait `arm` and the
  carrier is kind cargo without `docking: 'auto'`); station module to an existing station → `berth`/`dock`; station
  module founding a new station, or any orbital asset delivery without a station → `release`; surface delivery to
  a base (existing or new) → `surface`. Snapshot is JSON, part of `activeLaunch` (save/resume safe).
- Milestones (risk.js `ascentIds`/`arrivalDefs` extension): for `dock`/`berth` targets in Earth orbit
  (`transitWeeks 0`) the **ascent** list gets `rendezvous` then `dock` (groups `dock`); beyond Earth orbit they are
  appended to the arrival list. `release` gets `module_release` (group `deploy`, share 0.3). Surface deliveries keep
  the descent/landing milestones and add a visual-only beat (no milestone). `dockingReliability` and trait `arm`
  modify the `dock` group pFail; `bs_pad` modifies `landing`.

### 7.2 RenderState additions (README §3, updated by launch-visuals)
```js
rs.target = SceneTarget | null      // copied from al.target, plus resolved art: modules[i].art, vehicles[i].art
rs.mode: … | 'rendezvous'           // orbit frame without capture: station/module at centre, Earth/Moon limb below
```
New events (README §4): `rendezvous` (milestone `rendezvous` ok), `dock` (milestone `dock` ok: contact/latch),
`berth` (arm capture, same milestone when sequence `berth`), `release` (milestone `module_release`), `unload`
(visual: 1.5 s after `touchdown` when `rs.target.sequence === 'surface'`). Idempotent like the others.

### 7.3 Painters (new `src/ui/launch-render/infra.js`; art in `data/vehicle-art.json` → `modules`, `baseVehicles`)
- `layoutStation(modules, {seed}) → {parts: [{id, x, y, rot, art}], ports: [{x, y, dir, free}], bbox}` — pure,
  deterministic, tested: core at origin on the x axis; nodes branch ±y; labs/habs along free axial/radial ports in
  module order; solar trusses perpendicular at the core/node with panel pairs; ring/cylinder modules replace the
  layout centre at tiers 5+. The **target port** = first free port facing +x (approach side).
- `paintStation(ctx, layout, {pxPerM, light, t, lightsOn})` with cached sprite per `(layout hash, size bucket,
  light bucket)`; panels and lights animate cheaply (opacity only).
- **Docking sequence** (`mode 'rendezvous'`, ≈ 14 s scene time): approach from +x along the V-bar (range 200 m →
  30 m with RCS puffs from fx), hold at 10 m (wobble if the milestone is an anomaly), final approach, contact flash
  at the port, latch (small shake), docked lights; `berth`: craft holds at 10 m, the arm (from the station art)
  grapples and pulls it to the port. Failure: glancing contact + drift away (no explosion unless catastrophic).
  The new module (station type) is the "craft" drawn from its module art.
- **Release** (no station): upper stage with the module; spring separation, module RCS, arrays/radiators unfold
  (0.8 s each), the upper stage retreats with a small deorbit burn; when founding a station the module turns to
  its attitude and its lights come on ("Primeiro módulo em posição").
- **Surface base** (descent mode): `layoutBase(target, {seed, sizeTier, bodyId})` → placed items on a 3-band
  ground plane (far/mid/near) with `drawBase(ctx, view, layout, {pxPerM, light, t, reduce})` drawn between the
  far terrain layer and the landing terrain (parallax depth 0.35–0.7). By tier: **0** 1–2 small habitats + 2 solar
  panels + a mast; **1** + landing pad (lit ring), lab, 1 parked vehicle; **2** + buried habitats, greenhouse dome,
  comms tower, roads; **3** domes cluster, garage, several vehicles, mining rig; **4** big domes, factory, mass
  driver rail on the horizon; **5** giant structures (arcology towers, megastructure silhouette) on the horizon with
  haze. Items come from the base's actual module list first (one sprite per module type, counts capped by tier),
  tier fills the rest generically. Night side: window lights.
- **Vehicles** (`rs.target.vehicles`, max 6 drawn): parked near the garage/pad; on `unload` they drive to the lander
  along a deterministic path (speed 3 m/s visual), stop beside it, crane/truck loads a crate; dust per body rules
  (vacuum: ballistic sheets, no billowing). If the base has no vehicles, astronauts' lights or a cargo crate lowering
  is shown instead. Reduced motion: vehicles appear already parked next to the lander.
- Budget: ≤ 6 ms/frame at 390×700 (README §1.6): base and station layers are cached offscreen canvases; per frame
  only vehicles (≤ 6 sprites), lights and particles.
- `tools/launch-preview.html/js`: presets "Acoplar à ISS", "Primeiro módulo", "Braço robótico", "Base tier 0…5",
  "Veículos 0–6", on Moon/Mars/Titan; screenshots at 390×844 and 320×640.

---

## 8. Rocket market (R9) — owner market (`src/sim/market.js`, new; MODULES after `investors`)

### 8.1 Player buying: treaty-gated access (applies to the player as buyer only; AI keeps today's rules)
`market.treatyAccess(state, data, buyerId, item)` → `{ok, reason}` or `null` (no opinion), called by
`calendar.accessFor` when `buyerId === playerId` after the existing embargo/tension/launchPolicy checks:
1. Own lineage or generic → ok (null).
2. `embargo` includes buyer → blocked (embargo beats treaties; data may add `embargoUntil: year`).
3. Tension ≥ 3 → blocked (existing).
4. Operator kind `company` and `access: 'open'` → ok (commercial market).
5. Operator kind `agency` (any access) → needs an **active agreement** with the operator (`ctrl`):
   `launch_services` (new) naming the vehicle or `vehicleIds: '*'`, or one of `mission_partnership`,
   `cost_sharing`, `crew_exchange`, `tech_transfer`, or same bloc when `access` is `open`/`bloc`. Else
   `'Precisa de um acordo com {ator} (contrato de lançamento ou parceria)'`.
6. `access: 'own'` (any operator kind) → only `launch_services` naming the vehicle: `'Uso exclusivo de {ator}: só com
   contrato de lançamento'`.
- A treaty break or expiry closes access for new bookings at once. Player missions already `scheduled` on that
  vehicle: launch ≤ 26 weeks away keep it; later ones go back to `vehicleId: null` with suggestion and card
  "O acordo com {ator} acabou: escolha outro foguete para {missão}." (missions-sim listens to signal
  `treaty/broken`/`treaty/expired`, uses `market.treatyAccess`).
- Buying price unchanged (`costM` + tech); `launch_services` terms may set `priceMult` (0.9–1.3).

### 8.2 `launch_services` and `station_partnership` treaty types (diplomacy.js + `actors.json.proposalTypes`)
- `launch_services` "Contrato de lançamento": `durationWeeks 156`, `allowCompanies true`, terms `{seller, buyer,
  vehicleIds: [..]|'*', launches: n, priceMult}`; `defaultTerms` picks the seller's vehicles the buyer lacks;
  `dealUtility` for the seller: `+ budgetPressure × 20 + trust/10 − rivalry/10 − tension × 8 + (company ? 15 : 0) −
  (vehicle access 'own' ? 12 : 0)`; for the buyer: `+ need(class) × 15 − priceMult × 10`. AI-AI deals allowed (they
  only matter for news; AI access rules unchanged).
- `station_partnership` "Parceria de estação": `durationWeeks 520`, terms `{assetId, owner}`; utility for the owner:
  `+ supplyDeficit × 30 + trust/10 − rivalry/10 − tension × 8`; proposed from the Infra screen ("Propor parceria") or
  by the AI owner when its station's supply < 40% and trust ≥ 30.
- Both appear in the existing proposal UI (world-tab reads `diplomacy/proposalTypes`); labels in
  `components.js` (missions-ui owner adds them).

### 8.3 AI buying the player's rockets (slice `state.market`)
```js
state.market = { seq, interest: {[vehicleId]: {[buyerId]: 0..100}}, offers: [{id, vehicleId, buyerId, units, priceM,
  createdTurn, expiresTurn}], contracts: [{id, vehicleId, buyerId, units, delivered, failed, priceM, advanceM,
  everyWeeks, nextTurn, startTurn, untilTurn, status: 'active'|'done'|'cancelled'}], declined: {[vehicleId|buyerId]: turn},
  sales: {count, revenueM} }
```
- **Sellable vehicles**: player designs in phase `operational` and catalog vehicles whose `operator` resolves to the
  player's lineage, in service.
- **Interest** (each `every(ctx, 13)`), per sellable V and core AI buyer B (not dead, not the player):
  ```
  f = min(1, log2(1 + flights) / log2(41))              flights = vehicleStats/design stats
  r = clamp((relMean − 0.80) / 0.17, 0, 1)               relMean = vehicleReliability(...).mean
  fails = failures in the last 104 weeks
  ratio = askPrice / refPrice(B, class(V))               refPrice = cheapest vehicle of that class B can access (AI rules)
  need = B has no vehicle of that class ? 1 : 0.3 ; agencies with launchPolicy 'domestic' × 0 (× 0.5 if they have none)
  bloc = same bloc ? 1 : 0
  target = 100·need·(0.35 f + 0.35 r + 0.15 trust/100 + 0.15 bloc) − 25·fails − 40·max(0, ratio − 1) − 18·tension
           + techBonus(player, 'marketInterest')
  interest ← interest + (target − interest) · 0.35         (clamp 0..100, rounded to 0.1)
  ```
  `askPrice` = `V.costM` (designs: `derived.costM`) × 1.2 default (player-set in the market screen, 0.9–2.0).
- **Offer**: interest ≥ 55, no open offer for (V,B), not declined in the last 52 weeks, ≤ 2 open offers, ≤ 4
  active contracts → with `chanceInStep(0.25/13, ctx)` per quarter push decision `market/offer`
  ("{Ator} quer comprar {n} lançamentos do {foguete}") with `units = 2 + floor(interest/25)` over 52–156 weeks,
  `priceM = round(refPrice × (0.95 + interest/400))`, choices: `accept` · `counter` (+15%: the buyer accepts with
  `p = clamp((interest − 50)/40, 0.1, 0.9)`, shown in the preview, rolled with `rngFor(seed,'market','counter',id)`)
  · `decline` (default; expiry `expiryIn(ctx, 6)`).
- **Contract**: 20% advance on signing (`budget.receive` category `market`); one delivery every `everyWeeks`
  (`nextTurn` is an appointment only for the player's visibility, not a step stop). Delivery = abstract flight for
  the buyer: success `p = vehicleReliability(V).mean` rolled with `rngFor(seed,'market','flight',id,delivered)`;
  `calendar.recordFlight(state, V, ok)` or `designs.onDesignFlight` updates stats (so flights and reliability feed
  interest: the virtuous circle the player asked for). Ok: pay `priceM × 0.8`, trust +2, reputation +1 per 3
  deliveries, news importance 1. Fail: no payment, trust −6, interest −30, refund 50% of that unit's advance; 2
  failures → contract cancelled (news importance 2).
- Player-initiated sale: Market screen "Oferecer a {ator}" → `market/propose {vehicleId, buyerId, units, priceM}`;
  accepted with `p = clamp((interest − 40)/50 − 0.8·max(0, price/ref − 1), 0.05, 0.95)` (shown), resolved next tick.
  `priceM` is capped at `refPrice × propose.maxPriceMult` (2; query `market/maxPrice`): above it the proposal is
  refused and the chance is 0 (no 5% floor for absurd prices).

### 8.4 Production cadence
`market.productionQueue(state, data, vehicleId)` → `{perYear, used12m, nextFreeTurn}`: `perYear` = catalog
`cadencePerYear` (own catalog vehicles) or by class for designs (small 10, medium 6, heavy 3, superheavy 1.5;
reusable × 1.5) × (1 + techBonus 'production'). Used = player missions with that vehicle scheduled in the next 52
weeks + contract deliveries due. `nextFreeTurn` = the first turn when a unit is free. missions-sim uses it in
`validate` (§1.5) and `earliestLaunch` for player-produced vehicles only.

### 8.5 market.js API
```js
export const meta = { maxDt: 13 };
export function init / tick / onYear / compact (done/cancelled contracts > 3 y removed, offers expired) / onActorGone
export function treatyAccess(state, data, buyerId, item) → {ok, reason}|null
export function sellables(state, data) → [{vehicleId, name, flights, rel, perYear, askPrice}]
export function productionQueue(state, data, vehicleId) → {perYear, used12m, nextFreeTurn}
actions: 'market/setPrice' {vehicleId, mult}, 'market/propose' {vehicleId, buyerId, units, priceM}, 'market/requestAccess' {vehicleId}
         (creates a diplomacy proposal launch_services to the operator through diplomacy's proposal API)
decisionHandlers: 'market/offer' (accept | counter | decline)
queries: 'market/view' (sellables, interest table [{buyerId, interest, trend}], offers, contracts, buyable [{vehicleId, ok, reason, operator}]), 'market/interest'
signals: 'market/sale', 'market/delivery'
```
Active only from `scenario.unlocks.market.fromYear` (no slice before).

---

## 9. Data, vocab, schemas and validator additions (owner techtree-data, for everyone)

### 9.1 vocab.json (new/changed sections; ids frozen once added)
- `missionTypes`: add `rover` {label 'Rover', era e1}; `lander` → `{label 'Pouso de sonda (antigo)', status:
  'legacy', aliasOf: {type: 'probe', sub: 'lander'}}`; `colony`, `mining`, `interstellar` stay reserved (colony
  becomes active when colonies-from-base lands, §3.7: status removed by techtree-data at integration).
- `missionSubtypes` (new): the table of §1.2, `{<type>: {<sub>: {label, era}}}`.
- `payloadKinds` (new): `supply, experiments, station_module, base_module, base_vehicle, propellant, servicing,
  client`.
- `assetKinds` (new): `station, base, satellite, rover`; `assetStatus`: `active, degraded, derelict, ended`.
- `stationModules`, `baseModules`, `baseVehicles` (new): ids of §3.2 with era.
- `unlockKinds` (new): the 8 kinds of §5.6 with label.
- `unlockKeys` (new): every key of §4.5 plus any the techtree-data owner adds (`{key: {era, label}}`).
- `techEffects` (new): all effect keys of §4.6 with unit.
- `proposalTypes` (new section or extend): `launch_services`, `station_partnership`.
- `eventGroups`: add `infra` (degradation, reentry, base milestones), `market`.
- `spacecraftKinds`: unchanged (generic carriers are `cargo`/`lander`; rovers `rover`).
### 9.2 Schemas
`calendar-mission.schema.json` (type enum + `sub`), `spacecraft.schema.json` (`sub`, `cargoT`, `lifeYears`,
`gate`, `docking`), `vehicle.schema.json` (`gate`), `tech-node.schema.json` (`histYear`, `unlocks[] {key,
label}`, `lane`, `untilYear`, `techTier`, `secret`, `unlockedBy`), new `missions.schema.json`,
`contracts.schema.json`, `modules.schema.json`, `stations.schema.json`, `market.schema.json`,
`techtree.schema.json`, `tech-file.schema.json` (`nodes`, `templates`).
### 9.3 Validator rules (tools/validate/rules.js, vocab.js)
Keys used by gates/subtypes/modules/vehicles ⊆ keys granted by nodes; every granted key in `vocab.unlockKeys`;
unlock nodes have `histYear` within their era window and `fromYear = histYear − lead (± 2)`; requires only same or
earlier tier and acyclic across the whole tree (incl. generated); authored ids not `g\d_`; templates: `names.length
= values.length`; per tier node counts within ±15% of §4.1 (warning); ≥ 1 node per kind per tier where the kind
has keys of that era (warning); modules deliverable (§3.2); contracts `needs.firstsAny` ⊆ milestones;
stations.json destinations exist with kind station; boot rule per era (§4.3); `tech-eN` ≤ 40 KB.
### 9.4 Manifest (data/packs.json)
`core` gains `techtree`, `missions`, `contracts`, `modules`, `stations`, `market`; era packs drop `tech`; new
`tech-e1..tech-e7` packs (§4.3) with `exclude: ["lunar_race"]`. `colonies` pack unchanged.

---

## 10. Save migration v3 → v4 (owner techtree-ui+gating: `src/core/migrations/v4.js`, registered on import from research.js)

Pure, idempotent, takes `(s, data)`. Steps in this order:
1. **Legacy landing**: every `type === 'lander'` → `type = 'probe'`, `sub = 'lander'` in `s.missions[]`,
   `s.missionsArchive[]` stubs (field `type`/`t` as stored), `s.contracts[]`, `s.decisions[].payload.draft` and
   `.payload.type`, `s.calendar[]` instance overrides (if any field `type`), `s.mandates[]` (`type`). Missing `sub`
   on other types: derived (`missions.json` rule of §1.2) lazily by `normalizeDraft`, not here.
2. **Research grants**: `year = yearOf(s.turn, s.startYear)`; if the scenario has `techGating`:
   `s.research.unlocked = sortedUnion(unlocked, gating.historicalGrant(data, year + 1))` (nodes with `histYear ≤
   year`), plus the unlock nodes granting keys needed by hardware in player missions in `planning`+ and operational
   designs (`gating.gatesOf` over their vehicle/spacecraft/parts/template) with their `requires` closure. Granted
   ids are not added to `completedTurn` (they show as "concedida pela migração" via `research.migratedGrant = n`).
   `s.research.keys` recomputed; `s.research.bonus` **not** recomputed here (research recomputes on next tick; the
   bonus cache is derived).
3. **Slices**: `s.assets ??= null`, `s.market ??= null` (modules build them in `ensure`; infra's ensure also turns the
   player's v0.8 successful `station` missions into a player station asset at their destination — or into a
   partner share of the historical asset when the destination is a historical station — and v0.8 active rover-kind
   `probe` missions into rover assets).
4. `s.version = 4`.
Without `data` (tests calling migrate(raw)), step 2 is skipped and flagged `s.research.needsGrant = true`; research's
`init/tick` performs it once data is present (same function, same result).

Save budget: `research.unlocked` up to ~540 ids (~11 KB) is **not** compacted (EXPANSION §10 `eraDone` compaction is
dropped: keys need ids); assets ≤ 100 × ~250 B; market ≤ 4 KB. Must stay ≤ 400 KB at every year boundary
(`tests/perf-save.test.mjs`).

---

## 11. Missions UI (owner missions-ui)

- **Step 1 "Alvo e tipo"**: type chips (Satélite, Sonda, Rover, Tripulada, Carga, Estação); under them the **subtype
  chips** for the type (locked ones with lock icon + "Pesquise {nó}" link → `#pesquisa/n/<id>`); for station/cargo/
  crewed-rotation a **target block**: "Nova estação"/"Nova base" (name field) or existing assets at that destination
  (own first, then partners; each row: name, owner emblem, modules count, health bar, supply weeks; unavailable rows
  show `canDeliver` reason and, for other owners, "Propor parceria"); for station/cargo: **module / payload picker**
  (module cards with mass, cost, what it adds: "+8 ciência/ano", "+3 tripulantes"; locked ones greyed with the
  research link), vehicle count stepper (1–4), supply tonnes stepper.
- **Step 2**: carrier choice when the payload needs one; capacity line shows "carga útil {x} t de {y} t".
- **Step 3 "Resumo"**: "O que esta missão cria/muda": asset preview (new or after delivery: science/ano, upkeep t/ano,
  reserve weeks, share %), plus cost lines from §1.5.
- **Infraestrutura screen** (new `src/ui/infra-tab.js` + `src/ui/css/infra.css`, registered in `screens.js` group
  `operacoes`, id `infra`, title "Infraestrutura", badge = player assets with supply < 13 weeks or derelict): segments
  Estações · Bases · Satélites · Rovers; asset card (name, site, owner/partners chips, health bar, supply weeks, crew,
  science/ano, status chip), actions "Enviar suprimentos", "Enviar módulo", "Rodízio de tripulação", "Manutenção"
  (each opens the builder prefilled: type/sub/payload/target), "Propor parceria" (other owners), "Abandonar". Base
  cards link to the colony (colonies.js screen) when adopted.
- `dashboard.js`: the `lander` reference (l.197) → probe/lander; Painel alert row for low-supply assets.
- `components.js`: TYPE_LABELS/TYPE_ICONS (rover icon), treaty labels (`launch_services`: 'Contrato de lançamento',
  `station_partnership`: 'Parceria de estação'), new stroke icons requested by others (capsula, satelite, sonda,
  rodas, modulo).
- `screens.js`: register `infra` and `mercado` (market screen by the market owner: `src/ui/market.js`, group
  `operacoes`, title "Mercado de foguetes", available when `state.market`, badge = open `market/offer` decisions).
- Layout at 390×844 and 320×640: no horizontal overflow, chips wrap, steppers 44px, tested by `ui-layout` style
  tests.

---

## 12. Test plan

Each builder adds its tests and keeps the full suite green (`node --test tests/*.test.mjs`, 679 → more):
- **techtree-data**: `tests/techgen.test.mjs` (template expansion: ids, chain, interpolation, stable hash, names
  length), `tests/techtree-data.test.mjs` (counts per tier ±15%, ≥ 30% unlock, every key granted, acyclic, histYear
  windows, budgets), `data-validate` updates (new rules, boot per era), `vocab.test.mjs`.
- **techtree-ui+gating**: `tests/gating.test.mjs` (keyHeld player/AI/non-gated, gatesOf rules + overrides,
  itemGate reasons, missionGate, historicalGrant closure, grandfathering), `research.test.mjs` (keys cache, caps,
  rival cache equivalence: same picks with/without cache over 520 weeks), `techtree.test.mjs` (era lane layout,
  stubs, searchNodes, tile sizes, ≤ 100 tiles), `tests/migrate-v4.test.mjs` (fixture v0.8 saves: lander rename in
  all places, grants consistent with date — a 1970 save has `vehicle:heavy` and not `vehicle:reusable`; idempotent;
  serialize→deserialize identical), Hangar gating in `designs.test.mjs`.
- **missions-sim**: `tests/missions-v2.test.mjs` (types/subtypes/payload validation texts, carrier capacity, alias
  lander everywhere, rover asset created, satellite fleet, rotation keeps crew busy, docking milestones present for
  ISS targets), `tests/contracts-gating.test.mjs` (no lunar cargo before `lunar_surface_robotic`; station supply only
  with an active station of another owner; per-asset caps; followUp eligibility), updates of `missions*.test`,
  `briefing-end`, `integrity`, `vehicle-choice`; golden re-record at integration.
- **infrastructure-sim**: `tests/infra.test.mjs` (upkeep/supply/health curves at dt 1 vs 13 equivalent within 1%,
  statuses and news once, shares and science split, treaty canDeliver, historical ISS modules by date and end,
  AI auto-supply and contract demand, derelict card, ended→past, compaction caps), `colonies.test.mjs`
  (adoptBase, addInfra, ensureBaseFor), save/load identical with assets.
- **missions-ui**: `ui-*.test` style static tests for the builder steps and the Infra screen (no `undefined/NaN`,
  labels pt-BR, 320×640 no overflow), screenshots 390×844 + 320×640 of step 1 (each type), step 3, Infra segments.
- **launch-visuals**: `launch-render.test.mjs` (layoutStation deterministic and port selection, layoutBase per tier
  counts, painters don't throw in Node, events idempotent), `launch-scene.test.mjs` (sequence from snapshot, resume
  mid-docking from flags), preview screenshots of every preset; frame time ≤ 6 ms in the harness.
- **market**: `tests/market.test.mjs` (treatyAccess matrix: company open, agency with/without treaty, own,
  embargo, tension, break → reassignment card; interest formula monotone in flights/reliability and decreasing with
  failures/price/tension; offers caps/cooldown; deliveries update vehicle stats; counter probability shown = used;
  production queue), diplomacy tests for the two treaty types.
- **Integration (all, last)**: `node tools/smoke.mjs 2`, `node tools/validate-data.mjs`, `node tools/campaign.mjs`,
  `node tools/full-campaign.mjs` (1950→3000 ≤ 60 s; bot must research unlock nodes: the bot in `tools/bot-b.mjs`/
  `smoke.mjs` gets a "research the cheapest available unlock node first" rule — owner missions-sim), perf: tick
  median ≤ 4 ms / p99 ≤ 15 ms, save ≤ 400 KB at every year, boot ≤ 1.2 MiB, pacing 0.15–0.35 stops/turn
  reported.

---

## 13. Amendments to docs/EXPANSION.md
- §10 `research` compaction (`eraDone`) is dropped (§10 here).
- §4.4 boot budget rule counts all packs of the biggest era together (§4.3).
- §13.1 golden re-recorded once for Missões v2 (§0.6).
- §2.1 scenario file gains `techGating`, `techStart`, `unlocks.market`.
- The `legacy-e4` split (C4/D) still pending; tech is no longer part of it except `data/tech.json`.

---

## 14. File ownership (7 builders, disjoint)

Rule: a builder edits only its files. Shared files have **one** owner who implements the changes this document
asks of them; others call the APIs listed. A builder that needs a change in someone else's file writes it in its
report and the owner applies it.

### B1 techtree-data
Files: `data/tech/e1..e7/tech.json` (moved from `data/eras/eN/tech.json`, which are deleted), `data/tech.json`
(add `histYear`/`unlocks` only), `data/core/techtree.json` (new: kinds, colours, legend, effectLabels new keys,
effectCaps, gates, destClass, preview, lead), `src/core/techgen.js` (new), `src/core/packs.js` (techgen hook,
`exclude`), `data/packs.json`, `data/core/vocab.json`, `data/core/schemas/*` (all new/changed schemas),
`tools/validate/*`, `tools/validate-data.mjs`, `data/scenarios/*.json` + `data/scenario.json` (`techGating`,
`techStart`, `unlocks.market`), `data/vehicles.json` + `data/eras/*/vehicles.json` + `data/core/parts.json` +
`data/eras/*/parts.json` (only `gate` overrides / `tech` fields), tests listed in §12.
API: `techgen.expand(techJson) → nodes[]`; data shapes of §4.2–4.3, §5.2, §5.6, §6.4.

### B2 techtree-ui+gating
Files: `src/core/gating.js` (new), `src/sim/research.js`, `src/sim/calendar.js` (availability, accessFor hook to
market, `withLocked`), `src/core/catalog.js`, `src/sim/designs.js` (partAccess/template/license gating only),
`src/ui/research-tab.js`, `src/ui/techtree.css`, `src/ui/hangar.js` (locked reasons + research links),
`src/core/migrations/v4.js` (new), `docs/DESIGN.md` (unlock-kind addendum), tests of §12.
API: §5 (`keyHeld`, `keyYear`, `gatesOf`, `itemGate`, `missionGate`, `historicalGrant`, `unlockTargets`,
`keysOfNodes`), research queries §6.3, `calendar.availableVehicles(..., {withLocked})`.

### B3 missions-sim
Files: `src/sim/missions.js`, `src/sim/risk.js`, `src/sim/launch.js`, `src/gen/programs.js`, `src/gen/hardware.js`,
`src/core/helpers.js` (only `achievedAny`), `data/core/missions.json` (new), `data/core/contracts.json` (new),
`data/destinations.json` + `data/eras/*/destinations.json` (`missionTypes` with rover, `stationOk`, `assetHist`,
`needsRelay`), `data/spacecraft.json` + `data/eras/*/spacecraft.json` (`sub`, `cargoT`, `lifeYears`, `docking`,
generic carriers and rovers), `data/eras/*/calendar.json` + `data/calendar.json` (lander → probe/lander,
`sub` for satellites/rovers), `tools/smoke.mjs`, `tools/bot-b.mjs`, `tools/campaign.mjs`, `tools/full-campaign.mjs`,
`tools/golden.mjs` + golden fixture (re-record at integration), mission tests of §12.
API: `missionTypeOf`, `SUBTYPES` (from data), `contractEligible`, `draftOptions` extended (`subs`, `payloadKinds`,
`modules`, `vehicles`, `targets`, each with `locked`), `al.target` snapshot; calls `infra.*` (§3.8),
`market.productionQueue`, `market.treatyAccess`, `gating.missionGate`.

### B4 infrastructure-sim
Files: `src/sim/infra.js` (new), `data/core/modules.json` (new), `data/core/stations.json` (new),
`src/sim/colonies.js` (`adoptBase`, `addInfra`, `ensureBaseFor` hook), `data/core/colonies.json` (base thresholds
if needed), `src/core/engine.js` (register `infra` after missions and `market` after investors), `src/sim/budget.js`
(categories `infra`, `market` + labels "Infraestrutura", "Vendas de foguetes"), tests of §12.
API: §3.8.

### B5 missions-ui
Files: `src/ui/missions-tab.js`, `src/ui/css/missions.css`, `src/ui/infra-tab.js` (new), `src/ui/css/infra.css`
(new), `src/ui/components.js`, `src/ui/screens.js`, `src/ui/dashboard.js`, `src/ui/colonies.js` (link to base),
`src/ui/decisions.js` (rendering of `infra/derelict`, `market/offer` if special), UI tests and screenshots of §12.
API used: `missions/*` queries + `draftOptions`, `infra/*`, `research/node` for links.

### B6 launch-visuals
Files: `src/ui/launch-scene.js`, `src/ui/launch-scene.css`, `src/ui/launch-render/index.js`, `camera.js`, `fx.js`,
`vehicles.js`, `textures.js` (only if needed for ground bands), `src/ui/launch-render/infra.js` (new),
`src/ui/launch-render/README.md`, `data/vehicle-art.json` (`modules`, `baseVehicles` art), `tools/launch-preview.html`,
`tools/launch-preview.js`, `tests/launch-render.test.mjs`, `tests/launch-scene.test.mjs`.
API: RenderState/events of §7.2; reads `state.activeLaunch.target` only.

### B7 market
Files: `src/sim/market.js` (new), `src/sim/diplomacy.js` (two treaty types, `defaultTerms`/`dealUtility`, AI
proposals of `station_partnership`, proposal API used by `market/requestAccess`), `data/actors.json`
(`proposalTypes` rows) + era `snapshot.json` files only if they carry `proposalTypes`, `data/core/market.json` (new:
tuning of §8.3–8.4), `src/ui/market.js` (new screen), `src/ui/css/market.css` (new), `src/ui/world-tab.js` (only if
the proposal form needs terms inputs for the new types), tests of §12.
API: §8.5.

### Order and integration
1. B1 lands vocab/schemas/manifest and the tech packs first (others validate against them); B2 can start on
   `gating.js` with a stub `techtree.json`. 2. B3, B4, B7 in parallel (agree on §3.8/§8.5 signatures exactly as
   written). 3. B5, B6 after their sim APIs exist (they may mock with fixtures meanwhile). 4. B3 runs the integration
   checklist of §12 and re-records the golden. Nobody commits.

## 15. Review fixes (sim side)
- **Tech packs always merged** (§4.3 note): keys and key years never depend on the loaded eras (lazy = eager).
- **Research gate on edits** (§5.3): a scheduled mission is grandfathered only for the gate spec it was committed with
  (type, sub, payload kind, module, surface vehicle, crewed, target kind). An edit to anything else is gated like a
  new draft (`missions.js` `gateSpecOf`).
- **Market price cap** (§8.3): `priceM ≤ refPrice × propose.maxPriceMult` (2); above it `market/propose` refuses and
  `proposeChance` is 0. Query `market/maxPrice(vehicleId, buyerId)`.
- **Partner share** (§3): supply and propellant that do not fit in storage are lost and are not credited to the
  partner's delivered mass.
- **Founding after newGame as another actor**: `research.resetPlayer` gives the founded agency the §5.5 start
  (initialFor + historical grant, keys recomputed); the old actor joins the rivals.
- **Start set by date**: with `techStart: "historical"`, `initialFor` nodes from a later `histYear` are not given (the
  1950 campaign no longer starts with the 2026 Corrida set); the v3 → v4 migration drops them from v0.8 saves while
  their year is ahead (`dropEarlyStartNodes`), unless a held node requires them.
- **Contract auctions vs long steps** (§2): `closeTurn = max(created + 4, stepEnd)` (`ctx.stepEnd` = end of the player
  step, also for substeps), deadline counted from the close; closing an auction removes its bid card; a bid on a
  decided contract answers `{status: 'gone'}`. Weekly play (Corrida) is unchanged.
- **Arrival backlog**: an arrival that waited 13 weeks for its control-room scene (one blocking scene at a time) is
  resolved off-screen; long steps no longer pile hundreds of missions in `arrival`.
- **Colony-fed bases**: a base linked to an active colony with route or reserve is supplied by the colony
  (`infra.colonyFed`): `supplyWeeks` is Infinity (no cargo reminder) and its supply is topped up every step. Site
  names fall back to the colony site's pt-BR name.
- **ISS dated** (`fromYear` 1998) so it is not offered as a target before it exists.
- **Save encoding** (`savepack.js`, lossless): objects of ≥ 3 plain objects pack like arrays (`$k` + rows); research
  unlocked/completedTurn/bonus index the rivals' id table, and index lists are 2-character base-36 code strings.
