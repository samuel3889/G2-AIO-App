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
import { showMenuPage, MENU_ACTIONS, menuLabels, type MenuAction } from './menu'
import { mountSessions, setLiveSession, refreshSessions } from './sessions'
import {
  mountTranslate,
  setTranslateState,
  pushTranslation,
  lastPair,
} from './translate'
import { showTranslatePage, readMs, type LensTranslation } from './translatepage'
import { mountTabs } from './tabs'
import { mountReview } from './review'
import { mountPrompts } from './prompts'
import {
  statusContainers,
  setDeviceStatus,
  setGlassesSn,
  startStatusUpdates,
  setStripOnPage,
} from './statusbar'
import {
  onTimerExpired,
  startTimer,
  cancelTimer,
  type TimerState,
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
const tabs = mountTabs(['Live', 'Conversations', 'Translate'])

// The full tuning panel, minus anything that belongs beside its own feature.
// translate_hold_s is mounted on the Translate tab instead, further down.
void mountSettings(tabs.Live, { omit: ['translate_hold_s'] })
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

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: startupText.length,
    textObject: startupText,
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
 * runMenuSelection() calls toggleSession() and then showCaptions()
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

// Which page is on the lens. In 'home', 'list' and 'menu' modes the
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
type PageMode = 'home' | 'transcript' | 'list' | 'menu' | 'alert' | 'translate'
let pageMode: PageMode = 'home'

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
 * 'alert' can never be stored here. showTimerAlert() refuses to open a
 * second box over the first, so the value written is always a real page.
 */
let alertReturnTo: PageMode = 'home'

/**
 * Closes the alert box when its time is up. Null when no box is on screen.
 *
 * Doubles as THE FLAG for "an alert is up": pageMode === 'alert' says the
 * same thing, but this is what a tap has to clear, so the two are set and
 * cleared together in showTimerAlert() and closeTimerAlert().
 */
let alertTimer: number | null = null

/**
 * The assistant exchange the alert box interrupted, or null.
 *
 * Distinct from `assistant`, which keeps tracking the LIVE exchange while
 * the box is up — a phase change or a dismissal can still arrive from the
 * gateway during those seconds. This is the record that there was something
 * to go back TO, so closeTimerAlert() can tell "the box interrupted an
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
    return `${rec}Home · tap for menu`
  }
  if (pageMode === 'alert') return 'Timer finished · tap to dismiss'
  if (pageMode === 'menu') return 'Menu · scroll · tap to select · double-tap to go back'
  if (pageMode === 'list') {
    // Title comes from the header line the gateway sent, so the hint names
    // whatever is actually on the lens rather than one hardcoded source.
    const title = lastListLines?.[0] ?? 'List'
    return `${title} · scroll to browse · double-tap to go back`
  }
  const rec = sessionActive ? `Recording (${sessionUtterances}) · ` : ''
  const mic = micOn ? 'Microphone live' : 'Paused'
  return `${rec}${mic} · tap to ${micOn ? 'pause' : 'resume'} · double-tap for menu`
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
    async lines => {
      // Kept so restoreFromAssistant() can rebuild this exact list. The page
      // is a rebuild like any other and the SDK gives no way to read a
      // container's contents back, so the only copy of what was on the lens
      // is the one we keep here.
      lastListLines = lines
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
      const ok = await showListPage(bridge, lines)
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
            // restoreFromAssistant(); alertReturnTo by closeTimerAlert().
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
          // slot is what makes closeTimerAlert() fall through to
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

if (stt) {
  await bridge.audioControl(true)
  micOn = true
  refreshStatus()
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
  const body = boxes[0]?.content ?? ''
  console.log(`[assist] ${s.phase} content=${JSON.stringify(body)}`)

  // The strip goes on this page too. Note this ALSO changes the overlay from
  // a one-container page to a three-container one — which is the exact
  // variable the last overlay probe was left waiting on.
  const text = [...boxes, ...statusContainers()]

  const ok = await bridge.rebuildPageContainer(
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
  let upgraded = false
  if (ok) {
    upgraded = await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: boxes[0]?.containerID ?? OVERLAY_Q_ID,
        containerName: boxes[0]?.containerName ?? OVERLAY_NAME,
        content: body,
      }),
    )
  }

  console.log(`[assist] ${s.phase} rebuild=${ok} upgrade=${upgraded}`)

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
    bridge,
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
  // at session start, not an edge case: runMenuSelection() calls
  // toggleSession() and then showCaptions() immediately, and startSession()
  // only SENDS the command - the gateway's confirming 'session' frame
  // arrives during this rebuild, too late for the page and too early for the
  // onSession handler to act on (pageMode was still 'menu').
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
async function showHome() {
  console.log(`[page] home (from ${pageMode})`)
  const ok = await showHomePage(bridge)
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
    case 'menu':
      await showMenu()
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
        const ok = await showListPage(bridge, lastListLines)
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
 * Put the expired timer's title on the lens, full screen, and set the clock
 * that takes it away again.
 *
 * THE ALERT SUSPENDS AN ASSISTANT EXCHANGE, IT DOES NOT END ONE.
 *
 * The first cut nulled `assistant` and called stt.dismiss(), which sends
 * 'endconvo' — so a timer going off mid-answer threw away the follow-up
 * window, the held history and the answer itself. "Take the lens" and "end
 * the conversation" are two different things and that collapsed them.
 *
 * So nothing is torn down. `assistant` keeps its state, the exchange is
 * remembered in alertResumeAssistant, and closeTimerAlert() rebuilds the box
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
async function showTimerAlert(t: TimerState) {
  // A second timer cannot exist (timer.ts holds one), but an expiry landing
  // while a box is already up would otherwise overwrite alertReturnTo with
  // 'alert' and strand the lens there.
  if (pageMode === 'alert') {
    console.warn(`[timer] alert already up, ignoring ${t.id}`)
    return
  }

  if (assistant !== null) {
    // Where to go if the exchange dies during the alert: the page it was
    // launched from, never 'transcript', which is only what pageMode is set
    // to for the duration of a box.
    alertReturnTo = assistantReturnTo
    alertResumeAssistant = assistant
    console.log('[timer] alert suspending assistant box')
  } else {
    alertReturnTo = pageMode
    alertResumeAssistant = null
  }

  console.log(
    `[timer] alert "${t.title}" for ${t.alertS}s (returning to ${alertReturnTo})`,
  )

  const ok = await showAlertPage(bridge, t.title)
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
  // alertS is frozen per-timer in timer.ts, so a slider moved while this one
  // was counting down does not change the alert it was set with.
  alertTimer = window.setTimeout(() => {
    alertTimer = null
    void closeTimerAlert('elapsed')
  }, t.alertS * 1000)
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
async function closeTimerAlert(reason: string) {
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
    console.log(`[timer] alert closed (${reason}) -> resuming assistant box`)
    // pageMode and refreshStatus() are onAssistant's job on the normal path,
    // so they have to be done by hand here.
    pageMode = 'transcript'
    await renderAssistant(assistant)
    refreshStatus()
    return
  }

  console.log(`[timer] alert closed (${reason}) -> ${alertReturnTo}`)
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
  void showTimerAlert(t)
})

/**
 * Draw the translate page: either a line, or the idle header.
 *
 * Every path that puts translate mode on the lens comes through here, so
 * pageMode and the stale-render bookkeeping are done in ONE place rather
 * than at each call site.
 */
async function showTranslate() {
  const ok = await showTranslatePage(bridge, lensLine ?? {
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
  // showHome() and showTimerAlert() clear these.
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
 * ONE builder, used by both showMenu() and runMenuSelection(). They have to
 * agree: the selection maps an INDEX back to an action by matching the label
 * the OS reported against menuLabels(), so a state that differed between the
 * two would map a tap to the wrong item.
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

/** Rebuild the menu page. Reads current state for its labels and header. */
async function showMenu() {
  const ok = await showMenuPage(bridge, menuState())
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (menu)')
    console.error('Failed to build menu page')
    return
  }
  pageMode = 'menu'
  refreshStatus()
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
 * Map a menu tap to an action.
 *
 * currentSelectItemIndex is a protobuf int32, so index 0 arrives as
 * `undefined` for exactly the same reason CLICK_EVENT does — `?? 0` is
 * load-bearing, not defensive padding. The item NAME is cross-checked
 * against the labels we built, because a name is a non-zero-value field
 * and therefore survives the wire intact.
 */
async function runMenuSelection(index: number | undefined, name: string | undefined) {
  const labels = menuLabels(menuState())
  let i = index ?? 0
  if (name) {
    const byName = labels.indexOf(name)
    if (byName >= 0) i = byName
  }

  const action: MenuAction | undefined = MENU_ACTIONS[i]
  console.log(`[menu] select index=${index} name=${name} -> ${action}`)

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
    case 'session':
      toggleSession()
      // Leave the menu so the user sees captions and the recording flag
      // rather than a stale menu header.
      await showCaptions()
      break
    case 'mic':
      toggleMic()
      // Rebuild so the label flips to its opposite.
      await showMenu()
      break
    case 'exit':
      // The only place in this app that shuts the container down. Long
      // press is the normal route and never reaches us; this is the
      // fallback if that gesture is unavailable. exitMode 1 shows the OS
      // confirmation layer, and SYSTEM_EXIT_EVENT arrives on confirm.
      await bridge.shutDownPageContainer(1)
      break
    default:
      await showCaptions()
  }
}

/** Double tap. Back, per platform convention — never a shutdown. */
async function goBack() {
  // Back out of the assistant box first — it is the topmost thing on screen.
  if (assistant !== null) {
    stt?.dismiss()
    return
  }
  // Home is the ROOT now, and the hierarchy is home -> menu -> everything
  // else. So "back" from a feature page goes to the menu's parent, home —
  // never to captions, which is one of the things the menu launches rather
  // than the page underneath it.
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
  if (pageMode === 'home') {
    // Nothing above home. The only useful thing a gesture can do here is open
    // the menu, and both gestures do it rather than one of them being dead.
    await showMenu()
  } else if (pageMode === 'transcript') {
    await showMenu()
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

// Event routing.
//
// Gestures, per platform convention:
//   single tap -> select
//   double tap -> back
//   long press -> shut down, consumed by the OS. There is NO long-press
//                 value in OsEventTypeList, so it never arrives here; we
//                 only see the aftermath as SYSTEM_EXIT_EVENT.
//
// Check DOUBLE_CLICK_EVENT before CLICK_EVENT: a double tap may also
// deliver a click envelope, and back must win over select.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

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
      void closeTimerAlert('tapped')
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

  // Scrolling is handled by the OS - the list moves itself and reports
  // afterwards. Logged only, so the selected index is visible while
  // tuning itemCount. Deliberately does NOT rebuild the page: doing so
  // would fight the OS for control of the selection.
  if (
    listType === OsEventTypeList.SCROLL_TOP_EVENT ||
    listType === OsEventTypeList.SCROLL_BOTTOM_EVENT
  ) {
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

    if (pageMode === 'menu') {
      void runMenuSelection(
        event.listEvent?.currentSelectItemIndex,
        event.listEvent?.currentSelectItemName,
      )
    } else if (pageMode === 'list') {
      // Nothing to select in a read-only list. Logged so the index is
      // visible; double tap is how you leave.
      console.log(
        '[list] select ->',
        event.listEvent?.currentSelectItemIndex,
        event.listEvent?.currentSelectItemName,
      )
    } else if (pageMode === 'translate') {
      // A single tap does NOTHING here, deliberately.
      //
      // The obvious candidates are both wrong: toggling the mic would stop
      // the conversation being translated with no visible sign of why, and
      // clearing the line early would take away the thing the person
      // opposite is reading. Double tap ends the mode, which is the only
      // action this page has.
      console.log('[translate] tap ignored — double-tap to end')
    } else if (pageMode === 'home') {
      // The home page shows nothing, so there is nothing on it to act on.
      // Tap opens the menu — the same thing double tap does, because a blank
      // page with one dead gesture is indistinguishable from a hung one.
      //
      // NOT toggleMic(): the mic state is invisible from here, so a tap that
      // silently paused capture would be discoverable only by its
      // consequences.
      void showMenu()
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