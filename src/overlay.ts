/**
 * Assistant overlay: a dim question with a bright answer under it.
 *
 * TWO containers again, and this time for a reason the SDK forces. Brightness
 * is `textColor` on TextContainerProperty and it is a property of a
 * CONTAINER, not of text - the same constraint the teleprompter runs into.
 * So "my speech dim, the reply full brightness" is only expressible as two
 * containers, whatever it costs in layout.
 *
 * The question is BORDERLESS and dim; only the answer carries a border. That
 * keeps the pair reading as one exchange rather than two boxes: what is
 * framed is the thing worth reading, and what the wearer already said sits
 * quietly above it as context.
 *
 * The page this box goes on carries NOTHING ELSE — main.ts no longer puts
 * the transcript underneath it, so whatever was on the lens disappears for
 * the duration of the exchange.
 *
 * WHAT THE SDK DOES NOT GIVE US, and how this works around it:
 *
 * 1. No text colour, font, or opacity. TextContainerProperty's complete
 *    property list is position, size, borderWidth, borderColor,
 *    borderRadius, paddingLength, containerID, containerName,
 *    isEventCapture, content (index.d.ts:356-377). borderColor (0-16) is
 *    the only colour knob in the entire API.
 *    => There is now one border for the whole exchange. The old dim-border
 *       trick made the QUESTION read as secondary; with one container there
 *       is one border, so that distinction is gone. It cost a second box.
 *
 * 2. No z-order and no foreground layer. The only "foreground layer" in the
 *    SDK is shutDownPageContainer(1)'s exit dialog, which is the OS's own
 *    and cannot hold our content. An overlay is therefore a page REBUILD.
 *    => With nothing behind it, OVERLAP no longer decides anything. It is
 *       kept exported so nothing that imports it breaks.
 *
 * 3. No font metrics. Height has to be estimated from a character count.
 *    CHARS_PER_LINE and LINE_HEIGHT are GUESSES and need calibrating against
 *    a real lens - see the note on each.
 */
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { STATUS_H } from './statusbar'

// Container IDs. 1 transcript, 2/3 plex, 4/5 menu, 6 overlay.
export const OVERLAY_Q_ID = 6
// In use again: the answer needs its own container to carry its own
// brightness. See assistantBox().
export const OVERLAY_A_ID = 7

// containerName is capped at 16 characters. Exported because
// textContainerUpgrade has to name the same container this module built —
// two copies of the string would drift apart and the upgrade would silently
// target nothing.
export const OVERLAY_NAME = 'assist'

/** Name of the answer container. Also capped at 16 characters. */
export const OVERLAY_A_NAME = 'assistA'

const SCREEN_W = 576
const SCREEN_H = 288

/**
 * Historically: draw the box ON TOP of the transcript (true), or shrink the
 * transcript and sit below it (false).
 *
 * The overlay page no longer carries the transcript at all, so this decides
 * nothing now. Kept as an export only so existing imports still compile.
 */
export const OVERLAP = true

// --- z-order ----------------------------------------------------------------

/**
 * Does a HIGHER zOrderIndex draw in FRONT?
 *
 * The SDK documents zOrderIndex as controlling stacking order and validates
 * it, but nowhere states the direction — I checked both index.d.ts and the
 * compiled index.js. This is the one thing that has to be found empirically.
 *
 * With a single container on the overlay page there is nothing to stack, so
 * this no longer affects the overlay. It still matters to any page that
 * carries more than one container.
 */
export const HIGHER_IS_FRONT = true

/**
 * Resolve a depth to a zOrderIndex.
 *
 * `depth` is 0 for the backmost container, increasing toward the front.
 * `total` is how many containers the page has. Reversing preserves
 * uniqueness, which the SDK requires — see assignZOrder below.
 */
export function zFor(depth: number, total: number): number {
  return HIGHER_IS_FRONT ? depth : total - 1 - depth
}

/**
 * Z-ORDER RULES, read out of the shipped validator (index.js), not the docs.
 * validateEvenHubPageContainerZOrder runs CLIENT-SIDE before the bridge call:
 *
 *  1. ALL-OR-NOTHING. If any container on the page sets zOrderIndex, every
 *     container must — across listObject, textObject AND imageObject
 *     together. Otherwise: MISSING_Z_ORDER_INDEX.
 *  2. UNIQUE. No two containers may share a value, again across all three
 *     arrays. Otherwise: DUPLICATE_Z_ORDER_INDEX.
 *  3. FINITE NUMBER. Otherwise: INVALID_Z_ORDER_INDEX.
 *  4. Omitting it everywhere stays valid — that is the 0.0.10 behaviour.
 *
 * Failure does NOT reach the glasses. createStartUpPageContainer returns 1
 * (invalid) and rebuildPageContainer returns false, with `[EvenHub:CODE]
 * message` logged to console. So a half-applied zOrderIndex looks exactly
 * like a rebuild failure — check the console before suspecting the display.
 */

// --- geometry ---------------------------------------------------------------

const BOX_MARGIN_X = 28

/**
 * Gap between the bottom of the status strip and the top of the box.
 *
 * THIS is the knob for the box's vertical position. BOX_TOP is derived from
 * it so the box can never be tuned back on top of the clock: raise BOX_GAP
 * to push the box further down, lower it to tighten against the strip. 0
 * puts the border flush under the strip.
 */
const BOX_GAP = 8

/** Top edge of the box. Always below the strip, by construction. */
const BOX_TOP = STATUS_H + BOX_GAP

/**
 * Bottom margin, INDEPENDENT of BOX_TOP.
 *
 * These used to be the same number (MAX_BOX_BOTTOM was SCREEN_H - BOX_TOP),
 * which meant pushing the box down to clear the strip also raised its floor
 * by the same amount and cost a long answer two lines at both ends. Tune
 * this one on its own if answers are getting clipped.
 */
const BOX_BOTTOM_MARGIN = 20

const BOX_PADDING = 6
const BOX_W = SCREEN_W - BOX_MARGIN_X * 2

/**
 * Characters that fit on one line. THIS is the knob for trailing empty
 * space in the box.
 *
 * countLines() uses it to decide how tall the box must be, so a value that
 * is too LOW makes a one-line answer count as two and reserves an extra
 * LINE_HEIGHT of blank space under the text. Too HIGH and the last line
 * gets clipped instead.
 *
 * Was 30, copied from PLEX_LINE_CHARS in app.py - a different font context,
 * and measurably wrong here: a 48-character answer rendered on one line, so
 * the real figure is somewhere near 56. 50 leaves headroom, because the
 * font is proportional and a line of wide glyphs runs longer than an
 * average one while this counts every character the same.
 *
 * To tune: put up a long answer. Blank space under the last line -> raise.
 * Last line clipped -> lower.
 */
export const CHARS_PER_LINE = 54

/**
 * Height of one text line, in px. The SECOND knob for box height.
 *
 * UNVERIFIED - no font metrics exist anywhere in the SDK. CHARS_PER_LINE
 * above controls how many lines the box thinks it needs; this controls how
 * tall each one is. Fix the line COUNT first, then trim this if there is
 * still slack: a wrong value here is off by a few px per line, a wrong
 * value there is off by a whole line at once.
 */
export const LINE_HEIGHT = 28

/** Border colour 0-16. One border now, for the whole exchange. */
const BOX_BORDER_COLOR = 12

// Never let a very long answer push the box off screen.
const MAX_BOX_BOTTOM = SCREEN_H - BOX_BOTTOM_MARGIN

// --- content ----------------------------------------------------------------

export interface AssistantState {
  phase: 'listening' | 'question' | 'thinking' | 'answer'
  question: string
  answer: string
}

/**
 * Lines a string will occupy, counting explicit newlines and wrapping.
 *
 * Word-aware, because Whisper output is prose: breaking mid-word would make
 * the estimate optimistic and clip the last line.
 */
export function countLines(text: string, width = CHARS_PER_LINE): number {
  if (!text) return 0
  let lines = 0
  for (const para of text.split('\n')) {
    if (!para) {
      lines += 1
      continue
    }
    let col = 0
    let used = 1
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      const need = col === 0 ? word.length : word.length + 1
      if (col + need > width) {
        used += 1
        // A word longer than the line takes extra lines of its own.
        col = word.length % width
        used += Math.floor(word.length / width)
      } else {
        col += need
      }
    }
    lines += used
  }
  return lines
}

/** Height in px for a box holding `text`, including padding. */
function boxHeight(text: string): number {
  return countLines(text) * LINE_HEIGHT + BOX_PADDING * 2
}

/** The question line for each phase. */
function questionText(s: AssistantState): string {
  if (s.phase === 'listening') return 'Listening…'
  return s.question ? `“${s.question}”` : 'Listening…'
}

/** The reply line, or '' when there is nothing to show yet. */
function answerText(s: AssistantState): string {
  if (s.phase === 'thinking') return 'Thinking…'
  if (s.phase === 'answer') return s.answer
  return ''
}

/**
 * Brightness of the wearer's own words, 0-4.
 *
 * 0, the floor. What the wearer said is CONTEXT - they already know it, and
 * they are waiting on the reply. Keeping it on the lens at all is so they
 * can check what was heard when an answer looks wrong; it does not need to
 * compete with the answer for attention.
 */
const Q_BRIGHTNESS = 0

/** Brightness of the reply. The ceiling - this is the thing being read. */
const A_BRIGHTNESS = 4

/** Vertical gap between the question and the answer box. */
const PAIR_GAP = 6

/**
 * Lines of question kept before it is trimmed.
 *
 * A rambling question must not eat the space the answer needs. Three lines
 * is enough to recognise what was heard, which is the only job it has.
 */
const MAX_Q_LINES = 3

/** Trim `text` to at most `lines`, with an ellipsis when it was cut. */
function clampText(text: string, lines: number): string {
  if (lines < 1) return ''
  if (countLines(text) <= lines) return text
  // Cut by CHARACTERS rather than lines: countLines is an estimate, and a
  // hard character budget cannot overshoot the way a line-based cut can.
  return `${text.slice(0, lines * CHARS_PER_LINE - 1).trimEnd()}…`
}

/**
 * Build the overlay containers for the current assistant state.
 *
 * Returns ONE container while there is nothing to reply with yet, and TWO
 * once there is - the question above, dim and borderless, and the answer
 * below it in a bordered box at full brightness.
 *
 * main.ts spreads the array into textObject, derives containerTotalNum from
 * its length, and upgrades every entry, so a second box needs no change
 * there beyond upgrading all of them rather than the first.
 */
export function assistantBox(s: AssistantState): TextContainerProperty[] {
  const avail = MAX_BOX_BOTTOM - BOX_TOP
  const linesFor = (px: number) =>
    Math.max(0, Math.floor((px - BOX_PADDING * 2) / LINE_HEIGHT))

  const aText = answerText(s)

  // The question is trimmed FIRST and to a fixed ceiling, so the answer's
  // budget does not depend on how long-winded the question was.
  const qShown = clampText(
    questionText(s),
    aText ? Math.min(MAX_Q_LINES, linesFor(avail)) : linesFor(avail),
  )
  const qHeight = Math.min(boxHeight(qShown), avail)

  const question = new TextContainerProperty({
    xPosition: BOX_MARGIN_X,
    yPosition: BOX_TOP,
    width: BOX_W,
    height: qHeight,
    // NO BORDER on the question. One frame per exchange, around the answer.
    borderWidth: 0,
    borderColor: BOX_BORDER_COLOR,
    borderRadius: 4,
    paddingLength: BOX_PADDING,
    containerID: OVERLAY_Q_ID,
    containerName: OVERLAY_NAME,
    // `content` must be passed here even though main.ts follows the rebuild
    // with a textContainerUpgrade: the upgrade reads it back off this
    // object, so a container built without it sends '' too and draws empty.
    content: qShown,
    textColor: Q_BRIGHTNESS,
    zOrderIndex: zFor(0, 2),
    // Capture goes to the ANSWER when there is one - see below - so this
    // holds it only while the question is alone on the page.
    isEventCapture: aText ? 0 : 1,
  })

  if (!aText) return [question]

  const aTop = BOX_TOP + qHeight + PAIR_GAP
  const aAvail = MAX_BOX_BOTTOM - aTop
  const aShown = clampText(aText, linesFor(aAvail))

  const answer = new TextContainerProperty({
    xPosition: BOX_MARGIN_X,
    yPosition: aTop,
    width: BOX_W,
    height: Math.min(boxHeight(aShown), aAvail),
    borderWidth: 2,
    borderColor: BOX_BORDER_COLOR,
    borderRadius: 4,
    paddingLength: BOX_PADDING,
    containerID: OVERLAY_A_ID,
    containerName: OVERLAY_A_NAME,
    content: aShown,
    textColor: A_BRIGHTNESS,
    zOrderIndex: zFor(1, 2),
    // Exactly one container per page captures events, and while the overlay
    // is up it must be one of these - so a tap dismisses the box.
    isEventCapture: 1,
  })

  return [question, answer]
}

/**
 * Bottom edge of the overlay.
 *
 * main.ts no longer needs this (nothing is laid out underneath the box any
 * more), but it is kept exported so existing imports still compile.
 */
export function overlayBottom(s: AssistantState): number {
  const boxes = assistantBox(s)
  const last = boxes[boxes.length - 1]
  return (last.yPosition ?? 0) + (last.height ?? 0)
}