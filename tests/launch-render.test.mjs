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
