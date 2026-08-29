/**
 * Phone-side prep note library: the lesson material the gateway stores in
 * /data/prep.json, with one marked active.
 *
 * A PREP NOTE IS NOT A PROMPT, and the two panels sit next to each other, so
 * the distinction is worth stating once. A prompt is the instruction about HOW
 * to answer — the tags, the NONE contract, the shape rules. A prep note is the
 * MATERIAL a particular lesson is about. Both are titled libraries with one
 * active and both mint ids as "p" + epoch ms, so a bare id is ambiguous between
 * them; the gateway's suggest log line prints `prompt=` and `prep=` separately
 * for exactly that reason.
 *
 * WHAT ACTIVATING DOES, AND WHEN
 *
 * Unlike a prompt, which the gateway re-reads on every suggestion attempt, the
 * prep note is captured ONCE when a recording starts. Changing the active note
 * mid-recording does nothing to the recording in progress — it takes effect at
 * the next session_start. That is deliberate (a lesson must not change under a
 * conversation halfway through), and it is why this panel says "next recording"
 * rather than "now".
 *
 * "NO PREP NOTE" IS A REAL CHOICE, NOT AN EMPTY LIBRARY
 *
 * PrepStore.active_prep() returns None for an empty pointer and does NOT fall
 * back to prep[0], which is where it deliberately diverges from
 * ScriptStore.active_script(). So this panel must not do the prompts.ts
 * `find(active) ?? prompts[0]` trick: doing so would show a lesson as active
 * that the gateway is not sending. Resolve by `store.active` alone.
 *
 * The .env quoting rules DO NOT APPLY to anything typed here. Quotes, $, # and
 * newlines are all safe: this travels as JSON and lands in a JSON file.
 *
 * Not debounced-and-autosaved, for the same reason prompts.ts is not: a lesson
 * is thousands of characters and a half-typed paragraph reaching the model
 * mid-class is worse than an extra tap. Nothing leaves the phone until Save.
 *
 * Typing a 20k-character lesson on a phone is not the intended path — the
 * laptop helper (g2-prep.ps1, Send-Prep) exists for that. This panel is for
 * choosing which prepared lesson is active before a class, for small edits,
 * and for picking a file off the phone.
 *
 * THE FILE PICKER MAY NOT WORK, AND THAT CANNOT BE DETECTED IN ADVANCE
 *
 * The Even Hub SDK has no file API: it exposes getLocalStorage and
 * setLocalStorage for strings, and nothing else. So this uses a plain
 * <input type="file">, which is web platform rather than SDK.
 *
 * On Android a WebView only opens a picker if the HOST APP implements
 * WebChromeClient.onShowFileChooser. If Even Hub does not, tapping the input
 * does nothing whatsoever — no picker, no error, no event. There is no
 * capability flag for this, so it cannot be feature-detected before the tap.
 *
 * Hence the hint line below, shown BEFORE the picker rather than after a
 * failure: there is no failure event to hang a handler on. A dead button
 * with no explanation would read as a bug in this app rather than a limit of
 * the host, when the laptop path already works.
 *
 * Endpoints used, all as defined in routes_prep.py:
 *   GET    /prep                  -> { active, prep }
 *   POST   /prep                  -> create
 *   PUT    /prep/{id}             -> update
 *   POST   /prep/{id}/activate
 *   POST   /prep/deactivate
 *   DELETE /prep/{id}
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'
import { notifySetupChanged } from './setup'

interface StoredPrep {
  id: string
  title: string
  text: string
  created: number
  updated: number
}

interface Store {
  /** '' means no prep note. NOT a stale pointer to fall back from. */
  active: string
  prep: StoredPrep[]
}

/** PrepStore.MAX_TEXT. Kept in sync by hand; the gateway truncates silently. */
const MAX_TEXT = 32768

const CSS = `
.g2pp .eff {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; margin-bottom: 12px; border-radius: var(--r2);
  background: var(--sunken); border: 1px solid var(--line-soft);
  font-size: 12px; color: var(--text-2);
}
.g2pp .eff .who { color: var(--info); font-weight: 650; overflow-wrap: anywhere; }
.g2pp .count { color: var(--text-3); font-size: 12px; margin: 6px 0 10px; }
.g2pp .count.warn { color: var(--warn, #FFD60A); }
.g2pp .editbar {
  position: sticky; bottom: 0; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 2px; margin-top: 4px;
  background: linear-gradient(180deg, rgba(35,35,35,0), var(--surface) 30%);
}
.g2pp .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2pp .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.g2pp .pickhint { font-size: 11px; color: var(--text-3); margin-top: 8px; }
.g2pp .pickhint:empty { display: none; }
.g2pp .prev {
  font-size: 12px; color: var(--text-2); margin: 0 0 10px; padding: 8px 10px;
  border-radius: var(--r2); background: var(--sunken);
  border: 1px solid var(--line-soft); overflow-wrap: anywhere;
}
`

export async function mountPrep(host?: HTMLElement) {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2pp'
  // Above the prompt library: you choose WHICH LESSON before you think about
  // how the suggester should phrase itself, and the prep note is the thing
  // that changes between class periods.
  root.style.order = String(PANEL_ORDER.prep)
  ;(host ?? document.body).appendChild(root)

  const card = makeCard({
    title: 'Prep notes',
    sub: 'Lesson material sent with the transcript',
    icon: 'doc',
    collapsible: true,
    open: false,
    memory: 'prep',
  })
  const chip = document.createElement('span')
  chip.className = 'chip mute'
  chip.textContent = '—'
  card.aside.appendChild(chip)

  card.body.innerHTML = `
    <div class="eff"><span>Next recording</span><span class="who">loading…</span></div>
    <div class="body"></div>
    <div class="btns">
      <button class="btn sm new" type="button">${icon('plus')}<span>New note</span></button>
      <button class="btn sm pick" type="button">${icon('plus')}<span>From file</span></button>
      <button class="btn sm ghost off" type="button">Use none</button>
      <span class="state"></span>
    </div>
    <div class="pickhint"></div>
    <input class="file" type="file"
           accept=".pdf,.docx,.md,.txt,.csv,text/plain,application/pdf"
           style="display:none">`
  root.appendChild(card.root)

  const effWho = card.body.querySelector('.eff .who') as HTMLElement
  const body = card.body.querySelector('.body') as HTMLElement
  const stateEl = card.body.querySelector('.state') as HTMLElement
  const newBtn = card.body.querySelector('.new') as HTMLButtonElement
  const offBtn = card.body.querySelector('.off') as HTMLButtonElement
  const pickBtn = card.body.querySelector('.pick') as HTMLButtonElement
  const fileEl = card.body.querySelector('.file') as HTMLInputElement
  const hintEl = card.body.querySelector('.pickhint') as HTMLElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  let store: Store = { active: '', prep: [] }

  /** id currently open in the editor, '' for the list, 'new' for a draft. */
  let editing = ''

  async function call(path: string, init?: RequestInit): Promise<Store> {
    const r = await fetch(restUrl(path), init)
    if (!r.ok) throw new Error(`${r.status}`)
    return (await r.json()) as Store
  }

  const json = (b: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b),
  })

  async function load() {
    store = await call('/prep')
  }

  /**
   * The note the NEXT recording will run against, or null for none.
   *
   * Resolved by `store.active` alone, with NO fallback to prep[0]. See the
   * header: PrepStore.active_prep() returns None for an empty pointer, so
   * falling back here would draw a lesson as active that the gateway is not
   * going to send — the exact lie the prompts.ts fallback exists to avoid in
   * the opposite direction.
   */
  function activeNote(): StoredPrep | null {
    return store.prep.find(p => p.id === store.active) ?? null
  }

  /** The header chip is a few centimetres wide; an 80-char title is not. */
  function ellipsis(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
  }

  function paintEffective() {
    const p = activeNote()
    if (!p) {
      // Not an error state and not styled as one. A conversation with no
      // lesson attached is the whole stack's original behaviour and is the
      // right setting for anything that is not a class.
      effWho.textContent = store.prep.length
        ? 'No prep note'
        : 'No prep note (library empty)'
      chip.textContent = 'None'
      chip.className = 'chip mute'
      return
    }
    effWho.textContent = `${p.title} · ${p.text.length} chars`
    chip.textContent = ellipsis(p.title, 18)
    chip.className = 'chip info'
  }

  // ------------------------------------------------------------- editor

  function renderEditor(p: StoredPrep | null) {
    const isNew = p === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="inp t" type="text" maxlength="80"
             placeholder="e.g. AP Phys - Projectile Motion Day 2">
      <div class="lbl">Lesson material</div>
      <textarea class="inp x" spellcheck="false" maxlength="${MAX_TEXT}"></textarea>
      <div class="count"></div>
      <div class="editbar">
        <button class="btn primary save" type="button">${icon('check')}<span>Save</span></button>
        <button class="btn ghost cancel" type="button">Cancel</button>
        ${isNew ? '' : `<button class="btn danger del" type="button">${icon('trash')}<span>Delete</span></button>`}
      </div>`

    const t = body.querySelector('.t') as HTMLInputElement
    const x = body.querySelector('.x') as HTMLTextAreaElement
    const count = body.querySelector('.count') as HTMLElement

    t.value = p?.title ?? ''
    x.value = p?.text ?? ''

    // The same number prompts.ts shows, and it matters MORE here. A prompt is
    // ~2600 characters; a lesson can be ten times that, and the whole thing is
    // re-sent as prefill on every suggestion attempt. Ollama truncates past
    // num_ctx WITHOUT SAYING SO, and what it drops is the end of the prompt —
    // the transcript — so the symptom is a suggester that has stopped hearing
    // the room while still looking perfectly healthy.
    const paintCount = () => {
      const n = x.value.length
      count.textContent = `${n} chars (~${Math.round(n / 4)} tokens of prefill on every attempt)`
      // Two thirds of a 32768 context spent on material alone leaves little
      // for a lesson's worth of transcript.
      count.className = n > 20000 ? 'count warn' : 'count'
    }
    x.oninput = paintCount
    paintCount()

    ;(body.querySelector('.cancel') as HTMLButtonElement).onclick = () => {
      editing = ''
      render()
    }

    ;(body.querySelector('.save') as HTMLButtonElement).onclick = async () => {
      if (!x.value.trim()) {
        say('lesson material is empty', true)
        return
      }
      try {
        say('saving…')
        store = isNew
          ? await call('/prep', json({ title: t.value, text: x.value }))
          : await call(`/prep/${p!.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: t.value, text: x.value }),
            })
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
        // Two taps, because there is no undo. Sessions already recorded keep
        // their own COPY of the text, so deleting here cannot damage the
        // record of a class that has already happened — but the note itself
        // is gone.
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.classList.add('armed')
          del.innerHTML = `${icon('trash')}<span>Tap again to delete</span>`
          return
        }
        try {
          await call(`/prep/${p!.id}`, { method: 'DELETE' })
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

  function renderList() {
    if (!store.prep.length) {
      body.innerHTML = `<div class="empty">No prep notes. Recordings will run on
        the transcript alone. Add one here, or send a lesson file from a
        computer.</div>`
      return
    }

    body.innerHTML = ''
    for (const p of store.prep) {
      const on = p.id === store.active
      const row = document.createElement('div')
      row.className = on ? 'tile on' : 'tile'
      row.innerHTML = `
        <span class="ttl"></span>
        <span class="meta"></span>
        <div class="tags">${on ? '<span class="chip ok">Active</span>' : ''}</div>
        <div class="btns">
          ${on ? '' : `<button class="btn sm primary use" type="button">${icon('check')}<span>Use this</span></button>`}
          <button class="btn sm edit" type="button">${icon('edit')}<span>Edit</span></button>
        </div>`

      // textContent, not innerHTML: a title is user text and goes in as text,
      // never as markup.
      ;(row.querySelector('.ttl') as HTMLElement).textContent = p.title
      ;(row.querySelector('.meta') as HTMLElement).textContent = `${p.text.length} chars`

      const use = row.querySelector('.use') as HTMLButtonElement | null
      if (use) {
        use.onclick = async () => {
          try {
            await call(`/prep/${p.id}/activate`, { method: 'POST' })
            await load()
            render()
            // Both the Recording card and the summary prompt card resolve
            // differently once a prep note is attached, so they are told.
            notifySetupChanged()
            // "next recording", not "changed": a recording already running
            // captured its note at session_start and is unaffected.
            say('active from the next recording')
          } catch (e) {
            say(`activate failed: ${(e as Error).message}`, true)
          }
        }
      }

      ;(row.querySelector('.edit') as HTMLButtonElement).onclick = () => {
        editing = p.id
        render()
      }

      body.appendChild(row)
    }
  }

  function render() {
    paintEffective()
    newBtn.disabled = editing !== ''
    pickBtn.disabled = editing !== ''
    // Nothing to turn off when nothing is on, and hidden rather than disabled
    // during an edit so the editor's own bar is the only thing to press.
    offBtn.disabled = editing !== ''
    offBtn.style.display = store.active ? '' : 'none'
    if (editing === 'new') return renderEditor(null)
    if (editing) {
      const p = store.prep.find(q => q.id === editing)
      if (p) return renderEditor(p)
      editing = ''
    }
    renderList()
  }

  newBtn.onclick = () => {
    editing = 'new'
    render()
  }

  // --------------------------------------------------------- file upload

  pickBtn.onclick = () => {
    // Shown BEFORE the picker opens, not after a failure: a WebView that
    // blocks file input fires no event at all, so there is nothing to hang
    // an error handler on.
    hintEl.textContent =
      'If no file chooser opens, this app cannot reach your files. '
      + 'Send the lesson from a computer instead.'
    fileEl.value = ''
    fileEl.click()
  }

  fileEl.onchange = async () => {
    const f = fileEl.files && fileEl.files[0]
    if (!f) return
    hintEl.textContent = ''

    // Raw bytes to /prep/upload, the same thing the laptop helper sends. The
    // gateway reads request.body() and takes the filename from the query
    // string, so there is no multipart boundary on either side. .md and
    // .docx alike travel as bytes; nothing is decoded on the phone.
    say(`uploading ${f.name} (${Math.round(f.size / 1024)} KB)\u2026`)

    try {
      const buf = await f.arrayBuffer()
      // Title defaults to the filename without its extension, renameable
      // with Edit afterwards. Asking for a title first would put a keyboard
      // between the teacher and a task that should be two taps.
      const base = f.name.replace(/\.[^.]+$/, '')
      const q = `filename=${encodeURIComponent(f.name)}`
        + `&title=${encodeURIComponent(base)}`

      const r = await fetch(restUrl(`/prep/upload?${q}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buf,
      })
      const d = await r.json()

      if (!r.ok) {
        // extract.py writes these for the person who chose the file —
        // "probably a scan with no text layer", "save as .docx" — so the
        // server's own words are shown rather than a status code.
        say(d.error || `upload failed: ${r.status}`, true)
        return
      }

      store = d as Store
      editing = ''
      render()
      // PrepStore.create() activates the first note in an empty library, so
      // an upload CAN change which lesson the next recording uses. The
      // Recording card and the summary panel resolve differently when that
      // happens and would otherwise still be showing "None".
      notifySetupChanged()
      say(`added ${d.chars} characters`)

      // THE PREVIEW IS THE POINT. A two-column PDF extracts into interleaved
      // lines and still returns 200; only reading the words catches it, and
      // now is while the teacher still remembers what the document said.
      const prev = document.createElement('div')
      prev.className = 'prev'
      prev.textContent =
        (d.truncated ? `Cut at ${d.chars} of ${d.extracted} characters. ` : '')
        + `Check this reads like your document: ${d.preview}\u2026`
      body.prepend(prev)
    } catch (e) {
      say(`upload failed: ${(e as Error).message}`, true)
    }
  }

  offBtn.onclick = async () => {
    // No confirmation. This deletes nothing — it clears a pointer, and the
    // note is one tap away in the list.
    try {
      await call('/prep/deactivate', { method: 'POST' })
      await load()
      render()
      notifySetupChanged()
      say('next recording will use no prep note')
    } catch (e) {
      say(`failed: ${(e as Error).message}`, true)
    }
  }

  try {
    await load()
    render()
    say('')
  } catch (e) {
    chip.textContent = 'Offline'
    chip.className = 'chip bad'
    effWho.textContent = '(gateway unreachable)'
    body.innerHTML = `<div class="empty"><span class="err msg"></span><br>
      <span class="mono url"></span></div>`
    ;(body.querySelector('.msg') as HTMLElement).textContent =
      `Could not reach gateway: ${(e as Error).message}`
    ;(body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/prep`
  }
}