// Leads no longer carry roi.annualValue (commission is private, 2026-11-03). Backend consumers must
// omit the /yr piece instead of printing '?/yr', keep showing it for old leads that still have it,
// and never put annual/share into proposal links (the host sees that URL).
// Run: node --test tests/lead-roi-annual.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const fn = require('../netlify/functions/submission-created.js');
const command = readFileSync(new URL('../command.html', import.meta.url), 'utf8');

test('SMS roi piece omits /yr when annualValue is missing', () => {
  const s = fn.roiSms({ grade: 'A', monthlyGross: '$1,200' });
  assert.equal(s, ' | Site A: $1,200/mo');
  assert.ok(!s.includes('/yr') && !s.includes('?'));
});

test('SMS roi piece keeps annualValue for old leads', () => {
  assert.equal(fn.roiSms({ grade: 'B', monthlyGross: '$900', annualValue: '$1,080' }), ' | Site B: $900/mo, $1,080/yr');
});

test('email Site score row omits /yr when annualValue is missing', () => {
  assert.equal(fn.roiRowText({ grade: 'A', monthlyGross: '$1,200' }), 'A · $1,200/mo gross');
  assert.equal(
    fn.roiRowText({ grade: 'A', monthlyGross: '$1,200', basis: 'form estimate' }),
    'A · $1,200/mo gross (estimated from form answers)'
  );
});

test('email Site score row keeps annualValue for old leads', () => {
  assert.equal(
    fn.roiRowText({ grade: 'B', monthlyGross: '$900', annualValue: '$1,080' }),
    'B · $900/mo gross · $1,080/yr to host'
  );
});

test('proposal payload carries no annual or share, with or without annualValue', () => {
  const d = { name: 'Pat', company: 'Acme', city: 'Franklin', venue_type: 'Gym', product_interests: 'Snacks' };
  for (const r of [null, { grade: 'A', monthlyGross: '$1,200' }, { grade: 'A', monthlyGross: '$1,200', annualValue: '$1,440' }]) {
    const p = fn.proposalPayload(d, r);
    assert.deepEqual(Object.keys(p).sort(), ['city', 'co', 'grade', 'gross', 'name', 'venue', 'wants']);
  }
});

test('command.html proposal link payload has no annual or share', () => {
  const m = command.match(/const pd=b64u\(JSON\.stringify\(\{([\s\S]*?)\}\)\);/);
  assert.ok(m, 'proposal payload block not found');
  assert.ok(!/annual|share/.test(m[1]), m[1]);
});

test('command.html lead tag only prints /yr when annualValue exists', () => {
  assert.ok(!command.includes("esc(roi.annualValue||'')}/yr"));
  assert.ok(command.includes("roi.annualValue?` · ${esc(roi.annualValue)}/yr`:''"));
});
