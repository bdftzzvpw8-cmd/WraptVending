// Netlify build: copy only the public site into dist/ (publish = "dist").
// Publishing the repo root would also serve node_modules, package files, netlify.toml and tooling.
// New pages and folders at the root are published automatically; add anything private to SKIP.
import { cpSync, readdirSync, rmSync } from 'node:fs';

const SKIP = new Set(['dist', 'netlify', 'node_modules', '_private', 'package.json', 'package-lock.json', 'netlify.toml', 'build.mjs']);
rmSync('dist', { recursive: true, force: true });
const items = readdirSync('.').filter(f => !f.startsWith('.') && !SKIP.has(f));
for (const f of items) cpSync(f, `dist/${f}`, { recursive: true });
console.log(`dist/: ${items.length} entries — ${items.join(', ')}`);
