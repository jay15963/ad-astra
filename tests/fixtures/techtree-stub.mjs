// Stub tech-tree data for the gating/research/UI tests and the Pesquisa screenshot harness (MISSIONS-V2 §4–§6),
// written to the contract shapes while the real data (data/core/techtree.json, data/tech/eN/tech.json) is authored
// by techtree-data. `withStubTree(data)` returns a NEW data object: the loaded data plus these unlock nodes, the
// techtree table, and `techGating` on the scenario. Nothing here is loaded by the game.

/** techtree.json shape (§5.2, §5.6, §4.6, §6.4). */
export const STUB_TECHTREE = {
  kinds: [
    { id: 'vehicle', label: 'Foguete', color: '#ff8a4c', glyph: 'foguete' },
    { id: 'spacecraft', label: 'Nave', color: '#f472b6', glyph: 'capsula' },
    { id: 'satellite', label: 'Satélite', color: '#38bdf8', glyph: 'satelite' },
    { id: 'probe', label: 'Sonda', color: '#818cf8', glyph: 'sonda' },
    { id: 'rover', label: 'Rover e veículos', color: '#a3e635', glyph: 'rodas' },
    { id: 'module', label: 'Módulo de estação ou base', color: '#2dd4bf', glyph: 'modulo' },
    { id: 'missionType', label: 'Tipo de missão', color: '#f5f5f4', glyph: 'alvo' },
    { id: 'part', label: 'Peça do Hangar', color: '#d6b98c', glyph: 'chave' },
  ],
  gates: {
    vehicle: [
      { match: { class: 'small' }, key: 'vehicle:small' }, { match: { class: 'medium' }, key: 'vehicle:medium' },
      { match: { class: 'heavy' }, key: 'vehicle:heavy' }, { match: { class: 'superheavy' }, key: 'vehicle:superheavy' },
      { match: { reusable: true }, key: 'vehicle:reusable' }, { match: { crewRated: true }, key: 'vehicle:crew_rated' },
    ],
    template: [
      { match: { id: 'two_stage' }, key: 'vehicle:small' }, { match: { id: 'three_stage' }, key: 'vehicle:three_stage' },
      { match: { id: 'core_boosters' }, key: 'vehicle:core_boosters' }, { match: { id: 'reusable' }, key: 'vehicle:reusable' },
    ],
    part: [{ match: { prop: 'hydrolox' }, key: 'part:prop.hydrolox' }, { match: { kind: 'escape' }, key: 'part:escape.tower' }],
    spacecraft: [
      { match: { kind: 'capsule', crewMax: 1 }, key: 'spacecraft:capsule_1' },
      { match: { kind: 'capsule', crewMin: 2, crewMax: 3 }, key: 'spacecraft:capsule_2_3' },
      { match: { kind: 'lander', crewMin: 1 }, key: 'spacecraft:lander_crewed' },
      { match: { kind: 'satellite' }, subKey: 'satellite' },
      { match: { kind: 'probe', destClass: 'outer' }, key: 'probe:outer' },
    ],
  },
  destClass: { lunar: ['moon'], inner: ['venus', 'mars', 'mercury', 'sun'], outer: ['jupiter', 'saturn', 'uranus', 'neptune', 'pluto', 'kuiper'] },
  effectCaps: { launchCost: { min: -0.7 }, payload: { max: 1.5 }, reliability: { max: 0.12 }, '*': { max: 3 } },
  preview: {
    e6: { count: 75, unlockCount: 22, highlights: [{ name: 'Telescópio de lente solar', kind: 'satellite' }, { name: 'Vela a laser', kind: 'probe' }, { name: 'Anel habitacional', kind: 'module' }] },
    e7: { count: 70, unlockCount: 18, highlights: [{ name: 'Estrutura colossal', kind: 'module' }, { name: 'Propulsão de antimatéria', kind: 'vehicle' }] },
  },
};

const u = (key, label) => ({ key, label });
/** Unlock nodes (t1/t3/t4 samples on real ids' branches; requires use real kept nodes where it matters). */
export const STUB_NODES = [
  { id: 'zt1_vehicle_sounding', branch: 'propulsion', era: 1, techTier: 't1', histYear: 1950, fromYear: 1947, name: 'Foguetes de sondagem', short: 'Sondagem', icon: '🚀', description: 'Voos suborbitais com álcool e oxigênio líquido.', cost: 20, science: 5, weeks: 8, requires: [], unlocks: [u('vehicle:sounding', 'Foguetes de sondagem'), u('part:prop.alcolox', 'Motores a álcool')] },
  { id: 'zt1_vehicle_small', branch: 'propulsion', era: 1, techTier: 't1', histYear: 1957, fromYear: 1954, name: 'Foguete orbital de dois estágios', short: 'Orbital leve', icon: '🚀', description: 'O primeiro lançador capaz de pôr um satélite em órbita.', cost: 80, science: 20, weeks: 24, requires: ['zt1_vehicle_sounding'], unlocks: [u('vehicle:small', 'Lançadores leves (R-7, Vanguard)'), u('missionType:satellite', 'Missões de satélite')] },
  { id: 'zt1_sat_science', branch: 'science', era: 1, techTier: 't1', histYear: 1957, fromYear: 1954, name: 'Satélite científico', short: 'Sat. científico', icon: '🛰️', description: 'Instrumentos de radiação e micrometeoritos em órbita.', cost: 40, science: 15, weeks: 16, requires: [], unlocks: [u('satellite:science', 'Satélites científicos')] },
  { id: 'zt1_vehicle_medium', branch: 'propulsion', era: 1, techTier: 't1', histYear: 1959, fromYear: 1956, name: 'Lançador médio', short: 'Médio', icon: '🚀', description: 'Mais empuxo e estágios superiores para órbitas altas.', cost: 140, science: 30, weeks: 30, requires: ['zt1_vehicle_small'], unlocks: [u('vehicle:medium', 'Lançadores médios (Atlas, Thor)')] },
  { id: 'zt1_probe_lunar', branch: 'science', era: 1, techTier: 't1', histYear: 1959, fromYear: 1956, name: 'Sondas lunares', short: 'Sonda lunar', icon: '🌘', description: 'Sobrevoos e impactos na Lua.', cost: 90, science: 25, weeks: 24, requires: ['zt1_sat_science'], unlocks: [u('missionType:probe', 'Missões de sonda'), u('probe:lunar', 'Sondas lunares')] },
  { id: 'zt1_crewed_capsule', branch: 'life_support', era: 1, techTier: 't1', histYear: 1961, fromYear: 1958, name: 'Cápsula para um tripulante', short: 'Cápsula 1', icon: '👩‍🚀', description: 'Suporte de vida, escudo térmico e paraquedas para um piloto.', cost: 200, science: 40, weeks: 40, requires: ['zt1_vehicle_small'], unlocks: [u('missionType:crewed', 'Missões tripuladas'), u('spacecraft:capsule_1', 'Cápsulas de um lugar'), u('vehicle:crew_rated', 'Certificação para tripulação')] },
  { id: 'zt1_part_hydrolox', branch: 'propulsion', era: 1, techTier: 't1', histYear: 1962, fromYear: 1959, name: 'Motores a hidrogênio', short: 'Hidrogênio', icon: '💧', description: 'Hidrogênio e oxigênio líquidos: o maior impulso específico químico.', cost: 160, science: 35, weeks: 36, requires: ['zt1_vehicle_medium'], unlocks: [u('part:prop.hydrolox', 'Motores e estágios a hidrogênio')] },
  { id: 'zt1_vehicle_heavy', branch: 'propulsion', era: 1, techTier: 't1', histYear: 1965, fromYear: 1962, name: 'Integração de cargas pesadas', short: 'Lançador pesado', icon: '🚀', description: 'Núcleos maiores e estágios a hidrogênio.', cost: 220, science: 40, weeks: 40, requires: ['zt1_vehicle_medium'], unlocks: [u('vehicle:heavy', 'Lançadores pesados (Titan, Proton, Saturn IB)')] },
  { id: 'zt1_station_core', branch: 'structures', era: 1, techTier: 't1', histYear: 1971, fromYear: 1968, name: 'Estação orbital', short: 'Estação', icon: '🛰️', description: 'Um núcleo habitável em órbita baixa.', cost: 260, science: 50, weeks: 44, requires: ['zt1_crewed_capsule'], unlocks: [u('missionType:station', 'Missões de estação'), u('module:station.core', 'Núcleo de estação')] },
  { id: 'zt3_vehicle_reusable', branch: 'propulsion', era: 3, techTier: 't3', histYear: 2015, fromYear: 2012, name: 'Primeiro estágio reutilizável', short: 'Reuso', icon: '♻️', description: 'Pouso vertical e reuso do primeiro estágio.', cost: 300, science: 60, weeks: 40, requires: ['zt1_vehicle_heavy'], unlocks: [u('vehicle:reusable', 'Foguetes reutilizáveis'), u('part:reuse.legs', 'Pernas de pouso')] },
  { id: 'zt3_sat_constellation', branch: 'computing', era: 3, techTier: 't3', histYear: 2019, fromYear: 2016, name: 'Megaconstelações', short: 'Constelação', icon: '🛰️', description: 'Milhares de satélites pequenos produzidos em série.', cost: 180, science: 40, weeks: 30, requires: ['zt1_sat_science'], unlocks: [u('satellite:constellation', 'Megaconstelações')] },
  { id: 'zt4_base_hab', branch: 'life_support', era: 4, techTier: 't4', histYear: 2028, fromYear: 2023, name: 'Habitat de superfície compacto', short: 'Habitat', icon: '🏠', description: 'O primeiro módulo de base pressurizado.', cost: 320, science: 60, weeks: 40, requires: ['zt1_station_core'], unlocks: [u('module:base.hab_small', 'Habitat compacto'), u('missionType:base', 'Bases de superfície')] },
];

/**
 * Loaded data + stub tree (+ techGating, techStart 'historical'). Pure: never mutates `data`. The loaded nodes keep
 * their place in the graph but lose their own `unlocks` (the real tree is techtree-data's and changes while it is
 * authored), so the stub nodes (ids `zt<n>_…`) are the only key grantors and the tests stay stable.
 */
export function withStubTree(data, { gated = true, historical = true } = {}) {
  const strip = (n) => (n.unlocks ? (({ unlocks, ...rest }) => rest)(n) : n);
  const nodes = [...(data.tech?.nodes || []).map(strip), ...STUB_NODES.filter((n) => !(data.index?.tech || {})[n.id])];
  const tech = { ...data.tech, nodes };
  const index = { ...data.index, tech: Object.fromEntries(nodes.map((n) => [n.id, n])) };
  return {
    ...data, tech, index, techtree: STUB_TECHTREE,
    scenario: (({ techStart, ...sc }) => ({ ...sc, techGating: gated, ...(historical ? { techStart: 'historical' } : {}) }))(data.scenario || {}),
  };
}
