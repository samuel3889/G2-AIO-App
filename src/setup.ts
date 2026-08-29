/**
 * What the next recording will actually run with: prep note, suggestion
 * prompt, summary prompt — resolved the same way the gateway resolves them.
 *
 * WHY THIS IS SHARED AND NOT COPIED INTO EACH PANEL
 *
 * Three stores each have their own active pointer, each with its own fallback
 * rule, and one of them (summary) now picks between two pointers depending on
 * whether a prep note is attached. That is four rules. A panel that
 * reimplements them drifts from the gateway silently, and the symptom is a
 * screen that says one thing while the log says another — which is exactly
 * the confusion the `effective` blocks were added to end.
 *
 * THE RESOLUTION RULES, EACH MIRRORING ITS SERVER-SIDE COUNTERPART
 *
 *   prep     PrepStore.active_prep(): resolve `active`, NO fallback. An empty
 *            pointer means no prep note, which is a real choice, not a gap.
 *
 *   suggest  PromptStore.active_prompt(has_prep): the SAME two-pointer rule
 *            as summary below. A stale pointer degrades to a working prompt
 *            rather than to silence, so the panel shows the fallback rather
 *            than a blank.
 *
 *   summary  SummaryPromptStore.active_prompt(has_prep): when a prep note is
 *            attached AND active_prep is set AND resolves, that wins;
 *            otherwise fall THROUGH to the default rule above.
 *
 * WHAT IS AND IS NOT LOCKED ONCE RECORDING STARTS
 *
 * Only the prep note. gateway.py captures a COPY at session_start and holds it
 * for the life of the recording, so changing the active note mid-class does
 * nothing until the next one.
 *
 * The other two are read late and can be changed mid-recording:
 *   - the suggestion prompt is re-read on EVERY suggest attempt
 *   - the summary prompt is read when the recording STOPS
 *
 * The panel says so per row rather than describing the whole block as fixed,
 * because "these cannot be changed later" would be wrong about two of three.
 */
import { restUrl } from './api'

/** Fired when any of the three active pointers changes. */
export const SETUP_CHANGED = 'g2:setup-changed'

/**
 * Tell every mounted setup view to refetch.
 *
 * Called by the prep, prompt and summary-prompt panels after an activation.
 * A DOM event rather than a shared store because the panels are mounted
 * independently and must not have to know about each other.
 */
export function notifySetupChanged(): void {
  window.dispatchEvent(new CustomEvent(SETUP_CHANGED))
}

interface Named { id: string; title: string; text: string }

export interface SetupState {
  /** null = no prep note; the recording runs on the transcript alone. */
  prep: Named | null
  suggest: Named | null
  summary: Named | null
  /** True when the suggest prompt came from the prep-specific pointer. */
  suggestViaPrep: boolean
  /** True when the summary prompt came from the prep-specific pointer. */
  summaryViaPrep: boolean
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(restUrl(path))
    if (!r.ok) return null
    return (await r.json()) as T
  } catch {
    return null
  }
}

export async function fetchSetup(): Promise<SetupState> {
  // Three independent GETs in parallel. One failing must not blank the other
  // two: a panel that shows two of three answers is more useful than one that
  // shows an error because an unrelated store was slow.
  const [prepStore, promptStore, sumStore] = await Promise.all([
    getJson<{ active: string; prep: Named[] }>('/prep'),
    getJson<{ active: string; active_prep: string; prompts: Named[] }>(
      '/prompts'),
    getJson<{ active: string; active_prep: string; prompts: Named[] }>(
      '/summary-prompts'),
  ])

  // No fallback to prep[0] — see the header.
  const prep = prepStore
    ? prepStore.prep.find(p => p.id === prepStore.active) ?? null
    : null

  // The suggest store has a second pointer now too. Replay showed why: a
  // teaching prompt whose every rule references the lesson material, run
  // with none attached, reports the absence as a correction.
  let suggest: Named | null = null
  let suggestViaPrep = false
  if (promptStore) {
    if (prep && promptStore.active_prep) {
      const p = promptStore.prompts.find(q => q.id === promptStore.active_prep)
      if (p) { suggest = p; suggestViaPrep = true }
    }
    if (!suggest) {
      suggest = promptStore.prompts.find(q => q.id === promptStore.active)
        ?? promptStore.prompts[0] ?? null
    }
  }

  let summary: Named | null = null
  let summaryViaPrep = false
  if (sumStore) {
    if (prep && sumStore.active_prep) {
      const p = sumStore.prompts.find(q => q.id === sumStore.active_prep)
      if (p) { summary = p; summaryViaPrep = true }
    }
    if (!summary) {
      summary = sumStore.prompts.find(q => q.id === sumStore.active)
        ?? sumStore.prompts[0] ?? null
    }
  }

  return { prep, suggest, summary, suggestViaPrep, summaryViaPrep }
}

const CSS = `
.g2set { margin: 10px 0 2px; }
.g2set .row {
  display: grid; grid-template-columns: 92px 1fr; gap: 2px 10px;
  align-items: baseline; padding: 7px 0;
  border-top: 1px solid var(--line-soft);
}
.g2set .row:first-child { border-top: 0; }
.g2set .k {
  font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--text-3);
}
.g2set .v { font-size: 13px; color: var(--text-1); overflow-wrap: anywhere; }
.g2set .v.none { color: var(--text-3); }
.g2set .note { grid-column: 2; font-size: 11px; color: var(--text-3); }
.g2set .note.lock { color: var(--warn, #FFD60A); }
`

let cssInstalled = false

/**
 * Paint the resolved setup into `el` and keep it current.
 *
 * Returns a handle so the host can tell it when a recording starts or stops —
 * that does not change WHAT is used, but it changes what is still changeable,
 * which is the whole point of showing this next to the record button.
 */
export function mountSetupSummary(el: HTMLElement) {
  if (!cssInstalled) {
    const style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)
    cssInstalled = true
  }

  el.classList.add('g2set')
  let recording = false
  let state: SetupState | null = null

  function paint() {
    if (!state) {
      el.innerHTML = `<div class="row"><span class="k">Setup</span><span class="v none">loading…</span></div>`
      return
    }

    const rows: string[] = []

    // Prep note first: it is the only row that is locked, and the only one
    // whose absence changes what the other two mean.
    rows.push(row(
      'Prep note',
      state.prep ? state.prep.title : 'None',
      !state.prep,
      recording
        ? 'Locked for this recording'
        : 'Captured when recording starts',
      recording,
    ))

    rows.push(row(
      'Suggestions',
      state.suggest ? state.suggest.title : 'Gateway default',
      !state.suggest,
      state.suggestViaPrep
        ? 'Lesson prompt, because a prep note is attached'
        : 'Re-read on every suggestion — can change mid-recording',
      false,
    ))

    rows.push(row(
      'Summary',
      state.summary ? state.summary.title : 'Gateway default',
      !state.summary,
      state.summaryViaPrep
        ? 'Lesson prompt, because a prep note is attached'
        : 'Read when recording stops — can change mid-recording',
      false,
    ))

    el.innerHTML = rows.join('')
  }

  function row(k: string, v: string, muted: boolean, note: string,
               lock: boolean): string {
    // textContent is not available on a string build, so the two user-supplied
    // values are escaped by hand. A prompt title is user text and must never
    // reach innerHTML as markup.
    const esc = (s: string) => s.replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
    return `<div class="row">
      <span class="k">${esc(k)}</span>
      <span class="v${muted ? ' none' : ''}">${esc(v)}</span>
      <span class="note${lock ? ' lock' : ''}">${esc(note)}</span>
    </div>`
  }

  async function refresh() {
    state = await fetchSetup()
    paint()
  }

  paint()
  void refresh()

  window.addEventListener(SETUP_CHANGED, () => { void refresh() })

  return {
    refresh,
    /**
     * Recording started or stopped.
     *
     * On START this refetches as well as repainting: the prep note is captured
     * server-side at that moment, and refetching is what makes the row show
     * the value that was actually captured rather than whatever was on screen
     * beforehand.
     */
    setRecording(active: boolean) {
      if (active === recording) return
      recording = active
      if (active) void refresh()
      else paint()
    },
  }
}