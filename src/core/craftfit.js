// Estaleiro (spacecraft designer) — pure destination rules for designed craft. Shared by src/sim/craftdesigns.js
// (which builds the capability descriptor `cap` of a design), src/core/catalog.js (craftFitsDestination) and the UI.
// No state, no rng, no I/O: everything depends on the data (data/core/craft-parts.json `rules`) and the descriptor.
//
// cap = { role, kind, massT, dryT, cargoT, dv (km/s with the hold full), thrust (chemical kN), throttle, hasEngine,
//         ionOnly, comms (0 Earth · 1 Moon · 2 inner planets · 3 outer planets · 4 interstellar), solarW (at 1 AU),
//         rtgW, fcW, useW, battery, shield (0..3), chute, airbags, legs, skycrane, pressure, wheels, docking, arm,
//         sampler, crew, lsDays, escape, impactor, sample, life (years), sci (science/yr) }

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (x, d = 2) => String(Math.round(num(x) * 10 ** d) / 10 ** d).replace('.', ',');

const CP = new WeakMap();
/** Indexed craft parts catalog (data/core/craft-parts.json → data.craftParts), or null when it is not loaded. */
export function craftPartsOf(data) {
  const raw = data?.craftParts;
  if (!raw || !Array.isArray(raw.parts)) return null;
  let p = CP.get(raw);
  if (p) return p;
  const byId = {};
  for (const x of raw.parts) if (x && x.id) byId[x.id] = x;
  const roles = {};
  for (const r of raw.roles || []) if (r?.id) roles[r.id] = r;
  p = {
    raw, byId, list: raw.parts, roles, roleList: (raw.roles || []).filter((r) => r?.id), groups: raw.groups || [],
    shapes: raw.shapes || [], finishes: raw.finishes || [], placements: raw.placements || {}, rules: raw.rules || {},
  };
  CP.set(raw, p);
  return p;
}

const rulesOf = (data) => craftPartsOf(data)?.rules || {};

/** Destination by id (index first). */
export function destById(data, id) {
  if (!id) return null;
  return data?.index?.destinations?.[id] ?? data?.destinations?.destinations?.find((d) => d.id === id) ?? null;
}

function bodyRow(data, id) {
  if (!id) return null;
  const list = data?.bodies?.bodies;
  return data?.index?.bodies?.[id] ?? (Array.isArray(list) ? list.find((b) => b?.id === id) : null) ?? null;
}

/**
 * Physical facts of a destination's body for the craft rules: {id, g, atmo: 'none'|'thin'|'thick', au, entry (shield
 * rating to enter), night (long nights: the Moon, Mercury), hot (Venus)}. rules.bodies > bodies.json gravity > defaults.
 */
export function bodyInfo(data, dest) {
  const R = rulesOf(data);
  const id = R.destBody?.[dest?.id] || dest?.body || 'earth';
  const t = R.bodies?.[id] || {};
  const b = bodyRow(data, id);
  const g = num(t.g, num(b?.physical?.gravityG, id === 'earth' ? 1 : 0.001));
  const au = num(t.au, num(R.auByKey?.[dest?.capacityKey], 1));
  return { id, g, atmo: t.atmo || 'none', au, entry: num(t.entry, t.atmo && t.atmo !== 'none' ? 1 : 0), night: !!t.night, hot: !!t.hot };
}

/** Distance class of a destination for comms and crew rules: 0 Earth · 1 Moon · 2 inner · 3 outer · 4 interstellar. */
export function distClass(dest, body = null) {
  const k = dest?.capacityKey;
  const b = body?.id || dest?.body;
  if (k === 'interstellar' || dest?.kind === 'interstellar') return 4;
  if (k === 'outer') return 3;
  if (k === 'mars') return 2;
  if (b === 'earth' && (k === 'leo' || k === 'gto' || k === 'suborbital' || !k)) return 0;
  if (b === 'moon' || b === 'earth') return 1;
  return 2; // NEOs and the like on a lunar-class capacity key
}

const SHIELD_LABEL = ['', 'de retorno da órbita', 'de retorno lunar', 'de entrada extrema'];
const ENTRY_LABEL = ['', 'de classe 1 (Marte, Titã)', 'de classe 2', 'de classe 3 (entrada extrema)'];
const ROLE_KINDS = {
  satellite: ['orbit'],
  probe: ['orbit', 'flyby', 'rendezvous', 'atmosphere', 'suborbital', 'interstellar'],
  lander: ['surface'],
  rover: ['surface'],
  capsule: ['orbit', 'station', 'flyby', 'suborbital'],
  cargo: ['orbit', 'station'],
  module: ['orbit', 'station'],
};
const ROLE_NO = {
  satellite: 'Satélite só serve para órbitas.',
  probe: 'Sonda não pousa: para descer use um pousador (ou um impactador, de propósito).',
  lander: 'Pousador é para superfícies.',
  rover: 'Rover é para superfícies.',
  capsule: 'Cápsula vai à órbita, a estações ou dá a volta num corpo; para pousar precisa de um módulo de pouso.',
  cargo: 'Cargueiro vai a órbitas e estações; para superfícies use um pousador com carga.',
  module: 'Módulo de estação vai a órbitas que aceitam estação.',
};

function orbitDvOf(R, body) {
  if (body.id === 'earth') return 0;
  if (R.orbitDv && Object.prototype.hasOwnProperty.call(R.orbitDv, body.id)) return num(R.orbitDv[body.id], 1.2);
  if (body.g < num(R.smallBodyG, 0.005)) return num(R.smallBodyDv, 0.4);
  return num(R.orbitDv?.default, 1.2);
}

/**
 * Δv the craft itself must provide at a destination (km/s) and how it gets there:
 * {dv, mode: 'none'|'orbit'|'flyby'|'dock'|'entry'|'land'|'airland'|'impact'}.
 */
export function dvNeed(data, cap, dest, body = bodyInfo(data, dest)) {
  const R = rulesOf(data);
  const kind = dest?.kind;
  if (dest?.id && R.dvById && Object.prototype.hasOwnProperty.call(R.dvById, dest.id) && kind !== 'surface') return { dv: num(R.dvById[dest.id]), mode: 'orbit' };
  if (kind === 'suborbital' || kind === 'interstellar') return { dv: 0, mode: 'none' };
  if (kind === 'flyby') return { dv: num(R.flybyDv, 0.03), mode: 'flyby' };
  if (kind === 'station') return { dv: num(R.stationDv, 0.05) + (body.id === 'earth' ? 0 : orbitDvOf(R, body)), mode: 'dock' };
  if (kind === 'atmosphere') return { dv: 0, mode: 'entry' };
  if (kind === 'orbit' || kind === 'rendezvous') return { dv: orbitDvOf(R, body), mode: 'orbit' };
  if (kind === 'surface') {
    if (cap?.impactor && cap.role === 'probe') return { dv: num(R.flybyDv, 0.03), mode: 'impact' };
    if (body.atmo !== 'none') {
      if (body.atmo === 'thin' && !cap?.airbags && !cap?.skycrane) return { dv: num(R.thinTerminalDv, 0.35), mode: 'airland' };
      return { dv: 0, mode: 'airland' };
    }
    if (body.g < num(R.smallBodyG, 0.005)) return { dv: r2(num(R.smallBodyDv, 0.4) + 0.05), mode: 'land' };
    return { dv: r2(orbitDvOf(R, body) + num(R.landK, 4.8) * Math.sqrt(body.g)), mode: 'land' };
  }
  return { dv: 0, mode: 'none' };
}

/**
 * Can a designed craft fly to a destination? → { ok, reasons: [{code, text, tip}], warnings: [string], needDv,
 * lifeYears, scienceYr, companion (a capsule that lands with a separate crewed lander) }. Pure.
 */
export function fitDest(data, cap, destIn) {
  const dest = typeof destIn === 'string' ? destById(data, destIn) : destIn;
  const R = rulesOf(data);
  const out = { ok: false, reasons: [], warnings: [], needDv: 0, lifeYears: num(cap?.life, 0), scienceYr: num(cap?.sci, 0), companion: false };
  const add = (code, text, tip = null) => out.reasons.push({ code, text, tip });
  if (!cap) { add('unknown', 'Projeto inválido.'); return out; }
  if (!dest) { add('unknown', 'Destino desconhecido.'); return out; }
  const kind = dest.kind;
  const body = bodyInfo(data, dest);
  const dc = distClass(dest, body);
  const name = dest.name || dest.id;
  const role = cap.role;
  // ---- role × kind of place
  let allowed = (ROLE_KINDS[role] || []).includes(kind);
  if (role === 'probe' && kind === 'surface' && cap.impactor) allowed = true;
  if (role === 'capsule' && kind === 'surface' && body.id !== 'earth' && (cap.crew || 0) > 0) { allowed = true; out.companion = true; }
  if (role === 'module' && kind === 'orbit' && dest.stationOk === false) allowed = false;
  if (role === 'module' && kind === 'orbit' && dest.stationOk !== true && body.id !== 'earth' && body.id !== 'moon') allowed = false;
  if (!allowed) { add('role', ROLE_NO[role] || 'Este tipo de nave não serve para este lugar.', 'Mude a função da nave (Satélite, Sonda, Pousador…) ou escolha outro destino.'); out.ok = false; return out; }
  // ---- comms
  const labels = R.commsLabels || [];
  if (num(cap.comms, -1) < dc && kind !== 'suborbital') add('comms', `A antena não alcança ${name}: precisa de alcance até ${labels[dc] || 'lá'}.`, 'Troque a antena por uma de maior alcance (ganho médio ou alto).');
  // ---- propulsion
  const need = out.companion ? { dv: orbitDvOf(R, body), mode: 'orbit' } : dvNeed(data, cap, dest, body);
  out.needDv = r2(need.dv);
  if (need.dv > 0.001) {
    if (!cap.hasEngine) add('engine', `Precisa de propulsão própria para ${need.mode === 'land' ? 'descer' : need.mode === 'flyby' ? 'corrigir a rota' : 'entrar em órbita'} (${fmt(need.dv)} km/s).`, 'Acrescente um motor e propelente.');
    else if (num(cap.dv) + 1e-9 < need.dv) add('dv', `Δv insuficiente para ${name}: ${fmt(cap.dv)} de ${fmt(need.dv)} km/s.`, 'Ponha mais propelente (até o limite da estrutura), use um motor de Isp maior ou uma estrutura que leve mais tanque.');
  }
  // ---- landing and entry
  const surface = kind === 'surface' && need.mode !== 'impact' && !out.companion;
  if (surface || kind === 'atmosphere') {
    if (body.atmo !== 'none') {
      if (num(cap.shield) < body.entry) add('shield', `Entrar na atmosfera de ${name} pede escudo térmico ${ENTRY_LABEL[body.entry] || ''}.`.replace(' .', '.'), 'Acrescente um escudo térmico com a classificação certa (Entrada e pouso).');
      if (!cap.chute && (kind === 'atmosphere' || body.atmo === 'thick' || body.atmo === 'thin')) add('chute', 'Precisa de paraquedas para frear na atmosfera.', 'Acrescente um paraquedas.');
      if (surface && body.atmo === 'thin' && !cap.airbags && !cap.skycrane && !(cap.legs && cap.hasEngine)) add('terminal', 'Ar fino demais: além do paraquedas, precisa de retrofoguete com pernas, airbags ou guindaste aéreo.', 'Acrescente airbags, um guindaste aéreo ou pernas com um motor de descida.');
      if (surface && body.hot && !cap.pressure) add('pressure', `A superfície de ${name} esmaga e cozinha: precisa de casco pressurizado.`, 'Acrescente o casco pressurizado e refrigerado.');
    } else if (surface) {
      if (body.g >= num(R.smallBodyG, 0.005)) {
        if (!cap.legs && !cap.airbags) add('legs', 'Precisa de pernas de pouso (ou airbags).', 'Acrescente pernas de pouso.');
        if (cap.hasEngine && cap.ionOnly) add('ion', 'Propulsão iônica não segura uma descida: precisa de motor químico.', 'Acrescente um motor de descida.');
        else if (cap.hasEngine) {
          if (body.g >= num(R.throttleG, 0.05) && !cap.throttle) add('throttle', 'Pouso propulsivo precisa de motor estrangulável (motor de descida).', 'Troque ou acrescente um motor de descida.');
          const w = (num(cap.massT) + num(cap.cargoT)) * 9.80665 * body.g;
          const needKN = w * num(R.landTwr, 1.5);
          if (num(cap.thrust) + 1e-9 < needKN) add('twr', `O motor não segura a descida: empuxo de ${fmt(cap.thrust, 1)} kN, precisa de ${fmt(needKN, 1)} kN.`, 'Use um motor de descida mais forte ou mais motores.');
        }
      } else if (!cap.legs && !cap.sampler && !cap.arm && !cap.airbags) add('legs', 'Encostar num corpo pequeno pede pernas ou um braço de coleta.', 'Acrescente pernas de pouso ou o braço de coleta de amostras.');
    }
    if (role === 'rover' && surface && !cap.wheels) add('wheels', 'Rover sem rodas não anda.', 'Acrescente rodas (Entrada, pouso e rodas).');
  }
  // ---- docking
  if (kind === 'station' && ['capsule', 'cargo', 'module'].includes(role) && !cap.docking) add('docking', `Precisa de porta de acoplagem para chegar a ${name}.`, 'Acrescente uma porta de acoplagem.');
  // ---- crew
  if (num(cap.crew) > 0) {
    const days = role === 'lander' ? num(R.landerCrewDays, 4) : num(R.crewDays?.[dc], 3);
    if (num(cap.lsDays) < days) add('life', `Suporte de vida para ${num(cap.lsDays)} dia(s); ${name} pede ${days}.`, 'Troque o suporte de vida por um de mais dias.');
    if (role === 'capsule') {
      const rs = num(R.returnShield?.[dc], 1);
      if (num(cap.shield) < rs) add('return', `O escudo térmico não aguenta a volta de ${name}: precisa de escudo ${SHIELD_LABEL[rs]}.`, 'Use um escudo de classificação maior.');
      if (!cap.chute) add('chute', 'Precisa de paraquedas para a volta.', 'Acrescente um paraquedas.');
      if (!cap.escape) add('escape', 'Cápsula tripulada precisa de sistema de escape no lançamento.', 'Acrescente assento ejetável, torre de escape ou escape por propulsores.');
    }
  } else if (role === 'capsule') add('crew', 'Cápsula sem assentos.', 'Acrescente assentos (Tripulação).');
  if (role === 'cargo' && !(num(cap.cargoT) > 0)) add('cargo', 'Cargueiro sem compartimento de carga.', 'Acrescente um compartimento de carga.');
  // ---- power
  const gen = num(cap.solarW) / Math.max(0.01, body.au) ** 2 + num(cap.rtgW) + num(cap.fcW);
  const batteryOnly = gen <= 0 && cap.battery;
  if (batteryOnly) {
    out.lifeYears = Math.min(out.lifeYears, num(R.batteryLife, 0.03));
    const short = kind === 'atmosphere' || kind === 'suborbital' || need.mode === 'impact';
    if (!short) add('nopower', 'Só baterias: a nave morre em poucos dias.', 'Acrescente painéis solares ou um RTG.');
  } else if (gen <= 0 && num(cap.useW) > 0) add('nopower', 'Sem fonte de energia.', 'Acrescente painéis solares, baterias ou um RTG.');
  else if (gen + 1e-9 < num(cap.useW)) add('power', `Energia insuficiente em ${name}: ${Math.round(gen)} W de ${Math.round(num(cap.useW))} W.`, body.au > 3 ? 'Longe do Sol os painéis quase não rendem: use RTG.' : 'Acrescente painéis solares ou um RTG.');
  if (num(cap.solarW) > 0 && !cap.battery && ['orbit', 'surface', 'station', 'rendezvous'].includes(kind) && !num(cap.rtgW)) add('battery', 'Painel solar sem bateria: a nave apaga em cada eclipse e cada noite.', 'Acrescente uma bateria.');
  if (num(cap.fcW) > 0 && !num(cap.solarW) && !num(cap.rtgW)) out.lifeYears = Math.min(out.lifeYears, num(R.fuelcellLife, 0.05));
  if (surface && body.night && !num(cap.rtgW) && out.reasons.length === 0) {
    out.lifeYears = Math.min(out.lifeYears, num(R.nightLife, 0.04));
    out.warnings.push('Sem RTG, não sobrevive à noite de 14 dias: vida de cerca de 2 semanas.');
  }
  if (num(cap.crew) > 0) out.lifeYears = Math.min(out.lifeYears, Math.max(0.01, num(cap.lsDays) / 365));
  out.lifeYears = r2(out.lifeYears);
  out.scienceYr = r2(num(cap.sci) * num(dest.scienceMult, 1));
  out.ok = out.reasons.length === 0;
  return out;
}

/** Boolean shortcut used by catalog.craftFitsDestination. */
export function craftFitsDest(data, cap, destId) {
  return fitDest(data, cap, destId).ok;
}
