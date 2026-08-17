/**
 * Assistant overlay box.
 *
 * ONE box. It is drawn around the question as soon as there is one, and it
 * GROWS downward as "Thinking…" and then the answer are appended to the same
 * container. Previously this returned two stacked containers; a single one
 * is what makes it read as one growing box rather than a box that spawns a
 * second box underneath it.
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

// Container IDs. 1 transcript, 2/3 plex, 4/5 menu, 6 overlay.
export const OVERLAY_Q_ID = 6
// No longer used: the answer shares the question's container. Kept reserved
// so nothing else claims 7 and collides if a second box ever comes back.
export const OVERLAY_A_ID = 7

// containerName is capped at 16 characters. Exported because
// textContainerUpgrade has to name the same container this module built —
// two copies of the string would drift apart and the upgrade would silently
// target nothing.
export const OVERLAY_NAME = 'assist'

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

/**
 * TEMPORARY DEBUG PROBE — set back to null once we know the answer.
 *
 * When this is a string, the box renders THAT and nothing else: seven ASCII
 * characters, one line, no newlines, no curly quotes, no ellipsis. The real
 * content has all four of those, and the Plex header and menu labels — which
 * DO render — have none of them.
 *
 * Reading the result:
 *   TEST visible  -> the container, geometry, ID and border are all fine, and
 *                    something in the CONTENT string is what blanks the box.
 *   still blank   -> the content is irrelevant; the container itself is not
 *                    rendering, and geometry/ID/border is where to look next.
 */
const DEBUG_BOX_TEXT: string | null = 'TEST'

/** Border colour 0-16. One border now, for the whole exchange. */
const BOX_BORDER_COLOR = 12

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
 * Build the overlay container for the current assistant state.
 *
 * Returns an ARRAY of exactly one box. The array shape is kept because
 * main.ts spreads it into textObject and derives containerTotalNum from its
 * length — returning a bare container would mean changing both, for no gain.
 *
 * The box is sized to its content, so it grows in place across the phases:
 * question -> question + "Thinking…" -> question + answer.
 */
export function assistantBox(s: AssistantState): TextContainerProperty[] {
  const qText = questionText(s)
  const aText = answerText(s)

  // A blank line between the two so the reply is visually separate from the
  // question without a second border to separate it.
  const body = DEBUG_BOX_TEXT ?? (aText ? `${qText}\n\n${aText}` : qText)

  // Clamp: trim until the box fits above the bottom margin.
  const avail = MAX_BOX_BOTTOM - BOX_TOP
  const maxLines = Math.max(1, Math.floor((avail - BOX_PADDING * 2) / LINE_HEIGHT))
  let shown = body
  if (countLines(shown) > maxLines) {
    // Cut by characters rather than lines: countLines is an estimate, and
    // slicing to a hard character budget cannot overshoot the way a
    // line-based cut can.
    shown = `${body.slice(0, maxLines * CHARS_PER_LINE - 1).trimEnd()}…`
  }

  return [
    new TextContainerProperty({
      xPosition: BOX_MARGIN_X,
      yPosition: BOX_TOP,
      width: BOX_W,
      height: Math.min(boxHeight(shown), avail),
      borderWidth: 2,
      borderColor: BOX_BORDER_COLOR,
      borderRadius: 4,
      paddingLength: BOX_PADDING,
      containerID: OVERLAY_Q_ID,
      containerName: OVERLAY_NAME,
      // Only container on the overlay page, so depth 0 of 1.
      zOrderIndex: zFor(0, 1),
      // Exactly one container per page captures events, and while the
      // overlay is up it must be this one - so a tap dismisses the box.
      isEventCapture: 1,
    }),
  ]
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