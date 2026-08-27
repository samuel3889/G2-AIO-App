/**
 * The TRANSLATE page on the lens.
 *
 * Two containers, one above the other, plus the status strip:
 *
 *   +--------------------------------------------------+
 *   | 09:41                                    82%     |  status strip
 *   +--------------------------------------------------+
 *   | JA > EN                                          |  direction label
 *   +--------------------------------------------------+
 *   | ┌──────────────────────────────────────────────┐ |
 *   | │ Everyone calls her Aunt S.                   │ |  the translation
 *   | │                                              │ |
 *   | └──────────────────────────────────────────────┘ |
 *   +--------------------------------------------------+
 *
 * ONE DIRECTION ONLY. The gateway decides which utterances reach the lens
 * and marks them `lens` on the frame; this module never sees the others.
 * That is the stock Even app's behaviour and the reason it is right: the
 * glasses are what you turn toward the person you are talking to, so they
 * carry your speech in their language. The full two-way exchange is on the
 * phone.
 *
 * THE SOURCE TEXT IS NOT SHOWN. It was, briefly, on the reasoning that it
 * is the only feedback the microphone heard the right words - but that is a
 * DEBUGGING need, and the phone already serves it far better, with both
 * directions and no ten-second deadline. On the lens the source is text you
 * cannot read competing for space with text you can, and every line it
 * takes is a line the translation loses. It stays on the phone.
 *
 * The DIRECTION LABEL does stay. It is one line, it never changes mid
 * conversation, and it answers a question the wearer would otherwise have to
 * take the phone out for: which way round is this running.
 *
 * There is NO font size, no line height and no text alignment on
 * TextContainerProperty (index.d.ts:356-377), so the label and the
 * translation are distinguished by the only means the SDK offers: POSITION
 * and a BORDER. The label sits on top, unboxed; the translation sits below
 * in a bordered box, the same visual language the assistant overlay and the
 * timer alert already use for "this is the thing to read".
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import { RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { statusContainers, STATUS_H } from './statusbar'
// Line metrics are BORROWED from overlay.ts rather than redeclared. They are
// flagged there as estimates, and a second copy would drift from the one the
// assistant box uses the first time either is calibrated.
import { countLines, LINE_HEIGHT } from './overlay'

/**
 * Container IDs owned by this module.
 *
 * Allocation across the whole app: 1 transcript, 2/3 plex header/list, 4/5
 * menu header/list, 6/7 assistant overlay, 8 speaker names, 9 message,
 * 10/11 status clock+battery, 12 home, 13 status countdown, 14 alert. So
 * translate takes 15 and 16.
 *
 * The z-order validator does NOT check containerID for duplicates - only
 * zOrderIndex. A colliding ID rebuilds cleanly and returns true, then
 * swallows its own textContainerUpgrade, so the failure is silent and the
 * only defence is not colliding.
 */
export const TRANSLATE_SRC_ID = 15
export const TRANSLATE_SRC_NAME = 'xlate-src'
export const TRANSLATE_DST_ID = 16
export const TRANSLATE_DST_NAME = 'xlate-dst'

const PADDING = 6

/**
 * Characters per line at full width.
 *
 * Same value pages.ts uses for the alert box, and for the same reason: both
 * span the whole 576px rather than overlay.ts's 520px inset. It is an
 * estimate on a proportional font, so it is used for CLAMPING - deciding
 * what to cut - and never for alignment.
 */
const CHARS_PER_LINE = 60

/**
 * The label is ONE row. It holds "JA > EN" and nothing else, so a second
 * row would be blank space taken from the translation below it.
 */
const SRC_H = LINE_HEIGHT + PADDING * 2

/** Everything left under the strip and the label. */
const DST_H = 288 - STATUS_H - SRC_H
const DST_LINES = Math.max(1, Math.floor((DST_H - PADDING * 2) / LINE_HEIGHT))

/** Same border as the assistant box and the alert, for the same reason. */
const BORDER_COLOR = 12

/**
 * Cut `text` to at most `maxLines` rows, ending in an ellipsis.
 *
 * Cuts by CHARACTERS rather than by lines because countLines() is an
 * estimate: a character budget cannot overshoot the way a line-based cut
 * can. Same approach overlay.ts's assistantBox() takes.
 */
function clamp(text: string, maxLines: number): string {
  if (!text) return ''
  if (countLines(text, CHARS_PER_LINE) <= maxLines) return text
  return `${text.slice(0, maxLines * CHARS_PER_LINE - 1).trimEnd()}…`
}

/**
 * What one translated line looks like on the lens.
 *
 * `source` may be empty, which is the IDLE state - translate mode is
 * running but nothing has been said yet, or the last line's hold has
 * elapsed.
 */
export interface LensTranslation {
  /** The translation. Empty is the IDLE state - mode running, nothing said. */
  text: string
  /** Language codes for the label, e.g. 'en' and 'es'. */
  from: string
  to: string
}

/**
 * The two content containers.
 *
 * Exported separately from showTranslatePage() so a caller could compose a
 * page containing these plus something else without duplicating the
 * geometry. Nothing does that today; the export exists so that when
 * something needs to, it does not copy these numbers.
 */
export function translateContainers(t: LensTranslation): TextContainerProperty[] {
  // Always visible, including while idle, so a glance at the lens says which
  // direction is running even when nobody has spoken.
  const label = `${t.from.toUpperCase()} › ${t.to.toUpperCase()}`

  const dst = t.text ? clamp(t.text, DST_LINES) : 'Listening…'

  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: STATUS_H,
      width: 576,
      height: SRC_H,
      // No border on the label: the boxed thing below is the one to read,
      // and two boxes would give them equal weight.
      borderWidth: 0,
      borderColor: BORDER_COLOR,
      paddingLength: PADDING,
      containerID: TRANSLATE_SRC_ID,
      containerName: TRANSLATE_SRC_NAME,
      content: label,
      // Exactly ONE container per page may capture events, and it is the
      // big one below - it is what a tap is aimed at.
      isEventCapture: 0,
      zOrderIndex: 0,
    }),
    new TextContainerProperty({
      xPosition: 0,
      yPosition: STATUS_H + SRC_H,
      width: 576,
      height: DST_H,
      borderWidth: 2,
      borderColor: BORDER_COLOR,
      borderRadius: 4,
      paddingLength: PADDING,
      containerID: TRANSLATE_DST_ID,
      containerName: TRANSLATE_DST_NAME,
      content: dst,
      isEventCapture: 1,
      zOrderIndex: 1,
    }),
  ]
}

/**
 * How long a line of `text` needs to be on the lens to be READ.
 *
 * THE PROBLEM THIS SOLVES: a fixed ten-second hold is generous for "Everyone
 * calls her Aunt S." and nowhere near enough for a four-line paragraph. Worse,
 * a short utterance arriving right after a long one used to evict it
 * immediately, so the paragraph got whatever fraction of its ten seconds had
 * elapsed - sometimes two or three - and could not be read at all.
 *
 * So reading time is derived from LENGTH rather than fixed. MS_PER_CHAR is
 * set for roughly 18 characters a second, which is a deliberately unhurried
 * reading pace: this is text on a lens, in a second language, while someone
 * is talking at you.
 *
 * The slider value is the FLOOR, not the value - "Translation hold" now means
 * "the least time any line gets". The cap stops one runaway Whisper decode
 * from holding the lens for a minute.
 */
export function readMs(text: string, floorMs: number): number {
  const want = text.length * MS_PER_CHAR
  return Math.max(floorMs, Math.min(want, MAX_HOLD_MS))
}

/** Reading pace, ms per character. ~18 characters a second. */
const MS_PER_CHAR = 55

/** Nothing holds the lens longer than this, whatever its length. */
export const MAX_HOLD_MS = 30000

/**
 * Build the translate page.
 *
 * Rebuilt WHOLE on every line rather than upgraded in place. The caption
 * page uses textContainerUpgrade because it repaints on every partial -
 * several times a second - and a rebuild that often would be visible. This
 * page changes once per utterance at most, so the simpler path is the right
 * one, and it avoids the failure mode where an upgrade is aimed at a
 * container that a rebuild elsewhere has taken off the page.
 *
 * FOUR containers: source 0, translation 1, clock 10, battery 11.
 * zOrderIndex is ALL-OR-NOTHING per page and must be unique across every
 * container on it. The strip is rebuilt with the page because
 * rebuildPageContainer replaces EVERY container - a page that omits it
 * loses the clock and battery.
 *
 * Returns the boolean rebuildPageContainer gives, NOT the numeric code
 * createStartUpPageContainer returns - callers check `!ok`, not `!== 0`.
 */
export async function showTranslatePage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  t: LensTranslation,
): Promise<boolean> {
  const text = [...translateContainers(t), ...statusContainers()]
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}