// Read-only heuristic scan. Reports locations and categories, never matched secrets.
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { maxBuffer: 128 * 1024 * 1024 });
const entries = git('rev-list', '--objects', '--all').toString().trim().split('\n').map(line => {
  const i = line.indexOf(' '); return { oid: i < 0 ? line : line.slice(0, i), path: i < 0 ? '' : line.slice(i + 1) };
});
const patterns = [
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential value', /["'](?:access_token|refresh_token|client_secret)["']\s*:\s*["'][A-Za-z0-9._-]{32,}["']/],
];
const findings = [];
let blobs = 0;
// One batch process avoids hundreds of git processes on large histories.
const raw = execFileSync('git', ['cat-file', '--batch'], { input: entries.map(x => x.oid).join('\n') + '\n', maxBuffer: 128 * 1024 * 1024 });
let offset = 0;
for (const entry of entries) {
  const end = raw.indexOf(10, offset);
  const [, type, length] = raw.subarray(offset, end).toString().split(' ');
  const size = Number(length);
  if (!Number.isFinite(size)) throw new Error('Unexpected git object header');
  const body = raw.subarray(end + 1, end + 1 + size);
  offset = end + size + 2;
  if (type !== 'blob') continue;
  blobs++;
  if (/(^|\/)(auth\.json|\.env(?:\.(?!example$)[^/]+)?|[^/]+\.(?:pem|key))$/.test(entry.path)) findings.push({ ...entry, category: 'sensitive filename' });
  if (body.includes(0)) continue;
  const text = body.toString();
  for (const [category, pattern] of patterns) if (pattern.test(text)) findings.push({ ...entry, category });
}
console.log(JSON.stringify({ scannedAt: new Date().toISOString(), scope: 'all locally reachable refs, including fetched remote branches and tags', blobs, findings, limitation: 'Heuristic scan, not proof that no secret exists. Review filenames and repository metadata before changing visibility.' }, null, 2));
process.exitCode = findings.length ? 1 : 0;
