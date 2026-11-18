# Ad Astra — design system (derived from CSmanager)

Status: spec for the redesign. Source of truth for the 4 parallel builders. Written from a full read of
CSmanager `src/adapters/ui/estilo.css`, `movel.css`, `responsivo.tsx`, `diretor/diretor.css`,
`diretor/diretor-movel.css`, `animacoes.css`, `radar/radar.css` (title screen), `componentes.tsx`, and from
screenshots taken at 390x844 (DPR 2).

Reference screenshots: `tools/_scratch/ref/`
- CSmanager: `cs-title.png` (title screen), `cs-diretor-menu.png`, `cs-diretor-escolha.png` (team picker),
  `cs-diretor-folha-time.png`, `cs-diretor-convites.png` (full-screen task), `cs-dash-1.png` / `cs-dash-2.png`
  (career dashboard + bottom navbar), `cs-ranking-sub.png` (navbar sub-pills, table), `cs-elenco.png`
  (selected card), `cs-caixa.png` (filter pills + feed list), `cs-folha.png` (bottom sheet), `cs-gaveta.png`
  (drawer), `cs-sim-inicio.png` (simulation: KPI cards + table + navbar with light centre disc),
  `cs-sim-calendario.png`, `cs-sim-relogio-folha.png` (clock sheet: +1d/+7d/+30d + primary).
- Ad Astra before: `aa-before-title.png`, `aa-before-newgame.png`, `aa-before-painel.png`,
  `aa-before-missoes.png`, `aa-before-pesquisa.png`, `aa-before-mapa.png`, `aa-before-mundo.png`,
  `aa-before-decisao.png`, `aa-before-ajustes.png`.

---

## 0. The rules (CSmanager's own words, adopted verbatim)

1. **Cinza é a interface; cor é significado.** No structural element (button, tab, selection, focus,
   card, header) uses hue. Colour is reserved for meaning: green = went up / ok, red = went down / blocking /
   danger, amber = *your agency* + the main action + "needs your answer", blue-grey (`--info`) = neutral
   information / in progress.
2. **Hierarchy by contrast and space, not by strokes.** Five near-black surfaces, almost invisible 1px
   borders, a 4px spacing scale.
3. **No decoration.** Remove: the orange radial glow and blueprint grid on `body`, the diamond before
   section titles, the orange underline under view titles, the corner marks on tiles, poster rays on event
   banners, 3D drop shadows under buttons, uppercase condensed display type, pulsing badges, emoji in
   labels/buttons/eyebrows.
4. **Uppercase only for eyebrows** (tiny labels with letter-spacing). Titles, buttons, tabs and nav labels
   are sentence case ("Próximo evento", not "PRÓXIMO EVENTO").
5. **Numbers in mono, tabular.** Money, dates in lists, counts, percentages, KPI values.
6. **Movement only on `transform`/`opacity`**, with one curve (`--curve`). Everything stops under
   `body.reduce-motion` / `prefers-reduced-motion`.
7. Ad Astra identity survives only as small accents: the agency emblem (its own colours), country flags,
   the poster art on the title screen, and the imagery of the space map, world map and launch scene.
   Their chrome (buttons, chips, cards, sheets over them) follows this system.

The accent of the game is CSmanager's **career ("diretor") mode accent: amber `#e3b341`**. That mode is
the direct analogue of Ad Astra (you run one organisation, the world simulates around you). The old orange
`#ff6a3d` is retired everywhere outside emblems.

---

## 1. Tokens (exact CSS custom properties)

Put these in `styles.css` on the **existing** selector `body, body[data-era="4"] { ... }` (the test
`tests/ui-static.test.mjs` requires the literal `data-era="4"`), and the non-colour ones in `:root`.
Names are Ad Astra style (English, short); values are CSmanager's.

```css
:root {
  --text-scale: 1;                 /* KEEP (A / A+ / A++ setting) */
  --tap: 44px;                     /* KEEP literally "--tap: 44px" (test) */
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);   /* KEEP: test looks for "safe-area-inset-bottom" */
  --safe-l: env(safe-area-inset-left, 0px);
  --safe-r: env(safe-area-inset-right, 0px);

  /* type: CSmanager's MOBILE scale (movel.css @media max-width 1023.98px), times the text-scale setting */
  --font: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --mono: ui-monospace, 'SF Mono', 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace;
  --t9:  calc(10px * var(--text-scale));
  --t10: calc(11px * var(--text-scale));
  --t11: calc(12px * var(--text-scale));
  --t12: calc(13px * var(--text-scale));
  --t13: calc(14px * var(--text-scale));
  --t15: calc(16px * var(--text-scale));
  --t17: calc(17px * var(--text-scale));   /* topbar + sheet title */
  --t18: calc(19px * var(--text-scale));
  --t22: calc(22px * var(--text-scale));   /* page h1, KPI value */
  --t24: calc(24px * var(--text-scale));

  /* radius: CSmanager desktop is 6/4; its MOBILE layer raises cards to 14-16 and sheets to 20.
     Ad Astra is mobile-only, so use the mobile values. */
  --r: 6px;          /* buttons, inputs, segmented ends, small boxes */
  --r-sm: 4px;       /* chips-as-tags (.selo), tiny boxes, logo box */
  --r-card: 14px;    /* .card, lists, panels (CSmanager .painel mobile = 14) */
  --r-kpi: 16px;     /* KPI tiles, big blocks (CSmanager .dir-bloco/.dir-kpi mobile = 16) */
  --r-big: 12px;     /* action-bar buttons, sheet buttons, map overlay buttons (CSmanager .folha .relogio buttons) */
  --r-sheet: 20px;   /* bottom sheet top corners */
  --r-pill: 999px;

  /* layout */
  --top-h: 56px;     /* CSmanager --altura-topo */
  --nav-h: 62px;     /* CSmanager --altura-barra */
  --disc: 50px;      /* navbar centre disc (CSmanager .barra-inferior-disco); 46px at <=360px */
  --disc-rise: 20px; /* how far the disc stands above the bar (margin-top: -20px) */
  --pad-x: 12px;     /* view side padding (CSmanager .corpo mobile) */
  --gap: 12px;       /* between cards */
  --curve: cubic-bezier(0.32, 0.72, 0, 1);    /* CSmanager --curva: sheets, nav indicator, screen entry */
  --ease: var(--curve);                      /* legacy alias */
}

body, body[data-era="4"] {
  /* surfaces, back to front */
  --s0: #070709;   /* page background */
  --s1: #0c0c0f;   /* cards, header, navbar, sheets */
  --s2: #121216;   /* hover, inset boxes, sub-pill container, strip */
  --s3: #17171c;   /* default button, selected row, icon circle */
  --s4: #1e1e25;   /* hover of button, active segment, progress track */
  --line: #1c1c22;         /* every 1px divider/border */
  --line-strong: #2a2a33;  /* button borders, sheet border, grab handle, chip border */

  --text: #ecedf0;
  --text-2: #9b9ba6;
  --text-3: #626270;

  --green: #4ade80;
  --red: #f87171;
  --yellow: #e3b341;   /* = agency/action accent */
  --amber: #d29922;    /* darker amber: "champion"/tier-1 text, final */
  --info: #7aa2c4;
  --violet: #a78bfa;   /* only for "epic"/secret rarity (CSmanager .dir-prototipo) */

  --green-bg: #4ade8016;
  --red-bg: #f8717116;
  --yellow-bg: #e3b34116;
  --info-bg: #7aa2c416;
  --green-line: #4ade8040;   /* chip borders (CSmanager .dir-chip.*) */
  --red-line: #f8717140;
  --yellow-line: #e3b34140;
  --info-line: #7aa2c440;

  --act: var(--yellow);      /* primary action fill (CSmanager --cor-acao in diretor mode) */
  --act-ink: #151515;        /* text on primary */
  --light: #e8e8ec;          /* "lighter, not coloured" neutral primary (CSmanager button.primario) */
  --light-ink: #0a0a0c;
  --shadow: 0 16px 40px #000000b3;
  --shadow-sheet: 0 -20px 60px #00000099;

  /* LEGACY ALIASES — keep them: map.css, worldmap.css, techtree.css, launch-scene.css and JS read these.
     Builders migrate their own files to the new names; the aliases make un-migrated code look right. */
  --bg: var(--s0);
  --bg2: var(--s1);
  --panel: var(--s1);
  --panel2: var(--s3);
  --grid: transparent;
  --ink: var(--text);
  --ink2: var(--text-2);
  --muted: var(--text-3);   /* NOTE: old --muted was a mid grey used for body copy; where copy must stay
                               readable use --text-2, --text-3 is for labels/meta only */
  --dust: var(--text-3);    /* old beige eyebrow colour -> neutral eyebrow */
  --accent: var(--yellow);
  --accent-ink: var(--act-ink);
  --accent2: var(--yellow);
  --blue: var(--info);
  --good: var(--green);
  --bad: var(--red);
  --warn: var(--yellow);
  --font-body: var(--font);
  --font-display: var(--font);
  --font-mono: var(--mono);
  --radius: var(--r-card);
  --radius-s: var(--r);
}
/* colorblind (KEEP selector "body.colorblind"): blue/orange instead of green/red */
body.colorblind {
  --green: #60a5fa; --green-bg: #60a5fa16; --green-line: #60a5fa40;
  --red: #fb923c;   --red-bg: #fb923c16;   --red-line: #fb923c40;
  --info: #c4b5fd;  --info-bg: #c4b5fd16;  --info-line: #c4b5fd40;
}
```

Base:
```css
html { font-size: calc(15px * var(--text-scale)); }   /* keep: rem in un-migrated rules still works */
body { background: var(--s0); color: var(--text); font-family: var(--font); font-size: var(--t13);
       line-height: 1.5; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
       background-image: none; }
h1, h2, h3 { font-family: var(--font); font-stretch: normal; letter-spacing: -0.01em; font-weight: 600; }
:focus-visible { outline: 2px solid #c8c8c8; outline-offset: 2px; }   /* CSmanager radar focus */
```
No external fonts. `Inter` is used only if installed locally; otherwise system-ui.

Text helpers (map existing ones): `.muted` -> `color: var(--text-3)`, `.small` -> `var(--t11)`,
`.tiny` -> `var(--t10)`; add `.dim { color: var(--text-2) }`, `.mono { font-family: var(--mono);
font-variant-numeric: tabular-nums }`, `.up { color: var(--green) }`, `.down { color: var(--red) }`.

### Type roles

| Role | Spec | CSmanager source |
|---|---|---|
| Topbar title | `--t17`, 650, -0.02em, ellipsis | `.barra-topo-titulo > h1` |
| Topbar subtitle | 12px `--t11`, `--text-3`, ellipsis | `.barra-topo-titulo > span` |
| Page h1 | `--t22`, 600, -0.02em, margin 0 | `.dir-cabecalho h1` (mobile) |
| Page lead | `--t12`(13px), `--text-3`, margin-top 4px | `.dir-cabecalho p` |
| Card title | `--t13`(14px), 600, `--text` | `.dir-bloco > header .titulo` |
| Body / prose | `--t13`; long prose (event text) `--t15` line-height 1.6 `--text-2` | `.texto-longo` |
| Meta / sub | `--t11`(12px) `--text-3` | `.dir-kpi .det` |
| **Eyebrow** (labels) | `--t10`(11px), 500, uppercase, letter-spacing .08em, `--text-3` | `.dir-kpi .rot`, `th`, `.menu .grupo` |
| Eyebrow, accent | `--t10`, 600, uppercase, .08em, `--yellow` | `.dir-sobretitulo` |
| Mono eyebrow (title screen, footers, "fonte · data") | 10px `--mono`, letter-spacing .17em, uppercase, `#8b8b8b`/`--text-3` | `.modo-marca > span`, `.radar-eyebrow` |
| Numbers | `--mono`, tabular-nums, letter-spacing -0.02em | `.cartao > .n`, `.dir-kpi .val` |

### Spacing scale (4px base)
`4, 6, 8, 10, 12, 14, 16, 18, 24`. View padding `14px 12px 28px` (+safe-area l/r). Gap between cards 12.
Card interior 14. KPI grid gap 8. Row padding inside lists `12px 14px`. Header/section rows min-height 48.

### Motion
- `--curve` for sheets (0.36s up / 0.24s ease-in down), nav indicator (0.3s), screen entry (0.26s).
- Screen entry: `.view-inner { animation: screen-in .26s var(--curve) }` with
  `@keyframes screen-in { from { opacity: 0; transform: translateY(8px) } }` (CSmanager `.tela-entra`).
- Card cascade (optional, CSmanager `animacoes.css`): `.card, .tile` `animation: card-in .42s var(--curve)
  backwards`, delays +45ms for nth-child 2..8, none from 9th; `from { opacity:0; transform: translateY(10px)
  scale(.985) }`.
- Press feedback on any button/tappable card: `:active { transform: scale(.97); transition-duration: .06s }`.
- `body.reduce-motion` block (KEEP) must also cover the new animations.

---

## 2. Icons (port CSmanager's inline stroke icons)

CSmanager draws shell icons as inline SVG: 24x24 viewBox, `fill="none" stroke="currentColor"
stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`, `aria-hidden="true" focusable="false"`,
class `icone-svg`. Active nav item bumps `stroke-width` to 2.4.

**Builder 1 adds to `src/ui/components.js` (first thing, others import it):**
```js
export const ICONS = { /* name -> inner SVG markup (string) */ };
export function iconSVG(name, size = 24) { /* returns '<svg class="ic" width=.. height=.. viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+ICONS[name]+'</svg>' */ }
export function icon(name, size = 24, cls = '') { return raw(iconSVG(name, size), ['ic-wrap', cls].filter(Boolean).join(' ')); }
```
Signature is a contract: `icon(name, size?, cls?)` -> `<span class="ic-wrap">` element; `iconSVG(name,
size?)` -> string. Unknown name -> empty svg (never throws).

Paths (ported verbatim from `responsivo.tsx` TRACOS, plus new ones drawn in the same grid/stroke):
```
painel      <path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>          (CSmanager "inicio")
missoes     <path d="M12 2.8c2.9 1.9 4.4 5 4.4 8.9v4.8H7.6v-4.8c0-3.9 1.5-7 4.4-8.9z"/><circle cx="12" cy="9.8" r="1.7"/><path d="M7.6 12.8l-2.6 2.6v3.6l2.6-1.6M16.4 12.8l2.6 2.6v3.6l-2.6-1.6M10.2 19.4L12 21.2l1.8-1.8"/>
pesquisa    <path d="M9 3.5h6M10 3.5v5.6L4.9 17.9A2.1 2.1 0 0 0 6.7 21h10.6a2.1 2.1 0 0 0 1.8-3.1L14 9.1V3.5"/><path d="M7 15h10"/>
mapa        <circle cx="12" cy="12" r="2.6"/><ellipse cx="12" cy="12" rx="9.5" ry="4.6" transform="rotate(-28 12 12)"/><circle cx="20.4" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>
mundo       <circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.3 2.3 3.4 5.2 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.2-3.4-8.5s1.1-6.2 3.4-8.5z"/>
ajustes     <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 4.5v5M10 14.5v5"/>                               (CSmanager)
fechar      <path d="M6 6l12 12M18 6L6 18"/>                                                            (CSmanager)
voltar      <path d="M15 5l-7 7 7 7"/>                                                                  (CSmanager)
avancar     <path d="M9 5l7 7-7 7"/>                                                                    (CSmanager; "+1 semana" link)
proximo     <path d="M4.5 6.5v11l7.5-5.5zM12 6.5v11l7.5-5.5zM20 6v12"/>                                 (CSmanager; "Próximo evento" link)
continuar   <path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>                                         (CSmanager; navbar disc ▶)
carregando  <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/>                                                   (CSmanager; spin)
relogio     <circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>                                (CSmanager)
calendario  <rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>  (CSmanager)
trofeu      <path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7M9.5 17h5"/>  (CSmanager; Tabela da Era / metas)
ranking     <path d="M5 20V12M10 20V6M15 20v-9M20 20V9M3 20.5h18"/>                                    (CSmanager; stats/league)
equipe      <circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.1 2.8-5 5.5-5s4.9 1.9 5.5 5"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.8c1.5.7 2.6 2.4 3 4.7"/>  (CSmanager "elenco")
caixa       <path d="M3.5 13.5l2.6-7.3A1.5 1.5 0 0 1 7.5 5h9a1.5 1.5 0 0 1 1.4 1.2l2.6 7.3V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>  (CSmanager; decisões/inbox)
transferir  <path d="M4 8.5h15l-4-4M20 15.5H5l4 4"/>                                                    (CSmanager; contratos/trocas)
editar      <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>             (CSmanager)
mais        <path d="M12 5v14M5 12h14"/>
menos       <path d="M5 12h14"/>
alvo        <circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>   (recenter)
expandir    <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>
info        <circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.1"/>
alerta      <path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.4v.1"/>
check       <path d="M5 12.5l4.5 4.5L19 7.5"/>
cadeado     <rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>
noticia     <path d="M4 5.5h13v13a2 2 0 0 0 2 2H6a2 2 0 0 1-2-2z"/><path d="M17 9.5h3v9a2 2 0 0 1-4 0M7.5 9h6M7.5 12.5h6M7.5 16h4"/>
seta        <path d="M5 12h14M13 6l6 6-6 6"/>      ("ver tudo →" links)
```
Emoji policy: emoji (mission type icons, tech icons, news icons) may stay **inside content** where they
identify a thing (a probe, a tech), drawn at 18px centred in a 36px `--s3` circle (CSmanager
`.dir-lista-mensagens .icone` mobile). Never in tab labels, buttons, eyebrows, section titles, KPI labels,
or the header. Replace `⚙ ⏵ ⏩ ✕ ▸ ◀ ▶ + − ⌖ ⓘ` glyph buttons with the icons above.

---

## 3. Shell

Structure (`app.js`): `.shell > header.topbar, .ticker, main.view, nav.tabbar` (the time controls live in the
navbar's centre disc, §3.4; there is no separate action bar).
Class names `.tabbar`, `.ticker`, `.modal` must remain (test). Shell: `max-width: 480px`, centred,
`background: var(--s0)`; at >480px the shell gets `border-left/right: 1px solid var(--line)`.

### 3.1 Header (`.topbar`) — mirrors `.barra-topo` + `.dir-topo-movel`
```
[emblem 30px]  Missões                       [ajustes icon btn]
               NASA · sem 1 · jan/2026
```
- `.topbar`: `display:flex; align-items:center; gap:2px; min-height: calc(var(--top-h) + var(--safe-t));
  padding: var(--safe-t) max(6px,var(--safe-r)) 0 max(6px,var(--safe-l)); background: linear-gradient(180deg,
  var(--s2), var(--s1)); border-bottom: 1px solid var(--line); position: relative; z-index: 20`.
  (No 2px orange border.)
- Left: `button.agency` (whole identity block is the button, goes to Painel). Emblem 30px inside a
  `.agency-emblem` box (`border-radius: var(--r-sm)`; the emblem SVG keeps its own colours — the one
  allowed colour in the header). Gap 10px, padding-left 8px.
- `.agency-text`: `h1.agency-title` = **current screen name** (Painel, Missões, Pesquisa, Mapa, Mundo,
  Equipe, Ajustes) `--t17` 650 -0.02em; `.agency-sub` = `${flag} ${short} · ${fmtDate}` `--t11` `--text-3`
  (sans, not mono). The render key must include the route (today it only keys on agency+turn).
- Remove `.era-chip` from the header (the era goes to the Painel page lead and to Ajustes).
- Right: `.icon-btn` = CSmanager `.botao-icone`: 44x44, round, `background:none; border:0; color:
  var(--text)`, `:active { transform: scale(.92) }`, icon `ajustes` 24px, `aria-label="Ajustes"`.

### 3.2 Ticker (`.ticker`) — mirrors `.recado-faixa` + `.vis-ao-vivo`
- Strip under the header: height 34px, `background: var(--s1); border-bottom: 1px solid var(--line);
  color: var(--text-2); font-size: var(--t12); font-weight: 400`. No beige band.
- `.ticker-label` = pill "AO VIVO": `margin: 0 8px 0 max(12px, var(--safe-l)); border-radius: 999px;
  background: var(--red-bg); color: var(--red); font-size: var(--t9); font-weight: 700; letter-spacing:
  .1em; padding: 3px 9px; text-transform: uppercase; animation: live 1.6s ease-in-out infinite`
  (`@keyframes live { 50% { opacity: .55 } }`).
- `.tick-item` separated by a `·` in `--text-3` (CSS `::after`), padding-right 1.6rem. Marquee and mask
  kept. Tap goes to Mundo (unchanged). `body.reduce-motion` keeps the static, scrollable fallback.

### 3.3 Page head (`.view-head` / `.view-title`) — mirrors `.dir-cabecalho`
- `.view-title`: `--t22`, 600, -0.02em, **sentence case**, no `::after` underline, no uppercase.
- Optional lead `p.view-lead`: `--t12`, `--text-3`, margin 4px 0 0.
- Right side items (e.g. tension chip in Mundo) align `flex-end`.
- Since the header already names the screen, page h1 may say something richer (Painel: "Centro de
  controle"; lead "NASA · Era 4 · A Década Lunar"). Map screen has no page head.

### 3.4 Time: the navbar centre disc (`.tab-central`) — mirrors `.barra-inferior-central`
CSmanager's "Jogar o dia" disc, ported 1:1 (`cs-dash-1.png`). It replaced the old `.timebar` action bar
("+1 semana" / "Próximo evento"), which cost 64px of height on every screen.
- Position (since the expansion): between **Missões** and **Mapa** (`DISC_AT = 2` in `app.js`; 4 tabs + the disc
  = 5 equal slots). The tap advances one *turn*, whose length depends on the era (label from
  `query('time/stepLabel')`: "+1 semana" in the Corrida Lunar, "+2 sem", "+1 trimestre", "+1 ano", "até o
  lançamento" when the step is cut short). The text below describes the original 7-slot bar; same column as
  a tab. 6 tabs + the disc = 7 equal slots, so the disc sits exactly on the screen centre (CSmanager's bar
  has 7 slots too); never an even slot count. Markup: `button.tab-central > span.tab-disc (icon 26px) + span.tab-label` (label `aria-hidden`; the
  button carries an `aria-label` that names both actions).
- `.tab-disc`: `width/height: var(--disc)` (50px; 46px at <=360px), `border-radius: 50%`, `background:
  var(--act)`, `color: var(--act-ink)`, `margin-top: calc(-1 * var(--disc-rise))` (-20px: it stands out of the
  bar), `box-shadow: 0 6px 18px #00000080, 0 0 0 4px var(--s1)` (the 4px ring in the bar colour cuts it out
  of the bar's top border). `:active` / held: `transform: scale(.9)`. Focus-visible adds a 2px `--text` ring
  outside the s1 ring. Label = `.tab-label` in `--text-2`, truncated with an ellipsis like every tab label.
- **Tap** = "+1 semana" (`time/advance {weeks: 1, stopOnEvent: false}`, the old secondary button).
  **Long-press** (450ms, `HOLD_MS`) = "Próximo evento": the ring fills while held (`.segurando`), then
  `store.vibrate(15)` and the run starts. The run dispatches `time/advance {weeks: 1, stopOnEvent: true}`
  week by week (max 26), which stops exactly where one `{weeks: 26, stopOnEvent: true}` stops
  (tests/ui-play-disc.test.mjs), so the ring can show progress: `.ocupado` = `::before` rim
  `conic-gradient(var(--act) var(--anel), #ffffff26 0)` masked to 3px, `inset: -7px`. The run's end is
  unknown (it usually stops on an event within 1-4 weeks), so during a run the rim is an indeterminate arc
  (110deg + 30deg per week, max 330deg) that turns (`.girando` spins the rim 1.1s and the `carregando` icon
  .9s), not an x/26 fill. Weeks step every 90ms and the ring stays up at least 520ms. During the run only
  header/ticker/navbar redraw; the screen redraws once at the end. Tapping the disc during a run stops it
  (label "Parar"); the tap keeps the mode it was pressed in, and a tap within 300ms of a run ending on its
  own is ignored (no stray +1 week). While a run is on, `advance()` (Painel links, keyboard) does nothing.
  A finger that slides more than 10px (or leaves the disc while pressed) cancels the hold and the tap.
  `body.reduce-motion`: no spin, no delay.
- States (the disc is never dead while there is a way forward):
  | state | icon | label | tap |
  |---|---|---|---|
  | free clock | `continuar` ▶ | +1 semana | +1 week; hold = next event |
  | running | `carregando` (spins) | Parar | stop the run |
  | blocking decision | `alerta` | Decidir | open that decision (no time passes) |
  | launch in progress | `missoes` (rocket) | Lançar | open the control room |
  | game over (looking at the world) | `trofeu` | Resumo | back to the campaign summary |
  Blocked labels are `--text` 600 so the way out reads first.
- Discoverability: the first tap shows a toast once, "Segure para avançar até o próximo evento"
  (`localStorage['adastra.hint.hold']`). Keyboard: Space/Enter = tap, Shift+Enter = hold action.
- Accessible path without a long-press: the Painel page head carries two quiet `.btn-link`s on the right,
  "+1 semana" (`avancar`) and "Próximo evento" (`proximo`), 36px tall with 38px hit areas
  (`.pn-time`, css/dashboard.css). They route blocked states the same way as the disc.
- Content clearance: the disc stands 20px (+4px ring) over the bottom of `main.view`. Scrolling views
  already end with 28px padding; the map / tech tree keep their tool buttons away from the bar's centre, and
  the map's bottom window cards sit `calc(var(--disc-rise) + 4px + 12px)` above the bar.

### 3.5 Bottom navbar (`.tabbar`) — mirrors `.barra-inferior` exactly
Markup (app.js `renderTabbar`):
```html
<nav class="tabbar" aria-label="Abas">
  <button class="tab" type="button" aria-current="page">
    <span class="tab-icon">[iconSVG(id, 24)] <span class="tab-badge" aria-label="3 pendentes">3</span></span>
    <span class="tab-label">Painel</span>
  </button> ... ×6
</nav>
```
Since the expansion the items come from the screen registry (`src/ui/screens.js`, `nav: 'bottom'`): **Painel**,
**Missões**, [centre disc], **Mapa**, **Mundo**. Pesquisa and Equipe moved to the drawer (§3.6). Original list:
Items, in order: **Painel** (`painel`), **Missões** (`missoes`), **Pesquisa** (`pesquisa`), [centre disc,
§3.4], **Mapa** (`mapa`), **Mundo** (`mundo`), **Equipe** (`equipe`). The tab buttons and the disc are built once per shell
and updated in place (a long-press must survive re-renders). Labels sentence case (CSmanager style). Drop the emoji `TABS[].icon`.

CSS:
```css
.tabbar { display: flex; align-items: stretch; background: var(--s1); border-top: 1px solid var(--line);
  min-height: calc(var(--nav-h) + var(--safe-b)); padding: 0 var(--safe-r) var(--safe-b) var(--safe-l);
  position: relative; z-index: 20; }
.tab { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 3px; padding: 6px 2px 5px; background: none; border: 0; border-radius: 0;
  color: var(--text-3); position: relative; transition: color .15s; }
@media (hover: hover) { .tab:hover { color: var(--text); } }   /* hover only with a pointer */
.tab[aria-current='page'] { color: var(--text); }
.tab[aria-current='page'] .ic, .tab[aria-current='page'] svg { stroke-width: 2.4; }
.tab::after { content: ''; position: absolute; top: 0; left: 50%; width: 22px; height: 3px;
  border-radius: 2px; background: var(--text); opacity: 0; transform: translateX(-50%) scaleX(.3);
  transition: transform .3s var(--curve), opacity .2s; }
.tab[aria-current='page']::after { opacity: 1; transform: translateX(-50%) scaleX(1); }
.tab-icon { display: inline-flex; position: relative; transition: transform .18s var(--curve); }
.tab:active .tab-icon { transform: scale(.86); }
.tab-label { font-size: 10.5px; font-weight: 500; letter-spacing: .01em; line-height: 1.1; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }      /* NOT uppercase, NOT display font */
.tab-badge { position: absolute; top: -6px; right: -10px; min-width: 18px; padding: 0 4px;
  border: 2px solid var(--s1); border-radius: 10px; background: var(--red); color: #fff;
  font: 700 10px/14px var(--mono); text-align: center; }
```
- The indicator is a 3x22px line at the **top** of the item, colour `--text` (not accent).
- Badges: Painel = pending decisions count (red, as today; "hot" state = same red, no pulse animation);
  Mundo = unread important news (cap "9+"; CSmanager caps at "99+"). Zero draws nothing.
- Optional sub-pills (CSmanager `.barra-inferior-sub`, `cs-ranking-sub.png`): when **Missões** is active,
  a pill group can float 8px above the item with its sub-sections (Programa / Montar / Contratos / Frota);
  when **Mundo** is active, (Notícias / Atores / Tratados / Tabela). Spec if implemented:
  container `background: var(--s2); border: 1px solid var(--line); border-radius: 999px; padding: 3px;
  box-shadow: 0 6px 18px #00000080; bottom: calc(100% + 8px)`, buttons 34px tall, `--t11` 600, active =
  `background: var(--text); color: var(--s1)`; clamp inside the viewport (8px margin). This is
  **optional**; the in-page tabs (§4.6) are the required navigation.
- `@media (max-width: 360px)`: label 9.5px.

### 3.6 Drawer (`.gaveta` + `.veu`) — mirrors CSmanager `movel.css` + `responsivo.tsx` `useGaveta`
The 1950-3000 expansion has more screens than a bottom bar can hold, so every secondary screen lives in a left
drawer opened by the ☰ button (first item of the header). Structure: `nav.gaveta#gaveta > .gaveta-cabeca
(agency emblem, name, "Era N · nome · data", close button) + .gaveta-lista (eyebrow .gaveta-grupo per group,
then button.gaveta-item rows)`, and `div.veu` behind it. Both are siblings of `.shell` in `#app`.

- Header after the expansion: `[☰ .menu-btn] [h1 screen title / "NASA · Era 4"] [.data-chip] [emblem button →
  Painel]`. The date chip follows the era's precision (`time.formatTurnEra`: "sem 14 · abr/2026" weekly, "mar/1962",
  "T3 2087", "2741"); at ≤360px the "sem N ·" part hides. Ajustes moved into the drawer.
- `.gaveta`: `position: fixed; left: 0; top: 0; bottom: 0; width: min(86vw, 340px); background: var(--s1);
  border-right: 1px solid var(--line-strong); box-shadow: 24px 0 60px #000000a6`, safe areas as padding,
  `transform: translateX(-104%)` → `.aberta { transform: none }` with the shared curve (.3s / .34s); `visibility`
  follows so the closed drawer is out of the tab order (it is also `inert` and `aria-hidden` while closed).
- `.veu`: `#000000b3`, opacity 0 → `.visivel` 1, tap closes. `z-index` 65 / 70 (above the shell, under sheets).
- Rows: 46px tall, icon 20px `--text-3`, label `--t13`; current screen = `aria-current="page"`, `--s3` background,
  3px `--text` bar on the left. Groups (eyebrows): Agência, Operações, Universo, Mundo, Arquivo, Sistema.
  Screens a later phase delivers show a small "em breve" pill and open an "em breve" page that says what is coming.
- Needs-you: amber dot (`.gaveta-ponto`) or amber count (`.gaveta-contador`) on rows; the ☰ button gets the same
  dot (`.menu-ponto`) when any drawer row needs the player. Bottom tabs keep their red counts; Missões shows an amber
  dot when an accepted mission still has no rocket ("falta o veículo").
- Behaviour: opens with focus on the current row; Tab is trapped inside; Esc, a tap on the veil, a left swipe
  (> 64px, mostly horizontal), choosing a row and the Android back button close it (app.js pushes one history
  entry while it is open; choosing a row replaces that entry with the destination). On close the focus returns to ☰,
  whose `aria-expanded` follows the state. The screen behind is `inert` while the drawer is open.
- `body.reduce-motion` / `prefers-reduced-motion`: no transition.
- Screens are registered in `src/ui/screens.js` (`registerScreen({id, title, icon, group, order, nav, available,
  badge, load | go | action})`); adding a screen is one file plus one line there.

---

## 4. Components (current Ad Astra class -> new spec -> CSmanager class mirrored)

### 4.1 Card `.card` -> `.painel` / `.dir-bloco` (mobile)
`background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-card); padding: 14px;
gap: 10px`. No gradient. `.card-head`: icon + titles + right. `.card-icon`: 36px circle `--s3` (emoji or
icon centred, emblem SVG keeps own shape). `.card-title` `--t13` 600; `.card-sub` `--t11` `--text-3`.
`.card.tappable:active { transform: scale(.97) }` (no coloured border). `.card.mine` (your agency):
`box-shadow: inset 2px 0 0 var(--yellow)` (CSmanager selected row). A card with a header bar (title row +
link on the right, e.g. "Balanço · finanças →") uses `.card > header` = `min-height: 48px; padding: 10px
14px; border-bottom: 1px solid var(--line)`, card `padding: 0`, body `.card-body { padding: 14px }`.

### 4.2 KPI tiles `.tiles/.tile` -> `.dir-kpis/.dir-kpi` (mobile, `cs-dash-2.png`)
`.tiles`: grid 2 columns, gap 8. `.tile`: `background: var(--s1); border: 1px solid var(--line);
border-radius: var(--r-kpi); padding: 12px 14px; min-height: 0; gap: 2px`. Remove `::after` corner mark
and the emoji in the label.
- `.tile-label` = eyebrow (`--t10`, uppercase, .08em, `--text-3`, sans).
- `.tile-value` = `--mono`, `--t22` (19-22px), 600, -0.02em, tabular, line-height 1.15. Colour `--text`
  (green/red only if the number itself is good/bad news).
- `.tile-sub` = `--t11` `--text-3`.
- `.tile-wide` spans 2; sparkline bottom-right (`.faisca-canto`: absolute, right 10, bottom 8, opacity .8,
  stroke `--text-2`, or `--red` when falling).
- `:active { transform: scale(.97) }`; hover (pointer) `border-color: var(--line-strong)`.

### 4.3 Section title `.section-title` -> `.menu .grupo` / `.faixa` eyebrow
`h2`: `--t10`, 500, uppercase, letter-spacing .1em, `--text-3`, no `::before` diamond. Row: `padding:
14px 2px 2px`, right slot holds a count chip or a link button. Link button = `.btn-link`:
`background:none; border:0; color: var(--text-2); font-size: var(--t11); min-height: 32px` +
optional `seta` icon 14px ("ver tudo").

### 4.4 Chips / badges
- `.chip` -> `.dir-chip`: `border: 1px solid var(--line-strong); border-radius: 10px; background: none;
  color: var(--text-2); font-size: var(--t10); line-height: 17px; padding: 1px 7px`.
  Variants: `.chip-good` = `--green-bg` bg, `--green-line` border, `--green` text; `.chip-bad` red;
  `.chip-warn` yellow; `.chip-info` info; `.chip-muted` = `--text-3`, border `--line`;
  `.chip-accent` = yellow variant (your agency / "obrigatório").
- `button.chip` (filter chips: Todas / Importantes / Minha agência) -> `.dir-filtros-caixa button`:
  min-height 38, `border-radius: 999px; background: var(--s2); border: 1px solid var(--line-strong);
  padding: 0 14px; color: var(--text-2); font-size: var(--t12)`; active (`.active` /
  `aria-pressed="true"`) = `background: var(--text); border-color: var(--text); color: var(--s0)`.
  Rows of them scroll horizontally edge to edge (`margin: 0 -12px; padding: 2px 12px 4px`, no scrollbar).
- `.badge` (inline counter) -> `.dir-contador`: `background: var(--yellow); color: #111; border-radius:
  9px; font: 700 var(--t10)/16px var(--mono); min-width: 16px; padding: 0 4px`. Red variant `.badge-bad`
  for blocking counts. `.badge-hot` = `.badge-bad`, no animation.
- Tag `.selo` (mono tag, e.g. "1º", "LAN 0/1"): `font-family: var(--mono); font-size: var(--t10);
  border-radius: 3px; padding: 0 6px; line-height: 1.6`; neutral = `--s3` bg + `--line-strong` border.

### 4.5 Buttons `.btn` -> `button` / `.dir-botao`
- `.btn`: `min-height: 44px; padding: 0 16px; border-radius: var(--r); background: var(--s3); border:
  1px solid var(--line-strong); color: var(--text); font-size: var(--t13); font-weight: 500; gap: 6px`.
  Hover (pointer): `--s4`, border `--text-3`. Disabled: `opacity: .35`. Active: scale(.97).
- `.btn-primary`: `background: var(--act); border-color: var(--act); color: var(--act-ink); font-weight:
  600`; hover `filter: brightness(1.08)`. Sentence case, `--font`, no shadow, no letter-spacing.
- `.btn-light` (new, neutral confirm, CSmanager `button.primario`): `--light` bg/border, `--light-ink`.
  Use for non-agency confirmations inside sheets if a second emphasis is needed. Default primary is amber.
- `.btn-ghost`: `background: none; border-color: transparent; color: var(--text-2)`; hover `--s3` +
  `--line-strong` border.
- `.btn-danger`: looks like `.btn`; `:active`/hover -> `--red-bg` bg, `--red` border+text
  (CSmanager `button.perigo`). Text colour `--red` at rest is allowed for destructive actions.
- `.btn-urgent`: = `.btn-primary` (amber) — no red fill, no pulse.
- `.btn-small`: min-height 36, padding 0 12, `--t12`.
- Big buttons (sheet footers, title screen): add `.btn-big` = min-height 48, radius
  `var(--r-big)`, `--t13`/14px.
- Icon-only round button `.icon-btn` = 44px circle, transparent, `--text` (topbar). Map/world overlay
  tool buttons: see §6.

### 4.6 Segmented / tabs
Two variants of `segmented()` (B1 adds an option; default stays pill-group):
- **In-card toggle** (Mês/Temporada style, `.segmented`) -> `.painel-abas`: joined buttons, each `background:
  var(--s2); border: 1px solid var(--line); color: var(--text-2); min-height: 40px; flex: 1;
  font-size: var(--t12)`; neighbours share borders (`+ .seg { border-left: 0 }`); first/last get
  `var(--r)` outer corners; container has no background/padding. Active: `background: var(--s4);
  color: var(--text); box-shadow: inset 0 -2px 0 var(--yellow)`.
- **Screen sub-navigation** (`segmented(..., { cls: 'tabs' })`, used by Missões Programa/Montar/Contratos/
  Frota and Mundo Notícias/Atores/Tratados/Tabela) -> `.abas` mobile: `display:flex; gap:2px;
  border-bottom: 1px solid var(--line); margin: 0 -12px 14px; padding: 0 12px; overflow-x: auto`;
  buttons `background:none; border:0; border-bottom: 2px solid transparent; border-radius: 0; color:
  var(--text-3); min-height: 44px; padding: 10px 14px; font-size: var(--t13); font-weight: 500`;
  active `border-bottom-color: var(--text); color: var(--text)`. Badge inside = `.badge`.
- Content after a tablist enters with `@keyframes tab-in { from { opacity: 0; transform: translateY(4px) } }`
  .22s (CSmanager `[role=tablist] ~ *`).

### 4.7 Lists -> `.dir-lista-mensagens` / table rows (`cs-caixa.png`)
Lists are **one card with divided rows**, not a stack of boxed rows:
container `background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-card);
overflow: hidden`; row `display:flex; gap: 12px; align-items: center; padding: 12px 14px; min-height:
56px; border-bottom: 1px solid var(--line)`; last row no border; row `:active` -> `background: var(--s2)`.
Row anatomy: leading 36px circle (`--s3`; unread/needs-you = `--yellow-bg` with `box-shadow: 0 0 0 1px
#e3b34155`), text block (`b` `--t13` 600 ellipsis; sub `--t11` `--text-3`), trailing meta (mono `--t10`
`--text-3`, date) and/or chevron (`avancar` 16px `--text-3`). Row "mine": `box-shadow: inset 2px 0 0
var(--yellow)`. Applies to: `.decision-list/.decision-row`, `.launch-list/.launch-row`, `.goal-list/.goal`,
`.firsts/.first-row`, `.league/.league-row`, `.news-feed/.news-item`, `.proposal-list`, `.ledger`,
`.mission-list` (missions may keep separate cards if they carry progress bars — then use §4.1 cards with
12px gap), `.person-list`.

Urgency in decision rows: replace the coloured 4px left border with the leading circle:
urg-1 = `--s3`, urg-2 = `--yellow-bg` + amber ring, urg-3 / blocking = `--red-bg` + red ring and a red
`.chip-bad` "bloqueia o tempo". Kind line = eyebrow.

Ranking rows (`.league-row`, Tabela da Era) -> `cs-ranking-sub.png`: rank in mono; ranks 1–3 in a
`.selo` box (1º = `--yellow-bg`/`--yellow`, 2º/3º = neutral selo); my row `--yellow-bg` background +
inset 2px amber. Points right-aligned mono.

### 4.8 Progress / bars -> `.dir-progresso` / `.medidor`
`.bar`: track `background: var(--s4); height: 6px; border-radius: 3px`. `.bar-fill` default
`--text-2` (neutral progress: mission transit, research, budget share). Semantic fills only:
`.bar-good` green, `.bar-bad` red, `.bar-warn` yellow, `.bar-info` info, `.bar-accent` = yellow (your
agency). Width transition `.5s var(--curve)`. Diverging `.bar-center` keeps green/red + the hatch.
`.bar-row` label `--t11` `--text-2`, value mono `--t10` `--text-3`.
Risk gauge `.gauge`: card s1; `.gauge-label` eyebrow; `.gauge-value` mono `--t24` 600 coloured by band;
`.gauge-track` 8px radius 4, gradient `linear-gradient(90deg, var(--red), var(--yellow) 50%,
var(--green))` at `opacity: .55`; `.gauge-band` = `border: 2px solid var(--text); background: #ffffff1a`.

### 4.9 Bottom sheet `.modal-backdrop/.modal` -> `.folha-cortina/.folha` (`cs-folha.png`)
- Backdrop: `background: #000000b3; backdrop-filter: none; animation: fade .25s ease-out`.
- `.modal`: `background: var(--s1); border: 1px solid var(--line-strong); border-bottom: 0;
  border-radius: var(--r-sheet) var(--r-sheet) 0 0; box-shadow: var(--shadow-sheet); max-width: 480px;
  padding-bottom: var(--safe-b); animation: sheet-up .36s var(--curve)` with
  `@keyframes sheet-up { from { transform: translateY(100%) } }`; closing: `.closing .modal { animation:
  sheet-down .24s ease-in forwards }` (`to { transform: translateY(100%) }`), backdrop fades out .24s.
- `.modal-grab`: `width: 40px; height: 5px; border-radius: 3px; background: var(--line-strong);
  opacity: 1; margin: 10px auto 4px`.
- `.modal-head`: `padding: 0 8px 6px 18px; gap: 8px`; `.modal-title` `--t17` 650 -0.01em, sentence case
  (no uppercase); close `.icon-btn` = 36px circle `background: var(--s3)`, icon `fechar` 20px.
- `.modal-body`: `padding: 6px 18px 18px; gap: 12px`.
- `.modal-actions`: sticky bottom, `background: linear-gradient(180deg, transparent, var(--s1) 30%)`;
  buttons full width, `.btn-big` (48px, radius 12). Primary first (top), secondary below
  (`cs-folha.png`: "Responder no calendário" amber, "Abrir campeonato" outline, then text links row).
- `@media (min-width: 700px)`: centred, `border-radius: 16px`, full border, max-width 520px.

### 4.10 Toasts `.toast` -> `.dir-resumo` (+ `.dir-avisos` position)
Position: bottom, above the navbar and its raised disc: `.toasts { top: auto; bottom: calc(var(--nav-h) +
var(--disc-rise) + var(--safe-b) + 14px) }`.
`.toast`: `background: var(--s2); border: 1px solid var(--line-strong); border-left: 3px solid
var(--text-3); border-radius: var(--r); box-shadow: var(--shadow); padding: 10px 12px; font-size:
var(--t12); color: var(--text)`; `.toast-good` green left border, `.toast-bad` red, `.toast-warn` yellow,
info stays `--text-3`. Enter: `translateY(10px)` -> none .3s.

### 4.11 Notes / alerts `.notes`, `.fallback`, `.contract-banner`, `.ms-crewrisk` -> `.aviso`
`display:flex; gap: 7px; align-items: flex-start; border-radius: var(--r); padding: 8px 10px;
font-size: var(--t11)`; `.warn` = `--yellow-bg` + `--yellow` text; `.bad` = `--red-bg` + `--red`;
`.ok` = green; neutral note = `--s2` bg + `--text-2` (CSmanager: "nota não é problema, sem cor de alarme").
Borders: none (bg tint only). `.fallback` = neutral note with `alerta` icon (no stripes).

### 4.12 Empty state `.empty` -> `.vazio`
`color: var(--text-3); font-size: var(--t11); line-height: 1.7; padding: 22px 14px; text-align: center;
border: 0` (inside a card, or a card itself: s1 + border + radius). No emoji: optional 20px stroke icon in
`--text-3` above the text (`emptyState(text, iconName)`; if the 2nd arg is an emoji, ignore it).

### 4.13 Forms
`.input`/`select`: `background: var(--s0); border: 1px solid var(--line-strong); border-radius: var(--r);
min-height: 44px; font-size: 16px` (iOS zoom rule); focus `border-color: var(--text-3); outline: none`.
`.field > span` = eyebrow label. Range: `accent-color: var(--text-2)`.
Switch `.switch` (settings): track 46x28 `--s4` + `--line-strong` border; knob 20px `--text-2`; checked:
track `--light`, knob `--light-ink` (structural control = no hue).
`details.advanced > summary`: `--t12` `--text-2`, min-height 44, with `avancar` chevron rotating 90° open.

### 4.14 Event / decision card (`.event-card`, `.event-banner`, `.choice`) -> `.dir-destaque` + `.dir-leitura`
- `.event-banner`: `background: linear-gradient(110deg, var(--s2), var(--s1)); border: 1px solid
  var(--line-strong); border-left: 3px solid var(--yellow); border-radius: var(--r-card); padding: 14px`;
  blocking decisions: left border `--red`. Remove `::before` rays.
- `.event-face svg`: 56px, `border-radius: 12px; border: 1px solid var(--line-strong)`.
- `.event-kind` = accent eyebrow (`--yellow`, `--t10` 600 .08em). `.event-title` `--t18` 650 -0.02em,
  sentence case (no uppercase).
- Deadline ("vence em 3 meses") = `.chip` neutral; red chip if this week.
- `.event-body` `--t15` line-height 1.6 `--text-2`.
- `.choice`: `background: var(--s1); border: 1px solid var(--line); border-radius: var(--r-big);
  min-height: 56px; padding: 12px 14px`; `.choice-label` `--t13` 600; `.choice-hint` `--t11` `--text-3`;
  `.choice.selected` = `background: var(--s3); border-color: var(--line-strong); box-shadow: inset 3px 0 0
  var(--yellow)`; `.choice-reason` red text `--t11`; disabled opacity .45.
- `.choice-preview` = neutral note (`--s2`, no dashed border); `.preview-label` eyebrow.
- Confirm button = `.btn-primary.btn-big`; disabled state opacity .35 (no brown fill).

### 4.15 Headline quotes `.headlines blockquote`, `.headline-quote`
No beige paper / serif. `background: var(--s2); border-left: 3px solid var(--line-strong);
border-radius: 0 var(--r) var(--r) 0; padding: 10px 12px; font: 600 var(--t15)/1.4 var(--font);
color: var(--text)`; source/date line in mono eyebrow. Importance 3 news: left border `--yellow`.

### 4.16 Stepper (mission builder) `.stepper`
Steps: `--s1`, border `--line`, radius `var(--r-big)`, `--t11` `--text-3`, min-height 44. Active: `--s3`,
border `--line-strong`, `--text`; `.step-n` 22px circle `--s4` mono; active step-n `background:
var(--text); color: var(--s0)`; done = `--green` text, step-n `--green-bg`.

### 4.17 Selectable tiles (`.type-btn`, `.dest-card`, `.veh-card`, `.person-pick`, `.approach`, `.album-card`)
Base = card (s1, `--line`, radius 12/`--r-card`). Selected = `border-color: var(--yellow); box-shadow:
0 0 0 1px var(--yellow-line); background: var(--s2)` (CSmanager selected player card in `cs-elenco.png`).
Disabled opacity .45. `.approach.safe`/`.bold`: neutral border; the "bold" option gets a `.chip-warn`
label instead of an orange border. Album rarity: rare `--info`, epic `--violet`, legendary `--yellow`
(border only, no glow).

### 4.18 Misc
- `.trend`: mono `--t10`; good green, bad red, flat `--text-3`.
- `.kv-row`: `border-bottom: 1px solid var(--line)` (solid, not dashed), label `--text-3`, value
  `--text` right, mono for numbers. Same for `.ledger li` and `.toggle-row`.
- `.metro` route legs: legs `--text-3` 4px tall; the next/active leg `--info`; dots `--s0` bg with
  `2px solid var(--line-strong)` border. ΔV text mono `--text-3`.
- `.outcome-banner`: no uppercase/display font; `--t15` 650, radius `var(--r)`, tinted bg of its
  semantic colour (`.ob-good` green-bg/green, `.ob-bad` red, `.ob-warn` yellow, `.ob-accent` yellow).
- Count-up flashes keep (green/red text-shadow is meaning).
- Memorial: keep its solemn neutral greys; plates `--s2`, border `--line-strong`; names in `--font` 600
  (serif allowed only here, as a deliberate exception).

---

## 5. Screen mapping (current -> new) and builder ownership

Four builders work in parallel. **Ownership is by file and, inside `styles.css`, by section** (the
existing `/* ---------- name ---------- */` markers). Shared-file protocol: only use `Edit` with anchors
inside your own section; re-read `styles.css` right before each edit (others are editing it); never
`Write` the whole file; don't reorder sections. If you need a new global helper class, put it in your own
section with a screen-specific prefix. Do not add new `.css` files (sw.js `SHELL` and index.html would
need updating — if unavoidable, Builder 1 owns those two files and must be asked through the orchestrator).
**A class is restyled by whoever owns the `styles.css` section where its rules live today**, following
the §4 spec, even if §4 describes it as a generic component. E.g. `.gauge`, `.notes`, `.metro`,
`.stepper`, `.type-btn` live in `missions` (B3); `.tiles`, `.decision-*`, `.launch-*`, `.goal*`,
`.stat*`, `.ledger` live in `dashboard` (B2); `.league*`, `.news-*`, `.proposal-*`, `.chip.tension` live
in `world` (B3); `.approach*`, `.node-card` live in `research` (B4); `.card`, `.chip`, `.btn`,
`.segmented`, `.bar*`, `.empty`, `.fallback`, `.input` live in `basic components` (B1). Section map
today: Era 4 palette + shell + ticker + timebar + tabbar + basic components (B1) · dashboard (B2) ·
modal / bottom sheet generic part (B1) · decision/event card (B2) · toasts (B1) · title screen (B2) ·
missions incl. subway-map bars (B3) · research (B4) · world (B3) · crew (B2) · settings (B1) · fallback
launch room (B3) · reduce motion + small phones (B1) · missions: crew-loss risk (B3) · crew certification
(B3).
Never touch: `src/sim/*`, `src/core/*`, `data/*`, `src/ui/launch-scene.js`, `src/ui/launch-scene.css`,
`src/ui/launch-render/*`, `data/vehicle-art.json`, `tools/launch-preview.*`. Run
`node --test tests/*.test.mjs` before finishing.

### Builder 1 — Foundation, shell, shared components, Ajustes
Files: `styles.css` sections from the top through `---------- basic components ----------`,
`---------- modal / bottom sheet ----------` (generic `.modal*` + `.confirm` only; the Stellaris event
card block that follows belongs to B2), `toasts`, `---------- settings ----------`, `reduce motion`,
`small phones`; `src/ui/app.js`; `src/ui/components.js`; `src/ui/settings.js`; `index.html`
(`theme-color` -> `#0c0c0f`); `manifest.webmanifest` (`theme_color` `#0c0c0f`, `background_color`
`#070709`).
Do, in this order: (1) tokens + legacy aliases (§1) and the `icon()/iconSVG()/ICONS` export (§2) — others
depend on them; (2) header (§3.1, route-aware title), ticker (§3.2), view head (§3.3), action bar (§3.4),
navbar (§3.5); (3) generic components §4.1–4.13 incl. `segmented(..., {cls:'tabs'})` variant, `.btn-big`,
`.btn-light`, `.btn-link`, list container classes (§4.7) as generic `.list`/`.list-row` that the others
may reuse; `emptyState` ignores emoji; `openModal` markup per §4.9 (close button uses `icon('fechar',20)`);
`toast` position; (4) Ajustes screen: page head "Ajustes", groups as cards with `.toggle-row` rows
(§4.13 switch), era line ("Era 4 · A Década Lunar") as lead, about/version in mono footer.
Ad Astra today -> new: orange 2px header border -> s2→s1 gradient + 1px line; "US NASA / sem 1" ->
screen title + "NASA · sem 1 · jan/2026"; round bordered ⚙ -> borderless 44px `ajustes` icon;
beige ticker with orange "AO VIVO" block -> s1 strip + red "AO VIVO" pill; orange "PRÓXIMO EVENTO" with
3D shadow -> amber flat "Próximo evento" radius 12; emoji tab bar + orange top bar -> stroke icons +
3x22 white top line.

### Builder 2 — Painel, decisões, Equipe, title / new game / game over
Files: `src/ui/dashboard.js`, `src/ui/decisions.js`, `src/ui/crew-view.js`, `src/ui/newgame.js`,
`src/ui/portrait.js` (only if a frame colour must change; keep the art); `styles.css` sections
`dashboard`, the decision/event card block (`.event-card` … `.preview-label`), `title screen`, `crew`.
- **Painel** (`aa-before-painel.png` -> `cs-dash-1/2.png`): page head "Centro de controle" + lead
  "{agência} · Era 4 · A Década Lunar". "Verba em caixa" wide KPI tile (mono value, sub "+US$ 78 mi/sem"
  in green only because it is a gain; sparkline bottom-right), then 2x2 KPIs Apoio / Reputação / Equipe /
  Próxima janela (no emoji, eyebrow labels). Decisões: eyebrow section title with `.badge` count ->
  list card (§4.7) with leading circles by urgency; empty -> `.vazio` "Nenhuma decisão pendente. Avance o
  tempo ou monte uma missão." Em voo: list card rows with `bar` neutral fill and mono ETA. Próximos
  lançamentos / Metas da era / Certificação: list cards; section-title right slot = `.btn-link` with
  `seta` ("Nova missão", "Tabela"). Budget sheet (Gasto no ano, lançamentos contábeis): kv/ledger rows
  solid dividers, mono amounts, green/red signs.
- **Decision sheet** (`aa-before-decisao.png` -> `cs-folha.png`): §4.9 + §4.14. "BRIEFING: ARTEMIS II"
  becomes eyebrow "Briefing" (amber) + title "Artemis II" sentence case if the text allows (do not
  change data; only casing via CSS `text-transform: none`).
- **Equipe** (crew-view): page head "Equipe"; role groups = eyebrow section titles; people as list rows
  (portrait 36px circle/rounded 10px, name 600, role + status meta) or a 2-col card grid like
  `cs-elenco.png` (eyebrow role top-left, portrait, name, flag + age, meta) — choose the grid for the main
  roster, rows for ex-members. Person sheet: hero row, traits as chips, history as list rows. Memorial per
  §4.18.
- **Title screen** (`aa-before-title.png` -> `cs-title.png`, `.modo-inicial`): page `--s0` (or `#0f0f0f`)
  with CSmanager's faint grid: `::before` 72px grid `linear-gradient(#6a6a6a44 1px, transparent 1px)`
  both axes, `opacity: .13`, `mask-image: linear-gradient(to bottom, black, transparent 65%)`.
  Brand row: monogram box 34px "AA" (`border: 1px solid #78787855; background: #d7d1c50d; 14px 800
  letter-spacing -1px`) + `strong` "Ad Astra" 18px -0.4px; below it the mono eyebrow
  "AGÊNCIA ESPACIAL / ESTRATÉGIA" (10px mono, .17em, `#8b8b8b`). Opening: mono eyebrow
  "ERA 4 · A DÉCADA LUNAR"; h1 44px weight 550, letter-spacing -2.6px, line-height 1.05:
  "Corrida lunar,<br><em>2026 a 2030.</em>" (`em` normal style, `#a8a8a8`); tagline p 14px/1.8 `#969696`.
  The poster SVG (rocket + moon over a sunburst) is drawn in the sober palette: navy/graphite rays
  (`#0a0e16`->`#131a26` sky, `#1a2232` rays), a faint amber glow at the horizon, grey moon, light-grey
  rocket with the amber `--yellow` band and flame as the only colour (no orange sunburst, no CSS filter).
  It stays as identity art inside a `.modo-card`-like frame (`border: 1px solid #2d2d2d;
  background: #161616; border-radius: 6px`), with a mono index row "01  CORRIDA LUNAR" on top and no
  text-shadow title over it. Actions: "Continuar · NASA · sem 3" and "Começar" = `.btn-primary.btn-big`
  full width; "Novo jogo"/"Ajustes" = secondary `.btn-big`. Actor picker = list card rows (emblem 40px,
  name 600, style sub, chips: tier chip semantic, budget mono). "Opções avançadas" per §4.13.
  Footer: mono 9px .1em `#717171` "v0.4.0 · CALENDÁRIO REAL DE 2026; O FUTURO É SIMULAÇÃO".
- **Game over**: same language as title: eyebrow + big h1 (reason), KPI grid of the campaign, list of
  firsts, primary "Nova campanha", secondary "Ver o mundo final".

### Builder 3 — Missões, Mundo
Files: `src/ui/missions-tab.js`, `src/ui/world-tab.js`, `src/ui/worldmap.js` (chrome/labels only),
`src/ui/worldmap.css`; `styles.css` sections `missions`, `missions: crew-loss risk`, `crew certification
+ capacity help`, `fallback launch room`, `world`.
- **Missões** (`aa-before-missoes.png`): page head "Missões"; sub-nav Programa/Montar/Contratos/Frota ->
  `segmented(..., {cls:'tabs'})` underline tabs (§4.6). "EM VOO 4" -> eyebrow + mono count. Mission cards:
  s1 cards (§4.1) with leading 36px circle (type emoji allowed there), title 600, sub `--text-3`, status
  chip right (`chip-info` "Em trânsito"; done green; failed red; cancelled muted), chips row
  ("subida ok" green chip, "calendário real" muted chip), ETA line `--t11` `--text-2` + neutral 6px bar
  (no orange). Mission detail sheet: §4.9, kv rows, crew strip (portraits 44px), log as list rows,
  report with outcome banner §4.18.
  Builder (Montar): stepper §4.16, type grid / destination / vehicle cards §4.17, metro bars §4.18,
  risk gauge §4.8, `.builder-nav` sticky with `--s0` gradient, buttons `.btn-big` (Voltar secondary,
  Avançar/Agendar primary). Contracts: list rows; `.contract-banner` -> yellow `.aviso`. Frota: cards,
  cert steps with `check` icons in green, locked with `cadeado`.
- **Mundo** (`aa-before-mundo.png`): page head "Mundo" + right tension chip (t0 green-bg, t1 neutral,
  t2 yellow, t3/t4 red; no pulse). World map card `.wm`: s1, `--line` border, radius `--r-card`; header
  row 48px ("Mapa-múndi" `--t13` 600, conflict chip `chip-bad`, chevron icon); overlay tools (+ − alvo
  info) = §6 map buttons; timeline: track `--s4` 6px, thumb `--text`, arrows = 40px `.btn` with
  `voltar/avancar` icons; caption `--t11` `--text-2` with bold date. Sub-nav Notícias/Atores/Tratados/
  Tabela -> underline tabs. Filter chips Todas/Importantes/Minha agência -> filter pills (§4.4).
  News -> list card rows grouped by mono date eyebrow; imp-3 rows: leading circle `--yellow-bg`;
  headlines per §4.15. Atores: list rows (emblem 36px, name, bloc meta, relation bars §4.8). Tratados /
  proposals: list rows, long-shot = dashed `--line-strong` border kept. Tabela: ranking rows §4.7.
  Canvas imagery (countries, blocs, routes) unchanged; in `worldmap.js` only the actor label pills: bg
  `rgba(12,12,15,.92)`, border `#2a2a33`, player pill border `#e3b341` (was dark gold), text `#ecedf0`.

### Builder 4 — Pesquisa, Mapa
Files: `src/ui/research-tab.js`, `src/ui/techtree.css`, `src/ui/map.js` (chrome/DOM only, not canvas
art), `src/ui/map.css`; `styles.css` section `research`.
- **Pesquisa** (`aa-before-pesquisa.png`): page head "Pesquisa". Science card = KPI tile (eyebrow
  "Pontos de ciência", mono value, right column meta `--t11` `--text-2`: "+1/sem", "0/2 projetos",
  "5/39 tecnologias"). Legend = row of small chips. Tech tree nodes (`.tt-node`): `--s1` tiles, radius
  10, 1px border; state colours (meaning only): done = `--green` border + `--green-bg`; active
  (researching) = `--info` border + ring `--info`; available = `--yellow` border (your move); locked =
  `--line` border, opacity .5, `cadeado` icon; secret = dashed `--text-3`. Branch bands: `--s1` bg,
  `--line` border, radius `--r-card`, label = eyebrow (branch emoji may stay before it at 14px). Edges
  `--line-strong`, active path `--text-3`. Tool buttons (− + expandir alvo) = §6. Research sheet: §4.9,
  approach cards §4.17, facts as kv rows. Branch colours in `research-tab.js` (`#cdbf9f`, `#4fb3d9`…)
  -> use only for the small branch dot, not for big fills.
- **Mapa** (`aa-before-mapa.png`): map imagery (sun, orbits, planets, belts, window diamonds) unchanged.
  Chrome: set in `map.css` `.map-root { --map-bg: var(--s0); --map-panel: rgba(12,12,15,.92);
  --map-line: var(--line-strong); --map-text: var(--text); --map-muted: var(--text-2); --map-accent:
  var(--yellow); --map-warn: var(--yellow) }`. Mapa/Rotas toggle -> in-card toggle (§4.6 `.segmented`:
  joined `--s2` buttons, `--line` borders, `var(--r)` outer corners, active `--s4` + inset 2px `--yellow`
  underline), date right in mono `--text-2`. Level chips (Terra-Lua/Interno/Externo/Completo/?) -> 38px
  filter buttons with `border-radius: var(--r)` (not pills; pills read too soft next to the map tools):
  active = same mark as the Mapa/Rotas toggle above (`--s4` bg, `--text` 600, inset 2px `--yellow`
  underline), so the screen has one "selected" style. Zoom +/− -> §6. "8 missões em trânsito" chip -> `.chip` with a 6px `--info` dot.
  Window cards at the bottom (`.map-win`) -> s1/92% cards radius 12, border `--line-strong`, left accent
  3px `--yellow` only for "your next window", progress 4px `--text-2`. Destination sheet (`.map-sheet`)
  -> folha §4.9 (grab, title 17px, round close, kv rows, primary "Planejar missão" amber `.btn-big`).
  Legend card -> list card rows with swatches. Metro view: §4.18.

---

## 6. Overlays on imagery (map, world map, tech tree, launch)

Shared spec for any control floating over a canvas/SVG:
- Tool button: 44x44 (min 40), `border-radius: var(--r-big)`, `background: rgba(12,12,15,.92)`,
  `border: 1px solid var(--line-strong)`, `color: var(--text)`, icon 20px from §2 (`mais`, `menos`,
  `alvo`, `expandir`, `info`), `backdrop-filter: blur(6px)` allowed, `:active scale(.92)`; stacked with 8px
  gap; never covering the canvas top-right labels (inset 12px + safe area).
- Floating chip/info panel: `rgba(12,12,15,.92)`, `--line-strong` border, radius 12, `--t11`.
- Bottom sheets over imagery: §4.9 exactly.
- Labels drawn on canvas may keep their own palette; when a label pill needs "mine", use `#e3b341`.
- **Launch scene**: not touched by this redesign (another workflow owns it). It reads `--accent`, `--bg`,
  `--line`, `--muted`, `--panel`, `--warn`, `--text-scale`, `--text`, `--danger`, `--ok`, `--fg` from the
  global scope — the legacy aliases in §1 keep those defined, so it keeps working. When that workflow
  restyles its chrome it should use: HUD panels `rgba(12,12,15,.92)` + `--line-strong`, eyebrows mono
  10px .17em, numbers mono tabular, primary action amber `.btn-primary.btn-big`, go/no-go as
  green/red chips, abort as `.btn-danger`.

---

## 7. What to port from CSmanager (checklist)

| CSmanager | Ad Astra target |
|---|---|
| tokens `--s0..--s4`, `--linha*`, `--texto*`, semantic + `-bg` (estilo.css :root) | §1 tokens |
| mobile type scale + radius bump (movel.css `@media (max-width:1023.98px)`) | §1 `--t*`, `--r-card`, `--r-kpi` |
| `--curva`, `.tela-entra`, `cartao-entra` cascade, button `:active scale(.97)` (movel.css, animacoes.css) | §1 motion |
| `.barra-topo`, `.barra-topo-titulo`, `.botao-icone`, `.barra-topo-progresso` | `.topbar` §3.1 |
| `.recado-faixa`, `.vis-ao-vivo` | `.ticker` §3.2 |
| `.dir-cabecalho` | `.view-head` §3.3 |
| `.barra-inferior`, `-item`, `::after` indicator, `-icone`, `-rotulo`, `-selo`, `-sub` | `.tabbar` §3.5 |
| `.barra-inferior-central`, `-disco`, `.ocupado`, `.girando` | `.tab-central`, `.tab-disc` §3.4 |
| `.folha .relogio` buttons (+1d/+7d/+30d) | Painel head links `.pn-time` §3.4 |
| `Icone` + `TRACOS` (responsivo.tsx) | `icon()` §2 |
| `.painel`, `.dir-bloco`, `.corpo-bloco` | `.card` §4.1 |
| `.dir-kpis`, `.dir-kpi .rot/.val/.det`, `.faisca-canto`, `.cartao` | `.tiles/.tile` §4.2 |
| `.menu .grupo`, `.faixa`, `th` eyebrow | `.section-title` §4.3 |
| `.dir-chip.*`, `.selo.*`, `.dir-contador`, `.dir-filtros-caixa button` | chips/badges §4.4 |
| `button`, `button.primario`, `.dir-botao.primario`, `.fantasma`, `.perigo` | `.btn*` §4.5 |
| `.painel-abas`, `.abas` (mobile) | `.segmented` / tabs §4.6 |
| `.dir-lista-mensagens`, `.dir-lista-simples`, `.dir-tabela`, ranking `.selo` ranks | lists §4.7 |
| `.dir-progresso`, `.medidor`, `.barra-h` | `.bar` §4.8 |
| `.folha-cortina`, `.folha`, `.folha-alca`, `.folha-topo`, `.folha-fechar`, `.cortina > .modal` mobile | `.modal` §4.9 |
| `.dir-avisos`, `.dir-resumo` | `.toasts/.toast` §4.10 |
| `.aviso.*` | notes §4.11 |
| `.vazio` | `.empty` §4.12 |
| `input/select` rules, 16px iOS rule, `label > .rot` | forms §4.13 |
| `.dir-destaque`, `.dir-sobretitulo`, `.dir-leitura` | event card §4.14 |
| `.modo-inicial`, `.modo-marca`, `.modo-monograma`, `.modo-abertura`, `.modo-card`, `.modo-rodape`, `.radar-eyebrow` | title screen (B2) |
| selected card amber border (Elenco) | §4.17 |

Ported (1950-3000 expansion, EXPANSION.md §12): the hamburger drawer (`.gaveta`, `.veu`), see §3.6; the
"Calendário de lançamentos" drawer screen uses `.agenda-do-mes` rows. Still not ported: stories (`.stories`).

---

## 8. Done criteria (each builder)
- At 390x844 each owned screen matches the language of the `cs-*` references: near-black flat surfaces,
  1px `--line` borders, no orange, no uppercase titles, eyebrows tiny and spaced, numbers mono, amber only
  for agency/main action/needs-you, green/red only for good/bad.
- No horizontal scroll at 320px; tap targets >= 44px (nav items, chips >= 38px).
- `body.colorblind`, text size A+/A++, and `body.reduce-motion` still work.
- `node --test tests/*.test.mjs` passes. No test changes are expected; if one encodes the old look,
  update it and say so.
- Player-facing text stays pt-BR. No external fonts/CDNs. No changes to sim/core/data/launch files.
