/* WRAPT INSTANT ACKNOWLEDGMENT — the one outbound email that is safe to automate.
   Every 5 minutes: any site lead still "New", from the last 72h, with an email, no touch logged
   and no acknowledgment on record → a short personal note in Paige's voice with the proposal link.
   Deterministic template (no model) so an unsupervised send can't improvise. Opt-in:
     ACK_ENABLED=1  plus SMTP settings — SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / BRIEF_FROM, or the EMAIL_* / GMAIL_* names
                    the site's existing email function already uses (a Gmail app password alone is enough: host defaults to smtp.gmail.com)
     ACK_CC         optional — copy Paige (default paige@wraptvending.com). Referral leads are never auto-answered.
   Stamps the card "[M/D h:mmap] Auto-reply sent — thanks + proposal link" so the pipeline knows. */
import { CFG, fetchLeads, buildLeads, lastTouchDays, emailOf, firstName, useSite, getStoreSafe, json, smtpConfig, makeTransport } from './lib/wrapt-agents.mjs';
import { stamp } from './lib/notes.mjs';
import { writeLead } from './lib/inbox-core.mjs';

const b64u = s => Buffer.from(s, 'utf8').toString('base64');
export function introLine(vt) { // mirrors Command's introLine()
  vt = vt || '';
  if (/Gym|fitness|Pickleball/i.test(vt)) return 'Members can grab a protein shake, electrolyte drink or a cold water on the way out: tap a card, grab it, walk off. No front-desk time, no cash, no coins.';
  if (/Apartment|Senior/i.test(vt)) return 'It works as a 24/7 resident amenity for the lobby or clubroom: tap a card, grab a drink or snack, done. Your team never handles money or restocking.';
  if (/Hotel/i.test(vt)) return 'Guests can grab drinks and snacks any hour: tap a card, grab, auto-checkout. It reads as your amenity, and the front desk never has to touch it.';
  if (/Office|Corporate|coworking/i.test(vt)) return 'Employees and tenants get cold drinks and snacks without leaving the building: tap a card, grab, auto-checkout. Nothing for your team to manage.';
  if (/Dealership|Auto repair|Laundromat|Health clinic|Veterinary|Medical|Beauty|Salon|Tattoo/i.test(vt)) return 'Customers waiting on you can grab a drink or snack themselves: tap a card, grab, auto-checkout. It makes the wait better and costs you nothing.';
  if (/Church|College|Youth|Public|Entertainment|Golf|skate/i.test(vt)) return 'Visitors and families can grab a drink or snack anytime: tap a card, grab, auto-checkout. No staff time, no cash handling.';
  return 'Customers and staff can grab a cold drink or snack anytime: tap a card, grab, auto-checkout.';
}
export function ackEmail(l) {
  const d = l.data, co = d.company || 'your location', first = firstName(d.name) || 'there';
  const pd = b64u(JSON.stringify({ name: d.name || '', co: d.company || '', city: d.city || '', venue: d.venue_type || '', wants: d.product_interests || '', grade: '', gross: '', annual: '', share: '10%' }));
  const link = `${CFG.site}/proposal.html#${pd}`;
  const subject = `Your smart cooler at ${co} — Paige, Wrapt`;
  const text = `Hi ${first},

Thanks for reaching out about a cooler at ${co} — I'm Paige, owner of Wrapt here in Franklin.

The short version: we place a custom-wrapped smart cooler in your space at zero cost, we stock and service it weekly, and ${co} keeps 10% of net sales, paid monthly with a statement. ${introLine(d.venue_type)}

Here's a proposal built from what you shared:
${link}

I'll follow up personally within a day to find a time to stop by for five minutes with a mockup in your colors. If a day already works for you, reply here or text me at ${CFG.paige.phone}.

${CFG.paige.name}
Owner, Wrapt
${CFG.paige.phone} · wraptvending.com`;
  return { subject, text, link };
}
export function ackCandidates(leads, now = new Date()) {
  return leads.filter(l => !l.prospect && l.status === 'new' && emailOf(l) && l.created_at && now - new Date(l.created_at) < 72 * 3600e3
    && !/referral/i.test(l.data.lead_type || '') && lastTouchDays(l, now) == null && !/Auto-reply sent/.test(l.note || ''));
}
export function smtpReady() { return smtpConfig().ok; }

export async function runAck({ store = null, now = new Date(), transport = null, write = writeLead, leads = null } = {}) {
  store = await getStoreSafe(store);
  leads = leads || buildLeads(await fetchLeads(), [], {});
  const cands = ackCandidates(leads, now);
  const enabled = process.env.ACK_ENABLED === '1';
  const out = { enabled, smtp: smtpReady(), candidates: cands.map(l => l.id), sent: [], skipped: [], errors: [] };
  if (!cands.length) return out;
  if (!enabled || !out.smtp) { out.skipped = cands.map(l => `${l.id}: ${!enabled ? 'ACK_ENABLED is not 1' : 'SMTP not configured'}`); return out; }
  const tr = transport || await makeTransport();
  const from = smtpConfig().from, cc = process.env.ACK_CC ?? CFG.paige.email;
  for (const l of cands) {
    const key = `ack/${l.id}`;
    if (await store.get(key, { type: 'json' }).catch(() => null)) { out.skipped.push(`${l.id}: already acknowledged`); continue; }
    await store.setJSON(key, { ts: now.toISOString(), to: emailOf(l), status: 'sending' }); // claim first: two overlapping runs can't both send
    try {
      const m = ackEmail(l);
      await tr.sendMail({ from, to: emailOf(l), cc: cc || undefined, replyTo: CFG.paige.email, subject: m.subject, text: m.text });
      await write(l.id, { note: (l.note ? l.note.replace(/\s+$/, '') + '\n' : '') + `${stamp(now)} Auto-reply sent — thanks + proposal link (${emailOf(l)})` });
      await store.setJSON(key, { ts: now.toISOString(), to: emailOf(l), status: 'sent', subject: m.subject });
      out.sent.push(l.id);
    } catch (e) { out.errors.push(`${l.id}: ${e.message}`); await store.delete(key).catch(() => {}); }
  }
  return out;
}

export default async (req, context) => {
  useSite(context);
  const r = await runAck({});
  console.log(`[wrapt-ack] enabled:${r.enabled} smtp:${r.smtp} candidates:${r.candidates.length} sent:${r.sent.length}${r.skipped.length ? ' skipped: ' + r.skipped.join(' | ') : ''}${r.errors.length ? ' errors: ' + r.errors.join(' | ') : ''}`);
  return json(r);
};

export const config = { schedule: '*/5 * * * *' };
