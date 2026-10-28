import fs from 'node:fs'
import path from 'node:path'

const ARTIFACTS = path.resolve('artifacts')
fs.mkdirSync(ARTIFACTS, { recursive: true })

const readState = () =>
  browser.tauri.execute(async ({ core }) => core.invoke('debug_state'))

const saveEvidence = async (name) => {
  await browser.saveScreenshot(path.join(ARTIFACTS, `${name}.png`))
  const state = await readState()
  fs.writeFileSync(
    path.join(ARTIFACTS, `${name}.state.json`),
    JSON.stringify(state, null, 2)
  )
}

describe('agent-e2e-poc', () => {
  it('boots, reports ready, and exposes backend state', async () => {
    await $('[data-testid="title"]').waitForDisplayed({ timeout: 30000 })

    await browser.waitUntil(
      async () => (await $('[data-testid="app-ready"]').getText()) === 'ready',
      { timeout: 30000, timeoutMsg: 'app never reported ready' }
    )

    const state = await readState()
    expect(state.count).toBe(0)
    expect(state.name).toBe('')

    await saveEvidence('01-boot')
  })

  it('increments through the real IPC path', async () => {
    const inc = $('[data-testid="inc"]')
    await inc.click()
    await inc.click()
    await inc.click()

    await expect($('[data-testid="count"]')).toHaveText('3')

    const state = await readState()
    expect(state.count).toBe(3)
    expect(state.last_action).toBe('increment')

    await saveEvidence('02-counter')
  })

  it('persists typed input in Rust state', async () => {
    const input = $('[data-testid="name"]')
    await input.setValue('Ada')

    await expect($('[data-testid="greeting"]')).toHaveText('Hello, Ada')

    const state = await readState()
    expect(state.name).toBe('Ada')
    expect(state.last_action).toBe('set_name')
  })

  it('mocks an IPC command from the test without touching real state', async () => {
    const mock = await browser.tauri.mock('increment')
    await mock.mockReturnValue(42)

    // The mock routes calls made inside browser.tauri.execute().
    const mocked = await browser.tauri.execute(async ({ core }) =>
      core.invoke('increment')
    )
    expect(mocked).toBe(42)
    expect(mock.calls.length).toBeGreaterThan(0)

    // Rust state must be untouched by the interception.
    const state = await readState()
    expect(state.count).toBe(3)

    await mock.mockRestore()
  })

  it('resumes the real backend after the mock is restored', async () => {
    await $('[data-testid="inc"]').click()
    await expect($('[data-testid="count"]')).toHaveText('4')

    const state = await readState()
    expect(state.count).toBe(4)

    await saveEvidence('03-after-mock')
  })
})
