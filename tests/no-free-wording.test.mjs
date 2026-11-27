// Host-side cost is "no upfront cost". Never "free", "zero cost", "costs you nothing" or "nothing to pay"
// (sir's Wrapt rules; a host who chooses a custom wrap pays a one-time $200 fee, so "free" is untrue).
// no-commission-public.test.mjs already bans some of these on public pages; this covers what it skips:
// the outreach templates and AI prompts in netlify/ (the auto-ack email goes straight to leads) and command.html.
// A line that says NEVER is the rule itself, quoting the banned words, so it is exempt.
// Run: node --test tests/no-free-wording.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function walk(dir, rel) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const r = `${rel}/${name}`;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, r));
    else if (['.mjs', '.js', '.html'].includes(extname(name))) out.push(r);
  }
  return out;
}

const files = [...walk(join(ROOT, 'netlify'), 'netlify'), 'command.html'];

// "free" alone has innocent uses here (toll-free numbers, free WiFi in prospect notes, "free the claim"),
// so only "free" said about the cooler, the placement or the host is banned.
const BANNED = [
  /zero cost/i,
  /at no cost/i,
  /costs? you nothing/i,
  /nothing to pay/i,
  /free (to|for) the host/i,
  /\bfree\b,?\s+(custom|smart|cooler|vending|machine|placement|install)/i,
  /(places|place|placing)\s+(a\s+)?free\b/i,
  // Outreach never mentions a custom wrap, the host's branding, a mockup or a wrap fee (sir, 2026-11-27: "we don't
  // need to mention custom wraps. its in our name").
  /custom[- ]wrap/i,
  /wrapped (in|with) (your|the host'?s?|their)/i,
  /mock-?up/i,
  /(your|the host'?s?) (branding|logo|colou?rs)\b/i,
];

test('the scan covers the auto-ack email, the drafting prompts and Command', () => {
  for (const f of ['netlify/functions/ack.mjs', 'netlify/functions/lib/wrapt-agents.mjs', 'netlify/functions/lib/notes.mjs', 'command.html']) {
    assert.ok(files.includes(f), f);
  }
});

for (const f of files) {
  test(`no "free", "zero cost" or custom-wrap wording in ${f}`, () => {
    const hits = [];
    readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
      if (/\bNEVER\b/.test(line)) return;
      for (const re of BANNED) {
        const m = line.match(re);
        if (m) hits.push(`${f}:${i + 1} ${re} → …${line.slice(Math.max(0, m.index - 40), m.index + 40).trim()}…`);
      }
    });
    assert.deepEqual(hits, []);
  });
}
