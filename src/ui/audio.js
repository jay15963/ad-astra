// Adaptive synthesized sound for the Launch Day scene (WebAudio, no audio files).
// Everything is optional: no AudioContext (Node, old browsers) or sound off => every call is a silent no-op.
// The context is created only after the first user gesture (autoplay policies).
// Nothing important is conveyed only by sound: the scene always shows captions too.

let storeRef = null;
let ctx = null;          // AudioContext
let master = null;       // master gain (settings.sound / silence)
let bus = null;          // compressor -> master
let noiseBuf = null;     // 2 s white noise, shared
let rumble = null;       // {src, filter, gain}
let drone = null;        // {oscs, filter, gain}
let silenced = false;
let listening = false;
let api = null;

const hasWindow = () => typeof window !== 'undefined' && typeof document !== 'undefined';
const AC = () => (hasWindow() ? (window.AudioContext || window.webkitAudioContext || null) : null);

/** True when the player wants sound. */
function enabled() {
  return storeRef?.settings?.sound !== false;
}

/** Create the context lazily (only after a gesture). Returns null when unavailable. */
function ac(create = false) {
  if (ctx) return ctx;
  if (!create) return null;
  const Ctor = AC();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = enabled() ? 0.8 : 0;
    bus = ctx.createDynamicsCompressor();
    bus.threshold.value = -18;
    bus.ratio.value = 4;
    bus.connect(master);
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Unlock on the first user gesture (pointer/touch/key). Safe to call many times. */
function listenForUnlock() {
  if (listening || !hasWindow()) return;
  listening = true;
  const unlock = () => {
    const c = ac(true);
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  };
  for (const ev of ['pointerdown', 'touchend', 'keydown']) window.addEventListener(ev, unlock, { passive: true });
}

/** Ready context or null (respects sound setting). */
function live() {
  const c = ac(false);
  if (!c || !enabled()) return null;
  if (c.state === 'suspended') c.resume().catch(() => {});
  return c;
}

/** Keep master gain in sync with settings and silence. */
function syncMaster() {
  if (!ctx || !master) return;
  const target = !enabled() || silenced ? 0 : 0.8;
  master.gain.setTargetAtTime(target, ctx.currentTime, silenced ? 0.04 : 0.15);
}

/** One enveloped oscillator note. */
function tone(freq, dur, { type = 'sine', gain = 0.2, attack = 0.005, at = 0, slideTo = null, detune = 0 } = {}) {
  const c = live();
  if (!c) return;
  const t0 = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
  o.detune.value = detune;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(bus);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

/** Filtered noise burst (booms, thumps, radio static). */
function noise(dur, { freq = 800, q = 0.7, type = 'lowpass', gain = 0.3, at = 0, sweepTo = null } = {}) {
  const c = live();
  if (!c || !noiseBuf) return;
  const t0 = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t0);
  if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  f.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(bus);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// ---------------- continuous layers ----------------

/** Engine rumble, intensity 0..1 (0 stops it smoothly). */
function setRumble(intensity) {
  const c = live();
  const v = Math.max(0, Math.min(1, intensity || 0));
  if (!c) return;
  if (!rumble && v > 0) {
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 90;
    filter.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(bus);
    src.start();
    rumble = { src, filter, gain };
  }
  if (!rumble) return;
  const t = c.currentTime;
  rumble.gain.gain.setTargetAtTime(v * 0.55, t, 0.25);
  rumble.filter.frequency.setTargetAtTime(70 + v * 380, t, 0.3);
}

/** Tension drone, level 0..1: rises in pitch, brightness and volume. */
function setTension(level) {
  const c = live();
  const v = Math.max(0, Math.min(1, level || 0));
  if (!c) return;
  if (!drone && v > 0) {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 280;
    filter.Q.value = 3;
    const gain = c.createGain();
    gain.gain.value = 0;
    filter.connect(gain).connect(bus);
    const oscs = [55, 55.35, 82.4].map((f, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = f;
      o.connect(filter);
      o.start();
      return { o, base: f };
    });
    // slow wobble (LFO) on the filter makes it breathe
    const lfo = c.createOscillator();
    const lfoGain = c.createGain();
    lfo.frequency.value = 0.25;
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    drone = { oscs, filter, gain, lfo };
  }
  if (!drone) return;
  const t = c.currentTime;
  drone.gain.gain.setTargetAtTime(0.02 + v * 0.11, t, 0.4);
  drone.filter.frequency.setTargetAtTime(240 + v * 1400, t, 0.5);
  for (const { o, base } of drone.oscs) o.frequency.setTargetAtTime(base * (1 + v * 0.5), t, 0.8);
  drone.lfo.frequency.setTargetAtTime(0.25 + v * 3, t, 0.5);
}

/** Hard cut of the drone (the "silence at the peak"). */
function cutTension() {
  if (!drone || !ctx) return;
  const d = drone;
  drone = null;
  const t = ctx.currentTime;
  d.gain.gain.cancelScheduledValues(t);
  d.gain.gain.setValueAtTime(d.gain.gain.value, t);
  d.gain.gain.linearRampToValueAtTime(0, t + 0.03);
  setTimeout(() => {
    try { d.oscs.forEach(({ o }) => o.stop()); d.lfo.stop(); } catch { /* already stopped */ }
  }, 120);
}

function stopRumble() {
  if (!rumble || !ctx) return;
  const r = rumble;
  rumble = null;
  r.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
  setTimeout(() => { try { r.src.stop(); } catch { /* ok */ } }, 1500);
}

// ---------------- public API ----------------

function build() {
  return {
    /** Countdown beep. kind: 'tick' (T-10..4), 'final' (T-3..1), 'go' (T-0). */
    beep(kind = 'tick') {
      if (kind === 'go') { tone(880, 0.5, { type: 'square', gain: 0.12 }); tone(1320, 0.5, { type: 'sine', gain: 0.1 }); return; }
      tone(kind === 'final' ? 1000 : 760, 0.12, { type: 'square', gain: kind === 'final' ? 0.12 : 0.08 });
    },
    /** Short radio squelch before a radio line. */
    radio() { noise(0.08, { type: 'bandpass', freq: 2200, q: 2, gain: 0.08 }); },
    /** Milestone OK: the "goal" chime. */
    chime() {
      tone(660, 0.25, { type: 'triangle', gain: 0.14 });
      tone(990, 0.4, { type: 'triangle', gain: 0.12, at: 0.09 });
    },
    /** Anomaly: two-tone alarm. */
    alarm() {
      for (let i = 0; i < 3; i++) {
        tone(520, 0.14, { type: 'square', gain: 0.09, at: i * 0.3 });
        tone(390, 0.14, { type: 'square', gain: 0.09, at: i * 0.3 + 0.15 });
      }
    },
    /** Stage separation / pyro thump. */
    thump() { noise(0.35, { freq: 400, sweepTo: 60, gain: 0.45 }); tone(70, 0.3, { gain: 0.3, slideTo: 40 }); },
    /** Explosion. */
    boom() {
      noise(2.4, { freq: 1800, sweepTo: 50, gain: 0.8 });
      tone(55, 1.8, { type: 'sine', gain: 0.5, slideTo: 25 });
    },
    /** Touchdown: soft crunch. */
    touchdown() { noise(0.6, { freq: 900, sweepTo: 120, gain: 0.35 }); },
    rumble: setRumble,
    stopRumble,
    tension: setTension,
    cutTension,
    /** Silence everything (climax). Continuous layers keep state and come back on unsilence. */
    silence(on = true) { silenced = !!on; syncMaster(); },
    /** Success: bright major chord fanfare. */
    fanfare(big = true) {
      const root = 523.25;
      const notes = big ? [1, 1.25, 1.5, 2] : [1, 1.25, 1.5];
      notes.forEach((m, i) => {
        tone(root * m, 1.8, { type: 'triangle', gain: 0.12, at: i * 0.12, attack: 0.02 });
        tone(root * m / 2, 1.8, { type: 'sawtooth', gain: 0.03, at: i * 0.12, attack: 0.05, detune: 6 });
      });
      if (big) notes.forEach((m) => tone(root * m, 2.6, { type: 'sine', gain: 0.08, at: 0.7, attack: 0.1 }));
    },
    /** Failure: low falling tone. */
    failure(grave = true) {
      tone(grave ? 110 : 165, 2.8, { type: 'sawtooth', gain: 0.1, slideTo: grave ? 46 : 98, attack: 0.08 });
      tone(grave ? 116 : 174, 2.8, { type: 'sine', gain: 0.12, slideTo: grave ? 49 : 104, attack: 0.08 });
    },
    /** Call when settings change (sound toggle). */
    sync() { syncMaster(); if (!enabled()) { cutTension(); stopRumble(); } },
    /** Stop every continuous layer (scene closed). */
    stopAll() { cutTension(); stopRumble(); silenced = false; syncMaster(); },
    get available() { return !!AC(); },
    get unlocked() { return !!ctx && ctx.state === 'running'; },
  };
}

/** Shared audio controller bound to the store (settings.sound). */
export function getAudio(store) {
  if (store) storeRef = store;
  listenForUnlock();
  if (!api) api = build();
  return api;
}

/** Try to unlock right now (call inside a user-gesture handler). */
export function unlockAudio() {
  const c = ac(true);
  if (c && c.state === 'suspended') c.resume().catch(() => {});
  syncMaster();
}
