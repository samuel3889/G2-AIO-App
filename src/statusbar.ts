/**
 * Persistent status strip for the lens: clock top-left, battery top-right.
 *
 * There is NO persistent overlay layer in this SDK. `rebuildPageContainer`
 * replaces the entire page, so "persist across pages" can only mean: every
 * page builder includes these two containers. This module owns their
 * geometry, their text, and the device state they read from, so the four
 * page builders (startup, transcript, plex, menu, assistant) cannot drift
 * apart.
 *
 * The device state lives HERE rather than being threaded through every
 * showXPage() signature: those builders take (bridge, theirOwnState), and
 * adding a status argument to each one would mean every future page has to
 * remember to pass it. Instead main.ts calls setDeviceStatus() whenever the
 * host reports a change, and the builders just call statusContainers().
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 */
import {
  TextContainerProperty,
  TextContainerUpgrade,
  type DeviceStatus,
} from '@evenrealities/even_hub_sdk'

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
 * The allocation across this app is: 1 = transcript, 2/3 = plex
 * header/list, 4/5 = menu header/list, and 6 = the assistant overlay box
 * (OVERLAY_Q_ID in overlay.ts). 6/7 therefore COLLIDES with the overlay —
 * that collision is what made the assistant box lose its border, shrink to
 * the clock's width, and swallow its own textContainerUpgrade, since the
 * ID/name pair no longer identified a single container.
 *
 * Note the z-order validator does NOT catch this: it checks zOrderIndex for
 * duplicates, not containerID, so a colliding page still rebuilds and
 * returns true.
 *
 * 10/11 matches the z-order values below and leaves 6-9 free for pages that
 * grow.
 */
export const CLOCK_ID = 10
export const BATTERY_ID = 11

// containerName is capped at 16 characters by the protocol.
export const CLOCK_NAME = 'status-clock'
export const BATTERY_NAME = 'status-batt'

/**
 * z-order values, deliberately high.
 *
 * The shipped validator (validateEvenHubPageContainerZOrder in index.js,
 * exported and confirmed in index.d.ts as
 * EvenHubPageContainerValidationErrorCode) rejects a page where two
 * containers share a value: DUPLICATE_Z_ORDER_INDEX, and the rebuild returns
 * false without ever reaching the glasses. Every existing page in this app
 * uses 0 and 1, so the strip takes 10 and 11 — far enough above the content
 * containers that a page adding a third or fourth of its own still cannot
 * collide.
 */
export const CLOCK_Z = 10
export const BATTERY_Z = 11

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

/**
 * Serial number of the glasses, captured at boot.
 *
 * onDeviceStatusChanged fires for whichever device changed, and DeviceInfo
 * declares both isGlasses() and isRing() (index.d.ts) - so a ring would
 * otherwise overwrite the glasses battery reading. Empty means we never got
 * a device at boot, in which case everything is accepted.
 */
let glassesSn = ''

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
 * The two status containers, in a fixed order: [clock, battery].
 *
 * `isEventCapture` is hard-coded to 0 on both: exactly one container per
 * page may capture events, and that is always the page's own content
 * container, never the status strip.
 *
 * Content is baked in at build time, so every page rebuild refreshes the
 * clock for free. Between rebuilds it is frozen until something calls
 * textContainerUpgrade against CLOCK_ID.
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
 * than by importing EvenAppBridge - same approach as showPlexPage and
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

/** Push the current time to the lens if it differs from what is up. */
async function pushClock(bridge: StatusBridge): Promise<void> {
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
 * Start keeping the strip current: a clock poll plus a device status
 * subscription.
 *
 * Returns a stop function that clears both. Call it from cleanup() so the
 * interval does not outlive the widget.
 *
 * NOTE this is the first thing in the app to write to a container it did
 * not create via createStartUpPageContainer. If the clock never changes but
 * the console stays silent, the write is being accepted and ignored; if the
 * warnings above fire, it is being rejected.
 */
export function startStatusUpdates(bridge: StatusBridge): () => void {
  const timer = window.setInterval(() => {
    void pushClock(bridge)
  }, TICK_MS)

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

  return () => {
    window.clearInterval(timer)
    unsubscribe()
  }
}