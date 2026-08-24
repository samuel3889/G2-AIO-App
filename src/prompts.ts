/**
 * Phone-side prompt library: the titled suggestion prompts the gateway
 * stores in /data/prompts.json, with one marked active.
 *
 * Replaces editing SUGGEST_PROMPT in .env. That value is now only a SEED
 * for an empty store on first boot; once a prompt exists here it is what
 * the suggester sends, and .env is never consulted again.
 *
 * The .env quoting rules DO NOT APPLY to anything typed here. Quotes, $, #
 * and newlines are all safe: this travels as JSON and lands in a JSON file,
 * so none of the shell interpolation that truncated .env values can happen.
 *
 * Mounts to the host it is given, matching mountSettings() and
 * mountSessions() — NOT to #app, which ui.ts overwrites wholesale.
 *
 * Unlike the tuning sliders, edits here are NOT debounced-and-autosaved.
 * A prompt is 2600 characters of carefully weighed text, and a half-typed
 * sentence reaching the model mid-session is a worse failure than an extra
 * tap. Nothing leaves the phone until Save is pressed.
 *
 * The gateway URL rule and the token live in api.ts.
 */
import { restBase, restUrl } from './api'

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
.g2pr { font: 14px/1.4 system-ui, sans-serif; padding: 12px; max-width: 560px;
        margin: 12px auto; background: #111; color: #eee; border-radius: 10px; }
.g2pr h3 { margin: 0 0 4px; font-size: 15px; }
.g2pr .sub { color: #888; font-size: 12px; margin-bottom: 12px; }
.g2pr .eff { background: #1c1c1c; border-radius: 8px; padding: 8px 10px;
             margin-bottom: 12px; font-size: 12px; color: #9df; }
.g2pr .row { background: #1a1a1a; border-radius: 8px; padding: 10px;
             margin-bottom: 8px; }
.g2pr .row.on { border-left: 3px solid #6cf; }
.g2pr .ttl { font-weight: 600; display: block; }
.g2pr .meta { color: #888; font-size: 12px; }
.g2pr .badge { color: #6cf; font-size: 12px; font-weight: 600; }
.g2pr .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2pr button { background: #333; color: #eee; border: 0; border-radius: 6px;
               padding: 9px 12px; font-size: 13px; touch-action: manipulation; }
.g2pr button:active { background: #444; }
.g2pr button:disabled { opacity: .5; }
.g2pr button.primary { background: #6cf; color: #062; font-weight: 600; }
.g2pr button.danger { background: #3a1c1c; color: #ff6b60; }

/* 16px on the inputs stops the browser zooming the whole page in on focus,
   which on a phone leaves the panel scrolled sideways and half off-screen. */
.g2pr input, .g2pr textarea { width: 100%; box-sizing: border-box;
       background: #0d0d0d; color: #eee; border: 1px solid #333;
       border-radius: 6px; padding: 8px; font: 16px/1.4 system-ui, sans-serif; }
.g2pr textarea { min-height: 46vh; resize: vertical; white-space: pre-wrap; }
.g2pr .count { color: #888; font-size: 12px; margin: 4px 0 8px; }
.g2pr .lbl { color: #888; font-size: 12px; margin: 8px 0 4px; }
.g2pr .state { font-size: 12px; color: #888; margin-left: 4px; }
.g2pr .err { color: #f66; }
`

export async function mountPrompts(host?: HTMLElement) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2pr'
  root.innerHTML = `<h3>Suggestion prompts</h3>
    <div class="sub">The instruction sent with the transcript during a
      recording. The active one is used; edits apply at the next
      suggestion.</div>
    <div class="eff">loading…</div>
    <div class="body"></div>
    <div class="btns"><button class="new">New prompt</button>
      <span class="state"></span></div>`
  ;(host ?? document.body).appendChild(root)

  const eff = root.querySelector('.eff') as HTMLElement
  const body = root.querySelector('.body') as HTMLElement
  const state = root.querySelector('.state') as HTMLElement

  const say = (m: string, err = false) => {
    state.textContent = m
    state.className = err ? 'state err' : 'state'
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
      eff.textContent = ''
      return
    }
    eff.textContent =
      `Sending: ${store.effective.label} — ${store.effective.chars} chars`
  }

  // ------------------------------------------------------------- editor

  function renderEditor(p: StoredPrompt | null) {
    const isNew = p === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="t" type="text" maxlength="80"
             placeholder="e.g. Meeting corrections">
      <div class="lbl">Prompt</div>
      <textarea class="x" spellcheck="false"></textarea>
      <div class="count"></div>
      <div class="btns">
        <button class="save primary">Save</button>
        <button class="cancel">Cancel</button>
        ${isNew ? '' : '<button class="del danger">Delete</button>'}
      </div>`

    const t = body.querySelector('.t') as HTMLInputElement
    const x = body.querySelector('.x') as HTMLTextAreaElement
    const count = body.querySelector('.count') as HTMLElement

    t.value = p?.title ?? ''
    x.value = p?.text ?? ''

    // Length is shown because it is the one number that silently breaks
    // things: the whole prompt is re-sent as prefill on EVERY attempt, and
    // Ollama truncates past num_ctx without saying so. Roughly 4 chars per
    // token against a 32768 context.
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
          del.textContent = 'Tap again to delete'
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
      body.innerHTML =
        `<div class="row"><span class="meta">No prompts stored. The
         gateway is falling back to SUGGEST_PROMPT from the environment
         until you create one.</span></div>`
      return
    }

    body.innerHTML = ''
    for (const p of store.prompts) {
      const on = p.id === store.active
      const row = document.createElement('div')
      row.className = on ? 'row on' : 'row'
      row.innerHTML = `
        <span class="ttl"></span>
        <span class="meta"></span>
        <div class="btns">
          ${on ? '<span class="badge">Active</span>'
               : '<button class="use primary">Use this</button>'}
          <button class="edit">Edit</button>
        </div>`

      // textContent, not innerHTML: a title is user text and goes in as
      // text, never as markup.
      ;(row.querySelector('.ttl') as HTMLElement).textContent = p.title
      ;(row.querySelector('.meta') as HTMLElement).textContent =
        `${p.text.length} chars`

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
    const newBtn = root.querySelector('.new') as HTMLButtonElement
    newBtn.disabled = editing !== ''
    if (editing === 'new') return renderEditor(null)
    if (editing) {
      const p = store.prompts.find(q => q.id === editing)
      if (p) return renderEditor(p)
      editing = ''
    }
    renderList()
  }

  ;(root.querySelector('.new') as HTMLButtonElement).onclick = () => {
    editing = 'new'
    render()
  }

  try {
    await load()
    render()
    say('')
  } catch (e) {
    body.innerHTML = `<div class="err">Could not reach gateway: ${
      (e as Error).message
    }<br>Checked ${restBase()}/prompts</div>`
  }
}