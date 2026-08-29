import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import {
  startSttStream,
  type SessionState,
  type AssistantState,
  type TranslateState,
  type TranslationLine,
  type NoteDue,
  type TelepromptState,
} from './asr/stt'
import { mountUi, setStatus, setTranscript } from './ui'
import {
  captionColumns,
  resetCaptions,
  setPartial,
  pushFinal,
  setName,
  setBandVisible,
  isBandVisible,
} from './captions'
import {
  NAMES_ID,
  NAMES_NAME,
  TRANSCRIPT_ID,
  TRANSCRIPT_NAME,
  showTranscriptPage,
  showHomePage,
  showAlertPage,
  showMessagePage,
  homeContainer,
} from './pages'
import { mountSettings } from './settings'
import { showListPage } from './listpage'
import {
  formatSuggest,
  SUGGEST_ID,
  SUGGEST_NAME,
  resolveHoldMs,
} from './suggest'
import { assistantBox, OVERLAY_Q_ID, OVERLAY_NAME } from './overlay'
import {
  menuContainer,
  menuLabels,
  actionForItemId,
  LAUNCH_MENU_STATE,
  type MenuAction,
} from './menu'
import { mountSessions, setLiveSession, refreshSessions } from './sessions'
import {
  mountTranslate,
  setTranslateState,
  pushTranslation,
  lastPair,
} from './translate'
import { showTranslatePage, readMs, type LensTranslation } from './translatepage'
import {
  showTelepromptPage,
  telepromptLines,
  clampCursor,
  wordIndexOfLine,
  lineOfWordIndex,
  setTelepromptLayout,
} from './teleprompt'
import { mountTabs } from './tabs'
import { mountReview } from './review'
import { mountPrep } from './prep'
import { mountPrompts } from './prompts'
import { mountSummaryPrompts } from './summaryprompts'
import { mountNotes } from './notes'
import { mountScripts, applyTelepromptPreview } from './scripts'
import { restUrl } from './api'
import {
  statusContainers,
  setDeviceStatus,
  setGlassesSn,
  startStatusUpdates,
  setStripOnPage,
} from './statusbar'
// TimerState is no longer imported: showAlert() takes a plain
// {kind,id,title,alertS} now that a note can raise the same box, and
// nothing else in this file names the type. tsconfig has noUnusedLocals,
// so leaving it would fail the build rather than warn.
import {
  onTimerExpired,
  startTimer,
  cancelTimer,
  resolveAlertMs,
} from './timer'

// Phone UI: one tab bar, TWO hosts. Every panel is mounted ONCE, here at
// startup, and only shown/hidden afterwards — mountSessions() registers
// callbacks that setLiveSession() drives, so remounting on tab switch would
// leave those writing into detached DOM.
//
// Review is no longer a tab. It is a collapsible section of Conversations,
// alongside Recording, Saved conversations and Suggestion prompts — four
// steps of one job rather than a nav entry each. Their vertical order comes
// from PANEL_ORDER in theme.ts, NOT from the order they are mounted in here:
// mountReview() has to run before the bridge await below (so Review works
// with no glasses attached) while mountSessions() has to run after it (its
// buttons need the STT socket).
//
// mountUi() still owns #app and is NOT moved into a host: it replaces #app's
// innerHTML wholesale, which would destroy anything mounted inside it.
//
// Translate is its OWN tab rather than a section of Conversations, unlike
// Review. The two are different modes of the device - the gateway refuses to
// caption and translate at once - so putting them in one scrolling column
// would suggest they compose.
const tabs = mountTabs([
  'Live',
  'Conversations',
  'Notes',
  'Translate',
  'Teleprompt',
])

// The tuning panel, minus every group that belongs beside its own feature.
//
// WHAT IS LEFT ON LIVE is the capture chain - what counts as speech, where an
// utterance starts and ends, speaker separation, the roster and timers. All
// of it shapes the microphone, which is what this tab is about.
//
// Everything else is mounted next to the thing it configures, further down:
// suggestions and review audio on Conversations, note alerts on Notes,
// translation hold on Translate, prompter layout on Teleprompt. A slider
// is easiest to judge while looking at what it changes.
void mountSettings(tabs.Live, {
  omit: [
    'suggest_every_utts',
    'suggest_cooldown_s',
    'suggest_context_utts',
    'suggest_timeout_s',
    'suggest_hold_s',
    'suggest_memory',
    'suggest_dup_ratio',
    'clip_retention_h',
    'note_alert_s',
    'translate_hold_s',
    'teleprompt_row_h',
    'teleprompt_chars',
  ],
})
mountUi()
mountReview(tabs.Conversations)

const API_KEY = import.meta.env.VITE_STT_API_KEY as string
if (!API_KEY) {
  setStatus('error', 'VITE_STT_API_KEY not set — copy .env.example to .env.local')
  console.warn('VITE_STT_API_KEY is not set.')
}

const bridge = await waitForEvenAppBridge()

// Seed the status strip before the first page is built.
//
// getDeviceInfo() returns DeviceInfo | null (index.d.ts:1130), and
// DeviceStatus.batteryLevel is OPTIONAL (index.d.ts:139) — it can legitimately
// be undefined this early, in which case the strip shows '--%'.
try {
  const device = await bridge.getDeviceInfo()
  setDeviceStatus({
    batteryLevel: device?.status?.batteryLevel,
    isCharging: device?.status?.isCharging,
  })
  // Later status events are matched against this so a ring cannot overwrite
  // the glasses battery.
  setGlassesSn(device?.sn)
  console.log(
    `[status] boot device sn=${device?.sn} battery=${device?.status?.batteryLevel}` +
      ` charging=${device?.status?.isCharging}`,
  )
} catch (err) {
  console.warn('[status] getDeviceInfo failed:', err)
}

// What the transcript container holds before anything has been said. No
// longer on the startup page — the app now launches into the blank HOME page
// — but still the value `currentText` starts at, so the first caption page
// built has something in it rather than an empty column.
//
// captions.ts's CAPTION_RULER probe is deliberately NOT consulted here. It is
// read inside captionColumns(), so turning it on still replaces the captions
// the moment anything repaints — this constant only covers the gap before the
// first render.
const INITIAL_CONTENT = 'Listening…'

// --- contextual menu plumbing -------------------------------------------
//
// THE MENU IS DECLARED WITH THE PAGE. `menuObject` is replaced wholesale on
// every create/rebuild and is never merged, and a rebuild that OMITS it
// CLEARS the custom items - omission is significant, not neutral.
//
// This app rebuilds the page from eight different places (captions, home, the
// two list paths, the alert box, translate, the assistant overlay, notes), and
// every one of them would have to remember to carry the menu forward. One
// forgotten call site is not a visible bug at the call site: it is a menu that
// silently empties itself two pages later.
//
// So the menu is attached HERE instead, by wrapping the bridge. Page builders
// keep taking `{ rebuildPageContainer }` and stay unaware of the menu; they are
// handed `lensBridge` rather than `bridge` and the menu rides along.
//
// `menuObject` is only filled in when the caller did not set one, so a future
// page that wants its own menu can still override it.
function withMenu(container: RebuildPageContainer): RebuildPageContainer {
  if (container.menuObject === undefined) {
    container.menuObject = menuContainer(menuState())
  }
  return container
}

// Structurally compatible with the `{ rebuildPageContainer }` parameter every
// page builder declares, so nothing in pages.ts / listpage.ts /
// translatepage.ts had to change.
const lensBridge = {
  rebuildPageContainer: (container: RebuildPageContainer): Promise<boolean> =>
    bridge.rebuildPageContainer(withMenu(container)),
}

// THE LAUNCH PAGE IS BLANK: the status strip and nothing else.
//
// homeContainer() is the invisible full-screen container underneath it. It is
// not decoration — statusContainers() sets isEventCapture 0 on both strip
// containers, so without it NOTHING on this page captures events and there is
// no gesture that leads off it. See pages.ts:HOME_ID.
//
// THREE containers at startup: home 0, clock 10, battery 11. zOrderIndex is
// ALL-OR-NOTHING per page and unique across all of them.
//
// This deliberately does NOT go through showHomePage(): the startup call is
// once per app lifetime and must be createStartUpPageContainer, which returns
// a numeric result code rather than the boolean rebuildPageContainer gives.
const startupText = [homeContainer(), ...statusContainers()]

// LAUNCH_MENU_STATE, not menuState(). This runs at module top level, ABOVE
// the `let sessionActive` / `micOn` / `translatePair` declarations further down
// this file - calling menuState() here would be a temporal dead zone crash, not
// a stale label. The menu is re-declared from live state a few lines below,
// once the mic is up.
const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: startupText.length,
    textObject: startupText,
    menuObject: menuContainer(LAUNCH_MENU_STATE),
  }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}


// Keep the strip live between page rebuilds: a clock poll plus a device
// status subscription. Stopped in cleanup() so the interval does not
// outlive the widget.
const stopStatusUpdates = startStatusUpdates(bridge)

// Last thing actually written to each container, so an unchanged column is
// not re-sent. The names column only changes when an utterance starts or a
// name lands - a partial touches the text column alone - so most renders
// stay ONE bridge call rather than two, which matters on a BLE queue slow
// enough to need the 120ms debounce below.
let lastNames = ''
let lastText = ''

/**
 * The suggestion currently on the lens, already formatted by
 * formatSuggest(), or '' for none.
 *
 * Held here rather than written straight to the container because
 * showTranscriptPage() BAKES IT INTO the rebuild. The caption page is rebuilt
 * on every return from the menu, a list page or an assistant box, and a
 * suggestion still inside its hold window has to survive that round trip -
 * a rebuild that dropped it would blank the band mid-countdown.
 */
let currentSuggestion = ''

/** What the band container actually holds, so a repeat write is skipped. */
let lastSuggestion = ''

/** Clears currentSuggestion when it lapses. Null when nothing is up. */
let suggestTimer: number | null = null

/**
 * Whether the page CURRENTLY ON THE LENS was built with the band.
 *
 * Not the same thing as isBandVisible(), and the gap between them is the
 * whole point. isBandVisible() is what the band SHOULD be; this is what was
 * actually built. They diverge whenever the flag changes while a rebuild is
 * already in flight, which is the normal case at session start:
 * runMenuAction() calls toggleSession() and then showCaptions()
 * immediately, but startSession() only SENDS the command - the gateway's
 * 'session' frame confirming it lands during that rebuild.
 *
 * Comparing against this instead of watching for the flag to change means a
 * late-arriving frame still gets the page corrected, rather than being
 * dropped because the rebuild it needed had already started.
 */
let bandOnPage = false

/**
 * Whether the band CURRENTLY ON THE LENS was built with its outline drawn.
 *
 * Same relationship to `currentSuggestion !== ''` as bandOnPage has to
 * isBandVisible(): one is what the page SHOULD be, this is what was
 * actually built.
 *
 * It exists because borderWidth, like every other geometry property, is
 * FROZEN at container creation - textContainerUpgrade replaces content and
 * nothing else. So an empty band cannot have its rule removed by writing ''
 * into it; the page has to be rebuilt with a borderWidth-0 container in its
 * place. suggestContainer() derives the width from the content, so a
 * rebuild carrying '' produces the outline-less band automatically and this
 * flag is only ever a record of which one went up.
 *
 * Meaningless while bandOnPage is false - there is no band to have an
 * outline. Set together with it in showCaptions().
 */
let bandBorderOnPage = false
let renderTimer: number | null = null
let currentNames = ''
let currentText = INITIAL_CONTENT

// Which page is on the lens. In 'home' and 'list' modes the
// transcript container does not exist, so textContainerUpgrade would target a
// container that is not on the page — every caption render must be
// suppressed until we rebuild.
//
// 'home' is the LAUNCH mode and the blank page. Every render guard in this
// file is already written as `pageMode !== 'transcript'`, so adding it here is
// what makes partials, finals, speaker names and suggestions all stay off the
// lens while home is up, without touching any of them.
//
// 'alert' is the full-screen timer box. It is a page mode rather than a flag
// because every render guard in this file is already written as
// `pageMode !== 'transcript'` — so naming it here is what suppresses
// partials, finals, speaker names and suggestions for its duration, with no
// edit to any of them.
//
// 'translate' is the two-box translate page. Like 'alert' it is a page mode
// rather than a flag, so that every render guard already written as
// `pageMode !== 'transcript'` suppresses partials, finals, speaker names and
// suggestions for its duration with no edit to any of them. The gateway
// bypasses all four while translating anyway, so this is belt and braces —
// but a frame in flight when the mode changed would otherwise land on a page
// whose transcript container does not exist.
type PageMode =
  | 'home'
  | 'transcript'
  | 'list'
  | 'alert'
  | 'translate'
  | 'teleprompt'
let pageMode: PageMode = 'home'

// --- teleprompter -------------------------------------------------------
//
// PHASE 1: the script is the hardcoded DEMO_SCRIPT and there is no store
// behind it yet. What this proves on the lens is the rendering and the
// gestures - five rows, three brightness levels, swipe to move - which is
// everything the AI-following mode will later drive.
//
// `telepromptScript` is the WRAPPED array, computed once when the page is
// opened rather than on every render. wrapLines is pure and the script does
// not change while it is being read, so re-wrapping per swipe would be work
// for nothing - and a cursor indexing an array that could be re-wrapped
// differently is a position that quietly means something else afterwards.
let telepromptScript: string[] = []

// LINE index into telepromptScript, not a row on the lens. The row is
// derived from it by telepromptRows().
let telepromptCursor = 0

// --- translate mode, mirrored from the gateway --------------------------
//
// The gateway is authoritative for all three; nothing here sets them except
// the onTranslate hook. `translatePair` is what the lens header is drawn
// from, so it has to survive the gaps between utterances.
let translateActive = false
let translatePair: { a: string; b: string } = { a: 'en', b: 'es' }

/**
 * Clears the translated line off the lens when its hold elapses.
 *
 * The page does NOT go away with it — translate mode is still running, so
 * the lens falls back to the header and "Listening…" rather than to
 * captions. That is the difference between this and the suggestion timer:
 * a suggestion is an interruption of the caption page, whereas this IS the
 * page.
 */
let translateTimer: number | null = null

/** The line on the lens right now, or null for the idle state. */
let lensLine: LensTranslation | null = null

/**
 * A line that arrived while the one on the lens was still being read.
 *
 * WHY A QUEUE OF EXACTLY ONE. A long paragraph followed by a short remark
 * used to lose: the short one replaced it instantly and the paragraph got
 * whatever fraction of its hold had elapsed. Replacing is right for a
 * SUGGESTION - it is an aside, and a newer one supersedes an older one - but
 * a translation is a turn in a conversation and dropping one loses something
 * a person actually said.
 *
 * So the current line is protected for its reading time and the newcomer
 * waits. Depth one, not more: if three utterances land during one long
 * paragraph, the lens is already behind the room and showing all of them in
 * sequence would put it further behind. The newest is the one worth having,
 * and every one of them is on the phone in full regardless.
 */
let lensQueued: LensTranslation | null = null

/** Floor for a line's reading time, from the gateway's hold_ms. */
let lensFloorMs = 10000

/**
 * The page to rebuild when the alert box goes away.
 *
 * Same role assistantReturnTo plays for the assistant box, and captured for
 * the same reason: there is no page stack in this SDK, so "go back" can only
 * mean "rebuild the thing we remember being there".
 *
 * 'alert' can never be stored here. showAlert() refuses to open a
 * second box over the first, so the value written is always a real page.
 */
let alertReturnTo: PageMode = 'home'

/**
 * Closes the alert box when its time is up. Null when no box is on screen.
 *
 * Doubles as THE FLAG for "an alert is up": pageMode === 'alert' says the
 * same thing, but this is what a tap has to clear, so the two are set and
 * cleared together in showAlert() and closeAlert().
 */
let alertTimer: number | null = null

/**
 * The assistant exchange the alert box interrupted, or null.
 *
 * Distinct from `assistant`, which keeps tracking the LIVE exchange while
 * the box is up — a phase change or a dismissal can still arrive from the
 * gateway during those seconds. This is the record that there was something
 * to go back TO, so closeAlert() can tell "the box interrupted an
 * exchange" from "the box interrupted the caption page".
 */
let alertResumeAssistant: AssistantState | null = null

// Conversate state, mirrored from the gateway. The gateway is authoritative;
// this is only what the lens and phone display.
let sessionActive = false
let sessionUtterances = 0

let micOn = false

// The assistant exchange currently on the lens, or null. While this is set
// the transcript container is NOT ON THE PAGE AT ALL, so a
// textContainerUpgrade aimed at it would be writing into a container that
// does not exist.
let assistant: AssistantState | null = null

/**
 * The page that was on the lens when the CURRENT assistant exchange began, and
 * therefore the page to rebuild when it ends.
 *
 * Written once per exchange, on the none -> box transition in onAssistant, and
 * read by restoreFromAssistant(). 'home' is the initial value for the same
 * reason pageMode is: that is what the app launches into, so an exchange
 * triggered before any page change returns to a blank lens rather than to
 * captions the user never opened.
 */
let assistantReturnTo: PageMode = 'home'

/**
 * The lines the list currently on the lens was built from, or null.
 *
 * Needed because returning to 'list' means REBUILDING it — there is no
 * page stack in this SDK and no way to read a container's contents back — so
 * without a copy of the lines there is nothing to return to.
 */
let lastListLines: string[] | null = null

/**
 * Note ids for the list on the lens, or null when the list is read-only.
 *
 * ids[i] belongs to lastListLines[i + 1] - the header is not a note. Its
 * PRESENCE is what makes the page actionable: the notes list arrives with
 * ids, Plex and Sparky lists do not, and that is the only difference
 * between an actionable list page and a read-only one.
 *
 * Kept in step with lastListLines by every path that sets either. They are
 * two halves of one value and a set of one without the other is a bug -
 * which is why noteIdAt() re-checks the pairing rather than trusting it.
 */
let lastNoteIds: string[] | null = null

function scheduleGlassesRender() {
  if (pageMode !== 'transcript') return
  if (assistant !== null) return
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    // Re-check: a list may have taken over during the 120ms debounce.
    if (pageMode !== 'transcript') return
    if (assistant !== null) return

    // Names FIRST. If the two writes are ever split across a frame, a row
    // showing a name with no text beside it reads better than a row of text
    // with the wrong name beside it.
    if (currentNames !== lastNames) {
      lastNames = currentNames
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: NAMES_ID,
          containerName: NAMES_NAME,
          content: currentNames,
        }),
      )
    }

    if (currentText !== lastText) {
      lastText = currentText
      await bridge.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: TRANSCRIPT_ID,
          containerName: TRANSCRIPT_NAME,
          content: currentText,
        }),
      )
    }
  }, 120) // debounce display writes — BLE render queue is slow
}

/**
 * Push currentSuggestion into the band container.
 *
 * Written DIRECTLY rather than through scheduleGlassesRender()'s 120ms
 * debounce. That debounce exists because partials arrive several times a
 * second; suggestions arrive at most once every few seconds and are already
 * rate-limited server-side, so there is nothing to coalesce.
 *
 * Skipped entirely unless the caption page is on screen AND the band is up,
 * because textContainerUpgrade against a container that is not on the
 * current page does nothing and reports nothing. currentSuggestion still
 * holds the text, and showCaptions() bakes it into the next rebuild - which
 * is what makes a suggestion survive a trip through the menu.
 */
async function pushSuggestion() {
  if (pageMode !== 'transcript') return
  if (assistant !== null) return
  if (!isBandVisible()) return
  if (currentSuggestion === lastSuggestion) return

  // THE OUTLINE NEEDS A REBUILD, THE TEXT DOES NOT.
  //
  // The band's border is drawn only when it holds something (suggest.ts),
  // and borderWidth is frozen at container creation - so crossing the
  // empty/non-empty boundary cannot be done with an upgrade. showCaptions()
  // bakes currentSuggestion into the rebuild, which is exactly the string
  // this function was about to write, so it does the whole job and returns.
  //
  // The caption columns are NOT re-cut first, unlike the band-visibility
  // rebuild in onSession: their height depends on isBandVisible(), which
  // has not moved here. The rows stay reserved either way and the wrap is
  // unchanged, so currentText/currentNames are still correct.
  //
  // At most two rebuilds per suggestion - one to raise the outline, one to
  // drop it - and the gateway's cooldown bounds how often that can happen.
  // A suggestion REPLACED while another is up takes the cheap path below,
  // because the outline is already on the page.
  const needBorder = currentSuggestion !== ''
  if (needBorder !== bandBorderOnPage) {
    await showCaptions()
    return
  }

  lastSuggestion = currentSuggestion
  const ok = await bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: SUGGEST_ID,
      containerName: SUGGEST_NAME,
      content: currentSuggestion,
    }),
  )
  // Only trust the cache if the write was accepted - on false the string is
  // NOT on the lens and the next attempt should try again rather than skip.
  if (!ok) {
    lastSuggestion = ''
    console.warn('[suggest] upgrade returned false')
  }
}

/**
 * Drop whatever is in the band and stop its clock.
 *
 * Called on expiry, and on session end - the band leaves the page with the
 * session, so a suggestion left in currentSuggestion would reappear on the
 * next session's first rebuild, hours later and with no relation to what was
 * being said.
 *
 * WHY `push` IS A PARAMETER
 *
 * On expiry, pushing is the whole point: the band is staying on the page and
 * has to lose both its text and its outline, which now means a rebuild.
 *
 * On SESSION END it would be waste. onSession() clears the suggestion and
 * then drops the band off the page entirely, and that second step is a page
 * rebuild of its own - so pushing here would rebuild once to un-outline a
 * band that is about to be removed, and again to remove it. Two full page
 * rebuilds back to back, the first of them visible.
 *
 * The state is still cleared either way, which is what stops a suggestion
 * from the last session reappearing on the first rebuild of the next one.
 */
function clearSuggestion(push = true) {
  if (suggestTimer !== null) {
    window.clearTimeout(suggestTimer)
    suggestTimer = null
  }
  currentSuggestion = ''
  if (push) void pushSuggestion()
}

/**
 * Recompute both caption columns from the buffer.
 *
 * `render` is false before a PAGE REBUILD, where showTranscriptPage() bakes
 * currentText straight into the new containers - queueing a debounced write
 * as well would just fire it against containers that no longer exist. The
 * row count changes with the band, so the columns still have to be recut for
 * the new height first, or the rebuild paints the wrong number of lines.
 *
 * `render` is true on the ordinary caption path, where the containers are
 * already on the page and the debounced writer is how text reaches them.
 */
function syncCaptionColumns(render = false) {
  const cols = captionColumns()
  currentNames = cols.names
  currentText = cols.text
  if (render) scheduleGlassesRender()
}

/**
 * Put a single message on the lens, with an empty name column.
 *
 * Used for 'Listening…' and 'Paused', which are states rather than speech
 * and so belong to no speaker.
 */
function setLensMessage(msg: string) {
  currentNames = ''
  currentText = msg
  scheduleGlassesRender()
}

// Phone status line. One place, because it now has to account for three
// page modes and a recording flag.
function hint(): string {
  if (pageMode === 'home') {
    const rec = sessionActive ? `Recording (${sessionUtterances}) · ` : ''
    return `${rec}Home · tap for captions · hold for menu · double-tap to exit`
  }
  if (pageMode === 'alert') {
    return alertKind === 'note'
      ? 'Note due · tap to dismiss'
      : 'Timer finished · tap to dismiss'
  }
  if (pageMode === 'list') {
    // Title comes from the header line the gateway sent, so the hint names
    // whatever is actually on the lens rather than one hardcoded source.
    const title = lastListLines?.[0] ?? 'List'
    // The notes list has an action; every other list does not, and a
    // hint offering one that does nothing is worse than no hint.
    if (lastNoteIds) {
      return `${title} · scroll · tap to tick off · double-tap to go back`
    }
    return `${title} · scroll to browse · double-tap to go back`
  }
  const rec = sessionActive ? `Recording (${sessionUtterances}) · ` : ''
  const mic = micOn ? 'Microphone live' : 'Paused'
  return `${rec}${mic} · tap to ${micOn ? 'pause' : 'resume'} · hold for menu`
}

function refreshStatus() {
  const kind = sessionActive || micOn ? 'listening' : 'paused'
  setStatus(kind, hint())
}

// The default stt.ts is a blank stub that throws. Catch the throw so the UI
// surfaces the "configure stt.ts" error chip instead of hanging on "Connecting…".
let stt: ReturnType<typeof startSttStream> | null = null
try {
  stt = startSttStream(
    API_KEY,
    ({ finalText, interimText }) => {
      // PHONE PANEL ONLY. The lens no longer renders from these two
      // strings - it is driven by onPartial/onUtterance/onSpeaker below,
      // because a flat string has nowhere to put a name that arrives after
      // the text it belongs to.
      //
      // onResult still carries the assistant overlay text (showOverlay in
      // stt.ts calls it with the answer as `finalText`), which is another
      // reason not to feed it to the caption buffer: an answer would be
      // appended to the conversation as though someone had said it.
      setTranscript(finalText, interimText)
    },
    err => {
      setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      console.error('STT error:', err)
    },
    // Structured answer — Plex activity, a Sparky card — rendered as a
    // scrollable OS list. lines[0] is the HEADER, not an item.
    async (lines, ids) => {
      // Kept so restoreFromAssistant() can rebuild this exact list. The page
      // is a rebuild like any other and the SDK gives no way to read a
      // container's contents back, so the only copy of what was on the lens
      // is the one we keep here.
      lastListLines = lines
      // Set TOGETHER with the lines, always, including to null. A list
      // arriving without ids after one that had them must clear these, or
      // a tap on the Plex page would mark a note done.
      lastNoteIds = ids && ids.length ? ids : null
      // The list page IS the handover out of the assistant exchange, so the
      // assistant state is cleared HERE rather than by an onAssistant(null)
      // from stt.ts. That null used to arrive one statement before this
      // callback and sent us into restoreFromAssistant(), which rebuilt the
      // caption page underneath this build - two rebuildPageContainer calls
      // racing, and this one returning false.
      //
      // Cleared BEFORE the await so a caption frame landing mid-rebuild
      // cannot be blocked by a stale box; pageMode is still 'transcript'
      // until the build succeeds, and scheduleGlassesRender()'s own re-check
      // catches the switch.
      assistant = null
      const ok = await showListPage(lensBridge, lines)
      if (!ok) {
        // rebuildPageContainer returns boolean, NOT the numeric result code
        // createStartUpPageContainer gives - `!ok`, not `!== 0`.
        setStatus('error', 'rebuildPageContainer failed (list)')
        console.error('Failed to build list page')
        return
      }
      pageMode = 'list'
      refreshStatus()
    },
    {
      // --- lens caption buffer ------------------------------------------
      //
      // Three hooks instead of one string, because the speaker name arrives
      // AFTER the text it belongs to: gateway.py sends the 'final' frame and
      // only then spawns run_speaker() to embed and score the audio
      // (gateway.py:3486-3496). The buffer keeps utterances addressable by
      // seq so the name can be filled in when it lands.
      onPartial: (text: string) => {
        setPartial(text)
        syncCaptionColumns(true)
      },
      onUtterance: (seq: number, text: string) => {
        pushFinal(seq, text)
        syncCaptionColumns(true)
      },
      onSpeaker: (seq: number, name: string | null) => {
        setName(seq, name)
        // The name lives in its OWN container, so writing it in cannot
        // change the wrap or the row count of the text beside it. This
        // repaint swaps '?' for 'Samuel' and moves nothing else.
        syncCaptionColumns(true)
      },

      onSession: (s: SessionState) => {
        sessionActive = s.active
        sessionUtterances = s.utterances
        setLiveSession(s)

        // The suggestion band belongs to the recording session, so it comes
        // and goes with it rather than sitting empty behind a border.
        //
        // setBandVisible() returns whether the value CHANGED, and that guard
        // is load-bearing: this hook fires on every utterance while
        // recording, and the band can only appear or disappear through a
        // full page rebuild - the columns are a different height with it up,
        // and container geometry is frozen at creation. Rebuilding on every
        // increment would tear down and recreate both caption columns
        // several times a minute.
        //
        // Only rebuild if the caption page is the thing on screen. From the
        // menu, a list page or an assistant box, a rebuild here would yank
        // the display out from under the user - and it is not needed, since
        // showCaptions() reads the flag when it next builds the page anyway.
        // The band leaves the page when the session stops, so anything in
        // it goes too - otherwise it would reappear on the first rebuild of
        // the NEXT session, unrelated to anything being said then.
        // `false`: the band is about to leave the page with the session,
        // and that rebuild happens a few lines below. Pushing here would
        // rebuild the page twice in a row for one event.
        if (!s.active) clearSuggestion(false)

        setBandVisible(s.active)

        // Compare against what was BUILT, not against the previous flag
        // value. This hook fires on every utterance while recording, so the
        // comparison still collapses to a no-op almost every time - but when
        // the page and the flag genuinely disagree it corrects them, even if
        // the frame that changed the flag arrived while showCaptions() was
        // mid-rebuild. Watching for the flag to CHANGE missed exactly that
        // case, and the band never appeared until the next manual return to
        // captions.
        //
        // Still skipped unless captions are the thing on screen: from the
        // menu, a list page or an assistant box a rebuild would yank the
        // display out from under the user, and showCaptions() reads the flag
        // when it next builds the page anyway.
        if (isBandVisible() !== bandOnPage && pageMode === 'transcript' && assistant === null) {
          syncCaptionColumns()
          void showCaptions()
        }

        // A stop with no summary coming (LLM unconfigured, or nothing
        // recorded) never produces a 'summary' frame, so the session list
        // has to be refreshed here or the new entry never appears.
        if (!s.active) void refreshSessions()

        // The menu header shows the utterance count, but the page is NOT
        // rebuilt on every increment: rebuilding resets the OS list
        // selection, which would yank the highlight out from under a user
        // mid-scroll. The count refreshes when the menu is next opened.
        refreshStatus()
      },
      onSuggest: (tag: string, text: string, holdMs?: number) => {
        // A newer suggestion REPLACES an older one and restarts the clock
        // rather than queueing behind it: two inside the hold window means
        // the second is the more relevant one, and the conversation has
        // already moved past the first.
        currentSuggestion = formatSuggest(tag, text)
        // How long THIS suggestion stays up, read off the frame the gateway
        // just sent - so the settings slider applies from the next
        // suggestion onward with no reload. A replacement re-reads it, so
        // moving the slider mid-conversation is picked up immediately.
        const hold = resolveHoldMs(holdMs)
        if (suggestTimer !== null) window.clearTimeout(suggestTimer)
        suggestTimer = window.setTimeout(() => {
          suggestTimer = null
          currentSuggestion = ''
          // This is now a page REBUILD, not an upgrade: the outline goes
          // with the text.
          void pushSuggestion()
        }, hold)
        void pushSuggestion()
      },
      /**
       * "hey jarvis, set a timer for 20 minutes" — the command half.
       *
       * Nothing here touches the lens. startTimer() fires onTimerChanged,
       * statusbar.ts starts its 1Hz loop off the back of that, and the
       * countdown appears in the strip on the next write. The CONFIRMATION
       * the wearer reads is a separate 'answer' frame that arrives a moment
       * later and goes through the ordinary assistant path, so it dismisses
       * itself on ANSWER_HOLD_MS like any other reply.
       *
       * A start REPLACES a running timer rather than queueing behind it —
       * timer.ts holds exactly one. That is deliberate: if you set another
       * one, that is the one you care about.
       */
      onTimer: (cmd) => {
        if (cmd.action === 'cancel') {
          const was = cancelTimer()
          if (was === null) console.log('[app] timer cancel with none running')
          return
        }
        if (typeof cmd.durationS !== 'number') {
          // The gateway never sends a start without one, so this is a
          // malformed frame rather than a case to handle. Logged rather
          // than silently ignored: a countdown that simply fails to appear
          // is otherwise indistinguishable from the wake word being missed.
          console.warn('[app] timer start frame with no duration_s', cmd)
          return
        }
        startTimer({
          durationS: cmd.durationS,
          title: cmd.title,
          alertS: cmd.alertS,
        })
      },
      /**
       * A note's due time has passed — the popup half of the notes feature.
       *
       * UNSOLICITED, unlike onTimer. Nothing on the lens led up to this and
       * no 'answer' frame follows it, so putting the box up IS the whole
       * response. That is also why it goes straight to showAlert() rather
       * than through the assistant path: there is no exchange to resolve.
       *
       * The gateway sends at most one of these per poll and marks the note
       * before sending, so this cannot arrive twice for the same note or in
       * a burst. showAlert() still guards against a box already being up,
       * because a note can come due while a TIMER alert is on the lens.
       */
      onNoteDue: (note: NoteDue) => {
        if (!note.title) {
          // notestore.create() falls back to the raw text when there is no
          // structured title, so the gateway never sends an empty one. A
          // blank full-screen box would read as a rendering fault and send
          // you looking in the wrong place, so it is logged and dropped.
          console.warn('[app] note_due frame with no title', note)
          return
        }
        // Clamped HERE, through the same resolveAlertMs() the timer path
        // uses, so one function decides what a hold may be however the
        // frame got here. A gateway older than the note_alert_s tunable
        // sends no alert_s at all, and that falls back to ALERT_S_DEFAULT
        // rather than to no hold — a box with no timeout would own the lens
        // until it was tapped.
        void showAlert({
          kind: 'note',
          id: note.id,
          title: note.title,
          alertS: resolveAlertMs(note.alertS) / 1000,
        })
      },
      onTeleprompt: (s: TelepromptState) => {
        // ONLY MOVES THE PROMPTER WHEN THE PROMPTER IS ON THE LENS. This
        // fires on reconnects and on a stop as well as on a match, and a
        // frame arriving while the wearer is reading captions must not
        // rebuild the page out from under them.
        if (pageMode !== 'teleprompt') return
        if (!s.active || telepromptScript.length === 0) return

        const line = lineOfWordIndex(telepromptScript, s.word)
        if (line === telepromptCursor) {
          // The match advanced within the SAME line. Common - a line is
          // about nine words and an utterance is often shorter - and
          // redrawing an identical page would spend a BLE round trip to
          // change nothing.
          return
        }

        // NEVER FOLLOW BACKWARDS. Whisper revises: a partial can land a line
        // ahead and its final settle a line behind, and honouring that shows
        // as a visible flicker on the lens. follow.py already refuses small
        // backward matches; this refuses the rest, because the reader is the
        // only thing that should ever move a prompter back up. They can
        // swipe, which goes through moveTeleprompt() and is unaffected.
        if (line < telepromptCursor) {
          console.log(
            `[teleprompt] ignoring backward follow ${telepromptCursor + 1} -> ${line + 1}`,
          )
          return
        }

        console.log(
          `[teleprompt] follow word ${s.word}/${s.words} -> line ${line + 1}`,
        )
        telepromptCursor = line
        // ONE REBUILD PER LINE, and this is a hard constraint rather than a
        // preference. A three-frame slide was tried here and stopped the
        // prompter following speech at all: at 116-179ms per rebuild it put
        // roughly half a second of BLE traffic behind every line, and
        // utterances arrive faster than that.
        //
        // Not awaited: this hook is on the socket's message path and holding
        // every frame behind a rebuild would back up captions, timers and
        // everything else on the socket.
        void showTelepromptPage(lensBridge, telepromptScript, telepromptCursor)
      },
      onTranslate: (s: TranslateState) => {
        console.log(`[app] translate ${s.active ? `${s.a} -> ${s.b}` : 'off'}`)
        setTranslateState(s)

        const was = translateActive
        translateActive = s.active
        if (s.active && s.a && s.b) translatePair = { a: s.a, b: s.b }

        // ONLY act on a CHANGE. This hook also fires on every reconnect,
        // from the translate_status stt.ts sends on open — and an inactive
        // frame arriving while the wearer is reading captions must not
        // rebuild the lens out from under them.
        if (s.active === was) return

        if (s.active) {
          lensQueued = null
          // Never steal the lens from a box that is mid-exchange or a timer
          // alert that is mid-hold. Both are seconds long and both restore
          // through returnToPage(), which now knows how to come back here —
          // so the page arrives when the interruption ends.
          if (assistant !== null || pageMode === 'alert') {
            console.log('[app] translate started behind an overlay')
            // Remember where to land. assistantReturnTo is read by
            // restoreFromAssistant(); alertReturnTo by closeAlert().
            if (assistant !== null) assistantReturnTo = 'translate'
            else alertReturnTo = 'translate'
            return
          }
          lensLine = null
          void showTranslate()
        } else {
          void endTranslateOnLens()
        }
      },
      onTranslation: (line: TranslationLine) => {
        // The phone gets EVERY line, both directions and the out-of-pair
        // ones. The lens gets only what the gateway marked.
        pushTranslation(line)

        if (!line.translated || !line.lens) return
        if (!translateActive) return
        // An assistant box or an alert owns the lens while it is up. The
        // line still goes to the phone above; it is simply not worth
        // interrupting a box the wearer is reading for a translation whose
        // ten seconds would be half gone by the time they looked back.
        if (assistant !== null || pageMode === 'alert') return

        void pushLensTranslation(
          {
            text: line.text,
            from: line.from,
            to: line.to,
          },
          // The FLOOR for this line's time on the lens, not its duration:
          // pushLensTranslation() extends it for longer text. Read off the
          // frame the gateway just sent, so the Translation hold slider
          // applies from the next line with no reload. A gateway older than
          // that tunable sends no hold_ms; 10s is its default.
          line.holdMs ?? 10000,
        )
      },
      onSummary: (id, _text) => {
        console.log(`[app] summary ready for ${id}`)
        void refreshSessions()
      },
      onAssistant: (s: AssistantState | null) => {
        // `dismiss()` in stt.ts fires this hook unconditionally, and
        // showCaptions() below calls dismiss() — so handling a null when
        // there is already no assistant re-enters showCaptions forever.
        // That loop repaints the caption page continuously, which is what
        // wiped the menu and the list page a few ms after they rendered.
        // A null when nothing is up means there is nothing to hand back.
        if (s === null && assistant === null) return

        // Remember where the exchange STARTED, on the transition into it
        // only. This hook fires again on every phase change (listening ->
        // question -> thinking -> answer), and by then pageMode has already
        // been overwritten below — capturing on each one would record
        // 'transcript' every time, which is exactly the bug that used to send
        // every dismissal to the caption page.
        if (s && assistant === null) {
          assistantReturnTo = pageMode
          console.log(`[assist] launched from ${assistantReturnTo}`)
        }

        assistant = s
        if (s) {
          // The alert box owns the lens. Track the new phase so the box is
          // replayed with the CURRENT state when the alert closes — an
          // answer that arrives during those seconds should be the thing
          // that comes back, not the "Thinking…" it replaced — but do not
          // rebuild, or the alert is yanked off the lens by a frame the user
          // cannot see.
          if (pageMode === 'alert') {
            alertResumeAssistant = s
            return
          }
          // The overlay REPLACES whatever page was up, including a list.
          // pageMode goes to 'transcript' for the duration because every
          // render guard in this file pairs it with `assistant === null`;
          // where the lens actually returns to is assistantReturnTo, captured
          // above.
          pageMode = 'transcript'
          void renderAssistant(s)
        } else {
          // Same reasoning for the dismissal. stt.ts's ANSWER_HOLD_MS is 10s
          // and an alert is typically 8, so an exchange that was already
          // near its end can lapse while the box is up. Clearing the resume
          // slot is what makes closeAlert() fall through to
          // alertReturnTo instead of replaying a box the gateway has since
          // forgotten.
          if (pageMode === 'alert') {
            alertResumeAssistant = null
            return
          }
          void restoreFromAssistant()
        }
      },
    },
  )
} catch (err) {
  setStatus('error', (err as Error)?.message ?? 'STT startup failed')
  console.error('STT startup failed:', err)
}

// Phone-side session browser. Mounted after `stt` exists so its Start/Stop
// buttons can reach the socket.
mountSessions(
  {
    start: (title?: string) => stt?.startSession(title),
    stop: () => stt?.stopSession(),
  },
  tabs.Conversations,
)

// Translate panel. Mounted AFTER the socket exists, same reason as
// mountSessions: its buttons send commands over it.
mountTranslate(
  {
    start: (a: string, b: string) => stt?.startTranslate(a, b),
    stop: () => stt?.stopTranslate(),
  },
  tabs.Translate,
)

// The one slider that belongs to this feature, on this feature's tab. Same
// panel code as the Live one - same fetch, same debounced PUT - narrowed to
// a single key, with no "Reset all" button since that would reset every
// tunable in the app from a card that looks like it is about one.
//
// PANEL_ORDER.tuning puts it below the pair picker regardless of the order
// these two were mounted in.
void mountSettings(tabs.Translate, {
  only: ['translate_hold_s'],
  header: false,
})

// Prompt library, in the same tab. Where it lands vertically is PANEL_ORDER's
// job, not this call's position. Independent of `stt`: it only talks to the
// gateway over REST, so a failed socket leaves prompt editing working.
void mountPrompts(tabs.Conversations)

// Prep notes, in the same tab and directly above the prompt library. Same
// independence from `stt`: choosing next period's lesson has to work whether
// or not the glasses are connected, because it happens between classes.
void mountPrep(tabs.Conversations)

// Summary prompts, below the suggest prompt library. Also REST-only, so it
// works with no glasses attached - which is when you would be editing one,
// after a class rather than during it.
void mountSummaryPrompts(tabs.Conversations)

// Suggestions and review audio, on the tab whose recordings they act on.
// Both groups in ONE panel: two mounts would be two cards with two "Tuning"
// headers, and bucket() already renders a group per card.
//
// header:false because "Reset all" from here would reset every tunable in
// the app, from a card that appears to be about suggestions.
void mountSettings(tabs.Conversations, {
  only: [
    'suggest_every_utts',
    'suggest_cooldown_s',
    'suggest_context_utts',
    'suggest_timeout_s',
    'suggest_hold_s',
    'suggest_memory',
    'suggest_dup_ratio',
    'clip_retention_h',
  ],
  header: false,
})

// Notes, on their OWN tab. REST only, so the panel works with the glasses
// disconnected and with the socket down - a failed socket leaves note
// editing working, exactly as it does for the prompt library.
void mountNotes(tabs.Notes)

// The note alert slider, beside the notes it fires for.
void mountSettings(tabs.Notes, {
  only: ['note_alert_s'],
  header: false,
})

// Teleprompter scripts, on their OWN tab for the same reason notes are:
// REST only, so the panel works with the glasses disconnected and with the
// socket down. This is where the script the lens opens is chosen.
void mountScripts(tabs.Teleprompt)

// The two prompter layout sliders, on the tab where the scripts they lay out
// live. header:false because "Reset all" from here would reset every tunable
// in the app from a card that appears to be about two sliders.
void mountSettings(tabs.Teleprompt, {
  only: ['teleprompt_row_h', 'teleprompt_chars'],
  header: false,
  // Straight into the preview, so a slider redraws it without the Scripts
  // panel polling /settings. Fires on load and after every successful save,
  // never on a failed one - so the preview never shows a value the gateway
  // rejected.
  onChange: applyTelepromptPreview,
})

if (stt) {
  await bridge.audioControl(true)
  micOn = true
  refreshStatus()
  // Re-declare the menu now that micOn is true. The startup page was built
  // from LAUNCH_MENU_STATE, whose `micOn: false` produced a "Resume mic" item
  // that would otherwise sit there lying about the mic until the first page
  // change. One rebuild of the same blank home page.
  await refreshMenu()
}

/**
 * Rebuild the page as JUST the assistant box.
 *
 * The transcript container is deliberately NOT on this page: whatever was on
 * the lens goes away for the duration of the exchange and comes back when
 * showCaptions() rebuilds. One container, so there is nothing to stack and
 * no z-order collision to get wrong.
 *
 * Called on every phase change, which is what makes the single box grow as
 * the exchange fills in.
 */
async function renderAssistant(s: AssistantState) {
  const boxes = assistantBox(s)
  console.log(
    `[assist] ${s.phase} boxes=${boxes.length} ` +
      boxes.map(b => JSON.stringify(b.content ?? '')).join(' | '),
  )

  // The strip goes on this page too. Note this ALSO changes the overlay from
  // a one-container page to a three-container one — which is the exact
  // variable the last overlay probe was left waiting on.
  const text = [...boxes, ...statusContainers()]

  const ok = await lensBridge.rebuildPageContainer(
    new RebuildPageContainer({
      containerTotalNum: text.length,
      textObject: text,
    }),
  )

  // Paint the text INTO the container the rebuild just made.
  //
  // The ID and name are read off the container that was just built rather
  // than from the OVERLAY_* constants. Those agree today, but an upgrade
  // aimed at a container that is not on the page does nothing at all and
  // reports nothing, so reading from the built object keeps the two in step
  // by construction.
  // EVERY box, not just the first: the question and the answer are separate
  // containers now, because brightness is a property of a container and the
  // two need different ones. Upgrading only boxes[0] would leave the answer
  // showing whatever the rebuild put there and never correct it.
  const upgraded: boolean[] = []
  if (ok) {
    for (const box of boxes) {
      upgraded.push(
        await bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: box.containerID ?? OVERLAY_Q_ID,
            containerName: box.containerName ?? OVERLAY_NAME,
            content: box.content ?? '',
          }),
        ),
      )
    }
  }

  console.log(`[assist] ${s.phase} rebuild=${ok} upgrade=${upgraded.join(',')}`)

  if (!ok) {
    // A z-order violation fails HERE, client-side, without ever reaching the
    // glasses — the SDK logs `[EvenHub:MISSING_Z_ORDER_INDEX]` or similar to
    // the console and returns false.
    console.error('Failed to build assistant overlay')
    return
  }

  // The caption containers are not on the page at all now, so the debounced
  // renderer's idea of what is on the lens is stale.
  lastNames = ''
  lastText = ''
}

/** Rebuild the caption page and hand the display back to the transcript. */
async function showCaptions() {
  // Diagnostic: if this repeats without a gesture, a page-rebuild loop is
  // running and it is what is wiping the menu and the list page.
  console.log(`[page] captions (from ${pageMode})`)
  // Read the flag BEFORE the await, because that is when the page is built
  // from it: showTranscriptPage() spreads suggestContainers() synchronously
  // on entry, then awaits rebuildPageContainer. Reading it afterwards records
  // the flag as it is when the rebuild FINISHES, which is a different moment
  // - and if a 'session' frame landed in between, the record would claim the
  // page has a band it was never built with, hiding the disagreement the
  // check below exists to catch.
  const builtWithBand = isBandVisible()
  // Captured at the same moment and for the same reason: the container is
  // built from currentSuggestion synchronously on entry to
  // showTranscriptPage(), so what matters is the value NOW, not after the
  // rebuild resolves. A suggestion landing mid-rebuild must not make this
  // record claim an outline the page was never built with.
  const builtWithBorder = builtWithBand && currentSuggestion !== ''
  const ok = await showTranscriptPage(
    lensBridge,
    currentText,
    currentNames,
    currentSuggestion,
  )
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (transcript)')
    console.error('Failed to rebuild transcript page')
    return
  }
  pageMode = 'transcript'
  // Force the next render through on BOTH columns: the containers were just
  // recreated, so whatever lastNames/lastText hold no longer reflects what is
  // on the lens.
  lastNames = ''
  lastText = ''
  // The band was rebuilt WITH currentSuggestion baked in, so that is what is
  // on the lens - recording it here stops pushSuggestion() writing the same
  // string again on the next frame.
  lastSuggestion = currentSuggestion
  // What this page was ACTUALLY built with, captured above.
  bandOnPage = builtWithBand
  bandBorderOnPage = builtWithBorder
  stt?.dismiss()
  refreshStatus()

  // The session state may have changed while that rebuild was in flight, in
  // which case the page just built is already stale. This is the NORMAL path
  // at session start, not an edge case: runMenuAction() calls
  // toggleSession() and then showCaptions() immediately, and startSession()
  // only SENDS the command - the gateway's confirming 'session' frame
  // arrives during this rebuild, too late for the page and too early for the
  // onSession handler to act on (the rebuild had not landed yet).
  //
  // One corrective pass. It cannot loop: the second call captures the flag
  // as it now is, and only another session frame could move it again.
  if (isBandVisible() !== bandOnPage) {
    syncCaptionColumns()
    await showCaptions()
  }

  // Same correction, for the SUGGESTION rather than the band. A frame that
  // arrived while this rebuild was in flight was baked into a page that had
  // already been assembled, or compared against a stale bandBorderOnPage.
  //
  // A no-op in the ordinary case: pushSuggestion() returns immediately when
  // currentSuggestion already matches what was built, which is what
  // lastSuggestion was just set to. It cannot loop for the same reason.
  void pushSuggestion()
}

/**
 * Rebuild the blank home page and hand the lens back to it.
 *
 * Deliberately does NOT call stt?.dismiss() the way showCaptions() does.
 * dismiss() fires onAssistant(null), which now calls restoreFromAssistant() —
 * and when the exchange was launched from home, that calls straight back into
 * this function. A dismiss() here would be a page-rebuild loop. Home is only
 * ever reached by a gesture, and the assistant box owns the gestures while it
 * is up, so there is nothing to dismiss on this path anyway.
 *
 * lastNames/lastText are cleared for the same reason showCaptions() sets them:
 * the caption containers are not on this page, so whatever they hold no longer
 * describes the lens.
 */
async function showTeleprompt(reset = false) {
  console.log(`[page] teleprompt (from ${pageMode})`)

  if (reset || telepromptScript.length === 0) {
    // The gateway is authoritative for which script this is. /scripts/active
    // returns the ONE script rather than the library, because the lens has no
    // picker yet and pulling the whole library to use one of it would be
    // work for nothing.
    let script: { title?: string; text?: string } | null
    try {
      const r = await fetch(restUrl('/scripts/active'))
      if (!r.ok) throw new Error(`${r.status}`)
      script = ((await r.json()) as { script: typeof script }).script
    } catch (e) {
      setStatus('error', `script fetch failed: ${(e as Error).message}`)
      console.error('Failed to fetch active script:', e)
      // A full-width message rather than a blank prompter. An empty
      // teleprompter and a broken one look identical on the lens, and the
      // wearer cannot see the phone's status line from inside the glasses.
      await showMessagePage(lensBridge, 'Could not load script')
      pageMode = 'transcript'
      lastNames = ''
      lastText = ''
      return
    }

    // AN EMPTY LIBRARY IS NOT AN ERROR. /scripts/active answers 200 with a
    // null script when nothing has been saved yet, which is an ordinary
    // state on a fresh install and deserves an instruction rather than a
    // failure.
    if (!script || !script.text) {
      console.log('[teleprompt] no active script')
      await showMessagePage(lensBridge, 'No script saved yet')
      pageMode = 'transcript'
      lastNames = ''
      lastText = ''
      return
    }

    // LAYOUT BEFORE WRAPPING. teleprompt_chars decides where lines break, so
    // fetching it after telepromptLines() would wrap at the old width and
    // leave the cursor indexing an array built to a different geometry.
    //
    // Fetched on every open rather than once at startup, so moving the
    // sliders and re-opening the prompter shows the new layout - which is
    // the only way to judge these two numbers.
    //
    // A failure here is NOT fatal: the defaults in teleprompt.ts are sane
    // and a prompter at the wrong line spacing beats no prompter at all.
    try {
      const r = await fetch(restUrl('/settings'))
      if (r.ok) {
        const d = (await r.json()) as { values: Record<string, number> }
        setTelepromptLayout({
          rowH: d.values?.teleprompt_row_h,
          chars: d.values?.teleprompt_chars,
        })
      }
    } catch (e) {
      console.warn('[teleprompt] layout fetch failed, using defaults:', e)
    }

    console.log(`[teleprompt] loaded ${script.title ?? 'untitled'} (${script.text.length} chars)`)
    telepromptScript = telepromptLines(script.text)
    telepromptCursor = 0

    // Tell the gateway to start following. It reads the script from its own
    // store rather than being sent the text - see stt.ts - so this cannot
    // disagree with the copy just fetched: both came from /scripts.
    //
    // Fire and forget, and NOT awaited before the page is built: a gateway
    // that is down should still leave a readable prompter that swipes.
    stt?.startTeleprompt()
  }

  const ok = await showTelepromptPage(
    lensBridge,
    telepromptScript,
    telepromptCursor,
  )
  if (!ok) {
    // rebuildPageContainer returning false is almost always a CLIENT-SIDE
    // validation failure - a duplicate or missing zOrderIndex, or a menu
    // label over 32 UTF-8 bytes - which never reaches the glasses. It is
    // not a BLE problem and retrying will not help.
    setStatus('error', 'rebuildPageContainer failed (teleprompt)')
    console.error('Failed to build teleprompt page')
    return
  }

  pageMode = 'teleprompt'
  // The caption containers are not on this page, so the caches that say what
  // was last written to them have to be cleared or the next return to
  // captions will skip a write it thinks it already made.
  lastNames = ''
  lastText = ''
  lastSuggestion = ''
  bandOnPage = false
  bandBorderOnPage = false
  refreshStatus()
}

/**
 * Move the cursor and redraw.
 *
 * A FULL PAGE REBUILD per line, deliberately, rather than five
 * textContainerUpgrade calls. Brightness moves with the cursor - the line
 * that was the focus becomes a spoken line - and textContainerUpgrade can
 * carry `textColor`, so five upgrades would work in principle. But five
 * bridge calls on a BLE queue slow enough to need a 120ms debounce elsewhere
 * in this file is not obviously cheaper than one rebuild, and five calls can
 * land SPLIT ACROSS A FRAME, showing two focus lines or none.
 *
 * If the rebuild turns out to be too slow to swipe against, THAT is when to
 * try the upgrade path - with a measurement rather than a guess.
 */
async function moveTeleprompt(delta: number) {
  const next = clampCursor(telepromptCursor + delta, telepromptScript)
  if (next === telepromptCursor) {
    // Already at an end. Redrawing an identical page would spend a BLE
    // round trip to change nothing.
    console.log(`[teleprompt] at ${delta > 0 ? 'end' : 'start'} of script`)
    return
  }
  console.log(`[teleprompt] line ${next + 1}/${telepromptScript.length}`)

  // THE THUMB WINS. Without this the aligner keeps searching around its own
  // old cursor, and the next matched utterance drags the prompter back to
  // where the wearer just moved it away from.
  stt?.seekTeleprompt(wordIndexOfLine(telepromptScript, next))

  telepromptCursor = next
  await showTelepromptPage(lensBridge, telepromptScript, telepromptCursor)
}

async function showHome() {
  console.log(`[page] home (from ${pageMode})`)
  const ok = await showHomePage(lensBridge)
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (home)')
    console.error('Failed to build home page')
    return
  }
  pageMode = 'home'
  lastNames = ''
  lastText = ''
  // The band container is not on this page either, so a suggestion arriving
  // now must not be recorded as already written. pushSuggestion() is guarded
  // by pageMode anyway; this keeps the cache honest for the next rebuild.
  lastSuggestion = ''
  bandOnPage = false
  bandBorderOnPage = false
  refreshStatus()
}

/**
 * Hand the lens back to whatever page the assistant exchange interrupted.
 *
 * Called ONLY from onAssistant's null branch, which is itself guarded against
 * firing when no box was up — so this cannot re-enter: showCaptions() calls
 * stt.dismiss(), but by the time we get here stt.ts has already cleared its
 * overlay, and closeAssistant() returns immediately when there is nothing to
 * close.
 *
 * The 'list' case rebuilds it from the retained lines. If a structured
 * answer is what ENDED this exchange, stt.ts fires onAssistant(null) and then
 * onLines() — so a return to the list here can be immediately replaced by the
 * new one. Both are list pages, so the worst case is one wasted rebuild, not
 * a wrong page.
 */
async function restoreFromAssistant() {
  console.log(`[assist] returning to ${assistantReturnTo}`)
  await returnToPage(assistantReturnTo)
}

/**
 * Rebuild a remembered page. The shared body of every "hand the lens back"
 * path in this file.
 *
 * Split out of restoreFromAssistant() when the timer alert box arrived and
 * needed the identical switch. Two copies would have been two places to
 * remember that 'list' is rebuilt from retained lines and that
 * lastNames/lastText have to be cleared — and the second copy is exactly
 * where that gets forgotten.
 *
 * 'alert' is not a case: an alert is never the page you return TO, only the
 * one you return FROM. It falls to the default, which is captions.
 */
async function returnToPage(mode: PageMode) {
  switch (mode) {
    case 'home':
      await showHome()
      break
    case 'translate':
      // Reachable when an assistant box or a timer alert interrupted the
      // translate page. `lensLine` may have been cleared by its hold while
      // the interruption was up, in which case this rebuilds the idle
      // header — which is correct: the line's ten seconds are over.
      await showTranslate()
      break
    case 'list':
      // No retained lines means the list was never built in this session —
      // fall through to captions rather than rebuild an empty list.
      if (lastListLines) {
        const ok = await showListPage(lensBridge, lastListLines)
        if (!ok) {
          setStatus('error', 'rebuildPageContainer failed (list)')
          console.error('Failed to rebuild list page')
          return
        }
        pageMode = 'list'
        lastNames = ''
        lastText = ''
        refreshStatus()
      } else {
        await showCaptions()
      }
      break
    default:
      await showCaptions()
  }
}

/**
 * What put the alert box on the lens. Drives the status hint and the log
 * prefix, and nothing else — the page itself is identical either way.
 *
 * 'timer' is a countdown the wearer set minutes ago and is expecting.
 * 'note' is a due date arriving unannounced, possibly hours after the note
 * was written, which is why the two get different holds (note_alert_s vs
 * timer_alert_s) and different wording on the phone.
 */
type AlertKind = 'timer' | 'note'

/**
 * Which of the two put the CURRENT box up. Meaningless unless
 * pageMode === 'alert'; set by showAlert() before the page is built so
 * hint() is already correct by the time refreshStatus() runs.
 */
let alertKind: AlertKind = 'timer'

/**
 * Put a title on the lens, full screen, and set the clock that takes it
 * away again.
 *
 * TWO CALLERS, ONE PAGE. An expired timer and a note that has come due are
 * the same event as far as the lens is concerned — something the wearer
 * asked to be interrupted by has arrived — so they share the page, the
 * suspend/resume logic below, the tap handler and the return path. Only the
 * hold and the wording differ, and both of those ride in on the call.
 *
 * THE ALERT SUSPENDS AN ASSISTANT EXCHANGE, IT DOES NOT END ONE.
 *
 * The first cut nulled `assistant` and called stt.dismiss(), which sends
 * 'endconvo' — so a timer going off mid-answer threw away the follow-up
 * window, the held history and the answer itself. "Take the lens" and "end
 * the conversation" are two different things and that collapsed them.
 *
 * So nothing is torn down. `assistant` keeps its state, the exchange is
 * remembered in alertResumeAssistant, and closeAlert() rebuilds the box
 * exactly as renderAssistant() left it — the box is sized from state on
 * every phase change anyway, so replaying it is a normal operation and not a
 * special restore path. The gateway is never told anything, because from its
 * side nothing happened.
 *
 * What CAN still end the exchange while the box is up is stt.ts's own
 * ANSWER_HOLD_MS timeout, which at 10s will usually outlast an 8s alert but
 * not always. That arrives as onAssistant(null), and the handler below
 * treats it as "there is nothing to resume" rather than rebuilding the page
 * out from under the alert.
 */
async function showAlert(opts: {
  kind: AlertKind
  /** Identity, for the log line only. A timer id, or a note id. */
  id: string
  /** What fills the lens. */
  title: string
  /** How long it holds, in SECONDS, already clamped by the caller. */
  alertS: number
}) {
  // Only one box at a time. A timer expiry cannot collide with itself
  // (timer.ts holds exactly one countdown), but a note coming due while a
  // timer alert is up is an ordinary race now that there are two sources —
  // and opening the second would overwrite alertReturnTo with 'alert' and
  // strand the lens there with nothing to return to.
  //
  // The loser is DROPPED, not queued. For a note that is safe: the gateway
  // has already marked it alerted, so it will not be sent again, but the
  // note is still in the list, still overdue and still shows its date when
  // the wearer next looks. Queueing would mean a second full-screen
  // interruption arriving seconds after the first, which is worse than
  // missing one.
  if (pageMode === 'alert') {
    console.warn(
      `[${opts.kind}] alert already up (${alertKind}), ignoring ${opts.id}`,
    )
    return
  }

  if (assistant !== null) {
    // Where to go if the exchange dies during the alert: the page it was
    // launched from, never 'transcript', which is only what pageMode is set
    // to for the duration of a box.
    alertReturnTo = assistantReturnTo
    alertResumeAssistant = assistant
    console.log(`[${opts.kind}] alert suspending assistant box`)
  } else {
    alertReturnTo = pageMode
    alertResumeAssistant = null
  }

  // Set BEFORE the build, so hint() is already correct when refreshStatus()
  // runs below and the phone never shows "Timer finished" under a note.
  alertKind = opts.kind

  console.log(
    `[${opts.kind}] alert "${opts.title}" for ${opts.alertS}s ` +
      `(returning to ${alertReturnTo})`,
  )

  const ok = await showAlertPage(lensBridge, opts.title)
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (alert)')
    console.error('Failed to build alert page')
    // Nothing was put on the lens, so there is nothing to take off it and no
    // timer to set. Whatever page was up is still up and pageMode still
    // describes it.
    alertResumeAssistant = null
    return
  }

  pageMode = 'alert'
  // THE ONE PAGE IN THIS APP WITHOUT THE STATUS STRIP. Containers 10, 11 and
  // 13 are not on it, so statusbar.ts's clock, battery and countdown writes
  // have to be suppressed until it comes down — otherwise they are issued
  // against containers that do not exist, which the simulator reports as
  // `container N not found` and real glasses silently drop.
  setStripOnPage(false)
  // The caption containers are not on this page either, so the debounced
  // renderer's idea of what is on the lens is stale — same reason
  // renderAssistant() and showHome() clear these.
  lastNames = ''
  lastText = ''
  lastSuggestion = ''
  bandOnPage = false
  bandBorderOnPage = false
  refreshStatus()

  if (alertTimer !== null) window.clearTimeout(alertTimer)
  // Already clamped by the caller — timer.ts freezes alertS onto the timer
  // when it is set, and the note path runs the frame's alert_s through the
  // same resolveAlertMs(). Both go through ONE clamp, so a bad value from
  // the gateway cannot pin the lens indefinitely from either direction.
  alertTimer = window.setTimeout(() => {
    alertTimer = null
    void closeAlert('elapsed')
  }, opts.alertS * 1000)
}

/**
 * Take the alert box off the lens and rebuild what was underneath it.
 *
 * Reached two ways: the timeout above, and a tap. Guarded on pageMode rather
 * than on alertTimer because the timeout nulls its own handle before calling
 * — so on that path there is no timer left to test.
 *
 * setStripOnPage(true) happens BEFORE the rebuild, not after: every page
 * below carries the strip, and statusContainers() bakes current content into
 * all three containers as it builds them. Setting it afterwards would leave
 * a window where the strip is on the lens but the push helpers still think
 * it is not.
 */
async function closeAlert(reason: string) {
  if (pageMode !== 'alert') return
  if (alertTimer !== null) {
    window.clearTimeout(alertTimer)
    alertTimer = null
  }
  setStripOnPage(true)

  // An exchange was suspended AND is still live. Replay it. `assistant` is
  // checked as well as the remembered copy because stt.ts's ANSWER_HOLD_MS
  // may have expired the exchange while the box was up, in which case
  // onAssistant(null) has already nulled it and there is nothing to go back
  // to but the page it was launched from.
  const resume = alertResumeAssistant
  alertResumeAssistant = null
  if (resume !== null && assistant !== null) {
    console.log(
      `[${alertKind}] alert closed (${reason}) -> resuming assistant box`,
    )
    // pageMode and refreshStatus() are onAssistant's job on the normal path,
    // so they have to be done by hand here.
    pageMode = 'transcript'
    await renderAssistant(assistant)
    refreshStatus()
    return
  }

  console.log(`[${alertKind}] alert closed (${reason}) -> ${alertReturnTo}`)
  await returnToPage(alertReturnTo)
}

// The countdown reaching zero. timer.ts clears its own state BEFORE firing
// this, so the rebuild below cannot bake a stale "00:00 left" into the strip
// — and by the time this runs, statusbar.ts has already blanked the
// countdown container and stopped its 1Hz interval.
//
// Deliberately not unsubscribed anywhere: it lives as long as the widget,
// and cleanup() tears the whole WebView context down.
onTimerExpired(t => {
  void showAlert({
    kind: 'timer',
    id: t.id,
    title: t.title,
    // Frozen onto the timer by timer.ts when it was set, and already
    // clamped there — so a slider moved while this one was counting down
    // does not change the alert it was set with.
    alertS: t.alertS,
  })
})

/**
 * Draw the translate page: either a line, or the idle header.
 *
 * Every path that puts translate mode on the lens comes through here, so
 * pageMode and the stale-render bookkeeping are done in ONE place rather
 * than at each call site.
 */
async function showTranslate() {
  const ok = await showTranslatePage(lensBridge, lensLine ?? {
    text: '',
    from: translatePair.a,
    to: translatePair.b,
  })
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (translate)')
    console.error('Failed to build translate page')
    return
  }
  pageMode = 'translate'
  // The caption containers are not on this page, so the debounced renderer's
  // idea of what is on the lens is stale — same reason renderAssistant(),
  // showHome() and showAlert() clear these.
  lastNames = ''
  lastText = ''
  lastSuggestion = ''
  bandOnPage = false
  bandBorderOnPage = false
  refreshStatus()
}

/**
 * Show one line and set the clock for what happens when its time is up.
 *
 * The duration is derived from the line's LENGTH — see readMs() — so a
 * paragraph gets longer than a four-word reply. `lensFloorMs` is the
 * gateway's hold_ms, which the slider now sets as the MINIMUM rather than
 * the fixed value.
 */
async function showLensLine(line: LensTranslation) {
  lensLine = line
  const ms = readMs(line.text, lensFloorMs)
  console.log(`[translate] lens ${line.text.length} chars for ${ms}ms`)

  if (translateTimer !== null) window.clearTimeout(translateTimer)
  translateTimer = window.setTimeout(() => {
    translateTimer = null
    if (!translateActive || pageMode !== 'translate') {
      lensLine = null
      lensQueued = null
      return
    }
    // Something arrived while this one was being read: show it now rather
    // than passing through the idle state, which would blink the lens.
    const next = lensQueued
    lensQueued = null
    if (next) {
      void showLensLine(next)
      return
    }
    // Back to the idle label, NOT to captions: translate mode is still
    // running and the next utterance belongs on this page.
    lensLine = null
    void showTranslate()
  }, ms)

  await showTranslate()
}

/**
 * A translation the gateway marked for the lens.
 *
 * Holds it back if the line already up has not had its reading time. Only
 * the NEWEST waiting line is kept; see lensQueued.
 */
async function pushLensTranslation(line: LensTranslation, holdMs: number) {
  lensFloorMs = holdMs

  if (translateTimer !== null) {
    // Something is still being read. Wait behind it.
    lensQueued = line
    console.log('[translate] queued behind the line being read')
    return
  }

  await showLensLine(line)
}

/** Leave translate mode on the lens. Called when the gateway says it ended. */
async function endTranslateOnLens() {
  if (translateTimer !== null) {
    window.clearTimeout(translateTimer)
    translateTimer = null
  }
  lensLine = null
  lensQueued = null
  // Home rather than captions. Translate mode is started from the phone, so
  // the wearer did not come here from the caption page and should not be
  // dropped into it — home is the root of the lens hierarchy.
  if (pageMode === 'translate') await showHome()
}

/**
 * The state the menu draws itself from.
 *
 * ONE builder, read by withMenu() every time a page is rebuilt. Every menu the
 * glasses hold was declared from this, so what the wearer reads on an item is
 * whatever this returned at the last rebuild - see refreshMenu().
 *
 * A stale label can no longer select the wrong action the way the old list
 * page could: selection now comes back as a stable itemID rather than as a row
 * index resolved against menuLabels().
 *
 * `translatePair` comes from the phone panel's last used pair rather than
 * from `translatePair` here, which only holds a pair while a translation is
 * actually running. Before the first one of the session there is nothing in
 * it, and the menu still has to be able to offer a sensible default.
 */
function menuState() {
  return {
    sessionActive,
    micOn,
    utterances: sessionUtterances,
    translateActive,
    translatePair: translateActive ? translatePair : lastPair(),
  }
}

/**
 * Re-declare the contextual menu.
 *
 * MENU ITEMS ARE FIRE AND FORGET: the glasses hold whatever labels were sent
 * with the current page and there is no path from the app back into an open
 * menu. An item reading "Pause mic" goes on reading "Pause mic" after the mic
 * has been paused, until the page is built again.
 *
 * So this rebuilds THE PAGE THAT IS ALREADY UP - returnToPage(pageMode) - and
 * the menu rides along on that rebuild via withMenu(). Nothing on the lens
 * changes; only the overlay the OS is holding does.
 *
 * Only needed after an action that flips one of the STATE-DEPENDENT labels
 * (mic, session, translate). Actions that already rebuild the page as part of
 * their own work - opening captions, starting a recording - get this for free
 * and must not call it again.
 */
async function refreshMenu() {
  console.log(`[menu] re-declaring on ${pageMode}: ${menuLabels(menuState()).join(' | ')}`)
  await returnToPage(pageMode)
}

function toggleMic() {
  if (!stt) return
  micOn = !micOn
  bridge.audioControl(micOn)
  // The caption buffer is not cleared here — pausing should not lose what is
  // on the lens — but the scroll offset indexes into the wrapped line list,
  // and 'Listening…'/'Paused' is one line. Without this the next partial
  // renders against a stale offset and the lens comes back blank.
  resetCaptions()
  setLensMessage(micOn ? 'Listening…' : 'Paused')
  refreshStatus()
}

function toggleSession() {
  if (!stt) return
  // The gateway confirms with a 'session' frame; nothing here assumes the
  // command succeeded.
  if (sessionActive) {
    stt.stopSession()
    return
  }

  // Starting a recording with the mic paused records silence. audioControl(false)
  // stops the HOST pushing PCM, so no frames reach sendPcm, the gateway never
  // sees an utterance, and the lens sits on whatever text was last rendered —
  // which looks exactly like a frozen display. Starting a conversation implies
  // capturing it, so resume the mic rather than leaving a recording that cannot
  // record.
  if (!micOn) {
    micOn = true
    bridge.audioControl(true)
  }

  // Fresh conversation, fresh lens. Without this, showCaptions() below calls
  // stt.dismiss(), which repaints the caption buffer — and that buffer still
  // holds the tail of whatever was said before the recording started.
  stt.clearTranscript()
  resetCaptions()
  setLensMessage('Listening…')

  stt.startSession()
}

/**
 * Run a contextual menu action.
 *
 * The action arrives already resolved, from actionForItemId() against the
 * itemID the OS reported. The index-and-label matching this function used to
 * do is gone with the list page, and with it a whole class of bug: a row index
 * had to be resolved against menuLabels() rebuilt from CURRENT state, so a
 * label that changed between drawing the page and tapping it could run the
 * wrong action. An itemID is a fixed protocol number and cannot drift.
 *
 * There is no protobuf zero-value trap here either - itemID 0 is illegal by
 * protocol, so an absent field genuinely means "no item" rather than "item 0",
 * which is exactly the trap selectIndexOf() exists to work around for lists.
 */
async function runMenuAction(action: MenuAction) {
  console.log(`[menu] action ${action}`)

  switch (action) {
    case 'captions':
      await showCaptions()
      break
    case 'translate':
      // Fire and forget: the gateway's 'translate' frame is what actually
      // moves the lens, through the onTranslate hook. Rebuilding the menu
      // here would race that frame and could leave a stale label up.
      //
      // Nothing is drawn on failure either. If the socket is down the
      // command is dropped with a warning from sendCmd() and the menu simply
      // stays put, which is the honest outcome - the mode did not start.
      if (translateActive) {
        console.log('[menu] stopping translation')
        stt?.stopTranslate()
      } else {
        const p = lastPair()
        console.log(`[menu] starting translation ${p.a} -> ${p.b}`)
        stt?.startTranslate(p.a, p.b)
      }
      break
    case 'teleprompt':
      // `true` reloads the script and sends the cursor back to the top.
      // Opening the prompter from the menu means starting a read, not
      // resuming one - and with no store behind it there is nothing yet that
      // could make resuming meaningful.
      await showTeleprompt(true)
      break
    case 'session':
      toggleSession()
      // Leave the menu so the user sees captions and the recording flag
      // rather than a stale menu header.
      await showCaptions()
      break
    case 'mic':
      toggleMic()
      // Re-declare so the item flips to its opposite. The menu the OS is
      // holding still says what it said when this page was built.
      await refreshMenu()
      break
    // 'exit' USED TO BE HERE and has been removed from MENU_ACTIONS. The OS
    // already puts its own "Close" row at the bottom of this same menu, so
    // ours was a second item doing the identical thing - and the root page
    // double tap below is a third route to it.
    //
    // shutDownPageContainer(1) is still called there, on the double tap, so
    // the exitMode-1 confirmation requirement is unaffected.
    default:
      await showCaptions()
  }
}

/**
 * Rebuild the notes list from the gateway.
 *
 * Called after completing one, because the completed note leaves the list and
 * the rows below it shift up. Nothing here re-renders the page from local
 * state: the rows come back already formatted from /notes/lens, so the
 * 64-character cap and the date-survives-truncation rule stay in Python where
 * they are tested. See NoteStore.lens_view().
 *
 * An empty list - every note ticked off - comes back as a header with no
 * items, and showListPage() falls through to a plain message page for that.
 * pageMode stays 'list' so double tap still leaves the way it did.
 */
async function refreshNotesPage(): Promise<void> {
  let view: { lines: string[]; ids: string[] }
  try {
    const r = await fetch(restUrl('/notes/lens'))
    if (!r.ok) throw new Error(`${r.status}`)
    view = (await r.json()) as { lines: string[]; ids: string[] }
  } catch (e) {
    setStatus('error', `notes refresh failed: ${(e as Error).message}`)
    console.error('Failed to refresh notes list:', e)
    return
  }

  lastListLines = view.lines
  lastNoteIds = view.ids.length ? view.ids : null

  const ok = await showListPage(lensBridge, view.lines)
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (notes)')
    console.error('Failed to rebuild notes list')
    return
  }
  pageMode = 'list'
  lastNames = ''
  lastText = ''
  refreshStatus()
}

/**
 * Mark the tapped note done.
 *
 * RESOLVED BY NAME FIRST, INDEX SECOND: currentSelectItemIndex is a protobuf
 * int32, so index 0 arrives as `undefined`, while the item NAME is a non-zero
 * value and survives the wire intact.
 *
 * This is now the ONLY place in the app that has to know that rule. The menu
 * used to be a list page and shared it; the contextual menu reports a stable
 * itemID instead, and itemID 0 is illegal by protocol, so nothing about menu
 * selection needs this any more.
 *
 * That omission was a real bug. Treating the missing index as "no selection"
 * meant a tap on the FIRST row was silently ignored, which looked from the
 * outside like notes with no due date being untickable - the note being tapped
 * simply happened to be at the top of the list.
 *
 * The name is also the STALENESS CHECK, which the menu does not need and this
 * does. The list on the lens is a snapshot: a note completed from the phone, or
 * a capture landing while the page is up, changes what the gateway would build
 * without changing what the glasses are showing. A name that matches exactly
 * one row is trustworthy whatever index came with it. A name that matches none
 * means the page is stale, and there is no undo on the lens - only the phone
 * can reopen a note - so it refreshes rather than guessing.
 *
 * DUPLICATE TITLES fall back to the index, because two identical rows make the
 * name useless for telling them apart and the index is then the only thing
 * that distinguishes them.
 */
async function completeNoteAt(
  reportedIndex: number | null,
  name?: string,
): Promise<void> {
  const ids = lastNoteIds
  const lines = lastListLines
  if (!ids || !lines) return

  // lines[0] is the header, so the row for ids[i] is lines[i + 1].
  const rows = lines.slice(1)

  let index = reportedIndex ?? 0
  if (typeof name === 'string' && name.length) {
    const hits: number[] = []
    rows.forEach((row, i) => { if (row === name) hits.push(i) })
    if (hits.length === 1) {
      index = hits[0]
    } else if (hits.length === 0) {
      // The glasses are showing a row this page does not have. Refresh and
      // let the wearer tap again against a list that is current.
      const msg = `note tap ignored: ${JSON.stringify(name)} is not on this list`
      console.warn(`[notes] ${msg}`)
      setStatus('error', msg)
      await refreshNotesPage()
      return
    }
    // hits.length > 1: two notes with the same row text. `index` keeps the
    // reported value, which is the only thing that separates them.
  }

  if (index < 0 || index >= ids.length) {
    // EVERY REFUSAL REPORTS TO THE PHONE, not only to the console. The WebView
    // console is not reachable while the app is on the glasses, so a branch
    // that declines to act and says so only to console.warn is, from the
    // wearer's side, indistinguishable from a dead gesture. That is exactly
    // how the index-zero bug stayed hidden.
    const msg = `note tap ignored: row ${index} outside 0..${ids.length - 1}`
    console.warn(`[notes] ${msg}`)
    setStatus('error', msg)
    await refreshNotesPage()
    return
  }

  const id = ids[index]
  console.log(
    `[notes] tick index=${reportedIndex} name=${JSON.stringify(name)} ` +
    `-> row ${index} ${id}`,
  )
  try {
    const r = await fetch(restUrl(`/notes/${id}/complete`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: true }),
    })
    if (!r.ok) throw new Error(`${r.status}`)
  } catch (e) {
    const msg = `could not tick note: ${(e as Error).message}`
    setStatus('error', msg)
    console.error('[notes]', msg, e)
    return
  }
  await refreshNotesPage()
}

async function goBack() {
  // Back out of the assistant box first — it is the topmost thing on screen.
  if (assistant !== null) {
    stt?.dismiss()
    return
  }
  // Home is the ROOT, and every other page is one level down from it: the
  // menu is no longer a page in the hierarchy, it is an OS overlay reachable
  // from all of them. So "back" from a feature page goes to home — never to
  // captions, which is one of the things the menu launches rather than the
  // page underneath it.
  // Double tap ENDS TRANSLATE MODE rather than merely leaving the page.
  // Leaving would strand the gateway translating with nothing on the lens
  // to show for it, and the only way back would be the phone. The gateway's
  // 'translate' frame then drives endTranslateOnLens(), so the lens and the
  // mode come down together rather than one guessing about the other.
  if (pageMode === 'translate') {
    console.log('[app] double-tap in translate -> ending translate mode')
    stt?.stopTranslate()
    return
  }
  if (pageMode === 'teleprompt') {
    // Leaving the prompter ends the follow. A gateway left following a
    // script nobody is reading would keep matching ordinary conversation
    // against it and logging moves for a page that is not on the lens.
    //
    // NOTE this is the only exit that stops it. Reaching for the menu and
    // picking Captions or Translate leaves the follow running until the next
    // teleprompt_start replaces it - harmless, since nothing renders it, but
    // worth knowing when reading the gateway log.
    stt?.stopTeleprompt()
  }
  if (pageMode === 'home') {
    // ROOT PAGE. Double tap here MUST call shutDownPageContainer(1) — the
    // system exit confirmation. This is a submission requirement, not a
    // preference: mode 0 (immediate exit) and any in-app confirmation UI of
    // our own are both rejected on the root page, as is doing nothing.
    //
    // It used to open the menu. That was only ever defensible under the
    // pattern where the menu it opened contained an Exit item; with the menu
    // moved to the OS overlay there is nothing left on this gesture, so it
    // goes back to being the exit it is supposed to be.
    console.log('[gesture] double-tap on root -> system exit dialog')
    await bridge.shutDownPageContainer(1)
  } else {
    await showHome()
  }
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  // Stop the recording deliberately so the gateway writes the file and
  // summarises, rather than treating it as an interrupted session.
  if (sessionActive) stt?.stopSession()
  bridge.audioControl(false)
  stt?.close()
  stopStatusUpdates()
  // The hold timer would otherwise outlive the widget and fire a
  // textContainerUpgrade against a torn-down bridge.
  if (suggestTimer !== null) {
    window.clearTimeout(suggestTimer)
    suggestTimer = null
  }
  // Same reason: it would fire a rebuildPageContainer against a torn-down
  // bridge some seconds after the widget had gone.
  if (alertTimer !== null) {
    window.clearTimeout(alertTimer)
    alertTimer = null
  }
  // Same reason again: it would fire a rebuildPageContainer against a
  // torn-down bridge up to ten seconds after the widget had gone.
  if (translateTimer !== null) {
    window.clearTimeout(translateTimer)
    translateTimer = null
  }
  unsubscribe()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all — and in this app
// that means every incoming audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Reads the selected row out of a list envelope.
//
// THE SAME PROTOBUF TRAP AS eventTypeOf ABOVE, and it cost a real bug:
// index 0 is a zero value, protobuf omits zero-value fields on the wire,
// so a tap on the FIRST row of a list arrives with
// `currentSelectItemIndex` undefined. Code that treats undefined as "no
// index" silently ignores every tap on the top row - which showed up as
// notes without a due date not ticking off, because the note being tapped
// happened to be the first one.
//
// Resolved INSIDE the envelope check, exactly as eventTypeOf does. A
// missing envelope still means no index - a tap that never reached the
// list at all must not be read as a tap on row zero.
//
// Defaulting to 0 is only safe because the caller re-checks the reported
// LABEL against the row it believes is at that index; see completeNoteAt().
// Without that check this would turn a stray envelope into a tick on the
// wrong note.
function selectIndexOf(
  envelope?: { currentSelectItemIndex?: number },
): number | null {
  if (!envelope) return null
  return envelope.currentSelectItemIndex ?? 0
}

// Event routing.
//
// Gestures:
//   single tap        -> select
//   double tap        -> back, and on the ROOT page the system exit dialog
//   tap then long press -> the OS raises the CONTEXTUAL MENU. The gesture
//                 itself never reaches us; we see the overlay opening as
//                 FOREGROUND_ENTER_EVENT, a selection as
//                 menuItemClickEvent, and the overlay closing as
//                 FOREGROUND_EXIT_EVENT.
//   long press    -> shut down, consumed by the OS. There is NO long-press
//                 value in OsEventTypeList, so it never arrives here; we
//                 only see the aftermath as SYSTEM_EXIT_EVENT.
//
// Check DOUBLE_CLICK_EVENT before CLICK_EVENT: a double tap may also
// deliver a click envelope, and back must win over select.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  // THE CONTEXTUAL MENU IS ITS OWN TOP-LEVEL EVENT FIELD.
  //
  // It does NOT route through isEventCapture the way list and text events do,
  // so it arrives whichever container is capturing and on whichever page is
  // up — which is why it is handled here, above every pageMode branch below,
  // rather than inside one of them. The alert box owns every ordinary gesture
  // while it is up; it does not own this one.
  //
  // No `?? 0` fallback, deliberately: itemID 0 is illegal by protocol, so an
  // absent field means no item rather than the first item. This is the exact
  // opposite of the list-index rule in selectIndexOf() below.
  const menuItemId = event.menuItemClickEvent?.itemID
  if (menuItemId !== undefined) {
    const action = actionForItemId(menuItemId)
    if (!action) {
      const msg = `menu itemID ${menuItemId} is not one this page declared`
      console.warn(`[menu] ${msg}`)
      setStatus('error', msg)
      return
    }
    void runMenuAction(action)
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  // In list modes (list, menu) the LIST holds isEventCapture, so taps and
  // scrolls arrive as listEvent rather than textEvent.
  const listType = eventTypeOf(event.listEvent)

  // THE ALERT BOX OWNS EVERY GESTURE, and it is checked before the
  // double-tap branch rather than inside it.
  //
  // The box is the only container on its page and it is the only thing on
  // the lens, so there is no "select" to distinguish from "back" — both mean
  // the same thing, which is "I have seen it, take it away". Routing a
  // double tap to goBack() instead would send the lens to the menu rather
  // than to the page the alert interrupted.
  if (pageMode === 'alert') {
    const tapped =
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT ||
      listType === OsEventTypeList.CLICK_EVENT ||
      sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
      listType === OsEventTypeList.DOUBLE_CLICK_EVENT
    if (tapped) {
      void closeAlert('tapped')
      return
    }
    // A SYSTEM_EXIT_EVENT still has to fall through to cleanup() below, so
    // this deliberately does not return on everything.
  }

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    // Diagnostic: if two of these land per physical double tap, the second
    // one takes "back" out of the page the first one just built.
    console.log(`[gesture] double-tap in ${pageMode}`)
    void goBack()
    return
  }

  // The contextual menu opening and closing arrives as ordinary foreground
  // events on the page underneath it.
  //
  // FOREGROUND_EXIT_EVENT HERE DOES NOT MEAN THE APP WAS TORN DOWN. The page
  // stays mounted and owns the screen the whole time the overlay is up, so
  // nothing destructive belongs on this branch — no stopping timers, no
  // dropping the socket. Teardown is SYSTEM_EXIT_EVENT / ABNORMAL_EXIT_EVENT
  // at the bottom of this handler, and that has not changed.
  if (
    sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
    sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT
  ) {
    console.log(
      `[menu] overlay ${sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT ? 'opened' : 'closed'} over ${pageMode}`,
    )
    return
  }

  // THE TELEPROMPTER OWNS SWIPES ON ITS OWN PAGE.
  //
  // Placed here - after the double-tap branch, before the list-scroll branch
  // - so that double tap still leaves the page and so that a list page is
  // unaffected.
  //
  // The mapping was measured on the glasses: swipe FORWARD on the
  // right temple reported textEvent 2 (SCROLL_BOTTOM_EVENT) and swipe
  // BACKWARD reported textEvent 1 (SCROLL_TOP_EVENT). If forward turns out
  // to move the script backwards on the lens, swap these two and nothing
  // else needs to change.
  //
  // sysType and listType are checked as well as textType because the page is
  // built from text containers but nothing documents which envelope the
  // firmware uses on a page with five of them rather than one.
  if (pageMode === 'teleprompt') {
    if (
      textType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      sysType === OsEventTypeList.SCROLL_BOTTOM_EVENT ||
      listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
    ) {
      void moveTeleprompt(1)
      return
    }
    if (
      textType === OsEventTypeList.SCROLL_TOP_EVENT ||
      sysType === OsEventTypeList.SCROLL_TOP_EVENT ||
      listType === OsEventTypeList.SCROLL_TOP_EVENT
    ) {
      void moveTeleprompt(-1)
      return
    }
    // A single tap does NOTHING here yet, deliberately. It is the obvious
    // home for play/pause once Auto mode exists; wiring it to something else
    // now would only have to be unwired then.
  }

  // Scrolling is handled by the OS - the list moves itself and reports
  // afterwards. Logged only, so the selected index is visible while
  // tuning itemCount. Deliberately does NOT rebuild the page: doing so
  // would fight the OS for control of the selection.
  if (
    listType === OsEventTypeList.SCROLL_TOP_EVENT ||
    listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  ) {
    // RAW index here, deliberately - not selectIndexOf(). Anything that
    // ACTS on a selection goes through the helper; a diagnostic wants to
    // show what the wire actually carried, and silently printing 0 where
    // the field was absent would hide the exact thing this log is for.
    console.log(
      `[${pageMode}] scroll ${listType === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : 'down'} ->`,
      event.listEvent?.currentSelectItemIndex,
      event.listEvent?.currentSelectItemName,
    )
    return
  }

  if (
    sysType === OsEventTypeList.CLICK_EVENT ||
    textType === OsEventTypeList.CLICK_EVENT ||
    listType === OsEventTypeList.CLICK_EVENT
  ) {
    // While the assistant box is up it owns the taps: dismiss it and hand
    // the lens back, rather than toggling the mic underneath it.
    if (assistant !== null) {
      stt?.dismiss()
      return
    }

    if (pageMode === 'list') {
      if (lastNoteIds) {
        // The NOTES list. One tap ticks the selected note off, and that
        // is the only action this page has - deleting is the phone's job,
        // deliberately, because nothing on the lens can undo it.
        void completeNoteAt(
          selectIndexOf(event.listEvent),
          event.listEvent?.currentSelectItemName,
        )
      } else {
        // Any other list - Plex, a Sparky card - carries no ids and has
        // nothing to select. Logged so the index is visible; double tap
        // is how you leave.
        console.log(
          '[list] select ->',
          event.listEvent?.currentSelectItemIndex,
          event.listEvent?.currentSelectItemName,
        )
      }
    } else if (pageMode === 'translate') {
      // A single tap does NOTHING here, deliberately.
      //
      // The obvious candidates are both wrong: toggling the mic would stop
      // the conversation being translated with no visible sign of why, and
      // clearing the line early would take away the thing the person
      // opposite is reading. Double tap ends the mode, which is the only
      // action this page has.
      console.log('[translate] tap ignored — double-tap to end')
    } else if (pageMode === 'teleprompt') {
      // A single tap does NOTHING here, deliberately - the measurement that
      // borrowed this gesture has served its purpose and is gone.
      //
      // The branch still has to exist: the final `else` below is caption
      // mode and calls toggleMic(), so without it a tap while reading a
      // script would silently pause capture.
      //
      // This is the obvious home for play/pause once Auto mode exists.
      console.log('[teleprompt] tap ignored - swipe to move, double-tap to leave')
    } else if (pageMode === 'home') {
      // The home page shows nothing, so there is nothing on it to act on.
      //
      // This used to open the menu; the menu is now an OS overlay on tap then
      // long press, from any page including this one. Leaving the tap dead
      // would make a blank page indistinguishable from a hung one, so it goes
      // to captions — the page this app is for, and the one the old menu's
      // first item opened.
      //
      // NOT toggleMic(): the mic state is invisible from here, so a tap that
      // silently paused capture would be discoverable only by its
      // consequences.
      void showCaptions()
    } else {
      // Caption mode: tap is the primary action, and the primary action
      // here is pausing capture.
      toggleMic()
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)