/**
 * Header-plus-scrollable-list page for the lens.
 *
 * The gateway sends {type:'answer', lines:[header, ...items]}. This module
 * turns that into a two-container page: a text header plus a native OS list.
 * It knows nothing about what the lines MEAN - Plex streams, a nutrition
 * card, anything that arrives as an array of strings renders here.
 *
 * WAS plex.ts. It was never Plex-specific; Plex was simply the first thing
 * that needed a list, and the name stuck until a second caller made it
 * misleading. The rename changed no behaviour.
 *
 * THE FIRST LINE IS THE HEADER, not an item. Callers on the gateway side must
 * emit one - plex_lines() returns ["3 streams", ...] and sparky.py's cards
 * lead with a title. A caller that forgets loses its first line into the
 * title bar, which looks like a rendering bug and is not one.
 *
 * Scrolling is NOT implemented here. The glasses scroll the list themselves
 * and report SCROLL_TOP_EVENT / SCROLL_BOTTOM_EVENT after the fact, so this
 * module only ever builds pages - it never responds to movement.
 *
 * THIS MODULE IS A LEAF. Nothing in the app imports it except main.ts, which
 * uses exactly one thing from it: showListPage(). The caption page, the
 * message page and the containers they are built from used to live here for
 * no better reason than that this view was the first thing that ever needed
 * to rebuild back into caption mode - they are in pages.ts now.
 *
 * That direction matters. Captions are the core of the device and a list
 * read-out is optional; the core cannot depend on the optional. Delete this
 * file and the only thing that breaks is the list page.
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
import { showMessagePage } from './pages'

// Hard caps from index.d.ts / SDK docs: max 20 items, 64 chars each.
// The gateway also truncates to its own line-width setting for visual
// width; this is the protocol ceiling, applied second as a backstop.
const MAX_ITEMS = 20
const MAX_ITEM_CHARS = 64

// Display is 576x288. The header takes a strip off the top; the list gets
// the rest. No font metrics exist anywhere in the SDK docs, so these are
// starting values to tune against a real lens, not derived numbers.
const HEADER_HEIGHT = 40

/**
 * Container IDs owned by this module.
 *
 * The allocation across the whole app is: 1 transcript, 2/3 list
 * header/items, 4/5 menu header/list, 6/7 assistant overlay, 8 speaker
 * names, 9 message, 10/11 status strip. 2 and 3 are these.
 */
export const LIST_HEADER_ID = 2
export const LIST_ITEMS_ID = 3

const LIST_ITEMS_NAME = 'lens-list'

/**
 * Header container name. ELEVEN characters, deliberately.
 *
 * Was 'lens-list-header' (16), and that alone stopped this page building:
 * every rebuild returned false with no [EvenHub:...] line on the console,
 * because the shipped validator does not inspect containerName - the HOST
 * rejected the page. The tell was that a list with zero items renders fine
 * (it falls through to showMessagePage below, which uses 'message', 7 chars)
 * while every real list page failed, and menu.ts builds a structurally
 * identical page with 'menu-header', 11 chars, and works.
 *
 * Every container name that renders in this app is <= 12 characters:
 * 'transcript', 'names', 'message', 'home', 'assist', 'status-clock',
 * 'status-batt', 'menu-header', 'menu-list'. The 16-char one was the only
 * outlier and the only broken page.
 *
 * The "capped at 16 characters" comments in statusbar.ts and overlay.ts are
 * UNVERIFIED and, on this evidence, wrong or off by one - index.d.ts only
 * declares `containerName?: string` and states no limit. 16 may be the
 * buffer size with a NUL terminator eating the last byte. Until someone
 * measures where the real edge is, keep new names short rather than
 * treating 16 as safe.
 */
const LIST_HEADER_NAME = 'list-header'

/**
 * Build the page: header text + scrollable list.
 *
 * `lines[0]` is the header ("3 streams", "Calories", "Water · Fri Aug 21");
 * everything after it becomes one list item each.
 */
export async function showListPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  lines: string[],
): Promise<boolean> {
  // An empty array should not happen - every caller emits a header - but
  // 'No data' at least puts something legible on the lens if one does.
  const header = lines[0] ?? 'No data'
  const items = lines
    .slice(1, 1 + MAX_ITEMS)
    .map(s => (s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) : s))

  // A one-line answer - "Nobody is watching Plex.", "No water logged." -
  // arrives as a header with nothing after it. A list with zero items is
  // not a valid ListItemContainerProperty (itemCount range starts at 1),
  // so fall back to a plain text page.
  if (items.length === 0) {
    // Full width, NOT showTranscriptPage. Routing this through the caption
    // page meant "Nobody is watching Plex." inherited the name-column
    // offset and rendered pushed to the right. A read-out has no speaker
    // and no business borrowing caption geometry.
    //
    // This is the ONE thing this module takes from pages.ts, and it is a
    // generic message page, not a caption one - so the dependency does not
    // put the captions back under this module's control.
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
    containerID: LIST_HEADER_ID,
    containerName: LIST_HEADER_NAME,
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
    containerID: LIST_ITEMS_ID,
    containerName: LIST_ITEMS_NAME,
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