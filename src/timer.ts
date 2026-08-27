/**
 * Countdown timer state. PURE — no SDK import, no bridge, no geometry.
 *
 * WHY THIS IS SPLIT FROM statusbar.ts
 *
 * statusbar.ts's own comment states its job: it "owns their geometry, their
 * text, and the device state they read from". The timer's GEOMETRY belongs
 * there for exactly that reason — the strip must not be able to drift apart
 * across the page builders. But the timer's STATE does not: a deadline, a
 * title and an expiry callback have nothing to do with container layout, and
 * keeping them here means the whole countdown is testable without a lens, a
 * bridge, or a WebView.
 *
 * The dependency runs ONE WAY: statusbar.ts imports from here, and this file
 * imports nothing from statusbar.ts. Putting SCREEN_W or STATUS_H in here
 * would make that a cycle, and ESM cycles resolve module-level `const`s in
 * import order — which is how you get a container built with `width:
 * undefined` and no error anywhere.
 *
 * WHAT DOES NOT LIVE HERE
 *
 * The 1 Hz push loop and the container itself (statusbar.ts), and the
 * full-screen expiry box (main.ts, step 2). This module fires
 * onTimerExpired() and has no opinion about what happens next.
 */

export interface TimerState {
  /** Identity, so a later 'cancel' frame from the gateway can name one. */
  id: string
  /** Shown in the expiry box, NOT in the status strip — see timerText(). */
  title: string
  /** Wall-clock deadline, as Date.now() milliseconds. */
  endsAt: number
  /** What was originally asked for, kept for logging and for the box. */
  durationS: number
  /** How long the expiry box stays up, in seconds. */
  alertS: number
}

/**
 * Default seconds the full-screen expiry box stays on the lens.
 *
 * The "adjustable amount of seconds" you asked for. In step 3 the gateway
 * will send this on the timer frame, derived from a `timer_alert_s` tunable,
 * exactly the way `hold_ms` rides on each suggest frame — so moving the
 * slider on the phone applies to the next timer with no WebView reload. Until
 * then this constant is the only source.
 */
export const ALERT_S_DEFAULT = 8

/** Clamp, so a bad value from anywhere cannot pin the lens indefinitely. */
export const ALERT_S_MIN = 1
export const ALERT_S_MAX = 120

/**
 * Resolve an alert duration to milliseconds.
 *
 * Mirrors resolveHoldMs() in suggest.ts deliberately: ONE place decides what
 * a hold time may be, so a frame carrying nothing, a frame carrying garbage
 * and a hard-coded default all converge here rather than in three callers.
 */
export function resolveAlertMs(alertS?: number): number {
  if (typeof alertS !== 'number' || !Number.isFinite(alertS)) {
    return ALERT_S_DEFAULT * 1000
  }
  return Math.min(Math.max(alertS, ALERT_S_MIN), ALERT_S_MAX) * 1000
}

/**
 * The ONE timer, or null.
 *
 * Deliberately singular. Multiple concurrent timers would need somewhere to
 * render the second one, and the status strip has exactly one free slot
 * between the clock and the battery. A second "set a timer" REPLACES the
 * first rather than queueing behind it — same call suggest.ts makes, and for
 * the same reason: if you set another one, that is the one you care about.
 */
let current: TimerState | null = null

/** Monotonically increasing, so two timers set in the same ms differ. */
let nextId = 1

type ChangeCb = (t: TimerState | null) => void
type ExpireCb = (t: TimerState) => void

const changeCbs = new Set<ChangeCb>()
const expireCbs = new Set<ExpireCb>()

/**
 * Notified whenever the timer is SET, REPLACED, CANCELLED or EXPIRES.
 *
 * statusbar.ts subscribes to this to start and stop its 1 Hz push loop, so
 * the loop does not run — and does not write to the lens — when there is
 * nothing counting down.
 *
 * Returns an unsubscribe function.
 */
export function onTimerChanged(cb: ChangeCb): () => void {
  changeCbs.add(cb)
  return () => changeCbs.delete(cb)
}

/**
 * Notified ONCE when a timer reaches zero, with the timer that expired.
 *
 * Fires from tickTimer(), i.e. from statusbar.ts's push loop, and only after
 * `current` has already been cleared — so a handler that rebuilds the page
 * cannot rebuild it with a stale countdown baked in.
 *
 * Returns an unsubscribe function.
 */
export function onTimerExpired(cb: ExpireCb): () => void {
  expireCbs.add(cb)
  return () => expireCbs.delete(cb)
}

function emitChange() {
  for (const cb of changeCbs) {
    try {
      cb(current)
    } catch (err) {
      // One bad subscriber must not stop the others, and must not throw out
      // of a setInterval callback where nothing would catch it.
      console.error('[timer] onTimerChanged handler threw:', err)
    }
  }
}

export interface StartTimerOptions {
  /** Seconds from now. Values below 1 are rejected — see startTimer(). */
  durationS: number
  /** Defaults to 'Timer'. Shown in the expiry box. */
  title?: string
  /** Seconds the expiry box stays up. Defaults via resolveAlertMs(). */
  alertS?: number
}

/**
 * Start (or replace) the timer. Returns the new state, or null if rejected.
 *
 * The deadline is computed from Date.now() HERE, at the moment the command
 * arrives, rather than being sent as an absolute timestamp by the gateway.
 * That is the whole reason this is client-side: an absolute deadline would
 * require the Unraid clock and the phone clock to agree, and they are not
 * synchronised by anything in this stack. A duration is immune to that.
 */
export function startTimer(opts: StartTimerOptions): TimerState | null {
  const durationS = Math.round(opts.durationS)
  if (!Number.isFinite(durationS) || durationS < 1) {
    console.warn(`[timer] refusing duration ${opts.durationS}s`)
    return null
  }

  const title = (opts.title ?? '').trim() || 'Timer'

  current = {
    id: `t${nextId++}`,
    title,
    endsAt: Date.now() + durationS * 1000,
    durationS,
    // Stored per-timer rather than read at expiry, so a slider moved while
    // this one is already counting down does not change the alert it was
    // set with. Matches how suggest.ts freezes hold_ms per suggestion.
    alertS: resolveAlertMs(opts.alertS) / 1000,
  }

  console.log(
    `[timer] set ${current.id} "${current.title}" ${durationS}s ` +
      `alert=${current.alertS}s`,
  )
  emitChange()
  return current
}

/**
 * Cancel the timer. Returns what was cancelled, or null if nothing was up.
 *
 * Does NOT fire onTimerExpired — a cancelled timer must not put the
 * full-screen box on the lens.
 */
export function cancelTimer(): TimerState | null {
  if (current === null) return null
  const was = current
  current = null
  console.log(`[timer] cancelled ${was.id} "${was.title}"`)
  emitChange()
  return was
}

/** The timer currently counting down, or null. */
export function getTimer(): TimerState | null {
  return current
}

/** Milliseconds left, floored at 0. 0 when no timer is running. */
export function remainingMs(now: number = Date.now()): number {
  if (current === null) return 0
  return Math.max(0, current.endsAt - now)
}

/**
 * Format a remaining duration for the status strip.
 *
 * "MM:SS left" under an hour, "H:MM:SS left" at or above one. Seconds are
 * rounded UP, which is why a 20-minute timer reads "20:00 left" the instant
 * it is set instead of "19:59 left" — rounding down would make every timer
 * appear to start a second late.
 *
 * Returns '' when nothing is running. That empty string is what BLANKS the
 * container: the strip's timer container is on every page whether or not a
 * timer exists, so "no timer" is a content value, not a missing container.
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return ''
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss} left` : `${mm}:${ss} left`
}

/**
 * What the strip's timer container should hold right now.
 *
 * The TITLE is deliberately absent. There is one free slot in a 576px strip
 * between a 200px clock and a 56px battery, and "Pasta 19:59 left" does not
 * fit in it at any title length worth having. The title's job is to identify
 * the alarm when it goes off, which is what the full-screen expiry box is
 * for — so that is where it appears.
 */
export function timerText(now: number = Date.now()): string {
  return formatRemaining(remainingMs(now))
}

/**
 * Advance the timer by one tick. Returns the timer that EXPIRED, or null.
 *
 * Called from statusbar.ts's 1 Hz push loop and nowhere else. Expiry is
 * detected here rather than by a setTimeout on `endsAt` for a specific
 * reason: a WebView that is backgrounded, throttled or suspended does not
 * fire timeouts on schedule, but it does re-run its intervals when it wakes.
 * Comparing against Date.now() means a timer that should have gone off while
 * the phone was asleep fires on the first tick after it wakes, rather than
 * being silently late by however long the WebView was parked.
 *
 * `current` is cleared BEFORE the callbacks run, so an onTimerExpired
 * handler that rebuilds the page cannot bake a stale "00:00 left" into it.
 */
export function tickTimer(now: number = Date.now()): TimerState | null {
  if (current === null) return null
  if (current.endsAt > now) return null

  const fired = current
  current = null
  console.log(
    `[timer] expired ${fired.id} "${fired.title}" ` +
      `(${Math.round((now - fired.endsAt) / 1000)}s late)`,
  )
  // Change first: this is what stops the push loop, and it must stop before
  // anything rebuilds the page underneath it.
  emitChange()
  for (const cb of expireCbs) {
    try {
      cb(fired)
    } catch (err) {
      console.error('[timer] onTimerExpired handler threw:', err)
    }
  }
  return fired
}