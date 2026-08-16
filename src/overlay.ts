/**
 * Assistant overlay box.
 *
 * Shows your question and Jarvis's reply in a bordered box drawn over the
 * current page, without leaving that page.
 *
 * WHAT THE SDK DOES NOT GIVE US, and how this works around it:
 *
 * 1. No text colour, font, or opacity. TextContainerProperty's complete
 *    property list is position, size, borderWidth, borderColor,
 *    borderRadius, paddingLength, containerID, containerName,
 *    isEventCapture, content (index.d.ts:356-377). borderColor (0-16) is
 *    the only colour knob in the entire API.
 *    => "Question dimmer than the answer" is done with a DIM BORDER on the
 *       question box and a bright border on the answer box. The text itself
 *       renders identically; that is not tunable.
 *
 * 2. No z-order and no foreground layer. The only "foreground layer" in the
 *    SDK is shutDownPageContainer(1)'s exit dialog, which is the OS's own
 *    and cannot hold our content. An overlay is therefore a page REBUILD
 *    carrying the base containers plus these boxes.
 *    => Whether overlapping containers stack predictably is undocumented.
 *       OVERLAP below switches between drawing over the transcript and
 *       splitting the screen with it. If the lens renders the overlap badly,
 *       flip it to false.
 *
 * 3. No font metrics. Height has to be estimated from a character count.
 *    CHARS_PER_LINE and LINE_HEIGHT are GUESSES and need calibrating against
 *    a real lens - see the note on each.
 */
import { TextContainerProperty } from '@evenrealities/even_hub_sdk'

// Container IDs. 1 transcript, 2/3 plex, 4/5 menu, 6/7 overlay.
export const OVERLAY_Q_ID = 6
export const OVERLAY_A_ID = 7

// containerName is capped at 16 characters.
const OVERLAY_Q_NAME = 'assist-q'
const OVERLAY_A_NAME = 'assist-a'

const SCREEN_W = 576
const SCREEN_H = 288

/**
 * Draw the box ON TOP of the transcript (true), or shrink the transcript and
 * sit below it (false).
 *
 * SDK 0.0.11+ added zOrderIndex, so overlapping is now a supported, defined
 * operation rather than the gamble it was on 0.0.10. Kept as a switch only
 * as a fallback if stacking misbehaves on your firmware.
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
 * Test: trigger an assistant box. If it draws OVER the transcript, this is
 * right. If the transcript covers it, flip to false. Nothing else changes.
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
const BOX_TOP = 20
const BOX_PADDING = 6
const BOX_W = SCREEN_W - BOX_MARGIN_X * 2

/**
 * UNVERIFIED. 30 matches the PLEX_LINE_CHARS default in app.py, which is
 * itself a guess that was tuned by eye. Calibrate the same way: put a long
 * answer up, raise until a line wraps early, then back off one.
 */
export const CHARS_PER_LINE = 30

/**
 * UNVERIFIED. No font metrics exist anywhere in the SDK. If boxes come out
 * too tall (empty space under the last line) lower this; if text is clipped
 * at the bottom, raise it.
 */
export const LINE_HEIGHT = 28

/** Border colour 0-16. The only way to make the question read as secondary. */
const Q_BORDER_COLOR = 2
const A_BORDER_COLOR = 12

// Never let a very long answer push the box off screen.
const MAX_BOX_BOTTOM = SCREEN_H - BOX_TOP

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

/** What the question box shows for each phase. */
function questionText(s: AssistantState): string {
  if (s.phase === 'listening') return 'Listening…'
  return s.question ? `“${s.question}”` : 'Listening…'
}

/** What the answer box shows, or '' when there is nothing to show yet. */
function answerText(s: AssistantState): string {
  if (s.phase === 'thinking') return 'Thinking…'
  if (s.phase === 'answer') return s.answer
  return ''
}

/**
 * Build the overlay containers for the current assistant state.
 *
 * Returns one box while waiting, two once there is an answer. The boxes are
 * sized to their content and stacked, so the pair grows downward as the
 * exchange fills in: question -> question + "Thinking…" -> question + answer.
 */
export function assistantBox(s: AssistantState): TextContainerProperty[] {
  const qText = questionText(s)
  const aText = answerText(s)

  const qH = boxHeight(qText)
  const out: TextContainerProperty[] = []

  out.push(
    new TextContainerProperty({
      xPosition: BOX_MARGIN_X,
      yPosition: BOX_TOP,
      width: BOX_W,
      height: qH,
      borderWidth: 1,
      // Dim border: this is the only "dimmer" the SDK allows. The text
      // inside renders exactly like the answer's.
      borderColor: Q_BORDER_COLOR,
      borderRadius: 4,
      paddingLength: BOX_PADDING,
      containerID: OVERLAY_Q_ID,
      containerName: OVERLAY_Q_NAME,
      // Depth 1 of 3: transcript(0) < question(1) < answer(2). `total` must
      // match what renderAssistant actually puts on the page, or the values
      // collide when HIGHER_IS_FRONT is false.
      zOrderIndex: zFor(1, 3),
      content: qText,
      // Capture goes to the LAST box added, so it is set below once we know
      // whether an answer box exists.
      isEventCapture: 0,
    }),
  )

  if (aText) {
    const top = BOX_TOP + qH + 4
    // Clamp: trim the answer until its box fits above the bottom margin.
    const avail = MAX_BOX_BOTTOM - top
    const maxLines = Math.max(1, Math.floor((avail - BOX_PADDING * 2) / LINE_HEIGHT))
    let shown = aText
    if (countLines(shown) > maxLines) {
      // Cut by characters rather than lines: countLines is an estimate, and
      // slicing to a hard character budget cannot overshoot the way a
      // line-based cut can.
      shown = `${aText.slice(0, maxLines * CHARS_PER_LINE - 1).trimEnd()}…`
    }

    out.push(
      new TextContainerProperty({
        xPosition: BOX_MARGIN_X,
        yPosition: top,
        width: BOX_W,
        height: Math.min(boxHeight(shown), avail),
        borderWidth: 2,
        borderColor: A_BORDER_COLOR,
        borderRadius: 4,
        paddingLength: BOX_PADDING,
        containerID: OVERLAY_A_ID,
        containerName: OVERLAY_A_NAME,
        zOrderIndex: zFor(2, 3),
        content: shown,
        // Exactly one container on the page captures events, and while the
        // overlay is up it must be the overlay - so a tap dismisses the box
        // rather than doing whatever the page underneath does.
        isEventCapture: 1,
      }),
    )
  } else {
    out[0].isEventCapture = 1
    // No answer box: the page is transcript(0) + question(1), two containers.
    // Recompute, because zFor(1, 3) and zFor(1, 2) differ when
    // HIGHER_IS_FRONT is false and the transcript would then collide.
    out[0].zOrderIndex = zFor(1, 2)
  }

  return out
}

/**
 * Bottom edge of the overlay, for laying out the page underneath when
 * OVERLAP is false.
 */
export function overlayBottom(s: AssistantState): number {
  const boxes = assistantBox(s)
  const last = boxes[boxes.length - 1]
  return (last.yPosition ?? 0) + (last.height ?? 0)
}