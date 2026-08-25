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
 *
 * Endpoints used, all as defined in routes_prompts.py:
 *   GET    /prompts               -> { active, prompts, effective }
 *   POST   /prompts               -> create
 *   PUT    /prompts/{id}          -> update
 *   POST   /prompts/{id}/activate
 *   DELETE /prompts/{id}
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon } from './theme'

interface StoredPrompt {
  id: string
  title: string
  text: string
  updated: number
}

interface Store {
  active: string
  prompts: StoredPrompt[]
  /** What the gateway would actually send right now. Present on GET only. */
  effective?: { label: string; chars: number }
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

  let store: Store = { active: '', prompts: [] }

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
  }

  function paintEffective() {
    if (!store.effective) {
      effWho.textContent = '(unknown)'
      chip.textContent = '—'
      chip.className = 'chip mute'
      return
    }
    effWho.textContent = `${store.effective.label} · ${store.effective.chars} chars`
    chip.textContent = store.effective.label
    chip.className = 'chip info'
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
            await call(`/prompts/${p.id}/activate`, { method: 'POST' })
            await load()
            render()
            say('active prompt changed')
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