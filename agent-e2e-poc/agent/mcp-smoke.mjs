#!/usr/bin/env node
/** Smoke test: drive the real app through the MCP server over stdio. */
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(import.meta.dirname, '..')

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(root, 'agent/mcp-server.mjs')],
  cwd: root,
  stderr: 'inherit',
})

const client = new Client({ name: 'mcp-smoke', version: '0.1.0' })
await client.connect(transport)

const toolText = (result) =>
  result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')

try {
  const tools = await client.listTools()
  console.log('tools:', tools.tools.map((tool) => tool.name).join(', '))

  console.log('start:', toolText(await client.callTool({ name: 'start_app', arguments: {} })))

  console.log('state:', toolText(await client.callTool({ name: 'read_state', arguments: {} })))

  await client.callTool({ name: 'click', arguments: { selector: '[data-testid="inc"]' } })
  await client.callTool({ name: 'click', arguments: { selector: '[data-testid="inc"]' } })

  await client.callTool({
    name: 'type',
    arguments: { selector: '[data-testid="name"]', value: 'Grace' },
  })

  const state = JSON.parse(toolText(await client.callTool({ name: 'read_state', arguments: {} })))
  console.log('state after:', JSON.stringify(state))
  if (state.count !== 2 || state.name !== 'Grace') {
    throw new Error(`unexpected state: ${JSON.stringify(state)}`)
  }

  const shot = await client.callTool({ name: 'screenshot', arguments: {} })
  console.log('screenshot:', toolText({ content: shot.content }))
  if (!shot.content.some((part) => part.type === 'image')) {
    throw new Error('screenshot did not return image content')
  }

  console.log('logs:', toolText(await client.callTool({ name: 'read_logs', arguments: {} })).slice(-200))
} finally {
  await client.callTool({ name: 'stop_app', arguments: {} }).catch(() => {})
  await client.close()
}

console.log('mcp smoke: ok')
