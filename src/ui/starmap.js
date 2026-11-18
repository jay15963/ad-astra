// Níveis profundos do mapa espacial (EXPANSION.md §8): "Setor" (as ~55 estrelas reais mais próximas, em 3D com
// hastes até o plano galáctico) e "Galáxia" (Via Láctea esquemática: braços, regiões, a bolha explorada e os nós de
// colonização). Névoa de guerra: estrelas são sempre "observadas" (telescópios), mas planetas só aparecem a partir do
// ano em que foram anunciados ou depois que uma sonda sua chega (src/sim/explore.js). A UI só lê o estado.
// Desenho em canvas 2D, sem animação contínua: só redesenha quando a câmera ou o estado mudam (bom para celulares).
// Funções puras exportadas para testes em Node.
import { makeRng } from '../core/rng.js';
// pure readers of the JSON state only (no writes): the sim owns `state.explored`; when the engine registers the
// explore module the view reads `explore/state` through the store instead (knownSets)
import { exploredIds, colonyList, starStatus, knownPlanets, hiddenPlanetCount } from '../sim/explore.js';

export { colonyList };

/**
 * What the player knows: {explored: Set, colonies: []}. Prefers the store query `explore/state` (engine module),
 * falls back to the same pure derivation from the state when the module is not registered.
 */
export function knownSets(state, data, query = null) {
  let q = null;
  try { q = query?.('explore/state'); } catch { q = null; }
  if (q && Array.isArray(q.explored)) return { explored: new Set(q.explored), colonies: Array.isArray(q.colonies) ? q.colonies : colonyList(state) };
  return { explored: exploredIds(state, data), colonies: colonyList(state) };
}

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const arr = (x) => (Array.isArray(x) ? x : []);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const num = (v, d = 1) => Number(v).toFixed(d).replace('.', ',');

// ------------------------------------------------------------------ data

let STARS = null;
let STARS_P = null;

/** Load data/core/stars.json once (browser). Resolves to null when offline / missing (the deep levels then hide). */
export function loadStars(url = './data/core/stars.json') {
  if (STARS) return Promise.resolve(STARS);
  if (!STARS_P) {
    STARS_P = (typeof fetch === 'function' ? fetch(url) : Promise.reject(new Error('sem fetch')))
      .then((r) => { if (!r.ok) throw new Error(`stars.json ${r.status}`); return r.json(); })
      .then((j) => { STARS = j; return j; })
      .catch(() => { STARS_P = null; return null; });
  }
  return STARS_P;
}
/** Already loaded stars data (or null). */
export const starsData = () => STARS;
/** Tests / Node: inject the parsed file. */
export function setStarsData(j) { STARS = j || null; STARS_P = null; }

/** Deep levels available at `year`: [{id:'sector'|'galaxy', name, short}] in zoom-out order. Pure. */
export function deepLevels(stars, year) {
  const lv = stars?.levels || {};
  const out = [];
  for (const id of ['sector', 'galaxy']) {
    const l = lv[id];
    if (l && Number.isFinite(year) && year >= (l.fromYear ?? Infinity)) out.push({ id, name: l.name || id, short: l.short || l.name || id });
  }
  return out;
}

// J2000 equatorial → galactic rotation (IAU): galactic x toward the centre (l = 0), y toward l = 90°, z to the NGP.
const EQ2GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];

/** Galactic cartesian position (light-years) of a star from ra (hours), dec (degrees) and ly. Pure. */
export function starXYZ(s) {
  const d = Number(s?.ly) || 0;
  if (!d) return [0, 0, 0];
  const ra = (Number(s.ra) || 0) * 15 * DEG;
  const dec = (Number(s.dec) || 0) * DEG;
  const e = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)];
  return EQ2GAL.map((row) => (row[0] * e[0] + row[1] * e[1] + row[2] * e[2]) * d);
}

/** Galactic longitude (degrees, 0..360) and latitude of a star. Pure. */
export function galacticLB(s) {
  const [x, y, z] = starXYZ(s);
  const r = Math.hypot(x, y, z) || 1;
  return { l: ((Math.atan2(y, x) / DEG) + 360) % 360, b: Math.asin(z / r) / DEG };
}

/**
 * Galaxy-map coordinates (ly, y down) of something at galactic longitude `l` and distance `d` from the Sun, with the
 * galactic centre at (0, 0), the Sun at (0, sunR) and the centre "up" on screen. Pure.
 */
export function galaxyXY(l, d, sunR = 26000) {
  const a = (Number(l) || 0) * DEG;
  const r = Number(d) || 0;
  return [-r * Math.sin(a), sunR - r * Math.cos(a)];
}

const specClass = (spec) => String(spec || 'M').trim()[0].toUpperCase();
const STAR_R = { O: 4.4, B: 4.2, A: 3.8, F: 3.4, G: 3.2, K: 2.8, M: 2.2, L: 1.7, T: 1.6, Y: 1.5, D: 1.8 };

/** pt-BR type line of a star ("anã vermelha · M5.5V"). Pure. */
export function starTypeText(stars, s) {
  if (s?.home) return 'Nossa estrela · G2V';
  const c = specClass(s?.spec);
  const name = stars?.spectral?.[c]?.name || 'estrela';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} · ${s?.spec || '?'}${s?.companions ? ` + ${s.companions}` : ''}`;
}

/** Travel time text to a star at a fraction of c ("42 anos a 10% da luz"). Pure. */
export function travelText(ly, fracC = 0.1) {
  if (!ly) return '';
  const y = ly / fracC;
  const pct = Math.round(fracC * 100);
  return `${y >= 100 ? Math.round(y / 10) * 10 : Math.round(y)} anos a ${pct}% da luz`;
}

/**
 * Model of the sector at `year`: stars with position, status (home/colony/surveyed/observed), known planets,
 * hidden-planet count and colonies; plus the explored radius. Pure.
 */
export function sectorModel(stars, state, data, year, known = knownSets(state, data)) {
  const { explored, colonies } = known;
  const list = arr(stars?.stars).map((s) => {
    const status = starStatus(s, explored, colonies);
    const c = specClass(s.spec);
    return {
      ...s, xyz: starXYZ(s), status, cls: c,
      color: s.home ? '#fff1c4' : stars?.spectral?.[c]?.color || '#ffffff',
      r: s.home ? 3.4 : STAR_R[c] || 2.2,
      planets: knownPlanets(s, year, status),
      hidden: hiddenPlanetCount(s, year, status),
      colonies: colonies.filter((k) => k.starId === s.id),
    };
  });
  const reach = Math.max(0, ...list.filter((s) => s.status === 'surveyed' || s.status === 'colony').map((s) => Number(s.ly) || 0));
  return { stars: list, reach, explored, colonies };
}

/** Galaxy model: arms as polylines (ly), bar, regions with fog, colonies with a galaxy position. Pure. */
export function galaxyModel(stars, state, data, sector = null) {
  const g = stars?.galaxy || {};
  const sunR = g.sunR || 26000;
  const R = g.radius || 52000;
  const k = Math.tan((g.pitchDeg || 12) * DEG);
  const th0 = Math.atan2(sunR, 0); // the Sun's polar angle around the centre (screen coords, y down)
  const arms = arr(g.arms).map((a) => {
    const pts = [];
    // arms start at the ends of the bar and fade out at the disc's edge (~1.2 turns each, like the real ones)
    const rMin = Math.max(2600, (g.bar?.halfLength || 9000) * 1.05);
    for (let t = -9; t <= 9; t += 0.035) {
      const r = a.rAtSun * Math.exp(k * t);
      if (r < rMin || r > R * 0.98) continue;
      const th = th0 + t;
      pts.push([Math.cos(th) * r, Math.sin(th) * r]);
    }
    return { id: a.id, name: a.name, pts, rAtSun: a.rAtSun };
  });
  let spur = null;
  if (g.spur) {
    const pts = [];
    for (let d = g.spur.fromDeg; d <= g.spur.toDeg; d += 0.5) {
      const th = th0 + d * DEG;
      const r = sunR + (g.spur.dr || 0) * (d / Math.max(1, Math.abs(g.spur.fromDeg)));
      pts.push([Math.cos(th) * r, Math.sin(th) * r]);
    }
    spur = { id: g.spur.id, name: g.spur.name, pts };
  }
  const known = sector ? null : knownSets(state, data);
  const explored = sector?.explored || known.explored;
  const colonies = sector?.colonies || known.colonies;
  const regions = arr(g.regions).map((r) => {
    const [x, y] = galaxyXY(r.l, r.d, sunR);
    const status = r.kind === 'home' ? 'home' : colonies.some((c) => c.regionId === r.id) ? 'colony' : explored.has(r.id) ? 'surveyed' : 'observed';
    return { ...r, x, y, status };
  });
  const starsById = Object.fromEntries(arr(stars?.stars).map((s) => [s.id, s]));
  const nodes = colonies.map((c) => {
    let at = null;
    if (c.galaxy) at = galaxyXY(c.galaxy.l, c.galaxy.d, sunR);
    else if (c.regionId && regions.find((r) => r.id === c.regionId)) { const r = regions.find((x) => x.id === c.regionId); at = [r.x, r.y]; }
    else if (c.starId && starsById[c.starId]) { const lb = galacticLB(starsById[c.starId]); at = galaxyXY(lb.l, starsById[c.starId].ly, sunR); }
    else if (c.bodyId) at = [0, sunR];
    return at ? { ...c, x: at[0], y: at[1] } : null;
  }).filter(Boolean);
  return { sunR, radius: R, arms, spur, bar: g.bar || null, regions, nodes, reach: sector?.reach || 0 };
}

/** Sector camera projection of a galactic point. cam = {yaw, pitch (rad), s (px/ly), cx, cy}. Pure. */
export function projectSector([x, y, z], cam) {
  const c = Math.cos(cam.yaw), sn = Math.sin(cam.yaw);
  const x1 = x * c - y * sn;
  const y1 = x * sn + y * c;
  const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
  return {
    x: cam.cx - y1 * cam.s,
    y: cam.cy - (x1 * sp + z * cp) * cam.s,
    y0: cam.cy - x1 * sp * cam.s, // foot of the stalk on the galactic plane
    depth: x1 * cp - z * sp,
  };
}

/** Greedy label declutter: keeps a label only if its box is free. items: {x, y, w, h, prio}. Pure. */
export function declutter(items, obstacles = []) {
  const taken = obstacles.slice();
  const out = [];
  const hit = (a) => taken.some((b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]);
  for (const it of items.slice().sort((a, b) => b.prio - a.prio)) {
    for (const [dx, dy] of [[8, -4], [8, 6], [-8 - it.w, -4], [-it.w / 2, -14 - it.h / 2]]) {
      const box = [it.x + dx, it.y + dy - it.h / 2, it.w, it.h];
      if (!hit(box)) { taken.push(box); out.push({ ...it, bx: box[0], by: box[1] }); break; }
    }
  }
  return out;
}

// ------------------------------------------------------------------ view controller

const STATUS_TEXT = { home: 'Nosso sistema', colony: 'Colônia', surveyed: 'Sondada', observed: 'Observada por telescópios' };
const KIND_TEXT = { home: 'Nosso lar', aglomerado: 'Aglomerado estelar', nebulosa: 'Nebulosa', estrela: 'Estrela notável', campo: 'Campo de observação', centro: 'Centro galáctico' };

/**
 * Deep view controller drawn on the space map's canvas. map.js owns the DOM, the sheet and the frame loop; it
 * routes pointer events here while a deep level is active.
 *   opts: { getState(), data, invalidate(), onSelect(sel|null), onLeave('in'|'out'), colorOf(actorId) }
 */
export function createDeepView(opts) {
  const V = { level: 'sector', yaw: -0.35, pitch: 58 * DEG, ly: 18, gcx: 0, gcy: null, gs: null, sel: null };
  let W = 0, H = 0, dpr = 1;
  let hits = [];
  let cacheKey = '';
  const cache = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const cg = cache?.getContext?.('2d') || null;
  let sectorM = null, galaxyM = null, modelVersion = -1, version = 0;
  const lv = () => starsData()?.levels?.[V.level] || {};

  function models() {
    if (modelVersion === version && sectorM) return;
    const st = opts.getState() || {};
    const year = (st.startYear ?? 2026) + Math.floor((st.turn ?? 0) / 52);
    sectorM = sectorModel(starsData(), st, opts.data, year, knownSets(st, opts.data, opts.query));
    galaxyM = galaxyModel(starsData(), st, opts.data, sectorM);
    modelVersion = version;
  }
  const minDim = () => Math.max(1, Math.min(W, H));
  const galaxyFitS = () => minDim() / (2 * (galaxyM?.radius || 52000) * 1.04);
  const galaxyMaxS = () => minDim() / 1800;

  function setLevel(id, { fromOutside = false } = {}) {
    V.level = id;
    V.sel = null;
    if (id === 'galaxy') {
      models();
      if (V.gs == null || fromOutside) { V.gs = galaxyFitS(); V.gcx = 0; V.gcy = (galaxyM?.sunR || 26000) * 0.35; }
    } else if (fromOutside) {
      V.ly = clamp(18, lv().minLy || 5, lv().maxLy || 44);
    }
    cacheKey = '';
    opts.invalidate();
  }
  function resize(w, h, d) {
    W = w; H = h; dpr = d;
    if (cache) { cache.width = Math.round(W * dpr); cache.height = Math.round(H * dpr); }
    if (V.level === 'galaxy' && V.gs != null) V.gs = clamp(V.gs, galaxyFitS(), galaxyMaxS());
    cacheKey = '';
  }
  function refresh() { version++; cacheKey = ''; }

  // ---------- camera ----------
  function sectorCam() {
    return { yaw: V.yaw, pitch: V.pitch, s: (minDim() / 2) / V.ly, cx: W / 2, cy: H * 0.47 };
  }
  /** Zoom by factor (>1 = closer). Returns 'in'/'out' when the zoom runs past the level's range. */
  function zoomBy(f, sx = W / 2, sy = H / 2) {
    if (V.level === 'sector') {
      const L = lv();
      const next = V.ly / f;
      if (next < (L.minLy || 5) * 0.85 && f > 1) return 'in';
      if (next > (L.maxLy || 44) * 1.15 && f < 1) return 'out';
      V.ly = clamp(next, L.minLy || 5, L.maxLy || 44);
    } else {
      const s0 = V.gs;
      const next = s0 * f;
      if (next > galaxyMaxS() * 1.15 && f > 1) return 'in';
      V.gs = clamp(next, galaxyFitS(), galaxyMaxS());
      // keep the point under the fingers fixed
      const wx = V.gcx + (sx - W / 2) / s0;
      const wy = V.gcy + (sy - H / 2) / s0;
      V.gcx = wx - (sx - W / 2) / V.gs;
      V.gcy = wy - (sy - H / 2) / V.gs;
      clampGalaxy();
    }
    cacheKey = '';
    opts.invalidate();
    return null;
  }
  function clampGalaxy() {
    const R = (galaxyM?.radius || 52000) * 1.05;
    V.gcx = clamp(V.gcx, -R, R);
    V.gcy = clamp(V.gcy, -R, R);
  }
  function drag(dx, dy) {
    if (V.level === 'sector') {
      V.yaw += dx * 0.008;
      V.pitch = clamp(V.pitch + dy * 0.006, 18 * DEG, 90 * DEG);
    } else {
      V.gcx -= dx / V.gs;
      V.gcy -= dy / V.gs;
      clampGalaxy();
    }
    cacheKey = '';
    opts.invalidate();
  }
  function home() {
    if (V.level === 'sector') { V.yaw = -0.35; V.pitch = 58 * DEG; V.ly = 18; }
    else { V.gs = galaxyFitS(); V.gcx = 0; V.gcy = (galaxyM?.sunR || 26000) * 0.35; }
    cacheKey = '';
    opts.invalidate();
  }

  // ---------- drawing ----------
  function draw(g, ts = 1) {
    if (!W || !H || !starsData()) return;
    models();
    const key = `${V.level}|${V.yaw.toFixed(4)}|${V.pitch.toFixed(4)}|${V.ly.toFixed(3)}|${V.gcx.toFixed(1)}|${(V.gcy ?? 0).toFixed(1)}|${(V.gs ?? 0).toExponential(4)}|${W}|${H}|${dpr}|${version}|${ts}|${V.sel ? V.sel.id : ''}`;
    if (key !== cacheKey && cg) {
      cg.setTransform(dpr, 0, 0, dpr, 0, 0);
      cg.clearRect(0, 0, W, H);
      hits = [];
      if (V.level === 'sector') drawSector(cg, ts); else drawGalaxy(cg, ts);
      cacheKey = key;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (cache) g.drawImage(cache, 0, 0);
  }

  function backdrop(g) {
    const grd = g.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    grd.addColorStop(0, '#0d1226');
    grd.addColorStop(1, '#05060b');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const rng = makeRng(77).next;
    for (let i = 0; i < 160; i++) {
      g.fillStyle = `rgba(220,228,255,${0.08 + rng() * 0.22})`;
      g.fillRect(rng() * W, rng() * H, 1, 1);
    }
  }

  function drawSector(g, ts) {
    backdrop(g);
    const cam = sectorCam();
    const fs = 11 * ts;
    // distance rings on the galactic plane
    const sp = Math.sin(cam.pitch);
    g.lineWidth = 1;
    for (const r of [5, 10, 15, 20, 30, 40]) {
      if (r > V.ly * 1.6) break;
      g.strokeStyle = 'rgba(122,162,196,0.16)';
      g.setLineDash(r % 10 ? [2, 4] : []);
      g.beginPath();
      g.ellipse(cam.cx, cam.cy, r * cam.s, r * cam.s * sp, 0, 0, TAU);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(155,155,166,0.55)';
      g.font = `${Math.round(fs * 0.9)}px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${r} a.l.`, cam.cx, cam.cy + r * cam.s * sp + 8);
    }
    // direction to the galactic centre (the galaxy level uses the same "up")
    const cen = projectSector([V.ly * 1.15, 0, 0], cam);
    g.strokeStyle = 'rgba(227,179,65,0.22)';
    g.setLineDash([3, 5]);
    g.beginPath(); g.moveTo(cam.cx, cam.cy); g.lineTo(cen.x, cen.y0); g.stroke();
    g.setLineDash([]);
    // explored bubble
    if (sectorM.reach > 0) {
      g.fillStyle = 'rgba(86,180,233,0.07)';
      g.strokeStyle = 'rgba(86,180,233,0.45)';
      g.beginPath();
      g.ellipse(cam.cx, cam.cy, sectorM.reach * cam.s, sectorM.reach * cam.s * sp, 0, 0, TAU);
      g.fill(); g.stroke();
    }
    const pts = sectorM.stars.map((s) => ({ s, p: projectSector(s.xyz, cam) })).sort((a, b) => b.p.depth - a.p.depth);
    // stalks first
    for (const { s, p } of pts) {
      if (s.home) continue;
      g.strokeStyle = s.xyz[2] >= 0 ? 'rgba(160,180,220,0.28)' : 'rgba(160,180,220,0.16)';
      g.setLineDash(s.xyz[2] >= 0 ? [] : [2, 3]);
      g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x, p.y0); g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(160,180,220,0.3)';
      g.fillRect(p.x - 1.5, p.y0 - 0.5, 3, 1);
    }
    const labels = [];
    const marks = []; // status rings and colony badges: labels keep off them
    for (const { s, p } of pts) {
      if (p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
      const r = s.r * clamp(Math.sqrt(24 / V.ly), 0.85, 1.6);
      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.4);
      glow.addColorStop(0, s.color);
      glow.addColorStop(0.35, `${s.color}55`);
      glow.addColorStop(1, `${s.color}00`);
      g.fillStyle = glow;
      g.beginPath(); g.arc(p.x, p.y, r * 3.4, 0, TAU); g.fill();
      g.fillStyle = s.color;
      g.beginPath(); g.arc(p.x, p.y, r, 0, TAU); g.fill();
      // fog / status marks
      if (s.status === 'surveyed') {
        g.strokeStyle = '#56b4e9'; g.lineWidth = 1.4;
        g.beginPath(); g.arc(p.x, p.y, r + 4, 0, TAU); g.stroke();
      } else if (s.status === 'colony') {
        g.strokeStyle = '#e3b341'; g.lineWidth = 1.6;
        g.beginPath(); g.arc(p.x, p.y, r + 4.5, 0, TAU); g.stroke();
        colonyGlyph(g, p.x + r + 6, p.y - r - 6, '#e3b341');
        marks.push([p.x + r, p.y - r - 12, 12, 12]);
      }
      if (s.status !== 'observed') marks.push([p.x - r - 5, p.y - r - 5, 2 * r + 10, 2 * r + 10]);
      if (s.planets.length && !s.home) {
        // one dot per known world, on a little arc under the star
        const n = Math.min(7, s.planets.length);
        for (let i = 0; i < n; i++) {
          const a = Math.PI * (0.25 + (0.5 * i) / Math.max(1, n - 1 || 1));
          const pl = s.planets[i];
          g.fillStyle = pl.hz ? '#4ade80' : '#b9c2d6';
          g.beginPath(); g.arc(p.x + Math.cos(a) * (r + 8), p.y + Math.sin(a) * (r + 8), 1.5, 0, TAU); g.fill();
        }
      }
      if (V.sel?.id === s.id) {
        g.strokeStyle = '#ffffff'; g.lineWidth = 2;
        g.beginPath(); g.arc(p.x, p.y, r + 7, 0, TAU); g.stroke();
      }
      hits.push({ kind: 'star', id: s.id, x: p.x, y: p.y, r: Math.max(16, r + 8) });
      const near = (Number(s.ly) || 0) < V.ly * 0.75;
      const prio = (s.home ? 100 : 0) + (s.status !== 'observed' ? 50 : 0) + (s.planets.length ? 10 : 0) + (s.cls === 'G' || s.cls === 'K' || s.cls === 'A' || s.cls === 'F' ? 8 : 0) - (Number(s.ly) || 0) * 0.3;
      if (near || s.home || s.status !== 'observed' || V.sel?.id === s.id) {
        g.font = `${s.home || s.status !== 'observed' ? '600 ' : ''}${Math.round(fs)}px ${FONT}`;
        const text = s.name;
        labels.push({ x: p.x, y: p.y, w: g.measureText(text).width + 2, h: fs + 3, prio: V.sel?.id === s.id ? 999 : prio, text, s });
      }
    }
    const obstacles = [[W - 64, 0, 64, 120], [0, H - 48, W, 48], ...marks]; // zoom buttons, caption, marks
    // a phone shows ~12 names at the default zoom (more when zoomed in); the rest on tap
    const maxLabels = Math.round(clamp(12 * Math.sqrt(18 / V.ly) * Math.sqrt((W * H) / (390 * 600)), 6, 30));
    const shown = labels.sort((a, b) => b.prio - a.prio).slice(0, maxLabels);
    for (const L of declutter(shown, obstacles)) {
      g.font = `${L.s.home || L.s.status !== 'observed' ? '600 ' : ''}${Math.round(fs)}px ${FONT}`;
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillStyle = 'rgba(5,6,11,0.75)';
      g.fillText(L.text, L.bx + 1, L.by + 1);
      g.fillStyle = L.s.status === 'colony' ? '#e3b341' : L.s.status === 'surveyed' ? '#bfe6fb' : L.s.home ? '#fff1c4' : 'rgba(236,237,240,0.82)';
      g.fillText(L.text, L.bx, L.by);
    }
  }

  function colonyGlyph(g, x, y, color) {
    g.save();
    g.fillStyle = 'rgba(12,12,15,0.92)';
    g.strokeStyle = color;
    g.lineWidth = 1.2;
    g.beginPath();
    if (g.roundRect) g.roundRect(x - 6, y - 6, 12, 12, 3); else g.rect(x - 6, y - 6, 12, 12);
    g.fill(); g.stroke();
    g.fillStyle = color;
    g.beginPath(); g.moveTo(x - 3.5, y + 3); g.lineTo(x - 3.5, y - 0.5); g.lineTo(x, y - 3.5); g.lineTo(x + 3.5, y - 0.5); g.lineTo(x + 3.5, y + 3); g.closePath(); g.fill();
    g.restore();
  }

  function drawGalaxy(g, ts) {
    g.fillStyle = '#04050a';
    g.fillRect(0, 0, W, H);
    const s = V.gs;
    const toS = (x, y) => [(x - V.gcx) * s + W / 2, (y - (V.gcy ?? 0)) * s + H / 2];
    const fs = 11 * ts;
    const M = galaxyM;
    // disc glow
    const [ox, oy] = toS(0, 0);
    const disc = g.createRadialGradient(ox, oy, 0, ox, oy, M.radius * s);
    disc.addColorStop(0, 'rgba(255,226,170,0.55)');
    disc.addColorStop(0.12, 'rgba(240,200,150,0.22)');
    disc.addColorStop(0.45, 'rgba(120,140,200,0.10)');
    disc.addColorStop(1, 'rgba(60,80,140,0)');
    g.fillStyle = disc;
    g.beginPath(); g.arc(ox, oy, M.radius * s, 0, TAU); g.fill();
    // bar
    if (M.bar) {
      g.save();
      g.translate(ox, oy);
      g.rotate((M.bar.angleDeg || 0) * DEG);
      const bl = M.bar.halfLength * s;
      const bar = g.createRadialGradient(0, 0, 0, 0, 0, bl);
      bar.addColorStop(0, 'rgba(255,236,196,0.75)');
      bar.addColorStop(1, 'rgba(255,220,170,0)');
      g.fillStyle = bar;
      g.scale(1, 0.38);
      g.beginPath(); g.arc(0, 0, bl, 0, TAU); g.fill();
      g.restore();
    }
    // arms: wide soft band + bright core line
    const armPath = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => { const [a, b] = toS(x, y); if (i) g.lineTo(a, b); else g.moveTo(a, b); }); };
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // soft bands, widest first (no blur filters: cheap on phones, and the layer is cached per camera)
    for (const [w, a] of [[5200, 0.035], [3400, 0.05], [2000, 0.07], [900, 0.08]]) {
      g.strokeStyle = `rgba(170,190,250,${a})`;
      g.lineWidth = Math.max(1.5, w * s);
      for (const arm of M.arms) { armPath(arm.pts); g.stroke(); }
    }
    if (M.spur) {
      armPath(M.spur.pts);
      g.strokeStyle = 'rgba(190,205,255,0.12)';
      g.lineWidth = Math.max(2, 900 * s);
      g.stroke();
    }
    // stars and star-forming knots along the arms (seeded: the same picture every time)
    const rng = makeRng(2024).next;
    const gauss = () => (rng() + rng() + rng() - 1.5) / 1.5;
    for (const arm of M.arms) {
      for (let i = 0; i < arm.pts.length; i++) {
        const [x, y] = arm.pts[i];
        for (let j = 0; j < 4; j++) {
          const [px, py] = toS(x + gauss() * 2600, y + gauss() * 2600);
          if (px < 0 || py < 0 || px > W || py > H) { rng(); continue; }
          const pink = rng() < 0.04;
          g.globalAlpha = pink ? 0.6 : 0.18 + rng() * 0.45;
          g.fillStyle = pink ? '#f0a3c0' : '#e1e8ff';
          const sz = pink ? 1.8 : 1.1;
          g.fillRect(px, py, sz, sz);
        }
      }
    }
    g.globalAlpha = 1;
    const labels = [];
    const zoomedIn = s > galaxyFitS() * 2.2;
    // arm names (zoomed out only, along the arm near the Sun's side)
    if (!zoomedIn) {
      g.font = `italic ${Math.round(fs * 0.95)}px ${FONT}`;
      g.fillStyle = 'rgba(190,205,255,0.55)';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const a of M.arms) {
        const p = a.pts[Math.floor(a.pts.length * 0.55)];
        if (!p) continue;
        const [x, y] = toS(p[0], p[1]);
        if (x > 30 && x < W - 30 && y > 20 && y < H - 20) labels.push({ x, y, w: g.measureText(a.name).width, h: fs, prio: 1, text: a.name, arm: true });
      }
    }
    // regions
    const [sunX, sunY] = toS(0, M.sunR);
    for (const r of M.regions) {
      if (r.kind === 'home') continue;
      const [x, y] = toS(r.x, r.y);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      const known = r.status !== 'observed';
      // too close to the Sun to tell apart at this zoom: the Sun's tap target and label speak for the neighbourhood
      if (!known && Math.hypot(x - sunX, y - sunY) < 16) continue;
      const col = r.status === 'colony' ? '#e3b341' : r.status === 'surveyed' ? '#56b4e9' : r.kind === 'nebulosa' ? '#f0a3c0' : r.kind === 'centro' ? '#ffe2aa' : '#c7d2f0';
      g.globalAlpha = known ? 1 : 0.7;
      g.fillStyle = col;
      if (r.kind === 'nebulosa') { g.beginPath(); g.arc(x, y, 3.2, 0, TAU); g.fill(); g.globalAlpha *= 0.3; g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill(); }
      else if (r.kind === 'aglomerado') { for (const [dx, dy] of [[0, 0], [3, 2], [-3, 2], [0, -3]]) { g.beginPath(); g.arc(x + dx, y + dy, 1.4, 0, TAU); g.fill(); } }
      else { g.beginPath(); g.arc(x, y, 2.6, 0, TAU); g.fill(); }
      g.globalAlpha = 1;
      if (!known) { g.strokeStyle = 'rgba(199,210,240,0.35)'; g.setLineDash([2, 2]); g.beginPath(); g.arc(x, y, 6, 0, TAU); g.stroke(); g.setLineDash([]); }
      if (V.sel?.id === r.id) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 9, 0, TAU); g.stroke(); }
      hits.push({ kind: 'region', id: r.id, x, y, r: 18 });
      if (zoomedIn || r.kind === 'centro' || known) {
        g.font = `${known ? '600 ' : ''}${Math.round(fs)}px ${FONT}`;
        labels.push({ x, y, w: g.measureText(r.name).width + 2, h: fs + 3, prio: (known ? 50 : 10) + (V.sel?.id === r.id ? 999 : 0) - r.d / 2000, text: r.name, r });
      }
    }
    // colonization nodes
    for (const n of M.nodes) {
      const [x, y] = toS(n.x, n.y);
      colonyGlyph(g, x + 8, y - 8, opts.colorOf?.(n.ownerId) || '#e3b341');
    }
    // the Sun + explored bubble ("você está aqui")
    const [sx, sy] = toS(0, M.sunR);
    const bub = Math.max(5, (M.reach || 0) * s);
    g.fillStyle = 'rgba(86,180,233,0.12)';
    g.strokeStyle = 'rgba(86,180,233,0.7)';
    g.lineWidth = 1.2;
    g.beginPath(); g.arc(sx, sy, bub, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#fff1c4';
    g.beginPath(); g.arc(sx, sy, 2.6, 0, TAU); g.fill();
    hits.push({ kind: 'region', id: 'bolha_local', x: sx, y: sy, r: 20 });
    g.font = `600 ${Math.round(fs)}px ${FONT}`;
    const here = 'Sol · você está aqui';
    labels.push({ x: sx, y: sy, w: g.measureText(here).width + 2, h: fs + 3, prio: 2000, text: here, home: true });
    for (const L of declutter(labels, [[W - 64, 0, 64, 120]])) {
      g.textAlign = 'left';
      g.textBaseline = 'top';
      if (L.arm) {
        g.font = `italic ${Math.round(fs * 0.95)}px ${FONT}`;
        g.fillStyle = 'rgba(190,205,255,0.55)';
      } else {
        g.font = `${L.home || L.r?.status !== 'observed' ? '600 ' : ''}${Math.round(fs)}px ${FONT}`;
        g.fillStyle = 'rgba(4,5,10,0.8)';
        g.fillText(L.text, L.bx + 1, L.by + 1);
        g.fillStyle = L.home ? '#fff1c4' : L.r?.status === 'colony' ? '#e3b341' : L.r?.status === 'surveyed' ? '#bfe6fb' : 'rgba(236,237,240,0.8)';
      }
      g.fillText(L.text, L.bx, L.by);
    }
    // scale bar
    const lyPerPx = 1 / s;
    const target = 80 * lyPerPx;
    const nice = [500, 1000, 2000, 5000, 10000, 20000].find((v) => v >= target) || 20000;
    const px = nice / lyPerPx;
    g.strokeStyle = 'rgba(236,237,240,0.6)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(14, H - 18); g.lineTo(14 + px, H - 18); g.moveTo(14, H - 22); g.lineTo(14, H - 14); g.moveTo(14 + px, H - 22); g.lineTo(14 + px, H - 14); g.stroke();
    g.font = `${Math.round(fs * 0.9)}px ${FONT}`;
    g.fillStyle = 'rgba(236,237,240,0.7)';
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    g.fillText(`${nice.toLocaleString('pt-BR')} anos-luz`, 14, H - 24);
  }

  // ---------- hit test & sheets ----------
  function hit(x, y) {
    let best = null, bd = Infinity;
    for (const h of hits) {
      const d = Math.hypot(h.x - x, h.y - y);
      if (d <= h.r && d < bd) { bd = d; best = h; }
    }
    return best;
  }
  function select(sel) { V.sel = sel; cacheKey = ''; opts.invalidate(); }

  function sheetHtml(sel, { head, actorInfo } = {}) {
    models();
    const st = opts.getState() || {};
    const year = (st.startYear ?? 2026) + Math.floor((st.turn ?? 0) / 52);
    const SD = starsData();
    if (sel?.kind === 'star') {
      const s = sectorM.stars.find((x) => x.id === sel.id);
      if (!s) return '';
      const chip = `<span class="map-chip map-chip--deep-${s.status}">${STATUS_TEXT[s.status]}</span>`;
      const dot = `background:radial-gradient(circle at 35% 35%, #fff, ${s.color} 45%, #20140c 100%)`;
      const pl = s.planets.map((p) => `<li><b>${esc(p.name)}</b> <small>${esc(p.kind || 'mundo')}${p.hz ? ' · zona habitável' : ''}${p.found ? ` · anunciado em ${p.found}` : p.generated ? ' · revelado pela sua sonda' : ''}</small></li>`).join('');
      const hid = s.hidden ? `<p class="map-fogged">${s.status === 'observed' ? 'Pode haver mais mundos aqui. Só uma sonda sua revela o sistema inteiro.' : 'Há sinais de mais mundos ainda não confirmados.'}</p>` : '';
      const lb = galacticLB(s);
      const colonies = s.colonies.map((c) => {
        const a = actorInfo?.(st, opts.data, c.ownerId);
        return `<li><b>${esc(c.name)}</b> <small>${c.kind === 'outpost' ? 'posto avançado' : c.kind === 'station' ? 'estação' : 'colônia'}${a?.short ? ` · ${esc(a.short)}` : ''}</small></li>`;
      }).join('');
      const facts = s.home ? '' : `<dl class="map-facts">
          <div><dt>Distância</dt><dd>${num(s.ly, 2)} anos-luz</dd></div>
          <div><dt>Viagem</dt><dd>${esc(travelText(s.ly, SD?.probeSpeedC || 0.1))}</dd></div>
          <div><dt>Direção</dt><dd>l ${Math.round(lb.l)}° · b ${Math.round(lb.b)}°</dd></div>
          <div><dt>Mundos conhecidos</dt><dd>${s.planets.length}</dd></div>
        </dl>`;
      return `${head(dot, s.name, esc(starTypeText(SD, s)), chip)}
        <div class="map-sheet__body">
          ${s.home ? '<p class="map-hist">O Sistema Solar inteiro cabe num ponto nesta escala. Aproxime para voltar aos planetas.</p><div class="map-actions"><button type="button" class="map-btn" data-deep-leave="in">Ver o Sistema Solar</button></div>' : ''}
          ${facts}
          <section><h4>Mundos</h4>${pl ? `<ul>${pl}</ul>` : `<p class="map-fogged">${s.status === 'observed' ? `Nenhum planeta confirmado até ${year}.` : 'Nenhum planeta encontrado.'}</p>`}${hid}</section>
          ${colonies ? `<section><h4>Presença humana</h4><ul>${colonies}</ul></section>` : ''}
        </div>`;
    }
    if (sel?.kind === 'region') {
      const r = galaxyM.regions.find((x) => x.id === sel.id);
      if (!r) return '';
      const chip = `<span class="map-chip map-chip--deep-${r.status}">${STATUS_TEXT[r.status]}</span>`;
      const nodes = galaxyM.nodes.filter((n) => n.regionId === r.id || (r.kind === 'home' && !n.regionId && !n.galaxy));
      return `${head(`background:${r.kind === 'nebulosa' ? '#f0a3c0' : '#c7d2f0'}`, r.name, esc(KIND_TEXT[r.kind] || 'Região'), chip)}
        <div class="map-sheet__body">
          <dl class="map-facts">
            <div><dt>Distância</dt><dd>${r.d ? `${Number(r.d).toLocaleString('pt-BR')} anos-luz` : 'aqui'}</dd></div>
            ${r.d ? `<div><dt>Viagem</dt><dd>${esc(travelText(r.d, SD?.probeSpeedC || 0.1))}</dd></div>` : `<div><dt>Explorado</dt><dd>${sectorM.reach ? `até ${num(sectorM.reach, 1)} a.l.` : 'só o Sistema Solar'}</dd></div>`}
          </dl>
          ${r.kind === 'home' ? '<div class="map-actions"><button type="button" class="map-btn" data-deep-level="sector">Ver o setor estelar</button></div>' : ''}
          ${nodes.length ? `<section><h4>Nós de colonização</h4><ul>${nodes.map((n) => `<li><b>${esc(n.name)}</b></li>`).join('')}</ul></section>` : ''}
          ${r.status === 'observed' && r.kind !== 'home' ? '<p class="map-fogged">Conhecida só por telescópios. Nenhuma expedição chegou lá.</p>' : ''}
        </div>`;
    }
    return '';
  }

  function legendHtml() {
    if (V.level === 'galaxy') {
      return `<div class="map-legend__card">
        <div><span class="lg-deep lg-deep--home"></span> Sol e a bolha que você já explorou</div>
        <div><span class="lg-deep lg-deep--obs"></span> Região só observada (tracejada)</div>
        <div><span class="lg-deep lg-deep--surv"></span> Região sondada</div>
        <div><span class="lg-deep lg-deep--col"></span> Nó de colonização</div>
        <p>Via Láctea esquemática: braços em espiral, centro para cima. Pinça ou roda aproxima; aproxime o Sol para ver o setor.</p>
      </div>`;
    }
    return `<div class="map-legend__card">
      <div><span class="lg-deep lg-deep--obs"></span> Estrela observada: planetas só a partir do anúncio</div>
      <div><span class="lg-deep lg-deep--surv"></span> Sondada por você: o sistema inteiro aparece</div>
      <div><span class="lg-deep lg-deep--col"></span> Colônia ou posto avançado</div>
      <div><span class="lg-deep lg-deep--hz"></span> Mundo na zona habitável · <span class="lg-deep lg-deep--pl"></span> outro mundo</div>
      <p>Haste = altura sobre o plano da galáxia (tracejada: abaixo). Arraste para girar, pinça para aproximar. Anéis a cada 5 anos-luz.</p>
    </div>`;
  }

  return {
    get level() { return V.level; },
    get selection() { return V.sel; },
    setLevel, resize, refresh, draw, zoomBy, drag, home, hit, select, sheetHtml, legendHtml,
    destroy() { if (cache) { cache.width = 0; cache.height = 0; } },
  };
}
