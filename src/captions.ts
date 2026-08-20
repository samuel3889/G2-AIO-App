/**
 * Caption line buffer for the lens.
 *
 * WHAT THIS REPLACES
 *
 * main.ts used to send `(finalText + interimText).slice(-240)` to the
 * transcript container and let the glasses wrap it. Two consequences, both
 * visible on the lens:
 *
 *   1. `slice(-240)` cuts from the LEFT at an arbitrary character position.
 *      Every new word changes where the window starts, so the glasses re-wrap
 *      the whole block and every word already on screen shifts sideways. That
 *      is the "text moves around while you read it" problem.
 *   2. 240 characters is roughly four lines, so four lines is all you ever
 *      got — regardless of the container being 256px tall.
 *
 * THE FIX: wrap here, not on the glasses.
 *
 * Greedy word wrapping is PREFIX-STABLE. Wrapping left to right means that
 * once a line is full, appending more text to the end of the string cannot
 * change it — the extra words land on the next line instead. So if we do the
 * wrapping ourselves and send the glasses a string that already contains the
 * newlines, a word never changes its horizontal position. New words fill the
 * current line rightward; when it is full the block scrolls up by exactly one
 * line and everything keeps its column.
 *
 * WHAT THE SDK DOES NOT GIVE US
 *
 * TextContainerProperty's complete property list is xPosition, yPosition,
 * width, height, borderWidth, borderColor, borderRadius, paddingLength,
 * containerID, containerName, isEventCapture, zOrderIndex, content
 * (index.d.ts:410-425). There is no font size, no line height, no alignment.
 *
 * So "more spacing between lines" has exactly ONE mechanism available: put a
 * blank line between the text lines. That is a full line of gap, not a
 * fraction of one — there is no half-step. CAPTION_LINE_GAP is that switch,
 * and it costs capacity: with a gap of 1, half the rows on screen are blank.
 *
 * CALIBRATION
 *
 * Two numbers below are measured, not derived, because no font metrics exist
 * anywhere in the SDK. Set CAPTION_RULER = true for one run and read them off
 * the lens — see rulerText().
 */

// --- calibration knobs ------------------------------------------------------

/**
 * Characters that fit on ONE line of the transcript container.
 *
 * MEASURED on the lens with the ruler probe, 2026-08-20: 56. Not a guess any
 * more. It sits just above overlay.ts's CHARS_PER_LINE of 54, which is the
 * right relationship — the transcript container is wider than the assistant
 * box (576 vs 520) — so it also serves as a sanity check that the overlay
 * constant is in the right neighbourhood.
 *
 * Too HIGH -> the glasses wrap a line we thought fit, and that wrap is not in
 *             our line count, so the bottom line falls off the container.
 * Too LOW  -> visible empty gutter down the right-hand side.
 *
 * Tune with the ruler: the '>' at the end of each ruler row should sit as
 * close to the right edge as it can without the row wrapping.
 */
export const CAPTION_CHARS_PER_LINE = 56

/**
 * How many rows of text physically fit in the transcript container.
 *
 * MEASURED on the lens with the ruler probe, 2026-08-20: 9.
 *
 * The container is 576 x (288 - STATUS_H) = 576 x 256, padding 4, so 248px of
 * usable height. 248 / 9 = ~27.6px per row, which lands almost exactly on
 * overlay.ts's LINE_HEIGHT = 28 — so that guess was close, and the assistant
 * box's height estimate can be trusted more than its comment claims.
 *
 * This is up from the four lines the old `slice(-240)` allowed.
 */
export const CAPTION_ROWS = 9

/**
 * Blank rows inserted between text lines.
 *
 * 0 = single spaced, 1 = one blank row between each line. There is nothing in
 * between; see the header note.
 *
 * With CAPTION_ROWS = 9 the two settings are:
 *   gap 0 -> 9 lines, tight
 *   gap 1 -> 5 lines, double spaced   (floor((9 + 1) / 2))
 *
 * Both are better than the four crammed lines this replaced, so 1 is now a
 * real option rather than a sacrifice. Starting at 0 because nine lines is
 * already a large change and it is easier to judge the spacing once the
 * horizontal jitter is gone.
 */
export const CAPTION_LINE_GAP = 0

/**
 * DEBUG PROBE — set true for ONE run, read the two numbers above off the
 * lens, set the constants, set this back to false.
 *
 * Already used once, on 2026-08-20, which is where the 9 and the 56 came
 * from. Kept rather than deleted: the numbers are display-geometry
 * measurements, so anything that changes STATUS_H, the container height, or
 * the firmware's font invalidates them and this is how they get re-measured.
 *
 * When true the caption page renders a numbered column ruler instead of
 * speech. Nothing else changes: the socket still runs, the gateway still
 * transcribes, only the string sent to the container is replaced.
 *
 * Reading it:
 *   - Highest row number you can fully read      -> CAPTION_ROWS
 *   - Does any row wrap onto a second line?      -> CAPTION_CHARS_PER_LINE too high
 *   - Big empty gutter right of the '>' markers? -> CAPTION_CHARS_PER_LINE too low
 *   - Where does row L01 sit — top of the free
 *     area, or pushed to the bottom?             -> tells us whether the
 *     container top-aligns or bottom-aligns its text, which decides how the
 *     scroll behaves when there is less than a full screen of speech.
 */
export const CAPTION_RULER = false

/** How many rows the ruler draws. Deliberately more than we expect to fit. */
const RULER_ROWS = 14

// --- wrapping ---------------------------------------------------------------

/**
 * Greedy word wrap. Returns one string per line, no trailing newline.
 *
 * Word-aware because Whisper output is prose. A word longer than the line is
 * hard-broken rather than allowed to overflow — otherwise a URL or a long
 * compound would silently push a line past the container width and the
 * glasses would wrap it for us, which is the thing this module exists to
 * prevent.
 *
 * The prefix-stability property this whole module rests on: for any text T
 * and any suffix S, wrapLines(T + S) starts with every COMPLETE line of
 * wrapLines(T). Only the last, partially-filled line can change.
 */
export function wrapLines(text: string, width = CAPTION_CHARS_PER_LINE): string[] {
  const lines: string[] = []

  for (const para of text.split('\n')) {
    const before = lines.length
    let cur = ''

    for (const word of para.split(/\s+/)) {
      if (!word) continue
      let w = word

      // Hard-break anything wider than a line, a full line at a time.
      while (w.length > width) {
        if (cur) {
          lines.push(cur)
          cur = ''
        }
        lines.push(w.slice(0, width))
        w = w.slice(width)
      }

      if (!cur) cur = w
      else if (cur.length + 1 + w.length <= width) cur += ` ${w}`
      else {
        lines.push(cur)
        cur = w
      }
    }

    if (cur) lines.push(cur)
    // An empty paragraph is still a line — preserve deliberate blank lines.
    if (lines.length === before) lines.push('')
  }

  return lines
}

/** Text lines that fit on screen, once the blank spacer rows are paid for. */
export function visibleLines(): number {
  return Math.max(1, Math.floor((CAPTION_ROWS + CAPTION_LINE_GAP) / (1 + CAPTION_LINE_GAP)))
}

// --- scroll -----------------------------------------------------------------

/**
 * Index of the first line currently on screen. MONOTONIC — it only ever
 * increases within a session.
 *
 * Why it has to be sticky: `interimText` is re-decoded from the start of the
 * utterance on every partial, so it can get SHORTER between frames ("I scream
 * I" -> "ice cream"). Deriving the window purely from the current line count
 * would then slide the block back DOWN a line and then up again on the next
 * partial — a visible bounce on every sentence. Holding the top edge means a
 * shrinking partial just leaves the bottom row blank for a moment.
 *
 * Reset by resetCaptions() whenever the buffer it indexes into is cleared.
 */
let scrollTop = 0

/**
 * Drop the scroll position. Call this everywhere the caption text itself is
 * reset — otherwise the old offset indexes into a buffer that no longer has
 * that many lines and the lens shows nothing.
 */
export function resetCaptions(): void {
  scrollTop = 0
}

/**
 * The exact string to put in the transcript container.
 *
 * Takes the two halves separately rather than the concatenation main.ts used
 * to build, so this module keeps the option of treating the in-progress
 * partial differently later — dimming is impossible (no colour), but a
 * trailing marker is not.
 */
export function captionContent(finalText: string, interimText: string): string {
  if (CAPTION_RULER) return rulerText()

  const text = `${finalText}${interimText}`.trim()
  if (!text) {
    resetCaptions()
    return 'Listening…'
  }

  const lines = wrapLines(text)
  const cap = visibleLines()

  // Scroll only far enough to keep the newest line on screen, and never back.
  if (lines.length - scrollTop > cap) scrollTop = lines.length - cap
  // Guard: a caller that cleared the text without calling resetCaptions()
  // would otherwise leave scrollTop past the end and render an empty lens.
  if (scrollTop > Math.max(0, lines.length - 1)) scrollTop = Math.max(0, lines.length - 1)

  const window = lines.slice(scrollTop, scrollTop + cap)
  return window.join('\n'.repeat(1 + CAPTION_LINE_GAP))
}

// --- ruler ------------------------------------------------------------------

/** `----+----1----+----2…` of exactly `n` characters, last one a '>' marker. */
function rulerRow(n: number): string {
  let s = ''
  for (let c = 1; c <= n; c++) {
    if (c % 10 === 0) s += String((c / 10) % 10)
    else if (c % 5 === 0) s += '+'
    else s += '-'
  }
  return s.slice(0, Math.max(0, n - 1)) + '>'
}

/**
 * The calibration pattern. Every row is exactly CAPTION_CHARS_PER_LINE
 * characters wide including its `Lnn ` prefix, so a row that wraps on the
 * lens means the constant is too high.
 */
export function rulerText(): string {
  const out: string[] = []
  for (let i = 1; i <= RULER_ROWS; i++) {
    const head = `L${String(i).padStart(2, '0')} `
    out.push(head + rulerRow(Math.max(1, CAPTION_CHARS_PER_LINE - head.length)))
  }
  return out.join('\n')
}