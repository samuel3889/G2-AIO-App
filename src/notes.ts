/**
 * Phone-side note list: the notes the gateway stores in /data/notes.json.
 *
 * Same shape as prompts.ts — a card in a tab, REST only, no Even Hub SDK
 * calls — and for the same reason: it talks to the gateway over HTTP, so a
 * failed STT socket leaves note editing working.
 *
 * WHY THIS IS NOT AUTOSAVED, unlike the tuning sliders. A note is something
 * you said out loud and expect to still be there; a half-typed title
 * overwriting it because focus moved is a worse failure than an extra tap.
 * Same argument prompts.ts makes about a half-typed prompt reaching the
 * model. Completion and delete ARE immediate, because they are one tap with
 * a visible result and completion is reversible.
 *
 * THE DUE FIELD IS A PLAIN TEXT BOX, deliberately, and this is the one place
 * the panel is less polished than it could be.
 *
 * A note carries EITHER a date ("2026-08-28") or a date and a time
 * ("2026-08-28T14:00:00"), and duedates.py treats the difference as
 * meaningful: a day with no time never grows one it was not given. No single
 * HTML input models that. <input type="date"> would silently drop every time
 * a wearer spoke, and <input type="datetime-local"> would invent 00:00 for
 * every note that only ever had a day. A text box passes the value through
 * unchanged and shows what is actually stored.
 *
 * Clearing it sends {"clear_due": true}, NOT due: null — notestore.update()
 * reads due=null as "leave alone" so that a PUT which omits the field cannot
 * silently strip dates. See routes_notes.py.
 *
 * Endpoints used, all as defined in routes_notes.py:
 *   GET    /notes                  -> { notes }
 *   POST   /notes                  -> create   { text, title?, due? }
 *   PUT    /notes/{id}             -> update   { title?, text?, due?, done?, clear_due? }
 *   POST   /notes/{id}/complete    -> complete { done? }
 *   POST   /notes/clear-done       -> drop every completed note
 *   DELETE /notes/{id}
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon } from './theme'

interface StoredNote {
  id: string
  /** Raw transcript, verbatim. Never overwritten by structuring. */
  text: string
  /** Short form shown on the lens. Falls back to `text` when unstructured. */
  title: string
  /** ISO-8601, or null. Two shapes: "2026-08-28" or "2026-08-28T14:00:00". */
  due: string | null
  done: boolean
  created: number
  updated: number
  /** "voice" or "phone". Diagnostic: says whether Whisper was involved. */
  source: string
}

interface Store {
  notes: StoredNote[]
}

const CSS = `
.g2nt .grp { color: var(--text-3); font-size: 12px; margin: 12px 0 6px; }
.g2nt .grp:first-child { margin-top: 0; }
.g2nt .tile.done .ttl { text-decoration: line-through; color: var(--text-3); }
.g2nt .meta { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.g2nt .raw { color: var(--text-3); font-size: 12px; overflow-wrap: anywhere; }
.g2nt .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2nt .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.g2nt .editbar {
  position: sticky; bottom: 0; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 2px; margin-top: 4px;
  background: linear-gradient(180deg, rgba(35,35,35,0), var(--surface) 30%);
}
`

/**
 * An ISO due value as a person would read it.
 *
 * A SECOND IMPLEMENTATION of duedates.format_due(), and that duplication is
 * deliberate rather than sloppy: the gateway sends the raw ISO on every
 * frame precisely so both surfaces can format it for their own width, and a
 * shared formatter would mean the lens and the phone could not diverge when
 * they should. The lens has 56 characters; this has a card.
 *
 * The two INPUT shapes stay distinct here too: a date-only value never grows
 * a time it did not have.
 */
function formatDue(iso: string | null): string {
  if (!iso) return ''
  const hasTime = iso.includes('T')
  // Parsed as LOCAL time, not UTC. The gateway writes naive local strings
  // with no Z (see duedates.py), and `new Date("2026-08-28T14:00:00")` is
  // already local in every browser. Appending a Z here — or letting a
  // date-only string be parsed, which IS treated as UTC — would shift
  // every note by the timezone offset.
  const d = hasTime
    ? new Date(iso)
    : new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
  const days = Math.round((day.getTime() - today.getTime()) / 86400000)

  let datePart: string
  if (days === 0) datePart = 'today'
  else if (days === 1) datePart = 'tomorrow'
  else if (days === -1) datePart = 'yesterday'
  else if (days > 1 && days < 7)
    datePart = d.toLocaleDateString(undefined, { weekday: 'short' })
  else
    datePart = d.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    })

  if (!hasTime) return datePart
  const time = d
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '')
  return `${datePart} ${time}`
}

/** True when a due date has passed. Date-only counts the whole day. */
function overdue(n: StoredNote): boolean {
  if (!n.due || n.done) return false
  const end = n.due.includes('T') ? new Date(n.due) : new Date(`${n.due}T23:59:59`)
  return !Number.isNaN(end.getTime()) && end.getTime() < Date.now()
}

export async function mountNotes(host?: HTMLElement) {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2nt'
  // No PANEL_ORDER entry: this is the only panel on its tab, so there is
  // nothing to order it against. Give it one if a second card ever lands
  // here rather than picking a number now that nothing reads.
  ;(host ?? document.body).appendChild(root)

  const card = makeCard({
    title: 'Notes',
    sub: 'Captured by voice, stored on the gateway',
    icon: 'doc',
  })
  const chip = document.createElement('span')
  chip.className = 'chip mute'
  chip.textContent = '—'
  card.aside.appendChild(chip)

  card.body.innerHTML = `
    <div class="body"></div>
    <div class="btns">
      <button class="btn sm new" type="button">${icon('plus')}<span>New note</span></button>
      <button class="btn sm ghost refresh" type="button">${icon('refresh')}<span>Refresh</span></button>
      <button class="btn sm ghost clear" type="button">${icon('trash')}<span>Clear completed</span></button>
      <span class="state"></span>
    </div>`
  root.appendChild(card.root)

  const body = card.body.querySelector('.body') as HTMLElement
  const stateEl = card.body.querySelector('.state') as HTMLElement
  const newBtn = card.body.querySelector('.new') as HTMLButtonElement
  const refreshBtn = card.body.querySelector('.refresh') as HTMLButtonElement
  const clearBtn = card.body.querySelector('.clear') as HTMLButtonElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  let store: Store = { notes: [] }
  /** id open in the editor, '' for the list, 'new' for a draft. */
  let editing = ''

  async function call(path: string, init?: RequestInit): Promise<Store> {
    const r = await fetch(restUrl(path), init)
    if (!r.ok) throw new Error(`${r.status}`)
    return (await r.json()) as Store
  }

  const json = (b: unknown, method = 'POST'): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  })

  async function load() {
    store = await call('/notes')
  }

  function paintChip() {
    const open = store.notes.filter(n => !n.done).length
    const late = store.notes.filter(overdue).length
    chip.textContent = open === 0 ? 'None' : `${open} open`
    chip.className = late > 0 ? 'chip bad' : open > 0 ? 'chip info' : 'chip mute'
    if (late > 0) chip.textContent = `${open} open · ${late} due`
  }

  // ------------------------------------------------------------- editor

  function renderEditor(n: StoredNote | null) {
    const isNew = n === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="inp t" type="text" maxlength="120" placeholder="e.g. Call Sarah about the proposal">
      <div class="lbl">Due</div>
      <input class="inp d" type="text" placeholder="2026-08-28 or 2026-08-28T14:00 — blank for none">
      <div class="raw due-h"></div>
      ${isNew ? '' : '<div class="lbl">What you said</div><textarea class="inp x" rows="3" spellcheck="false"></textarea>'}
      <div class="editbar">
        <button class="btn primary save" type="button">${icon('check')}<span>Save</span></button>
        <button class="btn ghost cancel" type="button">Cancel</button>
        ${isNew ? '' : `<button class="btn danger del" type="button">${icon('trash')}<span>Delete</span></button>`}
      </div>`

    const t = body.querySelector('.t') as HTMLInputElement
    const d = body.querySelector('.d') as HTMLInputElement
    const x = body.querySelector('.x') as HTMLTextAreaElement | null
    const hint = body.querySelector('.due-h') as HTMLElement

    t.value = n?.title ?? ''
    d.value = n?.due ?? ''
    if (x) x.value = n?.text ?? ''

    // Echoes back how the value will actually read, so a typo in the box is
    // visible before Save rather than after it lands on the lens.
    const paintHint = () => {
      const v = d.value.trim()
      hint.textContent = v ? `reads as “${formatDue(v)}”` : 'no due date'
    }
    d.oninput = paintHint
    paintHint()

    ;(body.querySelector('.cancel') as HTMLButtonElement).onclick = () => {
      editing = ''
      render()
    }

    ;(body.querySelector('.save') as HTMLButtonElement).onclick = async () => {
      const title = t.value.trim()
      const due = d.value.trim()
      if (!title) {
        say('title is empty', true)
        return
      }
      try {
        say('saving…')
        if (isNew) {
          // A note typed here has no transcript, so the title IS the text.
          // Sent as both rather than leaving text empty, because the
          // matcher for "done with the milk one" searches title and text
          // joined and an empty half would make typed notes harder to
          // address by voice than spoken ones.
          store = await call('/notes', json({
            text: title, title, due: due || null, source: 'phone',
          }))
        } else {
          // clear_due, NOT due: null. See the module docstring.
          store = await call(`/notes/${n!.id}`, json({
            title,
            text: x ? x.value : undefined,
            ...(due ? { due } : { clear_due: true }),
          }, 'PUT'))
        }
        editing = ''
        await load()
        render()
        say('saved')
      } catch (e) {
        say(`save failed: ${(e as Error).message}`, true)
      }
    }

    const del = body.querySelector('.del') as HTMLButtonElement | null
    if (del) {
      del.onclick = async () => {
        // Two taps. There is no undo, and unlike completion a delete
        // cannot be walked back from the phone or by voice.
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.classList.add('armed')
          del.innerHTML = `${icon('trash')}<span>Tap again to delete</span>`
          return
        }
        try {
          await call(`/notes/${n!.id}`, { method: 'DELETE' })
          editing = ''
          await load()
          render()
          say('deleted')
        } catch (e) {
          say(`delete failed: ${(e as Error).message}`, true)
        }
      }
    }
  }

  // --------------------------------------------------------------- list

  function tile(n: StoredNote): HTMLElement {
    const row = document.createElement('div')
    row.className = n.done ? 'tile done' : 'tile'

    const late = overdue(n)
    const due = formatDue(n.due)
    row.innerHTML = `
      <span class="ttl"></span>
      <div class="tags"></div>
      <div class="raw"></div>
      <div class="btns">
        <button class="btn sm ${n.done ? 'ghost' : 'primary'} tick" type="button">
          ${icon('check')}<span>${n.done ? 'Reopen' : 'Done'}</span></button>
        <button class="btn sm edit" type="button">${icon('edit')}<span>Edit</span></button>
      </div>`

    // textContent, not innerHTML: a title is user text — and on this panel
    // it is user text that arrived via Whisper, which will happily
    // transcribe someone saying the word "script".
    ;(row.querySelector('.ttl') as HTMLElement).textContent = n.title

    const tags = row.querySelector('.tags') as HTMLElement
    if (due) {
      const c = document.createElement('span')
      c.className = late ? 'chip bad' : 'chip info'
      c.textContent = due
      tags.appendChild(c)
    }
    if (n.source === 'voice') {
      const c = document.createElement('span')
      c.className = 'chip mute'
      c.textContent = 'voice'
      tags.appendChild(c)
    }

    // The raw transcript, shown only when structuring changed it. When the
    // title IS the transcript there is nothing to compare and repeating it
    // is noise.
    const raw = row.querySelector('.raw') as HTMLElement
    if (n.text && n.text !== n.title) raw.textContent = n.text

    ;(row.querySelector('.tick') as HTMLButtonElement).onclick = async () => {
      try {
        // Immediate, no confirmation: one tap, visible result, and the same
        // button undoes it.
        await call(`/notes/${n.id}/complete`, json({ done: !n.done }))
        await load()
        render()
      } catch (e) {
        say(`failed: ${(e as Error).message}`, true)
      }
    }
    ;(row.querySelector('.edit') as HTMLButtonElement).onclick = () => {
      editing = n.id
      render()
    }
    return row
  }

  function renderList() {
    if (!store.notes.length) {
      body.innerHTML = `<div class="empty">No notes yet. Say “remind me to…”
        or “add milk to my list” to the glasses, or use New note below.</div>`
      return
    }

    // Open first, oldest first — the thing you have been putting off longest
    // belongs at the top, the same order NoteStore.open_notes() uses for the
    // lens. Completed notes go underneath, newest first, because that group
    // is a record rather than a queue.
    const open = store.notes.filter(n => !n.done).sort((a, b) => a.created - b.created)
    const done = store.notes.filter(n => n.done).sort((a, b) => b.updated - a.updated)

    body.innerHTML = ''
    for (const n of open) body.appendChild(tile(n))

    if (done.length) {
      const h = document.createElement('div')
      h.className = 'grp'
      h.textContent = `Completed (${done.length})`
      body.appendChild(h)
      for (const n of done) body.appendChild(tile(n))
    }
  }

  function render() {
    paintChip()
    newBtn.disabled = editing !== ''
    clearBtn.disabled = !store.notes.some(n => n.done)
    if (editing === 'new') return renderEditor(null)
    if (editing) {
      const n = store.notes.find(q => q.id === editing)
      if (n) return renderEditor(n)
      // The note went away underneath the editor — deleted by voice while
      // it was open. Fall back to the list rather than to a blank form.
      editing = ''
    }
    renderList()
  }

  newBtn.onclick = () => {
    editing = 'new'
    render()
  }

  refreshBtn.onclick = async () => {
    // Manual, not polled. Notes change when you speak, and a background
    // poll would be a request every few seconds for a list that is usually
    // unchanged — on a phone, over the same link the audio uses.
    try {
      say('loading…')
      await load()
      render()
      say('')
    } catch (e) {
      say(`refresh failed: ${(e as Error).message}`, true)
    }
  }

  clearBtn.onclick = async () => {
    if (clearBtn.dataset.armed !== '1') {
      clearBtn.dataset.armed = '1'
      clearBtn.classList.add('armed')
      clearBtn.innerHTML = `${icon('trash')}<span>Tap again to clear</span>`
      return
    }
    try {
      await call('/notes/clear-done', { method: 'POST' })
      clearBtn.dataset.armed = ''
      clearBtn.classList.remove('armed')
      clearBtn.innerHTML = `${icon('trash')}<span>Clear completed</span>`
      await load()
      render()
      say('cleared')
    } catch (e) {
      say(`clear failed: ${(e as Error).message}`, true)
    }
  }

  try {
    await load()
    render()
    say('')
  } catch (e) {
    chip.textContent = 'Offline'
    chip.className = 'chip bad'
    body.innerHTML = `<div class="empty"><span class="err msg"></span><br>
      <span class="mono url"></span></div>`
    ;(body.querySelector('.msg') as HTMLElement).textContent =
      `Could not reach gateway: ${(e as Error).message}`
    ;(body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/notes`
  }
}