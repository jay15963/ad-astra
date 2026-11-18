// Asset fixtures (MISSIONS-V2 §3.1 shape) for the UI tests and the Missões v2 screenshots: an own station low on
// supply, the ISS of another agency, an own lunar base with vehicles, a derelict own station, an observatory fleet
// and a Mars rover. assetsFor(state) returns fresh JSON for state.assets.

export function assetsFor(state, { other = 'nasa' } = {}) {
  const pid = state.playerId;
  const t = state.turn;
  const list = [
    { id: 'as_1', kind: 'station', sub: null, name: 'Aurora', ownerId: pid, partners: [{ actorId: pid, massT: 47, crewWeeks: 40 }],
      site: 'leo', bodyId: 'earth', histId: null, foundedTurn: t - 160, status: 'active',
      modules: [{ id: 'st_core', n: 1, addedTurn: t - 160, by: pid }, { id: 'st_lab', n: 1, addedTurn: t - 100, by: pid }, { id: 'st_solar', n: 1, addedTurn: t - 60, by: pid }],
      vehicles: [], units: [], lifeEndTurn: null, health: 74, supplyT: 0.9, crew: { n: 3, untilTurn: t + 10, missionId: null },
      colonyId: null, stageN: 0, sizeTier: 0, sciYr: 9.6, lastNotice: null, derelictTurn: null },
    { id: 'as_2', kind: 'station', sub: null, name: 'Estação Espacial Internacional', ownerId: other,
      partners: [{ actorId: other, massT: 300, crewWeeks: 900 }, { actorId: 'roscosmos', massT: 120, crewWeeks: 400 }, { actorId: 'esa', massT: 20, crewWeeks: 60 }],
      site: 'iss', bodyId: 'earth', histId: 'iss', foundedTurn: t - 1400, status: 'active',
      modules: [{ id: 'st_core', n: 2, addedTurn: t - 1400, by: other }, { id: 'st_node', n: 3, addedTurn: t - 1300, by: other }, { id: 'st_lab', n: 3, addedTurn: t - 1200, by: other }, { id: 'st_solar', n: 4, addedTurn: t - 1100, by: other }, { id: 'st_hab', n: 1, addedTurn: t - 1000, by: other }, { id: 'st_airlock', n: 1, addedTurn: t - 1000, by: other }, { id: 'st_arm', n: 1, addedTurn: t - 1000, by: other }, { id: 'st_cupola', n: 1, addedTurn: t - 800, by: other }],
      vehicles: [], units: [], lifeEndTurn: null, health: 61, supplyT: 14, crew: { n: 7, untilTurn: null, missionId: null },
      colonyId: null, stageN: 0, sizeTier: 0, sciYr: 48, lastNotice: null, derelictTurn: null },
    { id: 'as_3', kind: 'base', sub: null, name: 'Base Shackleton', ownerId: pid, partners: [{ actorId: pid, massT: 30, crewWeeks: 0 }],
      site: 'lunar_south_pole', bodyId: 'moon', histId: null, foundedTurn: t - 90, status: 'active',
      modules: [{ id: 'bs_hab_small', n: 2, addedTurn: t - 90, by: pid }, { id: 'bs_solar', n: 2, addedTurn: t - 90, by: pid }, { id: 'bs_comms', n: 1, addedTurn: t - 40, by: pid }],
      vehicles: [{ id: 'vh_lrv', n: 2, by: pid }], units: [], lifeEndTurn: null, health: 93, supplyT: 5, crew: { n: 4, untilTurn: t + 20, missionId: null },
      colonyId: null, stageN: 2, sizeTier: 1, sciYr: 4.2, lastNotice: null, derelictTurn: null },
    { id: 'as_4', kind: 'station', sub: null, name: 'Vigia', ownerId: pid, partners: [], site: 'sso', bodyId: 'earth', histId: null,
      foundedTurn: t - 600, status: 'derelict', modules: [{ id: 'st_core', n: 1, addedTurn: t - 600, by: pid }], vehicles: [], units: [],
      lifeEndTurn: null, health: 9, supplyT: 0, crew: { n: 0, untilTurn: null, missionId: null }, colonyId: null, stageN: 0, sizeTier: 0, sciYr: 0,
      lastNotice: null, derelictTurn: t - 30 },
    { id: 'as_5', kind: 'satellite', sub: 'observatory', name: 'Observatórios espaciais', ownerId: pid, partners: [], site: 'leo', bodyId: 'earth',
      histId: null, foundedTurn: t - 300, status: 'active', modules: [], vehicles: [], units: [{ endTurn: t + 520, n: 1 }, { endTurn: t + 30, n: 1 }],
      lifeEndTurn: null, health: 100, supplyT: 0, crew: { n: 0, untilTurn: null, missionId: null }, colonyId: null, stageN: 0, sizeTier: 0, sciYr: 36,
      lastNotice: null, derelictTurn: null },
    { id: 'as_6', kind: 'rover', sub: 'heavy', name: 'Rover Jezero', ownerId: pid, partners: [], site: 'mars_surface', bodyId: 'mars', histId: null,
      foundedTurn: t - 104, status: 'active', modules: [], vehicles: [], units: [], lifeEndTurn: t + 400, health: 88, supplyT: 0,
      crew: { n: 0, untilTurn: null, missionId: null }, colonyId: null, stageN: 0, sizeTier: 0, sciYr: 22, km: 31, lastNotice: null, derelictTurn: null },
  ];
  return { seq: 6, list, past: [{ name: 'Salyut Brasil', kind: 'station', ownerId: pid, year: (state.startYear || 2026) + Math.floor(t / 52) - 3, cause: 'reentrada' }], notified: {} };
}
