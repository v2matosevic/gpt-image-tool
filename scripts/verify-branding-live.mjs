// Manual only. Spends at most three subscription generation requests; never runs in CI.
// Usage: node scripts/verify-branding-live.mjs <brand-kit-spec.json> <output-directory>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
process.env.GPT_IMAGE_MAX_RETRIES = '0';
const { generateImage } = await import('../dist/generate.js');
const { createBrandBoard } = await import('../dist/brandboard.js');
const { resolveBrandPaths } = await import('../dist/branding.js');
const { SubscriptionProvider } = await import('../dist/providers/subscription.js');
const { checkSession } = await import('../dist/auth.js');
if (!process.argv[2] || !process.argv[3]) throw new Error('Provide a brand-kit spec and output directory. This spends up to 3 subscription image requests.');
const specPath = resolve(process.argv[2]), outDir = resolve(process.argv[3]);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
const brand = resolveBrandPaths(spec.brand, dirname(specPath));
const session = await checkSession();
if (!session.ok) throw new Error(session.reason ?? 'Subscription session is invalid.');
const started = new Date().toISOString();
let requests = 0;
const original = SubscriptionProvider.prototype.generate;
SubscriptionProvider.prototype.generate = function(input) {
  if (requests >= 3) throw new Error('The 3-request live-verification budget is exhausted.');
  requests++;
  console.error(`Subscription generation ${requests}/3`);
  return original.call(this, input);
};
await mkdir(outDir, { recursive: true });
const result = { started, backend: 'subscription', quality: 'low', requests: 0, concepts: null, board: null, error: null };
try {
  const concepts = await generateImage({
    subject: `an original abstract folded-leaf symbol for ${brand.name}, using a single continuous ribbon and an open counter; a distinctive simple silhouette`,
    preset: 'logo-mark', brand,
    brief: { purpose: 'logo exploration for a website and studio brand', direction: 'flat geometry, one visual idea, strong negative space', avoid: ['lettering', 'presentation mockups'] },
    style: { color: brand.colors.map(c => c.hex).join(', ') },
    references: [], styleReference: [], count: 2, series: 1, contactSheet: true,
    quality: 'low', proof: false, backend: 'subscription', imageModel: 'auto', outputPath: join(outDir, 'concept.png'),
  });
  result.concepts = { paths: [concepts.path, ...(concepts.variants ?? [])], sheet: concepts.contactSheet, qa: concepts.qa };
  const board = await createBrandBoard({
    brand, outDir: join(outDir, 'board'), layout: 'editorial', quality: 'low', backend: 'subscription', imageModel: 'auto',
    assets: result.concepts.paths.map((path, i) => ({ path, label: `Raster logo exploration ${i + 1}`, fit: 'contain' })),
    generate: [{ subject: `a quiet studio study of folded paper and one natural leaf, ${brand.colors.map(c => c.hex).join(', ')} palette, warm raking light, no lettering or logos`, preset: 'brand-material', label: 'Generated material and light direction' }],
    keywords: ['Grounded', 'Precise', 'Warm'],
  });
  result.board = { path: board.path, svgPath: board.svgPath, manifest: board.manifest };
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  result.requests = requests;
  result.finished = new Date().toISOString();
  await writeFile(join(outDir, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
