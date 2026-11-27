// A real stdio handshake and local tool call. Does not read credentials or spend quota.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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
  const studio = ['studio_guide', 'studio_list', 'studio_get', 'studio_create', 'studio_edit', 'studio_run', 'studio_status', 'studio_view'];
  const expected = ['generate_image', 'preview_image_request', 'export_logo_kit', 'create_brand_board', 'edit_image', 'upscale_image', 'export_web_assets', 'remove_background', 'compose_overlay', 'create_social_card', 'create_social_carousel', 'strip_image_metadata', 'list_image_presets', ...studio];
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
  // Studio, offline: create with a local reference, approve it, edit concurrently from the CLI,
  // run the (local) handoff through the detached worker, then view. No provider is called.
  const studioProject = join(scratch, 'studio-project');
  await mkdir(join(studioProject, 'img'), { recursive: true });
  const { encodePng } = await import(pathToFileURL(resolve('dist/bgremove.js')).href);
  const px = Buffer.alloc(32 * 32 * 4); for (let i = 0; i < 32 * 32; i++) px.set(i % 32 < 16 ? [200, 120, 40, 255] : [30, 60, 90, 255], i * 4);
  await writeFile(join(studioProject, 'img', 'mock.png'), encodePng({ width: 32, height: 32, data: px }));
  const call = async (name, args, expectError = false) => { const r = await client.callTool({ name, arguments: { project: studioProject, ...args } }); assert.equal(Boolean(r.isError), expectError, `${name}: ${r.content?.[0]?.text}`); return r.content[0].text; };
  assert.match(await call('studio_guide', { topic: 'nodes' }), /## handoff/);
  const created = await call('studio_create', { name: 'Smoke', nodes: [{ ref: 'mock', type: 'reference', settings: { path: 'img/mock.png', role: 'subject' } }, { ref: 'pick', type: 'gallery' }, { ref: 'hand', type: 'handoff', settings: { intent: 'Smoke test package' } }], connections: [{ from: 'mock', to: 'pick' }, { from: 'pick', to: 'hand' }] });
  assert.match(created, /no approved image reaches this handoff/);
  const bad = await client.callTool({ name: 'studio_edit', arguments: { project: studioProject, graph: 'smoke', ops: [{ op: 'set', node: 'hand', settings: { intnet: 'x' } }] } });
  assert.ok(bad.isError); assert.match(bad.content[0].text, /Did you mean "intent"/);
  const cliEdit = new Promise((res, rej) => {
    const c = spawn(process.execPath, [resolve('dist/cli.js'), 'studio', 'edit', 'smoke', '--project', studioProject, '--actor', 'cli-smoke', '--json', '--ops', JSON.stringify([{ op: 'note', on: 'hand', text: 'from the CLI' }])], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', d => (out += d)); c.on('exit', code => (code === 0 ? res(JSON.parse(out)) : rej(new Error(out))));
  });
  const noLook = await call('studio_edit', { graph: 'smoke', ops: [{ op: 'approve', take: 'mock/t1', note: 'smoke' }] }, true);
  assert.match(noLook, /NO_LOOK[\s\S]*op:"critique"/);
  await call('studio_edit', { graph: 'smoke', ops: [{ op: 'critique', take: 'mock/t1', summary: 'flat test swatch, fine for a smoke run' }, { op: 'approve', take: 'mock/t1', note: 'smoke' }] });
  const cli = await cliEdit;
  assert.equal(cli.ok, true);
  const got = await call('studio_get', { graph: 'smoke' });
  assert.match(got, /revision 2/); // approval is state, not definition assert.match(got, /from the CLI/);
  const ran = await call('studio_run', { graph: 'smoke', scope: 'hand', wait_seconds: 30 });
  assert.match(ran, /Run r\S+ \(hand\): done/, ran);
  assert.match(await readFile(join(studioProject, '.gptimage', 'studio', 'smoke', 'handoff', 'hand', 'handoff.md'), 'utf8'), /Smoke test package/);
  assert.match(await call('studio_view', { graph: 'smoke' }), /preview /);
  assert.match(await call('studio_list', {}), /smoke/);
  console.log(`MCP handshake passed: ${tools.length} tools; preset catalog, preview, logo kit, brand board and a Studio loop (create, refusal, concurrent CLI edit, detached handoff run, view) called offline.`);
} finally { await client.close(); await rm(scratch, { recursive: true, force: true }); }
