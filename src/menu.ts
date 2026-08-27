/**
 * Glasses menu page.
 *
 * Same two-container shape as plex.ts: a text header plus a native OS list.
 * The OS owns scrolling and selection; this module only builds the page and
 * exports the item labels so main.ts can map a tap back to an action.
 *
 * Gesture model (platform convention, NOT invented here):
 *   single tap -> select
 *   double tap -> back
 *   long press -> shut down the container, handled by the OS
 *   scroll     -> owned by the OS list
 *
 * Note there is no long-press value in OsEventTypeList (index.d.ts:707) -
 * the OS consumes that gesture and the app only ever sees the result as
 * SYSTEM_EXIT_EVENT. So nothing here should call shutDownPageContainer on
 * a double tap; that would steal the back gesture.
 *
 * The Exit item below is a deliberate belt-and-braces exit path: if long
 * press ever fails to reach the OS, there is still a way out of the widget
 * that does not require force-quitting from the phone.
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

// Container IDs. 1 is the transcript, 2/3 are the Plex header and list
// (see plex.ts). The menu takes 4 and 5 so no page ever reuses an ID that
// another page also defines.
export const MENU_HEADER_ID = 4
export const MENU_LIST_ID = 5

// containerName is capped at 16 characters by the protocol.
const MENU_HEADER_NAME = 'menu-header'
const MENU_LIST_NAME = 'menu-list'

const HEADER_HEIGHT = 40
const MAX_ITEM_CHARS = 64

/**
 * Menu action identifiers. The LABEL shown on the lens changes with state
 * ("Start conversation" / "Stop & save"), so the label cannot be the key -
 * main.ts maps the selected INDEX back to one of these.
 */
export type MenuAction =
  | 'captions'
  | 'translate'
  | 'session'
  | 'mic'
  | 'exit'

/**
 * Fixed order. Index N here is index N in the list on the lens, which is
 * what makes the index-to-action mapping safe.
 */
export const MENU_ACTIONS: MenuAction[] = [
  'captions',
  'translate',
  'session',
  'mic',
  'exit',
]

export interface MenuState {
  sessionActive: boolean
  micOn: boolean
  utterances: number
  /** Translate mode running right now. */
  translateActive: boolean
  /**
   * The pair the Translate item will start, as internal codes.
   *
   * The LABEL carries it - "Translate EN › ES" - because starting a
   * translation from the lens offers no chance to pick one. Without the
   * pair on the item, the only way to find out which direction is about to
   * start would be to start it and look.
   */
  translatePair: { a: string; b: string }
}

/** Labels for the current state, in MENU_ACTIONS order. */
export function menuLabels(state: MenuState): string[] {
  const pair =
    `${state.translatePair.a.toUpperCase()} › ${state.translatePair.b.toUpperCase()}`
  return [
    'Captions',
    state.translateActive ? 'Stop translation' : `Translate ${pair}`,
    state.sessionActive ? 'Stop & save' : 'Start conversation',
    state.micOn ? 'Pause mic' : 'Resume mic',
    'Exit',
  ]
}

/** Header line for the current state. */
export function menuHeader(state: MenuState): string {
  // Translate first: it OWNS the lens while it runs, so it is the more
  // urgent of the two states to see from here. A recording can be running
  // underneath it and is reported again the moment translation stops.
  if (state.translateActive) {
    return `TRANSLATING · ${state.translatePair.a.toUpperCase()} › ` +
      `${state.translatePair.b.toUpperCase()}`
  }
  if (!state.sessionActive) return 'Menu'
  return `REC · ${state.utterances} line${state.utterances === 1 ? '' : 's'}`
}

/**
 * Build the menu page.
 *
 * Rebuilding resets the OS list selection to the first item, so this is
 * called on ENTRY and after an action that changes a label - never on a
 * live counter tick. A header that repainted every utterance would yank
 * the highlight back to "Captions" while the user was scrolling.
 */
export async function showMenuPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  state: MenuState,
): Promise<boolean> {
  const items = menuLabels(state).map(s =>
    s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) : s,
  )

  const header = new TextContainerProperty({
    xPosition: 0,
    // Below the persistent status strip, not under it.
    yPosition: STATUS_H,
    width: 576,
    height: HEADER_HEIGHT,
    borderWidth: 0,
    paddingLength: 4,
    containerID: MENU_HEADER_ID,
    containerName: MENU_HEADER_NAME,
    // All-or-nothing per page, and unique across every container array.
    zOrderIndex: 0,
    content: menuHeader(state),
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
    containerID: MENU_LIST_ID,
    containerName: MENU_LIST_NAME,
    zOrderIndex: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      // 0 = auto fill length, per the SDK docs.
      itemWidth: 0,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
    isEventCapture: 1,
  })

  // The strip is rebuilt with the page: rebuildPageContainer replaces EVERY
  // container, so a page that omits it loses the clock and battery.
  const text = [header, ...statusContainers()]

  // containerTotalNum counts EVERY container on the page, across textObject
  // and listObject together - not just the text ones.
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length + 1,
      textObject: text,
      listObject: [list],
    }),
  )
}