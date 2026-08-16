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
export const TRANSCRIPT_ID = 1
export const PLEX_HEADER_ID = 2
export const PLEX_LIST_ID = 3

export const TRANSCRIPT_NAME = 'transcript'
const PLEX_LIST_NAME = 'plex-list'

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
  height = 288,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: TRANSCRIPT_ID,
    containerName: TRANSCRIPT_NAME,
    content,
    isEventCapture,
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
): Promise<boolean> {
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 1,
      textObject: [transcriptContainer(content, 1)],
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
    return showTranscriptPage(bridge, header)
  }

  const headerContainer = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: HEADER_HEIGHT,
    borderWidth: 0,
    paddingLength: 4,
    containerID: PLEX_HEADER_ID,
    containerName: 'plex-header',
    content: header,
    // Only ONE container per page may capture events, and it must be the
    // list - otherwise scroll never reaches it.
    isEventCapture: 0,
  })

  const list = new ListContainerProperty({
    xPosition: 0,
    yPosition: HEADER_HEIGHT,
    width: 576,
    height: 288 - HEADER_HEIGHT,
    borderWidth: 0,
    paddingLength: 4,
    containerID: PLEX_LIST_ID,
    containerName: PLEX_LIST_NAME,
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

  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: 2,
      textObject: [headerContainer],
      listObject: [list],
    }),
  )
}