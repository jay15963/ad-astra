// Composed SVG portraits (flat retro-futurist poster style) built from parts.
// Pure string output, no DOM: usable in Node tests.
// portrait = { skin 0..5, hair 0..9, hairColor 0..5, eyes 0..4, brows 0..3, mouth 0..4, accessory 0..5, suit 0..3, bg 0..5 }

import { hash32 } from '../core/rng.js';

const SKIN = ['#f6d7b8', '#ebbd96', '#cf9469', '#a9703f', '#7d4c2a', '#56321d'];
const HAIR = ['#1f1b22', '#4b2d1b', '#8a5a2b', '#d6aa5c', '#b2462a', '#a9adb3'];
// poster backgrounds: [base, accent]
const BG = [
  ['#e2553a', '#f08a4b'], ['#28628f', '#3f86b8'], ['#e2ad35', '#f2cc6a'],
  ['#2f7f6c', '#4aa58c'], ['#5e4589', '#7d63ab'], ['#cdbf9f', '#e6dcc2'],
];
const SUITS = [
  { base: '#e8692f', trim: '#f7f1e3', patch: '#1d3b5c' }, // laranja de voo
  { base: '#1f3a5f', trim: '#d9cfb8', patch: '#e2553a' }, // azul de voo
  { base: '#ecebe4', trim: '#9aa3ad', patch: '#2f6f9f' }, // EVA branco
  { base: '#d8d2c2', trim: '#2b2f3a', patch: '#c23b2a' }, // camisa de engenharia + gravata
];

const clampIdx = (v, n) => {
  const i = Math.floor(Number(v));
  return Number.isFinite(i) ? ((i % n) + n) % n : 0;
};

/** Deterministic portrait parts from any seed string (fallback when a person has no portrait). */
export function portraitFromSeed(seed) {
  const s = String(seed ?? 'x');
  const pick = (label, n) => hash32(s, label) % n;
  return {
    skin: pick('skin', 6), hair: pick('hair', 10), hairColor: pick('hc', 6), eyes: pick('eyes', 5), brows: pick('brows', 4),
    mouth: pick('mouth', 5), accessory: pick('acc', 6), suit: pick('suit', 4), bg: pick('bg', 6),
  };
}

function bgLayer(i, uid) {
  const [b, a] = BG[i];
  switch (i) {
    case 0: { // sunburst rays
      let rays = '';
      for (let k = 0; k < 12; k++) {
        const a0 = (k / 12) * Math.PI * 2, a1 = a0 + Math.PI / 12;
        rays += `M50 54L${(50 + 90 * Math.cos(a0)).toFixed(1)} ${(54 + 90 * Math.sin(a0)).toFixed(1)}L${(50 + 90 * Math.cos(a1)).toFixed(1)} ${(54 + 90 * Math.sin(a1)).toFixed(1)}Z`;
      }
      return `<rect width="100" height="100" fill="${b}"/><path d="${rays}" fill="${a}" opacity=".55"/>`;
    }
    case 1: // concentric orbits
      return `<rect width="100" height="100" fill="${b}"/><g fill="none" stroke="${a}" stroke-width="3"><circle cx="50" cy="54" r="30"/><circle cx="50" cy="54" r="42"/><circle cx="50" cy="54" r="54"/></g><circle cx="86" cy="18" r="4" fill="#f7f1e3"/>`;
    case 2: // diagonal poster stripes
      return `<rect width="100" height="100" fill="${b}"/><g fill="${a}"><path d="M-10 30L30-10H44L-10 44Z"/><path d="M-10 62L62-10H76L-10 76Z"/><path d="M10 110L110 10V24L24 110Z"/></g>`;
    case 3: // stars field
      return `<rect width="100" height="100" fill="${b}"/><g fill="#f7f1e3" opacity=".85"><circle cx="12" cy="14" r="1.6"/><circle cx="84" cy="10" r="1.2"/><circle cx="90" cy="38" r="1.8"/><circle cx="8" cy="46" r="1.1"/><circle cx="22" cy="28" r=".9"/><circle cx="76" cy="26" r=".9"/><path d="M80 60l1.6 3.6 3.6 1.6-3.6 1.6-1.6 3.6-1.6-3.6-3.6-1.6 3.6-1.6z"/></g>`;
    case 4: // crescent moon
      return `<rect width="100" height="100" fill="${b}"/><circle cx="78" cy="22" r="14" fill="${a}"/><circle cx="84" cy="17" r="12" fill="${b}"/><path d="M0 84Q50 70 100 84V100H0Z" fill="${a}" opacity=".5"/>`;
    default: // blueprint grid
      return `<rect width="100" height="100" fill="${b}"/><pattern id="g${uid}" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="${a}" stroke-width="1"/></pattern><rect width="100" height="100" fill="url(#g${uid})"/>`;
  }
}

function suitLayer(i, skin) {
  const s = SUITS[i];
  const body = `<path d="M10 104Q12 76 38 71H62Q88 76 90 104Z" fill="${s.base}"/>`;
  const neck = `<path d="M43 58H57V73Q50 78 43 73Z" fill="${skin}"/><path d="M43 66Q50 70 57 66V73Q50 78 43 73Z" fill="#000" opacity=".12"/>`;
  switch (i) {
    case 0: return neck + body + `<path d="M40 71L50 84L60 71" fill="none" stroke="${s.trim}" stroke-width="3"/><rect x="66" y="82" width="11" height="7" rx="1.5" fill="${s.patch}"/><circle cx="27" cy="86" r="4.5" fill="${s.patch}"/><circle cx="27" cy="86" r="2" fill="${s.trim}"/>`;
    case 1: return neck + body + `<path d="M38 71Q50 80 62 71" fill="none" stroke="${s.trim}" stroke-width="3"/><path d="M26 82h12v9H26z" fill="${s.patch}"/><path d="M28 86.5h8" stroke="${s.trim}" stroke-width="1.6"/><path d="M50 79V104" stroke="#000" stroke-opacity=".18" stroke-width="1.5"/>`;
    case 2: return neck + body + `<ellipse cx="50" cy="73" rx="19" ry="6" fill="${s.trim}"/><ellipse cx="50" cy="72" rx="14" ry="3.6" fill="#5b6470"/><rect x="62" y="84" width="10" height="10" rx="2" fill="${s.patch}"/><circle cx="31" cy="88" r="3" fill="#e2553a"/>`;
    default: return neck + body + `<path d="M41 71L50 79L59 71L57 104H43Z" fill="#f7f1e3"/><path d="M48 77H52L53 96L50 100L47 96Z" fill="${s.patch}"/><path d="M33 74L36 104" stroke="${s.trim}" stroke-width="1.6"/><rect x="31" y="92" width="7" height="9" rx="1" fill="${s.trim}"/>`;
  }
}

// hair: [back layer, front layer]
function hairLayers(i, c) {
  switch (i) {
    case 0: return ['', `<path d="M29 46Q27 21 50 20Q73 21 71 46Q68 32 56 30Q44 34 32 33Q30 38 29 46Z" fill="${c}"/>`];
    case 1: return ['', `<path d="M30 42Q30 22 50 22Q70 22 70 42Q66 30 50 29Q34 30 30 42Z" fill="${c}" opacity=".9"/>`];
    case 2: return [`<path d="M26 46Q24 18 50 18Q76 18 74 46V66Q70 68 66 64V48H34V64Q30 68 26 66Z" fill="${c}"/>`,
      `<path d="M28 44Q28 20 50 20Q72 20 72 44Q60 40 54 30Q46 40 28 44Z" fill="${c}"/>`];
    case 3: return [`<path d="M25 48Q22 17 50 17Q78 17 75 48L80 88Q70 92 66 80V50H34V80Q30 92 20 88Z" fill="${c}"/>`,
      `<path d="M28 46Q27 19 50 19Q73 19 72 46Q64 28 44 28Q34 34 28 46Z" fill="${c}"/>`];
    case 4: return [`<circle cx="50" cy="16" r="9" fill="${c}"/>`,
      `<path d="M29 44Q28 21 50 21Q72 21 71 44Q66 30 50 29Q34 30 29 44Z" fill="${c}"/><path d="M44 21Q50 17 56 21" stroke="#000" stroke-opacity=".2" fill="none" stroke-width="1.5"/>`];
    case 5: { // curly / afro cloud
      const pts = [[30, 30], [38, 21], [50, 18], [62, 21], [70, 30], [74, 41], [26, 41]];
      return [pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="11" fill="${c}"/>`).join(''),
        `<path d="M31 40Q34 28 50 28Q66 28 69 40Q60 34 50 35Q40 34 31 40Z" fill="${c}"/>`];
    }
    case 6: return ['', `<path d="M29 46Q26 20 52 19Q74 21 71 44Q70 34 62 30Q48 30 38 36Q31 38 29 46Z" fill="${c}"/><path d="M38 36Q48 26 66 28" stroke="#fff" stroke-opacity=".18" fill="none" stroke-width="2"/>`];
    case 7: return ['', `<path d="M38 27Q44 24 49 25" stroke="#fff" stroke-opacity=".35" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M29 50Q28 40 31 36V50Z M71 50Q72 40 69 36V50Z" fill="${c}"/>`];
    case 8: return [`<path d="M66 32Q86 36 82 66Q80 74 74 72Q78 52 66 42Z" fill="${c}"/>`,
      `<path d="M29 44Q28 21 50 21Q72 21 71 44Q64 30 50 30Q36 30 29 44Z" fill="${c}"/>`];
    default: return ['', `<path d="M30 44Q29 30 34 26Q40 12 58 14Q72 17 70 30Q71 38 70 44Q66 30 60 28Q46 24 36 32Q32 36 30 44Z" fill="${c}"/>`];
  }
}

function eyesLayer(i, mood) {
  if (mood === 'happy' && i !== 3) i = 3;
  const ink = '#1d1a22';
  switch (i) {
    case 0: return `<circle cx="42" cy="47" r="2.3" fill="${ink}"/><circle cx="58" cy="47" r="2.3" fill="${ink}"/>`;
    case 1: return `<circle cx="42" cy="47" r="3.6" fill="#fff"/><circle cx="58" cy="47" r="3.6" fill="#fff"/><circle cx="42.6" cy="47.4" r="2" fill="${ink}"/><circle cx="58.6" cy="47.4" r="2" fill="${ink}"/>`;
    case 2: return `<path d="M38.5 47.5H45.5M54.5 47.5H61.5" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
    case 3: return `<path d="M38.5 48Q42 44 45.5 48M54.5 48Q58 44 61.5 48" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    default: return `<path d="M38 47Q42 43.5 46 47Q42 50 38 47Z M54 47Q58 43.5 62 47Q58 50 54 47Z" fill="${ink}"/><path d="M37 45.5l-1.5-1.2M63 45.5l1.5-1.2" stroke="${ink}" stroke-width="1.2"/>`;
  }
}

function browsLayer(i, mood, c) {
  if (mood === 'tense') return `<path d="M37 40.5L46 42.5M63 40.5L54 42.5" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>`;
  if (mood === 'sad' || mood === 'dead') return `<path d="M37 42L46 40M63 42L54 40" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`;
  switch (i) {
    case 0: return `<path d="M37.5 41H46M54 41H62.5" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`;
    case 1: return `<path d="M37 42Q41.5 38 46 41M54 41Q58.5 38 63 42" stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
    case 2: return `<path d="M36.5 41.5Q41 38.5 46.5 40.5V42.5Q41 41 36.5 43.5Z M63.5 41.5Q59 38.5 53.5 40.5V42.5Q59 41 63.5 43.5Z" fill="${c}"/>`;
    default: return `<path d="M37 40L46 41.5M63 40L54 41.5" stroke="${c}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
}

function mouthLayer(i, mood) {
  const ink = '#4a1f1f';
  if (mood === 'happy') i = 2;
  if (mood === 'sad') return `<path d="M44 60Q50 56 56 60" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  if (mood === 'tense') return `<path d="M44.5 58.5H55.5" stroke="${ink}" stroke-width="2.4" stroke-linecap="round"/>`;
  if (mood === 'dead') i = 1;
  switch (i) {
    case 0: return `<path d="M43.5 57Q50 62 56.5 57" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    case 1: return `<path d="M45 58.5H55" stroke="${ink}" stroke-width="2" stroke-linecap="round"/>`;
    case 2: return `<path d="M42.5 56.5Q50 65 57.5 56.5Z" fill="${ink}"/><path d="M44.5 57.3H55.5L54.5 59H45.5Z" fill="#fff"/>`;
    case 3: return `<ellipse cx="50" cy="58.5" rx="2.6" ry="3" fill="${ink}"/>`;
    default: return `<path d="M44 58.5Q51 60 56.5 56" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
  }
}

function accessoryLayer(i, hairColor) {
  switch (i) {
    case 1: return `<g fill="none" stroke="#1d1a22" stroke-width="1.8"><circle cx="42" cy="47" r="5.6"/><circle cx="58" cy="47" r="5.6"/><path d="M47.6 46.5Q50 45 52.4 46.5M36.4 46L30 44M63.6 46L70 44"/></g><path d="M38 44.5l3 -1.5" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/>`;
    case 2: return `<path d="M28 46Q28 18 50 18Q72 18 72 46" fill="none" stroke="#2b2f3a" stroke-width="3"/><rect x="24" y="42" width="7" height="12" rx="3" fill="#2b2f3a"/><path d="M27 54Q30 64 42 62" fill="none" stroke="#2b2f3a" stroke-width="2"/><circle cx="43" cy="62" r="2.2" fill="#e2553a"/>`;
    case 3: return `<circle cx="70" cy="56" r="2.2" fill="#e6b33a" stroke="#8a6a1c" stroke-width=".8"/>`;
    case 4: return `<path d="M42 55.5Q46 52.5 50 54.5Q54 52.5 58 55.5Q54 57 50 55.6Q46 57 42 55.5Z" fill="${hairColor}"/>`;
    case 5: return `<g fill="#9a5a3a" opacity=".55"><circle cx="38" cy="52" r=".9"/><circle cx="41" cy="54" r=".9"/><circle cx="36" cy="55" r=".8"/><circle cx="62" cy="52" r=".9"/><circle cx="59" cy="54" r=".9"/><circle cx="64" cy="55" r=".8"/></g>`;
    default: return '';
  }
}

/**
 * portraitSVG(portrait, {size, mood}) -> SVG string.
 * mood: 'neutral' | 'happy' | 'sad' | 'tense' | 'dead' (memorial: greyscale)
 */
export function portraitSVG(portrait, { size = 64, mood = 'neutral', title } = {}) {
  const p = portrait && typeof portrait === 'object' ? portrait : portraitFromSeed(portrait);
  const skin = SKIN[clampIdx(p.skin, SKIN.length)];
  const hc = HAIR[clampIdx(p.hairColor, HAIR.length)];
  const bgI = clampIdx(p.bg, BG.length);
  const uid = hash32(JSON.stringify(p), mood).toString(36);
  const [hairBack, hairFront] = hairLayers(clampIdx(p.hair, 10), hc);
  const grey = mood === 'dead';
  const t = title ? `<title>${String(title).replace(/[<&>]/g, '')}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" class="pt${grey ? ' pt-grey' : ''}">${t}`
    + (grey ? `<defs><filter id="f${uid}"><feColorMatrix type="saturate" values="0"/></filter></defs><g filter="url(#f${uid})">` : '<g>')
    + bgLayer(bgI, uid)
    + hairBack
    + suitLayer(clampIdx(p.suit, SUITS.length), skin)
    // ears + head
    + `<circle cx="29.5" cy="49" r="4.5" fill="${skin}"/><circle cx="70.5" cy="49" r="4.5" fill="${skin}"/>`
    + `<ellipse cx="50" cy="45" rx="20.5" ry="23" fill="${skin}"/>`
    // flat poster shading on the right side of the face
    + `<path d="M56 22.6Q70.5 28 70.5 45Q70.5 62 54 67.8Q64 56 64 45Q64 31 56 22.6Z" fill="#000" opacity=".1"/>`
    + `<circle cx="38" cy="54" r="3.4" fill="#e2553a" opacity=".16"/><circle cx="62" cy="54" r="3.4" fill="#e2553a" opacity=".16"/>`
    + `<path d="M50 48.5Q48 53 49.5 54.5H52" stroke="#000" stroke-opacity=".22" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
    + hairFront
    + browsLayer(clampIdx(p.brows, 4), mood, hc)
    + eyesLayer(clampIdx(p.eyes, 5), mood)
    + mouthLayer(clampIdx(p.mouth, 5), mood)
    + accessoryLayer(clampIdx(p.accessory, 6), hc)
    + '</g></svg>';
}

/** Round emblem for an actor (agency/company) used as "portrait" on actor cards. */
export function emblemSVG(actor, { size = 48 } = {}) {
  const color = /^#[0-9a-f]{3,8}$/i.test(actor?.color || '') ? actor.color : '#28628f';
  const label = String(actor?.short || actor?.name || actor?.id || '?').toUpperCase().slice(0, 6).replace(/[<&>]/g, '');
  const fs = label.length <= 3 ? 26 : label.length <= 4 ? 21 : label.length <= 5 ? 17 : 14;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" class="emblem">`
    + `<circle cx="50" cy="50" r="48" fill="${color}"/>`
    + `<circle cx="50" cy="50" r="41" fill="none" stroke="#f7f1e3" stroke-width="2.5" opacity=".85"/>`
    + `<ellipse cx="50" cy="50" rx="46" ry="15" fill="none" stroke="#f7f1e3" stroke-width="2" opacity=".45" transform="rotate(-24 50 50)"/>`
    + `<circle cx="84" cy="34" r="4" fill="#f7f1e3"/>`
    + `<text x="50" y="${50 + fs * 0.36}" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="800" font-size="${fs}" fill="#f7f1e3" letter-spacing="1">${label}</text>`
    + '</svg>';
}

/** Generic icon-portrait for decision cards without a person/actor. kind: decision kind prefix. */
export function iconPortraitSVG(kind = '', { size = 64 } = {}) {
  const k = String(kind).split('/')[0];
  const glyph = {
    launch: '<path d="M50 18Q62 30 62 52V66H38V52Q38 30 50 18Z" fill="#f7f1e3"/><circle cx="50" cy="42" r="5" fill="#28628f"/><path d="M38 56L28 70H38ZM62 56L72 70H62Z" fill="#e2553a"/><path d="M43 68Q50 86 57 68Z" fill="#e2ad35"/>',
    contract: '<rect x="30" y="22" width="40" height="54" rx="3" fill="#f7f1e3"/><path d="M37 34H63M37 42H63M37 50H55" stroke="#28628f" stroke-width="3"/><circle cx="58" cy="64" r="7" fill="#e2553a"/>',
    diplomacy: '<circle cx="50" cy="50" r="26" fill="none" stroke="#f7f1e3" stroke-width="4"/><path d="M24 50H76M50 24Q36 50 50 76M50 24Q64 50 50 76" stroke="#f7f1e3" stroke-width="3" fill="none"/>',
    politics: '<path d="M26 72H74M30 66H70M34 44H66L50 28Z" stroke="#f7f1e3" stroke-width="4" fill="#f7f1e3"/><path d="M38 46V64M50 46V64M62 46V64" stroke="#f7f1e3" stroke-width="5"/>',
    briefing: '<rect x="26" y="28" width="48" height="40" rx="4" fill="#f7f1e3"/><circle cx="50" cy="48" r="10" fill="none" stroke="#28628f" stroke-width="3"/><path d="M50 38V58M40 48H60" stroke="#28628f" stroke-width="2"/>',
  }[k] || '<circle cx="50" cy="50" r="20" fill="#f7f1e3"/><path d="M50 22V30M50 70V78M22 50H30M70 50H78" stroke="#f7f1e3" stroke-width="4"/><circle cx="50" cy="50" r="8" fill="#e2553a"/>';
  const bg = { launch: '#e2553a', contract: '#e2ad35', diplomacy: '#2f7f6c', politics: '#5e4589', briefing: '#28628f' }[k] || '#1f3a5f';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" role="img" class="pt">`
    + `<rect width="100" height="100" fill="${bg}"/><g fill="none" stroke="#000" stroke-opacity=".12" stroke-width="1">`
    + '<path d="M0 25H100M0 50H100M0 75H100M25 0V100M50 0V100M75 0V100"/></g>' + glyph + '</svg>';
}
