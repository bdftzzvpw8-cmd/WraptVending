// Leave-behind page: static checks (no browser here). Run: node --test tests/leave-behind.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../leave-behind.html', import.meta.url), 'utf8');
const visible = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('inline script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(script));
});

test('page is noindex and has print CSS', () => {
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /@media print/);
});

test('no banned claims anywhere in the visible copy', () => {
  const banned = /\bfree\b|zero cost|costs? you nothing|nothing to pay|mockup|wrapped|every machine|90.day (?:trial|wait)|trial period(?<!no trial period)|\$1,000|per cent|guarantee|commission|payout|\bNGR\b/i;
  const hit = visible.match(banned);
  assert.equal(hit, null, 'found: ' + (hit && hit[0]));
});

test('no percentage and no commission details on the page', () => {
  assert.equal(/\d+(\.\d+)?\s*%/.test(visible), false);
  assert.equal(/commission|rate=/i.test(html), false);
});

test('the response line is exactly the approved wording; insurance stays blank until supplied', () => {
  assert.ok(script.includes('const RESPONSE_PROMISE = "We respond to any service request within 24 hours.";'));
  assert.match(script, /const INSURANCE_LINE   = "";/);
});

test('states the settled terms', () => {
  for (const s of ['No upfront cost', '$200 install fee', 'select locations']) {
    assert.ok(html.includes(s), 'missing: ' + s);
  }
});

test('no placed-host names, machine counts or wrap dollar figures', () => {
  assert.equal(/Firestone|Quick Cash|machines? (placed|installed)|\d+ machines/i.test(visible), false);
});

test('removal is 30 days notice, not the old 60-day exit wording', () => {
  assert.ok(html.includes("30 days' notice"));
  assert.equal(/60 days|reimburs/i.test(visible), false);
});
