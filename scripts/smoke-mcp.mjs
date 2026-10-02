// A real stdio handshake and local tool call. Does not read credentials or spend quota.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const scratch = await mkdtemp(join(tmpdir(), 'gpt-image-mcp-branding-'));
const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.js')] });
const client = new Client({ name: 'gpt-image-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const packageVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version;
  assert.equal(client.getServerVersion()?.version, packageVersion, 'MCP version must match the package release');
  const { tools } = await client.listTools();
  const expected = ['generate_image', 'preview_image_request', 'export_logo_kit', 'create_brand_board', 'edit_image', 'upscale_image', 'export_web_assets', 'remove_background', 'compose_overlay', 'create_social_card', 'create_social_carousel', 'strip_image_metadata', 'list_image_presets'];
  assert.deepEqual(tools.map(t => t.name).sort(), expected.sort());
  for (const name of ["generate_image", "edit_image", "upscale_image", "export_web_assets", "remove_background", "create_social_card", "create_social_carousel"]) {
    const schema = tools.find(t => t.name === name).inputSchema.properties;
    assert.ok(schema.image_model.enum.includes("flare"), `${name} exposes Flare`);
    assert.ok(schema.image_model.enum.includes("sunburst"), `${name} exposes Sunburst`);
    if (schema.quality) assert.ok(schema.quality.enum.includes("max"), `${name} exposes max quality`);
  }
  const refused = await client.callTool({ name: "generate_image", arguments: { prompt: "offline selection check", image_model: "flare", backend: "subscription" } });
  assert.ok(refused.isError);
  assert.match(refused.content[0].text, /does not reliably enforce/);
  const result = await client.callTool({ name: 'list_image_presets', arguments: { category: 'webdev' } });
  assert.ok(!result.isError);
  const catalog = JSON.parse(result.content.find(c => c.type === 'text').text);
  assert.ok(catalog.presets.some(p => p.id === 'hero-3d'));
  const preview = await client.callTool({ name: 'preview_image_request', arguments: { subject: 'a compact leaf monogram', preset: 'logo-monogram', brief: { purpose: 'website brand' }, backend: 'subscription', image_model: 'auto', proof: false } });
  assert.ok(!preview.isError, JSON.stringify(preview));
  const planned = JSON.parse(preview.content.find(c => c.type === 'text').text);
  assert.match(planned.compiledPrompt, /website brand/);
  assert.equal(planned.backend, 'subscription');
  const brand = { name: 'HARNESS', colors: [{ name: 'Ink', role: 'ink', hex: '#183C2F' }, { name: 'Paper', role: 'paper', hex: '#F6F2E9' }], fonts: { heading: { path: resolve('test/fixtures/brand-font.ttf') } }, logos: { mark: resolve('test/fixtures/brand-mark.svg') } };
  const kit = await client.callTool({ name: 'export_logo_kit', arguments: { brand, brand_name: 'HARNESS', out_dir: join(scratch, 'kit'), layouts: ['horizontal'], variants: ['color'], formats: ['png', 'svg'], social: false } });
  assert.ok(!kit.isError, JSON.stringify(kit));
  const exported = JSON.parse(kit.content.find(c => c.type === 'text').text);
  assert.equal(exported.deliverable, 'kit');
  assert.ok(exported.files.some(f => f.format === 'svg' && f.layout === 'horizontal'));
  const board = await client.callTool({ name: 'create_brand_board', arguments: { brand, out_dir: join(scratch, 'board'), layout: 'grid' } });
  assert.ok(!board.isError, JSON.stringify(board));
  const built = JSON.parse(board.content.find(c => c.type === 'text').text);
  assert.doesNotMatch(await readFile(built.svgPath, 'utf8'), /<text\b/);
  console.log(`MCP handshake passed: ${tools.length} tools; preset catalog, preview, logo kit and brand board called offline.`);
} finally { await client.close(); await rm(scratch, { recursive: true, force: true }); }
