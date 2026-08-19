/**
 * Tab bar for the phone panels.
 *
 * Creates one host <div> per tab and hands them back. Panels are mounted into
 * those hosts ONCE, at startup — never on tab switch. mountSessions()
 * registers callbacks that main.ts drives through setLiveSession(), so
 * remounting would leave those pointing at detached DOM.
 *
 * Hosts are appended to document.body, matching mountSettings() and
 * mountSessions(). #app is left where it is: ui.ts owns it and overwrites it
 * wholesale with innerHTML, so nothing may be mounted inside it.
 *
 * Switching a tab dispatches TAB_HIDE on the outgoing host and TAB_SHOW on the
 * incoming one. Nothing listens yet; review.ts will use TAB_HIDE to stop
 * playback once there is an <audio> element to stop.
 */

export const TAB_SHOW = 'g2:tabshow'
export const TAB_HIDE = 'g2:tabhide'

const CSS = `
.g2t { position: sticky; top: 0; z-index: 5; display: flex; gap: 6px;
       padding: 8px 12px; margin: 0 auto; max-width: 560px;
       background: #232323; border-bottom: 1px solid #3E3E3E;
       box-sizing: border-box; }
.g2t button { flex: 1; background: #2E2E2E; color: #bbb; border: 1px solid #3E3E3E;
              border-radius: 8px; padding: 11px 8px; font: 600 13px/1 system-ui, sans-serif;
              touch-action: manipulation; }
.g2t button:active { background: #3E3E3E; }
.g2t button.on { background: #6cf; color: #062; border-color: #6cf; }

.g2p { max-width: 560px; margin: 0 auto; }
/* Belt and braces: any later rule that sets display on .g2p would defeat the
   hidden attribute silently. */
.g2p[hidden] { display: none; }

/* ui.ts sets #app { height: 100% }, which parks the tab bar a full screen
   below the fold on the phone. Sized to content instead; .transcript keeps its
   own min-height so the caption box does not collapse. Delete this one rule to
   get the old behaviour back. */
#app { height: auto; }
`

/**
 * Build the bar and return name -> host element.
 * The first name is the tab shown at startup.
 */
export function mountTabs(names: string[]): Record<string, HTMLElement> {
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const nav = document.createElement('nav')
  nav.className = 'g2t'
  document.body.appendChild(nav)

  const hosts: Record<string, HTMLElement> = {}
  const buttons: Record<string, HTMLButtonElement> = {}

  for (const name of names) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = name
    b.onclick = () => show(name)
    nav.appendChild(b)
    buttons[name] = b

    const host = document.createElement('div')
    host.className = 'g2p'
    host.hidden = true
    document.body.appendChild(host)
    hosts[name] = host
  }

  let active = ''

  function show(name: string) {
    if (name === active || !hosts[name]) return
    if (active) {
      hosts[active].hidden = true
      hosts[active].dispatchEvent(new CustomEvent(TAB_HIDE))
    }
    active = name
    hosts[name].hidden = false
    for (const n of names) buttons[n].className = n === name ? 'on' : ''
    hosts[name].dispatchEvent(new CustomEvent(TAB_SHOW))
  }

  if (names.length) show(names[0])
  return hosts
}