/**
 * Review panel — step 4 of the plan: split-segment display.
 *
 * Lists the clips the gateway still has on disk for a session, worst-first,
 * plays them, and shows how the offline split pass carved each one.
 *
 * WHAT A SPLIT ACTUALLY MEANS, measured on real data rather than assumed:
 * `split: true` does NOT imply two people spoke. Both split clips in session
 * 20260818-233831 carve into 2-3 segments that all land on S3 — one long
 * high-scoring segment followed by short low-scoring tails:
 *
 *   seq 13:  0-7000ms @ 0.685,  7000-8000ms @ 0.340
 *   seq  7:  0-4500ms @ 0.702,  4500-5500 @ 0.374,  5500-7920 @ 0.390
 *
 * Every weak tail is at or near 1000ms, and the measured speaker-ID floor on
 * this mic is 2500ms — below which a clip embeds to noise. So the low scores
 * are most likely too-short segments, not voice changes. The UI therefore
 * reports "split xN" for same-speaker carving and reserves "N voices" for
 * segments that genuinely disagree. Presenting every split as a speaker
 * change would manufacture a conclusion the data does not support.
 *
 * `start_ms` is CLIP-relative — the first segment of an utterance 76s into
 * the session starts at 0. Verified against the live endpoint, which is why
 * seeking works with no offset arithmetic.
 *
 * No Even Hub SDK calls. DOM, fetch, and <audio> only.
 *
 * Endpoints used, all verified against the running gateway:
 *   GET /sessions                       -> { sessions: [...] }, newest first
 *   GET /sessions/{sid}/review[?all=1]  -> { id, clips, utterances, retention_h }
 *   GET /sessions/{sid}/clips/{seq}.wav -> audio/wav, Cache-Control: no-store
 *   GET  /speakers                      -> { speakers: [...] }, no vectors
 *   POST /speakers                      -> { session_id, label, name }
 *   PATCH /speakers/{id}                -> rename an existing centroid
 *   DELETE /speakers/{id}               -> forget a named voice
 *
 * The Save button is TWO operations. An unnamed label POSTs a new
 * enrolment; a named one whose field has been edited PATCHes a rename. That
 * split exists because a pre-filled field reads as editable, and a
 * correction that POSTed instead would mint a second centroid and orphan
 * the first — leaving a stored voiceprint nobody can later identify.
 * Re-typing the same name deliberately re-enrols, which is how a centroid
 * gets reinforced from a second session.
 *
 * NAMING enrols from CLEANLY-labelled utterances only. A label appearing
 * solely inside "+"-joined utterances has no single-voice vector to average
 * and cannot be named — the panel says "mixed only" and disables the field
 * rather than letting someone type a name and collect a 400.
 *
 * Naming does NOT make future sessions recognise anyone: SpeakerBook is
 * still minted empty at session_start. The note under the name fields says
 * so, because a UI that silently implied otherwise would be worse than one
 * that admits the limit.
 */
import { restBase, restUrl } from './api'
import { TAB_HIDE } from './tabs'

interface Segment {
  start_ms: number
  end_ms: number
  speaker: string | null
  score: number
}

interface ReviewClip {
  seq: number
  t: number | null
  text: string
  speaker: string | null
  score: number | null
  split: boolean
  segments: Segment[]
  /** label -> human name, only for labels that have been named. */
  speaker_names: Record<string, string>
  url: string
}

interface ReviewDoc {
  id: string
  clips: ReviewClip[]
  utterances: number
  retention_h: number
}

interface SessionRow {
  id: string
  title: string
  started: number | null
  utterances: number
  /**
   * Unexpired clips still on disk, from session_index(). Sessions recorded
   * before this field existed will not carry it, which is why the filter
   * below treats `undefined` as "keep" rather than as zero — dropping every
   * older session from the picker on upgrade day would look like data loss.
   */
  clips?: number
}

/** Below this an embedding is noise on this mic — measured, not guessed. */
const SPEAKER_MIN_MS = 2500

const CSS = `
.g2r { font: 14px/1.4 system-ui, sans-serif; padding: 12px; max-width: 560px;
       margin: 12px auto; background: #111; color: #eee; border-radius: 10px; }
.g2r h3 { margin: 0 0 4px; font-size: 15px; }
.g2r .sub { color: #888; font-size: 12px; margin-bottom: 12px; }
.g2r .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
            margin-bottom: 10px; }
.g2r select { flex: 1 1 100%; background: #1a1a1a; color: #eee; border: 1px solid #333;
              border-radius: 6px; padding: 9px 8px; font-size: 13px; }
.g2r button { background: #333; color: #eee; border: 0; border-radius: 6px;
              padding: 9px 12px; font-size: 13px; touch-action: manipulation; }
.g2r button:active { background: #444; }
.g2r button.on { background: #6cf; color: #062; font-weight: 600; }

/* Native controls LEFT VISIBLE on purpose: if scripted play() is ever blocked
   but the native control works, that distinction is the whole answer. */
.g2r .player { background: #161616; border-radius: 8px; padding: 8px 10px;
               margin-bottom: 10px; }
.g2r .player audio { width: 100%; display: block; }
.g2r .now { font-size: 12px; color: #888; margin-bottom: 6px; }
.g2r .diag { font-size: 11px; color: #777; margin-top: 6px; word-break: break-word;
             font-family: ui-monospace, Menlo, monospace; }
.g2r .diag.bad { color: #ff6b60; }
.g2r .diag.good { color: #7ddf7d; }

.g2r .stats { color: #888; font-size: 12px; margin-bottom: 10px; }
.g2r .legend { background: #161616; border-radius: 8px; padding: 10px;
               font-size: 12px; color: #aaa; margin-bottom: 10px; }
.g2r .legend .lgh { font-weight: 600; color: #ccc; margin-bottom: 8px; }
.g2r .legend .lgnote { color: #777; margin-top: 8px; line-height: 1.35; }
.g2r .nrow { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.g2r .nrow .tag { flex: 0 0 auto; background: #24303a; color: #6cf;
                  border-radius: 5px; padding: 3px 7px; font-weight: 600; }
.g2r .nrow .cnt { flex: 0 0 auto; color: #777; font-size: 11px; width: 58px; }
.g2r .nrow .cnt.none { color: #ffb454; }
.g2r .nrow .nm { flex: 1 1 auto; min-width: 0; background: #1a1a1a; color: #eee;
                 border: 1px solid #333; border-radius: 6px; padding: 8px;
                 font-size: 13px; }
.g2r .nrow .nm:disabled { opacity: .45; }
.g2r .nrow button { flex: 0 0 auto; padding: 8px 10px; font-size: 12px; }
.g2r .nrow .save { background: #24303a; color: #6cf; font-weight: 600; }
.g2r .nrow .forget { background: #3a1c1a; color: #ff6b60; }
.g2r .row { background: #1a1a1a; border-radius: 8px; padding: 10px;
            margin-bottom: 8px; }
.g2r .row.playing { background: #16232a; outline: 1px solid #6cf; }
.g2r .head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap;
             margin-bottom: 4px; }
.g2r .seq { color: #666; font-size: 12px; font-variant-numeric: tabular-nums; }
.g2r .spk { font-weight: 600; color: #6cf; font-size: 12px; }
.g2r .spk.none { color: #ffb454; }

/* Two DIFFERENT chips. Grey = the pass carved this clip but every piece
   landed on the same speaker. Orange = the pieces genuinely disagree. */
.g2r .chip { border-radius: 5px; padding: 1px 6px; font-size: 11px;
             font-weight: 600; }
.g2r .chip.carve { background: #2a2a2a; color: #999; }
.g2r .chip.voices { background: #3a2a16; color: #ffb454; }

.g2r .sc { margin-left: auto; color: #888; font-size: 12px;
           font-variant-numeric: tabular-nums; }
.g2r .sc.low { color: #ff6b60; }
.g2r .body { display: flex; gap: 10px; align-items: flex-start; }
.g2r .play { flex: 0 0 auto; width: 44px; height: 44px; border-radius: 8px;
             background: #2a2a2a; color: #6cf; font-size: 15px; line-height: 1;
             padding: 0; }
.g2r .play.on { background: #6cf; color: #062; }
.g2r .txt { flex: 1; white-space: pre-wrap; word-break: break-word; font-size: 13px; }

.g2r .segs { margin: 8px 0 0 54px; }
.g2r .seg { display: flex; gap: 8px; align-items: baseline; width: 100%;
            background: #141414; border-radius: 6px; padding: 7px 9px;
            margin-bottom: 4px; text-align: left; font-size: 12px;
            font-variant-numeric: tabular-nums; }
.g2r .seg:active { background: #202020; }
.g2r .seg.on { background: #16232a; outline: 1px solid #6cf; }
.g2r .seg .rng { color: #ccc; }
.g2r .seg .who { color: #6cf; font-weight: 600; }
.g2r .seg .who.none { color: #ffb454; }
.g2r .seg .val { margin-left: auto; color: #888; }
/* A segment under the embedding floor: its score is not evidence either way. */
.g2r .seg .short { color: #ffb454; font-size: 11px; }

.g2r .state { font-size: 12px; color: #888; }
.g2r .err { color: #f66; }
`

/** Seconds from session start -> m:ss. `t` can legitimately be null. */
function clock(t: number | null): string {
  if (t === null || t === undefined) return '--:--'
  const s = Math.max(0, Math.floor(t))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Milliseconds -> seconds, one decimal. Segment offsets are small. */
function secs(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/**
 * MediaError.code -> something readable. Code 2 (could not fetch) and code 4
 * (fetched, refused the container) point at completely different causes, and
 * "it didn't play" cannot distinguish them.
 */
function mediaErr(e: MediaError | null): string {
  if (!e) return 'unknown'
  const names: Record<number, string> = {
    1: 'ABORTED',
    2: 'NETWORK (could not fetch the URL)',
    3: 'DECODE (fetched, but decoding failed)',
    4: 'SRC_NOT_SUPPORTED (fetched, container/codec refused)',
  }
  const why = e.message ? ` — ${e.message}` : ''
  return `${e.code} ${names[e.code] ?? '?'}${why}`
}

/** Distinct non-null speakers across a segment list, order preserved. */
function distinctSpeakers(segs: Segment[]): string[] {
  const out: string[] = []
  for (const s of segs) {
    if (s.speaker && !out.includes(s.speaker)) out.push(s.speaker)
  }
  return out
}

export function mountReview(host?: HTMLElement) {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.className = 'g2r'
  root.innerHTML = `<h3>Review</h3>
    <div class="sub">Retained clips, worst-first. Tap ▶ for the whole clip, or a segment to hear just that piece.</div>
    <div class="bar">
      <select class="pick"><option>loading…</option></select>
      <button class="f-need on">Needs review</button>
      <button class="f-all">All</button>
      <button class="refresh">Refresh</button>
      <span class="state"></span>
    </div>
    <div class="player">
      <div class="now">Nothing loaded</div>
      <audio class="au" preload="none" controls playsinline></audio>
      <div class="diag">no attempt yet</div>
    </div>
    <div class="stats"></div>
    <div class="legend" hidden></div>
    <div class="list">Pick a session.</div>`
  ;(host ?? document.body).appendChild(root)

  const pick = root.querySelector('.pick') as HTMLSelectElement
  const needBtn = root.querySelector('.f-need') as HTMLButtonElement
  const allBtn = root.querySelector('.f-all') as HTMLButtonElement
  const stats = root.querySelector('.stats') as HTMLElement
  const legend = root.querySelector('.legend') as HTMLElement
  const listEl = root.querySelector('.list') as HTMLElement
  const state = root.querySelector('.state') as HTMLElement
  const audio = root.querySelector('.au') as HTMLAudioElement
  const nowEl = root.querySelector('.now') as HTMLElement
  const diagEl = root.querySelector('.diag') as HTMLElement

  let showAll = false
  let playingSeq: number | null = null
  // Which segment button is lit, as "seq:index". Null when playing a whole clip.
  let playingSeg: string | null = null
  // Pause automatically at this position (seconds) when playing one segment.
  let stopAt: number | null = null
  // True while start() is repositioning the head. The pause() and timeupdate
  // handlers must stand down during that window: pausing to seek would
  // otherwise clear the very state start() is in the middle of setting, and a
  // timeupdate arriving before the seek lands would compare the OLD position
  // against the NEW stopAt and cut playback instantly.
  let switching = false

  const say = (m: string, err = false) => {
    state.textContent = m
    state.className = err ? 'state err' : 'state'
  }

  const diag = (m: string, kind: '' | 'good' | 'bad' = '') => {
    diagEl.textContent = m
    diagEl.className = kind ? `diag ${kind}` : 'diag'
    console.log(`[review/audio] ${m}`)
  }

  // ------------------------------------------------------------------ audio
  //
  // ONE element, reused for every clip. Dozens of <audio> elements each
  // holding a WebView media resource is a good way to hit a per-page decoder
  // limit and get failures that look random.

  function paintPlaying() {
    for (const el of Array.from(listEl.querySelectorAll('.row'))) {
      const seq = Number((el as HTMLElement).dataset.seq)
      const on = playingSeq !== null && seq === playingSeq
      el.className = on ? 'row playing' : 'row'
      const b = el.querySelector('.play') as HTMLButtonElement | null
      if (b) {
        b.textContent = on && playingSeg === null ? '❚❚' : '▶'
        b.className = on && playingSeg === null ? 'play on' : 'play'
      }
    }
    for (const el of Array.from(listEl.querySelectorAll('.seg'))) {
      const key = (el as HTMLElement).dataset.key
      el.className = key && key === playingSeg ? 'seg on' : 'seg'
    }
  }

  function clearPlaying() {
    playingSeq = null
    playingSeg = null
    stopAt = null
    switching = false
    paintPlaying()
  }

  audio.addEventListener('loadstart', () => diag('loadstart — request issued'))
  audio.addEventListener('loadedmetadata', () =>
    diag(`metadata ok — duration ${audio.duration.toFixed(2)}s`),
  )
  audio.addEventListener('canplay', () => diag('canplay — decoded, ready', 'good'))
  audio.addEventListener('playing', () =>
    diag(`playing — duration ${audio.duration.toFixed(2)}s`, 'good'),
  )
  audio.addEventListener('ended', () => {
    clearPlaying()
    diag('ended — played to completion', 'good')
  })
  audio.addEventListener('pause', () => {
    if (switching) return
    if (playingSeq !== null && !audio.ended) clearPlaying()
  })
  audio.addEventListener('stalled', () => diag('stalled — data stopped arriving', 'bad'))
  audio.addEventListener('error', () => {
    clearPlaying()
    diag(`error — MediaError ${mediaErr(audio.error)}`, 'bad')
  })

  // Segment playback stops itself here. timeupdate fires roughly 4x/sec, so
  // the cut lands within ~250ms of end_ms — fine for listening, and NOT
  // precise enough to build any measurement on.
  audio.addEventListener('timeupdate', () => {
    if (switching || stopAt === null) return
    if (audio.currentTime >= stopAt) {
      stopAt = null
      audio.pause()
      diag('segment end reached')
    }
  })

  /**
   * Move the playhead and WAIT for it to land.
   *
   * Assigning currentTime is asynchronous. Arming stopAt or calling play()
   * before the seek completes means a timeupdate can compare the old position
   * against the new limit — which, seeking BACKWARD, is instantly past it and
   * cuts playback dead. Seeking backward is also the case that needs a fresh
   * range request, since `Cache-Control: no-store` discourages the WebView
   * from holding on to what it already played.
   *
   * Resolves rather than rejects on timeout: a seek that never reports is
   * still worth attempting playback after.
   */
  function seekTo(target: number): Promise<void> {
    if (Math.abs(audio.currentTime - target) < 0.05) return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => {
        audio.removeEventListener('seeked', done)
        window.clearTimeout(timer)
        resolve()
      }
      const timer = window.setTimeout(() => {
        diag(`seek to ${target.toFixed(1)}s did not report back`, 'bad')
        done()
      }, 3000)
      audio.addEventListener('seeked', done)
      audio.currentTime = target
    })
  }

  /**
   * Point the element at a clip and wait until it is seekable.
   *
   * Resolves immediately when that clip is already loaded, so replaying
   * segments of the same utterance does not re-fetch it. Rejects on error or
   * timeout rather than hanging: an unresolved promise here would leave the
   * row lit with nothing playing, which is the confusing failure.
   */
  function ensureLoaded(src: string): Promise<void> {
    if (audio.getAttribute('src') === src && audio.readyState >= 1) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const done = (fn: () => void) => {
        audio.removeEventListener('loadedmetadata', ok)
        audio.removeEventListener('error', bad)
        window.clearTimeout(timer)
        fn()
      }
      const ok = () => done(resolve)
      const bad = () => done(() => reject(new Error(mediaErr(audio.error))))
      const timer = window.setTimeout(
        () => done(() => reject(new Error('timed out waiting for metadata'))),
        8000,
      )
      audio.addEventListener('loadedmetadata', ok)
      audio.addEventListener('error', bad)
      audio.src = src
      audio.load()
    })
  }

  /** Whole clip from the top. */
  async function playClip(c: ReviewClip) {
    if (playingSeq === c.seq && playingSeg === null) {
      audio.pause()
      clearPlaying()
      diag('paused by user')
      return
    }
    await start(c, 0, null, `#${c.seq} · ${clock(c.t)} · ${c.speaker ?? 'unlabelled'}`, null)
  }

  /** One segment, seeking in and stopping at the far edge. */
  async function playSegment(c: ReviewClip, seg: Segment, key: string) {
    if (playingSeg === key) {
      audio.pause()
      clearPlaying()
      diag('paused by user')
      return
    }
    await start(
      c,
      seg.start_ms / 1000,
      seg.end_ms / 1000,
      `#${c.seq} · ${secs(seg.start_ms)}–${secs(seg.end_ms)}s · ${seg.speaker ?? 'unlabelled'}`,
      key,
    )
  }

  async function start(
    c: ReviewClip,
    from: number,
    to: number | null,
    label: string,
    segKey: string | null,
  ) {
    // `c.url` is a PATH from the gateway, not an absolute URL. restUrl()
    // prepends the host and appends the token.
    const src = restUrl(c.url)
    nowEl.textContent = label
    // Logged WITHOUT the token — this line lands in a console someone may paste.
    diag(`loading ${c.url} @ ${from.toFixed(1)}s`)

    playingSeq = c.seq
    playingSeg = segKey
    // Disarmed for the whole transition and re-armed only once the head has
    // actually landed. Leaving the previous segment's limit in place across a
    // seek is what cut playback after a fraction of a second.
    stopAt = null
    switching = true
    paintPlaying()

    try {
      await ensureLoaded(src)
      // Halt before repositioning: seeking underneath live playback leaves
      // the element briefly playing the old position.
      audio.pause()
      // UNCONDITIONAL, including to 0. `if (from > 0)` skipped the seek
      // entirely for the first segment of every clip, so tapping it just
      // continued from wherever the head happened to be.
      await seekTo(from)
      switching = false
      stopAt = to
      // Always behind a tap, so autoplay policy is satisfied. A rejection
      // here means something else: NotAllowedError is a policy refusal,
      // NotSupportedError means the source was rejected outright.
      await audio.play()
    } catch (e) {
      switching = false
      clearPlaying()
      const err = e as Error
      diag(`failed — ${err.name}: ${err.message}`, 'bad')
    }
  }

  function stopAudio(why: string) {
    if (!audio.getAttribute('src') && playingSeq === null) return
    audio.pause()
    // removeAttribute + load(), not src = '': assigning an empty string makes
    // the WebView resolve the PAGE url as a media source and fire a spurious
    // error that looks exactly like a real failure.
    audio.removeAttribute('src')
    audio.load()
    clearPlaying()
    nowEl.textContent = 'Nothing loaded'
    diag(why)
  }

  // Audio continuing out of a panel the user has navigated away from is a bug
  // that is hard to attribute later. `hidden` does not stop playback by itself.
  ;(host ?? root).addEventListener(TAB_HIDE, () => stopAudio('stopped — tab hidden'))

  // ---------------------------------------------------------------- naming

  /** Look an id out of the roster by name. Null when the name is unknown. */
  async function speakerIdFor(name: string): Promise<string | null> {
    const r = await fetch(restUrl('/speakers'))
    if (!r.ok) throw new Error(`roster ${r.status}`)
    const roster = ((await r.json()).speakers ?? []) as Array<{
      id: string
      name: string
    }>
    return roster.find(s => s.name === name)?.id ?? null
  }

  /**
   * Save the name in a label's field.
   *
   * TWO different operations behind one button, chosen by whether the label
   * is already named:
   *
   *   not named yet  -> POST /speakers, enrolling a new centroid
   *   already named  -> PATCH /speakers/{id}, RENAMING the existing one
   *
   * The distinction is the whole point. A field pre-filled with "Tara" reads
   * like it edits that name — and if a correction POSTed instead, it would
   * mint a SECOND centroid under the new spelling and orphan the first,
   * leaving a stored voiceprint nobody can later identify. Typos are the
   * common case for editing a name, so the common case must not be the one
   * that quietly duplicates.
   *
   * Re-typing the SAME name is treated as re-enrolment, not a no-op rename:
   * that is the deliberate way to reinforce a centroid from another session,
   * and the gateway merges weighted by count.
   */
  async function nameSpeaker(sid: string, label: string, raw: string,
                             row: HTMLElement, current: string) {
    const name = raw.trim()
    if (!name) {
      say('enter a name first', true)
      return
    }
    const btn = row.querySelector('.save') as HTMLButtonElement
    btn.disabled = true
    btn.textContent = 'saving…'
    try {
      if (current && name !== current) {
        // Rename. The centroid is untouched; only the label on it changes,
        // and the gateway rewrites every session carrying the old name.
        const id = await speakerIdFor(current)
        if (!id) throw new Error(`"${current}" is not in the roster`)
        const r = await fetch(restUrl(`/speakers/${encodeURIComponent(id)}`), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
        const d = await r.json()
        if (!r.ok) throw new Error(`${d.error ?? r.status}`)
        say(
          `renamed ${current} → ${name} · ${
            (d.sessions_updated ?? []).length
          } session(s) updated`,
        )
      } else {
        const r = await fetch(restUrl('/speakers'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sid, label, name }),
        })
        const d = await r.json()
        if (!r.ok) {
          // A 400 here is routine and informative rather than exceptional:
          // the `stats` block says which way it failed, and "no vectors"
          // has three different causes.
          const stats = d.stats
            ? ` (${d.stats.clean} clean, ${d.stats.mixed} mixed, ${d.stats.no_vec} without vectors)`
            : ''
          throw new Error(`${d.error ?? r.status}${stats}`)
        }
        say(
          `${label} → ${name}: ${d.vectors_used} vectors, ` +
            `${d.merged ? `merged, now ${d.speaker.n}` : 'new centroid'}`,
        )
      }
      // Reload rather than patching the DOM: the annotation lands on every
      // utterance carrying the label, including "+"-joined ones the row
      // list also renders.
      await loadReview()
    } catch (e) {
      btn.disabled = false
      btn.textContent = 'Save'
      say(`save failed: ${(e as Error).message}`, true)
    }
  }

  /** Remove a named voice entirely, and strip the name from every session. */
  async function forgetSpeaker(name: string, row: HTMLElement) {
    if (!name) return
    if (!confirm(`Forget "${name}"? This deletes the stored voiceprint and removes the name from every session it was applied to.`)) {
      return
    }
    const btn = row.querySelector('.forget') as HTMLButtonElement
    btn.disabled = true
    try {
      // The roster is the only place the id lives, and the review payload
      // carries names rather than ids — so look it up rather than
      // inventing an id from the name.
      const id = await speakerIdFor(name)
      if (!id) throw new Error(`"${name}" is not in the roster`)

      const r = await fetch(restUrl(`/speakers/${encodeURIComponent(id)}`), {
        method: 'DELETE',
      })
      if (!r.ok) throw new Error(`${r.status}`)
      const d = await r.json()
      say(`forgot ${name} · cleaned ${(d.sessions_cleaned ?? []).length} session(s)`)
      await loadReview()
    } catch (e) {
      btn.disabled = false
      say(`forget failed: ${(e as Error).message}`, true)
    }
  }

  // ------------------------------------------------------------------ fetch

  async function loadSessions() {
    try {
      // with_clips=1: the gateway drops sessions whose audio has expired
      // before they ever reach the phone. restUrl() switches to '&' for the
      // token because the path already carries a query string.
      const r = await fetch(restUrl('/sessions?with_clips=1'))
      if (!r.ok) throw new Error(`${r.status}`)
      const all = ((await r.json()).sessions ?? []) as SessionRow[]

      // Belt and braces, and the reason deploy order does not matter: a
      // gateway that predates with_clips ignores the param and returns
      // everything, and this catches the expired rows client-side. Against
      // the current gateway it filters nothing.
      const items = all.filter(s => s.clips === undefined || s.clips > 0)

      pick.innerHTML = ''
      if (!items.length) {
        pick.innerHTML = '<option>(no retained audio)</option>'
        // Deliberately one message for two cases. The filtered response
        // cannot tell "nothing recorded" from "everything expired" — the
        // expired rows never arrive — and inventing a distinction from a
        // count this endpoint no longer returns would be a guess. The
        // second sentence is true either way and points somewhere useful.
        listEl.textContent =
          'No sessions with retained audio. Recorded sessions keep their ' +
          'transcripts on the Sessions tab after their clips expire.'
        return
      }
      for (const s of items) {
        const o = document.createElement('option')
        o.value = s.id
        // textContent: a title is whatever Whisper heard.
        o.textContent = `${s.title || s.id} · ${s.utterances} lines`
        pick.appendChild(o)
      }
      // /sessions is newest-first, so index 0 is the newest.
      pick.selectedIndex = 0
      await loadReview()
    } catch (e) {
      listEl.innerHTML = `<div class="err">Could not reach gateway: ${
        (e as Error).message
      }<br>Checked ${restBase()}/sessions</div>`
    }
  }

  async function loadReview() {
    const sid = pick.value
    if (!sid) return
    stopAudio('cleared — session changed')
    listEl.textContent = 'loading…'
    say('')
    try {
      const path = `/sessions/${encodeURIComponent(sid)}/review${showAll ? '?all=1' : ''}`
      const r = await fetch(restUrl(path))
      if (!r.ok) throw new Error(`${r.status}`)
      render((await r.json()) as ReviewDoc)
    } catch (e) {
      listEl.innerHTML = `<div class="err">Review failed: ${(e as Error).message}</div>`
    }
  }

  function render(d: ReviewDoc) {
    const clips = d.clips ?? []

    const missing = (d.utterances ?? 0) - clips.length
    let note = ''
    if (missing > 0) {
      note =
        d.retention_h > 0
          ? ` · ${missing} expired`
          : ` · ${missing} never retained (clip_retention_h is 0)`
    }
    // Sessions recorded before the split pass existed have no segments at
    // all, and never will — diarize_session() only runs at session_stop.
    // Saying so beats leaving someone hunting for a display that cannot appear.
    const diarized = clips.some(c => (c.segments?.length ?? 0) > 0)
    stats.textContent =
      `${clips.length} clips · ${d.utterances} utterances · retention ${d.retention_h}h${note}` +
      (clips.length && !diarized ? ' · not re-diarized (no split data)' : '')

    // Labels present anywhere in the session, utterance level or segment level.
    const labels: string[] = []
    const note1 = (l: string | null) => {
      if (l && !labels.includes(l)) labels.push(l)
    }
    // How many clean (non-"+") utterances back each label. The gateway
    // enrols from these only, so a label sitting entirely inside mixed
    // utterances has nothing to average and naming it will 400.
    const clean: Record<string, number> = {}
    const named: Record<string, string> = {}
    for (const c of clips) {
      const parts = (c.speaker ?? '').split('+').filter(Boolean)
      for (const part of parts) note1(part)
      for (const s of c.segments ?? []) note1(s.speaker)
      if (parts.length === 1) clean[parts[0]] = (clean[parts[0]] ?? 0) + 1
      for (const [lbl, nm] of Object.entries(c.speaker_names ?? {})) named[lbl] = nm
    }
    labels.sort()

    if (labels.length) {
      legend.hidden = false
      legend.innerHTML = `<div class="lgh">Speakers in this session</div>
        <div class="names"></div>
        <div class="lgnote"></div>`
      const namesEl = legend.querySelector('.names') as HTMLElement
      const noteEl = legend.querySelector('.lgnote') as HTMLElement

      for (const lbl of labels) {
        const n = clean[lbl] ?? 0
        const row = document.createElement('div')
        row.className = 'nrow'
        row.innerHTML = `
          <span class="tag"></span>
          <span class="cnt"></span>
          <input class="nm" type="text" autocomplete="off"
                 autocapitalize="words" spellcheck="false">
          <button class="save" type="button">Save</button>
          <button class="forget" type="button" hidden>Forget</button>`

        ;(row.querySelector('.tag') as HTMLElement).textContent = lbl
        const cnt = row.querySelector('.cnt') as HTMLElement
        // A label with zero clean utterances cannot be enrolled at all.
        // Saying so up front beats a 400 after typing a name.
        cnt.textContent = n ? `${n} clean` : 'mixed only'
        if (!n) cnt.className = 'cnt none'

        const input = row.querySelector('.nm') as HTMLInputElement
        const saveBtn = row.querySelector('.save') as HTMLButtonElement
        const forgetBtn = row.querySelector('.forget') as HTMLButtonElement

        const current = named[lbl] ?? ''
        input.value = current
        input.placeholder = n ? 'name this voice' : 'nothing to enroll'
        input.disabled = !n
        saveBtn.disabled = !n
        forgetBtn.hidden = !current

        // The button says which of the two operations it will perform, so
        // the difference between renaming and re-enrolling is visible
        // BEFORE the tap rather than only in the status line after it.
        const paintBtn = () => {
          const typed = input.value.trim()
          saveBtn.textContent = !current
            ? 'Save'
            : typed && typed !== current
              ? 'Rename'
              : 'Re-enroll'
        }
        paintBtn()
        input.oninput = paintBtn

        saveBtn.onclick = () => void nameSpeaker(d.id, lbl, input.value, row, current)
        forgetBtn.onclick = () => void forgetSpeaker(current, row)
        input.onkeydown = ev => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            void nameSpeaker(d.id, lbl, input.value, row, current)
          }
        }

        namesEl.appendChild(row)
      }

      noteEl.textContent =
        'Naming averages this session\u2019s vectors into a stored centroid. ' +
        'It does not make future sessions recognise anyone \u2014 that is a ' +
        'separate change to the live path.'
    } else {
      legend.hidden = true
    }

    if (!clips.length) {
      listEl.textContent = d.utterances
        ? 'No clips on disk for this session.'
        : 'This session has no utterances.'
      return
    }

    listEl.innerHTML = ''
    for (const c of clips) {
      const segs = c.segments ?? []
      const voices = distinctSpeakers(segs)

      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.seq = String(c.seq)
      row.innerHTML = `
        <div class="head">
          <span class="seq"></span>
          <span class="spk"></span>
          <span class="sc"></span>
        </div>
        <div class="body">
          <button class="play" type="button" aria-label="play clip">▶</button>
          <div class="txt"></div>
        </div>
        <div class="segs"></div>`

      ;(row.querySelector('.seq') as HTMLElement).textContent =
        `#${c.seq} · ${clock(c.t)}`

      const spk = row.querySelector('.spk') as HTMLElement
      const nameMap = c.speaker_names ?? {}
      if (c.speaker) {
        // Named labels render as "Tara (S3)": the human name leads, but the
        // S-label stays visible because it is what the vectors were
        // clustered under and what every stored score refers to.
        const parts = c.speaker.split('+').filter(Boolean)
        spk.textContent = parts
          .map(p => (nameMap[p] ? `${nameMap[p]} (${p})` : p))
          .join(' + ')
      } else {
        spk.textContent = 'unlabelled'
        spk.className = 'spk none'
      }

      // Two distinct chips, because these are two distinct findings. More
      // than one segment is a CARVE; more than one speaker among them is a
      // genuine multi-voice utterance. Conflating them would report a
      // speaker change every time a trailing 1s window scored badly.
      if (voices.length > 1) {
        const chip = document.createElement('span')
        chip.className = 'chip voices'
        chip.textContent = `${voices.length} voices`
        spk.after(' ', chip)
      } else if (segs.length > 1) {
        const chip = document.createElement('span')
        chip.className = 'chip carve'
        chip.textContent = `split ×${segs.length}`
        spk.after(' ', chip)
      }

      const sc = row.querySelector('.sc') as HTMLElement
      // Score is meaningless on an unlabelled clip — the endpoint still
      // returns one, so it is hidden rather than shown as authoritative.
      if (c.speaker && typeof c.score === 'number') {
        sc.textContent = c.score.toFixed(3)
        if (c.score < 0.1) sc.className = 'sc low'
      }

      // textContent, never innerHTML: this is transcript text.
      ;(row.querySelector('.txt') as HTMLElement).textContent = c.text || '(no text)'
      ;(row.querySelector('.play') as HTMLButtonElement).onclick = () => void playClip(c)

      // Segment rows, only when the pass actually carved something. A single
      // segment spanning the whole clip adds a line and says nothing.
      const segsEl = row.querySelector('.segs') as HTMLElement
      if (segs.length > 1) {
        segs.forEach((s, i) => {
          const key = `${c.seq}:${i}`
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'seg'
          b.dataset.key = key
          const dur = s.end_ms - s.start_ms
          const short = dur < SPEAKER_MIN_MS
          b.innerHTML = `
            <span class="rng"></span>
            <span class="who"></span>
            <span class="short"></span>
            <span class="val"></span>`
          ;(b.querySelector('.rng') as HTMLElement).textContent =
            `${secs(s.start_ms)}–${secs(s.end_ms)}s`
          const who = b.querySelector('.who') as HTMLElement
          who.textContent = s.speaker
            ? nameMap[s.speaker]
              ? `${nameMap[s.speaker]} (${s.speaker})`
              : s.speaker
            : 'unlabelled'
          if (!s.speaker) who.className = 'who none'
          // Under the measured 2500ms floor the score is not evidence either
          // way, so the segment is marked rather than silently trusted.
          ;(b.querySelector('.short') as HTMLElement).textContent = short
            ? `${dur}ms — under floor`
            : ''
          ;(b.querySelector('.val') as HTMLElement).textContent = s.score.toFixed(3)
          b.onclick = () => void playSegment(c, s, key)
          segsEl.appendChild(b)
        })
      }

      listEl.appendChild(row)
    }
    say(`${clips.length} shown`)
  }

  function setFilter(all: boolean) {
    if (all === showAll) return
    showAll = all
    needBtn.className = all ? 'f-need' : 'f-need on'
    allBtn.className = all ? 'f-all on' : 'f-all'
    void loadReview()
  }

  pick.onchange = () => void loadReview()
  needBtn.onclick = () => setFilter(false)
  allBtn.onclick = () => setFilter(true)
  ;(root.querySelector('.refresh') as HTMLButtonElement).onclick = () => void loadSessions()

  void loadSessions()
}