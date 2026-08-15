/**
 * Gateway STT client - drop-in replacement for the ASR template's stub.
 *
 * Streams glasses mic PCM to your Unraid gateway over a WebSocket and
 * returns transcripts. Keeps the exact signature main.ts expects, so no
 * changes to main.ts are required.
 *
 * Wire format out: raw 16 kHz mono s16le PCM binary frames.
 * Wire format in:  JSON - {type:"ready"|"speech"|"final"|"error", ...}
 *
 * Env (in .env.local):
 *   VITE_GATEWAY_URL=wss://g2gateway.sams-server.duckdns.org:50443/ws/stt
 *   VITE_STT_API_KEY=<the AUTH_TOKEN from your compose .env>
 */

export interface SttHandle {
  sendPcm(pcm: unknown): void
  close(): void
}

export interface SttResult {
  finalText: string
  interimText: string
}

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL as string

// Cap retained transcript so a long session cannot grow without bound.
// main.ts slices the last 240 chars for the lens; this is the backing store.
const MAX_CHARS = 4000

/**
 * The SDK's audioPcm type is not documented. Normalise whatever it hands us
 * into bytes, and log which branch hit so the shape is known for certain.
 */
let loggedShape = false
function toBytes(pcm: unknown): Uint8Array | null {
  if (pcm == null) return null

  if (!loggedShape) {
    loggedShape = true
    const ctor = (pcm as any)?.constructor?.name ?? typeof pcm
    console.log(`[stt] audioPcm shape: ${ctor}`, pcm)
  }

  if (pcm instanceof Uint8Array) return pcm
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm)
  if (ArrayBuffer.isView(pcm)) {
    const v = pcm as ArrayBufferView
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
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
): SttHandle {
  if (!GATEWAY_URL) {
    throw new Error('VITE_GATEWAY_URL not set - copy .env.example to .env.local')
  }

  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let finalText = ''

  // Small bounded queue: frames that arrive while reconnecting. Dropping is
  // correct here - stale audio is worse than missing audio, and an unbounded
  // buffer would dump minutes of backlog into Whisper on reconnect.
  const pending: Uint8Array[] = []
  const MAX_PENDING = 50 // ~1s at 20ms frames

  const url = `${GATEWAY_URL}${GATEWAY_URL.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`

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
          // returns ~1s later.
          onResult({ finalText, interimText: msg.active ? ' ...' : '' })
          break

        case 'final': {
          finalText = `${finalText} ${msg.text}`.trim()
          if (finalText.length > MAX_CHARS) {
            finalText = finalText.slice(-MAX_CHARS)
          }
          console.log(`[stt] +${msg.stt_ms}ms: ${msg.text}`)
          onResult({ finalText, interimText: '' })
          break
        }

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

    close() {
      closed = true
      pending.length = 0
      try {
        ws?.close()
      } catch {
        /* already gone */
      }
    },
  }
}
