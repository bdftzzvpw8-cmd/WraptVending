// lead-status: the one writer every card goes through (Command, the inbox agent, the auto-reply stamp).
// A logged line is an append, so lines written meanwhile survive; a whole-note edit with `base` is refused
// (409, nothing written) if the card moved on; a read that fails writes nothing (503).
// Run: node --test tests/lead-status.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveCard } from '../netlify/functions/lead-status.js';
import { memoryStore } from './helpers.mjs';

const save = async (store, body) => { const r = await saveCard(store, body); return { status: r.status, j: await r.json() }; };
const seed = (store, id, card) => store.data.set('m:' + id, JSON.stringify(card));

test('append adds one trimmed line to the stored note and keeps the rest of the card', async () => {
  const s = memoryStore();
  seed(s, 'L1', { status: 'contacted', followup: '2026-12-01', note: '[11/20 9:00am] Visited\n', updated: '2026-11-20T15:00:00.000Z' });
  const { status, j } = await save(s, { id: 'L1', append: '  [11/24 2:00pm] Auto-reply sent — thanks  \n' });
  assert.equal(status, 200);
  assert.equal(j.meta.note, '[11/20 9:00am] Visited\n[11/24 2:00pm] Auto-reply sent — thanks');
  assert.equal(s.json('m:L1').status, 'contacted');
  assert.equal(s.json('m:L1').followup, '2026-12-01');
  assert.notEqual(s.json('m:L1').updated, '2026-11-20T15:00:00.000Z');
});

test('append to a card with no note starts it; the note keeps its newest 5000 chars', async () => {
  const s = memoryStore();
  assert.equal((await save(s, { id: 'L2', append: 'first' })).j.meta.note, 'first');
  seed(s, 'L3', { note: 'x'.repeat(4995) });
  const n = (await save(s, { id: 'L3', append: 'newest line' })).j.meta.note;
  assert.equal(n.length, 5000);
  assert.ok(n.endsWith('\nnewest line'));
});

test('a read that throws writes nothing and answers 503 (per-lead blob or the legacy blob)', async () => {
  const s = memoryStore();
  seed(s, 'L1', { status: 'signed', note: 'keep me', updated: 'u1' });
  s.failGet = /^m:L1$/;
  const r1 = await save(s, { id: 'L1', status: 'dead' });
  assert.equal(r1.status, 503);
  assert.match(r1.j.error, /nothing saved/);
  s.failGet = /^meta$/; // no m:L9 yet, so the legacy blob is read — and fails
  assert.equal((await save(s, { id: 'L9', append: 'x' })).status, 503);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.json('m:L1'), { status: 'signed', note: 'keep me', updated: 'u1' });
});

test('a missing card (null read) is a new card; the legacy shared blob is still the fallback base', async () => {
  const s = memoryStore();
  s.data.set('meta', JSON.stringify({ OLD: { status: 'proposal', note: 'from before the split' } }));
  const { j } = await save(s, { id: 'OLD', append: 'new line' });
  assert.equal(j.meta.status, 'proposal');
  assert.equal(j.meta.note, 'from before the split\nnew line');
  assert.equal((await save(s, { id: 'NEW', status: 'contacted' })).j.meta.status, 'contacted');
});

test('whole note with a stale base: 409 with the current card, nothing written', async () => {
  const s = memoryStore();
  const card = { status: 'contacted', note: 'a\n[11/24 2:00pm] Auto-reply sent', updated: '2026-11-24T20:00:00.000Z' };
  seed(s, 'L1', card);
  const { status, j } = await save(s, { id: 'L1', note: 'a\nmy edit', base: '2026-11-24T19:00:00.000Z', status: 'proposal' });
  assert.equal(status, 409);
  assert.equal(j.error, 'conflict');
  assert.deepEqual(j.meta, card);
  assert.deepEqual(s.writes, []);
  assert.deepEqual(s.json('m:L1'), card);
  // an empty base is stale too once the card has a stamp
  assert.equal((await save(s, { id: 'L1', note: 'x', base: '' })).status, 409);
});

test('whole note with the current base, or on a card that was never saved, replaces it', async () => {
  const s = memoryStore();
  seed(s, 'L1', { note: 'old', updated: 'u1' });
  const { status, j } = await save(s, { id: 'L1', note: 'edited', base: 'u1' });
  assert.equal(status, 200);
  assert.equal(j.meta.note, 'edited');
  assert.notEqual(j.meta.updated, 'u1');
  assert.equal((await save(s, { id: 'FRESH', note: 'first', base: '' })).j.meta.note, 'first');
});

test('no base: a whole note replaces as before (older Command copies keep working)', async () => {
  const s = memoryStore();
  seed(s, 'L1', { note: 'server line', updated: 'u9' });
  const { status, j } = await save(s, { id: 'L1', note: 'phone copy' });
  assert.equal(status, 200);
  assert.equal(j.meta.note, 'phone copy');
});

test('base without a note (status, follow-up) is not checked', async () => {
  const s = memoryStore();
  seed(s, 'L1', { note: 'n', updated: 'u2' });
  const { status, j } = await save(s, { id: 'L1', followup: '2026-12-05', base: 'u1' });
  assert.equal(status, 200);
  assert.equal(j.meta.followup, '2026-12-05');
  assert.equal(j.meta.note, 'n');
});

test('validation is unchanged: id, status, payout, follow-up and dates', async () => {
  const s = memoryStore();
  assert.equal((await save(s, {})).status, 400);
  assert.equal((await save(s, { id: 'x'.repeat(81) })).status, 400);
  assert.equal((await save(s, { id: 'L1', status: 'maybe' })).status, 400);
  assert.equal((await save(s, { id: 'L1', payout: 'later' })).status, 400);
  assert.deepEqual(s.writes, []);
  const { j } = await save(s, { id: 'L1', status: 'signed', followup: 'next week', signed_at: '2026-11-24T10:00', coi: 'bogus', phone: '(615) 555-0100 ext<b>', email: '  a@b.co ' });
  assert.equal(j.meta.status, 'signed');
  assert.equal(j.meta.followup, undefined);
  assert.equal(j.meta.signed_at, '2026-11-24');
  assert.equal(j.meta.coi, undefined);
  assert.equal(j.meta.phone, '(615) 555-0100 ');
  assert.equal(j.meta.email, 'a@b.co');
  assert.equal((await save(s, { id: 'L1', followup: '' })).j.meta.followup, '');
});
