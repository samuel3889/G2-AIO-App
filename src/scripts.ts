/**
 * Phone-side teleprompter script library: what the gateway stores in
 * /data/scripts.json, with one marked active.
 *
 * Same shape as prompts.ts — a card in a tab, REST only, no Even Hub SDK
 * calls — and for the same reason: it talks to the gateway over HTTP, so a
 * failed STT socket leaves script editing working.
 *
 * NOT AUTOSAVED, for the reason prompts.ts gives about prompts and notes.ts
 * gives about notes: a script is something someone wrote and expects to
 * still be there, and a half-typed paragraph overwriting it because focus
 * moved is worse than an extra tap. Activate and delete ARE immediate —
 * one tap with a visible result — and delete is armed twice.
 *
 * WHY THE LINE COUNT IS SHOWN
 *
 * A script is read five lines at a time on a 56-character lens, and nothing
 * about a textarea on a phone hints at that. The count comes from
 * telepromptLines(), the SAME function the glasses wrap with, so the number
 * is what the lens will actually produce rather than an estimate that
 * drifts. Paragraph breaks are included, because a blank line is a real row
 * on the lens and a real beat in the read.
 *
 * Endpoints used, all as defined in routes_scripts.py:
 *   GET    /scripts               -> { active, scripts }
 *   POST   /scripts               -> create   { title, text }
 *   PUT    /scripts/{id}          -> update   { title?, text? }
 *   POST   /scripts/{id}/activate
 *   DELETE /scripts/{id}
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'
import {
  telepromptLines,
  telepromptRowH,
  telepromptRowWidth,
  telepromptRowX,
  setTelepromptLayout,
  TELEPROMPT_ROWS,
  TELEPROMPT_FOCUS_ROW,
  SPOKEN_BRIGHTNESS,
  FOCUS_BRIGHTNESS,
  UPCOMING_BRIGHTNESS,
} from './teleprompt'
import { SCREEN_W } from './captions'
import { STATUS_H, SCREEN_H } from './statusbar'

interface StoredScript {
  id: string
  title: string
  text: string
  created: number
  updated: number
}

interface Store {
  active: string
  scripts: StoredScript[]
}

/**
 * Scale of the preview against the real lens.
 *
 * The preview is laid out in TRUE LENS PIXELS - 576 wide, the same row
 * heights and x offsets the glasses get, from the same functions - and then
 * scaled down by CSS transform to fit the phone. Laying it out in phone
 * pixels and converting would be a second implementation of the geometry,
 * which is exactly the thing that drifts from the display it claims to
 * predict.
 *
 * Recomputed on every render from the card's own width, so it survives
 * rotation and a resized window.
 */
const CSS = `
.g2sc .pv-outer { overflow: hidden; border-radius: var(--r2); background: #000; }
.g2sc .pv-lens {
  position: relative; width: ${SCREEN_W}px; height: ${SCREEN_H}px;
  transform-origin: top left; background: #000;
}
.g2sc .pv-row {
  position: absolute; color: #cfe9d8; white-space: pre;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  display: flex; align-items: center;
}
.g2sc .pv-strip {
  position: absolute; left: 0; top: 0; width: ${SCREEN_W}px; height: ${STATUS_H}px;
  color: #6f7f76; font-size: 18px; font-family: ui-monospace, monospace;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 8px; box-sizing: border-box;
}
.g2sc .pv-note { color: var(--text-3); font-size: 12px; margin-top: 8px; }
.g2sc .eff {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; margin-bottom: 12px; border-radius: var(--r2);
  background: var(--sunken); border: 1px solid var(--line-soft);
  font-size: 12px; color: var(--text-2);
}
.g2sc .eff .who { color: var(--info); font-weight: 650; overflow-wrap: anywhere; }
.g2sc .count { color: var(--text-3); font-size: 12px; margin: 6px 0 10px; }
.g2sc .editbar {
  position: sticky; bottom: 0; display: flex; gap: 8px; flex-wrap: wrap;
  padding: 10px 0 2px; margin-top: 4px;
  background: linear-gradient(180deg, rgba(35,35,35,0), var(--surface) 30%);
}
.g2sc .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.g2sc .btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
`

/**
 * Redraw hook, set while the Scripts panel is mounted.
 *
 * main.ts wires the layout sliders' onChange straight into this, so moving
 * one redraws the preview without the panel having to poll /settings. Null
 * when the panel has not mounted, which is why the export is a function
 * rather than the variable: a consumer holding the variable would capture
 * null forever.
 */
let previewRedraw: ((values: Record<string, number>) => void) | null = null

/** Apply gateway tunables to the preview. Safe to call before mount. */
export function applyTelepromptPreview(values: Record<string, number>): void {
  previewRedraw?.(values)
}

export async function mountScripts(host?: HTMLElement) {
  installTheme()

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2sc'
  root.style.order = String(PANEL_ORDER.scripts)
  ;(host ?? document.body).appendChild(root)

  const card = makeCard({
    title: 'Teleprompter scripts',
    sub: 'The active script is what Teleprompt opens on the glasses',
    icon: 'edit',
    collapsible: true,
    open: true,
    memory: 'scripts',
  })
  const chip = document.createElement('span')
  chip.className = 'chip mute'
  chip.textContent = '—'
  card.aside.appendChild(chip)

  card.body.innerHTML = `
    <div class="eff"><span>Active</span><span class="who">loading…</span></div>
    <div class="body"></div>
    <div class="btns">
      <button class="btn sm new" type="button">${icon('plus')}<span>New script</span></button>
      <span class="state"></span>
    </div>`
  root.appendChild(card.root)

  // --- lens preview -------------------------------------------------------
  const pv = makeCard({
    title: 'Lens preview',
    sub: 'How the active script will look on the glasses',
    icon: 'disc',
    collapsible: true,
    open: true,
    memory: 'scripts-preview',
  })
  pv.body.innerHTML = `
    <div class="pv-outer"><div class="pv-lens"></div></div>
    <div class="pv-note"></div>`
  root.appendChild(pv.root)

  const pvOuter = pv.body.querySelector('.pv-outer') as HTMLElement
  const pvLens = pv.body.querySelector('.pv-lens') as HTMLElement
  const pvNote = pv.body.querySelector('.pv-note') as HTMLElement

  const effWho = card.body.querySelector('.eff .who') as HTMLElement
  const body = card.body.querySelector('.body') as HTMLElement
  const stateEl = card.body.querySelector('.state') as HTMLElement
  const newBtn = card.body.querySelector('.new') as HTMLButtonElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  let store: Store = { active: '', scripts: [] }

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
    store = await call('/scripts')
  }

  /**
   * The script the glasses would open right now.
   *
   * MIRRORS THE GATEWAY, deliberately. ScriptStore.active_script() is
   * `self.get(self.active) or self.scripts[0]`: a stale active pointer
   * degrades to the first script rather than to a blank prompter. Resolving
   * only by `store.active` here would show "(none)" for a case where the
   * glasses will happily open scripts[0] — a worse lie than showing the
   * fallback.
   */
  function activeScript(): StoredScript | null {
    return store.scripts.find(s => s.id === store.active) ?? store.scripts[0] ?? null
  }

  /** The header chip is a few centimetres wide; an 80-char title is not. */
  function ellipsis(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`
  }

  /**
   * Lens lines a script wraps to, and screens at five lines a screen.
   *
   * telepromptLines() is the glasses' own wrapper, so this is the real
   * figure. Screens is a rough sense of length rather than a page count —
   * the prompter scrolls by ONE line, not by five, so there are no discrete
   * pages to count.
   */
  function lensStats(text: string): string {
    const lines = telepromptLines(text).length
    const screens = Math.max(1, Math.ceil(lines / TELEPROMPT_ROWS))
    return `${text.length} chars · ${lines} lens lines · about ${screens} screens`
  }

  // ------------------------------------------------------------- editor

  function renderEditor(s: StoredScript | null) {
    const isNew = s === null
    body.innerHTML = `
      <div class="lbl">Title</div>
      <input class="inp t" type="text" maxlength="80" placeholder="e.g. Conference opening">
      <div class="lbl">Script</div>
      <textarea class="inp x" spellcheck="true"></textarea>
      <div class="count"></div>
      <div class="editbar">
        <button class="btn primary save" type="button">${icon('check')}<span>Save</span></button>
        <button class="btn ghost cancel" type="button">Cancel</button>
        ${isNew ? '' : `<button class="btn danger del" type="button">${icon('trash')}<span>Delete</span></button>`}
      </div>`

    const t = body.querySelector('.t') as HTMLInputElement
    const x = body.querySelector('.x') as HTMLTextAreaElement
    const count = body.querySelector('.count') as HTMLElement

    t.value = s?.title ?? ''
    x.value = s?.text ?? ''

    // spellcheck is ON here and off in prompts.ts, deliberately: a prompt is
    // instructions to a model and full of jargon, a script is prose someone
    // will read aloud in front of people.
    const paintCount = () => {
      count.textContent = lensStats(x.value)
    }
    x.oninput = () => {
      paintCount()
      renderPreview()
    }
    paintCount()

    ;(body.querySelector('.cancel') as HTMLButtonElement).onclick = () => {
      editing = ''
      render()
    }

    ;(body.querySelector('.save') as HTMLButtonElement).onclick = async () => {
      if (!x.value.trim()) {
        say('script is empty', true)
        return
      }
      try {
        say('saving…')
        store = isNew
          ? await call('/scripts', json({ title: t.value, text: x.value }))
          : await call(`/scripts/${s!.id}`, {
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
        // Two taps, because there is no undo and a deleted script may be the
        // only copy of something someone wrote.
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1'
          del.classList.add('armed')
          del.innerHTML = `${icon('trash')}<span>Tap again to delete</span>`
          return
        }
        try {
          await call(`/scripts/${s!.id}`, { method: 'DELETE' })
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
    if (!store.scripts.length) {
      body.innerHTML = `<div class="empty">No scripts yet. Create one and the
        Teleprompt item on the glasses will open it.</div>`
      return
    }

    body.innerHTML = ''
    for (const s of store.scripts) {
      const on = s.id === store.active
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
      ;(row.querySelector('.ttl') as HTMLElement).textContent = s.title
      ;(row.querySelector('.meta') as HTMLElement).textContent = lensStats(s.text)

      const use = row.querySelector('.use') as HTMLButtonElement | null
      if (use) {
        use.onclick = async () => {
          try {
            await call(`/scripts/${s.id}/activate`, { method: 'POST' })
            await load()
            render()
            say('active script changed')
          } catch (e) {
            say(`activate failed: ${(e as Error).message}`, true)
          }
        }
      }

      ;(row.querySelector('.edit') as HTMLButtonElement).onclick = () => {
        editing = s.id
        render()
      }

      body.appendChild(row)
    }
  }

  /**
   * Draw the preview.
   *
   * TRUE LENS PIXELS, then scaled. Row height, width and x offset all come
   * from teleprompt.ts - the same functions that build the containers the
   * glasses receive - so the preview cannot drift from the display it claims
   * to predict. Only the FONT is an approximation: the lens font is not a
   * monospace and this is, sized so that one character advance matches the
   * measured px-per-character. Wrapping is exact because telepromptLines()
   * does it; only the letterforms differ.
   */
  function renderPreview() {
    const text = previewText()
    const lines = telepromptLines(text)
    const rowH = telepromptRowH()
    const w = telepromptRowWidth()
    const x = telepromptRowX()

    // A middle-of-the-script view rather than the opening lines: the focus
    // row with delivered text above it and upcoming text below is what the
    // wearer spends the read looking at, and it is the only state that shows
    // all three brightness levels at once.
    const cursor = Math.min(TELEPROMPT_FOCUS_ROW, Math.max(0, lines.length - 1))
    const top = cursor - TELEPROMPT_FOCUS_ROW

    // 4 brightness steps map onto opacity. The lens is a monochrome
    // projection onto glass and the phone is a backlit panel, so this is a
    // resemblance, not a match - it shows the RELATIVE separation between
    // spoken, current and upcoming, which is the thing being tuned.
    const dim = (b: number) => (b === 0 ? 0.3 : 0.3 + (b / 4) * 0.7)

    const rows: string[] = []
    for (let row = 0; row < TELEPROMPT_ROWS; row++) {
      const i = top + row
      const content = i >= 0 && i < lines.length ? lines[i] : ''
      const b =
        row < TELEPROMPT_FOCUS_ROW
          ? SPOKEN_BRIGHTNESS
          : row === TELEPROMPT_FOCUS_ROW
            ? FOCUS_BRIGHTNESS
            : UPCOMING_BRIGHTNESS
      const style =
        `left:${x}px;top:${STATUS_H + row * rowH}px;` +
        `width:${w}px;height:${rowH}px;opacity:${dim(b)};` +
        // 0.6em is the advance of a typical monospace glyph, so this sizes
        // one character to the lens's measured px-per-character.
        `font-size:${((SCREEN_W - 8) / 56 / 0.6).toFixed(1)}px;padding:0 4px;` +
        'box-sizing:border-box'
      const div = document.createElement('div')
      div.className = 'pv-row'
      div.setAttribute('style', style)
      // textContent, not innerHTML: this is user-written script text.
      div.textContent = content
      rows.push(div.outerHTML)
    }

    pvLens.innerHTML =
      '<div class="pv-strip"><span>12:00</span><span>0:00</span></div>' +
      rows.join('')

    // Scale to the card, in JS rather than CSS, because transform needs a
    // number and the lens box is a fixed 576px by design.
    const avail = pvOuter.clientWidth || SCREEN_W
    const k = avail / SCREEN_W
    pvLens.style.transform = `scale(${k})`
    // The outer box has to be told the scaled height; a transform does not
    // affect layout, so without this the card collapses to nothing.
    pvOuter.style.height = `${Math.round(SCREEN_H * k)}px`

    pvNote.textContent = lines.length
      ? `${lines.length} lens lines · ${telepromptRowH()}px spacing`
      : 'No script to preview yet.'
  }

  /** What the preview shows: the open editor if there is one, else active. */
  function previewText(): string {
    const x = body.querySelector('.x') as HTMLTextAreaElement | null
    if (x) return x.value
    return activeScript()?.text ?? ''
  }

  // Layout sliders live on this tab too, mounted by main.ts, and their
  // onChange lands here. setTelepromptLayout is the SAME clamp the lens
  // applies, so an out-of-range stored value previews as what the glasses
  // would actually show rather than as what was asked for.
  previewRedraw = (values: Record<string, number>) => {
    setTelepromptLayout({
      rowH: values.teleprompt_row_h,
      chars: values.teleprompt_chars,
    })
    renderPreview()
  }

  window.addEventListener('resize', renderPreview)

  function paintActive() {
    const s = activeScript()
    if (!s) {
      effWho.textContent = '(none)'
      chip.textContent = '—'
      chip.className = 'chip mute'
      return
    }
    effWho.textContent = `${s.title} · ${lensStats(s.text)}`
    chip.textContent = ellipsis(s.title, 18)
    chip.className = 'chip info'
  }

  function render() {
    paintActive()
    renderPreview()
    newBtn.disabled = editing !== ''
    if (editing === 'new') return renderEditor(null)
    if (editing) {
      const s = store.scripts.find(q => q.id === editing)
      if (s) return renderEditor(s)
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
    ;(body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/scripts`
  }
}