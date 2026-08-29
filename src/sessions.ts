/**
 * Phone-side conversate panel: start/stop recording, and browse the transcripts
 * and summaries the gateway has stored.
 *
 * The lens is a terrible place to read a 40-minute transcript, so the glasses
 * get start/stop plus live captions and the phone gets everything else.
 *
 * PUBLIC SURFACE IS UNCHANGED — mountSessions(controls, host), setLiveSession(s)
 * and refreshSessions() keep their names and signatures, so main.ts needs no
 * edits.
 *
 * WHAT CHANGED IN THIS PASS
 *  - Two cards instead of one undifferentiated block: the recording control is
 *    the hero, the archive is below it.
 *  - The record button is full width. It is the thing you press while walking.
 *  - Optional title field. controls.start already takes `title?: string`
 *    (SttHandle.startSession(title?) in asr/stt.ts sends session_start with
 *    {title}); nothing new is invented here, the field just supplies it. It is
 *    disabled while recording because the title is read at session start.
 *  - Delete arms on the first tap and fires on the second, matching prompts.ts,
 *    instead of relying on window.confirm — which in the Even Hub WebView is a
 *    modal you cannot style and sometimes cannot dismiss cleanly.
 *  - Summarise failures land inline instead of in an alert().
 *
 * WHAT CHANGED IN THE SECTIONS PASS
 *  - Both cards are collapsible with remembered state. Recording, Saved
 *    conversations, Review and Suggestion prompts are now four peer sections
 *    of ONE tab, so any of them being permanently expanded would bury the
 *    others below the fold.
 *  - Recording starts OPEN on a fresh install: it is the only section with a
 *    button you press mid-conversation, and a section you must unfold first is
 *    a section you cannot press while walking.
 *  - Saved conversations wears `archive`, not `chat` — `chat` is the icon on
 *    the Conversations tab itself, and a section repeating its parent's icon
 *    reads as a duplicate rather than a child.
 *  - The panel root carries PANEL_ORDER.sessions so it stacks above Review and
 *    Prompts regardless of mount order.
 *
 * Endpoints used, all as defined in routes_sessions.py:
 *   GET    /sessions               -> { sessions: [...] }
 *   GET    /sessions/{id}/text     -> { text, summary }
 *   POST   /sessions/{id}/summarize
 *   DELETE /sessions/{id}
 */
import type { SessionState } from './asr/stt'
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'
import { mountSetupSummary } from './setup'

interface StoredSession {
  id: string
  title: string
  started: number | null
  ended: number | null
  utterances: number
  has_summary: boolean
}

interface Controls {
  start: (title?: string) => void
  stop: () => void
}

const CSS = `
.g2c .liveline {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-radius: var(--r2);
  background: var(--sunken); border: 1px solid var(--line-soft);
  font-size: 13px; color: var(--text-2);
}
.g2c .liveline.rec { border-color: rgba(255,69,58,.45); background: rgba(255,69,58,.07);
                     color: var(--text); }
.g2c .liveline .dot {
  width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; background: var(--text-3);
}
.g2c .liveline.rec .dot { background: var(--danger); animation: g2pulse 1.4s ease-in-out infinite; }
.g2c .liveline .txt { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }

.g2c .body {
  margin: 10px 0 0; padding: 12px; border-radius: var(--r1);
  background: var(--sunken); border: 1px solid var(--line-soft);
  white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 42vh; overflow: auto; -webkit-overflow-scrolling: touch;
  font-size: 13px; line-height: 1.5; color: var(--text-2);
}
.g2c .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2c .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
`

let controls: Controls | null = null
let listEl: HTMLElement | null = null
let liveEl: HTMLElement | null = null
let liveTxt: HTMLElement | null = null
let liveChip: HTMLElement | null = null
let recBtn: HTMLButtonElement | null = null
let titleEl: HTMLInputElement | null = null
let countChip: HTMLElement | null = null
let live: SessionState = { active: false, id: null, utterances: 0 }

function when(ts: number | null): string {
  // The gateway stores seconds (time.time()); JS wants milliseconds.
  return ts ? new Date(ts * 1000).toLocaleString() : ''
}

let setupView: ReturnType<typeof mountSetupSummary> | null = null

export function mountSessions(c: Controls, host?: HTMLElement) {
  controls = c
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2c'
  // The host is a flex column; `order` is what fixes the reading order.
  root.style.order = String(PANEL_ORDER.sessions)
  ;(host ?? document.body).appendChild(root)

  // --- recording -----------------------------------------------------------
  const rec = makeCard({
    title: 'Recording',
    sub: 'Captured and summarised on the gateway',
    icon: 'record',
    collapsible: true,
    // Open on a fresh install. `memory` overrides this once the user has
    // folded it themselves, so the preference sticks either way.
    open: true,
    memory: 'rec',
  })
  liveChip = document.createElement('span')
  liveChip.className = 'chip mute'
  liveChip.textContent = 'Idle'
  rec.aside.appendChild(liveChip)

  rec.body.innerHTML = `
    <div class="liveline"><span class="dot"></span><span class="txt">Not recording</span></div>
    <div class="lbl">Title <span style="text-transform:none;letter-spacing:0;color:var(--text-3)">(optional)</span></div>
    <input class="inp title" type="text" maxlength="80" placeholder="e.g. Standup with Dana">
    <div class="lbl" style="margin-top:12px">This recording will use</div>
    <div class="setup"></div>
    <div class="btnrow" style="margin-top:12px">
      <button class="btn primary wide rec-toggle" type="button">${icon('record')}<span>Start recording</span></button>
    </div>`
  root.appendChild(rec.root)

  liveEl = rec.body.querySelector<HTMLElement>('.liveline')
  liveTxt = rec.body.querySelector<HTMLElement>('.liveline .txt')
  recBtn = rec.body.querySelector<HTMLButtonElement>('.rec-toggle')
  titleEl = rec.body.querySelector<HTMLInputElement>('.title')

  // Resolved server-side state, painted next to the button that commits
  // to it. Mounted here rather than in main.ts because it belongs to this
  // card and has no meaning outside it.
  const setupEl = rec.body.querySelector<HTMLElement>('.setup')
  if (setupEl) setupView = mountSetupSummary(setupEl)

  recBtn?.addEventListener('click', () => {
    if (live.active) {
      controls?.stop()
    } else {
      const t = titleEl?.value.trim()
      controls?.start(t ? t : undefined)
      if (titleEl) titleEl.value = ''
    }
  })

  // --- archive -------------------------------------------------------------
  const arch = makeCard({
    title: 'Saved conversations',
    sub: 'Survives app restarts',
    icon: 'archive',
    collapsible: true,
    open: false,
    memory: 'saved',
  })
  countChip = document.createElement('span')
  countChip.className = 'chip mute'
  countChip.textContent = '—'
  arch.aside.appendChild(countChip)

  arch.body.innerHTML = `
    <div class="btnrow" style="margin-bottom:12px">
      <button class="btn sm refresh" type="button">${icon('refresh')}<span>Refresh</span></button>
      <span class="state"></span>
    </div>
    <div class="list"><div class="empty">Loading…</div></div>`
  root.appendChild(arch.root)

  listEl = arch.body.querySelector<HTMLElement>('.list')
  const stateEl = arch.body.querySelector('.state') as HTMLElement

  arch.body.querySelector('.refresh')?.addEventListener('click', () => {
    stateEl.textContent = 'refreshing…'
    stateEl.className = 'state'
    void refreshSessions().then(() => { stateEl.textContent = '' })
  })

  void refreshSessions()
}

/** Called from main.ts whenever the gateway reports session state. */
export function setLiveSession(s: SessionState) {
  const wasActive = live.active
  live = s

  // The prep note is captured by the gateway at session_start, so the
  // setup block switches from "captured when recording starts" to
  // "locked for this recording" at exactly this moment.
  setupView?.setRecording(s.active)

  if (liveEl && liveTxt) {
    liveTxt.textContent = s.active
      ? `Recording ${s.id} · ${s.utterances} line${s.utterances === 1 ? '' : 's'}`
      : s.summarizing
        ? `Saved ${s.id} · summarising…`
        : 'Not recording'
    liveEl.className = s.active ? 'liveline rec' : 'liveline'
  }

  if (liveChip) {
    liveChip.textContent = s.active ? 'Rec' : s.summarizing ? 'Saving' : 'Idle'
    liveChip.className = s.active
      ? 'chip bad pulse'
      : s.summarizing
        ? 'chip warn'
        : 'chip mute'
  }

  if (recBtn) {
    recBtn.className = s.active ? 'btn danger wide rec-toggle' : 'btn primary wide rec-toggle'
    recBtn.innerHTML = s.active
      ? `${icon('stop')}<span>Stop &amp; save</span>`
      : `${icon('record')}<span>Start recording</span>`
  }

  if (titleEl) titleEl.disabled = s.active

  // A finished recording becomes a row in the list below; pull it in without
  // making the user hunt for Refresh. Fires ONLY on the active -> inactive
  // edge, so repeated state frames do not hammer /sessions.
  if (wasActive && !s.active) void refreshSessions()
}

export async function refreshSessions() {
  if (!listEl) return
  try {
    const r = await fetch(restUrl('/sessions'))
    if (!r.ok) throw new Error(`${r.status}`)
    render((await r.json()).sessions as StoredSession[])
  } catch (e) {
    if (countChip) {
      countChip.textContent = 'Offline'
      countChip.className = 'chip bad'
    }
    listEl.innerHTML = `<div class="empty"><span class="err msg"></span><br>
      <span class="mono url"></span></div>`
    ;(listEl.querySelector('.msg') as HTMLElement).textContent =
      `Could not reach gateway: ${(e as Error).message}`
    ;(listEl.querySelector('.url') as HTMLElement).textContent = `${restBase()}/sessions`
  }
}

function render(items: StoredSession[]) {
  if (!listEl) return

  if (countChip) {
    countChip.textContent = String(items.length)
    countChip.className = 'chip mute'
  }

  if (!items.length) {
    listEl.innerHTML = '<div class="empty">Nothing recorded yet.</div>'
    return
  }
  listEl.innerHTML = ''

  for (const s of items) {
    const row = document.createElement('div')
    row.className = 'tile'
    row.innerHTML = `
      <span class="ttl"></span>
      <span class="meta"></span>
      <div class="tags">
        <span class="chip mute lines"></span>
        ${s.has_summary ? '<span class="chip info">Summarised</span>' : ''}
      </div>
      <div class="body" hidden></div>
      <div class="btns">
        <button class="btn sm open" type="button">${icon('doc')}<span>Open</span></button>
        <button class="btn sm sum" type="button">${icon('spark')}<span>${
          s.has_summary ? 'Re-summarise' : 'Summarise'
        }</span></button>
        <button class="btn sm danger del" type="button">${icon('trash')}<span>Delete</span></button>
      </div>`

    // textContent, not innerHTML: a title is whatever Whisper heard, and a
    // transcript is untrusted text.
    ;(row.querySelector('.ttl') as HTMLElement).textContent = s.title || s.id
    ;(row.querySelector('.meta') as HTMLElement).textContent = when(s.started)
    ;(row.querySelector('.lines') as HTMLElement).textContent =
      `${s.utterances} line${s.utterances === 1 ? '' : 's'}`

    const body = row.querySelector('.body') as HTMLElement
    const openBtn = row.querySelector('.open') as HTMLButtonElement

    openBtn.onclick = async () => {
      if (!body.hidden) {
        body.hidden = true
        openBtn.innerHTML = `${icon('doc')}<span>Open</span>`
        return
      }
      body.textContent = 'loading…'
      body.hidden = false
      openBtn.innerHTML = `${icon('check')}<span>Close</span>`
      try {
        const r = await fetch(restUrl(`/sessions/${s.id}/text`))
        if (!r.ok) throw new Error(`${r.status}`)
        const d = await r.json()
        body.textContent = d.summary
          ? `SUMMARY\n${d.summary}\n\nTRANSCRIPT\n${d.text}`
          : d.text || '(empty)'
      } catch (e) {
        body.textContent = `failed: ${(e as Error).message}`
      }
    }

    const sumBtn = row.querySelector('.sum') as HTMLButtonElement
    sumBtn.onclick = async () => {
      const was = sumBtn.innerHTML
      sumBtn.disabled = true
      sumBtn.innerHTML = `${icon('spark')}<span>summarising…</span>`
      try {
        // A local model on a long transcript can legitimately take a minute.
        // No timeout is set on purpose.
        const r = await fetch(restUrl(`/sessions/${s.id}/summarize`), { method: 'POST' })
        if (!r.ok) throw new Error(`${r.status}`)
        await refreshSessions()
      } catch (e) {
        sumBtn.disabled = false
        sumBtn.innerHTML = was
        body.hidden = false
        body.textContent = `summary failed: ${(e as Error).message}`
      }
    }

    // Two taps, because there is no undo.
    const delBtn = row.querySelector('.del') as HTMLButtonElement
    delBtn.onclick = async () => {
      if (delBtn.dataset.armed !== '1') {
        delBtn.dataset.armed = '1'
        delBtn.classList.add('armed')
        delBtn.innerHTML = `${icon('trash')}<span>Tap again</span>`
        window.setTimeout(() => {
          if (delBtn.dataset.armed !== '1') return
          delBtn.dataset.armed = ''
          delBtn.classList.remove('armed')
          delBtn.innerHTML = `${icon('trash')}<span>Delete</span>`
        }, 4000)
        return
      }
      try {
        const r = await fetch(restUrl(`/sessions/${s.id}`), { method: 'DELETE' })
        if (!r.ok) throw new Error(`${r.status}`)
        await refreshSessions()
      } catch (e) {
        delBtn.dataset.armed = ''
        delBtn.classList.remove('armed')
        delBtn.innerHTML = `${icon('trash')}<span>Delete</span>`
        body.hidden = false
        body.textContent = `delete failed: ${(e as Error).message}`
      }
    }

    listEl.appendChild(row)
  }
}