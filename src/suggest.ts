/**
 * The proactive suggestion band.
 *
 * WHAT THIS IS
 *
 * A single full-width text container pinned to the BOTTOM of the caption
 * page, below both caption columns. It holds whatever the gateway's
 * {"type":"suggest"} frame last carried, or '' when there is nothing to
 * show.
 *
 * WHY IT IS PERMANENT RATHER THAN SUMMONED
 *
 * A container's geometry is FROZEN at creation, and textContainerUpgrade
 * replaces content only (G2_HANDOFF.md §5, finding 3). A band that appeared
 * when a suggestion arrived and vanished when it expired would therefore
 * need a full rebuildPageContainer at BOTH ends — and rebuildPageContainer
 * replaces every container on the page, so both caption columns would be
 * destroyed and recreated twice per suggestion, with main.ts's lastNames /
 * lastText cache invalidated each time and a forced repaint behind it.
 *
 * Reserving the space permanently makes showing and clearing a suggestion a
 * textContainerUpgrade against a container that is already on the page:
 * exactly the same cost as an ordinary caption repaint, and no page rebuild
 * at all.
 *
 * The price is caption rows, and it is paid whether or not anything is ever
 * suggested. captions.ts's SUGGEST_ROWS is that dial, and 0 turns the band
 * off completely and hands the rows back.
 *
 * WHY IT IS NOT IN pages.ts
 *
 * Same reason plex.ts no longer owns the caption page. The suggester is a
 * FEATURE and captions are the CORE; setting SUGGEST_ROWS to 0 or deleting
 * this file should cost you suggestions and nothing else. pages.ts imports
 * suggestContainers() and knows nothing else about this module.
 *
 * WHAT THE SDK DOES NOT GIVE US
 *
 * No font, no colour, no opacity, no alignment — TextContainerProperty's
 * complete property list is xPosition, yPosition, width, height,
 * borderWidth, borderColor, borderRadius, paddingLength, containerID,
 * containerName, isEventCapture, zOrderIndex, content (index.d.ts:410-425,
 * confirmed identical in the installed 0.0.13).
 *
 * So there is no way to make a suggestion LOOK different from speech by
 * styling it. The only two levers are the border (BAND_BORDER_WIDTH below)
 * and the characters themselves (TAG_PREFIX). Both matter more here than
 * anywhere else in this app: everything else on the caption page is a record
 * of what a human in the room actually said, and this one container is not.
 * A wearer who cannot tell them apart will eventually quote a machine back
 * to the person sitting opposite them.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import {
  SCREEN_W,
  CAPTION_PADDING,
  SUGGEST_ROWS,
  SUGGEST_BAND_H,
  SUGGEST_Y,
  SUGGEST_CHARS,
  isBandVisible,
} from './captions'

/**
 * Container ID.
 *
 * The allocation across this app is: 1 transcript, 2/3 plex header/list,
 * 4/5 menu header/list, 6/7 assistant overlay, 8 speaker names, 9 message,
 * 10/11 status strip. 12 is the next free one.
 *
 * NOTE the z-order validator does NOT check containerID for duplicates —
 * only zOrderIndex (see statusbar.ts). A colliding ID rebuilds cleanly and
 * returns true, then swallows its own textContainerUpgrade, which is the
 * failure that cost the assistant box its border and its content.
 */
export const SUGGEST_ID = 12

/** containerName is capped at 16 characters by the protocol. */
export const SUGGEST_NAME = 'suggest'

/**
 * z-order.
 *
 * zOrderIndex is ALL-OR-NOTHING per page and must be UNIQUE across every
 * container on it, or validateEvenHubPageContainerZOrder fails CLIENT-SIDE
 * and rebuildPageContainer returns false without ever reaching the glasses.
 *
 * The caption page uses transcript 0, names 1, clock 10, battery 11. 2 is
 * free and keeps the band down with the content containers rather than up
 * with the status strip.
 */
export const SUGGEST_Z = 2

/**
 * Border around the band. THIS is the knob for how clearly a suggestion
 * reads as not-speech.
 *
 * There is no colour, weight or style available for text, so a rule around
 * the band is the only non-textual signal available. 0 removes it, and then
 * TAG_PREFIX is doing the whole job alone.
 *
 * UNVERIFIED: whether a border eats into the interior text area. The
 * assistant box renders its content fine at borderWidth 2, so 1 should be
 * safe — but if the band's second row clips, zero this out before touching
 * SUGGEST_ROWS.
 */
const BAND_BORDER_WIDTH = 1

/**
 * Border colour, 0-16. The assistant box uses 12.
 *
 * NOTE the simulator changed its DEFAULT border_color to 0 (invisible) in
 * v0.7.0 to match the glasses. That does not affect this — the value is set
 * explicitly — but it does mean a border that vanishes here is a real
 * problem and not a simulator default.
 */
const BAND_BORDER_COLOR = 12

/**
 * TEMPORARY DEBUG PROBE — leave as a string for ONE run to confirm the band
 * renders at all, then set to null.
 *
 * While this is a string the band shows THAT and ignores every suggestion.
 * This is the first container in this app created at a non-zero yPosition on
 * the caption page, and a container that rebuildPageContainer accepts but
 * that never displays text is a failure mode this codebase has already hit
 * once (see overlay.ts's three probes).
 *
 * Reading the result:
 *   text visible          -> geometry, ID, z-order and border are all fine.
 *                            Set to null and wire the frame.
 *   band drawn but empty  -> the container is on the page but will not take
 *                            content. Same signature as the old overlay bug.
 *   nothing at all, and
 *   captions still fill
 *   the whole screen      -> rebuildPageContainer returned false. Look for
 *                            [EvenHub:DUPLICATE_Z_ORDER_INDEX] on the
 *                            console.
 */
const DEBUG_BAND_TEXT: string | null = null

/**
 * What goes in front of the suggestion text.
 *
 * The gateway's tag (ANSWER / CHECK / ASK / TERM) is deliberately NOT shown
 * verbatim. It is an internal contract that makes the shadow log countable
 * (G2_SUGGEST_HANDOFF.md §2), not a label anyone wants to read on a lens,
 * and 'CHECK: ' spends 7 of 56 characters on a word the wearer does not
 * need.
 *
 * A single marker character is enough to say "this is the machine, not the
 * room". Plain ASCII only: the lens font's coverage beyond ASCII is unknown,
 * and SUGGEST_PROMPT already constrains the model to ASCII for the same
 * reason.
 *
 * Set to '' to show the text bare, or switch formatSuggest() below to
 * `${tag}: ` if the tags turn out to be worth their characters during the
 * two-speaker test.
 */
const TAG_PREFIX = '> '

/**
 * How long a suggestion stays on the lens before it clears itself.
 *
 * Lives here rather than in main.ts because it is a property of the feature,
 * not of the render loop - the same reason ANSWER_HOLD_MS lives with the
 * assistant code in stt.ts.
 *
 * A newer suggestion REPLACES an older one and restarts this clock; it does
 * not queue behind it. Two suggestions inside 15s means the second is the
 * more relevant one, and a queue would put stale advice on the lens while
 * the conversation had already moved on.
 *
 * Unlike ANSWER_HOLD_MS there is no gateway-side counterpart to keep in
 * sync: a suggestion is fire-and-forget, arms nothing, and expiring it
 * leaves no server state behind.
 */
export const SUGGEST_HOLD_MS = 15_000

/**
 * Render a suggestion into the string the band will hold.
 *
 * Truncated to what the band can physically show, because the container
 * CLIPS rather than scrolls: a suggestion longer than SUGGEST_ROWS rows
 * loses its tail silently, with nothing on screen to say so. Cutting it here
 * at least marks the cut.
 *
 * `_tag` is accepted but not currently rendered — see TAG_PREFIX. It stays
 * in the signature so that turning tags on is a one-line change in this file
 * rather than a change at every call site in main.ts.
 *
 * The leading underscore is what stops tsconfig's noUnusedParameters from
 * failing the build on it: TypeScript treats `_`-prefixed parameters as
 * intentionally unused. Drop the underscore the moment the tag is actually
 * rendered.
 */
export function formatSuggest(_tag: string, text: string): string {
  const body = `${TAG_PREFIX}${text}`.replace(/\s+/g, ' ').trim()
  const budget = SUGGEST_ROWS * SUGGEST_CHARS
  if (body.length <= budget) return body
  // One character of headroom so the ellipsis itself does not push a row
  // over the wrap column.
  return `${body.slice(0, budget - 1).trimEnd()}...`
}

/**
 * The band container.
 *
 * `isEventCapture` is hard-coded to 0 and is NOT a parameter: exactly one
 * container per page may capture events, and on the caption page that has to
 * remain the transcript — it is far larger and is what a tap is aimed at.
 * A suggestion is unsolicited, so it must not be able to steal the gesture
 * that pauses the microphone.
 */
export function suggestContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    // Full width. A suggestion has no speaker, so it is not offset by the
    // name column the way the transcript is.
    xPosition: 0,
    yPosition: SUGGEST_Y,
    width: SCREEN_W,
    height: SUGGEST_BAND_H,
    borderWidth: BAND_BORDER_WIDTH,
    borderColor: BAND_BORDER_COLOR,
    borderRadius: 0,
    paddingLength: CAPTION_PADDING,
    containerID: SUGGEST_ID,
    containerName: SUGGEST_NAME,
    content: DEBUG_BAND_TEXT ?? content,
    isEventCapture: 0,
    zOrderIndex: SUGGEST_Z,
  })
}

/**
 * The band containers for a page, as an array.
 *
 * EMPTY on BOTH switches: the compile-time one (SUGGEST_ROWS = 0, feature
 * off entirely) and the runtime one (isBandVisible(), which follows the
 * recording session). Page builders SPREAD this rather than calling
 * suggestContainer() directly, so an empty array removes the container from
 * the page instead of leaving a zero-height one behind — and
 * containerTotalNum, derived from array length, stays correct with no second
 * edit.
 *
 * setBandVisible() is checked HERE rather than at the call sites so that
 * every page builder gets the behaviour without having to remember it.
 * Nothing outside captions.ts may flip that flag: the columns change height
 * with it, so it only takes effect through a page rebuild.
 */
export function suggestContainers(content = ''): TextContainerProperty[] {
  return isBandVisible() ? [suggestContainer(content)] : []
}