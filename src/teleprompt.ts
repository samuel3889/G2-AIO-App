/**
 * The teleprompter page: five lines of script, one per container.
 *
 * WHY FIVE CONTAINERS AND NOT ONE
 *
 * The obvious build is a single tall text container holding all five lines.
 * Two things rule that out.
 *
 * FIRST, BRIGHTNESS IS A PROPERTY OF A CONTAINER, NOT OF TEXT.
 * TextContainerProperty has `textColor` (index.d.ts:410-433) and the valid
 * range is MIN_TEXT_BRIGHTNESS 0 to MAX_TEXT_BRIGHTNESS 4. There is no font
 * size, no alignment, and no way to style a run of characters differently
 * from the ones beside it. So "already spoken" lines can only be dimmed by
 * living in their own container. Per-WORD graying, which the stock feature
 * does, is not reachable through this API at all - the finest grain
 * available is one line.
 *
 * SECOND, THE FIRMWARE SCROLLS TEXT CONTAINERS BY ITSELF.
 * Confirmed by probe on the caption page: a swipe moves the text with no
 * involvement from this app, and reports SCROLL_TOP_EVENT (1) /
 * SCROLL_BOTTOM_EVENT (2) as a textEvent afterwards. That means a container
 * whose content OVERFLOWS carries a scroll offset we can neither read nor
 * set - so pushing a new window into it would leave the lens showing an
 * offset we did not choose.
 *
 * One line per container makes that impossible by construction: content that
 * fits cannot be scrolled, so the only thing that ever moves the script is
 * the cursor in this module. The swipe events still arrive, and main.ts uses
 * them to move that cursor. We get the gesture without ceding the position.
 *
 * THE CONTAINER BUDGET IS EXACTLY FULL
 *
 * RebuildPageContainer caps `textObject` at 8. Five rows plus the three
 * statusContainers() (clock 10, battery 11, timer 13) is 8. There is no room
 * on this page for a sixth row or for a header of our own - which is fine,
 * because the elapsed timer the stock HUD puts in its header is already in
 * the status strip.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import { RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { statusContainers, STATUS_H, SCREEN_H } from './statusbar'
import { CAPTION_CHARS_PER_LINE, SCREEN_W, wrapLines } from './captions'

/**
 * How many script lines are on the lens at once.
 *
 * Capped by the SDK, not by taste: `textObject` holds at most 8 and the
 * status strip spends 3 of them. Six would still fit; five leaves the budget
 * with one spare slot and gives the focus line two lines of context on each
 * side.
 */
export const TELEPROMPT_ROWS = 5

/**
 * Which row the cursor sits on - the line being spoken NOW.
 *
 * Two above and two below, and FIXED: the highlight stays on this row and
 * the script slides up past it, one line at a time.
 *
 * A travelling highlight on a stationary page was tried instead and reverted.
 * It made the text move less often, which was not the problem - the problem
 * is HOW it moves, not how often.
 */
export const TELEPROMPT_FOCUS_ROW = 2

/**
 * Container IDs, one per row.
 *
 * The allocation across the app is 1 transcript, 2/3 list header/items, 6/7
 * assistant overlay, 8 names, 9 message, 10 clock, 11 battery, 12 home and
 * suggest, 13 timer, 14 alert, 15/16 translate. 17-21 were the next free
 * block.
 *
 * NOTE the z-order validator does NOT check containerID for duplicates -
 * only zOrderIndex. A colliding ID rebuilds cleanly and returns true, then
 * swallows its own textContainerUpgrade, so the failure is silent.
 */
export const TELEPROMPT_IDS = [17, 18, 19, 20, 21]

/**
 * Container names. Max 16 characters by protocol, so these are short.
 */
export const TELEPROMPT_NAMES = ['tp0', 'tp1', 'tp2', 'tp3', 'tp4']

/**
 * Brightness per row state, 0-4.
 *
 * SPOKEN is 0, the bottom of the range. 1 was tried first on the theory that
 * a line which vanishes entirely is worse than one that recedes - spoken
 * text is kept on screen so the wearer can find their place again after
 * losing it, and that only works if it is still readable. On the actual lens
 * 1 was not dim enough to separate the two states at a glance, so this is
 * now as low as MIN_TEXT_BRIGHTNESS allows.
 *
 * IF 0 TURNS OUT TO BE INVISIBLE rather than merely faint, the fix is to put
 * this back to 1 and lower UPCOMING and FOCUS instead - widening the gap from
 * the other end. Do not go below 0; isValidTextBrightness() rejects it and
 * the whole rebuild fails client-side.
 *
 * UPCOMING at 3 and FOCUS at 4 is a deliberately small gap. The lens is
 * monochrome and these are the only two levels that need distinguishing
 * while reading; a bigger gap made the upcoming lines hard to pre-read on
 * the caption page's own brightness experiments.
 */
export const SPOKEN_BRIGHTNESS = 0
export const FOCUS_BRIGHTNESS = 4
export const UPCOMING_BRIGHTNESS = 3

/** Same padding as every other page in this app. */
const TELEPROMPT_PADDING = 4

/**
 * Average px per character of the lens font.
 *
 * The same derivation captions.ts makes, from the one thing measured on
 * hardware: 56 characters across the full 576px width less padding. It is
 * recomputed here rather than imported because captions.ts keeps its copy
 * private.
 */
const PX_PER_CHAR = (SCREEN_W - 2 * TELEPROMPT_PADDING) / CAPTION_CHARS_PER_LINE

/**
 * Row height - and, because the script advances by exactly one row, THE
 * DISTANCE THE TEXT JUMPS on every scroll.
 *
 * TUNABLE, not a constant. It is `teleprompt_row_h` on the gateway, so it
 * survives a rebuild and can be adjusted from the phone while wearing the
 * glasses, which is the only way to judge it. The value here is the DEFAULT
 * and the fallback when /settings cannot be reached.
 *
 * Filling the glass gave 51px rows, so every scroll was a 51px instantaneous
 * translation - which is what reads as abrupt.
 *
 * ANIMATION WAS TRIED TWICE AND DOES NOT WORK ON THIS HARDWARE. A four-frame
 * probe measured 116, 120, 152 and 179ms per rebuildPageContainer, and a
 * three-frame slide built on those numbers stopped the prompter following
 * speech at all - half a second of BLE traffic per line, against utterances
 * arriving faster than that. Shortening the distance is the only lever that
 * costs nothing, which is why this became adjustable instead.
 *
 * A rendered line is PX_PER_ROW = 26 from captions.ts, so under about 32
 * the lines start to crowd. The gateway caps the slider at 50 because five
 * rows have to fit the 256px content area.
 */
let rowH = 36


/**
 * Wrap column for the script.
 *
 * TUNABLE, as `teleprompt_chars` on the gateway. The default is
 * CAPTION_CHARS_PER_LINE, the calibrated full-width figure from captions.ts.
 * TEXT_CHARS is NOT the right default: it is that figure reduced by the
 * speaker-name column, which this page does not have.
 *
 * Lowering it keeps text inside the comfortable centre of the eyebox at the
 * cost of more lines for the same script - and therefore more scrolls.
 */
let chars: number = CAPTION_CHARS_PER_LINE


/**
 * Split a script into lens lines.
 *
 * Wrapping happens ONCE, when a script is loaded, not on every render:
 * wrapLines is pure and the script does not change while it is being read,
 * so re-wrapping five lines per swipe would be work for nothing. It also
 * means the cursor indexes a stable array - a cursor into a list that could
 * be re-wrapped differently would be a position that quietly means something
 * else after a re-render.
 *
 * Blank lines survive, because wrapLines pushes an empty string for an empty
 * paragraph. That is wanted: a blank line in a script is a beat.
 */
export function telepromptLines(script: string): string[] {
  return wrapLines(script, chars)
}

/**
 * Clamp a cursor to the script.
 *
 * The cursor is a LINE INDEX into the array from telepromptLines(), not a
 * row on the lens. Row is derived from it in telepromptRows() below.
 */
export function clampCursor(cursor: number, lines: string[]): number {
  if (lines.length === 0) return 0
  if (cursor < 0) return 0
  if (cursor > lines.length - 1) return lines.length - 1
  return cursor
}

/**
 * Build the five row containers.
 *
 * Indices outside the script render as an EMPTY container rather than being
 * omitted: the page must always have the same containers in the same places,
 * because a rebuild that changes the container set changes the geometry, and
 * the first and last lines of a script would then sit somewhere different
 * from every other line.
 *
 * `isEventCapture` goes to the FOCUS row and to nothing else. Exactly one
 * container per page may capture events. Whether the choice matters for a
 * temple touchbar - which is not a touchscreen and has no notion of pointing
 * at a container - is not documented anywhere we have; the focus row is the
 * largest thing the wearer is actually looking at, which is the same rule
 * the caption page follows.
 */
export function telepromptRows(
  lines: string[],
  cursor: number,
): TextContainerProperty[] {
  const top = cursor - TELEPROMPT_FOCUS_ROW
  const focusRow = TELEPROMPT_FOCUS_ROW

  return TELEPROMPT_IDS.map((id, row) => {
    const index = top + row
    const content = index >= 0 && index < lines.length ? lines[index] : ''

    const textColor =
      row < focusRow
        ? SPOKEN_BRIGHTNESS
        : row === focusRow
          ? FOCUS_BRIGHTNESS
          : UPCOMING_BRIGHTNESS

    return new TextContainerProperty({
      xPosition: telepromptRowX(),
      yPosition: STATUS_H + row * rowH,
      width: telepromptRowWidth(),
      height: rowH,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: TELEPROMPT_PADDING,
      containerID: id,
      containerName: TELEPROMPT_NAMES[row],
      content,
      textColor,
      // Capture sits on the focus row, so it is on the line the wearer is
      // looking at. Exactly one container per page may hold it, and a page
      // with none reports no gestures at all - the prompter would go dead.
      isEventCapture: row === focusRow ? 1 : 0,
      // zOrderIndex is ALL-OR-NOTHING per page and must be unique across
      // every container on it. Rows take 0-4; statusContainers() uses 10, 11
      // and 12. A duplicate fails CLIENT-SIDE in
      // validateEvenHubPageContainerZOrder and never reaches the glasses -
      // rebuildPageContainer returns false with [EvenHub:...] on the
      // console, which on this setup means it returns false silently.
      zOrderIndex: row,
    })
  })
}

/**
 * Put the teleprompter on the lens.
 *
 * Eight containers: five rows plus the strip. Must be rebuildPageContainer,
 * never createStartUpPageContainer - the startup call is once per app
 * lifetime and main.ts has already spent it.
 */
export async function showTelepromptPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  lines: string[],
  cursor: number,
): Promise<boolean> {
  const text = [...telepromptRows(lines, cursor), ...statusContainers()]

  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}

/**
 * Words on a wrapped line.
 *
 * Whitespace-separated, matching what the gateway's follow.py tokenizer
 * counts. The two do NOT have to agree on what a word IS - the gateway
 * strips punctuation and lowercases, this does not - only on HOW MANY there
 * are, because the index is a position in a sequence. Both split on
 * whitespace and both discard empties, so the counts line up.
 *
 * The one case where they can diverge is a word longer than the wrap column,
 * which wrapLines() hard-breaks into fragments on separate lines. Each
 * fragment then counts as a word here and as one word there, so the index
 * drifts by the number of extra fragments. A 56-character unbroken word does
 * not occur in a speech, and the failure mode is a cursor a word or two off
 * rather than anything structural.
 */
function wordsOn(line: string): number {
  return line.split(/\s+/).filter(Boolean).length
}

/**
 * The word index at the START of a line - i.e. how many script words come
 * before it.
 *
 * Used when the wearer scrolls by hand: the gateway has to be told where the
 * thumb put the cursor, in the only coordinate it understands.
 */
export function wordIndexOfLine(lines: string[], lineIndex: number): number {
  let words = 0
  for (let i = 0; i < lineIndex && i < lines.length; i++) {
    words += wordsOn(lines[i])
  }
  return words
}

/**
 * The line containing a given word index - the inverse of the above.
 *
 * This is how a gateway word cursor becomes a row on the lens. Returns the
 * line the word FALLS ON, and clamps past the end to the last line, so a
 * finished script leaves the prompter showing its final lines rather than
 * scrolling into blankness.
 *
 * Blank lines carry no words, so a cursor landing exactly on a paragraph
 * break resolves to the line AFTER it - which is where the reader is about
 * to be, and the right side of the beat to show.
 */
export function lineOfWordIndex(lines: string[], word: number): number {
  if (lines.length === 0) return 0
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const n = wordsOn(lines[i])
    // `word < seen + n` rather than `<=`: a cursor sitting exactly on the
    // boundary is at the START of the next line, not the end of this one.
    if (n > 0 && word < seen + n) return i
    seen += n
  }
  return lines.length - 1
}

/** Current row height, for anything that needs to lay out a preview. */
export function telepromptRowH(): number {
  return rowH
}

/** Current wrap column. */
export function telepromptChars(): number {
  return chars
}

/**
 * Apply layout values fetched from the gateway's /settings.
 *
 * CLAMPED HERE AS WELL AS ON THE GATEWAY. The slider bounds are the
 * gateway's, but a stored settings.json edited by hand, or a value from an
 * older schema, would otherwise produce a page whose rows run off the glass
 * - and an out-of-range yPosition is a rebuild that fails validation, which
 * on these glasses means a prompter that silently does not appear.
 *
 * Anything missing or unparseable leaves the current value alone, so a
 * gateway that is down leaves a working prompter at its defaults rather than
 * a broken one at zero.
 */
export function setTelepromptLayout(v: {
  rowH?: unknown
  chars?: unknown
}): void {
  const maxRow = Math.floor((SCREEN_H - STATUS_H) / TELEPROMPT_ROWS)
  if (typeof v.rowH === 'number' && Number.isFinite(v.rowH)) {
    rowH = Math.max(24, Math.min(Math.round(v.rowH), maxRow))
  }
  if (typeof v.chars === 'number' && Number.isFinite(v.chars)) {
    chars = Math.max(12, Math.min(Math.round(v.chars), CAPTION_CHARS_PER_LINE))
  }
}

/**
 * Width of a row container, in pixels.
 *
 * Follows the wrap column rather than always filling the glass: a narrowed
 * prompter should be a narrower BOX, not a full-width box with text crammed
 * into its left end.
 */
export function telepromptRowWidth(): number {
  return Math.min(
    SCREEN_W,
    Math.round(chars * PX_PER_CHAR) + 2 * TELEPROMPT_PADDING,
  )
}

/**
 * Left edge of a row container - what CENTRES the narrowed prompter.
 *
 * There is no alignment property anywhere on TextContainerProperty; text
 * starts at the container's left edge and that is the whole of it. So
 * centring is done by centring the CONTAINER, which is the only lever the
 * SDK gives.
 */
export function telepromptRowX(): number {
  return Math.round((SCREEN_W - telepromptRowWidth()) / 2)
}