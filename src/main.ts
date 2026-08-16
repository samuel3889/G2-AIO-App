import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSttStream } from './asr/stt'
import { mountUi, setStatus, setTranscript } from './ui'
import { mountSettings } from './settings'
import { showPlexPage, showTranscriptPage } from './plex'

mountSettings()
mountUi()

const API_KEY = import.meta.env.VITE_STT_API_KEY as string
if (!API_KEY) {
  setStatus('error', 'VITE_STT_API_KEY not set — copy .env.example to .env.local')
  console.warn('VITE_STT_API_KEY is not set.')
}

const bridge = await waitForEvenAppBridge()

const transcript = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'transcript',
  content: 'Listening…',
  isEventCapture: 1,
})

const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [transcript] }),
)
if (created !== 0) {
  setStatus('error', `createStartUpPageContainer failed: ${created}`)
  console.error('Failed to create startup page')
}

let lastRender = ''
let renderTimer: number | null = null
let currentContent = 'Listening…'

// Which page is on the lens. In 'plex' mode the transcript container does
// not exist, so textContainerUpgrade would target a container that is not
// on the page - every caption render must be suppressed until we rebuild.
type PageMode = 'transcript' | 'plex'
let pageMode: PageMode = 'transcript'

function scheduleGlassesRender() {
  if (pageMode !== 'transcript') return
  if (renderTimer !== null) return
  renderTimer = window.setTimeout(async () => {
    renderTimer = null
    // Re-check: the list may have taken over during the 120ms debounce.
    if (pageMode !== 'transcript') return
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
      setStatus(micOn ? 'listening' : 'paused', 'Plex · scroll to browse · tap to close')
    },
  )
} catch (err) {
  setStatus('error', (err as Error)?.message ?? 'STT startup failed')
  console.error('STT startup failed:', err)
}

let micOn = false
if (stt) {
  await bridge.audioControl(true)
  micOn = true
  setStatus('listening', 'Microphone live · tap to pause · double-tap to exit')
}

// Tap toggles capture. `audioControl(false)` stops the host pushing PCM, so no
// further frames reach `sendPcm`; the STT client itself is left open. If your
// provider closes an idle stream, tear it down here and reopen it on resume.
// No-ops until stt.ts is wired up — there is no capture to pause.
/**
 * Leave the Plex list and rebuild the caption page.
 *
 * Only one container per page may capture events, and in list mode that is
 * the list - so tap cannot mean "pause mic" while Plex is up. Tap closes
 * the list instead; mic control returns with the transcript page.
 */
async function exitPlex() {
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
  setStatus(
    micOn ? 'listening' : 'paused',
    micOn ? 'Microphone live · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
  )
}

function toggleMic() {
  if (!stt) return
  micOn = !micOn
  bridge.audioControl(micOn)
  currentContent = micOn ? 'Listening…' : 'Paused'
  scheduleGlassesRender()
  setStatus(
    micOn ? 'listening' : 'paused',
    micOn ? 'Microphone live · tap to pause · double-tap to exit' : 'Paused · tap to resume · double-tap to exit',
  )
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridge.audioControl(false)
  stt?.close()
  unsubscribe()
}

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all — and in this template
// that means every incoming audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing, critical details:
//   • Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Audio PCM frames come through `event.audioEvent` — separate branch.
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app. System exit confirmation dialog appears;
//     SYSTEM_EXIT_EVENT fires on confirm and we clean up there.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) stt?.sendPcm(pcm)

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  // In Plex mode the LIST holds isEventCapture, so taps and scrolls arrive
  // as listEvent rather than textEvent.
  const listType = eventTypeOf(event.listEvent)

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    bridge.shutDownPageContainer(1)
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
      `[plex] scroll ${listType === OsEventTypeList.SCROLL_TOP_EVENT ? 'up' : 'down'} ->`,
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
    // Tap means "close the list" in Plex mode, "pause mic" in caption mode.
    if (pageMode === 'plex') void exitPlex()
    else toggleMic()
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    cleanup()
  }
})

window.addEventListener('beforeunload', cleanup)