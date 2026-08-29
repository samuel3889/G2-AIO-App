/**
 * Phone-side prompt library: the titled suggestion prompts the gateway stores
 * in /data/prompts.json, with one marked active.
 *
 * Replaces editing SUGGEST_PROMPT in .env. That value is now only a SEED for an
 * empty store on first boot; once a prompt exists here it is what the suggester
 * sends, and .env is never consulted again.
 *
 * The .env quoting rules DO NOT APPLY to anything typed here. Quotes, $, # and
 * newlines are all safe: this travels as JSON and lands in a JSON file, so none
 * of the shell interpolation that truncated .env values can happen.
 *
 * Unlike the tuning sliders, edits here are NOT debounced-and-autosaved. A
 * prompt is 2600 characters of carefully weighed text, and a half-typed sentence
 * reaching the model mid-session is a worse failure than an extra tap. Nothing
 * leaves the phone until Save is pressed.
 *
 * PUBLIC SURFACE IS UNCHANGED — mountPrompts(host) keeps its name and signature.
 *
 * WHAT CHANGED IN THIS PASS
 *  - The panel is a card, so it stacks with the recording card above it instead
 *    of being a second differently-coloured slab.
 *  - What is actually being sent is a chip in the card header, visible without
 *    reading the body.
 *  - The editor's Save/Cancel/Delete bar sticks to the bottom of the editor, so
 *    a 46vh textarea does not push Save off the screen.
 *  - "Sending" shows the prompt's TITLE and length, not the gateway's raw
 *    `effective.label` — that label leads with the internal id (p1787505227697)
 *    because it is also a log line. See effectiveTitle().
 *
 * Endpoints used, all as defined in routes_prompts.py:
 *   GET    /prompts               -> { active, prompts, effective }
 *   POST   /prompts               -> create
 *   PUT    /prompts/{id}          -> update
 *   POST   /prompts/{id}/activate
 *   DELETE /prompts/{id}
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
  /** What the gateway sends for a recording with NO prep note. GET only. */
  effective?: { label: string; chars: number }
  /** What it sends for a recording WITH one. GET only. */
  effective_prep?: { label: string; chars: number }
}

const CSS = `
.g2pr .eff {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; margin-bottom: 12px; border-radius: var(--r2);
  background: var(--sunken); border: 1px solid var(--line-soft);
  font-size: 12px; color: var(--text-2);
}
.g2pr .eff .who { color: var(--info); font-weight: 650; overflow-wrap: anywhere; }
.g2pr .count { color: var(--text-3); font-size: 12px; margin: 6px 0 10px; }
.g2pr .editbar {
  position: sticky; bottom: 0; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 2px; margin-top: 4px;
  background: linear-gradient(180deg, rgba(35,35,35,0), var(--surface) 30%);
}
.g2pr .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2pr .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
`

export async function mountPrompts(host?: HTMLElement) {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2pr'
  // Last section in the Conversations tab: this is configuration that shapes a
  // future recording, not something touched during one. See PANEL_ORDER.
  root.style.order = String(PANEL_ORDER.prompts)
  ;(host ?? document.body).appendChild(root)

  const card = makeCard({
    title: 'Suggestion prompts',
    sub: 'Sent with the transcript during a recording',
    icon: 'spark',
    collapsible: true,
    open: false,
    memory: 'prompts',
  })
  const chip = document.createElement('span')
  chip.className = 'chip mute'
  chip.textContent = '—'
  card.aside.appendChild(chip)

  card.body.innerHTML = `
    <div class="eff"><span>Sending</span><span class="who">loading…</span></div>
    <div class="body"></div>
    <div class="btns">
      <button class="btn sm new" type="button">${icon('plus')}<span>New prompt</span></button>
      <span class="state"></span>
    </div>`
  root.appendChild(card.root)

  const effWho = card.body.querySelector('.eff .who') as HTMLElement
  const body = card.body.querySelector('.body') as HTMLElement
  const stateEl = card.body.querySelector('.state') as HTMLElement
  const newBtn = card.body.querySelector('.new') as HTMLButtonElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  let store: Store = { active: '', active_prep: '', prompts: [] }

  /**
   * Whether a prep note is active, which decides WHICH of the two pointers a
   * recording started now would resolve.
   *
   * Fetched from /prep rather than assumed: the header chip is the
   * one-glance answer to "what happens next", and that is not knowable from
   * this store alone.
   */
  let hasPrep = false

  async function loadPrepState() {
    try {
      const r = await fetch(restUrl('/prep'))
      if (!r.ok) { hasPrep = false; return }
      const d = (await r.json()) as { active: string; prep: { id: string }[] }
      // Mirrors PrepStore.active_prep(): resolve the pointer, NO fallback.
      hasPrep = !!d.prep.find(q => q.id === d.active)
    } catch {
      hasPrep = false
    }
  }

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
    store = await call('/prompts')
    await loadPrepState()
  }

  /**
   * Human name of the prompt the gateway would send right now.
   *
   * NOT `store.effective.label`. That string is built in prompts.py as
   * `f"{p['id']} {p['title']!r}"` — id first — because the same value is what
   * the suggester writes to its log lines, where an id is the half that
   * matters. On screen it is 14 characters of noise in front of the answer,
   * so the title is resolved from the store the response already carries
   * instead of being parsed back out of the label.
   *
   * THE FALLBACK MIRRORS THE GATEWAY, deliberately. PromptStore.active_prompt()
   * is `self.get(self.active) or self.prompts[0]`: a stale active pointer
   * degrades to the first prompt rather than to silence. Resolving only by
   * `store.active` here would print '(unknown)' for a case where the gateway
   * is happily sending prompts[0], which is a worse lie than the id was.
   *
   * Null when the store is empty — the env-seed case, which has no title to
   * show and whose label ('env SUGGEST_PROMPT') carries no id anyway.
   */
  function effectiveTitle(): string | null {
    const p = store.prompts.find(q => q.id === store.active) ?? store.prompts[0]
    return p ? p.title : null
  }

  /**
   * Title used for prep-attached recordings, and whether it is a separate
   * choice. Mirrors PromptStore.active_prompt(has_prep=True): the prep
   * pointer wins only when set AND resolving, else falls through.
   */
  function prepTitle(): { title: string | null; separate: boolean } {
    if (store.active_prep) {
      const p = store.prompts.find(q => q.id === store.active_prep)
      if (p) return { title: p.title, separate: true }
    }
    return { title: effectiveTitle(), separate: false }
  }

  /** The header chip is a few centimetres wide; a 80-char title is not. */
  function ellipsis(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
  }

  function paintEffective() {
    if (!store.effective) {
      effWho.textContent = '(unknown)'
      chip.textContent = '—'
      chip.className = 'chip mute'
      return
    }
    // Empty store: the gateway is falling back to the env seed, and its label
    // is then the whole answer to "what is being sent", so it is shown as-is.
    const who = effectiveTitle() ?? store.effective.label
    const prep = prepTitle()
    effWho.textContent =
      `${who} · ${store.effective.chars} chars` +
      (prep.separate ? ` — with a prep note: ${prep.title}` : '')

    // THE CHIP SHOWS WHAT WOULD ACTUALLY BE SENT, which depends on whether a
    // prep note is attached - not the default pointer unconditionally.
    const shown = (hasPrep ? prep.title : who) ?? who
    chip.textContent = ellipsis(shown, 18)
    chip.className = hasPrep && prep.separate ? 'chip ok' : 'chip info'
  }

  // ------------------------------------------------------------- editor

  function renderEditor(p: StoredPrompt | null) {
    const isNew = p === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="inp t" type="text" maxlength="80" placeholder="e.g. Meeting corrections">
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

    // Length is shown because it is the one number that silently breaks things:
    // the whole prompt is re-sent as prefill on EVERY attempt, and Ollama
    // truncates past num_ctx without saying so. Roughly 4 chars per token
    // against a 32768 context.
    const paintCount = () => {
      count.textContent = `${x.value.length} chars (~${Math.round(
        x.value.length / 4,
      )} tokens of prefill on every attempt)`
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
          ? await call('/prompts', json({ title: t.value, text: x.value }))
          : await call(`/prompts/${p!.id}`, {
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
        // Two taps, because there is no undo and a deleted prompt is an
        // evening of tuning gone.
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.classList.add('armed')
          del.innerHTML = `${icon('trash')}<span>Tap again to delete</span>`
          return
        }
        try {
          await call(`/prompts/${p!.id}`, { method: 'DELETE' })
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
    if (!store.prompts.length) {
      body.innerHTML = `<div class="empty">No prompts stored. The gateway is
        falling back to SUGGEST_PROMPT from the environment until you create
        one.</div>`
      return
    }

    body.innerHTML = ''
    for (const p of store.prompts) {
      const on = p.id === store.active
      const row = document.createElement('div')
      row.className = on ? 'tile on' : 'tile'
      row.innerHTML = `
        <span class="ttl"></span>
        <span class="meta"></span>
        <div class="tags">
          ${on ? '<span class="chip ok">Default</span>' : ''}
          ${p.id === store.active_prep ? '<span class="chip info">Lessons</span>' : ''}
        </div>
        <div class="btns">
          ${on ? '' : `<button class="btn sm primary use" type="button">${icon('check')}<span>Use as default</span></button>`}
          ${p.id === store.active_prep
            ? `<button class="btn sm ghost unprep" type="button">Stop using for lessons</button>`
            : `<button class="btn sm useprep" type="button">${icon('check')}<span>Use for lessons</span></button>`}
          <button class="btn sm edit" type="button">${icon('edit')}<span>Edit</span></button>
        </div>`

      // textContent, not innerHTML: a title is user text and goes in as text,
      // never as markup.
      ;(row.querySelector('.ttl') as HTMLElement).textContent = p.title
      ;(row.querySelector('.meta') as HTMLElement).textContent = `${p.text.length} chars`

      const activate = async (slot: 'default' | 'prep') => {
        try {
          await call(`/prompts/${p.id}/activate?slot=${slot}`, { method: 'POST' })
          await load()
          render()
          notifySetupChanged()
          say(slot === 'prep' ? 'set for lessons' : 'set as default')
        } catch (e) {
          say(`activate failed: ${(e as Error).message}`, true)
        }
      }

      const use = row.querySelector('.use') as HTMLButtonElement | null
      if (use) use.onclick = () => void activate('default')

      const useprep = row.querySelector('.useprep') as HTMLButtonElement | null
      if (useprep) useprep.onclick = () => void activate('prep')

      const unprep = row.querySelector('.unprep') as HTMLButtonElement | null
      if (unprep) {
        unprep.onclick = async () => {
          // Clears the pointer only. The prompt stays in the library and
          // prep-attached recordings fall back to the default.
          try {
            await call('/prompts/deactivate-prep', { method: 'POST' })
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

  // Activating a lesson in the prep panel changes which pointer this card
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
    effWho.textContent = '(gateway unreachable)'
    body.innerHTML = `<div class="empty"><span class="err msg"></span><br>
      <span class="mono url"></span></div>`
    ;(body.querySelector('.msg') as HTMLElement).textContent =
      `Could not reach gateway: ${(e as Error).message}`
    ;(body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/prompts`
  }
}