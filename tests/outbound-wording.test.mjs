// Text the functions send or draft for hosts: the auto-reply to site leads (ack.mjs) and the brief's draft templates.
// Neither is a page, so no-commission-public.test.mjs never sees it. Same rules: no commission, rate or payout,
// never "free"/"zero cost", no wrap promise or mockup, no page count; and the auto-reply goes to one address only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ackEmail, runAck, soleAddress } from '../netlify/functions/ack.mjs';
import { templateDraft, OFF_TERMS } from '../netlify/functions/lib/wrapt-agents.mjs';
import { memoryStore } from './helpers.mjs';

const banned = /\bfree\b|zero cost|costs? you nothing|nothing to pay|commission|\bNGR\b|net sales|\d+\s*%|payout|paid monthly|mockup|custom-wrapped|wrapped in|in your colors|two pages|page agreement|\btrial\b|minimum|install fee/i;
const venues = ['Gym / fitness', 'Apartment', 'Hotel', 'Office / coworking', 'Dealership', 'Church', 'Laundromat', ''];
const lead = (over = {}) => ({ id: 'lead-1', status: 'new', note: '', created_at: new Date().toISOString(),
  data: { name: 'Test Person', company: 'Test Co', city: 'Franklin', venue_type: 'Hotel', email: 'test@example.com', ...over } });

test('auto-reply: approved wording on every venue, and the proposal link carries no figures', () => {
  for (const v of venues) {
    const m = ackEmail(lead({ venue_type: v }));
    assert.doesNotMatch(m.subject + '\n' + m.text, banned, v);
    assert.match(m.text, /no upfront cost \(custom wrap available at select locations\)/);
    const pd = JSON.parse(Buffer.from(m.link.split('#')[1], 'base64').toString('utf8'));
    for (const k of ['share', 'grade', 'gross', 'annual']) assert.ok(!(k in pd), `link carries ${k}`);
  }
});

test('draft templates: approved wording for every kind', () => {
  const items = [{ kind: 'hot' }, { kind: 'fresh' }, { status: 'proposal' }, { kind: 'due', note_full: '[11/2 3:00pm] Left card' }, { kind: 'quiet' }];
  for (const it of items) {
    const d = templateDraft({ first: 'Dana', co: 'Test Co', ...it });
    assert.doesNotMatch(Object.values(d).join('\n'), banned, JSON.stringify(it));
  }
});

test('model drafts: the off-terms filter catches the old wording and passes the templates', () => {
  for (const bad of ['It is free to the host', 'at zero cost', 'you keep 10% of net sales', 'a mockup with your logo', 'the agreement is two pages', 'custom-wrapped cooler'])
    assert.match(bad, OFF_TERMS, bad);
  assert.doesNotMatch(Object.values(templateDraft({ first: 'Dana', co: 'Test Co', kind: 'hot' })).join('\n'), OFF_TERMS);
});

test('soleAddress: one plain address or nothing', () => {
  assert.equal(soleAddress(' a.b+c@example.co.uk '), 'a.b+c@example.co.uk');
  for (const bad of ['a@x.com, b@y.org', 'a@x.com; b@y.org', '"x" <d@w.com>', 'v@x.com\r\nBcc: i@y.com', 'a b@x.com', 'no-at-sign', 'a@x', 'a@-x.com', '']) {
    assert.equal(soleAddress(bad), '', JSON.stringify(bad));
  }
});

async function run(leads, store = memoryStore()) {
  const sent = [], writes = [];
  const env = { ACK_ENABLED: process.env.ACK_ENABLED, SMTP_HOST: process.env.SMTP_HOST, BRIEF_FROM: process.env.BRIEF_FROM };
  Object.assign(process.env, { ACK_ENABLED: '1', SMTP_HOST: 'smtp.test', BRIEF_FROM: 'paige@test' });
  try {
    const r = await runAck({ store, leads, transport: { sendMail: async m => sent.push(m) }, write: async (id, p) => writes.push([id, p]) });
    return { r, sent, writes, store };
  } finally { for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test('auto-reply: a list of addresses in the email field is never sent to', async () => {
  const { r, sent } = await run([lead({ email: 'a@x.com, b@y.org; c@z.net' })]);
  assert.equal(sent.length, 0);
  assert.match(r.skipped.join(), /not one plain address/);
});

test('auto-reply: one plain address gets exactly one email, to that address', async () => {
  const { r, sent, writes } = await run([lead()]);
  assert.deepEqual(r.sent, ['lead-1']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, { name: '', address: 'test@example.com' });
  assert.match(writes[0][1].append, /Auto-reply sent/);
});

test('auto-reply: an unreadable claim or day count sends nothing', async () => {
  const s1 = memoryStore(); s1.failGet = /^ack\//;
  const a = await run([lead()], s1);
  assert.equal(a.sent.length, 0);
  assert.match(a.r.errors.join(), /unreadable/);
  const s2 = memoryStore(); s2.failGet = /^ack-day\//;
  const b = await run([lead()], s2);
  assert.equal(b.sent.length, 0);
  assert.match(b.r.errors.join(), /unreadable/);
});
