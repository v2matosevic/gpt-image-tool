// A real stdio handshake and local tool call. Does not read credentials or spend quota.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.js')] });
const client = new Client({ name: 'gpt-image-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const expected = ['generate_image', 'edit_image', 'upscale_image', 'export_web_assets', 'remove_background', 'compose_overlay', 'create_social_card', 'create_social_carousel', 'strip_image_metadata', 'list_image_presets'];
  assert.deepEqual(tools.map(t => t.name).sort(), expected.sort());
  const result = await client.callTool({ name: 'list_image_presets', arguments: { category: 'webdev' } });
  assert.ok(!result.isError);
  const catalog = JSON.parse(result.content.find(c => c.type === 'text').text);
  assert.ok(catalog.presets.some(p => p.id === 'hero-3d'));
  console.log(`MCP handshake passed: ${tools.length} tools; webdev catalog callable without credentials.`);
} finally { await client.close(); }
