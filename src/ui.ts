/**
 * Live panel: what the lens is showing right now.
 *
 * PUBLIC SURFACE IS UNCHANGED — mountUi(), setStatus(kind, text) and
 * setTranscript(final, interim) keep their names and signatures, so main.ts
 * needs no edits.
 *
 * WHAT CHANGED
 *  - The global page styling that used to live here moved to theme.ts. This
 *    file now styles only the transcript surface itself.
 *  - #app is no longer a full-height flex panel floating above the tab bar.
 *    tabs.ts moves it into the Live host; here it is filled with one card that
 *    sits in the normal card stack alongside the tuning sections.
 *  - The status chip is mirrored into the top bar via setShellStatus(), so the
 *    connection state is visible from the Conversations and Review tabs too.
 *  - The transcript auto-scrolls to the newest line, but only when it was
 *    already at the bottom — scrolling back to re-read something is not yanked
 *    away by the next utterance.
 *
 * #app is still overwritten wholesale with innerHTML, so nothing may be mounted
 * inside it.
 */
import { installTheme, icon } from './theme'
import { setShellStatus } from './tabs'

type Status = 'connecting' | 'listening' | 'paused' | 'error'

const CSS = `
.g2-live .chiprow { display: flex; align-items: center; gap: 8px; }
.g2-live .tx {
  margin-top: 12px; padding: 16px; min-height: 168px; max-height: 48vh;
  overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: var(--sunken); border: 1px solid var(--line-soft);
  border-radius: var(--r2);
  font-size: 17px; line-height: 1.55;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.g2-live .tx .interim { color: var(--text-3); }
/* Placeholder shown until the first word lands; the .has class is set by
   setTranscript() so an empty box never looks like a broken one. */
.g2-live .tx .ph { color: var(--text-3); font-size: 14px; }
.g2-live .tx.has .ph { display: none; }
.g2-live .hint {
  display: flex; align-items: center; gap: 8px; margin-top: 12px;
  font-size: 12px; color: var(--text-3);
}
.g2-live .hint svg { width: 14px; height: 14px; flex: 0 0 auto; }
`

/** How close to the bottom still counts as "following the live text". */
const STICK_PX = 40

let statusEl: HTMLSpanElement | null = null
let finalEl: HTMLSpanElement | null = null
let interimEl: HTMLSpanElement | null = null
let boxEl: HTMLDivElement | null = null

export function mountUi() {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const app = document.querySelector<HTMLDivElement>('#app')!
  app.innerHTML = `
    <section class="card g2-live">
      <div class="card-h">
        <span class="lead">${icon('waves')}</span>
        <span class="txt">
          <span class="ttl">Live captions</span>
          <span class="sub">Mirrored from the lens</span>
        </span>
        <span class="aside"><span id="status" class="chip mute">Connecting</span></span>
      </div>
      <div class="card-b">
        <div id="tx" class="tx" aria-live="polite">
          <span class="ph">Waiting for speech…</span><span id="final"></span><span
            id="interim" class="interim"></span>
        </div>
        <div class="hint">
          ${icon('mic')}
          <span>Tap the glasses temple to pause · double-tap to exit.</span>
        </div>
      </div>
    </section>
  `

  statusEl = app.querySelector<HTMLSpanElement>('#status')
  finalEl = app.querySelector<HTMLSpanElement>('#final')
  interimEl = app.querySelector<HTMLSpanElement>('#interim')
  boxEl = app.querySelector<HTMLDivElement>('#tx')
}

/** chip class + top-bar mirror for each state. */
const LOOK: Record<Status, { chip: string; shell: 'ok' | 'bad' | 'idle' }> = {
  connecting: { chip: 'chip mute', shell: 'idle' },
  listening: { chip: 'chip ok pulse', shell: 'ok' },
  paused: { chip: 'chip warn', shell: 'idle' },
  error: { chip: 'chip bad', shell: 'bad' },
}

export function setStatus(kind: Status, text: string) {
  const look = LOOK[kind]
  if (statusEl) {
    statusEl.className = look.chip
    statusEl.textContent = text
  }
  // Mirrored so the state is legible from any tab.
  setShellStatus(look.shell, text)
}

export function setTranscript(finalText: string, interimText: string) {
  if (!finalEl || !interimEl || !boxEl) return

  const stick =
    boxEl.scrollHeight - boxEl.scrollTop - boxEl.clientHeight < STICK_PX

  finalEl.textContent = finalText
  interimEl.textContent = interimText
  boxEl.classList.toggle('has', Boolean(finalText || interimText))

  if (stick) boxEl.scrollTop = boxEl.scrollHeight
}