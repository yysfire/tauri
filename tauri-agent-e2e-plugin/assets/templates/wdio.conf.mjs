// Template: WebdriverIO config for a Tauri app using the embedded provider.
// Copy to `wdio.conf.js` (requires "type": "module" in package.json).
import fs from 'node:fs'
import path from 'node:path'

const appDir = process.env.TAURI_E2E_APP_DIR ?? 'src-tauri'
const profile = process.env.TAURI_E2E_PROFILE ?? 'debug'

function packageName() {
  try {
    const toml = fs.readFileSync(path.join(appDir, 'Cargo.toml'), 'utf8')
    return toml.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m)?.[1] ?? 'app'
  } catch {
    return 'app'
  }
}

const binaryPath =
  process.env.TAURI_E2E_BINARY ?? path.join(appDir, 'target', profile, packageName())

export const config = {
  runner: 'local',
  specs: ['./test/specs/**/*.spec.js'],
  maxInstances: 1,
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 15000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: [
    'spec',
    [
      'junit',
      {
        outputDir: './artifacts/junit',
        outputFileFormat: (options) => `wdio-${options.cid}.xml`,
      },
    ],
  ],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },
  services: [
    [
      '@wdio/tauri-service',
      {
        appBinaryPath: binaryPath,
        // Example deterministic seam for native dialogs:
        // appArgs: [`--fake-file=${path.resolve('fixtures/sample.txt')}`],
        appArgs: process.env.TAURI_E2E_APP_ARGS
          ? process.env.TAURI_E2E_APP_ARGS.split(' ')
          : [],
        driverProvider: 'embedded',
        embeddedPort: Number(process.env.TAURI_E2E_PORT ?? 4445),
        startTimeout: 90000,
        commandTimeout: 30000,
        // Requires importing '@wdio/tauri-plugin' in the frontend test build.
        captureFrontendLogs: true,
      },
    ],
  ],
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': {
        application: binaryPath,
      },
    },
  ],
}
