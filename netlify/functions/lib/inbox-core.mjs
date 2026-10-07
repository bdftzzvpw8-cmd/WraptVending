/* =====================================================================
   WRAPT INBOX AGENT — core
   ---------------------------------------------------------------------
   An email arrives (webhook from an inbound-email service, or later the
   Gmail API) → normalize → skip automated mail → dedupe → work out which
   lead it belongs to → extract a note → write it through /lead-status
   exactly as Command would. Low-confidence matches go to a queue Paige
   resolves from the Today tab; bigger status moves become suggestions.

   Blob keys (store "wrapt-agents"), one key per item so concurrent
   webhooks never clobber each other:
     inbox/seen/<sha1(message_id)>   → ts, status        (dedupe; 'processing' until handled)
     inbox/t/<sha1(message_id)>      → lead id           (thread → lead memory)
     inbox/q/<qid>                   → queued email      (needs a home)
     inbox/s/<sid>                   → status suggestion (one tap in Command; may carry `contact`)
     inbox/c/<sid>                   → contact suggestion (email/phone/decision-maker read from a body)
     inbox/log/<ts>-<rand>           → activity line     (what the agent did)
   ===================================================================== */
import { createHash, randomBytes } from 'node:crypto';
import { CFG, fetchLeads, fetchProspects, fetchFieldProspects, buildLeads, emailOf, phoneOf, dmOf, firstName, getStoreSafe } from './wrapt-agents.mjs';
import { extractNote, buildPatch } from './notes.mjs';

export const INBOX = {
  secret: process.env.INBOX_SECRET || '',
  paige: (process.env.PAIGE_EMAILS || CFG.paige.email).toLowerCase().split(/[,\s]+/).filter(Boolean),
  parseAddr: (process.env.INBOX_ADDRESS || '').toLowerCase(), // the forwarding/BCC address itself, never a counterpart
  autoThreshold: +(process.env.INBOX_AUTO_SCORE || 75),
  queueThreshold: +(process.env.INBOX_QUEUE_SCORE || 40),
};
const sha = s => createHash('sha1').update(String(s)).digest('hex');
const rid = () => Date.now().toString(36) + randomBytes(3).toString('hex');

/* ---------- 1. normalize whatever the provider posts ---------- */
export function parseAddr(s) {
  s = String(s || '').trim();
  const m = /^(?:"?([^"<]*)"?\s*)?<([^>]+)>$/.exec(s);
  if (m) return { name: (m[1] || '').trim(), email: m[2].trim().toLowerCase() };
  const e = /[^\s<>,;"]+@[^\s<>,;"]+/.exec(s);
  return { name: e ? s.replace(e[0], '').replace(/[<>"]/g, '').trim() : '', email: e ? e[0].toLowerCase() : '' };
}
/* split "A <a@x>, "Hill, Marcus" <m@y>, c@z" on the commas that are outside quotes and angle brackets */
function splitAddrs(s) {
  const out = []; let cur = '', q = false, ang = false;
  for (const ch of String(s)) {
    if (ch === '"') q = !q;
    else if (ch === '<' && !q) ang = true;
    else if (ch === '>' && !q) ang = false;
    if ((ch === ',' || ch === ';') && !q && !ang) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
export function parseAddrList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => typeof x === 'string' ? parseAddr(x) : { name: x.Name || x.name || '', email: String(x.Email || x.email || x.address || '').toLowerCase() }).filter(a => a.email);
  return splitAddrs(v).map(parseAddr).filter(a => a.email);
}
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], t = ln.trim();
    // "On <date> <person> wrote:" — Gmail wraps long ones onto a second or third line
    if (/^On .{3,}/.test(t)) {
      const win = [t, (lines[i + 1] || '').trim(), (lines[i + 2] || '').trim()];
      const k = win.findIndex(x => /wrote:\s*$/.test(x));
      if (k >= 0 && win.slice(0, k).every(x => !/^>/.test(x))) break;
    }
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(t) || /^From: .+(Sent|Date): /i.test(ln) || /^_{10,}$/.test(t)) break;
    if (/^>/.test(ln)) continue;
    out.push(ln);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function headerMap(raw) { // SendGrid posts raw headers as one string
  const h = {};
  String(raw || '').replace(/\r/g, '').split('\n').forEach(ln => { const m = /^([\w-]+):\s*(.*)$/.exec(ln); if (m) h[m[1].toLowerCase()] = m[2]; });
  return h;
}
export function normalizeMessage(payload, { contentType = '' } = {}) {
  const p = payload || {};
  let msg;
  if (p.FromFull || p.MessageID) { // Postmark
    const hd = {}; (p.Headers || []).forEach(h => hd[String(h.Name).toLowerCase()] = h.Value);
    msg = { provider: 'postmark', from: { name: p.FromFull?.Name || '', email: String(p.FromFull?.Email || p.From || '').toLowerCase() },
      to: parseAddrList(p.ToFull || p.To), cc: parseAddrList(p.CcFull || p.Cc), subject: p.Subject || '',
      text: p.StrippedTextReply || stripQuoted(p.TextBody || ''), full: p.TextBody || '', date: p.Date || '',
      message_id: p.MessageID ? `<${p.MessageID}>` : (hd['message-id'] || ''), in_reply_to: hd['in-reply-to'] || '', references: hd.references || '', headers: hd };
  } else if (p.headers && typeof p.headers === 'object' && (p.plain != null || p.html != null)) { // CloudMailin
    const h = {}; Object.entries(p.headers).forEach(([k, v]) => h[k.toLowerCase()] = Array.isArray(v) ? v.join(' ') : v);
    msg = { provider: 'cloudmailin', from: parseAddr(h.from), to: parseAddrList(h.to), cc: parseAddrList(h.cc), subject: h.subject || '',
      text: p.reply_plain || stripQuoted(p.plain || ''), full: p.plain || '', date: h.date || '', message_id: h['message-id'] || '', in_reply_to: h['in-reply-to'] || '', references: h.references || '', headers: h };
  } else if (p.sender != null || p['body-plain'] != null) { // Mailgun (form fields)
    msg = { provider: 'mailgun', from: parseAddr(p.from || p.sender), to: parseAddrList(p.recipient || p.To || p.to), cc: parseAddrList(p.Cc || p.cc), subject: p.subject || p.Subject || '',
      text: p['stripped-text'] || stripQuoted(p['body-plain'] || ''), full: p['body-plain'] || '', date: p.Date || p.date || '',
      message_id: p['Message-Id'] || p['message-id'] || '', in_reply_to: p['In-Reply-To'] || '', references: p.References || '', headers: {} };
  } else if (typeof p.headers === 'string' || (p.envelope && typeof p.envelope === 'string')) { // SendGrid inbound parse
    const h = headerMap(p.headers);
    msg = { provider: 'sendgrid', from: parseAddr(p.from || h.from), to: parseAddrList(p.to || h.to), cc: parseAddrList(p.cc || h.cc), subject: p.subject || h.subject || '',
      text: stripQuoted(p.text || ''), full: p.text || '', date: h.date || '', message_id: h['message-id'] || '', in_reply_to: h['in-reply-to'] || '', references: h.references || '', headers: h };
  } else { // generic JSON (the Gmail sync script, tests, manual)
    msg = { provider: p.provider || 'generic', from: typeof p.from === 'string' ? parseAddr(p.from) : { name: p.from?.name || '', email: String(p.from?.email || '').toLowerCase() },
      to: parseAddrList(p.to), cc: parseAddrList(p.cc), subject: p.subject || '', text: p.stripped || stripQuoted(p.text || ''), full: p.text || '', date: p.date || '',
      message_id: p.message_id || '', in_reply_to: p.in_reply_to || '', references: Array.isArray(p.references) ? p.references.join(' ') : (p.references || ''), headers: p.headers || {},
      account: String(p.account || '').toLowerCase() }; // the mailbox the message was read from (Gmail sync) — counts as Paige's
  }
  msg.message_id = msg.message_id || `<gen-${sha(msg.from.email + msg.subject + msg.date + (msg.full || msg.text).slice(0, 200))}@wrapt>`;
  msg.refs = [msg.in_reply_to, ...String(msg.references || '').split(/\s+/)].map(s => s.trim()).filter(Boolean);
  msg.text = (msg.text || '').trim() || stripQuoted(msg.full || '');
  return msg;
}
export async function readPayload(req) {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json')) return { payload: await req.json(), contentType: ct };
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const fd = await req.formData(); const o = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string') o[k] = v;
    return { payload: o, contentType: ct };
  }
  const text = await req.text();
  try { return { payload: JSON.parse(text), contentType: ct }; } catch { return { payload: { text }, contentType: ct }; }
}

/* ---------- 2. what to ignore ---------- */
export function isAutomated(msg) {
  const h = msg.headers || {}, subj = (msg.subject || '').toLowerCase(), from = msg.from.email || '';
  if (/^(auto-replied|auto-generated|auto-notified)/i.test(h['auto-submitted'] || '')) return 'auto-submitted';
  if (/bulk|junk|list/i.test(h.precedence || '') || h['list-unsubscribe']) return 'bulk';
  if (/^(automatic reply|out of office|out of the office|delivery status notification|undeliverable|mail delivery failed|delivery failure)/i.test(subj)) return 'auto-reply';
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|bounce)[@.+-]/i.test(from)) return 'noreply sender';
  return '';
}
export function directionOf(msg) {
  const mine = new Set([...INBOX.paige, msg.account].filter(Boolean)), skip = new Set([...mine, INBOX.parseAddr].filter(Boolean));
  if (mine.has(msg.from.email)) {
    const cp = [...msg.to, ...msg.cc].find(a => !skip.has(a.email));
    return { direction: 'out', counterpart: cp || { name: '', email: '' } };
  }
  return { direction: 'in', counterpart: msg.from };
}

/* ---------- 3. which lead is this? ---------- */
const GENERIC_DOMAINS = /^(gmail|yahoo|hotmail|outlook|live|icloud|me|aol|msn|comcast|att|protonmail|proton|pm)\.(com|net|me|ch)$/i;
const STOP = new Set(['the', 'of', 'at', 'and', 'a', 'an', 'in', 'on', 'inc', 'llc', 'co', 'company', 'group', 'club', 'fitness', 'gym', 'apartments', 'apartment', 'community', 'communities', 'hotel', 'suites', 'inn', 'center', 'centre', 'studio', 'franklin', 'nashville', 'spring', 'hill', 'brentwood', 'columbia', 'murfreesboro', 'tn', 'cool', 'springs', 'downtown', 'north', 'south', 'east', 'west', 'by', 'for', 'to', 'tennessee', 'residential', 'living', 'golf', 'social', 'training', 'performance', 'athletic', 'athletics', 'family', 'house', 'auto', 'automotive', 'service', 'care', 'med', 'medical']);
const tokens = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
const domainOf = e => (String(e || '').split('@')[1] || '').toLowerCase();
const siteDomain = l => String(l.data.website || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];

export async function matchLead(msg, counterpart, leads, { threadLookup = async () => null } = {}) {
  const cands = new Map(); // id → {lead, score, why, signals}
  const add = (l, score, why) => {
    const c = cands.get(l.id);
    if (!c) cands.set(l.id, { lead: l, score, why, signals: 1 });
    else { c.signals++; if (c.score < score) { c.score = score; c.why = why; } }
  };
  // thread memory
  for (const ref of msg.refs) { const id = await threadLookup(ref); if (id) { const l = leads.find(x => x.id === id); if (l) add(l, 100, 'same thread'); } }
  const cpEmail = counterpart.email || '', cpDomain = domainOf(cpEmail);
  const hay = `${msg.subject}\n${msg.text}\n${counterpart.name}`.toLowerCase();
  if (cpEmail) leads.forEach(l => { if (emailOf(l).toLowerCase() === cpEmail) add(l, 100, 'email on card'); });
  if (cpDomain && !GENERIC_DOMAINS.test(cpDomain)) {
    const same = leads.filter(l => siteDomain(l) && (siteDomain(l) === cpDomain || cpDomain.endsWith('.' + siteDomain(l))));
    same.forEach(l => add(l, same.length === 1 ? 85 : 60, same.length === 1 ? 'website domain' : `shared domain (${same.length} cards)`));
  }
  leads.forEach(l => {
    const tk = tokens(l.data.company); if (!tk.length) return;
    const hit = tk.filter(t => hay.includes(t));
    const strong = hit.some(t => t.length >= 6) || hit.length >= 2;
    if (strong && hit.length === tk.length) add(l, 72, `company name "${l.data.company}" in text`);
    else if (strong) add(l, 55, `partly "${l.data.company}"`);
    const dm = dmOf(l);
    if (dm && counterpart.name && firstName(counterpart.name).toLowerCase() === firstName(dm.name).toLowerCase()) { const c = cands.get(l.id); if (c) c.score = Math.min(100, c.score + 15); }
  });
  // two independent signals pointing at the same card (domain + name, name + thread…) corroborate each other
  cands.forEach(c => { if (c.signals >= 2 && c.score < 100) { c.score = Math.min(100, c.score + 15); c.why += ' + corroborated'; } });
  const sorted = [...cands.values()].sort((a, b) => b.score - a.score);
  const best = sorted[0] || null;
  const second = sorted[1];
  const ambiguous = best && second && second.score >= best.score - 5 && best.score < 100;
  return { best: best && !ambiguous && best.score >= INBOX.autoThreshold ? best : null, candidates: sorted.slice(0, 4).map(c => ({ id: c.lead.id, co: c.lead.data.company || c.lead.data.name || c.lead.id, city: c.lead.data.city || '', status: c.lead.status, score: c.score, why: c.why })) };
}

/* ---------- 4. storage helpers ---------- */
async function put(store, key, obj) { await store.setJSON(key, obj); }
async function get(store, key) { try { return await store.get(key, { type: 'json' }); } catch { return null; } }
async function del(store, key) { try { await store.delete(key); } catch { /* ignore */ } }
async function listKeys(store, prefix) { try { const r = await store.list({ prefix }); return (r.blobs || []).map(b => b.key); } catch { return []; } }
async function log(store, entry) { await put(store, `inbox/log/${Date.now()}-${rid()}`, { ts: new Date().toISOString(), ...entry }); }

// Agents send only their new lines (append) so a note saved meanwhile in Command, or by a parallel run, is never overwritten.
export const asAppend = (patch, lines) => { const { note, ...rest } = patch; return { ...rest, append: lines.join('\n') }; };
export async function writeLead(id, patch) {
  const r = await fetch(`${CFG.site}/.netlify/functions/lead-status`, { method: 'POST', headers: { 'X-Dash-Key': CFG.dashKey, 'content-type': 'application/json' }, body: JSON.stringify({ id, ...patch }) });
  if (!r.ok) throw new Error(`lead-status: HTTP ${r.status}`);
  return true;
}
export async function loadAllLeads() {
  const raw = await fetchLeads();
  let pr = { prospects: [], renames: {} }; try { pr = await fetchProspects(); } catch { /* inbound-only still works */ }
  const field = await fetchFieldProspects();
  return buildLeads(raw, [...pr.prospects, ...field], pr.renames);
}
const who = cp => cp.name ? `${cp.name}` : (cp.email || 'them');

/* Email text is written by outsiders. The card only takes what the headers prove: the sender's own address
   (when the card has none) and the sender as decision-maker. Anything else the model read out of the body —
   another email, a phone, a different decision-maker — becomes a one-tap suggestion, never a card change. */
export function trustContact(lead, ex, direction, cp = {}) {
  const contact = {};
  if (ex.email && ex.email !== cp.email && !emailOf(lead)) contact.email = ex.email;
  if (ex.phone && !phoneOf(lead)) contact.phone = ex.phone;
  const dm = ex.decision_maker;
  const dmIsSender = !!(dm && direction === 'in' && cp.name && firstName(dm.name).toLowerCase() === firstName(cp.name).toLowerCase());
  if (dm && !dmIsSender) contact.decision_maker = dm;
  ex.email = direction === 'in' && cp.email && !emailOf(lead) ? cp.email : '';
  ex.phone = '';
  ex.decision_maker = dmIsSender ? dm : (direction === 'in' && cp.name && !dmOf(lead) && ex.relevant !== false ? { name: cp.name, title: '' } : null);
  return Object.keys(contact).length ? contact : null;
}
/* status suggestions → inbox/s (Command shows "Move to …?"); contact-only suggestions → inbox/c */
async function saveSuggestion(store, { lead, suggestion, contact, from, subject, now }) {
  if (!suggestion && !contact) return null;
  const sid = rid(), base = { sid, ts: now.toISOString(), lead_id: lead.id, co: lead.data.company || lead.data.name, from, subject };
  if (suggestion) await put(store, `inbox/s/${sid}`, { ...base, status: suggestion.status, reason: suggestion.reason, ...(contact ? { contact } : {}) });
  else await put(store, `inbox/c/${sid}`, { ...base, contact });
  return sid;
}
const PLACEMENT_WORDS = /cooler|vending|machine|wrapt|proposal|agreement|install|placement/i;

/* ---------- 5. the pipeline for one message ---------- */
// The seen-marker is a claim while processing and only becomes final once the message is filed, queued or
// dropped. If anything throws, the claim is released so the next delivery retries; a claim older than
// 10 minutes (a run that died mid-way) is retried too.
export async function processMessage(msg, opts = {}) {
  const { store, now = new Date() } = opts;
  const seenKey = `inbox/seen/${sha(msg.message_id)}`;
  const seen = await get(store, seenKey);
  if (seen && (seen.status !== 'processing' || now - new Date(seen.ts) < 10 * 60e3)) return { action: 'duplicate', message_id: msg.message_id };
  await put(store, seenKey, { ts: now.toISOString(), subject: msg.subject, status: 'processing' });
  try {
    const r = await handleMessage(msg, opts);
    await put(store, seenKey, { ts: now.toISOString(), subject: msg.subject, status: 'done', action: r.action });
    return r;
  } catch (e) { await del(store, seenKey); throw e; }
}
async function handleMessage(msg, { store, leads = null, now = new Date(), loadLeads = loadAllLeads, write = writeLead } = {}) {
  const auto = isAutomated(msg);
  if (auto) { await log(store, { action: 'skipped', why: auto, from: msg.from.email, subject: msg.subject }); return { action: 'skipped', why: auto }; }
  const { direction, counterpart } = directionOf(msg);
  if (!counterpart.email && direction === 'out') { await log(store, { action: 'skipped', why: 'no counterpart', subject: msg.subject }); return { action: 'skipped', why: 'no counterpart' }; }
  leads = leads || await loadLeads();
  const { best, candidates } = await matchLead(msg, counterpart, leads, { threadLookup: async ref => (await get(store, `inbox/t/${sha(ref)}`))?.lead || null });
  const lead = best?.lead || null;
  const text = `${msg.subject ? 'Subject: ' + msg.subject + '\n' : ''}${msg.text}`.slice(0, 6000);
  // no card, no near match and nothing about a placement → personal/other mail: drop it before paying for a model call
  if (!lead && !candidates.length && !PLACEMENT_WORDS.test(text)) {
    await log(store, { action: 'dropped', why: 'no match, not about a placement', from: counterpart.email, subject: msg.subject }); return { action: 'dropped', why: 'no match' };
  }
  let ex;
  try { ex = await extractNote({ kind: 'email', text, direction, from: `${counterpart.name} <${counterpart.email}>`, subject: msg.subject, lead, now, timeoutMs: 55000 }); } // background function
  catch (e) { // no model (or over the daily budget) → still file the exchange, plainly
    ex = { relevant: true, touch: 'Emailed', summary: (msg.subject || msg.text.slice(0, 120)).replace(/\s+/g, ' ').slice(0, 150), decision_maker: null, followup: '', followup_reason: '', coi_requested: /certificate of insurance|\bCOI\b|proof of insurance/i.test(text), status_suggest: '', status_reason: '', email: '', phone: '', current_vending: '', objections: [], confidence: 0.3, _fallback: e.message };
  }
  if (!lead && ex.relevant === false) { await log(store, { action: 'dropped', why: 'not relevant', from: counterpart.email, subject: msg.subject }); return { action: 'dropped', why: 'not relevant' }; }
  if (!lead) {
    const qid = rid();
    const item = { qid, ts: now.toISOString(), direction, from: counterpart, subject: msg.subject, text: msg.text.slice(0, 2500), message_id: msg.message_id, refs: msg.refs.slice(0, 5), extract: ex, candidates };
    await put(store, `inbox/q/${qid}`, item);
    await log(store, { action: 'queued', qid, from: counterpart.email, subject: msg.subject, candidates: candidates.map(c => c.co) });
    return { action: 'queued', qid, candidates };
  }
  // matched: write the note the way Command would
  const email = counterpart.email;
  const contact = trustContact(lead, ex, direction, counterpart); // the sender IS the contact; body-read details are only suggested
  const { patch, lines, suggestion } = buildPatch(lead, ex, { kind: 'email', direction, who: who(counterpart), now, auto: true });
  await write(lead.id, asAppend(patch, lines));
  Object.assign(lead, patch); // keep the in-memory copy current for any further messages in this run
  await put(store, `inbox/t/${sha(msg.message_id)}`, { lead: lead.id });
  const sid = await saveSuggestion(store, { lead, suggestion, contact, from: email, subject: msg.subject, now });
  await log(store, { action: 'filed', lead_id: lead.id, co: lead.data.company || lead.data.name, direction, from: email, subject: msg.subject, score: best.score, why: best.why, line: lines[0], suggestion: suggestion?.status || null, contact: contact ? Object.keys(contact) : null, fallback: ex._fallback || null });
  return { action: 'filed', lead_id: lead.id, score: best.score, why: best.why, lines, patch, suggestion, contact, sid };
}

/* ---------- 6. what Command reads and resolves ---------- */
export async function queueState(store, { limit = 30 } = {}) {
  const qk = await listKeys(store, 'inbox/q/'), sk = await listKeys(store, 'inbox/s/'), ck = await listKeys(store, 'inbox/c/'), lk = (await listKeys(store, 'inbox/log/')).sort().reverse().slice(0, limit);
  const byTs = (a, b) => (b.ts || '').localeCompare(a.ts || '');
  const queue = (await Promise.all(qk.map(k => get(store, k)))).filter(Boolean).sort(byTs);
  const suggestions = (await Promise.all(sk.map(k => get(store, k)))).filter(Boolean).sort(byTs);
  const contacts = (await Promise.all(ck.map(k => get(store, k)))).filter(Boolean).sort(byTs); // {sid, lead_id, co, contact:{email?,phone?,decision_maker?}}
  const recent = (await Promise.all(lk.map(k => get(store, k)))).filter(Boolean);
  return { queue, suggestions, contacts, recent };
}
export async function attachQueued(store, qid, leadId, { leads = null, now = new Date(), loadLeads = loadAllLeads, write = writeLead } = {}) {
  const item = await get(store, `inbox/q/${qid}`); if (!item) throw new Error('queue item not found');
  leads = leads || await loadLeads();
  const lead = leads.find(l => l.id === leadId); if (!lead) throw new Error('lead not found');
  const ex = { ...(item.extract || {}) };
  const contact = trustContact(lead, ex, item.direction, item.from || {});
  const { patch, lines, suggestion } = buildPatch(lead, ex, { kind: 'email', direction: item.direction, who: who(item.from || {}), now, auto: true });
  await write(lead.id, asAppend(patch, lines));
  await put(store, `inbox/t/${sha(item.message_id)}`, { lead: lead.id });
  for (const ref of item.refs || []) await put(store, `inbox/t/${sha(ref)}`, { lead: lead.id });
  await del(store, `inbox/q/${qid}`);
  const sid = await saveSuggestion(store, { lead, suggestion, contact, from: item.from?.email, subject: item.subject, now });
  await log(store, { action: 'attached', lead_id: lead.id, co: lead.data.company || lead.data.name, from: item.from?.email, subject: item.subject, line: lines[0] });
  return { ok: true, lead_id: lead.id, lines, patch, suggestion, contact, sid };
}
export async function dismissQueued(store, qid) { await del(store, `inbox/q/${qid}`); await log(store, { action: 'dismissed', qid }); return { ok: true }; }
export async function resolveSuggestion(store, sid, applied) {
  const s = (await get(store, `inbox/s/${sid}`)) || (await get(store, `inbox/c/${sid}`));
  await del(store, `inbox/s/${sid}`); await del(store, `inbox/c/${sid}`);
  await log(store, { action: applied ? 'suggestion applied' : 'suggestion dismissed', lead_id: s?.lead_id, status: s?.status, contact: s?.contact ? Object.keys(s.contact) : null });
  return { ok: true };
}
export { sha, rid };
