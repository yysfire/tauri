#!/usr/bin/env node
/**
 * Template: agent harness (build -> launch -> drive -> evidence).
 * Copy to `agent/run.mjs`. It writes artifacts/agent-summary.json so an agent
 * can decide what to fix without parsing the whole WDIO log.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const artifacts = path.join(root, 'artifacts')
const appDir = process.env.TAURI_E2E_APP_DIR ?? 'src-tauri'

fs.rmSync(artifacts, { recursive: true, force: true })
fs.mkdirSync(artifacts, { recursive: true })
fs.rmSync(path.join(root, 'logs'), { recursive: true, force: true })

const headless = !process.env.DISPLAY
const hasXvfb = spawnSync('which', ['xvfb-run'], { encoding: 'utf8' }).status === 0
const env = {
  ...process.env,
  ...(headless ? { WEBKIT_DISABLE_COMPOSITING_MODE: '1' } : {}),
}

function readJunit() {
  const dir = path.join(artifacts, 'junit')
  if (!fs.existsSync(dir)) return { suites: 0, tests: 0, failures: 0, failed: [] }

  let suites = 0
  let tests = 0
  let failures = 0
  const failed = []

  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.xml'))) {
    const xml = fs.readFileSync(path.join(dir, file), 'utf8')
    suites += 1
    tests += Number((xml.match(/tests="(\d+)"/) ?? [0, 0])[1])
    failures += Number((xml.match(/failures="(\d+)"/) ?? [0, 0])[1])
    for (const match of xml.matchAll(
      /<testcase\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/testcase>/g
    )) {
      if (match[2].includes('<failure')) failed.push(match[1])
    }
  }

  return { suites, tests, failures, failed }
}

function collectFrontendLog() {
  const dir = path.join(root, 'logs')
  if (!fs.existsSync(dir)) return { logFile: null, appLines: 0, captured: false }

  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort()
  if (!files.length) return { logFile: null, appLines: 0, captured: false }

  const latest = files[files.length - 1]
  const source = path.join(dir, latest)
  const text = fs.readFileSync(source, 'utf8')
  const appLines = text.split('\n').filter((line) => line.includes('[Tauri:Frontend:'))

  fs.copyFileSync(source, path.join(artifacts, 'frontend-log-full.txt'))
  fs.writeFileSync(path.join(artifacts, 'frontend-log.txt'), appLines.join('\n'))

  return { logFile: latest, appLines: appLines.length, captured: appLines.length > 0 }
}

function summarize(ok, failedStep = null) {
  const summary = {
    ok,
    failedStep,
    headless,
    junit: readJunit(),
    frontendLog: collectFrontendLog(),
    screenshots: fs.existsSync(artifacts)
      ? fs.readdirSync(artifacts).filter((name) => name.endsWith('.png'))
      : [],
    stateFiles: fs.existsSync(artifacts)
      ? fs.readdirSync(artifacts).filter((name) => name.endsWith('.state.json'))
      : [],
    artifactsDir: artifacts,
  }

  fs.writeFileSync(
    path.join(artifacts, 'agent-summary.json'),
    JSON.stringify(summary, null, 2)
  )
  console.log('\n=== agent summary ===')
  console.log(JSON.stringify(summary, null, 2))
}

function step(label, command, args) {
  const started = Date.now()
  console.log(`\n=== ${label} ===`)
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  if (result.status !== 0) {
    console.error(`\n[agent] failed: ${label} (exit ${result.status}, ${elapsed}s)`)
    summarize(false, label)
    process.exit(result.status ?? 1)
  }

  console.log(`[agent] ${label} ok (${elapsed}s)`)
}

step('build frontend', 'npm', ['run', 'build:web'])
step('build app', 'cargo', [
  'build',
  '--manifest-path',
  `${appDir}/Cargo.toml`,
  '--features',
  'wdio',
])

const wdio = ['./node_modules/.bin/wdio', 'run', 'wdio.conf.js']
if (headless && hasXvfb) {
  step('run e2e suite', 'xvfb-run', ['-a', ...wdio])
} else {
  step('run e2e suite', wdio[0], wdio.slice(1))
}

summarize(true)
