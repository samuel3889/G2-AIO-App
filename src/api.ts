/**
 * One place for the gateway URL rule and the token.
 *
 * settings.ts, sessions.ts, prompts.ts and review.ts all consume restBase()
 * and restUrl() from here. There is no second copy of the rule anywhere in
 * the app; if you find one, delete it rather than keeping the two in sync.
 *
 * NOTE this module deliberately does NOT own the WebSocket URL. stt.ts reads
 * VITE_GATEWAY_URL directly because it needs the wss:// form verbatim,
 * whereas everything here needs it rewritten to https:// with the /ws/stt
 * path stripped. One export cannot be both.
 */

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL as string

export const TOKEN = import.meta.env.VITE_STT_API_KEY as string

/** wss://host/ws/stt -> https://host   (^ws -> http covers wss -> https too) */
export function restBase(): string {
  return GATEWAY_URL.replace(/^ws/, 'http').replace(/\/ws\/stt.*$/, '')
}

/**
 * Absolute gateway URL with the token appended.
 *
 * Uses `&` when the path already carries a query string, which is what makes
 * `restUrl('/sessions/x/review?all=1')` work.
 */
export function restUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${restBase()}${path}${sep}token=${encodeURIComponent(TOKEN)}`
}