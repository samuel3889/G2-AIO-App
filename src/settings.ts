/**
 * Live tuning panel for the phone screen.
 *
 * Fetches the tunable schema from the gateway and builds controls from it,
 * so adding a tunable server-side needs no change here. Changes are
 * debounced, PUT to the gateway, and persisted server-side - they survive
 * app restarts and stack recomposes.
 *
 * Sliders are custom rather than <input type=range> because native ranges
 * jump to wherever you tap, which makes scrolling past them change their
 * value. Here the track ignores touches entirely: only a drag that STARTS
 * on the thumb moves anything. Vertical scroll passes straight through.
 *
 * Add one line to main.ts:
 *     import { mountSettings } from './settings'
 *     mountSettings()
 *
 * The gateway URL rule and the token live in api.ts. This file used to carry
 * its own copy of restBase() plus a local url() helper; both were removed in
 * favour of restBase()/restUrl(). Neither call site here carries a query
 * string, so restUrl()'s `?` vs `&` handling is a no-op today and correct if
 * one ever does.
 */
import { restBase, restUrl } from './api'

interface Tunable {
  key: string
  label: string
  help: string
  type: 'int' | 'float'
  min: number
  max: number
  step: number
  unit: string
}

const CSS = `
.g2s { font: 14px/1.4 system-ui, sans-serif; padding: 12px; max-width: 560px;
       margin: 12px auto; background: #111; color: #eee; border-radius: 10px; }
.g2s h3 { margin: 0 0 4px; font-size: 15px; }
.g2s .sub { color: #888; font-size: 12px; margin-bottom: 14px; }
.g2s .row { margin-bottom: 18px; }
.g2s .top { display: flex; justify-content: space-between; align-items: baseline; }
.g2s .lbl { font-weight: 600; }
.g2s .val { font-variant-numeric: tabular-nums; color: #6cf; }
.g2s .help { color: #888; font-size: 12px; margin: 2px 0 8px; }

/* Whole control allows vertical panning; only the thumb captures gestures. */
.g2s .ctl { display: flex; align-items: center; gap: 10px; touch-action: pan-y; }

.g2s .track { position: relative; flex: 1; height: 44px; touch-action: pan-y; }
.g2s .rail { position: absolute; top: 50%; left: 0; right: 0; height: 4px;
             margin-top: -2px; background: #333; border-radius: 2px; }
.g2s .fill { position: absolute; top: 50%; left: 0; height: 4px;
             margin-top: -2px; background: #6cf; border-radius: 2px; }

/* 44px hit area, 20px visual. touch-action:none so a horizontal drag that
   starts here is ours and does not also scroll the page. */
.g2s .thumb { position: absolute; top: 50%; width: 44px; height: 44px;
              margin: -22px 0 0 -22px; touch-action: none; cursor: grab; }
.g2s .thumb::after { content: ''; position: absolute; left: 12px; top: 12px;
              width: 20px; height: 20px; border-radius: 50%; background: #6cf;
              box-shadow: 0 1px 4px rgba(0,0,0,.6); }
.g2s .thumb.drag { cursor: grabbing; }
.g2s .thumb.drag::after { left: 9px; top: 9px; width: 26px; height: 26px;
              background: #9df; }

.g2s .step { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 8px;
             background: #262626; color: #ddd; border: 0; font-size: 17px;
             line-height: 1; touch-action: manipulation; }
.g2s .step:active { background: #3a3a3a; }

.g2s .bar { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.g2s button.reset { background: #333; color: #eee; border: 0; border-radius: 6px;
              padding: 9px 12px; font-size: 13px; }
.g2s .state { font-size: 12px; color: #888; }
.g2s .err { color: #f66; }
`

export async function mountSettings(host?: HTMLElement) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2s'
  root.innerHTML = `<h3>Tuning</h3>
    <div class="sub">Drag the circle to adjust. Applies live, saved on the server.</div>
    <div class="body">loading…</div>
    <div class="bar"><button class="reset">Reset to defaults</button>
    <span class="state"></span></div>`
  ;(host ?? document.body).appendChild(root)

  const body = root.querySelector('.body') as HTMLElement
  const state = root.querySelector('.state') as HTMLElement

  const say = (m: string, err = false) => {
    state.textContent = m
    state.className = err ? 'state err' : 'state'
  }

  let schema: Tunable[] = []
  let values: Record<string, number> = {}

  async function load() {
    const r = await fetch(restUrl('/settings'))
    if (!r.ok) throw new Error(`${r.status}`)
    const d = await r.json()
    schema = d.schema
    values = d.values
  }

  // Debounced so dragging fires one write, not fifty.
  let timer: number | null = null
  let pending: Record<string, number> = {}

  function push(key: string, v: number) {
    pending[key] = v
    if (timer !== null) return
    timer = window.setTimeout(async () => {
      timer = null
      const patch = pending
      pending = {}
      try {
        const r = await fetch(restUrl('/settings'), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        })
        if (!r.ok) throw new Error(`${r.status}`)
        values = (await r.json()).values
        say('saved')
      } catch (e) {
        say(`save failed: ${(e as Error).message}`, true)
      }
    }, 250)
  }

  function fmt(t: Tunable, v: number) {
    const n = t.type === 'float' ? v.toFixed(2) : String(Math.round(v))
    return t.unit ? `${n} ${t.unit}` : n
  }

  function snap(t: Tunable, v: number) {
    const stepped = Math.round((v - t.min) / t.step) * t.step + t.min
    const clamped = Math.min(Math.max(stepped, t.min), t.max)
    // Kill float drift from repeated step arithmetic (0.30000000000000004).
    return t.type === 'float' ? Math.round(clamped * 1000) / 1000 : Math.round(clamped)
  }

  function buildRow(t: Tunable) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <div class="top"><span class="lbl">${t.label}</span><span class="val"></span></div>
      <div class="help">${t.help}</div>
      <div class="ctl">
        <button class="step minus" aria-label="decrease">−</button>
        <div class="track"><div class="rail"></div><div class="fill"></div>
        <div class="thumb" role="slider"></div></div>
        <button class="step plus" aria-label="increase">+</button>
      </div>`

    const valEl = row.querySelector('.val') as HTMLElement
    const track = row.querySelector('.track') as HTMLElement
    const fill = row.querySelector('.fill') as HTMLElement
    const thumb = row.querySelector('.thumb') as HTMLElement

    const paint = () => {
      const v = values[t.key]
      const pct = ((v - t.min) / (t.max - t.min)) * 100
      thumb.style.left = `${pct}%`
      fill.style.width = `${pct}%`
      valEl.textContent = fmt(t, v)
      thumb.setAttribute('aria-valuenow', String(v))
    }

    const setValue = (v: number, write = true) => {
      const next = snap(t, v)
      if (next === values[t.key]) return
      values[t.key] = next
      paint()
      if (write) push(t.key, next)
    }

    // --- drag, thumb only -------------------------------------------------
    // pointerdown is bound to the THUMB, never the track. A touch that lands
    // on the rail does nothing, so scrolling past a slider is safe.
    thumb.addEventListener('pointerdown', ev => {
      ev.preventDefault()
      ev.stopPropagation()
      thumb.classList.add('drag')
      thumb.setPointerCapture(ev.pointerId)

      const rect = track.getBoundingClientRect()

      const move = (e: PointerEvent) => {
        const pct = (e.clientX - rect.left) / rect.width
        setValue(t.min + pct * (t.max - t.min))
      }
      const up = (e: PointerEvent) => {
        thumb.classList.remove('drag')
        try { thumb.releasePointerCapture(e.pointerId) } catch { /* gone */ }
        thumb.removeEventListener('pointermove', move)
        thumb.removeEventListener('pointerup', up)
        thumb.removeEventListener('pointercancel', up)
      }

      thumb.addEventListener('pointermove', move)
      thumb.addEventListener('pointerup', up)
      thumb.addEventListener('pointercancel', up)
    })

    // --- step buttons, for precision -------------------------------------
    ;(row.querySelector('.minus') as HTMLButtonElement).onclick = () =>
      setValue(values[t.key] - t.step)
    ;(row.querySelector('.plus') as HTMLButtonElement).onclick = () =>
      setValue(values[t.key] + t.step)

    paint()
    return { row, paint }
  }

  let painters: Array<() => void> = []

  function render() {
    body.innerHTML = ''
    painters = []
    for (const t of schema) {
      const { row, paint } = buildRow(t)
      body.appendChild(row)
      painters.push(paint)
    }
  }

  ;(root.querySelector('.reset') as HTMLButtonElement).onclick = async () => {
    try {
      const r = await fetch(restUrl('/settings/reset'), { method: 'POST' })
      values = (await r.json()).values
      painters.forEach(p => p())
      say('reset to .env defaults')
    } catch (e) {
      say(`reset failed: ${(e as Error).message}`, true)
    }
  }

  try {
    await load()
    render()
    say('')
  } catch (e) {
    body.innerHTML = `<div class="err">Could not reach gateway: ${
      (e as Error).message
    }<br>Checked ${restBase()}/settings</div>`
  }
}