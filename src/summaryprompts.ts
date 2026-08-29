/**
 * Phone-side SUMMARY prompt library: the instruction the gateway sends after a
 * recording ends, stored in /data/summary_prompts.json.
 *
 * The sibling of prompts.ts, and the difference is worth stating plainly
 * because the two cards sit near each other:
 *
 *   prompts.ts         -> instruction sent DURING a recording, every few
 *                         utterances, to decide whether to interrupt.
 *   summaryprompts.ts  -> instruction sent ONCE, after stop, to write up what
 *                         happened.
 *
 * Ids differ by first letter, "p" for suggest and "s" for summary, which is
 * the quickest way to tell from a log line which store an id came from.
 *
 * TWO ACTIVE POINTERS, WHICH IS WHY THIS IS NOT JUST prompts.ts RENAMED
 *
 *   active       used for sessions with NO prep note, and the fallback for
 *                everything when the prep pointer is unset.
 *   active_prep  used for sessions that HAVE a prep note attached.
 *
 * summarise() branches on doc.get("prep"), so the choice is made from a fact
 * the gateway already holds rather than from a conditional the model has to
 * honour. A teaching summary that asks which prepared points went uncovered
 * would produce a "Not covered" section about nothing if it ran on a faculty
 * meeting; the second pointer is what stops that.
 *
 * An UNSET prep pointer is the ordinary state, not a gap to fill. It means
 * "use the default for everything", which is exactly how this store behaved
 * before the second pointer existed. The panel says "same as default" rather
 * than "none" for that reason - "none" reads like something is broken.
 *
 * Endpoints used, all as defined in routes_summaryprompts.py:
 *   GET    /summary-prompts                     -> { active, active_prep,
 *                                                   prompts, effective,
 *                                                   effective_prep }
 *   POST   /summary-prompts                     -> create
 *   PUT    /summary-prompts/{id}                -> update
 *   POST   /summary-prompts/{id}/activate?slot=default|prep
 *   POST   /summary-prompts/deactivate-prep
 *   DELETE /summary-prompts/{id}
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'
import { SETUP_CHANGED, notifySetupChanged } from './setup'

interface StoredPrompt {
  id: string
  title: string
  text: string
  updated: number
}

interface Store {
  active: string
  /** '' means "same as active". Not an error state. */
  active_prep: string
  prompts: StoredPrompt[]
  /** What the summariser would send for a session with no prep note. */
  effective?: { label: string; chars: number }
  /** What it would send for a session with one. Present on GET only. */
  effective_prep?: { label: string; chars: number }
}

const CSS = `
.g2sp .eff {
  display: grid; grid-template-columns: auto 1fr; gap: 4px 8px;
  align-items: baseline;
  padding: 10px 12px; margin-bottom: 12px; border-radius: var(--r2);
  background: var(--sunken); border: 1px solid var(--line-soft);
  font-size: 12px; color: var(--text-2);
}
.g2sp .eff .who { color: var(--info); font-weight: 650; overflow-wrap: anywhere; }
/* The case that applies right now is drawn full strength and the other is
   dimmed, so the card answers "what happens next" before it is read closely. */
.g2sp .eff .dim { opacity: .45; }
.g2sp .count { color: var(--text-3); font-size: 12px; margin: 6px 0 10px; }
.g2sp .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2sp .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.g2sp .editbar {
  position: sticky; bottom: 0; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 2px; margin-top: 4px;
  background: linear-gradient(180deg, rgba(35,35,35,0), var(--surface) 30%);
}
`

export async function mountSummaryPrompts(host?: HTMLElement) {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2sp'
  root.style.order = String(PANEL_ORDER.summaryPrompts)
  ;(host ?? document.body).appendChild(root)

  const card = makeCard({
    title: 'Summary prompts',
    sub: 'Sent once when a recording stops',
    icon: 'doc',
    collapsible: true,
    open: false,
    memory: 'summaryprompts',
  })
  const chip = document.createElement('span')
  chip.className = 'chip mute'
  chip.textContent = '—'
  card.aside.appendChild(chip)

  card.body.innerHTML = `
    <div class="eff">
      <span>No prep note</span><span class="who plain">loading…</span>
      <span>With prep note</span><span class="who withprep">loading…</span>
    </div>
    <div class="body"></div>
    <div class="btns">
      <button class="btn sm new" type="button">${icon('plus')}<span>New prompt</span></button>
      <span class="state"></span>
    </div>`
  root.appendChild(card.root)

  const effPlain = card.body.querySelector('.eff .plain') as HTMLElement
  const effPrep = card.body.querySelector('.eff .withprep') as HTMLElement
  const body = card.body.querySelector('.body') as HTMLElement
  const stateEl = card.body.querySelector('.state') as HTMLElement
  const newBtn = card.body.querySelector('.new') as HTMLButtonElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  let store: Store = { active: '', active_prep: '', prompts: [] }
  let editing = ''

  /**
   * Whether a prep note is currently active, which decides WHICH of the two
   * pointers the next recording resolves.
   *
   * Fetched from /prep rather than assumed. The header chip is the one-glance
   * answer to "what happens next", and with two pointers that answer is not
   * knowable from this store alone: showing the default prompt while the
   * gateway is about to use the lesson prompt is exactly the mismatch the
   * effective blocks exist to prevent.
   */
  let hasPrep = false

  async function loadPrepState() {
    try {
      const r = await fetch(restUrl('/prep'))
      if (!r.ok) { hasPrep = false; return }
      const d = (await r.json()) as { active: string; prep: { id: string }[] }
      // Mirrors PrepStore.active_prep(): resolve the pointer, NO fallback to
      // prep[0]. An empty pointer means no prep note.
      hasPrep = !!d.prep.find(q => q.id === d.active)
    } catch {
      hasPrep = false
    }
  }

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
    store = await call('/summary-prompts')
    await loadPrepState()
  }

  /**
   * Title of the prompt used for sessions with no prep note.
   *
   * MIRRORS SummaryPromptStore.active_prompt(has_prep=False): resolve the
   * pointer, else fall back to prompts[0]. Resolving by `store.active` alone
   * would print nothing for a stale pointer while the gateway was happily
   * sending prompts[0] - a worse lie than showing the fallback.
   */
  function defaultTitle(): string | null {
    const p = store.prompts.find(q => q.id === store.active) ?? store.prompts[0]
    return p ? p.title : null
  }

  /**
   * Title used for prep-attached sessions, and whether it is a separate choice.
   *
   * Mirrors active_prompt(has_prep=True): the prep pointer wins only when it
   * is set AND resolves; otherwise it falls THROUGH to the default. That
   * fall-through is what makes the second pointer optional.
   */
  function prepTitle(): { title: string | null; separate: boolean } {
    if (store.active_prep) {
      const p = store.prompts.find(q => q.id === store.active_prep)
      if (p) return { title: p.title, separate: true }
    }
    return { title: defaultTitle(), separate: false }
  }

  function ellipsis(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
  }

  function paintEffective() {
    const plain = defaultTitle()
    const prep = prepTitle()

    // Empty store: the gateway is on the env seed, and its label is then the
    // whole answer to "what is being sent", so it is shown as-is.
    effPlain.textContent = plain
      ? `${plain}${store.effective ? ` · ${store.effective.chars} chars` : ''}`
      : (store.effective?.label ?? '(unknown)')

    // "same as default", never "none". An unset prep pointer is the ordinary
    // state and nothing is missing.
    effPrep.textContent = prep.title
      ? `${prep.title}${prep.separate ? '' : ' (same as default)'}`
      : (store.effective_prep?.label ?? '(unknown)')

    effPlain.classList.toggle('dim', hasPrep)
    effPrep.classList.toggle('dim', !hasPrep)

    // THE CHIP SHOWS WHAT WILL ACTUALLY BE USED, which depends on whether a
    // prep note is attached - not the default pointer unconditionally. With a
    // lesson active this reads the lesson prompt; with none, the default.
    const shown = hasPrep ? prep.title : plain
    if (shown) {
      chip.textContent = ellipsis(shown, 18)
      chip.className = hasPrep && prep.separate ? 'chip ok' : 'chip info'
    } else {
      chip.textContent = '—'
      chip.className = 'chip mute'
    }
  }

  // ------------------------------------------------------------- editor

  function renderEditor(p: StoredPrompt | null) {
    const isNew = p === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="inp t" type="text" maxlength="80"
             placeholder="e.g. Teaching summary">
      <div class="lbl">Prompt</div>
      <textarea class="inp x" spellcheck="false"></textarea>
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

    // Shown for consistency with the other prompt panels, but the number
    // matters far less here: this instruction is sent ONCE per recording,
    // not re-prefilled every few utterances. The transcript and prep note
    // sent alongside it are what actually approach num_ctx.
    const paintCount = () => {
      count.textContent = `${x.value.length} chars, sent once per recording`
    }
    x.oninput = paintCount
    paintCount()

    ;(body.querySelector('.cancel') as HTMLButtonElement).onclick = () => {
      editing = ''
      render()
    }

    ;(body.querySelector('.save') as HTMLButtonElement).onclick = async () => {
      if (!x.value.trim()) {
        say('prompt text is empty', true)
        return
      }
      try {
        say('saving…')
        store = isNew
          ? await call('/summary-prompts', json({ title: t.value, text: x.value }))
          : await call(`/summary-prompts/${p!.id}`, {
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
        // Two taps, because there is no undo.
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.classList.add('armed')
          del.innerHTML = `${icon('trash')}<span>Tap again to delete</span>`
          return
        }
        try {
          await call(`/summary-prompts/${p!.id}`, { method: 'DELETE' })
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

  async function activate(id: string, slot: 'default' | 'prep') {
    try {
      await call(`/summary-prompts/${id}/activate?slot=${slot}`, { method: 'POST' })
      await load()
      render()
      notifySetupChanged()
      say(slot === 'prep' ? 'set for lessons' : 'set as default')
    } catch (e) {
      say(`activate failed: ${(e as Error).message}`, true)
    }
  }

  function renderList() {
    if (!store.prompts.length) {
      body.innerHTML = `<div class="empty">No summary prompts stored. The
        gateway is falling back to SUMMARY_PROMPT from the environment until
        you create one.</div>`
      return
    }

    body.innerHTML = ''
    for (const p of store.prompts) {
      const isDefault = p.id === store.active
      const isPrep = p.id === store.active_prep
      const row = document.createElement('div')
      row.className = isDefault || isPrep ? 'tile on' : 'tile'
      row.innerHTML = `
        <span class="ttl"></span>
        <span class="meta"></span>
        <div class="tags">
          ${isDefault ? '<span class="chip ok">Default</span>' : ''}
          ${isPrep ? '<span class="chip info">Lessons</span>' : ''}
        </div>
        <div class="btns">
          ${isDefault ? '' : `<button class="btn sm primary usedef" type="button">${icon('check')}<span>Use as default</span></button>`}
          ${isPrep ? `<button class="btn sm ghost unprep" type="button">Stop using for lessons</button>`
                   : `<button class="btn sm useprep" type="button">${icon('check')}<span>Use for lessons</span></button>`}
          <button class="btn sm edit" type="button">${icon('edit')}<span>Edit</span></button>
        </div>`

      // textContent, not innerHTML: a title is user text.
      ;(row.querySelector('.ttl') as HTMLElement).textContent = p.title
      ;(row.querySelector('.meta') as HTMLElement).textContent = `${p.text.length} chars`

      const usedef = row.querySelector('.usedef') as HTMLButtonElement | null
      if (usedef) usedef.onclick = () => activate(p.id, 'default')

      const useprep = row.querySelector('.useprep') as HTMLButtonElement | null
      if (useprep) useprep.onclick = () => activate(p.id, 'prep')

      const unprep = row.querySelector('.unprep') as HTMLButtonElement | null
      if (unprep) {
        unprep.onclick = async () => {
          // Clears the pointer only. The prompt stays in the library, and
          // prep-attached sessions fall back to the default.
          try {
            await call('/summary-prompts/deactivate-prep', { method: 'POST' })
            await load()
            render()
            notifySetupChanged()
            say('lessons will use the default prompt')
          } catch (e) {
            say(`failed: ${(e as Error).message}`, true)
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
    if (editing === 'new') return renderEditor(null)
    if (editing) {
      const p = store.prompts.find(q => q.id === editing)
      if (p) return renderEditor(p)
      editing = ''
    }
    renderList()
  }

  newBtn.onclick = () => {
    editing = 'new'
    render()
  }

  // The prep panel activating a lesson changes which pointer THIS card
  // resolves, so the chip has to follow it.
  window.addEventListener(SETUP_CHANGED, () => {
    void loadPrepState().then(render)
  })

  try {
    await load()
    render()
    say('')
  } catch (e) {
    chip.textContent = 'Offline'
    chip.className = 'chip bad'
    effPlain.textContent = '(gateway unreachable)'
    effPrep.textContent = ''
    body.innerHTML = `<div class="empty"><span class="err msg"></span><br>
      <span class="mono url"></span></div>`
    ;(body.querySelector('.msg') as HTMLElement).textContent =
      `Could not reach gateway: ${(e as Error).message}`
    ;(body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/summary-prompts`
  }
}