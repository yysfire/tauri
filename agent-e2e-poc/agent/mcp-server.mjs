#!/usr/bin/env node
/**
 * Minimal MCP server for exploratory debugging of the PoC app.
 *
 * It talks W3C WebDriver straight to the in-app embedded server, so an agent
 * can drive the real desktop app without WDIO. Diagnostics go to stderr;
 * stdout is reserved for the MCP protocol.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const root = path.resolve(import.meta.dirname, '..')
const binary = path.join(root, 'src-tauri/target/debug/agent-e2e-poc')
const fixture = path.join(root, 'fixtures/sample.txt')
const artifacts = path.join(root, 'artifacts/mcp')
const port = Number(process.env.POC_WEBDRIVER_PORT ?? 4455)
const headless = !process.env.DISPLAY
const hasXvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'
let child = null
let sessionId = null
let output = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function remember(chunk) {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim()) output.push(line.trim())
  }
  if (output.length > 400) output = output.slice(-300)
}

async function wd(method, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message ?? `WebDriver ${response.status}`)
  }
  return payload.value
}

async function waitForServer(timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const status = await wd('GET', '/status')
      if (status?.ready) return
    } catch {
      // server not up yet
    }
    await sleep(400)
  }
  throw new Error('embedded WebDriver server did not become ready')
}

async function startApp() {
  if (sessionId) return sessionId
  if (!fs.existsSync(binary)) {
    throw new Error(`app binary not found at ${binary}; run "npm run build" first`)
  }

  const args = [`--fake-file=${fixture}`]
  const command = headless && hasXvfb ? 'xvfb-run' : binary
  const argv = headless && hasXvfb ? ['-a', binary, ...args] : args

  child = spawn(command, argv, {
    cwd: root,
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      ...(headless ? { WEBKIT_DISABLE_COMPOSITING_MODE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    // New process group so stop_app can take the app and Xvfb down together.
    detached: true,
  })
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  await waitForServer()
  const session = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'tauri',
        'tauri:options': { application: binary },
      },
    },
  })
  sessionId = session.sessionId
  return sessionId
}

async function stopApp() {
  if (sessionId) {
    await wd('DELETE', `/session/${sessionId}`).catch(() => {})
    sessionId = null
  }
  if (child) {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
    child = null
    await sleep(400)
  }
}

async function element(selector) {
  if (!sessionId) await startApp()
  const found = await wd('POST', `/session/${sessionId}/element`, {
    using: 'css selector',
    value: selector,
  })
  const id = found[ELEMENT_KEY]
  if (!id) throw new Error(`no element matched ${selector}`)
  return id
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })

const server = new McpServer({ name: 'agent-e2e-poc', version: '0.1.0' })

server.registerTool(
  'start_app',
  {
    description: 'Launch the desktop app and open a WebDriver session.',
    inputSchema: {},
  },
  async () => {
    const id = await startApp()
    return text(`app started, session ${id} on port ${port}`)
  }
)

server.registerTool(
  'stop_app',
  { description: 'Close the WebDriver session and terminate the app.', inputSchema: {} },
  async () => {
    await stopApp()
    return text('app stopped')
  }
)

server.registerTool(
  'read_state',
  {
    description: 'Read the structured app state exposed by the frontend.',
    inputSchema: {},
  },
  async () => {
    if (!sessionId) await startApp()
    // Use the async script channel so the latest Rust state is read through
    // IPC instead of relying on the last rendered snapshot.
    const state = await wd('POST', `/session/${sessionId}/execute/async`, {
      script: `var done = arguments[arguments.length - 1];
        window.__TAURI__.core.invoke('debug_state').then(done).catch(function (error) { done({ error: String(error) }); });`,
      args: [],
    })
    return text(JSON.stringify(state, null, 2))
  }
)

server.registerTool(
  'click',
  {
    description: 'Click an element by CSS selector.',
    inputSchema: { selector: z.string().describe('CSS selector, e.g. [data-testid="inc"]') },
  },
  async ({ selector }) => {
    const id = await element(selector)
    await wd('POST', `/session/${sessionId}/element/${id}/click`, {})
    await sleep(150)
    return text(`clicked ${selector}`)
  }
)

server.registerTool(
  'type',
  {
    description: 'Type text into a form field by CSS selector.',
    inputSchema: {
      selector: z.string().describe('CSS selector of the input'),
      value: z.string().describe('Text to type'),
    },
  },
  async ({ selector, value }) => {
    const id = await element(selector)
    await wd('POST', `/session/${sessionId}/element/${id}/value`, {
      text: value,
      value: [...value],
    })
    await sleep(200)
    return text(`typed into ${selector}`)
  }
)

server.registerTool(
  'screenshot',
  { description: 'Capture the webview and return the image plus its file path.', inputSchema: {} },
  async () => {
    if (!sessionId) await startApp()
    const base64 = await wd('GET', `/session/${sessionId}/screenshot`)
    fs.mkdirSync(artifacts, { recursive: true })
    const file = path.join(artifacts, `shot-${Date.now()}.png`)
    fs.writeFileSync(file, Buffer.from(base64, 'base64'))
    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/png' },
        { type: 'text', text: `saved to ${file}` },
      ],
    }
  }
)

server.registerTool(
  'read_logs',
  { description: 'Return recent app stdout/stderr lines.', inputSchema: {} },
  async () => text(output.slice(-80).join('\n') || '(no output captured)')
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`[mcp] agent-e2e-poc server ready on stdio (webdriver port ${port})`)

const shutdown = async () => {
  await stopApp()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
