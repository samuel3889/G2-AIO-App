/**
 * Phone-side translate panel: pick a language pair, start and stop the mode,
 * and read every line as it arrives.
 *
 * SHAPED AFTER THE STOCK EVEN APP, which is the thing this replaces:
 *   - a pair selector with the two languages either side of a swap control;
 *   - a big Start button;
 *   - while running, the whole exchange as a list with All / A>B / B>A
 *     filters over it.
 *
 * WHAT THE FILTER DOES NOT DO is change the lens. The stock app shows one
 * direction on the glasses no matter which filter is selected, and so does
 * this: the filter is a reading aid for the phone and nothing more. The
 * gateway decides what the lens gets, sends it as `lens` on each frame, and
 * this file only reports that decision. If the filter could change it, the
 * phone and the glasses would be able to disagree about what the wearer is
 * showing the person opposite - which is the one thing that must never
 * happen mid-conversation.
 *
 * DIRECTION, ONCE MORE: `a` is the LEFT language. An utterance detected as
 * `a` is translated into `b` AND appears on the lens. One detected as `b` is
 * translated into `a` for the phone only. Swapping is what reverses that.
 *
 * State ownership: this panel NEVER sets its own active flag. It sends a
 * command and waits for the gateway's 'translate' frame to come back through
 * setTranslateState(), the same discipline sessions.ts follows with
 * setLiveSession(). A rejected pair therefore cannot leave the phone showing
 * a mode that is not running.
 *
 * The pair itself IS remembered locally, in localStorage, because it is a
 * preference rather than state: the gateway forgets it on every reconnect by
 * design, and being made to re-pick Spanish every time the socket blips
 * would be miserable.
 *
 * Endpoint used, as defined in routes_translate.py:
 *   GET /translate/languages -> { provider, languages: [{code,name,native}] }
 */
import type { TranslateState, TranslationLine } from './asr/stt'
import { restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'

interface Controls {
  start: (a: string, b: string) => void
  stop: () => void
}

interface Lang {
  code: string
  name: string
  native: string
}

/**
 * Fallback list, used only if GET /translate/languages fails.
 *
 * These four are the launch set and they are hardcoded on the gateway too
 * (translate.py's SUPPORTED). Duplicated deliberately: a phone that cannot
 * reach the endpoint should still offer the common pairs rather than an
 * empty dropdown, and the gateway validates every pair anyway - so a stale
 * copy here can only produce a rejection, never a wrong translation.
 */
const FALLBACK: Lang[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
]

/** How many lines the phone keeps. Older ones fall off the top. */
const MAX_LINES = 200

const CSS = `
.g2t .pair {
  display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
}
.g2t .pair select {
  flex: 1 1 0; min-width: 0; appearance: none;
  background: var(--sunken); color: var(--text);
  border: 1px solid var(--line); border-radius: 11px;
  padding: 12px 10px; font: 650 15px/1.2 var(--font); text-align: center;
}
.g2t .pair select:disabled { opacity: .55; }
.g2t .swap {
  flex: 0 0 auto; width: 44px; height: 44px; padding: 0;
  display: grid; place-items: center;
  background: var(--surface-2); color: var(--text-2);
  border: 1px solid var(--line); border-radius: 11px;
}
.g2t .swap svg { width: 18px; height: 18px; }
.g2t .lensnote {
  margin: 0 0 12px; font-size: 12px; line-height: 1.5; color: var(--text-3);
}
.g2t .lensnote b { color: var(--text-2); font-weight: 650; }

.g2t .filters { display: flex; gap: 6px; margin-bottom: 10px; }
.g2t .filters button {
  flex: 1 1 0; min-height: 38px; padding: 8px 6px;
  background: var(--surface-2); color: var(--text-3);
  border: 1px solid var(--line); border-radius: 10px;
  font: 700 11px/1 var(--font); letter-spacing: .06em; text-transform: uppercase;
}
.g2t .filters button.on { background: var(--text); color: var(--bg); border-color: var(--text); }

.g2t .lines {
  max-height: 52vh; overflow: auto; -webkit-overflow-scrolling: touch;
}
.g2t .line {
  padding: 11px 0; border-bottom: 1px solid var(--line-soft);
}
.g2t .line:last-child { border-bottom: 0; }
.g2t .line .dir {
  font: 700 10px/1 var(--font); letter-spacing: .1em; text-transform: uppercase;
  color: var(--text-3); display: flex; align-items: center; gap: 6px;
}
/* The lens marker is a dot, not a word: it appears on roughly half the lines
   and a label that long would compete with the text it annotates. */
.g2t .line .dir .on-lens {
  width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
}
.g2t .line .src {
  margin-top: 5px; font-size: 14px; color: var(--text-3);
  overflow-wrap: anywhere;
}
.g2t .line .dst {
  margin-top: 3px; font-size: 16px; line-height: 1.45; color: var(--text);
  overflow-wrap: anywhere;
}
.g2t .line.skipped .dst { color: var(--text-3); font-style: italic; }
`

let controls: Controls | null = null
let langs: Lang[] = FALLBACK
let state: TranslateState = { active: false, a: null, b: null, aNative: null, bNative: null }
let lines: TranslationLine[] = []
/** '' = all, otherwise the `from` code to keep. */
let filter = ''

let selA: HTMLSelectElement | null = null
let selB: HTMLSelectElement | null = null
let swapBtn: HTMLButtonElement | null = null
let goBtn: HTMLButtonElement | null = null
let chipEl: HTMLElement | null = null
let noteEl: HTMLElement | null = null
let listEl: HTMLElement | null = null
let filtersEl: HTMLElement | null = null
let errEl: HTMLElement | null = null

function savePair(a: string, b: string): void {
  try { localStorage.setItem('g2:translate:pair', `${a},${b}`) } catch { /* private mode */ }
}

/**
 * The pair the wearer last used, for anything that needs to start a
 * translation WITHOUT going through this panel - the glasses menu, in
 * practice.
 *
 * Reads the live selects when the panel is mounted, so a pair chosen and not
 * yet started still counts as "most recent", and falls back to the stored
 * one otherwise. The stored value is written on every change and on every
 * confirmed start, so there is always something sensible to return.
 */
export function lastPair(): { a: string; b: string } {
  if (selA && selB && selA.value && selB.value && selA.value !== selB.value) {
    return { a: selA.value, b: selB.value }
  }
  const [a, b] = loadPair()
  return { a, b }
}

function loadPair(): [string, string] {
  try {
    const v = localStorage.getItem('g2:translate:pair')
    if (v) {
      const [a, b] = v.split(',')
      if (a && b && a !== b) return [a, b]
    }
  } catch { /* private mode */ }
  return ['en', 'es']
}

function nativeOf(code: string): string {
  return langs.find(l => l.code === code)?.native ?? code
}

function fillSelect(sel: HTMLSelectElement, chosen: string): void {
  sel.innerHTML = langs
    .map(l => `<option value="${l.code}">${l.native}</option>`)
    .join('')
  sel.value = langs.some(l => l.code === chosen) ? chosen : langs[0].code
}

/**
 * The one-line explanation of what the lens will show, in plain language.
 *
 * Worth the space: "EN > ES" tells you the pair but not which half of the
 * conversation ends up in front of your eye, and that is the single thing
 * about this feature that is not self-evident from the controls.
 */
function renderNote(): void {
  if (!noteEl) return
  const a = selA?.value ?? 'en'
  const b = selB?.value ?? 'es'
  noteEl.innerHTML =
    `On the glasses you'll see <b>${nativeOf(a)}</b> speech translated into ` +
    `<b>${nativeOf(b)}</b>. The other direction is translated too, but only ` +
    `shows here on the phone.`
}

function renderFilters(): void {
  if (!filtersEl) return
  const a = state.a ?? selA?.value ?? 'en'
  const b = state.b ?? selB?.value ?? 'es'
  const opts: [string, string][] = [
    ['', 'All'],
    [a, `${a.toUpperCase()} › ${b.toUpperCase()}`],
    [b, `${b.toUpperCase()} › ${a.toUpperCase()}`],
  ]
  filtersEl.innerHTML = opts
    .map(([v, label]) =>
      `<button type="button" data-f="${v}" class="${filter === v ? 'on' : ''}">${label}</button>`)
    .join('')
  for (const btn of Array.from(filtersEl.querySelectorAll('button'))) {
    btn.addEventListener('click', () => {
      filter = (btn as HTMLElement).dataset.f ?? ''
      renderFilters()
      renderLines()
    })
  }
}

function renderLines(): void {
  if (!listEl) return

  const shown = filter ? lines.filter(l => l.from === filter) : lines
  if (!shown.length) {
    listEl.innerHTML = `<div class="empty">${
      state.active ? 'Listening…' : 'Nothing translated yet'
    }</div>`
    return
  }

  // Newest LAST, matching the stock app and the way a transcript reads.
  listEl.innerHTML = shown
    .map(l => {
      if (!l.translated) {
        return `<div class="line skipped">
          <div class="dir">${(l.detected ?? '??').toUpperCase()} · not in pair</div>
          <div class="src"></div>
          <div class="dst">Heard, but not translated</div>
        </div>`
      }
      return `<div class="line">
        <div class="dir">${l.from.toUpperCase()} › ${l.to.toUpperCase()}${
          l.lens ? '<span class="on-lens"></span>' : ''
        }</div>
        <div class="src"></div>
        <div class="dst"></div>
      </div>`
    })
    .join('')

  // Text is written with textContent AFTER the markup is in place, never
  // interpolated into the HTML above: every one of these strings is speech
  // off a microphone by way of two web services, and an apostrophe or an
  // angle bracket in it must not be able to reach innerHTML.
  const rows = Array.from(listEl.querySelectorAll('.line'))
  shown.forEach((l, i) => {
    const row = rows[i]
    if (!row) return
    const src = row.querySelector('.src')
    const dst = row.querySelector('.dst')
    if (src) src.textContent = l.sourceText
    if (dst && l.translated) dst.textContent = l.text
  })

  listEl.scrollTop = listEl.scrollHeight
}

function renderControls(): void {
  const running = state.active

  if (selA) selA.disabled = running
  if (selB) selB.disabled = running
  if (swapBtn) swapBtn.disabled = running

  if (goBtn) {
    goBtn.className = running
      ? 'btn danger wide go'
      : 'btn primary wide go'
    goBtn.innerHTML = running
      ? `${icon('stop')}<span>End translation</span>`
      : `${icon('waves')}<span>Start</span>`
  }

  if (chipEl) {
    chipEl.textContent = running
      ? `${(state.a ?? '').toUpperCase()} › ${(state.b ?? '').toUpperCase()}`
      : 'Idle'
    chipEl.className = running ? 'chip ok pulse' : 'chip mute'
  }
}

export function mountTranslate(c: Controls, host?: HTMLElement): void {
  controls = c
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2t'
  // The host is a flex column; `order` fixes the reading order, so the
  // tuning slider mounted into this same tab lands below rather than above.
  root.style.order = String(PANEL_ORDER.translate)
  ;(host ?? document.body).appendChild(root)

  // --- pair + start --------------------------------------------------------
  const setup = makeCard({
    title: 'Translate',
    sub: 'Live two-way, one direction on the lens',
    icon: 'waves',
    collapsible: true,
    open: true,
    memory: 'tr-setup',
  })
  chipEl = document.createElement('span')
  chipEl.className = 'chip mute'
  chipEl.textContent = 'Idle'
  setup.aside.appendChild(chipEl)

  setup.body.innerHTML = `
    <div class="pair">
      <select class="sel-a" aria-label="Language shown on the glasses"></select>
      <button class="swap" type="button" aria-label="Swap languages">${icon('reset')}</button>
      <select class="sel-b" aria-label="Language translated into"></select>
    </div>
    <p class="lensnote"></p>
    <div class="btnrow">
      <button class="btn primary wide go" type="button">${icon('waves')}<span>Start</span></button>
    </div>
    <div class="err" style="margin-top:10px;font-size:12px;color:var(--danger)"></div>`
  root.appendChild(setup.root)

  selA = setup.body.querySelector<HTMLSelectElement>('.sel-a')
  selB = setup.body.querySelector<HTMLSelectElement>('.sel-b')
  swapBtn = setup.body.querySelector<HTMLButtonElement>('.swap')
  goBtn = setup.body.querySelector<HTMLButtonElement>('.go')
  noteEl = setup.body.querySelector<HTMLElement>('.lensnote')
  errEl = setup.body.querySelector<HTMLElement>('.err')

  const [pa, pb] = loadPair()
  if (selA) fillSelect(selA, pa)
  if (selB) fillSelect(selB, pb)
  renderNote()

  const onPick = () => {
    // Two selects that can hold the same language would send a pair the
    // gateway rejects. Nudging the OTHER one off the collision is friendlier
    // than an error, and it is what the stock app does.
    if (selA && selB && selA.value === selB.value) {
      const other = langs.find(l => l.code !== selA!.value)
      if (other) selB.value = other.code
    }
    if (selA && selB) savePair(selA.value, selB.value)
    renderNote()
    renderFilters()
  }
  selA?.addEventListener('change', onPick)
  selB?.addEventListener('change', onPick)

  swapBtn?.addEventListener('click', () => {
    if (!selA || !selB) return
    const a = selA.value
    selA.value = selB.value
    selB.value = a
    onPick()
  })

  goBtn?.addEventListener('click', () => {
    if (errEl) errEl.textContent = ''
    if (state.active) {
      controls?.stop()
      return
    }
    if (!selA || !selB) return
    // Cleared on START, not on stop: the lines from the last conversation
    // are worth reading after it ends, and this is the moment they stop
    // being about what is in front of you.
    lines = []
    renderLines()
    controls?.start(selA.value, selB.value)
  })

  // --- lines ---------------------------------------------------------------
  const log = makeCard({
    title: 'Conversation',
    sub: 'Both directions, newest at the bottom',
    icon: 'chat',
    collapsible: true,
    open: true,
    memory: 'tr-log',
  })
  log.body.innerHTML = `
    <div class="filters"></div>
    <div class="lines"><div class="empty">Nothing translated yet</div></div>`
  root.appendChild(log.root)

  filtersEl = log.body.querySelector<HTMLElement>('.filters')
  listEl = log.body.querySelector<HTMLElement>('.lines')
  renderFilters()
  renderControls()

  void loadLanguages()
}

/**
 * Replace the hardcoded list with the gateway's own.
 *
 * Failure is not surfaced: FALLBACK already covers the four languages this
 * was built for, and an error banner about a dropdown that visibly works
 * would be noise.
 */
async function loadLanguages(): Promise<void> {
  try {
    const r = await fetch(restUrl('/translate/languages'))
    if (!r.ok) return
    const body = await r.json()
    if (!Array.isArray(body.languages) || !body.languages.length) return
    langs = body.languages as Lang[]

    const [pa, pb] = loadPair()
    if (selA) fillSelect(selA, pa)
    if (selB) fillSelect(selB, pb)
    renderNote()
    renderFilters()
  } catch {
    /* fallback list stands */
  }
}

/** Called from main.ts on every 'translate' frame. The ONLY writer of `state`. */
export function setTranslateState(s: TranslateState): void {
  state = s

  if (s.error && errEl) errEl.textContent = s.error

  // Re-select from the gateway's answer rather than trusting what was
  // picked. They agree today, but the gateway is the authority on what is
  // running and the controls should show that, not the request.
  if (s.active && s.a && s.b) {
    if (selA) selA.value = s.a
    if (selB) selB.value = s.b
    savePair(s.a, s.b)
    renderNote()
  }

  renderControls()
  renderFilters()
  renderLines()
}

/** Called from main.ts on every 'translation' frame. */
export function pushTranslation(line: TranslationLine): void {
  lines.push(line)
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES)
  renderLines()
}