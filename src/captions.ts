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

import { STATUS_H, SCREEN_H } from './statusbar'

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
 * Height of one row of text, in px.
 *
 * MEASURED, not derived - and the distinction cost a row before it was
 * noticed. A row count is a FLOOR: "9 rows fit in 248px" only says a row is
 * at MOST 248/9 = 27.56px, and it is consistent with anything down to
 * 248/10 = 24.8px. Dividing height by row count therefore anchors on the
 * CEILING of the possible range, and every figure derived from it
 * underestimates how many rows fit.
 *
 * Three CAPTION_RULER measurements on the simulator, 2026-08-21, each
 * bracketing from both sides (N fit, N+1 did not):
 *
 *   usable 248px -> 9 rows  ->  24.8  < row <= 27.56
 *   usable 184px -> 7 rows  ->  23.0  < row <= 26.29
 *   usable 157px -> 6 rows  ->  22.43 < row <= 26.17
 *
 * Intersection: 24.8 < row <= 26.17. 26.0 sits inside it and reproduces all
 * three counts exactly, and every SUGGEST_ROWS value from 0 to 4 besides.
 *
 * ERR HIGH IF YOU RE-MEASURE. Too high only wastes a row to blank space.
 * Too low makes captionColumns() emit more lines than the container holds,
 * and the container CLIPS - so the line that disappears is the one at the
 * bottom, which is the NEWEST thing anyone said.
 *
 * NOTE overlay.ts's LINE_HEIGHT = 28 is outside this range and is therefore
 * also wrong. It only affects the assistant box's own wrapping, so it is not
 * touched here, but it is worth correcting separately.
 */
const FULL_CONTENT_H = SCREEN_H - STATUS_H
export const PX_PER_ROW = 26.0

/**
 * >>> THE ONE NUMBER TO CHANGE <<<  (for the suggestion band)
 *
 * How many rows of the lens are given over to the proactive suggester's
 * band, which sits BELOW the captions and spans the full width.
 *
 * The band is a PERMANENT container on the caption page, holding '' when
 * there is nothing to show. That is deliberate, and it is the whole reason
 * this is a fixed reservation rather than something that appears and
 * disappears: a container's geometry is FROZEN at creation
 * (G2_HANDOFF.md §5), so a band that came and went would need a full
 * rebuildPageContainer on every appearance AND every expiry, destroying and
 * recreating both caption columns each time. With a permanent container,
 * showing and clearing a suggestion is a textContainerUpgrade — the same
 * cost as an ordinary caption repaint.
 *
 * The price is paid once, in caption rows, and it is real:
 *
 *   0 -> captions 9 rows, band OFF entirely   (pre-suggest behaviour)
 *   1 -> captions 8 rows, band ~56 chars        (~9 words)
 *   2 -> captions 7 rows, band ~112 chars       (~18 words)
 *   3 -> captions 6 rows, band ~168 chars       (~28 words)
 *   4 -> captions 5 rows, band ~224 chars       (~37 words)
 *
 * All four VERIFIED against CAPTION_RULER, not predicted.
 *
 * 3 is the starting value: it is the smallest band that holds
 * SUGGEST_PROMPT's current 30-word cap without truncating, so it needs no
 * .env change to try. Dropping to 2 buys a caption row back but requires
 * cutting that cap to ~18 words, and 1 requires cutting it to ~9, which is
 * too short for a CHECK to say anything useful.
 *
 * A suggestion longer than the band is not lost, it is truncated with an
 * ellipsis by suggest.ts - but a truncated CHECK is worse than no CHECK,
 * so treat truncation as a signal to cut the prompt rather than to live
 * with it.
 */
export const SUGGEST_ROWS = 3

/** Height of the suggestion band in px, or 0 when it is switched off. */
export const SUGGEST_BAND_H =
  SUGGEST_ROWS > 0
    ? Math.ceil(SUGGEST_ROWS * PX_PER_ROW + 2 * CAPTION_PADDING)
    : 0

/**
 * Height of the caption columns WHEN THE BAND IS UP.
 *
 * Also what fixes the band's own top edge, below - so this stays a constant
 * even though the live height is now a function. The band always has the
 * same geometry whenever it exists; what varies is whether it exists.
 */
const CAPTION_BODY_H_WITH_BAND = FULL_CONTENT_H - SUGGEST_BAND_H

/** Top edge of the band. Immediately below the shortened caption columns. */
export const SUGGEST_Y = STATUS_H + CAPTION_BODY_H_WITH_BAND

// --- band visibility (RUNTIME) ----------------------------------------------

/**
 * Whether the suggestion band is currently on the caption page.
 *
 * RUNTIME STATE, unlike SUGGEST_ROWS. The band belongs to conversate, and
 * conversate is a recording session - so outside a session the rows go back
 * to the captions rather than sitting empty behind a border.
 *
 * WHY THIS IS MUTABLE MODULE STATE AND WHAT THAT COSTS
 *
 * A container's geometry is FROZEN at creation, so the two caption columns
 * have a DIFFERENT HEIGHT depending on whether the band is up. That means
 * changing this flag is only half the job: the page has to be REBUILT for it
 * to mean anything, and main.ts's lastNames/lastText cache has to be cleared
 * with it, because the containers those describe no longer exist.
 *
 * showCaptions() in main.ts already does both. Nothing else may flip this.
 *
 * Starts false: there is no session at boot, so the startup page main.ts
 * builds is the full-height one.
 */
let bandVisible = false

/**
 * Set band visibility. Returns TRUE if the value actually changed.
 *
 * The return value is the point: the caller uses it to decide whether a page
 * rebuild is needed. Session frames arrive on every utterance while
 * recording, and rebuilding the page on each one would destroy and recreate
 * both caption columns several times a minute.
 *
 * Forced false when SUGGEST_ROWS is 0, so the compile-time switch still wins
 * outright and no caller has to check both.
 */
export function setBandVisible(visible: boolean): boolean {
  const next = SUGGEST_ROWS > 0 && visible
  if (next === bandVisible) return false
  bandVisible = next
  return true
}

/** Whether the band should be built into the page right now. */
export function isBandVisible(): boolean {
  return bandVisible
}

/**
 * Height of the two caption columns AS OF NOW.
 *
 * pages.ts calls THIS for the default height of both transcriptContainer()
 * and namesContainer(), so the columns and the band cannot disagree about
 * where one ends and the other begins. A default parameter is evaluated per
 * call, so each page build picks up the current value.
 */
export function captionBodyH(): number {
  return bandVisible ? CAPTION_BODY_H_WITH_BAND : FULL_CONTENT_H
}

/**
 * How many rows of text physically fit in the (now shorter) transcript
 * container.
 *
 * A FUNCTION, not a constant, because the band comes and goes with the
 * recording session and the columns change height with it. Call it per
 * render; do not cache the result across a page rebuild.
 *
 * DERIVED from captionBodyH() so that SUGGEST_ROWS is the only number that
 * has to change. It used to be the measured literal 9; keeping it a literal
 * would mean every band resize was two edits, and forgetting the second one
 * either wastes a row or writes a row the container silently clips.
 *
 * APPROXIMATE — it treats a proportional font's row height as exact. Verify
 * with CAPTION_RULER after changing SUGGEST_ROWS: the highest row number you
 * can fully read is the true value, and if it disagrees, MEASURED_FULL_ROWS
 * above is what needs re-measuring, not this.
 */
export function captionRows(): number {
  return Math.max(
    1,
    Math.floor((captionBodyH() - 2 * CAPTION_PADDING) / PX_PER_ROW),
  )
}

/**
 * Characters that fit on one line of the FULL-WIDTH suggestion band.
 *
 * The band is not offset by the name column — a suggestion has no speaker —
 * so it gets the full 56, not TEXT_CHARS.
 */
export const SUGGEST_CHARS = Math.floor(
  (SCREEN_W - 2 * CAPTION_PADDING) / PX_PER_CHAR,
)

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
 *   - Highest row number you can fully read      -> captionRows()
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
  return Math.max(
    1,
    Math.floor((captionRows() + CAPTION_LINE_GAP) / (1 + CAPTION_LINE_GAP)),
  )
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