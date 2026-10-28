# Tauri Agent E2E

This plugin packages a practical, tested workflow for letting an AI agent drive and
verify a Tauri desktop app end to end.

What it gives the agent:

- A **skill** (`tauri-e2e`) with the setup checklist, contracts, failure triage and guardrails.
- **Templates** for the harness, WebdriverIO config, Rust state command and CI job.
- A **zero-dependency MCP server** with tools to launch the app, click, type, screenshot,
  read structured state and logs, and run the whole suite.

Start with the skill. If the host loads plugin MCP servers automatically, the
`tauri-e2e` server is available; otherwise run it directly:

```bash
TAURI_E2E_PROJECT=/path/to/tauri/app node mcp/server.mjs
```

The MCP server reads configuration from the environment:

| Variable | Default | Purpose |
|---|---|---|
| `TAURI_E2E_PROJECT` | current directory | Tauri project root |
| `TAURI_E2E_BINARY` | auto-detected | Built app binary |
| `TAURI_E2E_PORT` | `4445` | Embedded WebDriver port |
| `TAURI_E2E_STATE_COMMAND` | `debug_state` | Structured state command |

Tools never touch OS-level UI. Native dialogs must be replaced by deterministic
test doubles in the app, as described in the skill.
