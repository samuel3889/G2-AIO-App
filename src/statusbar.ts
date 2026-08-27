/**
 * Persistent status strip for the lens: clock top-left, countdown centre,
 * battery top-right.
 *
 * There is NO persistent overlay layer in this SDK. `rebuildPageContainer`
 * replaces the entire page, so "persist across pages" can only mean: every
 * page builder includes these containers. This module owns their geometry,
 * their text, and the device state they read from, so the four page builders
 * (startup, transcript, list, menu, assistant) cannot drift apart.
 *
 * The device state lives HERE rather than being threaded through every
 * showXPage() signature: those builders take (bridge, theirOwnState), and
 * adding a status argument to each one would mean every future page has to
 * remember to pass it. Instead main.ts calls setDeviceStatus() whenever the
 * host reports a change, and the builders just call statusContainers().
 *
 * The COUNTDOWN's state does not live here — timer.ts owns that, and this
 * module owns only its geometry and the loop that writes it. See the header
 * of timer.ts for why the split runs that way round.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 */
import {
  TextContainerProperty,
  TextContainerUpgrade,
  type DeviceStatus,
} from '@evenrealities/even_hub_sdk'
import { getTimer, onTimerChanged, startTimer, tickTimer, timerText } from './timer'

export const SCREEN_W = 576
export const SCREEN_H = 288

/**
 * Height of the strip. overlay.ts measures a text line at LINE_HEIGHT = 28,
 * so anything under that clips the glyphs. 32 = one line plus 2px padding
 * top and bottom.
 */
export const STATUS_H = 32

/**
 * Container IDs, deliberately clear of everything else.
 *
 * The allocation across this app is: 1 = transcript, 2/3 = list
 * header/list, 4/5 = menu header/list, 6 = the assistant overlay box
 * (OVERLAY_Q_ID in overlay.ts), 7 reserved, 8 = names, 9 = message,
 * 10/11 = this strip's clock and battery, 12 = home, 13 = this strip's
 * countdown.
 *
 * 6/7 once COLLIDED with the overlay — that collision is what made the
 * assistant box lose its border, shrink to the clock's width, and swallow
 * its own textContainerUpgrade, since the ID/name pair no longer identified
 * a single container.
 *
 * Note the z-order validator does NOT catch this: it checks zOrderIndex for
 * duplicates, not containerID, so a colliding page still rebuilds and
 * returns true. TIMER_ID is 13 and not 12 for precisely that reason — 12 is
 * HOME_ID in pages.ts, and a page carrying both would fail silently.
 */
export const CLOCK_ID = 10
export const BATTERY_ID = 11
export const TIMER_ID = 13

// containerName is capped at 16 characters by the protocol.
export const CLOCK_NAME = 'status-clock'
export const BATTERY_NAME = 'status-batt'
export const TIMER_NAME = 'status-timer'

/**
 * z-order values, deliberately high.
 *
 * The shipped validator (validateEvenHubPageContainerZOrder in index.js,
 * exported and confirmed in index.d.ts as
 * EvenHubPageContainerValidationErrorCode) rejects a page where two
 * containers share a value: DUPLICATE_Z_ORDER_INDEX, and the rebuild returns
 * false without ever reaching the glasses. Every existing page in this app
 * uses 0 and 1 (the caption page also uses 2 for the suggestion band), so
 * the strip takes 10, 11 and 12 — far enough above the content containers
 * that a page adding a third or fourth of its own still cannot collide.
 */
export const CLOCK_Z = 10
export const BATTERY_Z = 11
export const TIMER_Z = 12

const PADDING = 2

// overlay.ts's empirical metric: 30 chars across 576px => ~19px per char.
// "10:42 AM" is 8 chars; 200px leaves slack for a two-digit hour.
const CLOCK_W = 200

/**
 * Width of the battery container. THIS is the knob for how flush right the
 * percentage sits.
 *
 * There is no text-alignment property on TextContainerProperty, so content
 * is always drawn from the LEFT edge of its container. The container's
 * right edge is pinned to the screen edge below, so the gap you see to the
 * right of "100%" is empty space inside the container: the narrower this
 * is, the further right the text starts.
 *
 * Was 100, sized off a 19px/char estimate that the lens showed to be about
 * double the real glyph width. 56 fits the longest string this ever renders
 * ("+100%", 5 chars) with the padding.
 *
 * To tune: too much gap at the right -> lower. Digits clipped or the '%'
 * missing when the battery hits 100 -> raise. Check it at a 3-digit value,
 * not at "87%".
 */
const BATTERY_W = 56

/**
 * Average glyph width in the strip, in px. MEASURED, unlike every other
 * font figure in this codebase.
 *
 * Taken off a lens photograph of "00:11 left": 10 characters spanning
 * roughly 211-291px, so ~8px each. Note this is 20% NARROWER than the ~10px
 * BATTERY_W implies and well under half overlay.ts's CHARS_PER_LINE estimate
 * of ~19px — the strip and the body text are not the same size, so do not
 * carry this number into overlay.ts or captions.ts.
 *
 * The font is PROPORTIONAL, so this is an average and a run of wide glyphs
 * exceeds it. Everything derived from it below carries headroom for that.
 */
const TIMER_CHAR_W = 8

/**
 * Characters in the longest string formatRemaining() can produce:
 * "12:34:56 left". This sets the WIDTH, because a container narrower than
 * its content clips rather than wraps.
 */
const TIMER_MAX_CHARS = 13

/**
 * Characters in the string that is actually on the lens almost all the
 * time: "MM:SS left". This sets the POSITION — see TIMER_X.
 */
const TIMER_TYPICAL_CHARS = 10

/**
 * Width of the countdown container. Sized for the LONGEST string, plus a
 * character of headroom for the proportional font and the two paddings.
 *
 * To tune: the tail of "left" clipped, or a digit missing when the timer
 * crosses an hour -> raise TIMER_CHAR_W. Check it at "1:00:00 left", not at
 * "05:00 left".
 */
const TIMER_W = (TIMER_MAX_CHARS + 1) * TIMER_CHAR_W + PADDING * 2

/**
 * Left edge of the countdown.
 *
 * NOT centred on the container — centred on the TYPICAL STRING inside it.
 *
 * There is no text-alignment property, and container width is frozen at
 * creation, so content always draws from the left edge and every character
 * the string is SHORTER than the container becomes slack on the right. The
 * first cut centred the container itself, which put all ~30px of that slack
 * on one side and left "00:11 left" visibly left of centre — that is what
 * the lens photo shows.
 *
 * So the container is positioned as though it held exactly
 * TIMER_TYPICAL_CHARS. "MM:SS left" is then centred to within a glyph, which
 * is the string on screen for all but the first hour of a long timer, and an
 * "H:MM:SS left" runs about 12px right of centre instead of everything
 * running left of it. The error is split rather than eliminated: eliminating
 * it needs a page rebuild on the length-change boundary, which is the
 * bandBorderOnPage pattern in main.ts and not worth it for one transition
 * per timer.
 *
 * DO NOT pad the content with leading spaces instead. pages.ts documents
 * that failing for the speaker-name column: the font is proportional, so a
 * space is not a fixed fraction of a digit and the alignment wanders with
 * the content.
 */
const TIMER_X = Math.round(
  SCREEN_W / 2 - (TIMER_TYPICAL_CHARS * TIMER_CHAR_W) / 2 - PADDING,
)

export interface StatusState {
  /** 0-100, or undefined before the first device status arrives. */
  batteryLevel?: number
  isCharging?: boolean
}

// The last device status the host reported. Read by statusContainers() on
// every page build.
let deviceStatus: StatusState = {}

/**
 * What is currently ON THE LENS in each container, as far as we know.
 *
 * Written both by statusContainers() (which bakes content in at build time)
 * and by the upgrade helpers below, so a page rebuild cannot leave these
 * stale and trigger a pointless write on the next tick.
 */
let lastClockText = ''
let lastBatteryText = ''
let lastTimerText = ''

/**
 * Serial number of the glasses, captured at boot.
 *
 * onDeviceStatusChanged fires for whichever device changed, and DeviceInfo
 * declares both isGlasses() and isRing() (index.d.ts) - so a ring would
 * otherwise overwrite the glasses battery reading. Empty means we never got
 * a device at boot, in which case everything is accepted.
 */
let glassesSn = ''

/**
 * Whether the page CURRENTLY ON THE LENS carries the status strip.
 *
 * Every page in this app carries it EXCEPT the full-screen alert box, which
 * omits it deliberately (see showAlertPage in pages.ts). While that box is
 * up, containers 10, 11 and 13 do not exist, and the interval below would
 * otherwise keep writing to them — the simulator reports this honestly as
 * `TextContainerUpgrade failed: container 13 not found`, and on real glasses
 * it is a silent no-op that also poisons the lastXText caches, since a
 * rejected write leaves them claiming a string that never reached the lens.
 *
 * Same relationship to the page that bandOnPage has in main.ts: what was
 * actually BUILT, not what should be there. main.ts sets it false when the
 * alert goes up and true when it comes down — two call sites, because the
 * alert is the only page that has ever needed this.
 */
let stripOnPage = true

/**
 * Record whether the strip is on the page. Suppresses the three push
 * helpers below while it is false.
 *
 * Does NOT repaint on the way back to true: the page that restores the strip
 * is a rebuild, and statusContainers() bakes current content into all three
 * containers as it builds them.
 */
export function setStripOnPage(on: boolean): void {
  stripOnPage = on
}

/** Record the serial number to match later status events against. */
export function setGlassesSn(sn?: string): void {
  glassesSn = sn ?? ''
}

/**
 * Record a new device status. Does not repaint anything by itself.
 *
 * THE ZERO GUARD. DeviceStatus.fromJson in the shipped index.js reads the
 * battery with a plain `!= null` fallback to 0:
 *
 *   'batteryLevel': (x = json?.batteryLevel) != null ? x : 0
 *
 * (the constructor and createDefault() do the same). Note it uses direct
 * property access, NOT the loose `pickLoose` helper the container classes
 * use - so a host payload that omits batteryLevel, or spells it differently,
 * becomes a hard 0 rather than undefined. Since handleGlassesStatusChanged
 * runs EVERY status event through fromJson, an event that only reports a
 * wear or connect change arrives here as batteryLevel === 0 and would
 * otherwise overwrite a perfectly good reading. That is the 0% bug.
 *
 * So: a 0 reading is treated as "no reading" whenever we already hold a
 * non-zero one, and the previous value is kept. The cost is that a genuinely
 * dead battery freezes at its last real value instead of counting to 0 - an
 * acceptable trade, since the glasses power off before reporting 0 anyway.
 * isCharging is carried over with it, because a status event with no battery
 * field has no meaningful charge flag either.
 */
export function setDeviceStatus(s: StatusState): void {
  const incomingIsZero = s.batteryLevel === 0
  const haveRealReading =
    typeof deviceStatus.batteryLevel === 'number' && deviceStatus.batteryLevel > 0

  if (incomingIsZero && haveRealReading) {
    console.log(
      `[status] ignoring battery=0 update, keeping ${deviceStatus.batteryLevel}`,
    )
    return
  }

  deviceStatus = s
}

/** The current device status, for callers that need to log or inspect it. */
export function getDeviceStatus(): StatusState {
  return deviceStatus
}

/**
 * Clock text, formatted by hand rather than via toLocaleTimeString so the
 * output cannot change with the WebView's locale (and so it never contains
 * a non-ASCII narrow space, which the lens font may not have).
 */
export function clockText(now: Date = new Date()): string {
  const h24 = now.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`
}

/** Battery text. '--%' until a real reading arrives. */
export function batteryText(s: StatusState = deviceStatus): string {
  if (typeof s.batteryLevel !== 'number' || Number.isNaN(s.batteryLevel)) return '--%'
  const pct = Math.max(0, Math.min(100, Math.round(s.batteryLevel)))
  return s.isCharging ? `+${pct}%` : `${pct}%`
}

/**
 * The three status containers, in a fixed order: [clock, timer, battery].
 *
 * `isEventCapture` is hard-coded to 0 on all three: exactly one container per
 * page may capture events, and that is always the page's own content
 * container, never the status strip.
 *
 * Content is baked in at build time, so every page rebuild refreshes the
 * clock and the countdown for free. Between rebuilds they are frozen until
 * something calls textContainerUpgrade against CLOCK_ID / TIMER_ID.
 *
 * THE COUNTDOWN CONTAINER IS ALWAYS HERE, EVEN WITH NO TIMER RUNNING.
 *
 * That is deliberate and it is what keeps this feature out of main.ts. The
 * suggestion band needs a full page rebuild to appear or disappear because
 * its BORDER is content-dependent and borderWidth is frozen at container
 * creation — hence bandOnPage, bandBorderOnPage, and the corrective rebuild
 * passes in showCaptions(). The countdown has borderWidth 0 in both states,
 * so "no timer" is just `content: ''` and no rebuild is ever needed. An
 * empty, border-less container draws nothing: homeContainer() in pages.ts is
 * the same trick.
 *
 * The knock-on is that every page builder gains a container without being
 * edited, because all of them derive containerTotalNum from this array's
 * length — including menu.ts's `text.length + 1`.
 */
export function statusContainers(now: Date = new Date()): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: CLOCK_W,
      height: STATUS_H,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: PADDING,
      containerID: CLOCK_ID,
      containerName: CLOCK_NAME,
      content: (lastClockText = clockText(now)),
      isEventCapture: 0,
      zOrderIndex: CLOCK_Z,
    }),
    new TextContainerProperty({
      xPosition: TIMER_X,
      yPosition: 0,
      width: TIMER_W,
      height: STATUS_H,
      // Never bordered, in either state. This is the property that lets the
      // container stay on the page when idle — see the note above.
      borderWidth: 0,
      borderColor: 5,
      paddingLength: PADDING,
      containerID: TIMER_ID,
      containerName: TIMER_NAME,
      // now.getTime() rather than a second Date.now(): the clock beside it
      // was formatted from `now`, and reading the wall clock twice in one
      // page build is how the two end up describing different instants.
      content: (lastTimerText = timerText(now.getTime())),
      isEventCapture: 0,
      zOrderIndex: TIMER_Z,
    }),
    new TextContainerProperty({
      xPosition: SCREEN_W - BATTERY_W,
      yPosition: 0,
      width: BATTERY_W,
      height: STATUS_H,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: PADDING,
      containerID: BATTERY_ID,
      containerName: BATTERY_NAME,
      content: (lastBatteryText = batteryText()),
      isEventCapture: 0,
      zOrderIndex: BATTERY_Z,
    }),
  ]
}

// --- live updates -----------------------------------------------------------

/**
 * The two bridge methods this module needs, declared structurally rather
 * than by importing EvenAppBridge - same approach as showListPage and
 * showMenuPage, which take the one method they call.
 */
export interface StatusBridge {
  textContainerUpgrade: (c: TextContainerUpgrade) => Promise<boolean>
  onDeviceStatusChanged: (cb: (status: DeviceStatus) => void) => () => void
}

/**
 * How often to CHECK the clock, not how often to write it.
 *
 * The write only happens when the formatted string changes, so this is the
 * worst-case lag on a minute rollover, not a write rate. 15s keeps the BLE
 * render queue seeing about one write per minute.
 */
const TICK_MS = 5_000

/**
 * How often to write the COUNTDOWN, and unlike TICK_MS this really is a
 * write rate — the string changes every second by definition.
 *
 * THIS IS THE RISKIEST NUMBER IN THE FILE. Nothing else in this app writes
 * to the lens at 1 Hz sustained: the clock is throttled to roughly one write
 * a minute precisely because the BLE render queue is slow, and caption
 * writes are debounced to 120ms for the same reason. ~60 writes a minute for
 * the life of a timer is an order of magnitude more traffic than the strip
 * has ever carried, and whether the queue absorbs it or starts making
 * captions lag behind it is not knowable from the SDK — only from the lens.
 *
 * If captions go sluggish while a timer runs, raise this to 5_000 first.
 * "20:04 left" ticking in five-second steps still reads as a live countdown
 * and costs 12 writes a minute instead of 60; only the last minute of a
 * timer genuinely wants per-second resolution, and a two-rate scheme is the
 * next thing to try after that.
 */
const TIMER_TICK_MS = 1_000

/**
 * SELF-TEST: seconds to count down from at boot. 0 disables.
 *
 * Steps 1 and 2 of this feature had no voice path, so this was the only way
 * to put a countdown on the lens. Step 3b wired the gateway intent, so it is
 * off — leave it off. It exists as scaffolding for the next time the display
 * side needs work without a working microphone, which is the same job
 * CAPTION_RULER does in captions.ts.
 */
const TIMER_SELFTEST_S = 0

/** Push the current time to the lens if it differs from what is up. */
async function pushClock(bridge: StatusBridge): Promise<void> {
  if (!stripOnPage) return
  const text = clockText()
  if (text === lastClockText) return
  const ok = await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: CLOCK_ID,
      containerName: CLOCK_NAME,
      content: text,
    }),
  )
  // Only trust the cache if the write was accepted. On false the string is
  // NOT on the lens, and the next tick should try again rather than skip.
  if (ok) lastClockText = text
  else console.warn(`[status] clock upgrade returned false (content=${text})`)
}

/** Push the current battery reading to the lens if it differs. */
async function pushBattery(bridge: StatusBridge): Promise<void> {
  if (!stripOnPage) return
  const text = batteryText()
  if (text === lastBatteryText) return
  const ok = await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: BATTERY_ID,
      containerName: BATTERY_NAME,
      content: text,
    }),
  )
  if (ok) lastBatteryText = text
  else console.warn(`[status] battery upgrade returned false (content=${text})`)
}

/**
 * Write one string into the countdown container, if it differs from what is
 * already there.
 *
 * Split out of pushTimer() so the EXPIRY path can blank the container as a
 * plain awaited write, without re-entering the tick logic that is calling
 * it. The first cut had the stop branch of syncCountdownInterval() call
 * pushTimer() recursively to do the blanking; that issued an unawaited write
 * which then raced the page rebuild fired by the expiry callbacks, and lost.
 * `container 13 not found`.
 */
async function writeTimer(bridge: StatusBridge, text: string): Promise<void> {
  if (!stripOnPage) return
  if (text === lastTimerText) return
  const ok = await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: TIMER_ID,
      containerName: TIMER_NAME,
      content: text,
    }),
  )
  if (ok) lastTimerText = text
  else console.warn(`[status] timer upgrade returned false (content=${text})`)
}

/**
 * Advance the countdown and write it. Called once a second while a timer is
 * running, and nowhere else.
 *
 * EXPIRY IS TWO STEPS, IN THIS ORDER, AND THE ORDER IS THE WHOLE POINT.
 *
 * First blank the container, AWAITED, while it is still on the page. Only
 * then call tickTimer(), which clears the timer state, stops this interval,
 * and fires onTimerExpired — and that last one rebuilds the lens as the
 * full-screen alert box, on which container 13 does not exist. Doing it the
 * other way round, or issuing the blank without awaiting it, puts a write in
 * flight against a container the rebuild is about to remove.
 *
 * Expiry is detected by comparing against the wall clock rather than by a
 * setTimeout on `endsAt` — see the note in timer.ts about backgrounded
 * WebViews.
 */
async function pushTimer(bridge: StatusBridge): Promise<void> {
  const t = getTimer()

  if (t !== null && t.endsAt <= Date.now()) {
    await writeTimer(bridge, '')
    tickTimer()
    return
  }

  await writeTimer(bridge, timerText())
}

/**
 * Start keeping the strip current: a clock poll, a countdown poll, and a
 * device status subscription.
 *
 * Returns a stop function that clears all of them. Call it from cleanup() so
 * nothing outlives the widget. main.ts already stores this as
 * stopStatusUpdates and calls it there, so the countdown is covered by that
 * existing wiring without an edit.
 *
 * The countdown interval only exists WHILE A TIMER DOES. onTimerChanged
 * fires on set, replace, cancel and expiry, and this starts or stops the
 * interval to match — so an idle app runs one 5s interval exactly as before,
 * not a second one spinning at 1 Hz for nothing.
 *
 * NOTE this module is the first thing in the app to write to a container it
 * did not create via createStartUpPageContainer. If the clock or the
 * countdown never changes but the console stays silent, the write is being
 * accepted and ignored; if the warnings above fire, it is being rejected.
 */
export function startStatusUpdates(bridge: StatusBridge): () => void {
  const timer = window.setInterval(() => {
    void pushClock(bridge)
  }, TICK_MS)

  let countdown: number | null = null

  const syncCountdownInterval = () => {
    if (getTimer() !== null) {
      if (countdown !== null) return
      countdown = window.setInterval(() => {
        void pushTimer(bridge)
      }, TIMER_TICK_MS)
      // Write immediately as well as on the next tick, so a timer set at
      // 20:00.4 does not sit blank on the lens for the rest of that second.
      // writeTimer(), NOT pushTimer(): a freshly set timer cannot be expired,
      // and going through the tick path here would mean this runs inside the
      // onTimerChanged that pushTimer's own tickTimer() call emits.
      void writeTimer(bridge, timerText())
      console.log('[status] countdown interval started')
      return
    }

    if (countdown !== null) {
      window.clearInterval(countdown)
      countdown = null
      console.log('[status] countdown interval stopped')
    }
    // Blank the container. This is the CANCEL path — on the expiry path
    // pushTimer() has already blanked it, awaited, before tickTimer() got
    // here, and this write is then a no-op against the cache.
    void writeTimer(bridge, '')
  }

  const unsubscribeTimer = onTimerChanged(syncCountdownInterval)
  // A timer may already be running if this is ever called twice, or if a
  // future gateway frame lands before the bridge is ready.
  syncCountdownInterval()

  const unsubscribe = bridge.onDeviceStatusChanged(status => {
    // Ignore other devices (a ring) once we know which sn is the glasses.
    if (glassesSn && status.sn && status.sn !== glassesSn) {
      console.log(`[status] ignoring status for sn=${status.sn}`)
      return
    }
    setDeviceStatus({
      batteryLevel: status.batteryLevel,
      isCharging: status.isCharging,
    })
    // connectType / isWearing / isInCase are all declared on DeviceStatus in
    // index.d.ts. They are logged to identify WHICH events arrive with
    // battery=0: if the zeros all carry a connect or wear change, that
    // confirms the fromJson default above rather than a real dead battery.
    console.log(
      `[status] update sn=${status.sn} battery=${status.batteryLevel}` +
        ` charging=${status.isCharging} connect=${status.connectType}` +
        ` wearing=${status.isWearing} inCase=${status.isInCase}`,
    )
    void pushBattery(bridge)
  })

  // Step 1 probe. Remove the flag, not this block, once the gateway intent
  // exists — startTimer() is the same call the timer frame will make.
  if (TIMER_SELFTEST_S > 0) {
    console.log(`[status] SELF-TEST: starting ${TIMER_SELFTEST_S}s timer`)
    startTimer({ durationS: TIMER_SELFTEST_S, title: 'Self test' })
  }

  return () => {
    window.clearInterval(timer)
    if (countdown !== null) {
      window.clearInterval(countdown)
      countdown = null
    }
    unsubscribeTimer()
    unsubscribe()
  }
}