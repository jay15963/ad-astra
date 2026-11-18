// Launch Day renderer (src/ui/launch-render): contract smoke tests. DOM-free (Node): modules import, art data
// covers every vehicle/spacecraft id, stacks add up to real heights, noise is deterministic, no Math.random.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const ART = read('data/vehicle-art.json');
const VEHICLES = read('data/vehicles.json').vehicles;
const CRAFT = read('data/spacecraft.json').spacecraft;
const RENDER_DIR = path.join(root, 'src', 'ui', 'launch-render');

const tex = await import('../src/ui/launch-render/textures.js');
const veh = await import('../src/ui/launch-render/vehicles.js');
const fx = await import('../src/ui/launch-render/fx.js');
const cam = await import('../src/ui/launch-render/camera.js');
const idx = await import('../src/ui/launch-render/index.js');
veh.setVehicleArt(ART);

test('renderer modules import in Node and export the README contract', () => {
  for (const n of ['hash', 'rng', 'noise2', 'fbm', 'ridged', 'worley', 'makeCanvas', 'cached', 'clearTextureCache', 'textureStats', 'sizeBucket', 'lightBucket',
    'sunFor', 'bodyLook', 'drawPlanetDisc', 'drawEarthLimb', 'skyColors', 'drawSky', 'drawStarfield', 'siteStyleOf', 'drawLaunchSite', 'drawClouds', 'drawTerrain', 'drawGroundShadow']) {
    assert.equal(typeof tex[n], 'function', `textures.${n}`);
  }
  assert.ok(tex.SUN && tex.BODY_LOOK && tex.SITE_STYLE);
  for (const n of ['setVehicleArt', 'loadVehicleArt', 'vehicleArt', 'craftArt', 'listVehicleArtIds', 'listCraftArtIds', 'resolveStack', 'attachedParts', 'detachedBy', 'activeNozzles', 'paintVehicle', 'paintPart', 'paintCraft', 'craftKindOf']) {
    assert.equal(typeof veh[n], 'function', `vehicles.${n}`);
  }
  assert.ok(veh.MATERIALS.white_paint && veh.MATERIALS.stainless && veh.MATERIALS.orange_foam);
  for (const n of ['ambientPressure', 'expansionOf', 'drawPlume', 'drawCondensationCollar', 'drawParachutes', 'drawReentryPlasma', 'drawFlash', 'createFx']) assert.equal(typeof fx[n], 'function', `fx.${n}`);
  for (const n of ['createCamera', 'ascentFrame', 'descentFrame', 'orbitFrame', 'padFrame', 'parallax']) assert.equal(typeof cam[n], 'function', `camera.${n}`);
  const R = idx.createLaunchRenderer({ seed: 1 });
  for (const n of ['reset', 'event', 'update', 'draw', 'drawPadWindow', 'vehicleScreenPos', 'stats']) assert.equal(typeof R[n], 'function', `renderer.${n}`);
});

test('every launcher and spacecraft in data has explicit art', () => {
  for (const v of VEHICLES) assert.ok(ART.vehicles[v.id], `vehicle-art.json misses vehicle ${v.id}`);
  for (const c of CRAFT) assert.ok(ART.craft[c.id], `vehicle-art.json misses spacecraft ${c.id}`);
  // unknown ids still resolve to something drawable
  assert.ok(veh.vehicleArt('nope').parts.length > 0);
  assert.ok(veh.craftArt('nope', { kind: 'lander' }).template);
});

test('launch sites resolve to a known style and towers are known', () => {
  const sites = new Set(read('data/geopolitics.json').launchSites.map((s) => s.id));
  const towers = new Set(['fss', 'mechazilla', 'ml', 'gantry', 'umbilical', 'tulip', 'none']);
  for (const [id, a] of Object.entries(ART.vehicles)) {
    assert.ok(sites.has(a.site), `${id}: site ${a.site} is not a geopolitics launch site`);
    assert.notEqual(tex.siteStyleOf(a.site), 'generic', `${id}: site ${a.site} has no SITE_STYLE`);
    assert.ok(towers.has(a.tower), `${id}: tower ${a.tower}`);
  }
});

test('stacks add up to the real vehicle height (±15%) with real proportions', () => {
  for (const [id, a] of Object.entries(ART.vehicles)) {
    const st = a.refCraft ? veh.resolveStack(id, a.refCraft, { crewed: true }) : veh.resolveStack(id, null, {});
    const r = st.heightM / a.heightM;
    assert.ok(r > 0.85 && r < 1.15, `${id}: stack ${st.heightM.toFixed(1)} m vs ${a.heightM} m`);
    for (const p of st.parts) {
      assert.ok(p.len > 0 && p.d > 0 && Number.isFinite(p.y), `${id}.${p.id} dimensions`);
      if (p.engines) assert.ok(fx.PROPELLANT[p.engines.prop], `${id}.${p.id} propellant ${p.engines.prop}`);
      if (p.mat) assert.ok(veh.MATERIALS[p.mat], `${id}.${p.id} material ${p.mat}`);
    }
  }
});

test('staging logic: nozzles before and after staging, parts detach on their events', () => {
  for (const id of Object.keys(ART.vehicles)) {
    const st = veh.resolveStack(id, null, {});
    assert.ok(veh.activeNozzles(st, {}).length > 0, `${id}: first stage engines`);
    assert.ok(veh.activeNozzles(st, { staged: true }).length > 0, `${id}: upper stage engines`);
    assert.ok(veh.detachedBy(st, 'staging', {}).length > 0, `${id}: staging drops something`);
    if (st.hasBoosters) assert.ok(veh.detachedBy(st, 'boosterSep', {}).length > 0, `${id}: boosters`);
    assert.ok(veh.attachedParts(st, { staged: true, fairingOff: true }).length < st.parts.length, `${id}: fewer parts after staging`);
  }
  const f9 = veh.resolveStack('falcon9', 'crew_dragon', { crewed: true });
  assert.equal(f9.payload, 'craft');
  assert.ok(f9.heightM > 60 && f9.heightM < 70);
});

test('noise and PRNG are deterministic and bounded', () => {
  const a = tex.rng(42), b = tex.rng(42);
  for (let i = 0; i < 10; i++) assert.equal(a(), b());
  for (let i = 0; i < 200; i++) {
    const x = i * 0.37, y = i * 0.11;
    for (const v of [tex.noise2(x, y, 3), tex.fbm(x, y, { seed: 3 }), tex.ridged(x, y, { seed: 3 }), tex.worley(x, y, 3)]) assert.ok(v >= 0 && v <= 1, `noise in range: ${v}`);
  }
  assert.equal(tex.fbm(1.5, 2.5, { seed: 9 }), tex.fbm(1.5, 2.5, { seed: 9 }));
  assert.equal(tex.hash('moon'), tex.hash('moon'));
});

test('environment model: pressure falls with altitude, vacuum plumes expand', () => {
  assert.ok(fx.ambientPressure('earth', 0) > 1 && fx.ambientPressure('earth', 50) < 0.01);
  assert.equal(fx.ambientPressure('moon', 0), 0);
  assert.ok(fx.expansionOf(1.013) < 0.05 && fx.expansionOf(0) === 1);
});

test('particle system works without a DOM and respects its cap', () => {
  const sys = fx.createFx({ cap: 40, seed: 5 });
  for (let i = 0; i < 50; i++) sys.explosion(10, 10, { scale: 1 });
  assert.ok(sys.count() <= 40);
  for (let i = 0; i < 400; i++) sys.update(0.05);
  assert.equal(sys.count(), 0);
});

test('no Math.random in renderer code (visual determinism)', () => {
  for (const f of fs.readdirSync(RENDER_DIR).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(RENDER_DIR, f), 'utf8');
    assert.ok(!/Math\.random\s*\(/.test(src), `${f} calls Math.random()`);
  }
});

// ------------------------------------------------------------------ infrastructure (MISSIONS-V2 §7.3)
const infra = await import('../src/ui/launch-render/infra.js');
const STATION_IDS = ['st_core', 'st_lab', 'st_multiport', 'st_hab', 'st_node', 'st_solar', 'st_airlock', 'st_arm', 'st_logistics', 'st_cupola', 'st_inflatable', 'st_depot', 'st_centrifuge', 'st_shipyard', 'st_ring', 'st_cylinder'];
const BASE_IDS = ['bs_hab_small', 'bs_solar', 'bs_comms', 'bs_lab', 'bs_fission', 'bs_isru', 'bs_pad', 'bs_garage', 'bs_hab_large', 'bs_greenhouse', 'bs_dome', 'bs_factory', 'bs_mass_driver', 'bs_arcology', 'bs_megastructure'];
const VEH_IDS = ['vh_lrv', 'vh_drone', 'vh_crane', 'vh_excavator', 'vh_pressurized', 'vh_truck', 'vh_hopper', 'vh_crawler'];
const ISS = [['st_core', 1], ['st_node', 3], ['st_lab', 3], ['st_hab', 1], ['st_solar', 4], ['st_airlock', 1], ['st_cupola', 1], ['st_logistics', 1], ['st_arm', 1]].map(([id, n]) => ({ id, n }));

/** A canvas context that accepts every call (gradients, transforms, text) and counts the draws. */
function mockCtx() {
  const grad = { addColorStop() {} };
  let draws = 0;
  const target = {
    getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
    createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => null,
    measureText: () => ({ width: 10 }), getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    canvas: { width: 780, height: 1688 },
  };
  return new Proxy(target, {
    get(t, p) {
      if (p === '__draws') return draws;
      if (p in t) return t[p];
      if (/^(fill|stroke|drawImage|fillRect|strokeRect|fillText)/.test(String(p))) return () => { draws++; };
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}

test('infra art: every binding station / base module and surface vehicle has explicit art', () => {
  for (const id of [...STATION_IDS, ...BASE_IDS]) {
    assert.ok(ART.modules[id], `vehicle-art.json modules misses ${id}`);
    assert.equal(veh.moduleArt(id).fallback, false, id);
  }
  for (const id of STATION_IDS) assert.ok(ART.modules[id].shape, `${id} shape`);
  for (const id of BASE_IDS) assert.ok(ART.modules[id].kind && ART.modules[id].w > 0 && ART.modules[id].h > 0, `${id} kind/size`);
  for (const id of VEH_IDS) { assert.ok(ART.baseVehicles[id], `baseVehicles misses ${id}`); assert.ok(ART.baseVehicles[id].len > 0, id); }
  // unknown ids still draw (fallback by prefix)
  assert.equal(veh.moduleArt('st_future').shape, 'module');
  assert.equal(veh.moduleArt('bs_future').kind, 'hab');
  assert.equal(veh.baseVehicleArt('vh_future').kind, 'buggy');
  assert.equal(veh.moduleArt('st_lab'), veh.moduleArt('st_lab'), 'memoised (stable identity for sprite caches)');
});

test('layoutStation: deterministic, core at the origin, target port = first free +x port', () => {
  const a = infra.layoutStation(ISS, { seed: 7 }), b = infra.layoutStation(ISS, { seed: 7 });
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.equal(a.hash, b.hash);
  const core = a.parts.find((p) => p.id === 'st_core');
  assert.equal(core.x, 0); assert.equal(core.y, 0);
  assert.equal(a.port.dir, '+x'); assert.equal(a.port.free, true);
  assert.equal(a.port, a.ports.find((p) => p.free && p.dir === '+x'));
  for (const p of a.parts) {
    const vertical = Math.abs(Math.sin(p.rot || 0)) > 0.5;
    const right = p.x + (vertical ? p.d : p.len) / 2;
    assert.ok(right <= a.port.x + 1e-6, `${p.id} sticks out past the approach port`);
  }
  // nodes branch: labs on radial ports (rotated), one truss with a wing pair per st_solar, an arm
  assert.ok(a.parts.some((p) => p.id === 'st_lab' && Math.abs(p.rot) > 1), 'radial lab');
  assert.equal(a.truss.wings.length, 4);
  assert.ok(a.arm && a.arm.boom > 0);
  assert.ok(a.bbox.x1 > a.bbox.x0 && a.bbox.y1 > a.bbox.y0);
  assert.equal(infra.layoutStation(ISS, { seed: 8 }).parts.length, a.parts.length, 'the seed only flips radial sides');
  // a single core (Salyut) and an empty list still give a station with a port
  const sal = infra.layoutStation([{ id: 'st_core', n: 1 }]);
  assert.equal(sal.parts.filter((p) => p.shape === 'module').length, 1);
  assert.ok(infra.layoutStation([]).port, 'fallback module');
  assert.ok(infra.layoutStation([{ id: 'st_solar', n: 1 }]).truss, 'a non-axial first module waits for a chain');
  // ring / cylinder replace the centre; the approach port stays outside the ring
  const ring = infra.layoutStation([{ id: 'st_core', n: 1 }, { id: 'st_ring', n: 1 }]);
  const rp = ring.parts.find((p) => p.shape === 'ring');
  assert.ok(ring.port.x > rp.x + rp.r * 0.24, 'port beyond the ring');
  const cyl = infra.layoutStation([{ id: 'st_core', n: 1 }, { id: 'st_cylinder', n: 1 }]);
  assert.ok(cyl.parts.find((p) => p.shape === 'cylinder').x < 0, 'cylinder to the −x side');
  assert.ok(cyl.bbox.x1 - cyl.bbox.x0 > 1000);
  assert.ok(infra.layoutStation([{ id: 'st_hab', n: 500 }]).count <= 40, 'part cap');
});

test('dockPose: approach → hold → final → contact, docked / failure beats, berthing arm', () => {
  const tl = { start: 60, rv: 67, dock: 80 };
  let prev = Infinity;
  for (let c = 60; c <= 80; c += 0.25) {
    const p = infra.dockPose({ clock: c, t: c, tl });
    assert.ok(p.range <= prev + 1e-9, `range never grows while closing (clock ${c})`);
    assert.ok(Number.isFinite(p.range) && p.range >= 0);
    prev = p.range;
  }
  assert.ok(infra.dockPose({ clock: 60, t: 0, tl }).range >= 199);
  assert.equal(infra.dockPose({ clock: 67, t: 0, tl }).range, 30);
  assert.equal(infra.dockPose({ clock: 75, t: 0, tl }).phase, 'hold');
  assert.ok(infra.dockPose({ clock: 80, t: 0, tl }).range < 0.2);
  const d = infra.dockPose({ clock: 80, t: 100.2, tl, flags: { docked: true }, events: { dock: 100 } });
  assert.equal(d.range, 0); assert.equal(d.phase, 'docked'); assert.ok(d.flash > 0);
  assert.equal(infra.dockPose({ clock: 80, t: 5, tl, flags: { docked: true } }).flash, 0, 'resumed docked: no flash');
  const f1 = infra.dockPose({ clock: 80, t: 101, tl, flags: { dockFail: true }, events: { dockFail: 100 } });
  const f2 = infra.dockPose({ clock: 80, t: 104, tl, flags: { dockFail: true }, events: { dockFail: 100 } });
  assert.equal(f1.phase, 'drift'); assert.ok(f2.range > f1.range, 'drifts away after a glancing contact');
  assert.notEqual(infra.dockPose({ clock: 75, t: 3, tl, flags: { rvAnomaly: true } }).off, 0, 'anomaly wobble during the hold');
  const b0 = infra.dockPose({ clock: 74, t: 0, tl, seq: 'berth' }), b1 = infra.dockPose({ clock: 79, t: 0, tl, seq: 'berth' });
  assert.equal(b0.range, 10); assert.ok(b0.arm > 0 && b0.arm < 1);
  assert.ok(b1.armHold && b1.range < 10, 'the arm pulls the craft in');
});

test('releasePose: separation, arrays then radiators, stage departure burn, founding lights', () => {
  assert.equal(infra.releasePose({ released: false }).phase, 'attached');
  const a = infra.releasePose({ released: true, since: 0.5 }), b = infra.releasePose({ released: true, since: 1.6 }), c = infra.releasePose({ released: true, since: 4.5, founding: true });
  assert.ok(a.sep > 0 && a.arrays === 0);
  assert.ok(b.arrays > 0 && b.radiators === 0);
  assert.ok(c.stageBurn > 0 && Math.abs(c.stageRot) > 1.4 && !c.lights, 'engines turned away before the burn');
  assert.ok(infra.releasePose({ released: true, since: 6, founding: true }).lights);
  assert.equal(infra.releasePose({ released: true }).phase, 'done', 'resumed after the release');
});

test('layoutBase: counts by size tier, real modules first, founding shows only what is delivered', () => {
  const T = (tier, extra = {}) => infra.layoutBase({ kind: 'base', sequence: 'surface', sizeTier: tier, modules: [], bodyId: 'moon', ...extra }, { seed: 3 });
  const counts = [0, 1, 2, 3, 4, 5].map((t) => infra.baseCounts(T(t)));
  assert.ok(counts[0].hab >= 1 && counts[0].hab <= 2 && counts[0].solar === 2 && counts[0].mast === 1 && !counts[0].pad, 'tier 0: 1–2 habitats, 2 solar, a mast');
  assert.ok(counts[1].pad === 1 && counts[1].lab === 1 && counts[1].vehicles === 1, 'tier 1: pad, lab, a parked vehicle');
  assert.ok(counts[2].mound && counts[2].greenhouse && counts[2].tower, 'tier 2: buried habitat, greenhouse, comms tower');
  assert.ok(T(2).roads.length > 0 && T(1).roads.length === 0, 'roads from tier 2');
  assert.ok(counts[3].dome >= 3 && counts[3].garage && counts[3].plant && counts[3].vehicles >= 3, 'tier 3: domes, garage, mining rig, vehicles');
  assert.ok(counts[4].factory && counts[4].rail && counts[4].dome >= 5, 'tier 4: factory, mass driver, big domes');
  assert.ok(counts[5].arcology === 3 && counts[5].mega === 1, 'tier 5: arcologies + megastructure');
  for (let t = 1; t <= 5; t++) assert.ok(T(t).items.length >= T(t - 1).items.length, `tier ${t} ≥ tier ${t - 1}`);
  for (const it of T(5).items.filter((i) => i.band === 'horizon')) assert.ok(it.d > 2000, `${it.id} on the horizon`);
  // the base's own modules first, capped per tier
  const own = infra.baseCounts(T(0, { modules: [{ id: 'bs_hab_small', n: 10 }, { id: 'bs_pad', n: 3 }] }));
  assert.equal(own.hab, 2); assert.equal(own.pad, 1);
  // a base being founded: nothing generic, only the delivered payload
  const fresh = T(0, { newAsset: true, payload: { kind: 'base_module', moduleId: 'bs_hab_small' } });
  assert.equal(fresh.items.length, 0); assert.equal(fresh.vehicles.length, 0); assert.equal(fresh.pad, null);
  assert.equal(T(2, { vehicles: [{ id: 'vh_truck', n: 9 }] }).vehicles.length, 6, 'at most 6 vehicles drawn');
  assert.equal(T(3, { vehicles: [] }).vehicles.length, 0, 'a base that has no vehicles shows none (crate / crew instead)');
  assert.deepEqual(JSON.parse(JSON.stringify(T(4))), JSON.parse(JSON.stringify(T(4))), 'deterministic');
  assert.deepEqual([T(1).pad.x, T(1).pad.d], [0, 0], 'the pad sits under the lander');
});

test('vehicleStates: parked → drive to the lander after unload (≤ 9 s) → beside it; reduced motion parks them', () => {
  const lay = infra.layoutBase({ kind: 'base', sequence: 'surface', sizeTier: 3, modules: [{ id: 'bs_garage', n: 1 }], vehicles: [{ id: 'vh_truck', n: 1 }, { id: 'vh_lrv', n: 2 }, { id: 'vh_crawler', n: 1 }], payload: { kind: 'supply' } }, { seed: 1, landerW: 5 });
  const before = infra.vehicleStates(lay, { since: null });
  lay.vehicles.forEach((v, i) => { assert.equal(before[i].x, v.park.x); assert.equal(before[i].d, v.park.d); });
  assert.ok(infra.vehicleStates(lay, { since: 2 }).some((s) => s.moving));
  const end = infra.vehicleStates(lay, { since: 30 });
  lay.vehicles.forEach((v, i) => {
    if (!v.drives) { assert.equal(end[i].d, v.park.d, 'the crawler stays parked'); return; }
    assert.ok(end[i].arrived); assert.ok(Math.abs(end[i].x - v.slot.x) < 1e-6);
    assert.ok(Math.abs(v.slot.x) > lay.landerW / 2, 'beside the lander, not under it');
  });
  assert.ok(end.some((s) => s.loader), 'a loader picks up the crate');
  const parked = infra.vehicleStates(lay, { parked: true });
  lay.vehicles.forEach((v, i) => { if (v.drives) assert.ok(parked[i].arrived); });
  const rov = infra.layoutBase({ kind: 'base', sequence: 'surface', sizeTier: 1, payload: { kind: 'base_vehicle', vehicleTypeId: 'vh_pressurized', qty: 2 } }, { seed: 2 });
  assert.equal(rov.payloadVehicles.length, 2);
  assert.ok(infra.vehicleStates(rov, { since: 20 }).filter((s) => s.payload).every((s) => s.arrived), 'delivered vehicles roll out to the base');
});

test('groundProjection matches the terrain: the touchdown point sits at groundY with the descent scale', () => {
  const pr = infra.groundProjection({ W: 390, H: 844 }, { groundY: 700, pxPerM: 20, altM: 0, scrollX: 0 });
  const p = pr.project(0, 0);
  assert.ok(Math.abs(p.y - 700) < 1e-6 && Math.abs(p.s - 20) < 1e-6 && Math.abs(p.x - 195) < 1e-6);
  const far = pr.project(0, 500);
  assert.ok(far.y < p.y && far.y > pr.hor && far.s < p.s, 'farther = higher and smaller');
});

test('infra painters and the rendezvous / base scenes draw in Node without throwing', () => {
  const ctx = mockCtx();
  const light = tex.SUN;
  for (const id of STATION_IDS) assert.doesNotThrow(() => infra.paintModule(ctx, veh.moduleArt(id), { pxPerM: 3, light, unfold: 0.5 }), id);
  const lay = infra.layoutStation([...ISS, { id: 'st_ring', n: 1 }, { id: 'st_shipyard', n: 1 }, { id: 'st_depot', n: 1 }, { id: 'st_inflatable', n: 1 }, { id: 'st_centrifuge', n: 1 }]);
  for (const k of [0.3, 2, 14]) assert.doesNotThrow(() => infra.paintStation(ctx, lay, { pxPerM: k, light, t: 1 }));
  assert.doesNotThrow(() => infra.drawArm(ctx, lay, 4, light, { x: 20, y: 5 }));
  const view = { W: 390, H: 844 };
  const proj = infra.groundProjection(view, { groundY: 600, pxPerM: 20 });
  for (const world of ['moon', 'mars', 'titan']) {
    for (let tier = 0; tier <= 5; tier++) {
      const bl = infra.layoutBase({ kind: 'base', sequence: 'surface', sizeTier: tier, vehicles: [{ id: 'vh_truck', n: 1 }, { id: 'vh_drone', n: 1 }, { id: 'vh_hopper', n: 1 }, { id: 'vh_crane', n: 1 }, { id: 'vh_excavator', n: 1 }, { id: 'vh_pressurized', n: 1 }], payload: { kind: 'supply' } });
      assert.doesNotThrow(() => infra.drawBase(ctx, view, bl, { proj, light, t: 2, world, night: tier % 2 === 1 }), `${world} tier ${tier}`);
      assert.doesNotThrow(() => infra.drawBaseVehicles(ctx, view, bl, { proj, t: 2, since: 3, light, world, crewed: true }));
    }
  }
  assert.ok(ctx.__draws > 100, 'painters actually draw');
  // the composer: rendezvous (dock / berth / release / new module / lunar orbit) and a descent onto a base
  const R = idx.createLaunchRenderer({ seed: 3 });
  const base = { view, t: 1, dt: 1 / 60, reduce: false, seed: 3, phase: 'ascent', tele: { altKm: 410, velKms: 7.7, met: 1 }, clock: 70, progress: 0.9, vehicleId: 'falcon9', craftId: 'crew_dragon', crewed: true, bodyId: 'earth', world: 'earth', flags: { staged: true, fairingOff: true }, events: {} };
  const tISS = { kind: 'station', assetId: 'as_1', name: 'ISS', sequence: 'dock', modules: ISS, bodyId: 'earth', payload: { kind: null } };
  for (const target of [tISS, { ...tISS, sequence: 'berth' }, { kind: 'station', newAsset: true, sequence: 'release', modules: [], payload: { kind: 'station_module', moduleId: 'st_core' } }, { ...tISS, payload: { kind: 'station_module', moduleId: 'st_lab' } }, { ...tISS, bodyId: 'moon' }]) {
    for (const clock of [61, 70, 76, 80]) {
      const rs = { ...base, mode: 'rendezvous', target, clock, t: clock, dockT: { start: 60, rv: 67, dock: 80, release: 63 }, flags: { ...base.flags, docked: clock >= 80, released: clock >= 63 } };
      assert.doesNotThrow(() => { R.update(rs); R.draw(ctx, rs); R.vehicleScreenPos(rs); }, `${target.sequence} @${clock}`);
    }
    R.event('dock'); R.event('release');
  }
  const tBase = { kind: 'base', name: 'Base', sequence: 'surface', sizeTier: 3, modules: [{ id: 'bs_pad', n: 1 }, { id: 'bs_hab_small', n: 2 }], vehicles: [{ id: 'vh_truck', n: 1 }], bodyId: 'moon', payload: { kind: 'supply' } };
  for (const alt of [5, 0.4, 0.01, 0]) {
    const rs = { ...base, phase: 'arrival', mode: 'descent', world: 'moon', bodyId: 'moon', craftId: 'blue_moon_mk1', target: tBase, tele: { altKm: alt, velKms: 0.01, met: 1 }, flags: { engineOn: alt > 0, landed: alt === 0 }, t: 10 - alt };
    assert.doesNotThrow(() => { R.update(rs); R.draw(ctx, rs); }, `descent alt ${alt}`);
  }
  R.event('touchdown'); R.event('unload');
  assert.doesNotThrow(() => R.draw(ctx, { ...base, phase: 'arrival', mode: 'descent', world: 'moon', target: tBase, tele: { altKm: 0 }, flags: { landed: true }, t: 20 }));
  // a missing / malformed target never breaks the scenes
  assert.doesNotThrow(() => R.draw(ctx, { ...base, mode: 'rendezvous', target: null }));
  assert.doesNotThrow(() => R.draw(ctx, { ...base, mode: 'descent', world: 'moon', target: { kind: 'base', modules: 'x' } }));
  assert.equal(infra.resolveTarget(null), null);
  assert.equal(infra.resolveTarget({ kind: 'base' }).sequence, 'surface');
});

test('infra events are idempotent and recorded once', () => {
  const R = idx.createLaunchRenderer({ seed: 1 });
  const rs = { view: { W: 390, H: 844 }, t: 5, dt: 0, mode: 'rendezvous', phase: 'ascent', tele: { altKm: 410 }, clock: 70, flags: {}, events: {}, target: { kind: 'station', sequence: 'dock', modules: [{ id: 'st_core', n: 1 }] } };
  R.update(rs);
  for (const name of ['rendezvous', 'dock', 'berth', 'release', 'unload', 'dockFail', 'rvFail']) {
    R.event(name);
    const t0 = R.events()[name];
    R.update({ ...rs, t: 9 });
    R.event(name);
    assert.equal(R.events()[name], t0, `${name} recorded once`);
  }
  R.reset();
  assert.deepEqual(R.events(), {});
});

// ------------------------------------------------------------------ real sim snapshots (infra.sceneTarget → renderer)
test('real SceneTargets from the sim (infra.sceneTarget) resolve, lay out and draw: ISS dock/berth, first module, growing lunar base', async () => {
  const { loadDataNode } = await import('../src/core/data.js');
  const engine = await import('../src/core/engine.js');
  const sim = await import('../src/sim/infra.js');
  if (typeof sim.sceneTarget !== 'function' || typeof sim.deliver !== 'function') return; // infra.js not bound yet
  const c = await loadDataNode(root, { scenarioId: 'campaign', eras: 'all' });
  const at = (y) => ({ ...c, scenario: { ...c.scenario, start: { year: y, month: 0 }, startYear: y } });
  let k = 0;
  const M = (o) => ({ id: `lr_${++k}`, actorId: 'nasa', ...o });
  const craft = Object.values(c.index.spacecraft);
  const cap = craft.find((x) => x.kind === 'capsule')?.id;
  const cargo = craft.find((x) => x.kind === 'cargo' && x.docking !== 'auto')?.id;
  const out = [];
  { // ISS in 2012: crew rotation docks, a cargo ship is berthed by the arm
    const d = at(2012); const s = engine.newGame(d, { seed: 3, playerId: 'esa' });
    const iss = s.assets.list.find((a) => a.histId === 'iss');
    if (iss) {
      out.push(sim.sceneTarget(s, d, M({ actorId: 'esa', type: 'crewed', sub: 'rotation', destination: 'iss', spacecraftId: cap, payload: { targetAssetId: iss.id } })));
      out.push(sim.sceneTarget(s, d, M({ actorId: 'esa', type: 'cargo', sub: 'supply', destination: 'iss', spacecraftId: cargo, payload: { kind: 'supply', qty: 3, targetAssetId: iss.id } })));
    }
  }
  { // a station from scratch: release of the core, then the second module docks
    const d = at(1980); const s = engine.newGame(d, { seed: 3, playerId: 'nasa' });
    const first = { type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_core', newAsset: true, newAssetName: 'Aurora' } };
    out.push(sim.sceneTarget(s, d, M(first)));
    const { assetId } = sim.deliver(s, d, M(first));
    out.push(sim.sceneTarget(s, d, M({ type: 'station', destination: 'leo', payload: { kind: 'station_module', moduleId: 'st_lab', targetAssetId: assetId } })));
  }
  { // a lunar base growing from deliveries
    const d = at(2045); const s = engine.newGame(d, { seed: 3, playerId: 'nasa' });
    const site = 'lunar_south_pole';
    const { assetId } = sim.deliver(s, d, M({ type: 'cargo', sub: 'base_module', destination: site, payload: { kind: 'base_module', moduleId: 'bs_hab_small', newAsset: true } }));
    const add = (id) => sim.deliver(s, d, M({ type: 'cargo', sub: 'base_module', destination: site, payload: { kind: 'base_module', moduleId: id, targetAssetId: assetId } }));
    const snap = () => out.push(sim.sceneTarget(s, d, M({ type: 'cargo', sub: 'supply', destination: site, payload: { kind: 'supply', qty: 2, targetAssetId: assetId } })));
    add('bs_solar'); snap();
    ['bs_pad', 'bs_lab', 'bs_hab_large', 'bs_greenhouse', 'bs_comms', 'bs_fission', 'bs_isru'].forEach(add);
    sim.deliver(s, d, M({ type: 'cargo', sub: 'base_vehicle', destination: site, payload: { kind: 'base_vehicle', vehicleTypeId: 'vh_truck', qty: 2, targetAssetId: assetId } }));
    snap();
  }
  const targets = out.filter(Boolean);
  assert.ok(targets.length >= 4, `sim produced ${targets.length} scene targets`);
  const seqs = new Set(targets.map((t) => t.sequence));
  assert.ok(seqs.has('release') && seqs.has('surface') && (seqs.has('dock') || seqs.has('berth')), [...seqs].join(','));
  const ctx = mockCtx();
  const view = { W: 390, H: 844 };
  const R = idx.createLaunchRenderer({ seed: 5 });
  for (const t of targets) {
    const json = JSON.stringify(t);
    assert.deepEqual(JSON.parse(json), t, 'the snapshot is plain JSON (save / resume safe)');
    const r = infra.resolveTarget(t);
    assert.equal(JSON.stringify(t), json, 'resolveTarget never mutates the snapshot');
    assert.equal(r.sequence, t.sequence);
    for (const m of r.modules) assert.equal(m.art.fallback, false, `${m.id} has explicit art`);
    for (const v of r.vehicles) assert.equal(v.art.fallback, false, `${v.id} has explicit art`);
    if (r.kind === 'station') {
      const lay = infra.layoutStation(r.modules, { seed: 2 });
      assert.ok(lay.port && lay.port.free && lay.port.dir === '+x', 'an approach port');
      if (r.modules.length) assert.ok(lay.parts.some((p) => p.id === 'st_core'), 'the core is drawn');
      const rs = { view, t: 70, dt: 1 / 60, reduce: false, seed: 5, phase: 'ascent', mode: 'rendezvous', tele: { altKm: 410, velKms: 7.7, met: 1 }, clock: 72, progress: 0.9, vehicleId: 'falcon9', craftId: 'crew_dragon', bodyId: 'earth', world: 'earth', flags: { staged: true, fairingOff: true }, events: {}, target: t, dockT: { start: 60, rv: 67, dock: 80, release: 63 } };
      assert.doesNotThrow(() => { R.update(rs); R.draw(ctx, rs); }, `${t.sequence} ${t.name}`);
    } else {
      const lay = infra.layoutBase(r, { seed: 2 });
      const n = infra.baseCounts(lay);
      for (const m of r.modules.filter((x) => /hab|solar|pad|lab/.test(x.id))) assert.ok(lay.items.some((it) => it.id === m.id) || (m.id === 'bs_pad' && lay.pad), `${m.id} of the real base is drawn (${JSON.stringify(n)})`);
      assert.ok(lay.vehicles.length <= 6 && lay.vehicles.length === Math.min(6, r.vehicles.reduce((s, v) => s + v.n, 0)), 'real vehicles parked (≤ 6)');
      const rs = { view, t: 12, dt: 1 / 60, reduce: false, seed: 5, phase: 'arrival', mode: 'descent', world: r.bodyId, bodyId: r.bodyId, craftId: 'blue_moon_mk1', tele: { altKm: 0, velKms: 0, met: 1 }, flags: { landed: true }, events: {}, target: t };
      assert.doesNotThrow(() => { R.update(rs); R.draw(ctx, rs); R.event('touchdown'); R.event('unload'); R.draw(ctx, { ...rs, t: 16 }); }, `base tier ${t.sizeTier}`);
    }
  }
  const tiers = targets.filter((t) => t.kind === 'base').map((t) => t.sizeTier);
  assert.ok(tiers[tiers.length - 1] > tiers[0], `the lunar base grows a size tier (${tiers.join('→')})`);
});
