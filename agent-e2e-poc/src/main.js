const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args)
const q = (id) => document.querySelector(`[data-testid="${id}"]`)

// The bridge is only bundled for the "wdio" build mode so a release build
// never ships the automation surface.
const wdioEnabled = import.meta.env.MODE === 'wdio'

// Tauri freezes every namespace on the global API, so the WDIO plugin cannot
// defineProperty its invoke interceptor on `window.__TAURI__.core` — mocks
// silently fall through to the real backend. `window.__TAURI__` itself is a
// plain object, so swapping in a writable shallow clone restores interception
// for application-initiated invokes.
function unfreezeTauriCore() {
  const api = window.__TAURI__
  if (!api?.core || !Object.isFrozen(api.core)) return false
  api.core = { ...api.core }
  return true
}

async function loadWdioBridge() {
  if (!wdioEnabled) return
  try {
    const patched = unfreezeTauriCore()
    await import('@wdio/tauri-plugin')
    console.info(`[poc] wdio bridge ready (core unfrozen: ${patched})`)
  } catch (error) {
    console.warn('[poc] wdio bridge unavailable', error)
  }
}

function setCount(value) {
  q('count').textContent = String(value)
}

// Metadata comes from Rust, but the counter itself is rendered from the
// command's return value so an IPC mock is visible in the UI.
async function syncMeta() {
  const state = await invoke('debug_state')
  q('last-action').textContent = state.last_action || 'none'
  q('greeting').textContent = state.name ? `Hello, ${state.name}` : 'Hello, stranger'
  window.__APP_STATE__ = state
}

async function act(action, fn) {
  q('app-ready').textContent = 'busy'
  try {
    const value = await fn()
    console.info(`[poc] ${action} ok`, value)
    return value
  } catch (error) {
    console.error(`[poc] ${action} failed`, error)
    q('last-action').textContent = `error: ${String(error)}`
    return null
  } finally {
    await syncMeta()
    q('app-ready').textContent = 'ready'
  }
}

async function boot() {
  await loadWdioBridge()

  q('inc').addEventListener('click', async () => {
    const count = await act('increment', () => invoke('increment'))
    if (count !== null) setCount(count)
  })

  q('reset').addEventListener('click', async () => {
    const count = await act('reset', () => invoke('reset'))
    if (count !== null) setCount(count)
  })

  q('name').addEventListener('input', async (event) => {
    const name = await act('set_name', () => invoke('set_name', { name: event.target.value }))
    if (name !== null) q('greeting').textContent = `Hello, ${name}`
  })

  const state = await invoke('debug_state')
  setCount(state.count)
  await syncMeta()
  q('app-ready').textContent = 'ready'
  document.documentElement.dataset.ready = 'true'
  console.info('[poc] app ready')
}

boot()
