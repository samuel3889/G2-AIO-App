/**
 * Plex activity page for the lens.
 *
 * The gateway sends {type:'answer', lines:[header, ...streams]}. This module
 * turns that into a two-container page: a text header plus a native OS list.
 *
 * Scrolling is NOT implemented here. The glasses scroll the list themselves
 * and report SCROLL_TOP_EVENT / SCROLL_BOTTOM_EVENT after the fact, so this
 * module only ever builds pages - it never responds to movement.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import {
  RebuildPageContainer,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { statusContainers, STATUS_H } from './statusbar'
import { NAMES_W, SCREEN_W, CAPTION_PADDING } from './captions'

// Hard caps from index.d.ts / SDK docs: max 20 items, 64 chars each.
// The gateway also truncates by PLEX_LINE_CHARS for visual width; this is
// the protocol ceiling, applied second as a backstop.
const MAX_ITEMS = 20
const MAX_ITEM_CHARS = 64

// Display is 576x288. The header takes a strip off the top; the list gets
// the rest. No font metrics exist anywhere in the SDK docs, so these are
// starting values to tune against a real lens, not derived numbers.
const HEADER_HEIGHT = 40

// Container IDs. 1 stays reserved for the transcript so textContainerUpgrade
// keeps working unchanged when we rebuild back to caption mode.
// In use across the app: 1 transcript, 2/3 plex, 4/5 menu, 6/7 overlay,
// 8 speaker names, 10/11 status strip. 9 is the next free one.
export const TRANSCRIPT_ID = 1
export const PLEX_HEADER_ID = 2
export const PLEX_LIST_ID = 3

/**
 * The speaker-name column.
 *
 * WHY THIS EXISTS: the lens font is PROPORTIONAL, and the SDK exposes no
 * font metrics of any kind - TextContainerProperty has no font size, no line
 * height, no alignment (index.d.ts:410-425). So a name column padded with
 * SPACES cannot line up with the text beside it: eight spaces is narrower
 * than 'Samuel: ' and wider than '?:' plus six, and both errors were plainly
 * visible on the lens.
 *
 * Two containers side by side fixes it with geometry instead of character
 * counts. Same yPosition, same height, same padding, same font, so row N on
 * the left is on row N on the right by construction - whatever the glyphs
 * happen to be.
 */
export const NAMES_ID = 8
export const NAMES_NAME = 'names'

/**
 * A plain full-width message page. NOT part of the caption layout.
 *
 * Its own ID so that a stray textContainerUpgrade aimed at the transcript
 * cannot land on it, and so that nothing about it is reachable from the
 * caption render path.
 */
export const MESSAGE_ID = 9
export const MESSAGE_NAME = 'message'

export const TRANSCRIPT_NAME = 'transcript'
const PLEX_LIST_NAME = 'plex-list'

// NAMES_W, SCREEN_W and CAPTION_PADDING are OWNED BY captions.ts and
// imported, not redeclared. The caption layout derives TEXT_CHARS from all
// three, so a second copy here would let the containers and the wrap column
// disagree - the exact bug that makes the last word of a line vanish.
//
// Nothing about the speaker column is a Plex concern; this module builds the
// containers, it does not decide their proportions.

/**
 * The transcript container on its own.
 *
 * Exported so the assistant overlay can compose a page containing BOTH the
 * transcript and its boxes without duplicating this geometry - two copies of
 * the same layout constants would drift apart the first time either changes.
 *
 * `isEventCapture` is a parameter because only one container per page may
 * capture events: it is 1 on the plain caption page, and 0 when an overlay
 * box is up and needs the taps instead.
 */
export function transcriptContainer(
  content: string,
  isEventCapture = 1,
  height = 288 - STATUS_H,
  zOrderIndex = 0,
): TextContainerProperty {
  return new TextContainerProperty({
    // Offset by the name column. This container holds the WORDS only; the
    // speakers live in namesContainer() to its left.
    xPosition: NAMES_W,
    // Pushed down by the persistent status strip, which occupies the top
    // STATUS_H px of every page in this app.
    yPosition: STATUS_H,
    width: SCREEN_W - NAMES_W,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: CAPTION_PADDING,
    containerID: TRANSCRIPT_ID,
    containerName: TRANSCRIPT_NAME,
    content,
    isEventCapture,
    // Backmost on any page it appears on. Callers that stack things over it
    // pass their own depth via overlay.ts's zFor().
    zOrderIndex,
  })
}

/**
 * The speaker-name column that sits to the LEFT of the transcript.
 *
 * Geometry is deliberately IDENTICAL to transcriptContainer() except for
 * xPosition and width: same yPosition, same height, same paddingLength. That
 * is what makes the two columns share a baseline grid. Change one and change
 * the other, or the names drift out of line with the words they label.
 *
 * `isEventCapture` is 0 and not a parameter: exactly one container per page
 * may capture events and on the caption page that has to be the transcript,
 * which is far larger and is what a tap is aimed at.
 */
export function namesContainer(
  content: string,
  height = 288 - STATUS_H,
  zOrderIndex = 1,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H,
    width: NAMES_W,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: CAPTION_PADDING,
    containerID: NAMES_ID,
    containerName: NAMES_NAME,
    content,
    isEventCapture: 0,
    zOrderIndex,
  })
}

/**
 * Build the transcript-only page (caption mode).
 *
 * Used to return from the Plex view. Must be rebuildPageContainer, never
 * createStartUpPageContainer - the startup call is once per app lifetime
 * and main.ts has already spent it.
 */
export async function showTranscriptPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  content: string,
  names = '',
): Promise<boolean> {
  // The strip is rebuilt with the page: rebuildPageContainer replaces
  // EVERY container, so a page that omits it loses the clock and battery.
  //
  // FOUR containers now, not three. zOrderIndex is ALL-OR-NOTHING per page
  // and must be unique across every container: transcript 0, names 1, clock
  // 10, battery 11. A duplicate or a missing one fails CLIENT-SIDE in
  // validateEvenHubPageContainerZOrder and never reaches the glasses -
  // rebuildPageContainer returns false with [EvenHub:...] on the console.
  const text = [
    transcriptContainer(content, 1),
    namesContainer(names),
    ...statusContainers(),
  ]

  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}

/**
 * A full-width single-message container, spanning the whole lens.
 *
 * Deliberately independent of NAMES_W and of everything else in captions.ts.
 * This is what the transcript container looked like before the caption page
 * became two columns, and pages that show one line of text - a Plex message,
 * an error - want exactly that, not a text column offset to make room for
 * speaker names that do not exist.
 */
export function messageContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H,
    width: 576,
    height: 288 - STATUS_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MESSAGE_ID,
    containerName: MESSAGE_NAME,
    content,
    isEventCapture: 1,
    zOrderIndex: 0,
  })
}

/**
 * Put one line of text on the lens, full width.
 *
 * Three containers: message 0, clock 10, battery 11. zOrderIndex is
 * all-or-nothing per page and unique across it.
 */
export async function showMessagePage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  content: string,
): Promise<boolean> {
  const text = [messageContainer(content), ...statusContainers()]
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}

/**
 * Build the Plex activity page: header text + scrollable list.
 *
 * `lines[0]` is the header ("3 streams"); the rest are one stream each.
 */
export async function showPlexPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  lines: string[],
): Promise<boolean> {
  const header = lines[0] ?? 'Plex'
  const items = lines
    .slice(1, 1 + MAX_ITEMS)
    .map(s => (s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) : s))

  // "Nobody is watching Plex." arrives as a single line with no streams.
  // A list with zero items is not a valid ListItemContainerProperty
  // (itemCount range starts at 1), so fall back to a plain text page.
  if (items.length === 0) {
    // Full width, NOT showTranscriptPage. Routing this through the caption
    // page meant "Nobody is watching Plex." inherited the name-column
    // offset and rendered pushed to the right. A Plex message has no
    // speaker and no business borrowing caption geometry.
    return showMessagePage(bridge, header)
  }

  const headerContainer = new TextContainerProperty({
    xPosition: 0,
    // Below the status strip, not under it.
    yPosition: STATUS_H,
    width: 576,
    height: HEADER_HEIGHT,
    borderWidth: 0,
    paddingLength: 4,
    containerID: PLEX_HEADER_ID,
    containerName: 'plex-header',
    // zOrderIndex is ALL-OR-NOTHING per page: because the list below sets
    // one, this must too, or the whole rebuild is rejected client-side with
    // MISSING_Z_ORDER_INDEX and never reaches the glasses.
    zOrderIndex: 0,
    content: header,
    // Only ONE container per page may capture events, and it must be the
    // list - otherwise scroll never reaches it.
    isEventCapture: 0,
  })

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H + HEADER_HEIGHT,
    width: 576,
    height: 288 - STATUS_H - HEADER_HEIGHT,
    borderWidth: 0,
    paddingLength: 4,
    containerID: PLEX_LIST_ID,
    containerName: PLEX_LIST_NAME,
    // Must differ from the header's: values are unique across listObject,
    // textObject and imageObject combined, not per-array.
    zOrderIndex: 1,
    itemContainer: new ListItemContainerProperty({
      // UNVERIFIED: the docs say itemCount is 1-20 but do not say whether
      // it means total items or how many are VISIBLE at once. Set to the
      // total here. If only some render, that is the answer - try a
      // smaller fixed number and let the OS page through them.
      itemCount: items.length,
      // 0 = auto fill length, per the SDK docs.
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
    isEventCapture: 1,
  })

  const text = [headerContainer, ...statusContainers()]

  // containerTotalNum counts EVERY container on the page, across
  // textObject and listObject together - not just the text ones.
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length + 1,
      textObject: text,
      listObject: [list],
    }),
  )
}