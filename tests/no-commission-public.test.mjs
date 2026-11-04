// Commission is a private conversation between Wrapt and each location partner (sir, 2026-11-03).
// Nothing the public can load (including view-source: comments, JS constants, JSON-LD) may mention it.
// Run: node --test tests/no-commission-public.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Mirrors build.mjs: every root entry that is not in SKIP gets published to dist/.
const BUILD_SKIP = new Set(['dist', 'netlify', 'node_modules', '_private', 'tests', 'scripts', 'package.json', 'package-lock.json', 'netlify.toml', 'build.mjs']);
// Published but out of scope by sir's instruction: command.html is the key-gated internal CRM.
const PRIVATE_PAGES = new Set(['command.html']);
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.json', '.webmanifest', '.xml', '.txt', '.svg', '.css', '.md']);

function walk(dir, rel = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const r = rel ? `${rel}/${name}` : name;
    if (!rel && (BUILD_SKIP.has(name) || PRIVATE_PAGES.has(name))) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, r));
    else if (TEXT_EXT.has(extname(name).toLowerCase())) out.push(r);
  }
  return out;
}

const files = walk(ROOT);
const read = f => readFileSync(join(ROOT, f), 'utf8');

// Case-insensitive. No allowlist is needed today: none of these terms has an innocent use on the site.
// \bNGR\b is word-bounded so it cannot fire inside unrelated words; if 'deposit' ever needs an innocent
// use (e.g. a bottle deposit), add a narrow, commented exception here rather than loosening the pattern.
const BANNED = [
  /commission/i,
  /\bNGR\b/i,
  /net gross revenue/i,
  /host_?share/i,
  /you earn/i,
  /earns from/i,
  /revenue share/i,
  /deposit/i,
  /payout/i,
  /nothing to pay/i,
  /zero cost/i,
];

test('the public file list is the published site minus the two private pages', () => {
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('proposal.html'));
  assert.ok(files.includes('leave-behind.html'));
  assert.ok(files.includes('vending-machines-spring-hill-tn.html'));
  assert.ok(!files.includes('command.html'));
  assert.ok(!files.includes('machines.html'));
});

for (const f of files) {
  test(`no commission or host earnings in ${f}`, () => {
    const src = read(f);
    const hits = [];
    for (const re of BANNED) {
      const m = src.match(re);
      if (m) {
        const i = m.index;
        hits.push(`${re} → …${src.slice(Math.max(0, i - 40), i + 40).replace(/\s+/g, ' ')}…`);
      }
    }
    assert.deepEqual(hits, []);
  });
}

for (const f of files.filter(f => f.endsWith('.html'))) {
  test(`JSON-LD parses in ${f}`, () => {
    const blocks = [...read(f).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const [, json] of blocks) assert.doesNotThrow(() => JSON.parse(json));
  });
}
