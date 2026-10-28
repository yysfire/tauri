import { fileURLToPath } from 'node:url'

const binaryPath = './src-tauri/target/debug/agent-e2e-poc'
// Deterministic stand-in for the OS file picker; read by the app in wdio builds.
const fixturePath = fileURLToPath(new URL('./fixtures/sample.txt', import.meta.url))

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
        appArgs: [`--fake-file=${fixturePath}`],
        driverProvider: 'embedded',
        embeddedPort: 4445,
        startTimeout: 90000,
        commandTimeout: 30000,
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
