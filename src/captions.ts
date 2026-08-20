/**
 * Caption buffer for the lens.
 *
 * WHAT THIS IS
 *
 * A list of UTTERANCES, not a string. Each one is a seq, its text, and the
 * name of whoever said it once the gateway tells us. Rendering wraps each
 * utterance under a fixed-width speaker prefix and returns the window that
 * fits on screen.
 *
 * WHY IT IS NOT A STRING ANY MORE
 *
 * The name arrives AFTER the text. gateway.py sends {"type":"final"} and
 * only then spawns run_speaker(), which embeds the audio and scores it
 * against the roster (gateway.py:3486-3496). So a line lands on the lens
 * unnamed and the name follows a few hundred ms later, keyed by seq. There
 * is no way to fill that in without keeping the utterances addressable.
 *
 * The in-progress partial has NO seq — {"type":"partial"} carries only text,
 * audio_ms and stt_ms (gateway.py:3586). It does not need one: the partial is
 * always the newest utterance, so it is held as `pending` and adopts a seq
 * when its 'final' arrives.
 *
 * WHY THE NAMES ARE A SEPARATE COLUMN
 *
 * They used to be a prefix padded with spaces to a fixed character count.
 * That DOES NOT WORK: the lens font is proportional, and the SDK exposes no
 * font metrics of any kind. Eight spaces is narrower than "Samuel: " and
 * wider than "?:" plus six, so continuation rows landed left of the text on
 * one line and right of it on the next — both errors visible on the lens at
 * once.
 *
 * So captionColumns() returns TWO strings, rendered into two containers side
 * by side (plex.ts: namesContainer + transcriptContainer). Same yPosition,
 * height and padding, so row N on the left is on row N on the right by
 * construction, whatever the glyphs are. Alignment becomes geometry instead
 * of character counting.
 *
 * A continuation row gets an EMPTY line in the names column, which is what
 * keeps the two sides on the same grid.
 *
 * WHAT THE SDK DOES NOT GIVE US
 *
 * TextContainerProperty's complete property list is xPosition, yPosition,
 * width, height, borderWidth, borderColor, borderRadius, paddingLength,
 * containerID, containerName, isEventCapture, zOrderIndex, content
 * (index.d.ts:410-425). No font size, no line height, no alignment, no
 * colour. So there is no way to dim a partial or emphasise a name — the only
 * lever is the characters themselves.
 *
 * That is also why "more spacing between lines" means inserting a blank row.
 * It is a full row, not a fraction; CAPTION_LINE_GAP is that switch.
 */

// --- calibration ------------------------------------------------------------

/**
 * Characters that fit on ONE line of the transcript container.
 *
 * MEASURED on the lens with the ruler probe, 2026-08-20: 56. It sits just
 * above overlay.ts's CHARS_PER_LINE of 54, which is the right relationship —
 * the transcript container is wider than the assistant box (576 vs 520).
 */
export const CAPTION_CHARS_PER_LINE = 56

/** Lens width in px. */
export const SCREEN_W = 576

/**
 * paddingLength on both caption containers.
 *
 * Exported so plex.ts uses THIS value in the containers it builds. The
 * arithmetic below subtracts it, so a padding that was set independently over
 * there would silently throw the character count off.
 */
export const CAPTION_PADDING = 4

/**
 * >>> THE ONE NUMBER TO CHANGE <<<
 *
 * Width of the speaker-name column in px. Everything else about the two
 * columns is derived from it.
 *
 * Must clear the widest name that can render, which NAME_CHARS caps at six
 * plus a colon - 'Samuel:' is the worst case by construction.
 *
 *   name clipped, or the colon missing   -> RAISE
 *   wide empty gully before the words    -> LOWER
 *
 * Lives here rather than in plex.ts because it is a caption-layout decision.
 * plex.ts imports it to build the containers; nothing about the speaker
 * column belongs to the Plex page.
 */
export const NAMES_W = 88

/**
 * Average px per character of the lens font.
 *
 * Derived from the one thing actually measured on hardware: 56 characters
 * across the full 576px width, less padding on both sides. That measurement
 * is the anchor for every width in this file.
 */
const PX_PER_CHAR = (SCREEN_W - 2 * CAPTION_PADDING) / CAPTION_CHARS_PER_LINE

/**
 * Characters that fit on one line of the TEXT column.
 *
 * DERIVED, not configured - this is what makes NAMES_W the only number that
 * has to change. It used to be a second hand-scaled constant, which meant
 * every resize was two edits and one of them was easy to forget; forgetting
 * it clips the last word of a line instead of wrapping it.
 *
 * APPROXIMATE, because the font is PROPORTIONAL and this treats it as fixed.
 * That is fine for choosing a wrap column - being a character conservative
 * costs nothing - but it can be off by one either way. CAPTION_RULER renders
 * into the text column and still checks it: the '>' at the end of each row
 * should sit as close to the right edge as it can without the row wrapping.
 */
export const TEXT_CHARS = Math.floor(
  (SCREEN_W - NAMES_W - 2 * CAPTION_PADDING) / PX_PER_CHAR,
)

/**
 * How many rows of text physically fit in the transcript container.
 *
 * MEASURED on the lens with the ruler probe, 2026-08-20: 9.
 *
 * The container is 576 x (288 - STATUS_H) = 576 x 256, padding 4, so 248px of
 * usable height. 248 / 9 = ~27.6px per row, which lands almost exactly on
 * overlay.ts's LINE_HEIGHT = 28 — so that guess was close.
 */
export const CAPTION_ROWS = 9

/**
 * Blank rows inserted between text lines.
 *
 *   gap 0 -> 9 lines, tight
 *   gap 1 -> 5 lines, double spaced   (floor((9 + 1) / 2))
 *
 * Both beat the four crammed lines this replaced, so 1 is a real option
 * rather than a sacrifice.
 */
export const CAPTION_LINE_GAP = 0

/**
 * Characters of the speaker's name that get shown.
 *
 * Six, because "Samuel" is six and he is in every conversation. Anything
 * longer is truncated for DISPLAY ONLY — the roster name is untouched, and so
 * is anything written to the session file. "Adelaide" renders "Adelai".
 *
 * This is now a guard against OVERFLOWING plex.ts's NAMES_W, not an
 * alignment mechanism — alignment is the two containers' geometry. A name
 * that is too wide for the column gets clipped by the container, so this
 * bounds the worst case at 'Samuel:' and NAMES_W is sized for that.
 */
export const NAME_CHARS = 6

/** What an unidentified voice is called. */
const UNKNOWN_NAME = '?'

/**
 * DEBUG PROBE — renders a numbered column ruler instead of speech.
 *
 * Already used once, on 2026-08-20, which is where the 9 and the 56 came
 * from. Kept rather than deleted: those are display-geometry measurements, so
 * anything that changes STATUS_H, the container height, or the firmware's
 * font invalidates them and this is how they get re-measured.
 *
 *   - Highest row number you can fully read      -> CAPTION_ROWS
 *   - Does any row wrap onto a second line?      -> CAPTION_CHARS_PER_LINE
 *                                                   is too high
 *   - Empty gutter right of the '>' markers?     -> too low
 */
export const CAPTION_RULER = false

/** How many rows the ruler draws. More than we expect to fit, on purpose. */
const RULER_ROWS = 14

/**
 * Hard cap on retained utterances.
 *
 * Pruning normally happens as the buffer scrolls — an utterance whose lines
 * are entirely above the window is dropped — so this only fires in cases
 * where scrolling somehow does not. It is a memory backstop, not the primary
 * mechanism.
 */
const MAX_UTTERANCES = 60

// --- buffer -----------------------------------------------------------------

interface Utterance {
  /** null while this is the in-progress partial; set when its 'final' lands. */
  seq: number | null
  text: string
  /** null = not identified, renders as '?'. Never falls back to an S-label. */
  name: string | null
}

let utterances: Utterance[] = []

/**
 * The in-progress utterance, or null. Always the last element of `utterances`
 * when it exists — held separately only so setPartial() does not have to
 * search for it.
 */
let pending: Utterance | null = null

/**
 * First line currently on screen, in ABSOLUTE line coordinates — counting
 * lines that pruning has already discarded. MONOTONIC within a session.
 *
 * Why it is sticky: a partial is re-decoded from the start of the utterance
 * every time, so its text can get SHORTER between frames ("I scream I" ->
 * "ice cream") and drop a line. Deriving the window from the current line
 * count would slide the block back down and then up again on the next
 * partial — a visible bounce on every sentence. Holding the top edge means a
 * shrinking partial just leaves the bottom row blank for a moment.
 */
let scrollTop = 0

/** Lines discarded by pruning. `scrollTop` is measured from before these. */
let prunedLines = 0

/** Drop everything. Call wherever the transcript itself is cleared. */
export function resetCaptions(): void {
  utterances = []
  pending = null
  scrollTop = 0
  prunedLines = 0
}

/**
 * Update the in-progress utterance, creating it if there is not one.
 *
 * Called for both {"type":"partial"} and the "someone is talking" placeholder
 * on {"type":"speech", active:true} — the gateway sends the latter about a
 * second before Whisper returns anything, and without it the lens sits still
 * while someone is visibly speaking.
 */
export function setPartial(text: string): void {
  if (!pending) {
    pending = { seq: null, text, name: null }
    utterances.push(pending)
  } else {
    pending.text = text
  }
}

/**
 * An utterance finished. Commits the pending line under `seq`.
 *
 * The final text is NOT always the partial text — Whisper re-decodes with
 * more context and can change its mind — so this overwrites rather than
 * appends.
 *
 * A 'final' with no pending line in front of it is normal, not an error:
 * short utterances can finish before the partial interval elapses, and
 * partials are suppressed entirely for wake phrases.
 */
export function pushFinal(seq: number, text: string): void {
  if (pending) {
    pending.seq = seq
    pending.text = text
    pending = null
  } else {
    utterances.push({ seq, text, name: null })
  }

  // Backstop only; the scroll-based prune in captionContent() does the work.
  while (utterances.length > MAX_UTTERANCES) {
    const gone = utterances.shift()
    if (!gone) break
    prunedLines += lineCount(gone)
  }
  if (scrollTop < prunedLines) scrollTop = prunedLines
}

/**
 * Fill in the name for an utterance, from {"type":"speaker"}.
 *
 * `name` is null when the gateway scored the voice but neither threshold
 * cleared — that stays '?' rather than falling back to `speaker`, because an
 * S-label means nothing to the person wearing the glasses.
 *
 * A seq that is no longer in the buffer is ignored, not an error: an
 * utterance can scroll off while its audio is still being embedded.
 *
 * Because the prefix column is a fixed width, filling a name in NEVER changes
 * the line count or the wrap. The text does not move.
 */
export function setName(seq: number, name: string | null): void {
  for (let i = utterances.length - 1; i >= 0; i--) {
    if (utterances[i].seq === seq) {
      utterances[i].name = name
      return
    }
  }
}

// --- rendering --------------------------------------------------------------

/** Text lines that fit on screen, once the blank spacer rows are paid for. */
export function visibleLines(): number {
  return Math.max(1, Math.floor((CAPTION_ROWS + CAPTION_LINE_GAP) / (1 + CAPTION_LINE_GAP)))
}

/**
 * `Samuel:`, `Adelai:`, `?:` — NO padding. The column's width is the
 * container's width, not a character count.
 *
 * Truncation is display-only and deliberately silent: a name that does not
 * fit is still better identification than no name.
 */
export function prefixFor(name: string | null): string {
  return `${(name ?? UNKNOWN_NAME).slice(0, NAME_CHARS)}:`
}

/**
 * Greedy word wrap. Returns one string per line, no trailing newline.
 *
 * Word-aware because Whisper output is prose. A word wider than the line is
 * hard-broken rather than allowed to overflow — otherwise the glasses would
 * wrap it for us, which is the thing this module exists to prevent.
 *
 * The property everything else rests on: for any text T and any suffix S,
 * wrapLines(T + S) starts with every COMPLETE line of wrapLines(T). Only the
 * last, partially-filled line can change. That is what stops a word already
 * on screen from moving when the next one arrives.
 */
export function wrapLines(text: string, width = TEXT_CHARS): string[] {
  const lines: string[] = []

  for (const para of text.split('\n')) {
    const before = lines.length
    let cur = ''

    for (const word of para.split(/\s+/)) {
      if (!word) continue
      let w = word

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
    if (lines.length === before) lines.push('')
  }

  return lines
}

/** Rows one utterance occupies. */
function lineCount(u: Utterance): number {
  return wrapLines(u.text).length
}

/**
 * One utterance as parallel rows: names on the left, words on the right.
 *
 * The name goes on the first row only; every continuation row gets an EMPTY
 * name. The two arrays are always the same length, which is what keeps the
 * columns on a shared grid.
 */
function renderUtterance(u: Utterance): { names: string[]; text: string[] } {
  const text = wrapLines(u.text)
  const names = text.map((_, i) => (i === 0 ? prefixFor(u.name) : ''))
  return { names, text }
}

/**
 * Drop utterances that have scrolled entirely off the top.
 *
 * Keeps at least one so the buffer is never empty while a conversation is
 * live, and only ever drops lines already above the window — so pruning
 * cannot change what is on screen.
 */
function prune(): void {
  while (utterances.length > 1) {
    const n = lineCount(utterances[0])
    if (prunedLines + n > scrollTop) break
    utterances.shift()
    prunedLines += n
  }
}

/** What goes in the two caption containers. Always the same row count. */
export interface CaptionColumns {
  /** Goes in namesContainer(). */
  names: string
  /** Goes in transcriptContainer(). */
  text: string
}

/**
 * The exact strings to put in the two caption containers.
 *
 * Takes no arguments: everything it needs is in the buffer above, which
 * main.ts fills through setPartial / pushFinal / setName.
 *
 * The ruler and the idle message go in the TEXT column with an empty names
 * column, so the page shape never changes and no rebuild is needed to show
 * them.
 */
export function captionColumns(): CaptionColumns {
  if (CAPTION_RULER) return { names: '', text: rulerText() }
  if (utterances.length === 0) return { names: '', text: 'Listening…' }

  const nameRows: string[] = []
  const textRows: string[] = []
  for (const u of utterances) {
    const r = renderUtterance(u)
    nameRows.push(...r.names)
    textRows.push(...r.text)
  }

  const cap = visibleLines()
  const total = prunedLines + textRows.length

  // Scroll only far enough to keep the newest line on screen, and never back.
  if (total - scrollTop > cap) scrollTop = total - cap
  if (scrollTop < prunedLines) scrollTop = prunedLines

  const from = scrollTop - prunedLines
  const sep = '\n'.repeat(1 + CAPTION_LINE_GAP)

  prune()

  return {
    names: nameRows.slice(from, from + cap).join(sep),
    text: textRows.slice(from, from + cap).join(sep),
  }
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
 * The calibration pattern. Every row is exactly TEXT_CHARS wide including its
 * `Lnn ` prefix, so a row that wraps on the lens means TEXT_CHARS is too
 * high for the current NAMES_W.
 */
export function rulerText(): string {
  const out: string[] = []
  for (let i = 1; i <= RULER_ROWS; i++) {
    const head = `L${String(i).padStart(2, '0')} `
    // Sized to the TEXT column, which is what it now renders into.
    out.push(head + rulerRow(Math.max(1, TEXT_CHARS - head.length)))
  }
  return out.join('\n')
}