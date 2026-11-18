// Dia de Lançamento (sim side). Owns state.activeLaunch and state.commandPoints.
// State machine: prelaunch --countdown--> countdown (maybe pendingHold) --step--> ascent ... --> climax --step--> result --finish--> null.
// Every random draw derives from al.seed (locked at countdown) or from (state.seed, missionId, turn), so the
// same save + the same choices always give the same scene, also after save/load mid-scene.

import * as risk from './risk.js';
import * as missions from './missions.js';
import * as crew from './crew.js';
import * as research from './research.js';
import { addNews, changeActor, log, clamp } from '../core/helpers.js';
import { rngFor, hash32 } from '../core/rng.js';
import { OUTCOME_LABELS, FAILURE_LABELS, FAILURE_DESCRIPTIONS, pickFailureType } from '../core/outcome.js';

// ---------- tuning ----------
// Resolution numbers live in risk.SCENE: risk.sceneOdds computes the shown chance from the same rules (honest odds).
const { SUDDEN, REDUCE_FAIL, CONTINGENCY_FAIL, MINOR_MAINTAIN_FAIL, REDUCE_PF_MULT, SENSOR_PF_MULT } = risk.SCENE;
export const MAX_INTERVENTIONS = risk.SCENE.MAX_INTERVENTIONS;
const CONTINGENCY_MARGIN = 0.08; // margin burned by a contingency on a minor anomaly (overreaction has a price)
// Command points are a pool shared by every scene (GDD: "um recurso escasso"): spent points come back
// one at a time, every CP_REGEN_WEEKS weeks, up to the cap set by the best flight director (crew.commandPointsFor).
export const CP_REGEN_WEEKS = 4;
const REDUCE_MARGIN = 0.07; // margin consumed by each reduction

const STRATEGY_IDS = ['conservative', 'balanced', 'aggressive'];
const STRATEGY_LABELS = { conservative: 'Conservadora', balanced: 'Equilibrada', aggressive: 'Agressiva' };

// ---------- UI-flavor text tables (pt-BR) ----------

const WEATHER_ASCENT = [
  { code: 'clear', label: 'Céu limpo, vento fraco', risk: 0.02, weight: 38 },
  { code: 'cloudy', label: 'Parcialmente nublado', risk: 0.07, weight: 26 },
  { code: 'upper_winds', label: 'Ventos fortes em altitude', risk: 0.28, weight: 13 },
  { code: 'storm', label: 'Nuvens carregadas com raios', risk: 0.5, weight: 7 },
  { code: 'sea', label: 'Mar agitado na zona de resgate', risk: 0.26, weight: 7 },
  { code: 'front', label: 'Frente fria chegando', risk: 0.36, weight: 5 },
  { code: 'heat', label: 'Calor forte na plataforma', risk: 0.12, weight: 4 },
];
const WEATHER_SPACE = [
  { code: 'calm', label: 'Atividade solar calma', risk: 0.02, weight: 50 },
  { code: 'flare', label: 'Erupção solar moderada', risk: 0.3, weight: 12 },
  { code: 'comms', label: 'Rede de antenas com sinal instável', risk: 0.2, weight: 14 },
  { code: 'dust', label: 'Poeira suspensa na zona de pouso', risk: 0.26, weight: 10, surfaceOnly: true },
  { code: 'light', label: 'Iluminação rasante no alvo', risk: 0.14, weight: 14 },
];

const RADIO = {
  intro: ['Sala de controle aberta. {m} no relógio.', '{v} na plataforma. Abastecimento em andamento.', 'Bom dia, sala. Hoje é {m}.', 'Equipes em posição. {fd} na cadeira de diretor de voo.'],
  introArrival: ['{m} se aproxima de {dest}. Sala em silêncio.', 'Telemetria de {m} chegando. Atraso de sinal confirmado.', 'Hora da verdade em {dest}. Todos nos consoles.'],
  countdown: ['T menos 10 minutos. Rodada final de go/no-go.', 'Propulsão: go. Guiagem: go. Meteorologia: go.', 'Tanques pressurizados. Braço de acesso recolhido.', 'T menos 60 segundos. Veículo em controle interno.', '{fd}: estamos go para lançamento.'],
  countdownArrival: ['Sequência automática carregada. Go para a chegada.', 'Navegação confirma a trajetória. Go.', '{fd}: sala, estamos go.'],
  hold: ['Segurando a contagem. Vamos esperar.', 'Hold, hold, hold. Relógio parado.', 'Contagem segura. Ninguém sai do console.'],
  holdOk: ['Retomando a contagem. Condições aceitáveis.', 'Liberado. Relógio andando de novo.'],
  goAnyway: ['Vamos assim mesmo. Todos atentos.', 'Decisão tomada: seguimos.', 'Aceitamos o risco. Contagem continua.'],
  saved: ['Estabilizou. Boa decisão.', 'Voltou ao envelope. Segue.', 'Respira, sala. Passou.', 'Leitura normalizando. Bem feito.'],
  rode: ['Mantendo. Os números voltaram.', 'Seguimos o perfil. Passou.', 'Aguentou. Seguimos.'],
  auto: ['Sem tempo para decidir: a equipe segue o procedimento.', 'Procedimento automático em curso.'],
  abort: ['Abort, abort, abort!', 'Abortar! Sequência de segurança iniciada.', 'Comando de abort enviado.'],
  climaxOk: ['Silêncio na sala... e então, aplausos.', 'Confirmado. Podem comemorar.', 'É isso. Conseguimos.'],
  climaxFail: ['Silêncio no rádio.', 'Sala, mantenham os dados. Ninguém toca em nada.', 'Perdemos o sinal.'],
};

const MS_RADIO = {
  ignition: {
    ok: ['Ignição! Motores em empuxo pleno.', 'Temos ignição. Câmaras estáveis.', 'Ignição confirmada, pressão nominal.'],
    anomaly: ['Leitura estranha numa câmara de combustão...', 'Temperatura de turbobomba subindo.'],
    fail: ['Desligamento automático na plataforma!', 'Abort na ignição. Motores cortados.'],
  },
  liftoff: {
    ok: ['E decola! {v} deixou a torre.', 'Decolagem! Torre livre.', 'Saiu do chão. A multidão vai à loucura.'],
    anomaly: ['Rajada lateral na saída da torre.', 'Vibração acima do esperado.'],
    fail: ['Perdemos o veículo logo após a torre!', 'Desvio de trajetória. Terminação acionada.'],
  },
  maxq: {
    ok: ['Passando pelo Max-Q. Estrutura aguentou.', 'Max-Q. Pressão dinâmica máxima, tudo nominal.', 'Atravessamos a parede de ar.'],
    anomaly: ['Oscilação estrutural no Max-Q!', 'Carga aerodinâmica acima do envelope.'],
    fail: ['Ruptura estrutural no Max-Q!', 'Perdemos telemetria no Max-Q.'],
  },
  staging: {
    ok: ['Separação confirmada. Segundo estágio aceso.', 'Primeiro estágio fora. Estágio superior em empuxo.', 'Separação limpa.'],
    anomaly: ['Pressão oscilando no estágio 2.', 'Atraso na ignição do segundo estágio.'],
    fail: ['Segundo estágio não acendeu!', 'Falha na separação. Veículo instável.'],
  },
  fairing_or_les: {
    ok: ['Coifa fora. A carga vê o espaço.', 'Separação da coifa confirmada.'],
    okCrew: ['Torre de escape descartada. Cápsula livre.', 'Torre fora. A tripulação vê o céu escurecer.'],
    anomaly: ['Uma metade da coifa demorou a abrir.', 'Sensor de separação sem confirmação.'],
    fail: ['A coifa não separou! Massa demais.', 'Separação travada. Sem margem para a órbita.'],
  },
  orbit: {
    ok: ['Corte do motor. Estamos em órbita!', 'Inserção orbital confirmada. Bem-vindos ao espaço.', 'Órbita nominal. Pode respirar.'],
    anomaly: ['Corte do motor antes da hora prevista...', 'Órbita mais baixa que o planejado.'],
    fail: ['Não alcançamos a velocidade orbital.', 'Perdemos o estágio superior antes da órbita.'],
  },
  tli: {
    ok: ['Queima de injeção completa. Rumo a {dest}!', 'Saímos da órbita da Terra. Próxima parada: {dest}.'],
    anomaly: ['Queima de injeção com empuxo baixo.', 'Desvio pequeno na trajetória de injeção.'],
    fail: ['A queima de injeção parou no meio.', 'Estágio superior perdeu atitude na injeção.'],
  },
  // arrival groups (matched by id keyword)
  insertion: {
    ok: ['Captura confirmada. Estamos em órbita de {dest}.', 'Queima de inserção perfeita.'],
    anomaly: ['Queima de captura irregular...', 'Atitude oscilando antes da captura.'],
    fail: ['Passamos direto. Sem captura.', 'Queima de inserção abortada pelo computador.'],
  },
  descent: {
    ok: ['Descida motorizada no perfil.', 'Radar travado no solo. Descendo.', 'Velocidade e altitude nominais.'],
    anomaly: ['Velocidade de descida acima do perfil.', 'Alarme de computador na descida!'],
    fail: ['Perdemos o radar de altitude.', 'Descida fora de controle.'],
  },
  landing: {
    ok: ['Contato! Pouso confirmado.', 'Estamos no chão. Motor desligado.', 'Pouso suave. Poeira baixando.'],
    anomaly: ['Poeira cegando as câmeras.', 'Terreno irregular no ponto de pouso.'],
    fail: ['Impacto. Sem sinal da superfície.', 'Tombamos no pouso.'],
  },
  entry: {
    ok: ['Escudo térmico segurou. Paraquedas abertos.', 'Entrada atmosférica nominal.'],
    anomaly: ['Plasma cortando a comunicação.', 'Temperatura do escudo subindo.'],
    fail: ['Perdemos a nave na entrada.', 'Escudo térmico falhou.'],
  },
  dock: {
    ok: ['Acoplamento confirmado. Travas fechadas.', 'Contato e captura. Estamos acoplados.'],
    anomaly: ['Aproximação um pouco rápida.', 'Desalinhamento no acoplamento.'],
    fail: ['Colisão no acoplamento!', 'Travas não fecharam. Afastando.'],
  },
  deploy: {
    ok: ['Instrumentos ligados. Primeiros dados chegando.', 'Implantação concluída.'],
    anomaly: ['Painel solar abrindo devagar.', 'Antena sem travar.'],
    fail: ['Sem energia após a implantação.', 'Perdemos contato com a superfície.'],
  },
  generic: {
    ok: ['Marco cumprido. Seguimos.', 'Confirmado. Tudo nominal.'],
    anomaly: ['Leitura fora do esperado.', 'Algo não está certo nos dados.'],
    fail: ['Perdemos a nave.', 'Sem resposta da nave.'],
  },
};

const PROMPTS = {
  ignition: { critical: ['Turbobomba superaquecendo na ignição', 'Pressão de câmara caindo rápido'], minor: ['Leitura instável na câmara de combustão', 'Válvula de oxidante lenta'] },
  liftoff: { critical: ['Vento cruzado empurrando o veículo para a torre', 'Motor perdendo empuxo na decolagem'], minor: ['Vibração acima do normal na saída', 'Rajada lateral na torre'] },
  maxq: { critical: ['Oscilação estrutural crescendo no Max-Q', 'Carga aerodinâmica passando do limite'], minor: ['Carga aerodinâmica perto do limite', 'Ruído estrutural no Max-Q'] },
  staging: { critical: ['Pressão caindo rápido no estágio 2', 'Ignição do estágio 2 atrasada'], minor: ['Pressão oscilando no estágio 2', 'Separação mais lenta que o previsto'] },
  fairing_or_les: { critical: ['Trava da separação sem resposta', 'Sistema de separação em falha parcial'], minor: ['Sensor de separação atrasado', 'Leitura dupla no sensor de separação'] },
  orbit: { critical: ['Motor perdendo empuxo antes do corte', 'Guiagem calculando órbita baixa demais'], minor: ['Trajetória levemente baixa', 'Consumo de propelente acima do perfil'] },
  tli: { critical: ['Empuxo caindo na queima de injeção', 'Vazamento no estágio superior'], minor: ['Atitude oscilando na queima', 'Queima de injeção um pouco curta'] },
  insertion: { critical: ['Queima de captura com empuxo irregular', 'Motor principal não confirma ignição'], minor: ['Atitude oscilando antes da captura', 'Navegação com erro pequeno'] },
  descent: { critical: ['Radar de altitude perdendo o solo', 'Alarme de sobrecarga no computador'], minor: ['Velocidade de descida acima do perfil', 'Combustível de descida abaixo do esperado'] },
  landing: { critical: ['Pedras grandes na zona de pouso!', 'Inclinação perigosa no ponto de toque'], minor: ['Poeira cegando as câmeras', 'Ponto de pouso um pouco deslocado'] },
  entry: { critical: ['Temperatura do escudo subindo demais', 'Ângulo de entrada fora do corredor'], minor: ['Plasma cortando a comunicação', 'Oscilação leve na entrada'] },
  dock: { critical: ['Aproximação rápida demais', 'Propulsores de manobra falhando'], minor: ['Desalinhamento no acoplamento', 'Sensor de distância instável'] },
  deploy: { critical: ['Queda de energia na implantação', 'Mecanismo de abertura travado'], minor: ['Painel solar abrindo devagar', 'Antena sem travar'] },
  generic: { critical: ['Telemetria indica falha em andamento', 'Sistemas críticos em alarme'], minor: ['Leitura fora do esperado', 'Alarme intermitente nos sensores'] },
};

const TELEMETRY = {
  ignition: 'T-0 · empuxo 100%',
  liftoff: 'T+0:03 · alt 0,1 km · 60 km/h',
  maxq: 'T+1:12 · alt 12 km · Mach 1,5',
  staging: 'T+2:40 · alt 70 km · 8.000 km/h',
  fairing_or_les: 'T+3:30 · alt 110 km · 9.500 km/h',
  orbit: 'T+8:50 · alt 200 km · 27.400 km/h',
  tli: 'T+1:05:00 · 39.000 km/h · rumo de escape',
};

// {em} / {a}: destination phrases from data ("na Lua", "à Lua"); emptied when the mission name already says where
const HEADLINES = {
  total: {
    ascent: ['{m} decola e chega ao espaço sem sustos', '{v} leva {m} à órbita com perfeição', 'Lançamento impecável: {m} está a caminho'],
    ascentFar: ['{m} decola rumo {a}', 'Rumo {a}: {m} deixa a Terra'],
    crewed: ['Tripulação de {m} chega ao espaço', '{m}: decolagem perfeita com tripulação a bordo'],
    arrival: ['{m} chega {a}!', 'Missão cumprida: {m} {em}'],
    landing: ['{m} pousa {em}!', 'Contato! {m} toca o solo {em}'],
  },
  partial: {
    ascent: ['{m} chega ao espaço, mas fora do plano', 'Meio sucesso: {m} em órbita errada'],
    arrival: ['{m} chega {a}, mas não cumpre tudo', 'Sucesso parcial para {m} {em}'],
  },
  recoverable: {
    ascent: ['Perdemos {m}, mas a lição fica', 'Falha no lançamento de {m}; sem vítimas'],
    crewed: ['Tripulação de {m} volta a salvo após abortar', 'Abort salva a tripulação de {m}'],
    arrival: ['{m} falha {em}, mas a nave sobrevive', 'Chegada de {m} frustrada'],
  },
  catastrophic: {
    ascent: ['{v} falha em {ms} e {m} se perde', 'Explosão em {ms} encerra {m}'],
    crewed: ['Tragédia: perdemos a tripulação de {m}', 'Luto: {m} termina em tragédia'],
    crewedSafe: ['Perdemos {m}, mas a tripulação escapa', 'Sistema de escape salva a tripulação de {m}'],
    arrival: ['Perdemos {m} {em}', 'Silêncio {em}: {m} se perde'],
  },
};

/** True when the mission name already names the destination (avoid "Marte 2 chega a Marte"). */
function nameSaysDest(al) {
  const n = String(al.name || '').toLowerCase();
  return [al.destName, al.destShort].filter((x) => x && x.length >= 3).some((x) => n.includes(String(x).toLowerCase()));
}

// ---------- helpers ----------

const r3 = (x) => Math.round(x * 1000) / 1000 + 0; // + 0: never -0 (JSON round-trip)
const pct = (x) => `${Math.round(x * 100)}%`;
/** Small risks keep a decimal ("0,4%", "<0,1%") so a cause never reads "risco de 0%". */
const pctFine = (x) => {
  const v = (Number(x) || 0) * 100;
  if (v < 0.1) return '<0,1%';
  if (v < 10) return `${(Math.round(v * 10) / 10).toString().replace('.', ',')}%`;
  return `${Math.round(v)}%`;
};

function safe(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    const v = fn(...args);
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function roll(seed, ...labels) {
  return rngFor(seed, ...labels).next();
}

function pick(seed, list, ...labels) {
  if (!list?.length) return '';
  return list[Math.floor(roll(seed, 'pick', ...labels) * list.length)];
}

function groupOf(id) {
  return risk.msGroup(id);
}

function personName(state, id) {
  return (id && state.crew?.[id]?.name) || null;
}

function fill(state, al, text) {
  const rep = /\{em\}|\{a\}/.test(String(text)) && nameSaysDest(al);
  const em = rep ? '' : al.destEm || `em ${al.destName}`;
  const to = rep ? 'ao destino' : al.destTo || `a ${al.destName}`;
  let t = String(text).replaceAll('{em}', em).replaceAll('{a}', to);
  if (rep) t = t.replace(/ +([!:,])/g, '$1').replace(/ {2,}/g, ' ').trim();
  return t
    .replaceAll('{m}', al.name)
    .replaceAll('{v}', al.vehicleName)
    .replaceAll('{dest}', al.destName)
    .replaceAll('{fd}', personName(state, al.lineup.flightDirector) || 'Direção de voo')
    .replaceAll('{cmd}', personName(state, al.lineup.commander) || 'Comandante')
    .replaceAll('{ms}', al.endedAt?.label || 'voo');
}

function pushLog(state, al, t, kind, text, ms) {
  const line = fill(state, al, text);
  al.log.push({ t, kind, text: line });
  if (al.log.length > 120) al.log.splice(0, al.log.length - 120);
  if (ms && kind === 'radio') ms.radio.push(line);
}

function findMission(state, id) {
  return (state.missions || []).find((m) => m.id === id) || null;
}

function lookup(data, kind, id) {
  return risk.lookup ? risk.lookup(data, kind, id) : data?.index?.[kind]?.[id] || null;
}

function skillOf(state, id) {
  return state.crew?.[id]?.skill ?? 50;
}

/** Plan for risk.missionRisk from a mission + the scene lineup. */
function planFor(state, mission, al) {
  return {
    actorId: state.playerId,
    type: mission.type,
    destination: mission.destination,
    vehicleId: mission.vehicleId,
    spacecraftId: mission.spacecraftId,
    secondarySpacecraftId: mission.secondarySpacecraftId || undefined,
    crew: { ...(mission.crew || {}), flightDirector: al.lineup.flightDirector ?? null, commander: al.lineup.commander ?? null },
    config: { ...(mission.config || {}), strategy: al.lineup.strategy, fuelMargin: al.lineup.fuelMargin },
    launchTurn: Number.isFinite(mission.launchTurn) ? mission.launchTurn : state.turn,
    createdTurn: mission.createdTurn,
    calendarId: mission.calendarId || undefined,
    crewed: mission.crewed ?? (mission.type === 'crewed' || undefined),
    weather: al.weather,
  };
}

function rollWeather(state, data, mission, phase) {
  const dest = lookup(data, 'destinations', mission.destination);
  const surface = /surface|pole|polo/.test(String(mission.destination)) || /surface|landing/.test(String(dest?.kind || ''));
  const table = phase === 'arrival' ? WEATHER_SPACE.filter((w) => !w.surfaceOnly || surface) : WEATHER_ASCENT;
  const w = rngFor(state.seed, 'weather', mission.id, phase, state.turn).weighted(table) || table[0];
  return { code: w.code, label: w.label, risk: w.risk };
}

function commandPointsFor(state, data, crewSel) {
  const v = safe(crew.commandPointsFor, [state, data, crewSel], null);
  if (Number.isFinite(v)) return clamp(Math.round(v), 1, 5);
  // fallback: 2 base, +1 for a skilled flight director, + tech
  let cp = 2;
  if (crewSel?.flightDirector && skillOf(state, crewSel.flightDirector) >= 70) cp += 1;
  cp += Math.round(safe(research.techBonus, [state, state.playerId, 'commandPoints'], 0) || 0);
  return clamp(cp, 1, 5);
}

/** Recompute estimate + milestone risks from the current lineup/weather (only while milestones are pending). */
function rebuild(state, data, al) {
  const mission = findMission(state, al.missionId) || al.snapshot;
  // the lineup sets the ceiling; the agency's pool (what earlier scenes left) sets what is really there
  const cap = commandPointsFor(state, data, { ...(mission?.crew || {}), flightDirector: al.lineup.flightDirector, commander: al.lineup.commander });
  al.commandPoints = Math.max(0, Math.min(cap, Number.isFinite(al.pool) ? al.pool : cap));
  al.commandPointsCap = cap;
  al.commandPointsStart = al.commandPoints;
  state.commandPoints = al.commandPoints;
  const est = risk.missionRisk(state, data, { ...planFor(state, mission, al), commandPoints: al.commandPoints });
  const list = (est.milestones || []).filter((m) => m.phase === al.phase);
  let ms = list.map((m) => ({ id: m.id, label: m.label, t: m.t, pFail: m.pFail, anomalyBand: m.anomalyBand, failureWeights: m.failureWeights, phase: m.phase, status: 'pending', radio: [], ...(Number.isFinite(m.pEscape) ? { pEscape: m.pEscape } : {}), ...(m.radio ? { dataRadio: m.radio } : {}) }));
  if (!ms.length) {
    const pf = al.phase === 'arrival' ? clamp(1 - (est.pArrivalRaw ?? est.pArrival ?? 0.97), 0.01, 0.5) : clamp(1 - (est.pRaw ?? est.p ?? 0.9), 0.01, 0.6);
    ms = [{ id: al.phase === 'arrival' ? 'arrival' : 'orbit', label: al.phase === 'arrival' ? 'Chegada' : 'Inserção orbital', t: 10, pFail: pf, anomalyBand: 0.06, failureWeights: { propulsion: 0.35, structure: 0.2, software: 0.25, human: 0.1, environment: 0.1 }, phase: al.phase, status: 'pending', radio: [] }];
  }
  ms[ms.length - 1].climax = true;
  // transit/operation events (mission.riskMod, owned by missions) shift this phase's odds
  const mod = typeof missions.riskModOf === 'function' ? missions.riskModOf(state, mission) : Number(mission?.riskMod) || 0;
  let modFactor = null;
  if (mod) {
    const p0 = ms.reduce((p, m) => p * (1 - m.pFail), 1);
    const p1 = clamp(p0 + mod, 0.02, 0.995);
    const k = Math.log(p1) / Math.log(Math.max(1e-6, Math.min(0.999999, p0)));
    for (const m of ms) m.pFail = Math.round(clamp(1 - Math.pow(1 - m.pFail, k), 0.0002, 0.9) * 100000) / 100000;
    modFactor = { label: mod < 0 ? 'Danos e imprevistos da missão' : 'Imprevistos a favor', delta: r3(p1 - p0), kind: 'environment' };
  }
  // keep statuses/radio of already-resolved milestones (rebuild is only called before the first step)
  al.milestones = ms;
  al.pRawPhase = r3(ms.reduce((p, m) => p * (1 - m.pFail), 1));
  // mission-level numbers (risk.missionRisk) the phase chance is derived from
  al.mission = { p: est.p, low: est.low, high: est.high, pArrival: est.pArrival ?? 1, modFactor, factors: est.factors || [], warnings: est.warnings || [] };
  al.estimate = { errors: est.errors, valid: est.valid, pAscent: est.pAscent, pArrival: est.pArrival };
  al.prestigeMult = est.prestigeMult ?? 1;
  al.scienceMult = est.scienceMult ?? 1;
  al.vehicleFlights = est.vehicleFlights ?? 0;
  phaseOdds(state, data, al);
  return al;
}

/** Index of the milestone a real sensor fault makes riskier ('go' through a sensor hold). */
function sensorIndexOf(n) {
  return Math.min(n - 1, Math.max(1, Math.floor(n / 2)));
}

/** Escape chance at milestone i when the estimate did not carry one (fallback milestones). */
function escapeAt(state, data, al, i) {
  const m = al.milestones[i];
  if (Number.isFinite(m?.pEscape)) return m.pEscape;
  const orbit = al.milestones.findIndex((x) => x.id === 'orbit');
  return risk.escapeChance(data, {
    phase: al.phase, early: al.phase === 'ascent' && i < orbit, crewSafety: crewSafety(state),
    fuelMargin: al.lineup.fuelMargin, strategy: al.lineup.strategy, survival: safe(crew.survivalBonus, [state, data, al.crewIds], 0),
  });
}

/**
 * The chance shown in the scene: exact odds of THIS phase (risk.sceneOdds, same rules as the rolls) with the
 * scene's Command points, frozen nerves and the flight director's standard play. Also freezes al.nervesMult.
 */
function phaseOdds(state, data, al) {
  al.nervesMult = r3(risk.nervesMult(al.nerves));
  const n = al.milestones.length;
  const fd = al.lineup.flightDirector;
  const hasCrew = al.crewed && al.crewIds.length > 0;
  if (hasCrew) al.milestones.forEach((m, i) => { if (!Number.isFinite(m.pEscape)) m.pEscape = r3(escapeAt(state, data, al, i)); });
  const opts = {
    phase: al.phase, crewed: al.crewed, cp: al.commandPoints, hasFD: !!fd, acc: risk.hintAccuracy(fd ? skillOf(state, fd) : NaN),
    nervesMult: al.nervesMult, pfMult: al.pfMult || 1, escape: (i) => (hasCrew ? al.milestones[i].pEscape : 1),
  };
  let o = risk.sceneOdds(al.milestones, opts);
  if (al.hold?.reason === 'sensor' && al.hold.choice === 'go' && n > 1) {
    // nobody knows if the alarm was real: half the time it was
    const o2 = risk.sceneOdds(al.milestones, { ...opts, sensorIndex: sensorIndexOf(n) });
    o = { p: (o.p + o2.p) / 2, pCrewLoss: (o.pCrewLoss + o2.pCrewLoss) / 2 };
  }
  const M = al.mission || { p: o.p, low: o.p, high: o.p, pArrival: 1, factors: [], warnings: [] };
  // band: same width in failure space as the mission estimate
  const rl = M.p < 0.9999 ? (1 - M.low) / (1 - M.p) : 1.3;
  const rh = M.p < 0.9999 ? (1 - M.high) / (1 - M.p) : 0.7;
  const p = clamp(o.p, 0.01, 0.995);
  const kPhase = al.pRawPhase < 0.9999 ? clamp((1 - p) / (1 - al.pRawPhase), 0.2, 3) : 1;
  const mf = M.modFactor ? { ...M.modFactor, delta: r3(M.modFactor.delta * kPhase) } : null;
  const pMission = al.phase === 'ascent' && al.arrivalAhead ? p * (M.pArrival ?? 1) : p;
  const pCrewLoss = hasCrew ? o.pCrewLoss : 0;
  const warnings = (M.warnings || []).filter((w) => !String(w).startsWith('Risco estimado de perder a tripulação'));
  const extra = [];
  if (hasCrew) extra.push(`Risco de perder a tripulação ${al.phase === 'arrival' ? 'na chegada' : 'nesta subida'}: ${risk.pctFine ? risk.pctFine(pCrewLoss) : pct(pCrewLoss)}.`);
  if (al.phase === 'ascent' && al.arrivalAhead) extra.push(`A chance mostrada é da subida; com a chegada, a missão completa tem ~${pct(pMission)}.`);
  const base = al.estimate || {};
  al.estimate = {
    ...base,
    p: r3(p),
    low: r3(clamp(1 - (1 - p) * rl, 0.01, p)),
    high: r3(clamp(1 - (1 - p) * rh, p, 0.995)),
    factors: mf ? [...(M.factors || []), mf] : [...(M.factors || [])],
    warnings: [...extra, ...warnings],
    pPhase: r3(p),
    pPhaseRaw: al.pRawPhase,
    pMission: r3(pMission),
    pCrewLoss: r3(pCrewLoss),
    commandPoints: al.commandPoints,
  };
  return al.estimate;
}

function initialMood(al) {
  const p = al.pRawPhase ?? 0.9;
  al.nerves = risk.initialNerves(p, al.weather?.risk ?? 0, al.crewed);
  al.confidence = Math.round(clamp(p * 100 - 8, 10, 95));
}

function bump(al, dn, dc) {
  al.nerves = Math.round(clamp(al.nerves + dn, 0, 100));
  al.confidence = Math.round(clamp(al.confidence + dc, 0, 100));
}

/** Effective failure probability of milestone i right now. */
function effPF(al, i) {
  const m = al.milestones[i];
  let pf = m.pFail * (al.pfMult || 1);
  // nervous room = human factor (frozen when the countdown ends, so the shown chance can price it)
  pf *= Number.isFinite(al.nervesMult) ? al.nervesMult : risk.nervesMult(al.nerves);
  if (al.sensorIssue && al.sensorIssue.index === i) pf *= SENSOR_PF_MULT;
  return clamp(pf, 0, risk.SCENE.PF_MAX);
}

/** 'sudden' | 'critical' | 'minor' | 'ok' for milestone i at failure probability pf. */
function classify(al, i, pf) {
  const r = roll(al.seed, 'ms', i);
  if (r < pf * SUDDEN) return 'sudden';
  if (r < pf) return 'critical';
  if (r < pf + al.milestones[i].anomalyBand) return 'minor';
  return 'ok';
}

/**
 * At least one card per scene: a clean roll at the countdown's forcedIndex becomes a scare (a minor-looking
 * anomaly that is a false alarm: riding it out is safe) when no card came before it. No look-ahead, so
 * risk.sceneOdds can price it exactly.
 */
function shouldForce(al, i) {
  return al.forcedIndex != null && i === al.forcedIndex && al.interventions.length === 0 && !(al.autoHandled || []).length;
}

// ---------- scene lifecycle ----------

/** Create state.activeLaunch for a mission. Returns the scene or null. */
export function openScene(state, data, missionId, phase = 'ascent') {
  const mission = findMission(state, missionId);
  if (!mission) return null;
  const vehicle = lookup(data, 'vehicles', mission.vehicleId);
  const dest = lookup(data, 'destinations', mission.destination);
  const crewIds = [mission.crew?.commander, ...(mission.crew?.astronauts || [])].filter((x, i, a) => x && a.indexOf(x) === i);
  const flown = state.stats?.[`launch.flown.${missionId}.${phase}`] || 0;
  const al = {
    missionId,
    phase,
    act: 'prelaunch',
    seed: null,
    attempt: Math.max(mission.attempts || 0, flown),
    name: mission.name || 'Missão',
    vehicleId: mission.vehicleId,
    vehicleName: vehicle?.name || mission.vehicleId || 'veículo',
    spacecraftId: mission.spacecraftId,
    destination: mission.destination,
    destName: dest?.name || mission.destination || 'destino',
    destShort: dest?.short || null,
    destEm: dest?.emLabel || null,
    destTo: dest?.toLabel || null,
    crewed: !!(mission.crewed ?? (mission.type === 'crewed' || crewIds.length > 0)),
    crewIds,
    lineup: {
      flightDirector: mission.crew?.flightDirector ?? null,
      commander: mission.crew?.commander ?? null,
      strategy: STRATEGY_IDS.includes(mission.config?.strategy) ? mission.config.strategy : 'balanced',
      fuelMargin: clamp(Number.isFinite(mission.config?.fuelMargin) ? mission.config.fuelMargin : 0.1, 0, 0.3),
    },
    estimate: null,
    weather: rollWeather(state, data, mission, phase),
    pendingHold: null,
    hold: null, // {reason, choice}
    milestones: [],
    current: 0,
    pendingIntervention: null,
    interventions: [],
    commandPoints: 2,
    commandPointsStart: 2,
    nerves: 30,
    confidence: 60,
    log: [],
    outcome: null,
    pfMult: 1,
    marginUsed: 0,
    sensorIssue: null,
    forcedIndex: null,
    endedAt: null,
    startTurn: state.turn,
    pool: Number.isFinite(state.commandPoints) ? state.commandPoints : null,
    arrivalAhead: phase === 'ascent' && typeof missions.needsTransit === 'function' && !!missions.needsTransit(data, mission),
    snapshot: { id: mission.id, type: mission.type, destination: mission.destination, vehicleId: mission.vehicleId, spacecraftId: mission.spacecraftId, crew: mission.crew || {}, config: mission.config || {}, launchTurn: mission.launchTurn, createdTurn: mission.createdTurn, name: mission.name },
  };
  state.activeLaunch = al;
  rebuild(state, data, al);
  initialMood(al);
  phaseOdds(state, data, al);
  const s0 = hash32(state.seed, 'intro', missionId, phase, state.turn);
  pushLog(state, al, -60, 'radio', pick(s0, phase === 'arrival' ? RADIO.introArrival : RADIO.intro, 'intro'));
  pushLog(state, al, -60, 'telemetry', `Clima: ${al.weather.label}`);
  return al;
}

/** Postpone a mission/arrival by 1-2 weeks (scrub). */
function postpone(state, missionId, phase, reasonText, supportCost = 1) {
  const mission = findMission(state, missionId);
  const weeks = roll(state.seed, 'scrub', missionId, phase, state.turn) < 0.5 ? 1 : 2;
  if (mission) {
    // a new day is a new countdown: the scrub count feeds the countdown seed (holds, sensor glitches)
    mission.scrubs = (mission.scrubs || 0) + 1;
    if (phase === 'arrival') {
      if (mission.transit && Number.isFinite(mission.transit.arriveTurn)) mission.transit.arriveTurn = Math.max(mission.transit.arriveTurn, state.turn) + weeks;
      if (mission.status === 'arrival') mission.status = 'transit';
    } else {
      mission.launchTurn = Math.max(Number.isFinite(mission.launchTurn) ? mission.launchTurn : state.turn, state.turn) + weeks;
      if (mission.status === 'launch') mission.status = 'scheduled';
    }
  }
  if (supportCost) changeActor(state, state.playerId, 'support', -supportCost);
  addNews(state, {
    headline: `${phase === 'arrival' ? 'Chegada' : 'Lançamento'} de ${mission?.name || 'missão'} ${phase === 'arrival' ? 'adiada' : 'adiado'} em ${weeks} semana${weeks > 1 ? 's' : ''}`,
    body: reasonText || 'A direção preferiu não arriscar hoje.',
    tags: ['launch', 'scrub'],
    actors: [state.playerId],
    importance: 1,
    icon: 'launch',
  });
  return weeks;
}

// ---------- milestone resolution ----------

function telemetryFor(al, m) {
  return TELEMETRY[m.id] || `${m.label}`;
}

function radioFor(al, m, status, i) {
  const g = MS_RADIO[groupOf(m.id)] || MS_RADIO.generic;
  let pool = g[status] || MS_RADIO.generic[status];
  if (status === 'ok' && al.crewed && g.okCrew) pool = g.okCrew;
  return pick(al.seed, pool, 'radio', i, status);
}

function makeIntervention(state, al, i, severity) {
  const m = al.milestones[i];
  const g = PROMPTS[groupOf(m.id)] || PROMPTS.generic;
  // the flight director's read of the telemetry: better directors describe the real severity
  const fd = al.lineup.flightDirector;
  const acc = fd ? clamp(0.55 + skillOf(state, fd) / 250, 0.55, 0.95) : 0.5;
  const honest = roll(al.seed, 'hint', i) < acc;
  const shown = honest ? severity : severity === 'critical' ? 'minor' : 'critical';
  let prompt = pick(al.seed, g[shown], 'prompt', i);
  if (m.id === 'fairing_or_les' && al.crewed) prompt = prompt.replace('separação', 'torre de escape');
  const cp = al.commandPoints;
  const arrival = al.phase === 'arrival';
  const landingMs = arrival && al.milestones.some((x) => /descent|landing|touch|hazard/.test(x.id));
  const opts = [
    { id: 'reduce', label: arrival ? (landingMs ? 'Descida mais lenta' : 'Queima mais suave') : 'Reduzir empuxo', cost: 1, preview: arrival ? 'Menos risco agora, gasta a reserva de combustível' : 'Menos risco agora, menos margem depois' },
    { id: 'maintain', label: 'Manter', cost: 0, preview: 'Confia no veículo e segue o perfil' },
    { id: 'contingency', label: 'Contingência', cost: 2, preview: 'A sala assume o procedimento de emergência' },
    {
      id: 'abort',
      label: arrival ? (al.crewed && landingMs ? 'Abortar pouso' : 'Abortar e preservar') : 'Abortar',
      cost: al.crewed ? 0 : 1,
      preview: arrival ? 'Salva a nave; missão vira sucesso parcial' : al.crewed ? 'Salva a tripulação; missão perdida' : 'Encerra com segurança; missão perdida',
    },
  ];
  for (const o of opts) {
    if (o.cost > cp) Object.assign(o, { disabled: true, reason: 'Pontos de Comando insuficientes' });
    if (o.id === 'contingency' && !fd) Object.assign(o, { disabled: true, reason: 'Exige diretor de voo' });
  }
  return { id: `int_${al.missionId}_${al.phase}_${i}`, milestoneId: m.id, index: i, prompt, options: opts, seconds: 5, defaultOption: 'maintain', hint: shown };
}

function milestoneOk(state, al, i, how = 'clean') {
  const m = al.milestones[i];
  m.status = 'ok';
  pushLog(state, al, m.t, 'telemetry', telemetryFor(al, m), m);
  if (how === 'saved') pushLog(state, al, m.t, 'radio', pick(al.seed, RADIO.saved, 'saved', i), m);
  else if (how === 'rode') pushLog(state, al, m.t, 'radio', pick(al.seed, RADIO.rode, 'rode', i), m);
  if (m.dataRadio?.length) for (const line of m.dataRadio) pushLog(state, al, m.t, 'radio', line, m);
  else pushLog(state, al, m.t, 'radio', radioFor(al, m, 'ok', i), m);
  bump(al, how === 'clean' ? -5 : -10, how === 'clean' ? 4 : 8);
  al.current = i + 1;
  if (al.current >= al.milestones.length) concludeSuccess(state, al);
  return { milestone: m, status: 'ok' };
}

function milestoneFail(state, al, i, how) {
  const m = al.milestones[i];
  m.status = 'fail';
  al.current = i + 1;
  al.endedAt = { id: m.id, label: m.label, index: i, how };
  pushLog(state, al, m.t, 'radio', radioFor(al, m, 'fail', i), m);
  pushLog(state, al, m.t + 1, 'radio', pick(al.seed, RADIO.climaxFail, 'cf', i), m);
  bump(al, 100, -100);
  // failure type: milestone weights, nudged by nerves and weather
  const w = { ...m.failureWeights };
  w.human = (w.human || 0) + Math.max(0, al.nerves - 60) / 400;
  const ft = pickFailureType(rngFor(al.seed, 'ft', i), w);
  concludeFailure(state, al, i, ft, how);
  return { milestone: m, status: 'fail' };
}

/** Resolve the next milestone (no pending card). */
function resolveNext(state, data, al) {
  const i = al.current;
  const m = al.milestones[i];
  const pf = effPF(al, i);
  m.pEff = r3(pf);
  let kind = classify(al, i, pf);
  if (kind === 'ok' && shouldForce(al, i)) {
    kind = 'minor';
    m.forced = true;
  }
  if (kind === 'sudden') return milestoneFail(state, al, i, 'sudden');
  if (kind === 'ok') return milestoneOk(state, al, i, 'clean');
  // anomaly
  m.status = 'anomaly';
  m.severity = kind;
  pushLog(state, al, m.t, 'radio', radioFor(al, m, 'anomaly', i), m);
  bump(al, 18, -12);
  if (al.interventions.length < MAX_INTERVENTIONS) {
    al.pendingIntervention = makeIntervention(state, al, i, kind);
    return { milestone: m, status: 'anomaly', intervention: al.pendingIntervention };
  }
  pushLog(state, al, m.t, 'event', pick(al.seed, RADIO.auto, 'auto', i), m);
  return applyOption(state, al, i, 'maintain', true);
}

function applyOption(state, al, i, optionId, auto = false) {
  const m = al.milestones[i];
  const pf = m.pEff ?? effPF(al, i);
  const severity = m.severity || 'minor';
  const r = roll(al.seed, 'ms', i);
  if (!auto) al.interventions.push({ milestoneId: m.id, optionId, severity, index: i });
  else al.autoHandled = [...(al.autoHandled || []), { milestoneId: m.id, severity, index: i }];
  const rec = auto ? null : al.interventions[al.interventions.length - 1];

  if (optionId === 'abort') {
    pushLog(state, al, m.t, 'radio', pick(al.seed, RADIO.abort, 'abort', i), m);
    m.status = 'fail';
    al.current = i + 1;
    al.endedAt = { id: m.id, label: m.label, index: i, how: 'abort' };
    bump(al, -20, -30);
    const ft = pickFailureType(rngFor(al.seed, 'ft', i), m.failureWeights);
    concludeAbort(state, al, i, ft, severity);
    return { milestone: m, status: 'abort' };
  }
  let fail;
  if (optionId === 'reduce') {
    fail = severity === 'critical' && r < pf * REDUCE_FAIL;
    al.marginUsed = r3(al.marginUsed + REDUCE_MARGIN);
    al.pfMult = r3((al.pfMult || 1) * REDUCE_PF_MULT);
    bump(al, -6, 2);
  } else if (optionId === 'contingency') {
    fail = severity === 'critical' && r < pf * CONTINGENCY_FAIL;
    // emergency procedure for a minor glitch: works, but spends propellant/time margin
    if (severity !== 'critical') al.marginUsed = r3((al.marginUsed || 0) + CONTINGENCY_MARGIN);
    bump(al, -10, 4);
  } else {
    // maintain
    fail = severity === 'critical' || (!m.forced && roll(al.seed, 'ms2', i) < pf * MINOR_MAINTAIN_FAIL);
    bump(al, 6, -2);
  }
  if (rec) rec.saved = !fail && severity === 'critical';
  if (fail) return milestoneFail(state, al, i, 'anomaly');
  return milestoneOk(state, al, i, optionId === 'maintain' ? 'rode' : 'saved');
}

// ---------- outcomes, causes, headlines ----------

function crewSafety(state) {
  return clamp(safe(research.techBonus, [state, state.playerId, 'crewSafety'], 0) || 0, 0, 0.4);
}

function concludeSuccess(state, al) {
  const last = al.milestones[al.milestones.length - 1];
  al.endedAt = { id: last.id, label: last.label, index: al.milestones.length - 1, how: 'success' };
  const tight = al.marginUsed > al.lineup.fuelMargin + 0.05;
  const level = tight ? 'partial' : 'total';
  pushLog(state, al, last.t + 2, 'radio', pick(al.seed, RADIO.climaxOk, 'cok'), last);
  bump(al, -100, 100);
  setOutcome(state, al, level, null, { tight });
}

function concludeFailure(state, al, i, ft, how) {
  const m = al.milestones[i];
  // how a failure ends (partial / recoverable / catastrophic) and the escape chance come from risk.js,
  // the same tables risk.sceneOdds uses for the chance and the crew risk shown before launch
  const level = risk.failureLevel(risk.failureSplit(m.id, al.phase, al.crewed), roll(al.seed, 'sev', i));
  const extra = { how };
  if (level === 'catastrophic' && al.crewed && al.crewIds.length) {
    if (roll(al.seed, 'survive', i) < (Number.isFinite(m.pEscape) ? m.pEscape : 0.2)) {
      extra.escaped = true;
    } else {
      extra.crewLost = al.crewIds.slice();
    }
  }
  setOutcome(state, al, level, ft, extra);
}

function concludeAbort(state, al, i, ft, severity) {
  const level = al.phase === 'arrival' ? 'partial' : 'recoverable';
  setOutcome(state, al, level, ft, { how: 'abort', severity });
}

function buildCauses(state, al, level, ft, extra) {
  const causes = [];
  const add = (kind, label, detail, weight) => causes.push({ kind, label, detail: detail || '', weight: r3(weight) });
  const success = level === 'total' || level === 'partial';
  const end = al.endedAt;
  const est = al.estimate || {};
  const pPhase = est.pPhase ?? est.p ?? 0.9;

  // part
  if (ft && end && extra.how !== 'abort') {
    add('part', `${FAILURE_LABELS[ft]} em ${end.label}`, `Origem provável: ${FAILURE_DESCRIPTIONS[ft]}.`, -1);
  } else if (ft && extra.how === 'abort') {
    add('part', `Anomalia de ${FAILURE_LABELS[ft].toLowerCase()} em ${end.label}`, `Sinal vindo de ${FAILURE_DESCRIPTIONS[ft]}.`, -0.5);
  }
  if (success) {
    const flights = al.vehicleFlights || 0;
    add('part', al.phase === 'arrival' ? 'A nave cumpriu a sequência de chegada' : `${al.vehicleName} cumpriu o perfil de voo`, flights ? `${flights} voo${flights === 1 ? "" : "s"} de histórico pesaram a favor.` : 'Veículo novo que se provou hoje.', flights >= 20 ? 0.5 : 0.35);
  }
  for (const f of est.factors || []) {
    if (f.kind === 'part' && !f.info && f.label.startsWith('Pesquisa')) add('part', f.label, `Efeito estimado: ${f.delta > 0 ? '+' : ''}${Math.round(f.delta * 1000) / 10} p.p.`, clamp(f.delta * 8, -0.6, 0.6));
  }

  // decisions: lineup factors
  for (const f of est.factors || []) {
    if (f.kind !== 'decision' || f.info) continue;
    const good = f.delta > 0;
    add('decision', f.label, `${good ? 'Ganhou' : 'Custou'} ${Math.abs(Math.round(f.delta * 1000) / 10)} p.p. na chance estimada.`, clamp(f.delta * 6, -0.6, 0.6));
  }
  // decisions: hold
  if (al.hold) {
    if (al.hold.choice === 'hold') add('decision', al.hold.reason === 'weather' ? 'Segurar a contagem pelo clima' : 'Segurar a contagem pelo sensor', 'Paciência reduziu o risco do dia.', 0.35);
    if (al.hold.choice === 'go') add('decision', al.hold.reason === 'weather' ? 'Lançar com clima ruim' : 'Lançar com sensor duvidoso', 'Aceitar o risco cobrou seu preço no voo.', success ? -0.15 : -0.5);
  }
  // decisions: interventions
  for (const it of al.interventions) {
    const ms = al.milestones[it.index];
    const L = ms?.label || it.milestoneId;
    if (it.optionId === 'abort') {
      if (it.severity === 'critical') add('decision', `Abortar em ${L} evitou o pior`, 'A anomalia era real e grave.', 0.6);
      else add('decision', `Abortar em ${L} foi precaução demais`, 'A telemetria depois mostrou uma anomalia menor.', -0.5);
    } else if (it.optionId === 'reduce' || it.optionId === 'contingency') {
      const name = it.optionId === 'reduce' ? (al.phase === 'arrival' ? 'Descer mais devagar' : 'Reduzir empuxo') : 'O procedimento de contingência';
      if (it.saved) add('decision', `${name} em ${L} salvou a missão`, 'A anomalia era grave; a reação veio a tempo.', 0.8);
      else if (ms?.status === 'fail') add('decision', `${name} em ${L} não bastou`, 'A falha já estava avançada.', -0.3);
      else add('decision', `${name} em ${L}`, 'Cautela diante de uma anomalia menor.', it.optionId === 'reduce' ? 0.1 : 0.2);
    } else if (it.optionId === 'maintain') {
      if (ms?.status === 'fail' && it.severity === 'critical') add('decision', `Manter em ${L} foi fatal`, 'A anomalia era grave e pedia reação.', -0.8);
      else if (ms?.status === 'fail') add('decision', `Manter em ${L} não deu certo`, 'Uma anomalia menor cresceu.', -0.4);
      else add('decision', `Sangue frio em ${L}`, 'Manter o perfil era o certo.', 0.3);
    }
  }
  if (extra.tight) {
    // name what really burned the margin
    const used = new Set(al.interventions.filter((x) => x.optionId === 'reduce' || (x.optionId === 'contingency' && x.severity !== 'critical')).map((x) => x.optionId));
    const label = used.has('reduce') && used.has('contingency') ? 'Contingências e reduções consumiram a margem'
      : used.has('contingency') ? 'As contingências consumiram a margem' : 'As reduções consumiram a margem';
    add('decision', label, 'Sem combustível de sobra, o resultado ficou abaixo do plano.', -0.5);
  }

  // luck
  if (end && (extra.how === 'sudden' || extra.how === 'anomaly')) {
    const m = al.milestones[end.index];
    add('luck', `Dado da sorte em ${end.label}`, `Sorteio caiu na faixa de falha: risco de ${pctFine(m.pEff ?? m.pFail)} nesse marco.`, extra.how === 'sudden' ? -0.7 : -0.4);
  } else if (success) {
    if (pPhase < 0.75) add('luck', 'A sorte sorriu', `A chance era de ${pct(pPhase)} e deu certo.`, 0.5);
    const close = al.milestones.filter((m) => m.status === 'ok' && m.severity === 'critical');
    if (close.length) add('luck', `Passou raspando em ${close[0].label}`, 'A anomalia era grave, e mesmo assim a nave resistiu.', 0.4);
    else if (pPhase >= 0.75) add('luck', 'Nenhum dado contra', 'Os sorteios do dia ficaram longe da faixa de falha.', 0.2);
  }
  if (extra.escaped) add('luck', 'Sistema de escape funcionou', 'A tripulação sobreviveu à perda do veículo.', 0.7);

  // environment
  const wr = al.weather?.risk ?? 0;
  if (wr >= 0.2) add('environment', `Clima: ${al.weather.label}`, al.hold?.choice === 'hold' ? 'O clima melhorou durante a espera.' : 'O clima pesou contra.', ft === 'environment' ? -0.7 : -clamp(wr, 0.1, 0.4));
  else if (success) add('environment', `Clima: ${al.weather?.label || 'bom'}`, 'Condições a favor.', 0.15);
  for (const f of est.factors || []) {
    if (f.kind === 'environment' && !String(f.label).startsWith('Clima') && Math.abs(f.delta) >= 0.002) add('environment', f.label, envDetail(al, f.label), clamp(f.delta * 6, -0.5, 0.5));
  }

  // crew
  const fd = personName(state, al.lineup.flightDirector);
  if (fd) {
    const sk = skillOf(state, al.lineup.flightDirector);
    add('crew', `${state.crew?.[al.lineup.flightDirector]?.gender === "f" ? "Diretora" : "Diretor"} de voo: ${fd}`, sk >= 70 ? 'Leitura fina da telemetria.' : sk < 40 ? 'Pouca experiência na cadeira.' : 'Sala bem conduzida.', clamp((sk - 50) / 80, -0.5, 0.5) + (success ? 0.1 : 0));
  } else add('crew', 'Sala sem diretor de voo', 'Menos pontos de Comando e leitura pior das anomalias.', -0.4);
  const cmd = personName(state, al.lineup.commander);
  if (al.crewed && cmd) add('crew', `Comandante: ${cmd}`, success ? 'Voz calma no rádio.' : 'Seguiu o treino até o fim.', success ? 0.3 : 0.1);
  for (const f of est.factors || []) if (f.kind === 'crew' && f.info && Math.abs(f.delta) >= 0.003 && !/^Diretora? de voo|^Diretor\(a\) de voo/.test(f.label)) add('crew', f.label, '', clamp(f.delta * 6, -0.4, 0.4));
  if (al.nerves >= 75 && !success) add('crew', 'Nervos à flor da pele na sala', 'A tensão aumentou o risco de erro humano.', -0.25);
  if (extra.crewLost?.length) add('crew', `Perdemos ${extra.crewLost.length} tripulante${extra.crewLost.length > 1 ? 's' : ''}`, extra.crewLost.map((id) => personName(state, id)).filter(Boolean).join(', '), -1);

  causes.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  if (success) return causes.slice(0, 9);
  // a failure report leads with what went wrong; at most two consolations
  const neg = causes.filter((c) => c.weight < 0);
  const pos = causes.filter((c) => c.weight >= 0).slice(0, 2);
  return [...neg, ...pos].slice(0, 9);
}

/** Specific text for an environment factor of the estimate (destination difficulty, politics, sanctions). */
function envDetail(al, label) {
  const s = String(label);
  if (s.startsWith('Dificuldade do destino')) {
    const d = String(al.destination || '');
    if (d === 'lunar_south_pole') return 'Pouso no polo sul: sombras longas, terreno acidentado e nenhuma atmosfera para frear.';
    if (d === 'lunar_surface') return 'Descida sem atmosfera: só os motores seguram a nave, sem margem para erro.';
    if (d === 'mars_surface') return 'Entrada, descida e pouso em Marte: sete minutos sem ajuda da Terra.';
    if (d === 'mars_orbit') return 'Captura em Marte: uma queima longa, longe demais para correções em tempo real.';
    if (d === 'titan') return 'Entrada em Titã: ar denso e frio, a mais de uma hora-luz de qualquer ajuda.';
    if (d === 'venus_atmosphere') return 'Mergulho em Vênus: calor de forno, pressão esmagadora e ácido nas nuvens.';
    if (d === 'venus_orbit' || d === 'venus_flyby') return 'Vênus: muito calor perto do Sol e uma passagem que não se repete.';
    if (d === 'mercury_orbit' || d === 'mercury_flyby') return 'Mercúrio: Sol a pino, calor extremo e uma captura difícil de acertar.';
    if (d === 'phobos') return 'Pouso em Fobos: gravidade quase nula, a nave pode quicar para longe.';
    if (d === 'neo_sample_return') return 'Toque e volta num asteroide: superfície incerta e uma cápsula que precisa voltar.';
    if (d === 'neo_asteroid' || d === 'apophis' || d === 'didymos' || d === 'psyche' || d === 'ceres') return 'Encontro com corpo pequeno: navegação fina, gravidade fraca e forma pouco conhecida.';
    if (d === 'jupiter_trojans' || d === 'kuiper' || d === 'pluto_flyby' || d === 'neptune_flyby') return 'Passagem única no espaço profundo: anos de viagem e nenhuma segunda chance.';
    if (['jupiter', 'europa_flyby', 'ganymede_orbit'].includes(d)) return 'Sistema de Júpiter: radiação intensa e sinal com quase uma hora de atraso.';
    if (['saturn_orbit', 'enceladus_flyby', 'uranus_orbit'].includes(d)) return 'Espaço profundo: anos de viagem e sinal com horas de atraso.';
    if (d === 'lunar_orbit' || d === 'cislunar') return 'Inserção lunar: uma queima precisa, com a Terra a um segundo-luz.';
    return 'O destino cobra seu preço em cada etapa.';
  }
  if (s.startsWith('Sanções')) return 'Crise com o operador do lançador atrasou peças e suporte.';
  if (s.startsWith('Tensão política')) return 'Crise internacional: mais pressão e escrutínio sobre a sala.';
  return 'Pressão de fora da agência.';
}

function headlineFor(state, al, level, extra) {
  const H = HEADLINES[level] || HEADLINES.total;
  let pool;
  const landing = /surface|pole|polo/.test(String(al.destination)) || al.milestones.some((m) => groupOf(m.id) === 'landing');
  if (level === 'total') {
    if (al.phase === 'arrival') pool = landing ? H.landing : H.arrival;
    else if (al.crewed) pool = H.crewed;
    else pool = al.milestones.some((m) => m.id === 'tli') ? H.ascentFar : H.ascent;
  } else if (level === 'catastrophic') {
    if (al.crewed && extra.crewLost?.length) pool = H.crewed;
    else if (al.crewed) pool = H.crewedSafe;
    else pool = al.phase === 'arrival' ? H.arrival : H.ascent;
  } else if (level === 'recoverable') {
    pool = al.phase === 'arrival' ? H.arrival : al.crewed ? H.crewed : H.ascent;
  } else pool = al.phase === 'arrival' ? H.arrival : H.ascent;
  return fill(state, al, pick(al.seed, pool, 'headline', level));
}

function setOutcome(state, al, level, ft, extra) {
  if (level === 'catastrophic' && extra.escaped) level = 'recoverable'; // escape system saved the crew
  const causes = buildCauses(state, al, level, ft, extra);
  al.outcome = {
    level,
    failureType: ft || null,
    causes,
    headline: headlineFor(state, al, level, extra),
    crewLost: extra.crewLost || [],
    label: OUTCOME_LABELS[level],
    endedAt: al.endedAt?.id || null,
    how: extra.how || 'success',
    sudden: extra.how === 'sudden',
    escaped: !!extra.escaped,
  };
  // final: false when a good ascent still has a transit/arrival ahead (UI and listeners should not celebrate yet)
  const success = level === 'total' || level === 'partial';
  al.outcome.final = !(success && al.arrivalAhead);
  al.act = 'climax';
}

// ---------- actions ----------

function needScene(state) {
  return state.activeLaunch ? null : { ok: false, error: 'Nenhum lançamento em andamento.' };
}

export const actions = {
  'launch/configure': (state, data, action) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    if (al.act !== 'prelaunch') return { ok: false, error: 'A escalação fecha na contagem.' };
    const L = al.lineup;
    if ('flightDirector' in action) {
      const p = action.flightDirector ? state.crew?.[action.flightDirector] : null;
      if (action.flightDirector && (!p || (p.status && p.status !== 'active'))) return { ok: false, error: 'Diretor de voo indisponível.' };
      L.flightDirector = action.flightDirector || null;
    }
    if ('commander' in action) {
      const p = action.commander ? state.crew?.[action.commander] : null;
      if (action.commander && (!p || (p.status && p.status !== 'active'))) return { ok: false, error: 'Comandante indisponível.' };
      L.commander = action.commander || null;
      if (L.commander && !al.crewIds.includes(L.commander)) al.crewIds = [L.commander, ...al.crewIds];
    }
    if (action.strategy != null) {
      if (!STRATEGY_IDS.includes(action.strategy)) return { ok: false, error: 'Estratégia inválida.' };
      L.strategy = action.strategy;
    }
    if (action.fuelMargin != null) {
      const fm = Number(action.fuelMargin);
      if (!Number.isFinite(fm)) return { ok: false, error: 'Margem inválida.' };
      L.fuelMargin = r3(clamp(fm, 0, 0.3));
    }
    rebuild(state, data, al);
    initialMood(al);
    phaseOdds(state, data, al);
    return { ok: true, estimate: al.estimate };
  },

  'launch/countdown': (state, data) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    if (al.act !== 'prelaunch') return { ok: false, error: 'A contagem já começou.' };
    rebuild(state, data, al); // final numbers with today's weather
    initialMood(al);
    phaseOdds(state, data, al);
    // milestone rolls are locked per attempt (scrubbing does not re-roll the flight: "Justiça da sorte");
    // the countdown itself (holds, sensor glitches) is a new day after each scrub
    al.seed = hash32(state.seed, 'launch', al.missionId, al.phase, al.attempt);
    al.countSeed = hash32(state.seed, 'countdown', al.missionId, al.phase, al.attempt, findMission(state, al.missionId)?.scrubs || 0);
    al.act = 'countdown';
    const n = al.milestones.length;
    al.forcedIndex = n > 1 ? rngFor(al.seed, 'forced').int(1, n - 1) : 0;
    const lines = al.phase === 'arrival' ? RADIO.countdownArrival : RADIO.countdown;
    pushLog(state, al, -30, 'radio', pick(al.seed, lines, 'cd', 0));
    pushLog(state, al, -10, 'radio', pick(al.seed, lines, 'cd', 1));
    // hold triggers: bad weather or a sensor glitch (new vehicles glitch more)
    const sensorChance = 0.1 + (al.vehicleFlights < 10 ? 0.08 : 0);
    if ((al.weather?.risk ?? 0) >= 0.25) {
      al.pendingHold = {
        reason: 'weather',
        text: `${al.weather.label}. Meteorologia pede atenção.`,
        options: [
          { id: 'hold', label: 'Segurar', preview: '−nervosismo; o clima pode melhorar, mas a janela pode fechar' },
          { id: 'scrub', label: 'Adiar', preview: 'Encerra hoje; volta em 1-2 semanas, custa apoio' },
          { id: 'go', label: 'Lançar assim mesmo', preview: 'Mantém o risco do clima; +nervosismo' },
        ],
      };
    } else if (roll(al.countSeed ?? al.seed, 'sensor') < sensorChance) {
      al.pendingHold = {
        reason: 'sensor',
        text: 'Sensor com leitura duvidosa. Pode ser falso alarme.',
        options: [
          { id: 'hold', label: 'Segurar', preview: 'Equipe verifica o sensor; −nervosismo' },
          { id: 'scrub', label: 'Adiar', preview: 'Encerra hoje; volta em 1-2 semanas, custa apoio' },
          { id: 'go', label: 'Lançar assim mesmo', preview: 'Se o alarme for real, um marco fica mais arriscado' },
        ],
      };
    }
    if (al.pendingHold) {
      pushLog(state, al, -5, 'event', al.pendingHold.text);
      bump(al, 8, -4);
      phaseOdds(state, data, al);
    }
    return { ok: true, hold: al.pendingHold, seedLocked: true };
  },

  'launch/hold': (state, data, action) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    const h = al.pendingHold;
    if (!h) return { ok: false, error: 'Nada para decidir na contagem.' };
    const choice = action.choice;
    if (!['hold', 'scrub', 'go'].includes(choice)) return { ok: false, error: 'Escolha inválida.' };
    al.hold = { reason: h.reason, choice };
    al.pendingHold = null;
    if (choice === 'scrub') {
      const weeks = postpone(state, al.missionId, al.phase, h.reason === 'weather' ? `Clima: ${al.weather.label}.` : 'Sensor em verificação.', 1);
      closeScene(state, al);
      return { ok: true, scrubbed: true, weeks };
    }
    if (choice === 'hold') {
      pushLog(state, al, -4, 'radio', pick(al.seed, RADIO.hold, 'hold'));
      bump(al, -10, 3);
      phaseOdds(state, data, al);
      if (h.reason === 'weather') {
        if (roll(al.countSeed ?? al.seed, 'holdclear') < 0.72) {
          al.weather = { ...al.weather, risk: r3(al.weather.risk * 0.35), label: `${al.weather.label} (melhorando)` };
          rebuildRisks(state, data, al);
          pushLog(state, al, -3, 'radio', pick(al.seed, RADIO.holdOk, 'holdok'));
        } else {
          // the window closed while waiting
          const weeks = postpone(state, al.missionId, al.phase, 'A janela do dia fechou durante a espera.', 0);
          closeScene(state, al);
          return { ok: true, scrubbed: true, weeks, windowClosed: true };
        }
      } else {
        pushLog(state, al, -3, 'radio', 'Sensor verificado: falso alarme. Retomando.');
      }
    } else {
      pushLog(state, al, -4, 'radio', pick(al.seed, RADIO.goAnyway, 'go'));
      bump(al, 12, -6);
      phaseOdds(state, data, al);
      if (h.reason === 'sensor' && roll(al.countSeed ?? al.seed, 'sensorReal') < 0.5) {
        const n = al.milestones.length;
        al.sensorIssue = { index: Math.min(n - 1, Math.max(1, Math.floor(n / 2))) };
      }
    }
    return { ok: true };
  },

  'launch/step': (state, data) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    if (al.act === 'prelaunch') return { ok: false, error: 'Inicie a contagem primeiro.' };
    if (al.pendingHold) return { ok: false, error: 'Decida a contagem primeiro.' };
    if (al.pendingIntervention) return { ok: false, error: 'Há uma intervenção pendente.' };
    if (al.act === 'climax') {
      al.act = 'result';
      return { ok: true, act: 'result', outcome: al.outcome };
    }
    if (al.act === 'result') return { ok: true, act: 'result', outcome: al.outcome, done: true };
    if (al.act === 'countdown') {
      al.act = 'ascent';
      pushLog(state, al, -1, 'radio', al.phase === 'arrival' ? 'Sequência iniciada.' : '3... 2... 1...');
    }
    if (al.current >= al.milestones.length) {
      if (!al.outcome) concludeSuccess(state, al);
      return { ok: true, act: al.act, outcome: al.outcome };
    }
    const res = resolveNext(state, data, al);
    state.commandPoints = al.commandPoints;
    return { ok: true, act: al.act, ...res };
  },

  'launch/choose': (state, data, action) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    const pi = al.pendingIntervention;
    if (!pi) return { ok: false, error: 'Nenhuma intervenção pendente.' };
    const optionId = action.optionId === 'timeout' || !action.optionId ? pi.defaultOption : action.optionId;
    const opt = pi.options.find((o) => o.id === optionId);
    if (!opt) return { ok: false, error: 'Opção inválida.' };
    if (opt.disabled) return { ok: false, error: opt.reason || 'Opção indisponível.' };
    al.commandPoints -= opt.cost || 0;
    state.commandPoints = al.commandPoints;
    al.pendingIntervention = null;
    const res = applyOption(state, al, pi.index, optionId, false);
    if (action.optionId === 'timeout') al.interventions[al.interventions.length - 1].timeout = true;
    return { ok: true, act: al.act, ...res };
  },

  'launch/finish': (state, data) => {
    const err = needScene(state);
    if (err) return err;
    const al = state.activeLaunch;
    if (!al.outcome) return { ok: false, error: 'A cena ainda não terminou.' };
    al.act = 'result';
    const outcome = {
      ...al.outcome,
      phase: al.phase,
      interventions: al.interventions.map((x) => ({ ...x })),
      lineup: { ...al.lineup },
      weather: { ...al.weather },
      estimate: { p: al.estimate?.p, low: al.estimate?.low, high: al.estimate?.high, pPhase: al.estimate?.pPhase },
      prestigeMult: al.prestigeMult ?? 1,
      scienceMult: al.scienceMult ?? 1,
      commandPointsUsed: (al.commandPointsStart || 0) - (al.commandPoints || 0),
      launchedTurn: al.startTurn,
    };
    // the arrival scene inherits what the director chose at launch (strategy, fuel margin)
    const flownMission = findMission(state, al.missionId);
    if (flownMission && al.phase === 'ascent') {
      flownMission.config = { ...(flownMission.config || {}), strategy: al.lineup.strategy, fuelMargin: al.lineup.fuelMargin };
    }
    const key = `launch.flown.${al.missionId}.${al.phase}`;
    state.stats[key] = (state.stats[key] || 0) + 1;
    state.stats['launch.scenes'] = (state.stats['launch.scenes'] || 0) + 1;
    state.stats[`launch.${outcome.level}`] = (state.stats[`launch.${outcome.level}`] || 0) + 1;
    state.stats['launch.interventions'] = (state.stats['launch.interventions'] || 0) + al.interventions.length;
    closeScene(state, al);
    if (typeof missions.onLaunchResolved === 'function') {
      missions.onLaunchResolved(state, data, al.missionId, al.phase, outcome);
    } else {
      log(state, 'launch: missions.onLaunchResolved ausente; resultado não aplicado');
    }
    return { ok: true, outcome };
  },
};

/** Recompute milestone pFail after a weather change (keeps statuses; only before the first step). */
function rebuildRisks(state, data, al) {
  const keep = { cp: al.commandPoints, start: al.commandPointsStart, nerves: al.nerves, conf: al.confidence };
  rebuild(state, data, al);
  al.commandPoints = keep.cp;
  al.commandPointsStart = keep.start;
  al.nerves = keep.nerves;
  al.confidence = keep.conf;
  state.commandPoints = al.commandPoints;
  phaseOdds(state, data, al);
}

// ---------- decisions ----------

export const decisionHandlers = {
  'launch/ready': (state, data, decision, choiceId) => {
    const { missionId, phase = 'ascent' } = decision.payload || {};
    if (!findMission(state, missionId)) return { ok: false, error: 'missão não encontrada' };
    if (choiceId === 'scrub') {
      const weeks = postpone(state, missionId, phase, 'A direção decidiu adiar.', 1);
      return { scrubbed: true, weeks };
    }
    if (state.activeLaunch) {
      const weeks = postpone(state, missionId, phase, 'Sala de controle ocupada com outra missão.', 0);
      return { scrubbed: true, weeks, busy: true };
    }
    const al = openScene(state, data, missionId, phase);
    return { opened: !!al };
  },
};

// ---------- weekly housekeeping ----------

/** End the scene: what was not spent goes back to the agency's pool. */
function closeScene(state, al) {
  const used = Math.max(0, (al.commandPointsStart || 0) - (al.commandPoints || 0));
  const pool = Number.isFinite(al.pool) ? al.pool : al.commandPointsStart || 0;
  state.commandPoints = Math.max(0, pool - used);
  state.activeLaunch = null;
}

function previewPoints(state, data) {
  const fds = Object.values(state.crew || {}).filter((p) => p && p.actorId === state.playerId && p.role === 'flight_director' && (!p.status || p.status === 'active'));
  fds.sort((a, b) => (b.skill || 0) - (a.skill || 0) || String(a.id).localeCompare(String(b.id)));
  return commandPointsFor(state, data, { flightDirector: fds[0]?.id || null });
}

export function init(state, data, ctx) {
  state.activeLaunch = null;
  state.commandPoints = previewPoints(state, data);
  state.commandPointsWeeks = 0;
}

/** Weekly refill of the Command pool: +1 every CP_REGEN_WEEKS weeks, never above the current cap. */
function regenPool(state, data) {
  const cap = previewPoints(state, data);
  let pool = Number.isFinite(state.commandPoints) ? state.commandPoints : cap;
  if (pool >= cap) {
    state.commandPoints = cap;
    state.commandPointsWeeks = 0;
    return;
  }
  state.commandPointsWeeks = (state.commandPointsWeeks || 0) + 1;
  if (state.commandPointsWeeks >= CP_REGEN_WEEKS) {
    pool += 1;
    state.commandPointsWeeks = 0;
  }
  state.commandPoints = Math.min(cap, pool);
}

export function tick(state, data, ctx) {
  // a stale scene (mission vanished) must not block the game
  if (state.activeLaunch && !findMission(state, state.activeLaunch.missionId)) closeScene(state, state.activeLaunch);
  if (!state.activeLaunch) regenPool(state, data);
}

// ---------- queries ----------

export const queries = {
  'launch/active': (state) => state.activeLaunch,
  'launch/strategies': () => STRATEGY_IDS.map((id) => ({ id, label: STRATEGY_LABELS[id], preview: id === 'conservative' ? 'Menos risco, menos prestígio' : id === 'aggressive' ? 'Mais risco, mais prestígio' : 'Meio-termo' })),
  /** Estimate for a mission with an optional lineup patch (pré-lançamento sem mutar). */
  'launch/preview': (state, data, missionId, patch = {}) => {
    const mission = findMission(state, missionId);
    if (!mission) return null;
    const al = { lineup: { flightDirector: mission.crew?.flightDirector ?? null, commander: mission.crew?.commander ?? null, strategy: mission.config?.strategy || 'balanced', fuelMargin: mission.config?.fuelMargin ?? 0.1, ...patch }, weather: null };
    return risk.missionRisk(state, data, planFor(state, mission, al));
  },
  'launch/commandPoints': (state) => state.activeLaunch?.commandPoints ?? state.commandPoints ?? 0,
};

// ---------- autoplay (tools/tests) ----------

/**
 * Drive the active scene to the end with a policy. policy(intervention, al) -> optionId; hold(pendingHold, al) -> choice.
 * Returns the outcome (or {scrubbed:true}). Does not call finish unless opts.finish.
 */
export function autoplay(state, data, { choose = () => 'maintain', hold = () => 'go', finish = false } = {}) {
  let guard = 0;
  while (state.activeLaunch && guard++ < 100) {
    const al = state.activeLaunch;
    let r;
    if (al.act === 'prelaunch') r = actions['launch/countdown'](state, data, {});
    else if (al.pendingHold) r = actions['launch/hold'](state, data, { choice: hold(al.pendingHold, al) });
    else if (al.pendingIntervention) {
      let id = choose(al.pendingIntervention, al);
      const o = al.pendingIntervention.options.find((x) => x.id === id);
      if (!o || o.disabled) id = 'maintain';
      r = actions['launch/choose'](state, data, { optionId: id });
    } else if (al.act === 'result') {
      if (finish) return actions['launch/finish'](state, data, {}).outcome;
      return al.outcome;
    } else r = actions['launch/step'](state, data, {});
    if (r && r.scrubbed) return { scrubbed: true };
    if (r && r.ok === false) throw new Error(r.error);
  }
  return state.activeLaunch?.outcome || null;
}

/** Command points regenerate week by week: the engine substeps this module (EXPANSION.md §1.5). */
export const meta = { maxDt: 1 };
