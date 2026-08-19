/**
 * One place for the gateway URL rule and the token.
 *
 * settings.ts and sessions.ts each carry their own verbatim copy of
 * restBase(). A third copy in review.ts would be a third thing to keep in
 * sync, so the rule lives here instead. The two existing files are
 * deliberately NOT changed yet — migrating them is a separate, independently
 * verifiable step:
 *
 *     import { restBase } from './api'      // then delete the local copy
 *
 * The rule itself is copied byte-for-byte from settings.ts, so behaviour is
 * identical today.
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
 * `restUrl('/sessions/x/review?all=1')` work. Same rule as sessions.ts.
 */
export function restUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${restBase()}${path}${sep}token=${encodeURIComponent(TOKEN)}`
}