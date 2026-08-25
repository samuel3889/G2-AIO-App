/**
 * App shell for the phone: a fixed top bar, one scrolling content area, and a
 * bottom tab bar within thumb reach.
 *
 * PUBLIC SURFACE IS UNCHANGED. mountTabs(names) still returns name -> host and
 * TAB_SHOW / TAB_HIDE are still dispatched on the hosts, so main.ts and
 * review.ts need no edits.
 *
 * WHAT CHANGED, AND WHY
 *  - The bar used to be `position: sticky` inside normal document flow, sitting
 *    BELOW #app. #app is written by ui.ts and used to be a full-height panel, so
 *    the tab bar started a screen down and never actually stuck. Now the shell
 *    owns the layout: appbar / scroll / nav are the only children of <body>, the
 *    scroll area is the only thing that scrolls, and the nav is always visible.
 *  - #app is MOVED into the first tab's host here (see relocateApp). ui.ts still
 *    finds it with querySelector('#app') and still overwrites it wholesale, so
 *    nothing may be mounted inside it — that rule is unchanged. Doing the move
 *    here rather than in ui.ts matters because main.ts calls mountSettings()
 *    BEFORE mountUi(); moving it at mountTabs() time is what keeps the live
 *    captions above the tuning sliders instead of below them.
 *  - Scroll position is remembered per tab, so switching to Review and back does
 *    not dump you at the top of a long conversation list.
 *  - The nav hides while an <input> or <textarea> has focus. The Android
 *    keyboard resizes the WebView, which would otherwise park the bar directly
 *    on top of the prompt editor.
 *
 * Panels are still mounted into these hosts ONCE, at startup, and only
 * shown/hidden afterwards: mountSessions() registers callbacks that
 * setLiveSession() drives, so remounting would leave those writing into
 * detached DOM.
 */
import { installTheme, icon } from './theme'

export const TAB_SHOW = 'g2:tabshow'
export const TAB_HIDE = 'g2:tabhide'

/**
 * Tab name -> icon. A name with no entry falls back to a dot, so adding a
 * fourth tab in main.ts works without touching this file.
 */
const TAB_ICONS: Record<string, string> = {
  Live: 'waves',
  Conversations: 'chat',
  Review: 'headset',
  Settings: 'sliders',
  Prompts: 'doc',
}

const hosts: Record<string, HTMLElement> = {}
const buttons: Record<string, HTMLButtonElement> = {}
const scrollTops: Record<string, number> = {}

let scrollEl: HTMLElement | null = null
let crumbEl: HTMLElement | null = null
let dotEl: HTMLElement | null = null
let connEl: HTMLElement | null = null
let active = ''
let order: string[] = []

/** The host a panel was mounted into, for anything that needs it later. */
export function getTabHost(name: string): HTMLElement | undefined {
  return hosts[name]
}

/** Programmatic tab switch. */
export function showTab(name: string): void {
  if (name === active || !hosts[name]) return

  if (active) {
    if (scrollEl) scrollTops[active] = scrollEl.scrollTop
    hosts[active].hidden = true
    hosts[active].dispatchEvent(new CustomEvent(TAB_HIDE))
  }

  active = name
  hosts[name].hidden = false
  for (const n of order) buttons[n].classList.toggle('on', n === name)
  if (crumbEl) crumbEl.textContent = name
  if (scrollEl) scrollEl.scrollTop = scrollTops[name] ?? 0

  try { localStorage.setItem('g2:tab', name) } catch { /* private mode */ }
  hosts[name].dispatchEvent(new CustomEvent(TAB_SHOW))
}

/**
 * Connection state for the top bar, called from ui.ts's setStatus() so the
 * indicator is visible from every tab — not just Live.
 */
export function setShellStatus(kind: 'ok' | 'bad' | 'idle', label: string): void {
  if (dotEl) dotEl.className = `g2-dot${kind === 'idle' ? '' : ` ${kind}`}`
  if (connEl) {
    connEl.textContent = label
    connEl.className = `g2-conn${kind === 'idle' ? '' : ` ${kind}`}`
  }
}

/**
 * Move the pre-existing #app element (from index.html) into a tab host.
 * Called before any panel mounts, so #app ends up first in the host.
 */
function relocateApp(host: HTMLElement): void {
  const app = document.getElementById('app')
  if (app && app.parentElement !== host) host.appendChild(app)
}

/**
 * Build the shell and return name -> host element.
 * The first name is the tab shown at startup unless a previous tab was stored.
 */
export function mountTabs(names: string[]): Record<string, HTMLElement> {
  installTheme()
  order = names.slice()

  // --- top bar ------------------------------------------------------------
  const bar = document.createElement('header')
  bar.className = 'g2-appbar'
  bar.innerHTML =
    '<span class="g2-dot"></span>' +
    '<span class="g2-brand">G2</span>' +
    '<span class="g2-sep">/</span>' +
    '<span class="g2-crumb"></span>' +
    '<span class="spacer"></span>' +
    '<span class="g2-conn">starting…</span>'
  document.body.appendChild(bar)

  dotEl = bar.querySelector<HTMLElement>('.g2-dot')
  crumbEl = bar.querySelector<HTMLElement>('.g2-crumb')
  connEl = bar.querySelector<HTMLElement>('.g2-conn')

  // --- scrolling content --------------------------------------------------
  const scroll = document.createElement('main')
  scroll.className = 'g2-scroll'
  document.body.appendChild(scroll)
  scrollEl = scroll

  // --- bottom nav ---------------------------------------------------------
  const nav = document.createElement('nav')
  nav.className = 'g2-nav'
  document.body.appendChild(nav)

  for (const name of names) {
    const b = document.createElement('button')
    b.type = 'button'
    b.innerHTML = `${icon(TAB_ICONS[name] ?? 'dot')}<span>${name}</span>`
    b.onclick = () => showTab(name)
    nav.appendChild(b)
    buttons[name] = b

    const host = document.createElement('div')
    host.className = 'g2p'
    host.hidden = true
    scroll.appendChild(host)
    hosts[name] = host
  }

  if (names.length) relocateApp(hosts[names[0]])

  // Keyboard-aware nav. Bound once, on document, so panels rendered later are
  // covered without re-binding.
  document.addEventListener('focusin', ev => {
    const t = ev.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
      document.body.classList.add('g2-kbd')
    }
  })
  document.addEventListener('focusout', () => {
    document.body.classList.remove('g2-kbd')
  })

  if (names.length) {
    let start = names[0]
    try {
      const saved = localStorage.getItem('g2:tab')
      if (saved && names.includes(saved)) start = saved
    } catch { /* private mode */ }
    showTab(start)
  }

  return hosts
}