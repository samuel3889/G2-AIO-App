/**
 * Glasses contextual menu.
 *
 * This file used to build a menu PAGE: a text header plus a native OS list,
 * reached by double tap. That page is gone. The same actions are now declared
 * to the glasses OS as a contextual menu, which the OS raises on
 * TAP THEN LONG PRESS and renders itself without waking the WebView.
 *
 * What that changes:
 *
 *   - There is no MENU page mode any more. The menu is an OS overlay drawn on
 *     top of whatever page is already up; the page underneath stays mounted
 *     and keeps the screen the whole time.
 *   - Selection does not arrive as a list tap. It arrives as its own
 *     top-level `menuItemClickEvent` on the SAME onEvenHubEvent subscription,
 *     carrying only the itemID. It does NOT route through isEventCapture, so
 *     it reaches us regardless of which container is capturing.
 *   - Index-to-action mapping is gone with the list. Each action owns a
 *     STABLE numeric itemID instead, so reordering MENU_ACTIONS can no longer
 *     silently remap a selection to the wrong thing.
 *
 * Protocol constraints, from the SDK types in index.d.ts and the contextual
 * menu docs - all of these are checked client-side by
 * validateEvenHubPageContainerMenu() and fail the whole rebuild locally
 * rather than reaching the glasses:
 *
 *   - at most 10 items                     (TOO_MANY_MENU_ITEMS)
 *   - itemID is a non-zero uint32, unique  (INVALID_MENU_ITEM_ID,
 *                                           DUPLICATE_MENU_ITEM_ID)
 *   - itemName is at most 32 UTF-8 BYTES,
 *     which is not 32 characters           (INVALID_MENU_ITEM_NAME)
 *
 * The OS wraps our items in system slots we do not control and cannot
 * address: Display off and Brightness above, "Close <app name>" below.
 *
 * THE MENU IS DECLARED WITH THE PAGE, NOT FETCHED ON DEMAND. It is attached
 * as `menuObject` on createStartUpPageContainer / rebuildPageContainer, and
 * it is replaced wholesale, never merged. A rebuild that OMITS menuObject
 * CLEARS the custom items - omission is significant, not neutral. That is why
 * main.ts wraps the bridge rather than editing every page builder: every
 * rebuild in the app has to carry this forward or the menu vanishes on the
 * next page change.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import {
  MenuContainerProperty,
  MenuItemProperty,
  utf8ByteLength,
} from '@evenrealities/even_hub_sdk'

/**
 * Menu action identifiers. The LABEL shown on the lens changes with state
 * ("Start conversation" / "Stop & save"), so the label cannot be the key -
 * main.ts maps the itemID reported by the OS back to one of these.
 */
export type MenuAction =
  | 'captions'
  | 'translate'
  | 'session'
  | 'mic'
  | 'exit'

/**
 * Payload order. There is NO ordering field on MenuItemProperty - the OS
 * renders items in the order they appear in the array, so this array is the
 * menu order. Reorder here to reorder the menu.
 */
export const MENU_ACTIONS: MenuAction[] = [
  'captions',
  'translate',
  'session',
  'mic',
  'exit',
]

/**
 * Stable protocol IDs, one per action.
 *
 * ZERO IS RESERVED by the protocol and is rejected by SDK validation, so
 * these start at 1. These numbers are the wire contract between the menu we
 * declare and the click event that comes back - they must never be reused
 * for a different action, and they are deliberately NOT derived from the
 * position in MENU_ACTIONS so that reordering the menu cannot remap them.
 */
export const MENU_ITEM_IDS: Record<MenuAction, number> = {
  captions: 1,
  translate: 2,
  session: 3,
  mic: 4,
  exit: 5,
}

/** Reverse lookup, built once from the table above. */
const ACTION_BY_ID = new Map<number, MenuAction>(
  (Object.keys(MENU_ITEM_IDS) as MenuAction[]).map(a => [MENU_ITEM_IDS[a], a]),
)

/**
 * Resolve an incoming menuItemClickEvent.itemID to an action.
 *
 * Returns undefined for an unknown or missing ID rather than guessing. Unlike
 * the list page this replaced, there is NO protobuf zero-value trap to work
 * around here: itemID 0 is illegal by protocol, so an absent field really
 * does mean "no item", never "item 0".
 */
export function actionForItemId(id?: number): MenuAction | undefined {
  if (typeof id !== 'number') return undefined
  return ACTION_BY_ID.get(id)
}

export interface MenuState {
  sessionActive: boolean
  micOn: boolean
  utterances: number
  /** Translate mode running right now. */
  translateActive: boolean
  /**
   * The pair the Translate item will start, as internal codes.
   *
   * The LABEL carries it - "Translate EN > ES" - because starting a
   * translation from the lens offers no chance to pick one. Without the
   * pair on the item, the only way to find out which direction is about to
   * start would be to start it and look.
   */
  translatePair: { a: string; b: string }
}

/**
 * The menu as it is declared on the STARTUP page.
 *
 * createStartUpPageContainer runs at module top level in main.ts, BEFORE the
 * `let sessionActive` / `micOn` / `translatePair` declarations further down
 * that file - reading them there would be a temporal dead zone crash, not a
 * stale label. So the launch menu is declared from this literal instead.
 *
 * IT MUST MATCH main.ts's INITIAL VALUES (main.ts: `translatePair` at its
 * declaration, `sessionActive`, `sessionUtterances`, `micOn`). main.ts
 * re-declares the menu from live state as soon as the mic is up, so this is
 * only what is on the glasses for the first moments after launch.
 */
export const LAUNCH_MENU_STATE: MenuState = {
  sessionActive: false,
  micOn: false,
  utterances: 0,
  translateActive: false,
  translatePair: { a: 'en', b: 'es' },
}

/**
 * Trim a label to the protocol's 32 UTF-8 BYTE limit without splitting a
 * character in half.
 *
 * utf8ByteLength is the SDK's own byte counter, so this measures exactly what
 * validateEvenHubPageContainerMenu() will measure. Array.from() iterates by
 * code point rather than by UTF-16 unit, so dropping the last element can
 * never leave half a surrogate pair behind.
 *
 * Every label built below is comfortably inside the limit today. This exists
 * so that a longer language name or a renamed action degrades to a truncated
 * item rather than to INVALID_MENU_ITEM_NAME, which fails the ENTIRE rebuild
 * client-side - taking the page down with the menu.
 */
const MAX_ITEM_BYTES = 32

function fitLabel(label: string): string {
  if (utf8ByteLength(label) <= MAX_ITEM_BYTES) return label
  const chars = Array.from(label)
  while (chars.length && utf8ByteLength(chars.join('')) > MAX_ITEM_BYTES) {
    chars.pop()
  }
  return chars.join('')
}

/**
 * Labels for the current state, in MENU_ACTIONS order.
 *
 * Exported because it is worth logging what was actually declared: the OS
 * renders these itself and never tells us what it drew.
 *
 * '>' rather than the '\u203a' this used on the list page. The OS renders one
 * line per slot and does not wrap, and plain ASCII keeps the byte count equal
 * to the character count so the ~16-character readable width is easy to
 * reason about.
 */
export function menuLabels(state: MenuState): string[] {
  const pair =
    `${state.translatePair.a.toUpperCase()} > ${state.translatePair.b.toUpperCase()}`
  return [
    'Captions',
    state.translateActive ? 'Stop translation' : `Translate ${pair}`,
    state.sessionActive ? 'Stop & save' : 'Start conversation',
    state.micOn ? 'Pause mic' : 'Resume mic',
    'Exit',
  ].map(fitLabel)
}

/**
 * Build the contextual menu for the current state.
 *
 * MENU CLICKS ARE FIRE AND FORGET: the glasses do not re-render item state
 * and there is no acknowledgement path back from the app to an open menu. An
 * item that reads "Pause mic" keeps reading "Pause mic" until the menu is
 * DECLARED AGAIN, which only happens on a page rebuild. That is why main.ts
 * rebuilds the current page after an action that flips one of these labels.
 */
export function menuContainer(state: MenuState): MenuContainerProperty {
  const labels = menuLabels(state)
  return new MenuContainerProperty({
    menuItems: MENU_ACTIONS.map(
      (action, i) =>
        new MenuItemProperty({
          itemName: labels[i],
          itemID: MENU_ITEM_IDS[action],
        }),
    ),
  })
}