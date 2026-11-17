# launch-render — the Launch Day renderer

The renderer is everything drawn on the Launch Day canvas (`src/ui/launch-scene.js` → `.ls-canvas`). It
**only presents** what the sim decided (`state.activeLaunch`): it never reads or writes game state, never
calls `store`, never imports `src/sim/*`. `launch-scene.js` builds a plain **RenderState** snapshot every
frame and forwards milestone **events**; the renderer turns those into pictures.

No build step, no npm deps, no downloaded images. Every pixel is generated in code (canvas 2D, offscreen
canvases, gradients, seeded noise, inline SVG paths if useful). Mobile-first: portrait 320–430 CSS px wide.

```
src/ui/launch-render/
  README.md      this file (art direction + contract)
  index.js       scene composer: createLaunchRenderer() — the ONLY module launch-scene.js talks to
  textures.js    seeded noise, offscreen texture cache, sky, stars, planets, Earth limb, clouds, pads, terrain
  vehicles.js    data-driven painter for launch vehicles + spacecraft (reads data/vehicle-art.json)
  fx.js          pooled particle system + pure effect painters (plumes, diamonds, collar, chutes, plasma)
  camera.js      framing (px per metre), follow, shake, parallax helpers
data/vehicle-art.json   art data for every launcher/spacecraft (real dimensions, materials, sites)
tools/launch-preview.html + tools/launch-preview.js   standalone harness (no game state needed)
```

Ownership (one builder per file; the composer `index.js` belongs to the integrator, who also later
rewires `launch-scene.js`): textures.js · vehicles.js + data/vehicle-art.json · fx.js · camera.js + index.js.
Builders may only change the exported signatures below by updating this README in the same change.

---------------------------------------------------------------------------------------------------------

## 1. Art direction

**Goal:** painterly-realistic 2D, like a high-end space-sim illustration — never flat "poster/blueprint",
never neon, never perfect geometric primitives on their own. Every surface gets *(a)* a base material,
*(b)* cylindrical/spherical shading from one sun, *(c)* a low-amplitude noise breakup (panel seams, grime,
dust), *(d)* a rim light from sky/planet bounce. Edges are soft-antialiased, not outlined. No black strokes.

### 1.1 Lighting model (shared by all modules)
- One sun per scene. `light = { ax, ay }` is a **unit vector in screen space pointing from the object
  towards the sun** (y-down). Default `SUN = { ax: -0.62, ay: -0.78 }` (upper left). On Earth pad scenes
  at dawn/dusk the sun is low: `{ ax: -0.95, ay: -0.3 }`.
- Cylinders (stages, tanks, SRBs, capsules): across-axis shade
  `I(s) = ambient + diffuse * max(0, n(s)·L) + spec * pow(max(0, n(s)·H), shininess)`, where `s ∈ [-1,1]`
  is the normalized horizontal position across the body, `n(s) = (s, 0, sqrt(1-s²))`. Implemented as a
  horizontal `createLinearGradient` with ~7 stops (precomputed per material + light angle bucket, cached).
- Materials (`MATERIALS` in vehicles.js): `white_paint` (ambient .32, diffuse .68, spec .15, shin 8),
  `stainless` (ambient .18, diffuse .35, spec .9, shin 40, tinted by sky colour = environment reflection),
  `orange_foam` (SLS/ET #c8641e → #8a3e12, rough, spec 0, cell noise), `carbon_black` (#1b1d21, spec .25),
  `bare_aluminium` (#b9bec4, spec .5), `gold_foil` (MLI: #d6a43a crumpled worley highlights),
  `silver_foil`, `ablator` (Avcoat/PICA: #3b2f27 → charred #1a1410), `tile_black` (Starship hex tiles),
  `solar_cell` (#16203a with #2b3f7a grid + specular sheen), `grey_paint`, `bronze` (Atlas V #b4743f).
- Soot: per-part `soot ∈ [0,1]` = gradient from the engine end (dark #26221e, multiply) fading upward,
  streaked by vertical noise. Reused Falcon 9 / New Glenn boosters: soot .55–.75; fresh: 0.
- Frost: cryogenic tanks get `frost ∈ [0,1]` at the pad (white-blue #e8f1f6 speckle over LOX sections,
  `screen` blend); it fades during the first ~20 s of ascent (`frost * (1 - since(liftoff)/20)`).
- Rim light: thin 1–2 px lighter edge on the side away from the sun, coloured by the sky bottom colour
  (Earth: blue-cyan; Mars: dusty orange; airless: none or very faint Earthshine).
- Shadows: landers cast an elliptical soft shadow (offset along `-light`) whose size/alpha follow altitude.
- Exposure/colour grading: highlights never pure #fff except engine cores and the sun; shadows never pure
  black except deep space. Atmospheric scenes get a final subtle haze (low-alpha sky-colour veil over
  distant layers). Vacuum scenes: hard terminator, black shadows, no haze.

### 1.2 Palette by environment
| Environment | Sky (zenith → horizon) | Ground / disc | Notes |
|---|---|---|---|
| Earth pad, day | #3d7fb8 → #a9c9de | marsh/grass #4a5a3a, concrete #8d8a82 | haze #d9e3e8; deluge steam #f2f4f5 |
| Earth pad, dusk | #253a6b → #e8a466 | dark greens | sun-low warm rim |
| Earth 10–40 km | #1d4f8f → #6fa3cf | — | Mach diamonds, collar near Max-Q |
| Earth 40–100 km | #071634 → #2a5d9a | limb appears ≥ 60 km | stars fade in > 50 km |
| Earth space | #000 → #02040a | limb #6aa8e0 glow band, clouds, oceans #0d3a66 | thin airglow #3a8fd9 |
| Moon | #000 | regolith #8e8b85/#5f5d59, maria #4b4a48 | hard shadows, Earth in sky |
| Mars | #c9926a (horizon) → #6b4a3a → black high | rust #a4542e/#7d3a1e, dark basalt #4a2c22 | butterscotch sky, blue sunset optional |
| Venus | clouds #e6d3a3/#c9a86a (uv bands) | — (orbit/flyby only) | no surface landing |
| Mercury | #000 | grey-brown #7d756c, bright rays | like Moon, warmer |
| Europa | #000 | ice #d8d4c8 with lineae #8a5a3a | Jupiter in sky |
| Titan | orange haze #d9a24a → #8a5a22 | dark dunes #3e2c18, methane shine | no stars, diffuse light |
| Ganymede/Callisto | #000 | dark grey-brown, bright craters | |
| Asteroids/comets | #000 | rubble #5a544c, boulders | irregular silhouette |
| Gas giants | — | banded discs | for orbit arrivals |

### 1.3 Per-body look (textures.js `BODY_LOOK`)
- **earth**: from orbit: oceans + continents (fbm landmask, seeded per body so it is stable) + cloud
  layer (separate cached sprite, slow drift) + limb glow + night side city lights optional. Ground: per
  launch site (see §1.4). Splashdown: ocean with swell (sum of 3 directional sine waves + noise foam).
- **moon**: maria (low-frequency fbm thresholded, darker basalt), crater population (power-law radii,
  bright ejecta rays for a few), regolith grain (high-freq noise). Landing ground: grey plain, rocks with
  hard shadows, crater rims in mid/far parallax layers, black sky, Earth hanging (small blue marble).
- **mars**: rust gradient by latitude, dark albedo features (Syrtis-like fbm), white polar caps, faint
  dust-storm veils. Landing ground: rusty plain, scattered dark rocks, dunes, distant mesa layers, pale
  butterscotch sky, dust blown by plume.
- **venus**: opaque cloud deck with chevron uv bands (only discs/flyby/atmospheric probe; never a ground).
- **mercury**: Moon-like, warmer, more craters, no maria contrast.
- **europa**: off-white ice, reddish-brown lineae (ridged noise lines), few craters.
- **titan**: orange limb-dark haze sphere; descent: thick haze layers, dark dunes and bright plains.
- **ganymede / callisto / io / enceladus / triton / pluto / charon / ceres / vesta / phobos / deimos**:
  generic rocky/icy parameterised by `BODY_LOOK[id]` (base colour, crater density, albedo variation).
- **apophis / bennu / didymos / kamooalewa / psyche / trojans / asteroid_belt / kuiper_belt**: irregular
  potato silhouette (radial noise), rubble texture, boulders.
- **jupiter / saturn / uranus / neptune / sun**: banded or plain discs (+ Saturn rings).
- Unknown id → `generic` (grey rocky).

### 1.4 Earth launch sites (textures.js `SITE_STYLE`)
`siteStyle` is resolved from `data/vehicle-art.json` (`vehicles[id].site` = geopolitics launchSites id):

| site id | style | look |
|---|---|---|
| canaveral, wallops | `florida` | flat scrub + marsh, Atlantic on the horizon, low palms, water tower, lightning masts |
| starbase | `bocachica` | dunes, mud flats, Gulf on horizon, launch mount + Mechazilla tower |
| vandenberg | `coastal_hills` | golden hills, Pacific fog bank |
| wenchang | `wenchang` | tropical coast, coconut palms, gantry with umbilicals |
| sriharikota | `sriharikota` | coastal scrub, Bay of Bengal, tall umbilical tower |
| kourou | `kourou` | dense green jungle hills, humid haze, ELA mobile gantry |
| baikonur | `steppe` | endless beige steppe, Soyuz "tulip" support arms, flame trench |
| vostochny | `taiga` | dark conifer forest, flame trench, grey sky |
| jiuquan | `desert` | Gobi gravel, distant mountains, tall white service tower |
| xichang | `mountains` | green mountains close, valley haze |
| tanegashima, uchinoura | `island` | green cliffs, ocean, Yoshinobu pad |
| mahia | `peninsula` | green grassland, cliff, Pacific |
| (anything else) | `generic` | grassland + concrete pad |

Tower types (`vehicles[id].tower`): `fss` (lattice fixed service structure + crew access arm),
`mechazilla` (OLIT with chopsticks + QD arm), `ml` (SLS mobile launcher, tall grey lattice with arms),
`gantry` (enclosed mobile gantry, rolled back), `umbilical` (simple umbilical mast), `tulip` (Soyuz
cradle arms that swing open at liftoff), `none`.

### 1.5 Animation beats (what must be visible)
- **Countdown/pad** (`mode:'pad'`): LOX venting from vent valves (white puffs streaming downwind), frost,
  tower arms connected, lightning masts, low sun haze. T−3..0: engine start transient (orange flash →
  clean kerolox/methalox flame), deluge water steam blooming sideways out of the flame trench.
- **Liftoff**: hold-down release thump (shake), slow first metres (tower arm swings away / Mechazilla
  stays), huge billowing steam/smoke clouds rolling outward along the ground then rising; camera follows.
- **Ascent 1–15 km**: plume with Mach diamonds (kerolox orange/yellow + soot tail, hydrolox nearly
  transparent with blue diamonds, methalox blue-violet core, solid = blinding white with thick white
  smoke trail). Contrail/smoke column below. Clouds pass with parallax.
- **Max-Q (≈10–14 km)**: condensation collar (Prandtl-Glauert vapor cone) flickering around the
  interstage/fairing; shake; plume still compact.
- **High altitude (> 30 km)**: plume expands (underexpanded, bell-shaped, translucent, wider than the
  vehicle; at > 80 km a huge faint "jellyfish" halo if the sun is low). Sky → black, stars fade in,
  Earth limb + curvature + airglow from ≥ 60 km.
- **Booster sep** (visual only, ~60% between liftoff and staging, if SRBs/side boosters): boosters yaw
  outward with small sep motor puffs, tumble and fall away.
- **Staging (MECO → sep → SES)**: engines cut (plume collapses in 0.2 s), cold-gas sep puffs + ullage
  thrusters, first stage drifts down and back, interstage falls; ~1.0 s later the upper-stage vacuum
  engine lights (bright, long, thin nozzle; very wide plume). Reusable first stages (`reuse:'droneship'|
  'rtls'|'catch'`): the falling stage flips (cold gas thruster puffs at the top), grid fins deploy, small
  boostback plume. Expendable stages tumble slowly.
- **Fairing / LES**: fairing halves clamshell open (rotate outward around their base hinge) then drift
  apart, tumbling; LES tower: small solid jettison motor fires, tower climbs away and arcs off.
- **Orbit (SECO)**: plume off, small RCS puffs, Earth limb wide, sunlit; spacecraft separation optional.
- **TLI**: upper stage relight, long plume, flash.
- **Explosion**: fireball (additive yellow→orange→dark red), expanding smoke (dark grey, lit on sun side),
  debris chunks with burning trails, shockwave ring in atmosphere, no gore. Escape: LES/SuperDraco
  plume pulling the capsule away, parachutes later.
- **Descent (Moon/Mars/...)**: terrain with ≥ 3 parallax layers approaching, dust picked up by the plume
  from ~30 m (radial sheets of regolith, straight ballistic in vacuum — no billowing on the Moon!,
  billowing on Mars/Titan/Earth), lander shadow converging with the lander, legs compressing on contact
  (spring damper 0.3 s), engine cutoff, dust settling (vacuum: falls fast; Mars: hangs).
- **Mars/Titan EDL**: entry plasma around the aeroshell (`entry`), supersonic chute (DGB, white/orange
  gores), backshell separation, powered descent.
- **Earth return**: re-entry plasma, drogues → 3–4 main chutes (striped), splashdown spray + ring waves,
  bobbing capsule.
- **Orbit arrival**: planet disc filling the view from below, slow terminator, retro burn plume pointing
  prograde, capture ellipse.

### 1.6 Performance budget (mid-range phone)
- DPR capped at 2 (already done by the scene). Target ≤ 6 ms/frame at 390×700 CSS px.
- **No per-pixel work per frame.** All noise is evaluated only when (re)building a cached texture.
  Cache keys: `body|kind|sizeBucket|lightBucket` (size buckets: 64, 128, 256, 512, 1024 px; light angle
  bucket: 16 steps). LRU with a byte budget of ~48 MB (w*h*4), evict oldest.
- Planets: cached sprite blitted (`drawImage`), rotation via a slowly scrolling cached equirect strip only
  for large discs, never per-pixel reprojection per frame.
- Gradients for materials are cached per (material, lightBucket, widthPx bucket).
- Particles: fixed pools (`cap`: 600 normal, 150 reduced motion). No object allocation per particle per
  frame. Smoke puffs drawn from 4 cached soft-puff sprites (tinted variants cached), not `arc` + blur.
  Never use `ctx.filter` or `shadowBlur` per particle.
- Reduced motion (`rs.reduce`): no shake, no flicker, fewer particles (×0.25), no twinkle, slower drift,
  instantaneous transitions are fine. Effects stay readable (plume is still drawn, static).

### 1.7 Determinism
All visual randomness uses a **local seeded PRNG** (`rng(seed)` from textures.js; seeds from
`hash(id)`), never `Math.random`. The same vehicle/body/site always looks the same; particles use the fx
system's own PRNG stream (seeded per scene from `rs.seed`). The sim is never touched.

---------------------------------------------------------------------------------------------------------

## 2. Conventions (all modules)

- **Screen space**: CSS pixels, origin top-left of the stage, **y down**. The scene has already applied
  `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`; renderer functions must not reset the transform (use
  `save()/restore()` and relative `translate/rotate/scale`). `view = { W, H }` in CSS px.
- **Vehicle-local space**: **metres, y up**, origin = centre of the base plane (exit plane of the lowest
  nozzle for launch vehicles; footpad plane for landers; bottom of the heat shield for capsules; geometric
  centre for probes/modules). Painters draw at the current ctx origin and convert with
  `canvasY = -yM * pxPerM`, `canvasX = xM * pxPerM`. Boosters sit at ±x (side view).
- **Angles**: radians, canvas convention (positive = clockwise on screen). Vehicle `tilt` = pitch from
  vertical, positive = nose toward +x (downrange, to the right).
- **Light**: `{ ax, ay }` unit vector, screen space, from object to sun. A painter that is drawn rotated
  by `tilt` receives the *screen* light plus `tilt` and counter-rotates internally.
- **Units**: altitude `altKm` (km), velocity `velKms` (km/s), distances in the world in metres,
  `pxPerM` (CSS px per metre), times in seconds.
- **Time**: `rs.t` = visual clock (seconds, monotone, already slowed in slow-motion / interventions);
  `rs.dt` = visual frame delta (already scaled, clamp ≤ 0.1). Event times are stored in `rs.t` units:
  `since(name) = rs.t - events[name]`.
- **Colours**: CSS strings. Use `rgba()` for alpha. Additive light (`globalCompositeOperation='lighter'`)
  only for flames, flashes, plasma and sun glare; always restore to `source-over`.
- **Node safety**: every module must import in Node without a DOM (tests import them). Touch `document`,
  `OffscreenCanvas`, `fetch` only inside functions, and degrade to no-ops when missing.
- **No exceptions out of draw calls**: unknown ids → fallbacks; NaN guards on numeric inputs.

---------------------------------------------------------------------------------------------------------

## 3. RenderState (built by launch-scene.js every frame)

```js
/** @typedef RenderState
 * view:    { W, H }                     CSS px of the stage
 * t, dt:   visual clock + delta (s)
 * reduce:  boolean                      prefers-reduced-motion / settings.reduceMotion
 * seed:    uint32                       hash(missionId + phase) — per-scene visual seed
 * mode:    'pad' | 'ascent' | 'descent' | 'orbit'
 *          pad     = countdown view (window to the pad; scene still draws control-room chrome itself)
 *          ascent  = phase 'ascent' after T-0
 *          descent = phase 'arrival', landing kinds (Moon/Mars/Titan surface, Earth splashdown)
 *          orbit   = phase 'arrival', capture/flyby kinds
 * phase:   'ascent' | 'arrival'
 * tele:    { altKm, velKms, met }       telemetryAt(S.profile, S.clock) (+ metAt)
 * clock:   S.clock (animation clock, s)
 * progress: 0..1 = clock / profile.times[last]  (orbit framing, descent pacing)
 * cd:      countdown seconds left (mode 'pad'), else null
 * vehicleId, craftId                    data ids (may be null/unknown → fallbacks)
 * landerId: spacecraft id of the partner lander when the mission's craft cannot land (Orion → HLS);
 *          null → index.descentCraftId() falls back to generic_lander / generic_mars_lander
 * crewed:  boolean
 * bodyId:  destination body ('moon', 'mars', ...)  — what we fly to
 * world:   body drawn under the vehicle  ('earth' on ascent and splashdown, else bodyId; titan for titan)
 * siteId:  geopolitics launch site id or null (renderer resolves from vehicle art when null)
 * weather: { risk 0..100, label }       pad mood: clouds, rain, wind
 * flags:   { engineOn, staged, fairingOff, exploded, escaped, landed, chute, inOrbit, hold, boostersOff? }
 *          (boostersOff is optional: the composer derives it from events.boosterSep || staged)
 *          (exactly the scene's S.* flags; the renderer must draw a consistent picture from flags alone,
 *           so resume/replay mid-flight works without events)
 * events:  { [name]: tAt }              rs.t when each event fired this scene (see §4); absent = not yet
 * light:   { ax, ay } | undefined       override; default from textures.sunFor(mode, world, siteId)
 */
```

## 4. Events (scene → renderer)

`R.event(name, payload?)` is called by launch-scene.js at the moment the scene presents a milestone (and
also during replay). Mapping (same regexes the scene already uses in `present()` / `deriveVehicleState()`):

| milestone id / scene moment | event | payload |
|---|---|---|
| countdown reaches T−3 | `ignition` | — |
| `ignition` ok | `ignition` (idempotent) | — |
| `liftoff` ok (or S.clock crosses liftoff time) | `liftoff` | — |
| `maxq` presented | `maxq` | `{ status }` |
| (visual only) 60% of the way from liftoff to staging, vehicle has `boosters` | `boosterSep` | — |
| `/stag|separ|meco/` ok | `staging` | `{ status }` |
| `/fairing|les|coifa/` ok | `fairing` (renderer decides LES tower vs fairing from the stack) | — |
| `/orbit/` ok in ascent | `seco` | — |
| `/tli/` ok | `tli` | — |
| failure → explode() | `explode` | `{ x, y }` optional screen pos |
| abort with escape | `escape` | — |
| `/parachute|paraq/` | `chute` | — |
| `/powered|descent|descida/` | `powered` | — |
| `/entry|reentry/` arrival | `entry` | — |
| final arrival milestone, landing | `touchdown` | `{ hard: boolean }` |
| final arrival milestone, world earth | `splashdown` | — |
| final arrival milestone, orbit kind | `capture` | — |
| any anomaly stamp | `anomaly` | `{ severity: 0..1 }` (shake + flicker) |
| replay start / scene reset | `R.reset()` | — |

Events are idempotent (a second `staging` is ignored). The renderer records `events[name] = rs.t` itself
(the scene may also pass `rs.events` explicitly; the renderer merges).

---------------------------------------------------------------------------------------------------------

## 5. Module contracts

### 5.0 index.js — scene composer (integrator)

```js
export function createLaunchRenderer(opts?: { seed?: number, cap?: number }): LaunchRenderer
LaunchRenderer = {
  reset(): void                                   // forget events, particles, debris, camera
  event(name: string, payload?: object): void     // §4 (needs the latest rs; uses last update's rs.t)
  update(rs: RenderState): void                   // advance camera/fx/debris by rs.dt; emits particles
  draw(ctx: CanvasRenderingContext2D, rs): void   // whole canvas for modes ascent/descent/orbit
  drawPadWindow(ctx, rect: {x,y,w,h}, rs): void   // the countdown window view (pad, rocket, venting)
  vehicleScreenPos(rs): { x, y }                  // where the vehicle is (for stamps / bursts)
  stats(): { particles, textures, bytes }         // debug
}
export function descentCraftId(rs): string   // craft drawn in a descent (lander / capsule / fallback)
export { SUN } from './textures.js'; export { loadVehicleArt, setVehicleArt } from './vehicles.js'
```
launch-scene.js integration (later step): in `createScene` create `R = createLaunchRenderer({ seed })`;
in `frame()` build `rs` and call `R.update(rs)` once per frame then `R.draw(g, rs)` instead of
`drawAscent/drawDescent/drawOrbitArrival`; `drawControlRoom` calls `R.drawPadWindow(g, rect, rs)` for
the window; `separateStage/dropFairing/explode/escape/touchdown/present` call `R.event(...)`;
`startReplay` calls `R.reset()`. The scene keeps its HUD, DOM, confetti/result fx and S.flash overlay.

### 5.1 textures.js (builder: textures)

```js
// PRNG + noise (pure, Node-safe)
export function hash(str: string): number                         // FNV-1a uint32
export function rng(seed: number): () => number                   // mulberry32, [0,1)
export function noise2(x, y, seed=0): number                      // value noise, smooth, [0,1]
export function fbm(x, y, { oct=5, lac=2, gain=0.5, seed=0 }={}): number            // [0,1]
export function ridged(x, y, { oct=5, lac=2, gain=0.5, seed=0 }={}): number         // [0,1], sharp ridges
export function worley(x, y, seed=0): number                      // F1 distance to nearest cell point, ~[0,1]

// canvases + cache
export function makeCanvas(w, h): HTMLCanvasElement | OffscreenCanvas | null        // null in Node
export function cached(key: string, w, h, paint: (ctx, w, h) => void): canvas | null  // LRU cache
export function clearTextureCache(): void
export function textureStats(): { count, bytes }
export function sizeBucket(px: number): number                    // 64|128|256|512|1024|2048
export function lightBucket(light): number                        // 0..15

// lighting
export const SUN: { ax, ay }                                      // default sun (upper left)
export function sunFor(mode, world, siteId?): { ax, ay }

// bodies
export const BODY_LOOK: Record<bodyId, { kind:'earth'|'rocky'|'icy'|'cloudy'|'haze'|'gas'|'ring'|'star'|'small',
   base: string, palette: string[], craters: 0..1, atmosphere: { color, thickness } | null,
   sky: [zenith, horizon] | null, dust: string }>
export function bodyLook(bodyId): BODY_LOOK entry (falls back to 'generic')
export function drawPlanetDisc(ctx, bodyId, cx, cy, r, { light=SUN, rot=0, t=0, clouds=true }={}): void
   // r = radius in screen px. Sphere with texture, terminator, limb darkening / atmosphere glow.
   // Uses cached sprite at sizeBucket(2r) + lightBucket.
export function drawEarthLimb(ctx, view, { altKm, light, t, tilt=0 }={}): { horizonY }
   // Curved Earth seen from altKm (visible ≥ ~30 km, fully ≥ 100 km): ocean/land/clouds texture strip,
   // curvature radius grows smaller with altitude, atmosphere glow band (thin blue → black), airglow.
export function skyColors(world, altKm, { sunElev=0.5, weather=null }={}): { zenith, horizon, haze, starAlpha }
export function drawSky(ctx, view, world, altKm, opts?): void     // full-screen gradient + haze + sun glare
export function drawStarfield(ctx, view, { alpha, drift=0, t=0, seed=1, reduce=false }={}): void
   // cached star sprite (2 layers, milky band), scroll by drift (px)

// Earth ground + pad
export const SITE_STYLE: Record<siteId, styleId>
export function siteStyleOf(siteId): styleId                       // 'generic' fallback
export function drawLaunchSite(ctx, view, { style, groundY, pxPerM, t, tower, towerArm=1, towerHeightM=80, reduce }): void
   // ground plane + horizon + water/vegetation + flame trench + pad + tower (NOT the vehicle).
   // groundY = screen y of the pad surface; pxPerM = vehicle scale (tower drawn to real height ~ 1:1 with
   // vehicle). towerArm 1 = crew/umbilical arm connected, 0 = retracted (animate over 1.5 s after liftoff).
export function drawClouds(ctx, view, { altKm, pxPerKm, anchorY, drift, t, coverage=0.4, world='earth' }): void
   // cloud decks at real altitudes (cumulus 1–3 km, cirrus 8–11 km); deck screen y =
   // anchorY - (deckAltKm - altKm) * pxPerKm. Cached cloud sprites, parallax by drift.

// landing terrain
export function drawTerrain(ctx, view, world, { altM, pxPerM, groundY, scrollX=0, t=0, seed, light }): void
   // Parallax layers for the landing site of `world` (moon/mars/mercury/europa/titan/ganymede/callisto/
   // phobos/asteroids/generic; 'earth' = ocean with swell). groundY = screen y of the touchdown point
   // (computed by camera.descentFrame). Far layers move with factor 0.15/0.4, near plane 1.0 (perspective:
   // the near plane is a trapezoid widening toward the bottom of the screen). Rocks/craters cached.
export function drawGroundShadow(ctx, x, groundY, { widthPx, heightAboveM, pxPerM, light, world }): void
```

### 5.2 vehicles.js + data/vehicle-art.json (builder: vehicles)

`data/vehicle-art.json` (owned by the vehicles builder; never add art fields to vehicles.json):
```jsonc
{ "version": 1,
  "vehicles": { "<vehicleId>": VehicleArt, ... },        // every id in data/vehicles.json
  "families": { "<familyId>": VehicleArt },             // fallbacks (e.g. "medium_kerolox")
  "craft":    { "<spacecraftId>": CraftArt, ... },      // every id in data/spacecraft.json
  "craftKinds": { "capsule"|"lander"|"probe"|...: CraftArt } }
VehicleArt = {
  "name": "Falcon 9", "family": "falcon",
  "site": "canaveral",                 // geopolitics launchSites id → SITE_STYLE
  "tower": "fss",                      // §1.4 tower types
  "reuse": "droneship"|"rtls"|"catch"|null,   // first-stage recovery shown after staging
  "heightM": 70, "diameterM": 3.66,    // reference values (tests check the parts add up ±15%)
  "parts": [ Part, ... ],              // bottom → top, the launch stack WITHOUT payload
  "payloadTop": 58.3,                  // y (m) where the payload stack sits
  "fairing": Part | null,              // used when the craft is not a crewed capsule on top
  "crewTop": "craft" | "integrated"    // 'integrated': upper stage IS the craft (Starship)
}
Part = { "id": "s1", "role": "stage"|"interstage"|"booster"|"upper"|"fairing"|"adapter"|"les"|"nose",
  "y": 0, "len": 41.2, "d": 3.66, "dTop": 3.66, "x": 0,           // metres; x≠0 for side boosters
  "mat": "white_paint", "soot": 0.6, "frost": 0.5,
  "nose": "ogive"|"cone"|"flat"|"blunt"|null,                       // shape of the top end
  "engines": { "n": 9, "prop": "kerolox"|"hydrolox"|"methalox"|"solid"|"hypergolic",
               "bellD": 0.9, "bellLen": 1.2, "layout": "octaweb"|"cluster"|"single"|"pair"|"ring", "vac": false },
  "gridFins": true, "legs": 4, "fins": 0,
  "sep": "boosterSep"|"staging"|"fairing"|null,                     // event that detaches it
  "marks": [ { "type": "band"|"text"|"flag"|"stripe"|"logo", "y": 30, "h": 2, "color": "#1b1d21", "text": "SpaceX" } ] }
CraftArt = { "name", "template": "capsule"|"capsule_sm"|"lander"|"starship"|"probe"|"rover"|"module"|"rotorcraft"|"aeroshell",
  "heightM", "widthM", ...template params (see stubs/JSON) ,
  "onStack": [ Part, ... ] | null }    // capsule + trunk/ESM + LES as stack parts (crewed tops)
```

```js
export const MATERIALS: Record<matId, { base, dark, light, spec, shin, rough }>
export function setVehicleArt(json): void                         // inject (tests, preview)
export function loadVehicleArt(url?): Promise<json>               // fetches data/vehicle-art.json once
export function vehicleArt(vehicleId, vehicleData?): VehicleArt   // never null: explicit → family → generic
export function craftArt(craftId, craftData?): CraftArt           // never null: explicit → kind → generic
export function listVehicleArtIds(): string[]
export function listCraftArtIds(): string[]
export function resolveStack(vehicleId, craftId, { crewed, vehicleData, craftData }): Stack
   // Stack = { id, heightM, maxWidthM, parts: Part[] (vehicle parts + payload parts on top),
   //          art: VehicleArt, craft: CraftArt, hasBoosters, hasLES, site, tower, reuse }
   // Payload: crewed capsule → craft.onStack parts at payloadTop; Starship → integrated; else fairing.
export function attachedParts(stack, flags: { boostersOff, staged, fairingOff }): Part[]
export function detachedBy(stack, eventName): Part[]               // parts that leave on that event
export function activeNozzles(stack, flags): Array<{ x, y, d, prop, vac }>   // vehicle metres, y up;
   // the engines that burn now (boosters + core before staging, upper after). y = nozzle exit (≤ 0 ok).
export function paintVehicle(ctx, stack, { pxPerM, light, tilt=0, flags, frost=0, t=0, reduce=false }): { topM, widthM }
   // Draws attached parts at the ctx origin (base centre), y up. Includes engines/bells, grid fins (deployed
   // after staging only on the falling stage), legs folded, markings, soot, frost speckle.
export function paintPart(ctx, stack, part, { pxPerM, light, tilt=0, finsOut=false, legsOut=0 }): void
   // A single detached part with its own origin at the part's base centre (for debris/boosters/fairings).
   // Fairing halves: part.id + ':L' / ':R' draw one half each (origin at the half's base hinge).
export function paintCraft(ctx, craft, { pxPerM, light, mode='flight'|'entry'|'chute'|'landed'|'stack',
   legs=1 (0 folded..1 deployed), compress=0 (0..1 leg stroke), engineOn=false, t=0, heading=0 }): { heightM, widthM, nozzles }
   // Draws a spacecraft at the ctx origin (landers: footpads at y=0; capsules: heat-shield bottom at y=0;
   // probes: centre). heading = rotation for probes (0 = engine pointing +x).
export function craftKindOf(craftData): 'capsule'|'lander'|'probe'|'cargo'|'station_module'|'rover'|'satellite'
```

### 5.3 fx.js (builder: fx)

```js
export function ambientPressure(world, altKm): number   // bar. earth 1.013·e^(-h/8.5), mars 0.006·e^(-h/11.1),
                                                        // titan 1.47·e^(-h/20), venus 92·e^(-h/15.9), else 0
export function expansionOf(pBar): number               // 0 sea level .. 1 vacuum (plume widening factor)
export const PROPELLANT: Record<prop, { core, mid, tail, smoke, diamonds, luminous }>  // plume palettes

export function drawPlume(ctx, nozzle: { x, y, d }, { prop, pBar, throttle=1, pxPerM, t, angle=0,
   lengthM?, reduce=false, seed=0 }): void
   // Pure painter at screen coords (nozzle.x/y in screen px, d in metres). angle = exhaust direction
   // (0 = straight down the screen). Sea level: narrow, bright, Mach diamonds (count by pBar), kerolox
   // soot tail; vacuum: wide translucent bell, faint. Flicker deterministic from t+seed.
export function drawCondensationCollar(ctx, x, y, radiusPx, { intensity 0..1, t, angle=0 }): void
export function drawParachutes(ctx, x, y, { count=1|3|4, kind='main'|'drogue'|'dgb', deploy 0..1, t,
   pxPerM, sway=0, colors? }): void   // canopies above (x,y)=riser confluence point (screen px)
export function drawReentryPlasma(ctx, x, y, { intensity 0..1, radiusPx, angle, t }): void
export function drawFlash(ctx, view, { color, alpha }): void

export function createFx({ cap=600, seed=1, reduce=false }={}): Fx
Fx = {
  update(dt): void                  // integrate, age, recycle
  draw(ctx, layer: 'back'|'front'): void   // back = smoke/steam/dust behind the vehicle; front = sparks/fire
  shift(dx, dy): void               // move world-anchored particles (camera moved)
  clear(): void; count(): number; setReduce(b): void
  // emitters (positions in screen px; rates per second; call every update with dt)
  exhaust(x, y, { angle, prop, pBar, pxPerM, dt, rate=1, d }): void      // smoke/contrail trail
  padBillow(x, groundY, { intensity 0..1, dt, pxPerM, deluge=true }): void // steam/smoke rolling sideways
  vent(x, y, { dir=1, dt, rate=1 }): void                                 // LOX boil-off puffs
  rcs(x, y, angle): void                                                  // one small cold-gas puff
  staging(x, y, { angle, pxPerM }): void                                  // sep flash + ullage/cold-gas puffs
  fairingPuff(x, y, { angle, pxPerM }): void
  landingDust(x, groundY, { intensity 0..1, world, pxPerM, dt }): void    // vacuum = ballistic sheets
  explosion(x, y, { scale=1, world }): void                               // fireball + smoke + sparks
  splash(x, waterY, { scale=1 }): void
  addDebris({ paint(ctx), x, y, vx, vy, rot=0, vr=0, life=6, gravity=60, drag=0.1, trail? }): void
     // paint draws the piece at its own origin (e.g. vehicles.paintPart closure). Units px, px/s.
}
```

### 5.4 camera.js (builder: camera + integrator)

```js
export function createCamera(): Camera
Camera = { shake(amount 0..2): void, update(dt, reduce): void, offset(): { x, y }, rot(): number }
export function ascentFrame(rs, stackHeightM): { pxPerM, anchorX, anchorY, tilt, groundY, pxPerKm, drift }
   // pxPerM: at the pad the stack fills ~44% of H; zooms out gently with altitude (×0.6 by 40 km).
   // anchor = screen point of the vehicle base. groundY = anchorY + altM * pxPerM (off-screen fast).
   // pxPerKm = compressed scale for clouds/limb parallax. tilt = gravity turn (0 → ~1.1 rad at orbit).
   // drift = accumulated horizontal parallax px (for stars/clouds).
export function descentFrame(rs, craftHeightM): { pxPerM, craftX, craftY, groundY, horizonY, scrollX, landedY }
   // craft fills ~22% of H; groundY approaches craftY as altitude → 0 (log mapping like today's scene).
export function orbitFrame(rs): { cx, cy, r, craftX, craftY }      // planet disc framing for 'orbit'
export function padFrame(rect, stackHeightM): { pxPerM, baseX, groundY }
export function parallax(depth, x): number                       // x * depth
```

---------------------------------------------------------------------------------------------------------

## 6. Preview harness (tools/launch-preview.html)

Serve the repo (`http://localhost:8130/tools/launch-preview.html`) and pass URL params:
`?vehicle=falcon9&craft=crew_dragon&body=moon&scene=landing&t=3.2&w=375&h=812&crewed=1&site=canaveral`
- `scene`: `pad|countdown|liftoff|maxq|staging|boostersep|fairing|orbit|tli|descent|landing|touchdown|
  explosion|escape|splashdown|entry|chute|arrival` — builds a RenderState + replays the events at fixed
  1/60 s steps from the scene start to `t` seconds after the scene's key moment, so particles are
  deterministic and screenshots reproducible.
- `gallery=vehicles|craft|bodies|terrain|sites|plumes` draws every entry in a labelled grid.
- `dpr=1|2`, `reduce=1`, `anim=1` (play live from `t`), `seed=N`.
The harness imports the renderer modules directly; it never loads game state. It reuses
`buildProfile/telemetryAt/metAt` from launch-scene.js so altitudes/timings match the game exactly.
**Service worker caveat:** the game registers `sw.js` on the same origin; if the harness URL shows the game
shell instead, unregister it (DevTools → Application → Service workers) and reload.

## 8. Status after the architect pass
All modules are **working stubs**: complete exports, correct coordinate conventions, real proportions from
data/vehicle-art.json, deterministic fx, but deliberately plain art. launch-scene.js is NOT wired yet (the
integrator does that last, see §5.0). Known integration notes:
- The ascent animation compresses time (liftoff → Max-Q in ~10 s, alt 0.06 → 12 km). Camera/pad framing
  must look right under that compression (ground leaves the screen within ~1 s after liftoff + 1 s).
- launch-scene.js keeps its own S.particles for confetti/sparks/result fx; the renderer owns everything else.
- If launch-scene.js imports index.js statically, add the new modules to index.html modulepreload
  (tests/sw-pwa.test.mjs tolerates at most 3 missing preloads) — or import it dynamically with a fallback
  to the old drawing code.

## 7. Tests
`tests/launch-render.test.mjs` (new): modules import in Node; every `data/vehicles.json` and
`data/spacecraft.json` id resolves to art; stacks add up to `heightM` (±15%); `noise/rng` deterministic;
`activeNozzles` non-empty before SECO; no `Math.random` in `src/ui/launch-render/*.js`.

---------------------------------------------------------------------------------------------------------

## 8. Visual review round 1 — contract additions

- `vehicles.js` `craftNozzles(craft, opts)` → nozzle exits `{ x, y, d, prop, angle, lengthM? }` in craft-local
  metres for the same paint options as `paintCraft` (dry run on a no-op context, cached). The composer draws
  descent plumes from these, so flames always leave the real nozzle exits (HLS: mid-body landing thrusters).
- `textures.js` `drawCloudsFront(ctx, view, { altKm, pxPerKm, anchorY, t, coverage, light, reduce })`: veil +
  near puffs while the vehicle crosses a cloud deck (call after the vehicle).
- `textures.js` `drawGroundShadow(…, { objHeightM, objWidthM })`: tall craft (height > 2.2 × width) cast a
  projected strip shadow away from the sun (hard-edged on airless bodies); others keep the soft ellipse.
- Big planet discs (orbit arrival) are refined by a screen-resolution "cap" (`drawDiscCap`, internal):
  procedural craters / Europa lineae / regolith detail generated progressively (≈9 ms per live frame) in
  normalised disc coordinates and reused while the disc grows.
- `fx.addDebris({ …, ax, ay, rel, tick })`: extra acceleration (px/s²), `rel` = lives in the tracked vehicle's
  frame (not moved by `shift`), `tick(o, dt, fx)` per update. `fx.jet(x, y, angle, { ppm, hot, len })`: BSM /
  cold-gas jet. `fx.explosion(…, { dir })`: debris biased along the flight direction.
- Landings: over the last 5 % of the arrival timeline the picture eases the visual altitude to 0 (the sim's
  telemetry can still read tens of metres at the touchdown milestone). Presentation only.
