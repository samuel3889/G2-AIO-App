/**
 * Phone-side conversate panel: start/stop recording, and browse the
 * transcripts and summaries the gateway has stored.
 *
 * The lens is a terrible place to read a 40-minute transcript, so the
 * glasses get start/stop plus live captions and the phone gets everything
 * else.
 *
 * Mounts to document.body, matching mountSettings() — NOT to #app, which
 * ui.ts overwrites wholesale with innerHTML.
 *
 * The gateway URL rule and the token live in api.ts. This file used to carry
 * its own verbatim copy of restBase() plus a local url() helper; both were
 * removed in favour of restBase()/restUrl(). api.ts's restUrl() implements
 * the same `?` vs `&` rule the local helper did, so behaviour is unchanged.
 */
import type { SessionState } from './asr/stt'
import { restBase, restUrl } from './api'

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
.g2c { font: 14px/1.4 system-ui, sans-serif; padding: 12px; max-width: 560px;
       margin: 12px auto; background: #111; color: #eee; border-radius: 10px; }
.g2c h3 { margin: 0 0 4px; font-size: 15px; }
.g2c .sub { color: #888; font-size: 12px; margin-bottom: 12px; }
.g2c .live { padding: 8px 10px; border-radius: 8px; background: #1c1c1c;
             margin-bottom: 10px; }
.g2c .live.rec { background: #2a1616; color: #ff6b60; }
.g2c .bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.g2c button { background: #333; color: #eee; border: 0; border-radius: 6px;
              padding: 9px 12px; font-size: 13px; touch-action: manipulation; }
.g2c button:active { background: #444; }
.g2c button:disabled { opacity: .5; }
.g2c button.primary { background: #6cf; color: #062; font-weight: 600; }
.g2c button.rec { background: #ff453a; color: #fff; }
.g2c .row { background: #1a1a1a; border-radius: 8px; padding: 10px;
            margin-bottom: 8px; }
.g2c .ttl { font-weight: 600; display: block; }
.g2c .meta { color: #888; font-size: 12px; }
.g2c .body { white-space: pre-wrap; background: #0d0d0d; border-radius: 6px;
             padding: 8px; margin: 8px 0; max-height: 40vh; overflow: auto;
             font-size: 13px; }
.g2c .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2c .state { font-size: 12px; color: #888; }
.g2c .err { color: #f66; }
`

let controls: Controls | null = null
let listEl: HTMLElement | null = null
let liveEl: HTMLElement | null = null
let recBtn: HTMLButtonElement | null = null
let live: SessionState = { active: false, id: null, utterances: 0 }

function when(ts: number | null): string {
  // The gateway stores seconds (time.time()); JS wants milliseconds.
  return ts ? new Date(ts * 1000).toLocaleString() : ''
}

export function mountSessions(c: Controls, host?: HTMLElement) {
  controls = c

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2c'
  root.innerHTML = `<h3>Conversations</h3>
    <div class="sub">Recorded on the gateway. Survives app restarts.</div>
    <div class="live">Not recording</div>
    <div class="bar">
      <button class="rec-toggle primary">Start recording</button>
      <button class="refresh">Refresh</button>
      <span class="state"></span>
    </div>
    <div class="list">loading…</div>`
  ;(host ?? document.body).appendChild(root)

  liveEl = root.querySelector('.live')
  listEl = root.querySelector('.list')
  recBtn = root.querySelector('.rec-toggle')

  recBtn?.addEventListener('click', () => {
    if (live.active) controls?.stop()
    else controls?.start()
  })
  root.querySelector('.refresh')?.addEventListener('click', () => {
    void refreshSessions()
  })

  void refreshSessions()
}

/** Called from main.ts whenever the gateway reports session state. */
export function setLiveSession(s: SessionState) {
  live = s
  if (liveEl) {
    liveEl.textContent = s.active
      ? `Recording ${s.id} · ${s.utterances} lines`
      : s.summarizing
        ? `Saved ${s.id} · summarising…`
        : 'Not recording'
    liveEl.className = s.active ? 'live rec' : 'live'
  }
  if (recBtn) {
    recBtn.textContent = s.active ? 'Stop & save' : 'Start recording'
    recBtn.className = s.active ? 'rec-toggle rec' : 'rec-toggle primary'
  }
}

export async function refreshSessions() {
  if (!listEl) return
  try {
    const r = await fetch(restUrl('/sessions'))
    if (!r.ok) throw new Error(`${r.status}`)
    render((await r.json()).sessions as StoredSession[])
  } catch (e) {
    listEl.innerHTML = `<div class="err">Could not reach gateway: ${
      (e as Error).message
    }<br>Checked ${restBase()}/sessions</div>`
  }
}

function render(items: StoredSession[]) {
  if (!listEl) return
  if (!items.length) {
    listEl.textContent = 'Nothing recorded yet.'
    return
  }
  listEl.innerHTML = ''

  for (const s of items) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <span class="ttl"></span>
      <span class="meta"></span>
      <div class="body" hidden></div>
      <div class="btns">
        <button class="open">Open</button>
        <button class="sum">${s.has_summary ? 'Re-summarise' : 'Summarise'}</button>
        <button class="del">Delete</button>
      </div>`

    // textContent, not innerHTML: a title is whatever Whisper heard, and a
    // transcript is untrusted text.
    ;(row.querySelector('.ttl') as HTMLElement).textContent = s.title || s.id
    ;(row.querySelector('.meta') as HTMLElement).textContent =
      `${when(s.started)} · ${s.utterances} lines${s.has_summary ? ' · summarised' : ''}`

    const body = row.querySelector('.body') as HTMLElement

    ;(row.querySelector('.open') as HTMLButtonElement).onclick = async () => {
      if (!body.hidden) {
        body.hidden = true
        return
      }
      body.textContent = 'loading…'
      body.hidden = false
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

    ;(row.querySelector('.sum') as HTMLButtonElement).onclick = async ev => {
      const btn = ev.currentTarget as HTMLButtonElement
      btn.disabled = true
      btn.textContent = 'summarising…'
      try {
        // A local model on a long transcript can legitimately take a
        // minute. No timeout is set on purpose.
        const r = await fetch(restUrl(`/sessions/${s.id}/summarize`), { method: 'POST' })
        if (!r.ok) throw new Error(`${r.status}`)
        await refreshSessions()
      } catch (e) {
        btn.disabled = false
        btn.textContent = 'Summarise'
        alert(`summary failed: ${(e as Error).message}`)
      }
    }

    ;(row.querySelector('.del') as HTMLButtonElement).onclick = async () => {
      if (!confirm(`Delete ${s.title || s.id}?`)) return
      try {
        const r = await fetch(restUrl(`/sessions/${s.id}`), { method: 'DELETE' })
        if (!r.ok) throw new Error(`${r.status}`)
        await refreshSessions()
      } catch (e) {
        alert(`delete failed: ${(e as Error).message}`)
      }
    }

    listEl.appendChild(row)
  }
}