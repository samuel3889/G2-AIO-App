/**
 * Persistent status strip for the lens: clock top-left, battery top-right.
 *
 * There is NO persistent overlay layer in this SDK. `rebuildPageContainer`
 * replaces the entire page, so "persist across pages" can only mean: every
 * page builder includes these two containers. This module owns their
 * geometry and text so the three page builders (main startup, plex, menu)
 * cannot drift apart.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 *
 * NOTE on `zOrderIndex`: the uploaded index.d.ts (the copy in this project)
 * does NOT declare zOrderIndex on TextContainerProperty — I checked. The
 * existing code in main.ts / plex.ts / menu.ts passes it and compiles, so
 * the installed SDK must be newer than the uploaded types. It is included
 * here to match the working code, because per plex.ts's comment the field
 * is ALL-OR-NOTHING per page: if the list sets it, every sibling must.
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

// Container IDs. 1 = transcript, 2/3 = plex header/list, 4/5 = menu
// header/list. 6/7 continue that scheme so no page reuses another's ID.
export const CLOCK_ID = 6
export const BATTERY_ID = 7

// containerName is capped at 16 characters by the protocol.
export const CLOCK_NAME = 'status-clock'
export const BATTERY_NAME = 'status-batt'

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

/**
 * Clock text, formatted by hand rather than via toLocaleTimeString so the
 * output cannot change with the WebView's locale (and so it never contains
 * a non-ASCII narrow-space, which the lens font may not have).
 */
export function clockText(now: Date = new Date()): string {
  const h24 = now.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const mm = String(now.getMinutes()).padStart(2, '0')
  return `${h12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`
}

/** Battery text. '--%' until a real reading arrives. */
export function batteryText(s: StatusState): string {
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
 * `zOrderIndex` values 1 and 2 sit in front of a background container at 0.
 */
export function statusContainers(
  s: StatusState,
  now: Date = new Date(),
): TextContainerProperty[] {
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
      zOrderIndex: 1,
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
      content: batteryText(s),
      isEventCapture: 0,
      zOrderIndex: 2,
    }),
  ]
}