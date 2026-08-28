/**
 * Live tuning panel for the phone screen.
 *
 * Fetches the tunable schema from the gateway and builds controls from it, so
 * adding a tunable server-side still needs no change here. Changes are
 * debounced, PUT to the gateway, and persisted server-side — they survive app
 * restarts and stack recomposes.
 *
 * Sliders are custom rather than <input type=range> because native ranges jump
 * to wherever you tap, which makes scrolling past them change their value. Here
 * the track ignores touches entirely: only a drag that STARTS on the thumb moves
 * anything. Vertical scroll passes straight through. That behaviour is
 * unchanged — only the skin around it is new.
 *
 * WHAT CHANGED IN THIS PASS
 *  - Twenty-five sliders in one flat column is a wall. They are now sorted into
 *    collapsible sections whose open/closed state is remembered.
 *  - Voice activity was nine of the twenty-seven sliders - a third of the panel
 *    back in one card, which is the wall again in miniature. It splits along a
 *    real seam rather than an arbitrary one: the level gates answer "is this
 *    speech at all", the boundary values answer "where does this utterance
 *    begin and end". Different questions, different units, tuned at different
 *    times. Section ids changed with it ('voice' -> 'voice_level' and
 *    'voice_timing'), so the remembered open/closed state for the old section
 *    is orphaned under 'tune:voice' and both new sections start closed once.
 *  - THE GROUPING IS CLIENT-SIDE. tunables.py's TUNABLES entries carry
 *    key/label/help/env/type/min/max/step/default/unit and NO group field, so
 *    nothing here reads one. GROUPS below lists known keys by hand, and any key
 *    the server sends that is not listed falls into "Other" rather than
 *    vanishing — a new server-side tunable still appears without a phone build.
 *    That safety net is also the trap: timer_alert_s was added to tunables.py
 *    and silently sat in "Other" until someone noticed. Every key in tunables.py
 *    as of this pass is now listed above; check this list when adding one.
 *  - Reset arms on the first tap and fires on the second. Note it restores the
 *    ENV defaults (tunables.py Settings.reset uses _env_defaults), which are the
 *    .env values where set and the schema defaults otherwise. The button says so
 *    rather than claiming "factory defaults".
 *  - A failed load now offers Retry instead of a dead end.
 *
 * MOUNTED MORE THAN ONCE, since the Translate tab landed. mountSettings()
 * takes an options bag that filters the schema, so the same fetch, the same
 * slider and the same debounced PUT serve both:
 *
 *   mountSettings(tabs.Live, { omit: ['translate_hold_s'] })
 *   mountSettings(tabs.Translate, { only: ['translate_hold_s'], header: false })
 *
 * A tunable belongs beside the feature it tunes. Translation hold was three
 * cards down a panel on a different tab from the thing it changes, which is
 * how timer_alert_s sat unnoticed in "Other" for a while.
 *
 * The two instances do NOT share state: each fetches /settings and holds its
 * own copy. That is a real limitation and an accepted one - the only value
 * they both render would be one listed in `only` AND not in `omit`, which is
 * a configuration mistake rather than a case to design for. Changes from
 * either are written to the gateway and both re-read on the next app start.
 *
 * The gateway URL rule and the token live in api.ts. Endpoints used, all as
 * defined in routes_settings.py:
 *   GET  /settings         -> { schema, values }
 *   PUT  /settings         -> { values, changed }
 *   POST /settings/reset   -> { values }
 */
import { restBase, restUrl } from './api'
import { installTheme, makeCard, icon, PANEL_ORDER } from './theme'

export interface SettingsOptions {
  /**
   * Render ONLY these keys. Everything else in the schema is ignored, and a
   * key listed here that the gateway does not send simply does not appear -
   * so a panel pinned to a tunable that was later renamed goes empty rather
   * than breaking the tab.
   */
  only?: string[]
  /** Render everything EXCEPT these keys. Ignored when `only` is given. */
  omit?: string[]
  /**
   * Show the "Tuning" header card with the Reset all button. Default true.
   *
   * False for a subset panel: "Reset all" there would reset every tunable in
   * the app, from a card that appears to be about one slider.
   */
  header?: boolean
}

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

interface Group {
  id: string
  title: string
  sub: string
  icon: string
  keys: string[]
}

/**
 * Curated order. Keys are taken verbatim from tunables.py TUNABLES; a key that
 * is renamed server-side simply drops into "Other" until it is listed here.
 */
const GROUPS: Group[] = [
  {
    id: 'voice_level',
    title: 'What counts as speech',
    sub: 'The loudness and voicedness gates',
    icon: 'gauge',
    keys: ['min_rms', 'armed_min_rms', 'min_voiced_ratio', 'vad_aggressiveness'],
  },
  {
    id: 'voice_timing',
    title: 'Utterance boundaries',
    sub: 'Where an utterance starts, ends, and gets cut',
    icon: 'span',
    keys: [
      'preroll_ms',
      'hangover_ms',
      'min_utterance_ms',
      'max_utterance_ms',
      'hallucination_max_ms',
    ],
  },
  {
    id: 'speaker',
    title: 'Speaker separation',
    sub: 'Carving a recording into distinct voices',
    icon: 'users',
    keys: ['speaker_min_ms', 'speaker_match', 'speaker_new', 'speaker_max', 'split_drop'],
  },
  {
    id: 'roster',
    title: 'Names & roster',
    sub: 'Matching a voice to a stored name',
    icon: 'tag',
    keys: ['roster_match', 'roster_margin', 'live_roster_match', 'live_roster_margin'],
  },
  {
    id: 'suggest',
    title: 'Suggestions',
    sub: 'The proactive prompts on the lens',
    icon: 'spark',
    keys: [
      'suggest_every_utts',
      'suggest_cooldown_s',
      'suggest_context_utts',
      'suggest_timeout_s',
      'suggest_hold_s',
      'suggest_memory',
      'suggest_dup_ratio',
    ],
  },
  {
    id: 'clips',
    title: 'Review audio',
    sub: 'How long clips stay on disk',
    icon: 'disc',
    keys: ['clip_retention_h'],
  },
  {
    id: 'timers',
    title: 'Timers',
    sub: 'The full-screen alert when a timer ends',
    icon: 'clock',
    keys: ['timer_alert_s'],
  },
  {
    id: 'notes',
    title: 'Notes',
    sub: 'The full-screen alert when a note comes due',
    icon: 'clock',
    keys: ['note_alert_s'],
  },
  {
    id: 'translate',
    title: 'Lens timing',
    sub: 'How long a translated line stays up',
    icon: 'clock',
    keys: ['translate_hold_s'],
  },
]

const CSS = `
.g2s .srow { padding: 14px 0; border-top: 1px solid var(--line-soft); }
.g2s .srow:first-child { border-top: 0; padding-top: 6px; }

.g2s .top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.g2s .name { font: 650 14px/1.3 var(--font); }
.g2s .val {
  flex: 0 0 auto; font: 700 13px/1 var(--mono); font-variant-numeric: tabular-nums;
  color: var(--accent); background: var(--accent-dim);
  border: 1px solid rgba(60,250,68,.28); border-radius: 8px; padding: 5px 8px;
}
.g2s .help { color: var(--text-3); font-size: 12px; line-height: 1.45; margin: 5px 0 4px; }

/* Whole control allows vertical panning; only the thumb captures gestures. */
.g2s .ctl { display: flex; align-items: center; gap: 10px; touch-action: pan-y; }

.g2s .track { position: relative; flex: 1 1 auto; height: 44px; touch-action: pan-y; }
.g2s .rail {
  position: absolute; top: 50%; left: 0; right: 0; height: 4px; margin-top: -2px;
  background: #3A3A3A; border-radius: 2px;
}
.g2s .fill {
  position: absolute; top: 50%; left: 0; height: 4px; margin-top: -2px;
  background: var(--accent); border-radius: 2px;
}

/* 44px hit area, 20px visual. touch-action:none so a horizontal drag that
   starts here is ours and does not also scroll the page. */
.g2s .thumb {
  position: absolute; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px;
  touch-action: none;
}
.g2s .thumb::after {
  content: ''; position: absolute; left: 12px; top: 12px; width: 20px; height: 20px;
  border-radius: 50%; background: var(--accent);
  box-shadow: 0 1px 5px rgba(0,0,0,.65), 0 0 0 4px rgba(60,250,68,.10);
  transition: width .1s var(--ease), height .1s var(--ease), left .1s var(--ease), top .1s var(--ease);
}
.g2s .thumb.drag::after {
  left: 8px; top: 8px; width: 28px; height: 28px;
  background: #8CFF92; box-shadow: 0 2px 8px rgba(0,0,0,.7), 0 0 0 8px rgba(60,250,68,.14);
}

.g2s .step {
  flex: 0 0 auto; width: 38px; height: 38px; border-radius: 10px;
  background: var(--surface); color: var(--text-2); border: 1px solid var(--line);
  font: 400 20px/1 var(--font); touch-action: manipulation;
}
.g2s .step:active { background: #383838; color: var(--text); }
`

export async function mountSettings(
  host?: HTMLElement,
  opts: SettingsOptions = {},
) {
  installTheme()
  const showHeader = opts.header !== false

  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2-stack g2s'
  // The host is a flex column, so `order` decides where this stacks - not
  // the order it was mounted in. Tuning goes last on whatever tab it is on.
  root.style.order = String(PANEL_ORDER.tuning)
  ;(host ?? document.body).appendChild(root)

  // --- header card, always present ----------------------------------------
  const head = makeCard({
    title: 'Tuning',
    sub: 'Applies live · stored on the gateway',
    icon: 'sliders',
  })
  const badge = document.createElement('span')
  badge.className = 'chip mute'
  badge.textContent = 'Loading'
  head.aside.appendChild(badge)

  head.body.innerHTML = `
    <div class="note">Drag a circle to adjust, or use −/+ for a single step.
      Every change is saved on the gateway and survives an app restart.</div>
    <div class="btnrow" style="margin-top:12px">
      <button class="btn danger reset" type="button">${icon('reset')}<span>Reset all</span></button>
      <span class="state"></span>
    </div>`
  // Built either way, appended only when wanted. Everything below writes to
  // `badge` and `stateEl` unconditionally; leaving the card detached lets
  // those writes be harmless no-ops rather than needing a null check at
  // every call site.
  if (showHeader) root.appendChild(head.root)

  const stateEl = head.body.querySelector('.state') as HTMLElement
  const resetBtn = head.body.querySelector('.reset') as HTMLButtonElement

  const say = (m: string, err = false) => {
    stateEl.textContent = m
    stateEl.className = err ? 'state err' : 'state'
  }

  const setBadge = (text: string, kind: string) => {
    badge.textContent = text
    badge.className = `chip ${kind}`
  }

  let schema: Tunable[] = []
  let values: Record<string, number> = {}

  async function load() {
    const r = await fetch(restUrl('/settings'))
    if (!r.ok) throw new Error(`${r.status}`)
    const d = await r.json()
    // Filtered HERE, once, rather than in bucket() and again in render():
    // everything downstream then works on the schema this panel owns and
    // needs no idea that a subset is possible. `values` is deliberately NOT
    // filtered - it is only ever read by key.
    schema = filterSchema(d.schema)
    values = d.values
  }

  // Debounced so dragging fires one write, not fifty.
  let timer: number | null = null
  let pending: Record<string, number> = {}

  function push(key: string, v: number) {
    pending[key] = v
    setBadge('Saving', 'warn')
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
        setBadge('Saved', 'ok')
        say('')
      } catch (e) {
        setBadge('Failed', 'bad')
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
    row.className = 'srow'
    row.innerHTML = `
      <div class="top"><span class="name"></span><span class="val num"></span></div>
      <div class="help"></div>
      <div class="ctl">
        <button class="step minus" type="button" aria-label="decrease">−</button>
        <div class="track"><div class="rail"></div><div class="fill"></div>
        <div class="thumb" role="slider"></div></div>
        <button class="step plus" type="button" aria-label="increase">+</button>
      </div>`

    // textContent, not innerHTML: label and help come off the wire.
    ;(row.querySelector('.name') as HTMLElement).textContent = t.label
    ;(row.querySelector('.help') as HTMLElement).textContent = t.help

    const valEl = row.querySelector('.val') as HTMLElement
    const track = row.querySelector('.track') as HTMLElement
    const fill = row.querySelector('.fill') as HTMLElement
    const thumb = row.querySelector('.thumb') as HTMLElement

    thumb.setAttribute('aria-valuemin', String(t.min))
    thumb.setAttribute('aria-valuemax', String(t.max))
    thumb.setAttribute('aria-label', t.label)

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
  let sectionCards: HTMLElement[] = []

  /**
   * Narrow the gateway's schema to what this panel is for.
   *
   * `only` wins over `omit` when both are given; that combination is a
   * configuration mistake rather than a case worth resolving cleverly.
   */
  function filterSchema(all: Tunable[]): Tunable[] {
    if (opts.only) {
      const want = new Set(opts.only)
      return all.filter(t => want.has(t.key))
    }
    if (opts.omit) {
      const drop = new Set(opts.omit)
      return all.filter(t => !drop.has(t.key))
    }
    return all
  }

  /** Split the schema into GROUPS order, leftovers last, nothing dropped. */
  function bucket(): Array<{ g: Group; items: Tunable[] }> {
    const byKey = new Map(schema.map(t => [t.key, t]))
    const used = new Set<string>()
    const out: Array<{ g: Group; items: Tunable[] }> = []

    for (const g of GROUPS) {
      const items: Tunable[] = []
      for (const k of g.keys) {
        const t = byKey.get(k)
        if (t) { items.push(t); used.add(k) }
      }
      if (items.length) out.push({ g, items })
    }

    const rest = schema.filter(t => !used.has(t.key))
    if (rest.length) {
      out.push({
        g: { id: 'other', title: 'Other', sub: 'Not yet grouped on the phone',
             icon: 'sliders', keys: [] },
        items: rest,
      })
    }
    return out
  }

  function render() {
    for (const el of sectionCards) el.remove()
    sectionCards = []
    painters = []

    const buckets = bucket()
    buckets.forEach(({ g, items }, i) => {
      const card = makeCard({
        title: g.title,
        sub: g.sub,
        icon: g.icon,
        collapsible: true,
        // First section open on a fresh install; after that the phone
        // remembers what you left open.
        open: i === 0,
        // A subset panel gets its OWN memory key. Otherwise the Translation
        // card on the Translate tab and the same-named card in the full
        // panel would fold each other, which reads as the app forgetting.
        memory: opts.only ? `tune:${g.id}:sub` : `tune:${g.id}`,
      })

      const count = document.createElement('span')
      count.className = 'chip mute'
      count.textContent = String(items.length)
      card.aside.appendChild(count)

      for (const t of items) {
        const { row, paint } = buildRow(t)
        card.body.appendChild(row)
        painters.push(paint)
      }

      root.appendChild(card.root)
      sectionCards.push(card.root)
    })

    setBadge(`${schema.length} values`, 'mute')
  }

  // Two taps: a mis-tap here throws away an evening of tuning.
  let armed = false
  resetBtn.onclick = async () => {
    if (!armed) {
      armed = true
      resetBtn.classList.add('armed')
      resetBtn.innerHTML = `${icon('reset')}<span>Tap again to reset</span>`
      say('restores the .env values, not the slider defaults')
      window.setTimeout(() => {
        if (!armed) return
        armed = false
        resetBtn.classList.remove('armed')
        resetBtn.innerHTML = `${icon('reset')}<span>Reset all</span>`
        say('')
      }, 4000)
      return
    }
    armed = false
    resetBtn.classList.remove('armed')
    resetBtn.innerHTML = `${icon('reset')}<span>Reset all</span>`
    try {
      const r = await fetch(restUrl('/settings/reset'), { method: 'POST' })
      if (!r.ok) throw new Error(`${r.status}`)
      values = (await r.json()).values
      painters.forEach(p => p())
      setBadge('Reset', 'ok')
      say('reset to .env defaults')
    } catch (e) {
      setBadge('Failed', 'bad')
      say(`reset failed: ${(e as Error).message}`, true)
    }
  }

  async function boot() {
    try {
      await load()
      render()
      say('')
    } catch (e) {
      for (const el of sectionCards) el.remove()
      sectionCards = []
      setBadge('Offline', 'bad')

      const fail = makeCard({ title: 'Gateway unreachable', icon: 'sliders' })
      fail.body.innerHTML = `
        <div class="err"></div>
        <div class="note" style="margin-top:6px">Checked <span class="mono url"></span></div>
        <div class="btnrow" style="margin-top:12px">
          <button class="btn retry" type="button">${icon('refresh')}<span>Retry</span></button>
        </div>`
      ;(fail.body.querySelector('.err') as HTMLElement).textContent =
        `Could not load tuning: ${(e as Error).message}`
      ;(fail.body.querySelector('.url') as HTMLElement).textContent = `${restBase()}/settings`
      ;(fail.body.querySelector('.retry') as HTMLButtonElement).onclick = () => {
        fail.root.remove()
        setBadge('Loading', 'mute')
        void boot()
      }
      root.appendChild(fail.root)
      sectionCards.push(fail.root)
    }
  }

  await boot()
}