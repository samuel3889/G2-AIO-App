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
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'

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

// "100%" / "+100%" is at most 5 chars => ~95px. There is no text-alignment
// property on TextContainerProperty, so the only way to get the battery
// near the right edge is to make the box narrow and push it right; a
// shorter string like "87%" will sit a few px left of the edge.
const BATTERY_W = 100

export interface StatusState {
  /** 0-100, or undefined before the first device status arrives. */
  batteryLevel?: number
  isCharging?: boolean
}

// The last device status the host reported. Read by statusContainers() on
// every page build.
let deviceStatus: StatusState = {}

/** Record a new device status. Does not repaint anything by itself. */
export function setDeviceStatus(s: StatusState): void {
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
      content: clockText(now),
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
      content: batteryText(),
      isEventCapture: 0,
      zOrderIndex: BATTERY_Z,
    }),
  ]
}