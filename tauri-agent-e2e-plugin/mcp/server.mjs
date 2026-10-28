#!/usr/bin/env node
/**
 * Tauri Agent E2E — zero-dependency MCP server.
 *
 * Speaks JSON-RPC over stdio (newline-delimited) and drives the app through the
 * embedded W3C WebDriver server, so no WDIO or npm dependencies are required.
 * Diagnostics go to stderr; stdout carries only the protocol.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const VERSION = '0.1.0'
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

const config = {
  projectRoot: path.resolve(process.env.TAURI_E2E_PROJECT ?? process.cwd()),
  binaryPath: process.env.TAURI_E2E_BINARY ?? null,
  port: Number(process.env.TAURI_E2E_PORT ?? 4445),
  stateCommand: process.env.TAURI_E2E_STATE_COMMAND ?? 'debug_state',
}

const headless = !process.env.DISPLAY
const hasXvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let child = null
let sessionId = null
let output = []

function remember(chunk) {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim()) output.push(line.trim())
  }
  if (output.length > 500) output = output.slice(-300)
}

function resolveBinary() {
  if (config.binaryPath && fs.existsSync(config.binaryPath)) return config.binaryPath

  const cargoToml = path.join(config.projectRoot, 'src-tauri/Cargo.toml')
  let packageName = null
  if (fs.existsSync(cargoToml)) {
    packageName = fs
      .readFileSync(cargoToml, 'utf8')
      .match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1] ?? null
  }

  const names = []
  if (packageName) names.push(packageName)
  const tauriConf = path.join(config.projectRoot, 'src-tauri/tauri.conf.json')
  if (fs.existsSync(tauriConf)) {
    try {
      const productName = JSON.parse(fs.readFileSync(tauriConf, 'utf8')).productName
      if (productName) names.push(productName)
    } catch {
      // ignore malformed config
    }
  }

  for (const profile of ['debug', 'release']) {
    for (const name of names) {
      const candidate = path.join(config.projectRoot, 'src-tauri/target', profile, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }

  throw new Error(
    'Cannot resolve the app binary. Build the app first, pass binaryPath to start_app, ' +
      'or set TAURI_E2E_BINARY.'
  )
}

async function wd(method, pathname, body, timeoutMs = 15000) {
  const response = await fetch(`http://127.0.0.1:${config.port}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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
  throw new Error(
    'Embedded WebDriver did not become ready. Is tauri-plugin-wdio-webdriver registered ' +
      'and built with the wdio feature?'
  )
}

async function startApp(options = {}) {
  if (options.projectRoot) config.projectRoot = path.resolve(options.projectRoot)
  if (options.binaryPath) config.binaryPath = options.binaryPath
  if (options.port) config.port = Number(options.port)
  if (sessionId) return sessionId

  const binary = resolveBinary()
  const extra = Array.isArray(options.args) ? options.args : []
  const command = headless && hasXvfb ? 'xvfb-run' : binary
  const argv = headless && hasXvfb ? ['-a', binary, ...extra] : extra

  child = spawn(command, argv, {
    cwd: config.projectRoot,
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(config.port),
      ...(headless ? { WEBKIT_DISABLE_COMPOSITING_MODE: '1' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  try {
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
    return { binary, sessionId, port: config.port }
  } catch (error) {
    await stopApp()
    const tail = output.slice(-15).join('\n')
    throw new Error(`${error.message}${tail ? `\nApp output:\n${tail}` : ''}`)
  }
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

async function findElement(selector) {
  if (!sessionId) await startApp()
  const found = await wd('POST', `/session/${sessionId}/element`, {
    using: 'css selector',
    value: selector,
  })
  const id = found[ELEMENT_KEY]
  if (!id) throw new Error(`No element matched selector: ${selector}`)
  return id
}

async function readState(command = config.stateCommand) {
  if (!sessionId) await startApp()
  return wd(
    'POST',
    `/session/${sessionId}/execute/async`,
    {
      script: `var done = arguments[arguments.length - 1];
        var fallback = function () { done(window.__APP_STATE__ ?? null); };
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
          window.__TAURI__.core.invoke(${JSON.stringify(command)})
            .then(function (value) { done(value); })
            .catch(fallback);
        } else {
          fallback();
        }`,
      args: [],
    },
    30000
  )
}

function runSuite({ timeoutMs = 900000 } = {}) {
  const harness = path.join(config.projectRoot, 'agent/run.mjs')
  if (!fs.existsSync(harness)) {
    throw new Error(
      'agent/run.mjs not found. Copy assets/templates/agent-run.mjs into the project first.'
    )
  }

  const result = spawnSync(process.execPath, [harness], {
    cwd: config.projectRoot,
    env: { ...process.env, CI: 'true' },
    encoding: 'utf8',
    timeout: timeoutMs,
  })

  const summaryPath = path.join(config.projectRoot, 'artifacts/agent-summary.json')
  const summary = fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
    : null

  if (!summary) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')
    throw new Error(`Suite exited with ${result.status} and produced no summary.\n${tail}`)
  }

  const tail = `${result.stdout ?? ''}`.trim().split('\n').slice(-12).join('\n')
  return { summary, outputTail: tail }
}

const text = (value) => ({ content: [{ type: 'text', text: value }] })

const TOOLS = [
  {
    name: 'start_app',
    description: 'Launch the Tauri app and open an embedded WebDriver session.',
    inputSchema: {
      type: 'object',
      properties: {
        projectRoot: { type: 'string', description: 'Tauri project root' },
        binaryPath: { type: 'string', description: 'Built app binary' },
        port: { type: 'number', description: 'Embedded WebDriver port' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra app arguments' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stop_app',
    description: 'Close the session and terminate the app process group.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'screenshot',
    description: 'Capture the webview as a PNG image and save it under artifacts/mcp.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'click',
    description: 'Click an element matched by a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'type',
    description: 'Type text into an input matched by a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, value: { type: 'string' } },
      required: ['selector', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_state',
    description: 'Read structured app state through the configured IPC command.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'read_logs',
    description: 'Return recent app stdout/stderr lines.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'run_e2e',
    description: 'Run the project E2E harness and return the machine-readable summary.',
    inputSchema: {
      type: 'object',
      properties: { timeoutMs: { type: 'number' } },
      additionalProperties: false,
    },
  },
]

async function callTool(name, args) {
  switch (name) {
    case 'start_app': {
      const result = await startApp(args)
      return text(`Started ${result.binary}\nsession ${result.sessionId}\nport ${result.port}`)
    }
    case 'stop_app':
      await stopApp()
      return text('App stopped')
    case 'screenshot': {
      if (!sessionId) await startApp()
      const base64 = await wd('GET', `/session/${sessionId}/screenshot`)
      const dir = path.join(config.projectRoot, 'artifacts/mcp')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `shot-${Date.now()}.png`)
      fs.writeFileSync(file, Buffer.from(base64, 'base64'))
      return {
        content: [
          { type: 'image', data: base64, mimeType: 'image/png' },
          { type: 'text', text: `Saved to ${file}` },
        ],
      }
    }
    case 'click': {
      const id = await findElement(args.selector)
      await wd('POST', `/session/${sessionId}/element/${id}/click`, {})
      await sleep(150)
      return text(`Clicked ${args.selector}`)
    }
    case 'type': {
      const id = await findElement(args.selector)
      await wd('POST', `/session/${sessionId}/element/${id}/value`, {
        text: args.value,
        value: [...args.value],
      })
      await sleep(200)
      return text(`Typed into ${args.selector}`)
    }
    case 'read_state':
      return text(JSON.stringify(await readState(args.command), null, 2))
    case 'read_logs':
      return text(output.slice(-80).join('\n') || 'No output captured')
    case 'run_e2e': {
      const { summary, outputTail } = runSuite(args)
      return text(`${JSON.stringify(summary, null, 2)}\n\n--- output tail ---\n${outputTail}`)
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: params.protocolVersion ?? '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'tauri-agent-e2e', version: VERSION },
      instructions:
        'Drive the real Tauri app: start_app, click/type, read_state, screenshot, read_logs, ' +
        'and run_e2e. Prefer read_state over inspecting pixels.',
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'tools/call') {
    const name = params.name
    if (!TOOLS.some((tool) => tool.name === name)) {
      throw new Error(`Unknown tool: ${name}`)
    }
    try {
      return await callTool(name, params.arguments ?? {})
    } catch (error) {
      return {
        content: [{ type: 'text', text: String(error?.message ?? error) }],
        isError: true,
      }
    }
  }
  if (method === 'ping') return {}
  throw new Error(`Method not found: ${method}`)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }

  if (message.id === undefined || typeof message.method !== 'string') return
  if (message.method.startsWith('notifications/')) return

  try {
    send({ jsonrpc: '2.0', id: message.id, result: await handle(message.method, message.params ?? {}) })
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: String(error?.message ?? error) },
    })
  }
})

const shutdown = async () => {
  await stopApp()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.error('[tauri-agent-e2e] MCP server ready on stdio')
