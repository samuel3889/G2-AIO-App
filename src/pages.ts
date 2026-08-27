/**
 * Lens page builders and the containers they are made of.
 *
 * WHAT LIVES HERE
 *
 * Everything about the CAPTION page and the generic full-width MESSAGE page:
 * the two caption columns, the message container, and the two show*Page()
 * functions that assemble them. Plus the container IDs those three own.
 *
 * WHY IT IS ITS OWN MODULE
 *
 * All of this used to live in plex.ts, for no better reason than that the
 * Plex view was the first thing that ever needed to rebuild back to caption
 * mode. That made a FEATURE module the owner of a CORE one: the caption page
 * is the whole point of the device, and it cannot be hostage to whether the
 * wearer still wants to read Tautulli on their face. Deleting plex.ts should
 * cost you the Plex list and nothing else.
 *
 * The dependency now runs the right way round - plex.ts imports
 * showMessagePage() from here for its empty case, and nothing here knows
 * that plex.ts exists.
 *
 * WHAT DOES NOT LIVE HERE
 *
 * The caption GEOMETRY CONSTANTS. NAMES_W, SCREEN_W, CAPTION_PADDING and
 * captionBodyH() are owned by captions.ts and imported, never redeclared:
 * the caption layout derives its wrap column from all of them, so a second
 * copy here would let the containers and the wrapping disagree - the exact
 * bug that makes the last word of a line vanish.
 *
 * This module builds containers. It does not decide their proportions.
 *
 * All container models are CLASS INSTANCES (`new X({...})`), matching
 * index.d.ts where every one declares `constructor(data?: Partial<X>)`.
 * The published README shows plain object literals; it is wrong.
 */
import { RebuildPageContainer, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { statusContainers, STATUS_H } from './statusbar'
import {
  NAMES_W,
  SCREEN_W,
  CAPTION_PADDING,
  captionBodyH,
} from './captions'
import { suggestContainers } from './suggest'
// The alert box borrows overlay.ts's line metrics rather than declaring a
// second copy. Not a cycle: overlay.ts imports statusbar.ts and nothing else
// from this side of the app.
import { countLines, LINE_HEIGHT } from './overlay'

/**
 * Container IDs owned by this module.
 *
 * The allocation across the whole app is: 1 transcript, 2/3 plex
 * header/list, 4/5 menu header/list, 6/7 assistant overlay, 8 speaker names,
 * 9 message, 10/11 status strip.
 *
 * 1 stays reserved for the transcript so that textContainerUpgrade keeps
 * working unchanged across every rebuild back into caption mode.
 *
 * NOTE the z-order validator does NOT check containerID for duplicates -
 * only zOrderIndex. A colliding ID rebuilds cleanly and returns true, then
 * swallows its own textContainerUpgrade (see statusbar.ts).
 */
export const TRANSCRIPT_ID = 1
export const TRANSCRIPT_NAME = 'transcript'

/**
 * The speaker-name column.
 *
 * WHY THIS EXISTS: the lens font is PROPORTIONAL, and the SDK exposes no
 * font metrics of any kind - TextContainerProperty has no font size, no line
 * height, no alignment (index.d.ts:410-425). So a name column padded with
 * SPACES cannot line up with the text beside it: eight spaces is narrower
 * than 'Samuel: ' and wider than '?:' plus six, and both errors were plainly
 * visible on the lens.
 *
 * Two containers side by side fixes it with geometry instead of character
 * counts. Same yPosition, same height, same padding, same font, so row N on
 * the left is on row N on the right by construction - whatever the glyphs
 * happen to be.
 */
export const NAMES_ID = 8
export const NAMES_NAME = 'names'

/**
 * A plain full-width message page. NOT part of the caption layout.
 *
 * Its own ID so that a stray textContainerUpgrade aimed at the transcript
 * cannot land on it, and so that nothing about it is reachable from the
 * caption render path.
 */
export const MESSAGE_ID = 9
export const MESSAGE_NAME = 'message'

/**
 * The HOME page's one and only content container - full screen, empty, and
 * invisible.
 *
 * WHY IT EXISTS AT ALL, ON A PAGE THAT IS MEANT TO BE BLANK
 *
 * statusContainers() hard-codes `isEventCapture: 0` on both strip containers
 * (statusbar.ts), because exactly one container per page may capture events
 * and on every other page that has to be the page's own content. A page built
 * from the strip ALONE therefore captures nothing: no tap, no double tap, and
 * no way off the home page short of a long press that kills the widget.
 *
 * So home gets one container that is full-screen and event-capturing but
 * draws nothing - `content: ''` with `borderWidth: 0`. The lens shows the
 * clock and the battery and otherwise stays dark, which is the point, and the
 * gestures still arrive.
 *
 * Its own ID (12) rather than reusing MESSAGE_ID: allocation is 1
 * transcript, 2/3 plex, 4/5 menu, 6/7 assistant overlay, 8 names, 9 message,
 * 10/11 status. A colliding ID rebuilds cleanly and returns true, then
 * swallows its own textContainerUpgrade - the failure mode is silent, so the
 * only defence is not colliding.
 */
export const HOME_ID = 12
export const HOME_NAME = 'home'

/**
 * The full-screen alert box — currently used only by the expiry of a
 * countdown timer, but deliberately named for the SHAPE rather than the
 * feature, because "one container, whole lens, holds one message, goes away
 * by itself" is not specific to timers.
 *
 * 13 is the countdown container in the status strip (TIMER_ID in
 * statusbar.ts), so this takes 14. Allocation across the app is now: 1
 * transcript, 2/3 plex, 4/5 menu, 6/7 assistant overlay, 8 names, 9 message,
 * 10/11 status clock+battery, 12 home, 13 status countdown, 14 this.
 */
export const ALERT_ID = 14
export const ALERT_NAME = 'alert'

/**
 * The transcript container on its own.
 *
 * Exported so any page builder can compose one containing BOTH the
 * transcript and its own containers without duplicating this geometry - two
 * copies of the same layout constants would drift apart the first time
 * either changes.
 *
 * `isEventCapture` is a parameter because only one container per page may
 * capture events: it is 1 on the plain caption page, and 0 when an overlay
 * box is up and needs the taps instead.
 */
export function transcriptContainer(
  content: string,
  isEventCapture = 1,
  height = captionBodyH(),
  zOrderIndex = 0,
): TextContainerProperty {
  return new TextContainerProperty({
    // Offset by the name column. This container holds the WORDS only; the
    // speakers live in namesContainer() to its left.
    xPosition: NAMES_W,
    // Pushed down by the persistent status strip, which occupies the top
    // STATUS_H px of every page in this app.
    yPosition: STATUS_H,
    width: SCREEN_W - NAMES_W,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: CAPTION_PADDING,
    containerID: TRANSCRIPT_ID,
    containerName: TRANSCRIPT_NAME,
    content,
    isEventCapture,
    // Backmost on any page it appears on. Callers that stack things over it
    // pass their own depth via overlay.ts's zFor().
    zOrderIndex,
  })
}

/**
 * The speaker-name column that sits to the LEFT of the transcript.
 *
 * Geometry is deliberately IDENTICAL to transcriptContainer() except for
 * xPosition and width: same yPosition, same height, same paddingLength. That
 * is what makes the two columns share a baseline grid. Change one and change
 * the other, or the names drift out of line with the words they label.
 *
 * `isEventCapture` is 0 and not a parameter: exactly one container per page
 * may capture events and on the caption page that has to be the transcript,
 * which is far larger and is what a tap is aimed at.
 */
export function namesContainer(
  content: string,
  height = captionBodyH(),
  zOrderIndex = 1,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H,
    width: NAMES_W,
    height,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: CAPTION_PADDING,
    containerID: NAMES_ID,
    containerName: NAMES_NAME,
    content,
    isEventCapture: 0,
    zOrderIndex,
  })
}

/**
 * Build the caption page: the two columns plus the status strip.
 *
 * This is THE page of this app - what the lens shows whenever nothing else
 * has taken it. Every other page builder exists to be returned FROM, back to
 * this one.
 *
 * Must be rebuildPageContainer, never createStartUpPageContainer - the
 * startup call is once per app lifetime and main.ts has already spent it.
 */
export async function showTranscriptPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  content: string,
  names = '',
  suggestion = '',
): Promise<boolean> {
  // The strip is rebuilt with the page: rebuildPageContainer replaces
  // EVERY container, so a page that omits it loses the clock and battery.
  //
  // FOUR containers now, not three. zOrderIndex is ALL-OR-NOTHING per page
  // and must be unique across every container: transcript 0, names 1, clock
  // 10, battery 11. A duplicate or a missing one fails CLIENT-SIDE in
  // validateEvenHubPageContainerZOrder and never reaches the glasses -
  // rebuildPageContainer returns false with [EvenHub:...] on the console.
  // zOrderIndex is ALL-OR-NOTHING per page and must be unique across every
  // container on it: transcript 0, names 1, suggest 2, clock 10, battery 11.
  // The band's 2 simply does not appear when the band does not.
  //
  // FOUR containers when no session is running, FIVE while one is. The band
  // is SPREAD from suggestContainers(), which returns an EMPTY array when
  // the feature is off (SUGGEST_ROWS = 0) or when no session is recording.
  // So the container leaves the page and its rows go back to the captions,
  // and containerTotalNum follows automatically because it is derived from
  // the array length rather than written down separately.
  //
  // `suggestion` is threaded through rather than defaulted to '' here:
  // showCaptions() rebuilds this page on every return from the menu and from
  // a feature page, and a suggestion still inside its hold window has to
  // survive that round trip. Baking it into the rebuild is what makes that
  // work without a follow-up textContainerUpgrade.
  const text = [
    transcriptContainer(content, 1),
    namesContainer(names),
    ...suggestContainers(suggestion),
    ...statusContainers(),
  ]

  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}

/**
 * A full-width single-message container, spanning the whole lens.
 *
 * Deliberately independent of NAMES_W and of everything else in captions.ts.
 * This is what the transcript container looked like before the caption page
 * became two columns, and pages that show one line of text - an error, or a
 * feature module reporting that it has nothing to show - want exactly that,
 * not a text column offset to make room for speaker names that do not
 * exist.
 */
export function messageContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H,
    width: 576,
    height: 288 - STATUS_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: MESSAGE_ID,
    containerName: MESSAGE_NAME,
    content,
    isEventCapture: 1,
    zOrderIndex: 0,
  })
}

/**
 * Put one line of text on the lens, full width.
 *
 * Three containers: message 0, clock 10, battery 11. zOrderIndex is
 * all-or-nothing per page and unique across it.
 */
export async function showMessagePage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  content: string,
): Promise<boolean> {
  const text = [messageContainer(content), ...statusContainers()]
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}
/**
 * The invisible full-screen container that backs the home page.
 *
 * Geometry matches messageContainer() - below the strip, full width - but it
 * never holds text, so nothing here is derived from the caption constants and
 * nothing depends on this staying in step with them.
 */
export function homeContainer(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: STATUS_H,
    width: 576,
    height: 288 - STATUS_H,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: HOME_ID,
    containerName: HOME_NAME,
    content: '',
    // The whole reason this container exists. See HOME_ID above.
    isEventCapture: 1,
    zOrderIndex: 0,
  })
}

/**
 * The HOME page: blank lens, status strip only.
 *
 * This is what the app launches into. Three containers: home 0, clock 10,
 * battery 11 - zOrderIndex is all-or-nothing per page and unique across it.
 *
 * Nothing is written into the home container ever, so there is no
 * textContainerUpgrade path to it and no render state to keep in step. The
 * caption page is reached from the menu, and main.ts suppresses every caption
 * write while this page is up.
 */
export async function showHomePage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
): Promise<boolean> {
  const text = [homeContainer(), ...statusContainers()]
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}

// --- full-screen alert ------------------------------------------------------

/**
 * Border colour, 0-16. Matches the assistant overlay's box so the two read
 * as the same kind of object — something that has taken the lens and will
 * hand it back.
 */
const ALERT_BORDER_COLOR = 12

const ALERT_PADDING = 6

/**
 * Characters per line for the alert box.
 *
 * Wider than overlay.ts's CHARS_PER_LINE because the alert box spans the
 * FULL 576px rather than that box's 520px inset. Scaled from it in the same
 * proportion rather than measured, since it is only used to count rows for
 * the vertical centring below — being a few characters out moves the message
 * by at most one row.
 */
const ALERT_CHARS_PER_LINE = 60

/**
 * Rows the box can hold, used only to push the message down toward the
 * middle. LINE_HEIGHT is overlay.ts's estimate for BODY text and is
 * explicitly marked unverified there — but a wrong value here costs a few
 * px of vertical offset, not a clipped word, so it is safe to borrow.
 */
const ALERT_ROWS = Math.floor((288 - ALERT_PADDING * 2) / LINE_HEIGHT)

/**
 * The full-screen alert container.
 *
 * COVERS THE WHOLE LENS, INCLUDING THE STATUS STRIP. Every other page in
 * this app reserves the top STATUS_H px for the clock and battery; this one
 * does not, and showAlertPage() below omits the strip containers entirely
 * rather than drawing the box over them.
 *
 * That is a deliberate choice over stacking. overlay.ts's HIGHER_IS_FRONT is
 * flagged there as the one thing in the z-order model that was never
 * established empirically — the SDK documents zOrderIndex as controlling
 * stacking and validates it, but states nowhere which direction is front. A
 * page that relies on getting that right would either work or silently draw
 * the clock on top of the alert, and there is no way to tell from the code
 * which. Omitting the strip needs no such assumption: there is one container
 * on the page, so nothing can be in front of anything.
 *
 * The cost is that the clock and battery are gone for the few seconds the
 * box is up. That is the correct trade for something whose entire job is to
 * be impossible to miss.
 *
 * `isEventCapture` is 1 because it is the only container here and a tap must
 * dismiss the box early — see the 'alert' branch of the event router in
 * main.ts.
 */
export function alertContainer(message: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 2,
    borderColor: ALERT_BORDER_COLOR,
    borderRadius: 4,
    paddingLength: ALERT_PADDING,
    containerID: ALERT_ID,
    containerName: ALERT_NAME,
    content: message,
    isEventCapture: 1,
    // Only container on the page, so this is the whole z-order. It still has
    // to be SET: the validator is all-or-nothing per page, and a page whose
    // one container omits zOrderIndex is fine, but one that sets it on some
    // and not others is rejected. Setting it always is the habit that keeps
    // a second container from breaking this later.
    zOrderIndex: 0,
  })
}

/**
 * Vertically centre a short message by padding it with blank lines.
 *
 * This is the one alignment trick in this codebase that is actually SAFE.
 * Horizontal padding with spaces does not work — pages.ts's speaker column
 * documents why, the font is proportional and a space is not a fixed
 * fraction of a glyph. But LINE HEIGHT is uniform whatever the glyphs are,
 * so a leading newline moves text down by exactly one row every time.
 *
 * Horizontal centring is still not available and is not attempted: the
 * message sits at the left padding. There is no text-alignment property on
 * TextContainerProperty at all (index.d.ts:356-377).
 */
function centreVertically(message: string): string {
  const used = countLines(message, ALERT_CHARS_PER_LINE)
  const blank = Math.max(0, Math.floor((ALERT_ROWS - used) / 2))
  return '\n'.repeat(blank) + message
}

/**
 * Put one message on the lens, full screen, no status strip.
 *
 * ONE container, so containerTotalNum is 1. Returns the boolean
 * rebuildPageContainer gives, NOT the numeric code from
 * createStartUpPageContainer — callers check `!ok`, not `!== 0`.
 */
export async function showAlertPage(
  bridge: { rebuildPageContainer: (c: RebuildPageContainer) => Promise<boolean> },
  message: string,
): Promise<boolean> {
  const text = [alertContainer(centreVertically(message))]
  return bridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )
}