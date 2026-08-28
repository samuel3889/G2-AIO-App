/**
 * Shared visual language for every phone panel.
 *
 * WHY THIS FILE EXISTS
 * Before this, settings.ts, sessions.ts, prompts.ts and review.ts each shipped
 * their own private <style> block with its own greys (#111 vs #1a1a1a vs #161616),
 * its own button radius and its own accent. Four panels, four design systems,
 * one screen. Everything visual now lives here; the panels only compose it.
 *
 * WHAT IT OWNS
 *   - CSS custom properties (the only place a colour is chosen)
 *   - the app shell classes used by tabs.ts (.g2-appbar / .g2-scroll / .g2-nav)
 *   - reusable components: .card, .btn, .chip, .tile, .inp, .slider
 *   - makeCard(): the collapsible section every panel is built from
 *   - PANEL_ORDER: flex `order` values, so a host's sections stack in a fixed
 *     order no matter what order the panels happened to mount in
 *   - icon(): inline SVG, stroke: currentColor, so icons inherit chip/button colour
 *
 * COLOURS are the Even Realities dark surfaces already used in the old ui.ts
 * (#232323 / #2E2E2E / #3E3E3E) with the OS green #3CFA44 as the single accent
 * and #FF453A for danger. Nothing else is allowed to be a brand colour.
 *
 * THE REVIEW COMPAT BLOCK at the bottom is deliberate. review.ts still injects
 * its own .g2r stylesheet and its internals are NOT rewritten; the overrides are
 * scoped `.g2p .g2r` (specificity 0,2,0) so they beat review's own `.g2r` rules
 * (0,1,0) regardless of which <style> is appended last.
 *
 * The .g2r root itself is now FLAT — no background, border, radius, padding or
 * margin — because review.ts wraps it in a real makeCard(). Leaving the old
 * slab styling on it would draw a second card inside the first, which is the
 * exact double-bordered look this file exists to prevent.
 *
 * No Even Hub SDK calls here. DOM only.
 */

const CSS = `
:root {
  color-scheme: dark;

  /* surfaces */
  --bg:        #1B1B1B;
  --surface:   #232323;
  --surface-2: #2A2A2A;
  --sunken:    #161616;
  --line:      #3A3A3A;
  --line-soft: #2E2E2E;

  /* ink */
  --text:   #ECECEC;
  --text-2: #A3A3A3;
  --text-3: #767676;

  /* signal */
  --accent:     #3CFA44;
  --accent-ink: #05270A;
  --accent-dim: rgba(60,250,68,.12);
  --info:       #7FD1FF;
  --warn:       #FFB454;
  --danger:     #FF453A;
  --danger-dim: rgba(255,69,58,.12);

  --r1: 8px;
  --r2: 12px;
  --r3: 18px;

  --ease: cubic-bezier(.2,.7,.3,1);
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  /**
   * Height of the in-page app bar (the "G2 / Live ... HOME - TAP FOR MENU"
   * strip), NOT the host's native "Even Hub ASR" title bar above it.
   *
   * Was 50px, and the strip additionally added env(safe-area-inset-top) to
   * both its height and its top padding - see .g2-appbar below. The host
   * already draws its own title bar under the system status bar, so that
   * inset was being paid twice: once by the host chrome, once here. The
   * visible result was a tall dead band with the row pinned to its bottom.
   * 38px is one 12px uppercase line plus 13px above and below.
   */
  --appbar-h: 38px;
}

* { -webkit-tap-highlight-color: transparent; }
*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

html, body {
  margin: 0; height: 100%;
  background: var(--bg); color: var(--text);
  font: 15px/1.45 var(--font);
  -webkit-text-size-adjust: 100%;
  overscroll-behavior: none;
  touch-action: manipulation;
}
body { display: flex; flex-direction: column; }

/* ------------------------------------------------------------------ shell */

/**
 * The in-page app bar.
 *
 * NO env(safe-area-inset-top) here. This WebView is hosted below the Even Hub
 * native title bar, which has already cleared the notch/status bar, so adding
 * the inset again pushed the row down by the full status-bar height and left
 * the band above it empty. If this page is ever loaded standalone (browser,
 * fullscreen WebView) the row would sit under the system clock - put the inset
 * back on <body> in that case, not here.
 *
 * gap/padding trimmed with the height so the row still reads as centred.
 */
.g2-appbar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 7px;
  height: var(--appbar-h);
  padding: 0 14px;
  background: linear-gradient(180deg, #272727, #1F1F1F);
  border-bottom: 1px solid var(--line-soft);
  position: relative; z-index: 4;
}
.g2-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  background: var(--text-3); box-shadow: 0 0 0 3px rgba(255,255,255,.04);
  transition: background .2s var(--ease), box-shadow .2s var(--ease);
}
.g2-dot.ok  { background: var(--accent); box-shadow: 0 0 10px rgba(60,250,68,.55); }
.g2-dot.bad { background: var(--danger); box-shadow: 0 0 10px rgba(255,69,58,.5); }
.g2-brand {
  font: 800 11px/1 var(--font); letter-spacing: .16em; color: var(--text-2);
}
.g2-sep   { color: var(--text-3); font-size: 11px; }
.g2-crumb { font: 650 12px/1 var(--font); color: var(--text); }
.g2-appbar .spacer { flex: 1 1 auto; }
.g2-conn {
  font: 600 10px/1 var(--font); letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-3); white-space: nowrap; max-width: 44%;
  overflow: hidden; text-overflow: ellipsis;
}
.g2-conn.ok  { color: var(--accent); }
.g2-conn.bad { color: var(--danger); }

.g2-scroll {
  flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  padding: 14px 12px 22px;
}

/* A panel that renders several stacked cards wraps them in this. */
.g2-stack { display: flex; flex-direction: column; gap: 14px; }

/* One tab host. Panels are children; the gap is the only vertical rhythm rule. */
.g2p { max-width: 560px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.g2p[hidden] { display: none; }

/* ui.ts owns #app and overwrites it wholesale; tabs.ts moves it into the first
   host. Height must be content-sized or it parks the rest a screen down. */
#app { display: block; height: auto; }

.g2-nav {
  flex: 0 0 auto; display: flex; gap: 4px;
  padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
  background: #1F1F1F; border-top: 1px solid var(--line-soft); z-index: 5;
}
.g2-nav button {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px;
  min-height: 52px; padding: 8px 4px;
  background: transparent; border: 0; border-radius: var(--r2);
  color: var(--text-3); font: 650 11px/1 var(--font); letter-spacing: .02em;
  touch-action: manipulation; transition: color .15s var(--ease), background .15s var(--ease);
}
.g2-nav button svg { width: 22px; height: 22px; }
.g2-nav button.on { color: var(--accent); background: var(--accent-dim); }
.g2-nav button:active { background: rgba(255,255,255,.06); }

/* An on-screen keyboard shoves the fixed bar up over the field being typed in.
   focusin/focusout in tabs.ts toggles this. */
body.g2-kbd .g2-nav { display: none; }

/* ------------------------------------------------------------- components */

.card {
  background: var(--surface);
  border: 1px solid var(--line-soft);
  border-radius: var(--r3);
  overflow: hidden;
  box-shadow: 0 1px 0 rgba(255,255,255,.03) inset, 0 6px 20px rgba(0,0,0,.28);
}
.card-h {
  display: flex; align-items: center; gap: 11px; width: 100%;
  box-sizing: border-box; padding: 14px 16px;
  background: transparent; border: 0; color: inherit; text-align: left; font: inherit;
}
button.card-h { touch-action: manipulation; }
button.card-h:active { background: rgba(255,255,255,.03); }
.card-h .lead {
  flex: 0 0 auto; width: 32px; height: 32px; border-radius: 10px;
  display: grid; place-items: center;
  background: var(--surface-2); color: var(--text-2); border: 1px solid var(--line-soft);
}
.card-h .lead svg { width: 17px; height: 17px; }
.card-h .txt { flex: 1 1 auto; min-width: 0; }
.card-h .ttl { display: block; font: 650 15px/1.25 var(--font); }
.card-h .sub { display: block; margin-top: 3px; font-size: 12px; color: var(--text-3); }
.card-h .sub:empty { display: none; }
.card-h .aside { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
.card-h .chev { flex: 0 0 auto; color: var(--text-3); display: grid; place-items: center;
                transition: transform .18s var(--ease); }
.card-h .chev svg { width: 18px; height: 18px; }
.card.open .card-h .chev { transform: rotate(90deg); }
.card-b { padding: 2px 16px 16px; }
.card.collapsed .card-b { display: none; }

.btn {
  appearance: none; display: inline-flex; align-items: center; justify-content: center;
  gap: 7px; min-height: 44px; padding: 11px 14px;
  background: var(--surface-2); color: var(--text);
  border: 1px solid var(--line); border-radius: 11px;
  font: 650 13px/1 var(--font); touch-action: manipulation;
  transition: transform .08s var(--ease), background .15s var(--ease);
}
.btn svg { width: 16px; height: 16px; }
.btn:active   { transform: scale(.985); background: #343434; }
.btn:disabled { opacity: .45; transform: none; }
.btn.primary  { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.btn.primary:active { background: #31DE39; }
.btn.danger   { background: var(--danger-dim); color: var(--danger); border-color: rgba(255,69,58,.35); }
.btn.armed    { background: var(--danger); color: #fff; border-color: transparent; }
.btn.ghost    { background: transparent; }
.btn.sm       { min-height: 36px; padding: 8px 11px; font-size: 12px; border-radius: 9px; }
.btn.icon     { width: 44px; padding: 0; }
.btn.icon.sm  { width: 36px; }
.btn.wide     { width: 100%; }
.btnrow { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.chip {
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  padding: 6px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2);
  font: 700 11px/1 var(--font); letter-spacing: .08em; text-transform: uppercase;
}
.chip.ok   { color: var(--accent); border-color: rgba(60,250,68,.4);  background: var(--accent-dim); }
.chip.bad  { color: var(--danger); border-color: rgba(255,69,58,.4);  background: var(--danger-dim); }
.chip.warn { color: var(--warn);   border-color: rgba(255,180,84,.4); background: rgba(255,180,84,.10); }
.chip.info { color: var(--info);   border-color: rgba(127,209,255,.35); background: rgba(127,209,255,.10); }
.chip.mute { color: var(--text-3); }
.chip.pulse::before {
  content: ''; width: 7px; height: 7px; border-radius: 50%;
  background: currentColor; animation: g2pulse 1.6s ease-in-out infinite;
}
@keyframes g2pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }

.tile {
  background: var(--surface-2); border: 1px solid var(--line-soft);
  border-radius: var(--r2); padding: 12px;
}
.tile + .tile { margin-top: 8px; }
.tile .ttl  { display: block; font: 650 14px/1.3 var(--font); overflow-wrap: anywhere; }
.tile .meta { display: block; margin-top: 3px; font-size: 12px; color: var(--text-3); }
.tile.on { border-color: rgba(60,250,68,.45);
           background: linear-gradient(180deg, rgba(60,250,68,.07), transparent); }

.inp {
  width: 100%; box-sizing: border-box;
  background: var(--sunken); color: var(--text);
  border: 1px solid var(--line); border-radius: 11px; padding: 11px 12px;
  /* 16px, or the browser zooms the page on focus and leaves the panel
     scrolled sideways and half off-screen. */
  font: 16px/1.45 var(--font);
}
.inp::placeholder { color: var(--text-3); }
.inp:focus { outline: none; border-color: rgba(60,250,68,.5); box-shadow: 0 0 0 3px var(--accent-dim); }
textarea.inp { min-height: 44vh; resize: vertical; white-space: pre-wrap; }

.lbl {
  margin: 14px 0 6px;
  font: 800 10px/1 var(--font); letter-spacing: .16em; text-transform: uppercase;
  color: var(--text-3);
}
.note  { font-size: 12px; line-height: 1.45; color: var(--text-3); }
.state { font-size: 12px; color: var(--text-3); }
.state.err, .err { color: var(--danger); }
.mono  { font-family: var(--mono); }
.num   { font-variant-numeric: tabular-nums; }
.empty {
  padding: 20px 10px; text-align: center; font-size: 13px; color: var(--text-3);
  border: 1px dashed var(--line); border-radius: var(--r2);
}
.divider { height: 1px; background: var(--line-soft); margin: 14px 0; border: 0; }

/* --------------------------------------------- review.ts compatibility skin
   Scoped as .g2p .g2r so it wins on specificity, not on style-tag order.     */
.g2p .g2r {
  background: transparent; color: var(--text); font-family: var(--font);
  border: 0; border-radius: 0; margin: 0; padding: 0; max-width: none;
}
.g2p .g2r .sub  { font-size: 12px; color: var(--text-3); margin-bottom: 12px; }
.g2p .g2r .stats { color: var(--text-3); }
.g2p .g2r button {
  min-height: 40px; border-radius: 10px; font-weight: 650;
  background: var(--surface-2); color: var(--text); border: 1px solid var(--line);
}
.g2p .g2r button.on   { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.g2p .g2r button:active { background: #343434; }
.g2p .g2r select {
  min-height: 44px; border-radius: 11px; padding: 10px 12px; font-size: 15px;
  background: var(--sunken); color: var(--text); border: 1px solid var(--line);
}
.g2p .g2r .row     { background: var(--surface-2); border: 1px solid var(--line-soft);
                     border-radius: var(--r2); }
.g2p .g2r .row.playing { background: rgba(60,250,68,.07); outline: 1px solid rgba(60,250,68,.5); }
.g2p .g2r .player,
.g2p .g2r .legend  { background: var(--sunken); border: 1px solid var(--line-soft);
                     border-radius: var(--r2); }
.g2p .g2r .nrow .nm { min-height: 40px; border-radius: 10px;
                      background: var(--sunken); border: 1px solid var(--line); color: var(--text); }
.g2p .g2r .nrow .tag  { background: var(--accent-dim); color: var(--accent); border-radius: 6px; }
.g2p .g2r .nrow .save { background: var(--accent-dim); color: var(--accent);
                        border-color: rgba(60,250,68,.35); }
.g2p .g2r .nrow .forget { background: var(--danger-dim); color: var(--danger);
                          border-color: rgba(255,69,58,.35); }
`

let installed = false

/** Inject the stylesheet once. Safe to call from every panel. */
export function installTheme(): void {
  if (installed) return
  installed = true
  const style = document.createElement('style')
  style.id = 'g2-theme'
  style.textContent = CSS
  // First child of <head> so any panel-local sheet appended later can still
  // override a component deliberately.
  document.head.prepend(style)
}

/* -------------------------------------------------------------------- icons */

const ICONS: Record<string, string> = {
  waves:    '<path d="M2 12h2m3-6v12m4-9v6m4-10v14m4-9v4m3-3h2"/>',
  chat:     '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z"/>',
  // Lidded box with a pull slot: stored conversations, as distinct from the
  // `chat` bubble the Conversations TAB uses. A section must not wear its own
  // parent's icon or the nesting stops reading.
  archive:  '<rect x="3" y="4" width="18" height="4.5" rx="1.4"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5"/><path d="M10 12.5h4"/>',
  headset:  '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="7" rx="2"/><rect x="17" y="14" width="5" height="7" rx="2"/>',
  sliders:  '<path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
  chevron:  '<path d="m9 6 6 6-6 6"/>',
  refresh:  '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  trash:    '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  edit:     '<path d="M4 20h4l10-10-4-4L4 16v4Z"/><path d="m14 6 4 4"/>',
  check:    '<path d="m4 12 5 5L20 6"/>',
  record:   '<circle cx="12" cy="12" r="7"/>',
  stop:     '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  doc:      '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/>',
  spark:    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>',
  user:     '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  tag:      '<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z"/><circle cx="8" cy="8" r="1.4"/>',
  disc:     '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  mic:      '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  reset:    '<path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/>',

  // Added for the tuning panel's section headers. Each one has to read at
  // 18px inside a card badge, so they are deliberately 2-3 strokes and no
  // more - detail at this size turns into a smudge.

  // Dial with a needle: a threshold something is measured against.
  gauge:    '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 18 4.5-6"/><circle cx="12" cy="18" r="1.4"/>',
  // Measured span: two end posts with a double-headed arrow between them.
  span:     '<path d="M4 5v14M20 5v14"/><path d="M7 12h10"/><path d="m9.5 9.5 3 2.5-3 2.5M14.5 9.5l3 2.5-3 2.5"/>',
  // Two heads, one behind the other: telling people apart, not one person.
  users:    '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.9a3.4 3.4 0 0 1 0 6.2"/><path d="M17.5 14.4A6.5 6.5 0 0 1 21.5 20"/>',
  // Clock face with hands: a duration on the wall, not on disk.
  clock:    '<circle cx="12" cy="12" r="9"/><path d="M12 6.5V12l3.5 2.2"/>',
}

/**
 * Inline SVG markup for `name`, stroked in currentColor so it inherits the
 * colour of whatever chip or button it sits in. Unknown names render a dot
 * rather than throwing, so a typo degrades instead of blanking a tab bar.
 */
export function icon(name: string): string {
  const body = ICONS[name] ?? '<circle cx="12" cy="12" r="4"/>'
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
  )
}

/* --------------------------------------------------------------------- card */

export interface CardOptions {
  title: string
  sub?: string
  /** Key into the icon set above. Omit for no leading badge. */
  icon?: string
  /** Header becomes a button that folds the body away. */
  collapsible?: boolean
  /** Starting state for a collapsible card. Ignored when `memory` restores one. */
  open?: boolean
  /** Remember open/closed under this key across app restarts. */
  memory?: string
  /**
   * Fired when the card is folded or unfolded — by tap or by setOpen(), but
   * NOT for the initial state, which the caller already knows via isOpen().
   *
   * This is what lets a section behave like a tab used to: review.ts defers
   * its first fetch until it is opened, and stops audio when it is closed.
   */
  onToggle?: (open: boolean) => void
}

export interface CardHandle {
  root: HTMLElement
  /** Put panel content in here. */
  body: HTMLElement
  /** Right-hand header slot: chips, counts, a small button. */
  aside: HTMLElement
  setSub: (text: string) => void
  setOpen: (open: boolean) => void
  isOpen: () => boolean
}

function remember(key: string, open: boolean): void {
  try { localStorage.setItem(`g2:card:${key}`, open ? '1' : '0') } catch { /* private mode */ }
}

function recall(key: string): boolean | null {
  try {
    const v = localStorage.getItem(`g2:card:${key}`)
    return v === null ? null : v === '1'
  } catch { return null }
}

/**
 * Vertical order of the sections inside a tab host.
 *
 * A host (.g2p) is a flex column, so `order` decides the stacking — NOT the
 * sequence the panels were mounted in. That distinction matters: main.ts must
 * mount review.ts before it awaits the Even Hub bridge (so the panel still
 * exists when there are no glasses to talk to) but must mount sessions.ts
 * after, because the record buttons need the STT socket. Mount order and read
 * order are therefore not the same thing, and this is the read order.
 *
 * Gaps of 10 so a section can be slipped in between without renumbering.
 */
export const PANEL_ORDER = {
  /** Pair picker + live lines (translate.ts), on the Translate tab. */
  translate: 5,
  /** Recording + Saved conversations (sessions.ts). */
  sessions: 10,
  /** Review (review.ts). */
  review: 20,
  /**
   * Notes (notes.ts).
   *
   * Between Review and the prompt library: notes are a thing you READ
   * and fix, like a saved conversation, rather than configuration that
   * shapes a future recording.
   */
  notes: 25,
  /** Suggestion prompts (prompts.ts). */
  prompts: 30,
  /**
   * Tuning sliders (settings.ts). LAST on whatever tab they appear on.
   *
   * settings.ts can now be mounted more than once - the whole set on Live,
   * and a single-slider subset on Translate - so it needs an order value of
   * its own rather than relying on being mounted first.
   */
  tuning: 40,
} as const

/**
 * Build a card. Collapsible cards are the unit of organisation on the phone:
 * a panel is a stack of them, and only the one being used is open.
 */
export function makeCard(o: CardOptions): CardHandle {
  installTheme()

  const root = document.createElement('section')
  root.className = 'card'

  const collapsible = o.collapsible === true
  const head = document.createElement(collapsible ? 'button' : 'div')
  head.className = 'card-h'
  if (collapsible) (head as HTMLButtonElement).type = 'button'

  head.innerHTML =
    (o.icon ? `<span class="lead">${icon(o.icon)}</span>` : '') +
    '<span class="txt"><span class="ttl"></span><span class="sub"></span></span>' +
    '<span class="aside"></span>' +
    (collapsible ? `<span class="chev">${icon('chevron')}</span>` : '')

  const ttl = head.querySelector('.ttl') as HTMLElement
  const sub = head.querySelector('.sub') as HTMLElement
  const aside = head.querySelector('.aside') as HTMLElement

  // textContent, not innerHTML: titles can carry user text.
  ttl.textContent = o.title
  sub.textContent = o.sub ?? ''

  const body = document.createElement('div')
  body.className = 'card-b'

  root.appendChild(head)
  root.appendChild(body)

  const stored = o.memory ? recall(o.memory) : null
  let open = collapsible ? (stored ?? o.open ?? false) : true

  const apply = () => {
    if (!collapsible) return
    root.classList.toggle('open', open)
    root.classList.toggle('collapsed', !open)
    head.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  apply()

  if (collapsible) {
    head.addEventListener('click', () => {
      open = !open
      apply()
      if (o.memory) remember(o.memory, open)
      o.onToggle?.(open)
    })
  }

  return {
    root,
    body,
    aside,
    setSub: (text: string) => { sub.textContent = text },
    setOpen: (v: boolean) => {
      open = v
      apply()
      if (o.memory) remember(o.memory, v)
      o.onToggle?.(v)
    },
    isOpen: () => open,
  }
}