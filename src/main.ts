import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSttStream, type SessionState, type AssistantState } from './asr/stt'
import { mountUi, setStatus, setTranscript } from './ui'
import { mountSettings } from './settings'
import { showPlexPage, showTranscriptPage } from './plex'
import { assistantBox, OVERLAY_Q_ID, OVERLAY_NAME } from './overlay'
import { RebuildPageContainer } from '@evenrealities/even_hub_sdk'
import { showMenuPage, MENU_ACTIONS, menuLabels, type MenuAction } from './menu'
import { mountSessions, setLiveSession, refreshSessions } from './sessions'
import { mountTabs } from './tabs'
import { mountReview } from './review'
import {
  statusContainers,
  setDeviceStatus,
  setGlassesSn,
  startStatusUpdates,
  STATUS_H,
} from './statusbar'

// Phone UI: one tab bar, three hosts. Every panel is mounted ONCE, here at
// startup, and only shown/hidden afterwards — mountSessions() registers
// callbacks that setLiveSession() drives, so remounting on tab switch would
// leave those writing into detached DOM.
//
// mountUi() still owns #app and is NOT moved into a host: it replaces #app's
// innerHTML wholesale, which would destroy anything mounted inside it.
const tabs = mountTabs(['Live', 'Conversations', 'Review'])

void mountSettings(tabs.Live)
mountUi()
mountReview(tabs.Review)

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

const transcript = new TextContainerProperty({
  xPosition: 0,
  // Pushed down by the status strip. Overlapping containers would depend on
  // z-order behaviour that is still unverified in this app, so the strip gets
  // its own reserved band instead.
  yPosition: STATUS_H,
  width: 576,
  height: 288 - STATUS_H,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'transcript',
  content: 'Listening…',
  // Exactly one container per page may capture events; the status containers
  // are both 0, so this stays 1.
  isEventCapture: 1,
  // Backmost. zOrderIndex is ALL-OR-NOTHING per page, and the status
  // containers set 10 and 11, so this one must be set too.
  zOrderIndex: 0,
})

const startupText = [transcript, ...statusContainers()]

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

let lastRender = ''
let renderTimer: number | null = null
let currentContent = 'Listening…'

// Which page is on the lens. In 'plex' and 'menu' modes the transcript
// container does not exist, so textContainerUpgrade would target a
// container that is not on the page — every caption render must be
// suppressed until we rebuild.
type PageMode = 'transcript' | 'plex' | 'menu'
let pageMode: PageMode = 'transcript'

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

function scheduleGlassesRender() {
  if (pageMode !== 'transcript') return
  if (assistant !== null) return
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    // Re-check: a list may have taken over during the 120ms debounce.
    if (pageMode !== 'transcript') return
    if (assistant !== null) return
    if (currentContent === lastRender) return
    lastRender = currentContent
    await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'transcript',
        content: currentContent,
      }),
    )
  }, 120) // debounce display writes — BLE render queue is slow
}

// Phone status line. One place, because it now has to account for three
// page modes and a recording flag.
function hint(): string {
  if (pageMode === 'menu') return 'Menu · scroll · tap to select · double-tap to go back'
  if (pageMode === 'plex') return 'Plex · scroll to browse · double-tap to go back'
  const rec = sessionActive ? `Recording (${sessionUtterances}) · ` : ''
  const mic = micOn ? 'Microphone live' : 'Paused'
  return `${rec}${mic} · tap to ${micOn ? 'pause' : 'resume'} · double-tap for menu`
}

function refreshStatus() {
  setStatus(sessionActive || micOn ? 'listening' : 'paused', hint())
}

// The default stt.ts is a blank stub that throws. Catch the throw so the UI
// surfaces the "configure stt.ts" error chip instead of hanging on "Connecting…".
let stt: ReturnType<typeof startSttStream> | null = null
try {
  stt = startSttStream(
    API_KEY,
    ({ finalText, interimText }) => {
      const combined = (finalText + interimText).trim()
      // 240 chars is a rough fit for the 576x288 text container at default font.
      currentContent = combined ? combined.slice(-240) : 'Listening…'
      setTranscript(finalText, interimText)
      scheduleGlassesRender()
    },
    err => {
      setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      console.error('STT error:', err)
    },
    // Structured answer (Plex activity): render as a scrollable OS list.
    async lines => {
      const ok = await showPlexPage(bridge, lines)
      if (!ok) {
        // rebuildPageContainer returns boolean, NOT the numeric result code
        // createStartUpPageContainer gives - `!ok`, not `!== 0`.
        setStatus('error', 'rebuildPageContainer failed (plex)')
        console.error('Failed to build plex page')
        return
      }
      pageMode = 'plex'
      refreshStatus()
    },
    {
      onSession: (s: SessionState) => {
        sessionActive = s.active
        sessionUtterances = s.utterances
        setLiveSession(s)

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
      onSummary: (id, _text) => {
        console.log(`[app] summary ready for ${id}`)
        void refreshSessions()
      },
      onAssistant: (s: AssistantState | null) => {
        // `dismiss()` in stt.ts fires this hook unconditionally, and
        // showCaptions() below calls dismiss() — so handling a null when
        // there is already no assistant re-enters showCaptions forever.
        // That loop repaints the caption page continuously, which is what
        // wiped the menu and the Plex list a few ms after they rendered.
        // A null when nothing is up means there is nothing to hand back.
        if (s === null && assistant === null) return

        assistant = s
        if (s) {
          // The overlay REPLACES whatever page was up, including a list.
          // pageMode records where captions resume from when it clears.
          pageMode = 'transcript'
          void renderAssistant(s)
        } else {
          void showCaptions()
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
  let up: boolean | string = 'skipped'
  if (ok) {
    up = await bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        // Read off the container that was just built, rather than from the
        // constants: the probes in overlay.ts can change the ID or name, and
        // an upgrade aimed at a container that is not on the page does
        // nothing at all — silently.
        containerID: boxes[0]?.containerID ?? OVERLAY_Q_ID,
        containerName: boxes[0]?.containerName ?? OVERLAY_NAME,
        content: body,
      }),
    )
  }

  // DIAGNOSTIC — the two return values we have never actually seen.
  //
  // Both of these calls return a boolean, and every conclusion in this
  // debugging session has ASSUMED both were true. This reports them to the
  // PHONE status line rather than the console, because that needs no tooling:
  // read it off the phone screen while the box is on the lens.
  setStatus(
    'listening',
    `DBG ${s.phase} rebuild=${ok} upgrade=${up} id=${boxes[0]?.containerID}` +
      ` name=${boxes[0]?.containerName} len=${body.length}`,
  )
  console.log(`[assist] rebuild=${ok} upgrade=${up}`)

  if (!ok) {
    // A z-order violation fails HERE, client-side, without ever reaching the
    // glasses — the SDK logs `[EvenHub:MISSING_Z_ORDER_INDEX]` or similar to
    // the console and returns false.
    console.error('Failed to build assistant overlay')
    return
  }

  // The transcript container is not on the page at all now, so the debounced
  // renderer's idea of what is on the lens is stale.
  lastRender = ''
}

/** Rebuild the caption page and hand the display back to the transcript. */
async function showCaptions() {
  // Diagnostic: if this repeats without a gesture, a page-rebuild loop is
  // running and it is what is wiping the menu and the Plex list.
  console.log(`[page] captions (from ${pageMode})`)
  const ok = await showTranscriptPage(bridge, currentContent)
  if (!ok) {
    setStatus('error', 'rebuildPageContainer failed (transcript)')
    console.error('Failed to rebuild transcript page')
    return
  }
  pageMode = 'transcript'
  // Force the next render through: the container was just recreated, so
  // whatever lastRender holds no longer reflects what is on the lens.
  lastRender = ''
  stt?.dismiss()
  refreshStatus()
}

/** Rebuild the menu page. Reads current state for its labels and header. */
async function showMenu() {
  const ok = await showMenuPage(bridge, {
    sessionActive,
    micOn,
    utterances: sessionUtterances,
  })
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
  currentContent = micOn ? 'Listening…' : 'Paused'
  scheduleGlassesRender()
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
  currentContent = 'Listening…'

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
  const labels = menuLabels({ sessionActive, micOn, utterances: sessionUtterances })
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
  if (pageMode === 'transcript') {
    // Captions is the launch page, so "back" from here goes up to the menu.
    await showMenu()
  } else {
    await showCaptions()
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
  // In list modes (plex, menu) the LIST holds isEventCapture, so taps and
  // scrolls arrive as listEvent rather than textEvent.
  const listType = eventTypeOf(event.listEvent)

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
    } else if (pageMode === 'plex') {
      // Nothing to select in a read-only list. Logged so the index is
      // visible; double tap is how you leave.
      console.log(
        '[plex] select ->',
        event.listEvent?.currentSelectItemIndex,
        event.listEvent?.currentSelectItemName,
      )
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