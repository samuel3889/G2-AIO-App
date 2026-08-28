/**
 * Gateway STT client - drop-in replacement for the ASR template's stub.
 *
 * Streams glasses mic PCM to your Unraid gateway over a WebSocket and
 * returns transcripts.
 *
 * Wire format out: raw 16 kHz mono s16le PCM binary frames, plus JSON
 *                  control frames {cmd:"flush"|"reset"|"endconvo"|
 *                  "session_start"|"session_stop"|"session_status"|
 *                  "translate_start"|"translate_stop"|"translate_status"}.
 * Wire format in:  JSON - {type:"ready"|"speech"|"partial"|"final"|"wake"|
 *                          "question"|"thinking"|"answer"|"convo"|
 *                          "session"|"summary"|"timer"|"translate"|
 *                          "translation"|"error", ...}
 *
 * Env (in .env.local):
 *   VITE_GATEWAY_URL=wss://g2gateway.sams-server.duckdns.org:50443/ws/stt
 *   VITE_STT_API_KEY=<the AUTH_TOKEN from your compose .env>
 */

export interface SessionState {
  active: boolean
  id: string | null
  utterances: number
  /** Only present on the frame sent when a session stops. */
  summarizing?: boolean
}

/**
 * Translate MODE state, from {"type":"translate"}.
 *
 * `a` is the LEFT language and `b` the RIGHT one. The order is load bearing
 * and is the ONLY thing that decides which direction reaches the lens - see
 * TranslationLine.lens. Swapping them is how the wearer reverses it.
 *
 * Both are null when inactive, rather than retaining the last pair. The
 * gateway holds this per WebSocket, so a reconnect genuinely comes back with
 * translation off, and a remembered pair here would misrepresent that.
 */
export interface TranslateState {
  active: boolean
  a: string | null
  b: string | null
  /** Display names, e.g. "Español". Null when inactive. */
  aNative: string | null
  bNative: string | null
  /** Only present when a translate_start was rejected. */
  error?: string
}

/**
 * One translated utterance, from {"type":"translation"}.
 *
 * NOT a caption. This never touches `finalText` and never reaches
 * onResult() - a translation is machine text about what someone said, and
 * putting it in the caption buffer would make it indistinguishable from
 * the transcript, exactly as the 'suggest' frame must not.
 *
 * `translated` is false when the gateway detected a language outside the
 * pair. In that case only `sourceText` and `detected` are meaningful and
 * everything else is undefined: there is nothing to show but what was heard.
 * The phone should grey the line rather than hide it, so a third language in
 * the room reads as "ignored" and not as "the glasses stopped working".
 *
 * `lens` is decided by the GATEWAY, not here. The list and the lens are drawn
 * from this one frame, and a client that re-derived the direction itself
 * could disagree with the server after a pair swap only one of them had
 * processed.
 */
export interface TranslationLine {
  seq: number
  translated: boolean
  /** What was actually said, in the language it was said in. */
  sourceText: string
  /** The translation. Empty when translated is false. */
  text: string
  /** Our language codes, e.g. "es". Empty when translated is false. */
  from: string
  to: string
  /** Display names for the two above. */
  fromNative: string
  toNative: string
  /** The raw code Whisper reported, which may be outside the pair. */
  detected: string | null
  /** True when this line is the one the lens should show. */
  lens: boolean
  /** How long the lens should hold it. Undefined = client default. */
  holdMs?: number
  sttMs: number
  translateMs: number
}

export interface SttHandle {
  sendPcm(pcm: unknown): void
  close(): void
  /**
   * Drop any answer currently owning the lens and resume captions.
   *
   * The Plex list has no auto-dismiss timer - the user may be reading it -
   * so main.ts calls this when they tap to leave.
   */
  dismiss(): void
  /** Begin recording a conversation. Idempotent on the gateway side. */
  startSession(title?: string): void
  /** Stop recording; the gateway saves and then summarises in background. */
  stopSession(): void
  /** Ask the gateway to restate session state (used after a reconnect). */
  sessionStatus(): void
  /**
   * Empty the lens caption buffer.
   *
   * Called when a new recording starts: the lens should show the new
   * conversation, not the tail of whatever was said before it. The gateway
   * keeps the authoritative transcript, so nothing is lost by clearing here.
   */
  clearTranscript(): void
  /**
   * Enter translate mode with a language pair.
   *
   * `a` is the LEFT language and `b` the RIGHT one, as our internal codes
   * ("en", "es", "ru", "ja"). The gateway validates the pair and answers
   * with a 'translate' frame either way - it does NOT silently accept a
   * language it cannot handle, so onTranslate() is where the result of this
   * call shows up, not the return value.
   *
   * While translate mode is on, the wake word and the assistant are
   * bypassed server-side. Calling this does not stop a recording; the two
   * are independent, exactly as sessions and conversations are.
   */
  startTranslate(a: string, b: string): void
  /** Leave translate mode. Captions and the wake word resume. */
  stopTranslate(): void
  /** Ask the gateway to restate translate mode (used after a reconnect). */
  translateStatus(): void
}

export interface SttResult {
  finalText: string
  interimText: string
}

/**
 * The assistant exchange, as structured data rather than one blob of text.
 *
 * main.ts needs the question and the answer SEPARATELY even though overlay.ts
 * now draws them in ONE growing box: it decides the spacing between them and
 * clamps the answer to fit the lens. Collapsing them into a single string
 * here would take that decision away from the module that owns the layout.
 */
export interface AssistantState {
  phase: 'listening' | 'question' | 'thinking' | 'answer'
  question: string
  answer: string
}

export interface SttHooks {
  /** Recording started/stopped/counted. */
  onSession?: (s: SessionState) => void
  /**
   * The in-progress utterance changed.
   *
   * Fires for {"type":"partial"} and for the "someone is talking"
   * placeholder on {"type":"speech", active:true}. Carries NO seq, because
   * the gateway's partial frame does not have one (gateway.py:3586) - the
   * partial is always the newest utterance, so it does not need one.
   */
  onPartial?: (text: string) => void
  /**
   * An utterance finished, with the seq the gateway assigned it.
   *
   * This is the SAME utterance the last onPartial described, and the text
   * can differ from it: Whisper re-decodes the whole buffer with more
   * context and changes its mind. Treat it as a replacement, not an append.
   */
  onUtterance?: (seq: number, text: string) => void
  /**
   * Who said utterance `seq`, or null for "scored, but not confidently
   * anyone".
   *
   * ALWAYS ARRIVES AFTER the onUtterance for the same seq, by a few hundred
   * ms: gateway.py sends the 'final' frame and only then spawns
   * run_speaker() to embed and score the audio (gateway.py:3486-3496). A
   * consumer therefore has to be able to fill a name in after the fact.
   *
   * Utterances under `speaker_min_ms` return before the embed
   * (gateway.py:3180-3184) and never produce this frame at all, so short
   * backchannels stay unnamed permanently. That is correct, not a gap.
   */
  onSpeaker?: (seq: number, name: string | null) => void
  /** Summary finished, some seconds after stopSession(). */
  onSummary?: (id: string, text: string) => void
  /**
   * Assistant exchange changed, or null when it is dismissed and the lens
   * goes back to captions.
   */
  onAssistant?: (s: AssistantState | null) => void
  /**
   * A proactive suggestion for the band, from {"type":"suggest"}.
   *
   * `tag` is one of ANSWER / CHECK / ASK / TERM - the gateway validates it
   * and DROPS anything else before sending (gateway.py:3801), so a frame
   * that arrives here always carries one of the four and a non-empty text.
   *
   * NOT related to onAssistant. This is unsolicited: nobody said a wake
   * word, nothing is armed, and no follow-up window opens. It must never be
   * routed through showOverlay() or onResult() - that is the assistant's
   * path and it feeds the caption buffer, which would put machine text into
   * the transcript as though a person had said it.
   *
   * Only fires when the gateway has SUGGEST_MODE=on. In `shadow` the
   * suggestion is generated and logged server-side but no frame is sent
   * (gateway.py:3832).
   *
   * `holdMs` is how long this suggestion should stay on the lens, taken
   * from the frame's `hold_ms` field, which the gateway derives from the
   * `suggest_hold_s` tunable at send time. It is OPTIONAL because a gateway
   * older than that tunable sends no such field; main.ts falls back to
   * SUGGEST_HOLD_DEFAULT_MS in that case via resolveHoldMs().
   *
   * The value rides on each frame rather than being fetched once, so moving
   * the slider on the phone applies to the next suggestion without a
   * WebView reload.
   */
  onSuggest?: (tag: string, text: string, holdMs?: number) => void
  /**
   * A timer command from the gateway, from {"type":"timer"}.
   *
   * NOT part of the assistant exchange, even though it is always caused by
   * one. The gateway sends this frame and then an ordinary 'answer' frame
   * carrying the confirmation, so the box the wake word opened resolves and
   * dismisses itself on ANSWER_HOLD_MS like any other reply. This hook is
   * only the COMMAND half.
   *
   * Deliberately not routed through onResult() or showOverlay(), for the
   * same reason 'suggest' is not: those feed the caption buffer, and a
   * confirmation that went that way would be indistinguishable from
   * something a person in the room said.
   *
   * NOT gated on `overlay`. The countdown lives in the status strip, which
   * is on every page including the assistant box, so there is no page state
   * that makes this write pointless — unlike a suggestion, which main.ts has
   * to hold and bake into a later rebuild.
   */
  onTimer?: (cmd: TimerCommand) => void
  /**
   * Translate mode turned on or off, or a start was rejected.
   *
   * Fires on every translate_start, translate_stop and translate_status,
   * and on reconnect via the translate_status this module sends itself. The
   * frame always carries the WHOLE state rather than a delta, so a consumer
   * that missed one recovers on the next instead of reconciling.
   */
  onTranslate?: (s: TranslateState) => void
  /**
   * One utterance was translated, from {"type":"translation"}.
   *
   * Deliberately NOT routed through onResult() or showOverlay(), for the
   * same reason 'suggest' is not: those feed the caption buffer, and a
   * translation that went that way would be recorded as though a person in
   * the room had said it in that language.
   *
   * Fires for out-of-pair detections too, with `translated` false. Filtering
   * those out is the consumer's decision, not this module's.
   */
  onTranslation?: (line: TranslationLine) => void
}

/**
 * The command half of a {"type":"timer"} frame.
 *
 * `durationS` is a DURATION, never a deadline, and that is deliberate on the
 * gateway's side: the Unraid clock and the phone clock are not synchronised
 * by anything in this stack, so the client anchors the countdown on its own
 * Date.now() when the frame lands.
 *
 * Everything but `action` is optional because a cancel carries none of it.
 */
export interface TimerCommand {
  action: 'start' | 'cancel'
  title?: string
  durationS?: number
  /** Seconds the full-screen alert box holds. Undefined = client default. */
  alertS?: number
}

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL as string

// Cap retained transcript so a long session cannot grow without bound.
// main.ts slices the last 240 chars for the lens; this is the backing store.
// NOTE: this is the LENS buffer only. The authoritative transcript of a
// recorded session lives on the gateway, uncapped, so trimming here does
// not lose anything from the saved file.
const MAX_CHARS = 4000

// How long the exchange stays on the lens after an answer, AND how long a
// follow-up is accepted for. The two are the same number deliberately: the
// window the user can see is the window they can talk into. When it lapses
// the box goes and the interaction is over.
//
// The gateway's own CONVO_ARM_S must be set to match. It is not timer-driven
// server-side, so the ONLY thing that closes the follow-up window early is
// the 'endconvo' this client sends - see closeAssistant(). If CONVO_ARM_S is
// longer than this and an 'endconvo' is ever missed, the gateway stays armed
// with an invisible box and routes room chatter to the LLM.
const ANSWER_HOLD_MS = 10000

// How long a bare wake phrase stays armed waiting for the question to arrive
// as a separate utterance. Pairs with WAKE_ARM_S on the gateway (default 8s);
// this is the DISPLAY side of that window, so it is a little longer.
const LISTEN_HOLD_MS = 10000

// A summary is long and arrives without warning. Give it longer than an
// answer, and let a tap dismiss it early.
const SUMMARY_HOLD_MS = 30000

/**
 * Bytes we are willing to hand to WebSocket.send().
 *
 * TypeScript 5.7 made the typed arrays generic over their backing buffer, so
 * a bare `Uint8Array` now means `Uint8Array<ArrayBufferLike>` - which INCLUDES
 * SharedArrayBuffer. `WebSocket.send` accepts only `ArrayBufferView<ArrayBuffer>`,
 * so an unqualified Uint8Array no longer satisfies it and every `ws.send(bytes)`
 * fails to compile. Naming the narrow type once here is what makes both send
 * sites check, rather than casting at each of them.
 */
type PcmBytes = Uint8Array<ArrayBuffer>

/**
 * The SDK's audioPcm type is not documented. Normalise whatever it hands us
 * into bytes, and log which branch hit so the shape is known for certain.
 */
let loggedShape = false
function toBytes(pcm: unknown): PcmBytes | null {
  if (pcm == null) return null

  if (!loggedShape) {
    loggedShape = true
    const ctor = (pcm as any)?.constructor?.name ?? typeof pcm
    console.log(`[stt] audioPcm shape: ${ctor}`, pcm)
  }

  if (pcm instanceof Uint8Array) {
    // Already bytes, but possibly over a SharedArrayBuffer as far as the
    // type system is concerned. The runtime check is what narrows it; the
    // else branch copies, which is the only correct way out of a shared
    // buffer and in practice never runs - the SDK does not use SAB.
    return pcm.buffer instanceof ArrayBuffer
      ? (pcm as PcmBytes)
      : new Uint8Array(pcm)
  }
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm)
  if (ArrayBuffer.isView(pcm)) {
    const v = pcm as ArrayBufferView
    // Same narrowing as above. A VIEW is taken rather than a copy on the
    // common path: this runs once per 20ms audio frame.
    const view = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
    return v.buffer instanceof ArrayBuffer
      ? (view as PcmBytes)
      : new Uint8Array(view)
  }
  if (Array.isArray(pcm)) return new Uint8Array(pcm as number[])
  if (typeof pcm === 'string') {
    // base64
    try {
      const bin = atob(pcm)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  return null
}

export function startSttStream(
  token: string,
  onResult: (r: SttResult) => void,
  onError: (e: unknown) => void,
  // Optional 4th arg, added for the Plex list view. When the gateway sends
  // an answer carrying a `lines` array, it goes here INSTEAD of onResult -
  // a list needs the array, and joining it into one string then re-splitting
  // in main.ts would throw away the structure the gateway already computed.
  // Omit it and behaviour is exactly as before.
  // `ids` is present ONLY on the notes list, and its presence is the
  // signal that the list is ACTIONABLE. ids[i] belongs to lines[i+1] -
  // the header has no note behind it. Plex and Sparky send lines with
  // no ids and stay read-only, which is why this is an optional second
  // parameter rather than a separate callback: one page builder, one
  // frame shape, one branch in main.ts.
  onLines?: (lines: string[], ids?: string[]) => void,
  // Optional 5th arg: conversate session callbacks. Grouped into one object
  // rather than added as a 6th and 7th positional parameter.
  hooks: SttHooks = {},
): SttHandle {
  if (!GATEWAY_URL) {
    throw new Error('VITE_GATEWAY_URL not set - copy .env.example to .env.local')
  }

  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let finalText = ''

  // Assistant mode. While this is non-null it OWNS the display: captions
  // stop updating the lens so an answer cannot be shoved off screen by the
  // next thing said in the room. Cleared on timeout, or by the next wake.
  let overlay: string | null = null
  let overlayTimer: number | null = null

  // The question is carried across three separate frames — 'question',
  // 'thinking', then 'answer' — so it has to be held here. The 'answer'
  // frame does not repeat it.
  let assistantQuestion = ''

  // Translate mode, mirrored from the gateway's frames and never set
  // locally. startTranslate() sends a command and waits for the answer
  // rather than assuming it worked: the gateway rejects an unsupported or
  // same-language pair, and a client that had already flipped its own flag
  // would show translate mode running while the server was still
  // captioning.
  let translating = false

  function emitAssistant(
    phase: AssistantState['phase'],
    answer = '',
  ) {
    hooks.onAssistant?.({ phase, question: assistantQuestion, answer })
  }

  function showOverlay(text: string, holdMs: number) {
    overlay = text
    if (overlayTimer !== null) clearTimeout(overlayTimer)
    overlayTimer = window.setTimeout(() => {
      overlay = null
      overlayTimer = null
      // Fall back to the live transcript.
      onResult({ finalText, interimText: '' })
    }, holdMs)
    onResult({ finalText: text, interimText: '' })
  }

  function clearOverlay() {
    if (overlayTimer !== null) clearTimeout(overlayTimer)
    overlayTimer = null
    overlay = null
  }

  /**
   * The box is closing. Tear down BOTH sides of the exchange.
   *
   * The gateway's follow-up window is not timer-driven: `armed_at` is only
   * consulted when the next utterance completes, and nothing on the server
   * expires it on a schedule. So the ONLY thing that ends a conversation
   * early is this 'endconvo' frame, which makes app.py's handle_cmd call
   * end_convo() - clearing `history` and zeroing `armed_at`.
   *
   * Every path that takes the box off the lens must come through here.
   * Previously the ANSWER_HOLD_MS timeout was the only one that did, so a
   * tap-to-dismiss left the gateway armed with the conversation still held:
   * invisible box, live microphone, next sentence in the room answered by
   * the LLM.
   *
   * The `overlay !== null` guard matters. main.ts calls dismiss() from
   * showCaptions() on EVERY rebuild of the caption page, including simply
   * backing out of the menu. Without the guard that would fire an endconvo
   * each time and could disarm a wake the user had just spoken.
   */
  function closeAssistant(reason: string) {
    if (overlay === null) return
    console.log(`[stt] assistant closed (${reason}) - ending conversation`)
    sendCmd('endconvo')
    clearOverlay()
    assistantQuestion = ''
    hooks.onAssistant?.(null)
    onResult({ finalText, interimText: '' })
  }

  // Small bounded queue: frames that arrive while reconnecting. Dropping is
  // correct here - stale audio is worse than missing audio, and an unbounded
  // buffer would dump minutes of backlog into Whisper on reconnect.
  const pending: PcmBytes[] = []
  const MAX_PENDING = 50 // ~1s at 20ms frames

  const url = `${GATEWAY_URL}${GATEWAY_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`

  // Control frames are NOT queued. A stale "stop recording" replayed after a
  // reconnect would stop a session the user had since restarted, and the
  // gateway ends the recording on disconnect anyway - so dropping is right.
  function sendCmd(cmd: string, extra: Record<string, unknown> = {}) {
    if (ws?.readyState !== WebSocket.OPEN) {
      console.warn(`[stt] cmd ${cmd} dropped - socket not open`)
      return
    }
    ws.send(JSON.stringify({ cmd, ...extra }))
  }

  function connect() {
    if (closed) return

    ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      retry = 0
      console.log('[stt] gateway connected')
      while (pending.length && ws?.readyState === WebSocket.OPEN) {
        ws.send(pending.shift()!)
      }
      // Resync the UI. A reconnect gets a FRESH gateway session object, so
      // this will report inactive after a drop - which is the truth, and
      // better than a phone UI still claiming to be recording.
      sendCmd('session_status')
      // Same reasoning: a reconnect gets a FRESH gateway handler with
      // translate_pair back at None, so the phone has to be told rather
      // than keeping its own last known pair. This is also what clears
      // `translating` after a drop, with no special case in onclose.
      sendCmd('translate_status')
    }

    ws.onmessage = ev => {
      let msg: any
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }

      switch (msg.type) {
        case 'ready':
          console.log(`[stt] ready ${msg.sample_rate}Hz`)
          break

        case 'speech':
          // Live "someone is talking" signal. Shown as interim so the lens
          // reacts immediately instead of sitting still until Whisper
          // returns ~1s later. Suppressed while an answer is displayed.
          //
          // Only the START of speech writes here. Clearing on speech END
          // would blank a partial that is already on screen, leaving the
          // lens empty for the ~500ms until the 'final' arrives — a visible
          // flicker on every single utterance. The 'final' case clears the
          // interim, which is the correct moment for it.
          //
          // Also suppressed in translate mode. The gateway stops sending
          // partials there, but 'speech' still arrives - it comes from the
          // endpointer, not Whisper - and a lone "..." with no text ever
          // following it reads as a hang.
          if (overlay === null && !translating && msg.active) {
            onResult({ finalText, interimText: ' ...' })
            hooks.onPartial?.('…')
          }
          break

        case 'partial':
          // In-progress utterance, re-decoded from the start each time. The
          // text can CHANGE between partials as Whisper gets more context,
          // so this REPLACES the interim rather than appending to it —
          // appending would produce "I scream I scream ice cream".
          //
          // Rendered as interim, so `finalText` stays untouched: when the
          // 'final' for this utterance lands it appends once, and the
          // interim is cleared. Nothing is ever double-counted.
          if (overlay === null) {
            onResult({ finalText, interimText: ` ${msg.text}` })
            hooks.onPartial?.(msg.text)
          }
          break

        case 'final': {
          // Not reachable in translate mode - run_translate() returns
          // before the gateway ever builds a 'final' - but left ungated on
          // purpose. If one did arrive it would be a real transcript line
          // and belongs in the buffer; dropping it silently would hide a
          // server-side bug rather than surface it.
          finalText = `${finalText} ${msg.text}`.trim()
          if (finalText.length > MAX_CHARS) {
            finalText = finalText.slice(-MAX_CHARS)
          }
          console.log(`[stt] +${msg.stt_ms}ms: ${msg.text}`)
          if (overlay === null) {
            onResult({ finalText, interimText: '' })
            hooks.onUtterance?.(msg.seq, msg.text)
          }
          break
        }

        case 'speaker':
          // Live speaker identification. The gateway scores the utterance
          // against the named roster and sends `name` when both
          // live_roster_match and live_roster_margin clear, or null when
          // they do not.
          //
          // `msg.speaker` (S1/S2/...) is deliberately IGNORED here. It is a
          // within-session clustering label with no meaning to the person
          // wearing the glasses, and showing it as a fallback would make an
          // unidentified voice look identified.
          //
          // Not gated on `overlay`: this only annotates an utterance already
          // in the caption buffer, it never repaints the lens by itself, so
          // it is safe to apply while an assistant box is up. The annotation
          // is then already correct when captions come back.
          hooks.onSpeaker?.(msg.seq, msg.name ?? null)
          break

        case 'suggest':
          // Unsolicited machine text for the band. Deliberately NOT routed
          // through onResult() or showOverlay(): those are the assistant's
          // path, and onResult() feeds the caption buffer - a suggestion
          // that went that way would be indistinguishable from something a
          // person in the room actually said.
          //
          // NOT gated on `overlay`, unlike the caption frames above. The
          // band is a container on the caption page, so while an assistant
          // box is up it is not on screen at all and the write would be a
          // silent no-op. main.ts holds the text instead and bakes it into
          // the page when captions come back, so a suggestion that lands
          // mid-exchange is not simply lost.
          console.log(
            `[stt] suggest seq=${msg.seq} ${msg.tag} +${msg.llm_ms}ms ` +
              `hold=${msg.hold_ms ?? 'default'}: ${msg.text}`,
          )
          // hold_ms is passed through UNVALIDATED: clamping and the
          // fallback both live in suggest.ts's resolveHoldMs(), so there is
          // one place that decides what a hold time may be. This module's
          // job is to hand the frame's fields to the hook, not to police
          // them.
          hooks.onSuggest?.(
            msg.tag,
            msg.text,
            typeof msg.hold_ms === 'number' ? msg.hold_ms : undefined,
          )
          break

        case 'timer':
          // Command only. The confirmation the wearer reads arrives
          // separately as an ordinary 'answer' frame, immediately after
          // this one — the gateway sends the command first so the countdown
          // is already running when the box describing it appears.
          //
          // The fields are passed through UNVALIDATED. Clamping and the
          // default both live in timer.ts's resolveAlertMs() and
          // startTimer(), so there is one place that decides what a
          // duration and a hold may be; this module's job is to hand the
          // frame's fields to the hook, not to police them.
          console.log(
            `[stt] timer ${msg.action} title=${msg.title ?? '-'} ` +
              `duration=${msg.duration_s ?? '-'}s alert=${msg.alert_s ?? 'default'}s`,
          )
          hooks.onTimer?.({
            action: msg.action === 'cancel' ? 'cancel' : 'start',
            title: typeof msg.title === 'string' ? msg.title : undefined,
            durationS:
              typeof msg.duration_s === 'number' ? msg.duration_s : undefined,
            alertS: typeof msg.alert_s === 'number' ? msg.alert_s : undefined,
          })
          break

        case 'wake':
          // Bare wake phrase: gateway is armed and waiting for a question.
          console.log('[stt] wake - listening for question')
          assistantQuestion = ''
          // `overlay` is still set here even though main.ts now draws the
          // box: it is what stops caption frames repainting the lens
          // underneath the overlay. Only the RENDERING moved out of this
          // module, not the display ownership.
          overlay = 'listening'
          if (overlayTimer !== null) clearTimeout(overlayTimer)
          overlayTimer = window.setTimeout(() => {
            // Send 'endconvo' here too, not just a display clear. WAKE_ARM_S
            // (8s) is shorter than this hold, so the gateway would usually
            // have lapsed on its own - but "usually" is not "always", and a
            // wake that armed the gateway and then timed out on the lens
            // must not leave a live microphone behind it.
            overlayTimer = null
            closeAssistant('listen timeout')
          }, LISTEN_HOLD_MS)
          emitAssistant('listening')
          break

        case 'question':
          console.log(`[stt] question: ${msg.text}`)
          assistantQuestion = msg.text ?? ''
          overlay = 'question'
          if (overlayTimer !== null) clearTimeout(overlayTimer)
          overlayTimer = null // held until the answer resolves it
          emitAssistant('question')
          break

        case 'thinking':
          overlay = 'thinking'
          emitAssistant('thinking')
          break

        case 'answer':
          console.log(`[stt] answer (+${msg.llm_ms}ms): ${msg.text}`)
          // Structured answers (Plex, a Sparky card) render as a scrollable
          // list rather than a text overlay. Still set `overlay` so captions
          // stop writing to the lens underneath the list - clearing it is
          // what hands the display back.
          //
          // DELIBERATELY NO onAssistant(null) HERE. It used to fire just
          // before onLines(), and main.ts reads a null as "the exchange is
          // over, put the previous page back" - so restoreFromAssistant()
          // rebuilt the caption page (firing dismiss() -> closeAssistant() ->
          // 'endconvo') while showListPage() was rebuilding the list. Two
          // rebuildPageContainer calls in flight at once, and the list lost:
          // 'rebuildPageContainer failed (list)' with the box vanishing off
          // the lens a frame earlier.
          //
          // The list page IS the handover, so main.ts clears its assistant
          // state in its own onLines handler instead - one rebuild, not two.
          if (Array.isArray(msg.lines) && msg.lines.length && onLines) {
            overlay = msg.text
            if (overlayTimer !== null) clearTimeout(overlayTimer)
            overlayTimer = null // no auto-dismiss: the user scrolls it
            // Passed through UNVALIDATED beyond the type check: main.ts
            // is what pairs ids to rows and it re-checks the pairing
            // before acting on a tap, so a short or malformed array
            // costs a refetch there rather than a wrong note here.
            onLines(
              msg.lines,
              Array.isArray(msg.ids) ? (msg.ids as string[]) : undefined,
            )
          } else {
            overlay = 'answer'
            emitAssistant('answer', msg.text ?? '')
            if (overlayTimer !== null) clearTimeout(overlayTimer)
            overlayTimer = window.setTimeout(() => {
              // Null the handle first: closeAssistant() calls clearOverlay(),
              // which would otherwise clearTimeout on the timer that is
              // currently executing. Harmless, but it reads as a bug.
              overlayTimer = null
              closeAssistant('answer timeout')
            }, ANSWER_HOLD_MS)
          }
          break

        case 'translate':
          // Mode state. The ONLY writer of `translating`, which is why
          // startTranslate() below does not touch it.
          translating = !!msg.active
          if (msg.error) {
            console.warn(`[stt] translate rejected: ${msg.error}`)
          } else {
            console.log(
              `[stt] translate ${msg.active ? `${msg.a} -> ${msg.b}` : 'off'}`,
            )
          }
          hooks.onTranslate?.({
            active: !!msg.active,
            a: msg.a ?? null,
            b: msg.b ?? null,
            aNative: msg.a_native ?? null,
            bNative: msg.b_native ?? null,
            error: typeof msg.error === 'string' ? msg.error : undefined,
          })
          break

        case 'translation':
          // One translated utterance. Never written to `finalText` and
          // never passed to onResult(): see TranslationLine.
          //
          // NOT gated on `overlay`. Like 'suggest', this does not repaint
          // the lens by itself - main.ts decides that - so a translation
          // that lands while some box is up is handed over rather than
          // lost.
          if (msg.translated) {
            console.log(
              `[stt] translate seq=${msg.seq} ${msg.from}->${msg.to} ` +
                `(stt ${msg.stt_ms}ms + tr ${msg.translate_ms}ms) ` +
                `lens=${msg.lens}: ${msg.text}`,
            )
          } else {
            console.log(
              `[stt] translate seq=${msg.seq} skipped, detected ` +
                `${msg.detected} outside pair: ${msg.source_text}`,
            )
          }
          // hold_ms is passed through UNVALIDATED, same rule as 'suggest'
          // and 'timer': clamping and the fallback belong in the module
          // that owns the lens, so one place decides what a hold may be.
          hooks.onTranslation?.({
            seq: msg.seq,
            translated: !!msg.translated,
            sourceText: msg.source_text ?? '',
            text: msg.text ?? '',
            from: msg.from ?? '',
            to: msg.to ?? '',
            fromNative: msg.from_native ?? '',
            toNative: msg.to_native ?? '',
            detected: msg.detected ?? null,
            lens: !!msg.lens,
            holdMs: typeof msg.hold_ms === 'number' ? msg.hold_ms : undefined,
            sttMs: msg.stt_ms ?? 0,
            translateMs: msg.translate_ms ?? 0,
          })
          break

        case 'session':
          console.log(
            `[stt] session ${msg.active ? 'recording' : 'stopped'} `
            + `${msg.id ?? '-'} (${msg.utterances} utterances)`,
          )
          hooks.onSession?.({
            active: !!msg.active,
            id: msg.id ?? null,
            utterances: msg.utterances ?? 0,
            summarizing: msg.summarizing,
          })
          break

        case 'summary':
          console.log(`[stt] summary ${msg.id}: ${msg.text}`)
          hooks.onSummary?.(msg.id, msg.text)
          // The summary owns the lens the same way an answer does, so the
          // next thing said in the room cannot scroll it away mid-read.
          showOverlay(msg.text, SUMMARY_HOLD_MS)
          break

        case 'convo':
          // Follow-up window opened or closed. Logged only.
          console.log(`[stt] convo active=${msg.active}`)
          break

        case 'error':
          onError(new Error(msg.message))
          break
      }
    }

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    }

    ws.onclose = e => {
      if (closed) return

      // 4401 is the gateway rejecting the token. Retrying will not help.
      if (e.code === 4401) {
        onError(new Error('Gateway rejected token - check VITE_STT_API_KEY'))
        return
      }

      // A dropped socket ends the conversation whether we like it or not:
      // the gateway holds `history` and `armed_at` in the WebSocket handler's
      // locals, so a reconnect gets a fresh, disarmed session. Clear the box
      // to match, WITHOUT sending endconvo - there is no socket to send it
      // on, and the server-side state it would clear is already gone.
      clearOverlay()
      assistantQuestion = ''
      hooks.onAssistant?.(null)

      retry += 1
      const delay = Math.min(500 * 2 ** (retry - 1), 5000)
      console.warn(`[stt] disconnected (${e.code}), retry in ${delay}ms`)
      setTimeout(connect, delay)
    }
  }

  connect()

  return {
    sendPcm(pcm: unknown) {
      const bytes = toBytes(pcm)
      if (!bytes || bytes.length === 0) return

      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(bytes)
      } else if (pending.length < MAX_PENDING) {
        pending.push(bytes)
      }
    },

    dismiss() {
      // Tap, double-tap, or main.ts rebuilding the caption page. This is the
      // path that used to leave the gateway armed - it cleared the lens and
      // told the server nothing.
      closeAssistant('dismissed')
    },

    startSession(title?: string) {
      sendCmd('session_start', title ? { title } : {})
    },

    stopSession() {
      sendCmd('session_stop')
    },

    sessionStatus() {
      sendCmd('session_status')
    },

    startTranslate(a: string, b: string) {
      // Any exchange on screen is over: translate mode bypasses the
      // assistant server-side, so a box left up would never resolve and its
      // follow-up window would never be closed by anything.
      closeAssistant('translate started')
      // `translating` is deliberately NOT set here - the gateway's
      // 'translate' frame is what sets it, so a rejected pair cannot leave
      // this client believing it is translating.
      sendCmd('translate_start', { a, b })
    },

    stopTranslate() {
      sendCmd('translate_stop')
    },

    translateStatus() {
      sendCmd('translate_status')
    },

    clearTranscript() {
      finalText = ''
      // A new recording is starting. If an exchange is still up, it is over -
      // and the gateway needs to hear that, not just the lens.
      closeAssistant('transcript cleared')
      clearOverlay()
      onResult({ finalText: '', interimText: '' })
    },

    close() {
      closed = true
      clearOverlay()
      pending.length = 0
      try {
        ws?.close()
      } catch {
        /* already gone */
      }
    },
  }
}