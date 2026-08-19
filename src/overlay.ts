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
import { STATUS_H } from './statusbar'

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

/**
* TEMPORARY DEBUG PROBE — leave as 'TEST' for ONE run to confirm the
 * content fix, then set to null.
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
const DEBUG_BOX_TEXT: string | null = null

/**
 * TEMPORARY DEBUG PROBE 2.
 *
 * When true, the box is drawn with the SAME geometry the transcript
 * container uses — origin 0,0, full 576 width, no border, no radius,
 * padding 4 — and only its height follows the content. The only thing that
 * still differs from the caption page is the container ID and name.
 *
 * The pattern this is testing: every container in this app that renders
 * text (transcript, Plex header, menu header) sits at x=0, y=0 and spans
 * the full width. The assistant box is the only one that does not, and it
 * is the only one whose text never appears — while its BORDER draws in the
 * right place. That is what a text run positioned at the page origin and
 * then clipped to the container rectangle would look like.
 *
 *   TEST appears -> position/border is the culprit; add one property back
 *                   at a time (x offset, then y offset, then border) until
 *                   it disappears again.
 *   still blank  -> geometry is not it either, and the next variable is the
 *                   container ID: reuse 1/'transcript' and see if the same
 *                   box renders under the identity the OS already knows.
 */
const DEBUG_PLAIN_GEOMETRY = false

/**
 * TEMPORARY DEBUG PROBE 3.
 *
 * When true, the box is built as containerID 1 / 'transcript' — the exact
 * identity created by createStartUpPageContainer at boot, and the only
 * container in this app that has ever been written to successfully by
 * textContainerUpgrade.
 *
 * What is left to explain: with probe 2 the box had the transcript's
 * geometry and still rendered no text, so position, width, border and
 * padding are all cleared. The remaining differences between it and a
 * container that works are its ID/name, and the fact that the overlay page
 * carries a single container while the Plex and menu pages carry two.
 * This tests the first of those.
 *
 *   TEST appears -> a text container invented by rebuildPageContainer cannot
 *                   be written to; the overlay must reuse ID 1, and the
 *                   whole OVERLAY_Q_ID idea goes away.
 *   still blank  -> ID is not it either, and the last variable is the
 *                   single-container page: next probe adds a second, dummy
 *                   container so the overlay page has the same shape as the
 *                   Plex and menu pages that do render.
 */
const DEBUG_TRANSCRIPT_IDENTITY = false

// Kept in sync with plex.ts's TRANSCRIPT_ID / TRANSCRIPT_NAME by hand: this
// is probe scaffolding, not permanent, and importing plex.ts here just to
// read two constants would couple the layout module to the page module.
const PROBE_ID = 1
const PROBE_NAME = 'transcript'

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
      xPosition: DEBUG_PLAIN_GEOMETRY ? 0 : BOX_MARGIN_X,
      yPosition: DEBUG_PLAIN_GEOMETRY ? 0 : BOX_TOP,
      width: DEBUG_PLAIN_GEOMETRY ? SCREEN_W : BOX_W,
      height: DEBUG_PLAIN_GEOMETRY ? 288 : Math.min(boxHeight(shown), avail),
      // Back to 2 for this round. Text is absent with the border at 0 AND at
      // 2, so the border is not the variable any more — but a visible frame
      // is how you confirm the page is up while reading the diagnostics on
      // the phone.
      borderWidth: 2,
      borderColor: DEBUG_PLAIN_GEOMETRY ? 5 : BOX_BORDER_COLOR,
      borderRadius: DEBUG_PLAIN_GEOMETRY ? 0 : 4,
      paddingLength: DEBUG_PLAIN_GEOMETRY ? 4 : BOX_PADDING,
      containerID: DEBUG_TRANSCRIPT_IDENTITY ? PROBE_ID : OVERLAY_Q_ID,
      containerName: DEBUG_TRANSCRIPT_IDENTITY ? PROBE_NAME : OVERLAY_NAME,
      // THE BUG: `shown` was computed above and then never passed. The
      // container went to the lens with no `content` at all, so the box
      // drew and stayed empty — and main.ts reads `boxes[0].content` to
      // build its textContainerUpgrade, so the upgrade sent '' too.
      content: shown,
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