/* =====================================================================
   WRAPT NOTES CORE — free text → a structured note in Command's own format
   ---------------------------------------------------------------------
   One extractor for three inputs:
     • an email (in or out) arriving through the inbox agent
     • a dictated/typed field note ("Smart note" box on the card)
     • a photo read (business card / site photo / competitor machine)
   Output is a PROPOSED patch for /lead-status — the caller decides whether
   to apply it (inbox agent applies the safe parts; the card UI asks Paige).

   Conventions it preserves (Command reads these back):
     [M/D h:mmap] <Touch>: summary        ← newest stamp = last touch
     Decision-makers: Name (Title)        ← last such line wins (dmOf)
     Emails: a@b.com                      ← cqOf / emailOf read this
   ===================================================================== */
import { CFG, todayISO, isoPlusDays, dmOf, emailOf, phoneOf, STATUSES } from './wrapt-agents.mjs';

/* ---------- Claude plumbing (injectable for tests) ---------- */
let LLM = null;
export function setLLM(fn) { LLM = fn; } // fn({system,user,images?,maxTokens,model}) → text
export function llmReady() { return !!(LLM || CFG.anthropicKey); }

export async function claudeText({ system, user, images = [], maxTokens = 1500, model = CFG.model }) {
  if (LLM) return LLM({ system, user, images, maxTokens, model });
  if (!CFG.anthropicKey) throw new Error('ANTHROPIC_API_KEY not set');
  const content = [];
  images.forEach(im => content.push({ type: 'image', source: { type: 'base64', media_type: im.media_type || 'image/jpeg', data: im.data } }));
  content.push({ type: 'text', text: user });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 55000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': CFG.anthropicKey, 'anthropic-version': '2023-06-01' },
      // No temperature (current models 400 on non-default sampling). Thinking is on by default and counts against
      // max_tokens, so keep effort low and leave room above the JSON's own size.
      body: JSON.stringify({ model, max_tokens: Math.max(maxTokens, 4000), output_config: { effort: 'low' }, system, messages: [{ role: 'user', content }] }),
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`claude: HTTP ${r.status} ${j?.error?.message || ''}`.trim());
    if (j?.stop_reason === 'refusal' || j?.stop_reason === 'max_tokens') throw new Error(`claude: stopped (${j.stop_reason})`);
    return (j?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  } finally { clearTimeout(t); }
}
export function parseJSON(text) {
  const m = String(text).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON in model reply');
  return JSON.parse(m[0]);
}
export async function claudeJSON(opts) { return parseJSON(await claudeText(opts)); }

/* ---------- Command's stamp, in Central time ---------- */
export function stamp(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(now);
  const g = t => (p.find(x => x.type === t) || {}).value || '';
  return `[${g('month')}/${g('day')} ${g('hour')}:${g('minute')}${g('dayPeriod').toLowerCase()}]`;
}
export function weekdayISO(now = new Date()) { // Central weekday name + today
  return { today: todayISO(now), weekday: new Intl.DateTimeFormat('en-US', { timeZone: CFG.tz, weekday: 'long' }).format(now) };
}

/* the card UI sends a flat lead; give it the shape the helpers expect */
export function leadFromClient(c = {}) {
  const s = v => (v == null ? '' : String(v));
  return {
    id: s(c.id), prospect: !!c.prospect, status: s(c.status) || 'prospect',
    data: { company: s(c.co || c.company), name: s(c.name), venue_type: s(c.venue || c.venue_type), city: s(c.city), email: s(c.email), phone: s(c.phone), address: s(c.address) },
    metaEmail: '', metaPhone: '', note: s(c.note), followup: s(c.followup), coi: s(c.coi), signed_at: s(c.signed_at),
    co: s(c.co || c.company), venue: s(c.venue || c.venue_type), city: s(c.city),
  };
}

/* ---------- the extractor ---------- */
const EXTRACT_SYSTEM = `You turn raw field communication for Wrapt (Franklin, TN — places free custom-wrapped smart coolers in local businesses; host keeps 10% of net sales) into one structured CRM note. Paige Fryer is the owner doing the outreach.

Return ONLY a JSON object:
{
 "relevant": true|false,            // false for newsletters, spam, receipts, automated mail, anything not about a placement
 "touch": "Visited"|"Called"|"Texted"|"Emailed"|"Note",   // how this contact happened (emails are always "Emailed")
 "summary": "<= 170 chars. Past tense, specific, no fluff: who said what, what was asked, what Paige promised. Names and dates included.",
 "decision_maker": {"name":"","title":""} | null,       // a person who decides or influences; only if named in the text
 "followup": "YYYY-MM-DD" | null,   // the date Paige should act next, resolved from phrases like "Thursday", "next week", "end of month", "in two weeks". Null if nothing implies a date.
 "followup_reason": "",
 "coi_requested": true|false,       // they asked for a certificate of insurance / COI / proof of insurance
 "status_suggest": "contacted"|"proposal"|"signed"|"waitlist"|"installed"|"dead" | null,  // only when the text clearly implies the pipeline moved (asked for the agreement → signed is NOT implied; sent proposal → "proposal"; signed agreement → "signed"; firm no → "dead")
 "status_reason": "",
 "email": "" | null,                // a contact email that appears in the text (not Paige's)
 "phone": "" | null,                // a contact phone that appears in the text
 "current_vending": "" | null,      // what vending/snack setup they have now, if mentioned
 "objections": ["..."],             // short, only if raised
 "confidence": 0.0-1.0
}
Rules: never invent — every field must come from the text. Dates: use the supplied today/weekday; "Thursday" means the next Thursday after today; "tomorrow" = today + 1. Keep the summary useful to someone reading the card in three weeks.`;

export async function extractNote({ kind = 'dictation', text, direction = 'in', from = '', subject = '', lead = null, now = new Date() }) {
  const { today, weekday } = weekdayISO(now);
  const ctx = lead ? {
    company: lead.co || lead.data?.company || '', venue_type: lead.venue || lead.data?.venue_type || '', city: lead.city || lead.data?.city || '',
    status: lead.status || '', known_decision_maker: lead.dm || (lead.note ? (dmOf(lead)?.name || '') : ''),
    recent_notes: String(lead.note_tail || lead.note || '').slice(-600), current_followup: lead.followup || '',
  } : null;
  const user = `Today is ${weekday} ${today} (America/Chicago).
Input kind: ${kind}${kind === 'email' ? ` (${direction === 'out' ? 'sent BY Paige' : 'received by Paige'}; from: ${from}; subject: ${subject})` : ''}
Lead context: ${ctx ? JSON.stringify(ctx) : 'unknown — not matched to a card yet'}

TEXT:
"""
${String(text).slice(0, 6000)}
"""`;
  const j = await claudeJSON({ system: EXTRACT_SYSTEM, user, maxTokens: 800 });
  return normalizeExtract(j, { kind, today });
}

export function normalizeExtract(j, { kind, today }) {
  const o = j && typeof j === 'object' ? j : {};
  const s = v => (v == null ? '' : String(v).trim());
  let touch = s(o.touch) || (kind === 'email' ? 'Emailed' : 'Note');
  if (kind === 'email') touch = 'Emailed';
  if (!['Visited', 'Called', 'Texted', 'Emailed', 'Note'].includes(touch)) touch = 'Note';
  let followup = s(o.followup);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(followup) || followup < today) followup = '';
  const dm = o.decision_maker && s(o.decision_maker.name) ? { name: s(o.decision_maker.name), title: s(o.decision_maker.title) } : null;
  let status = s(o.status_suggest).toLowerCase();
  if (!STATUSES.includes(status) || status === 'prospect' || status === 'new') status = '';
  return {
    relevant: o.relevant !== false, touch,
    summary: s(o.summary).replace(/\s+/g, ' ').slice(0, 170),
    decision_maker: dm, followup, followup_reason: s(o.followup_reason),
    coi_requested: !!o.coi_requested, status_suggest: status, status_reason: s(o.status_reason),
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s(o.email)) ? s(o.email).toLowerCase() : '',
    phone: s(o.phone).replace(/[^\d+().\- ]/g, '').slice(0, 20),
    current_vending: s(o.current_vending).slice(0, 80),
    objections: Array.isArray(o.objections) ? o.objections.map(s).filter(Boolean).slice(0, 4) : [],
    confidence: Math.max(0, Math.min(1, +o.confidence || 0)),
  };
}

/* ---------- turn an extraction into a /lead-status patch ---------- */
/* opts.who: "Marcus (GM)" / "marcus@x.com" for emails; opts.auto: true when the inbox agent applies without a human */
export function buildPatch(lead, ex, { kind = 'dictation', direction = 'in', who = '', now = new Date(), auto = false } = {}) {
  const lines = [];
  const st = stamp(now);
  let head;
  if (kind === 'email') head = direction === 'out' ? `Emailed ${who || 'them'}` : `Email from ${who || 'them'}`;
  else if (kind === 'photo') head = 'Photo';
  else head = ex.touch;
  lines.push(`${st} ${head}: ${ex.summary || '(no summary)'}`);
  if (ex.objections.length) lines.push(`Objections: ${ex.objections.join('; ')}`);
  if (ex.current_vending) lines.push(`Current vending: ${ex.current_vending}`);
  const curDM = dmOf(lead);
  if (ex.decision_maker && (!curDM || curDM.name.toLowerCase() !== ex.decision_maker.name.toLowerCase()))
    lines.push(`Decision-makers: ${ex.decision_maker.name}${ex.decision_maker.title ? ` (${ex.decision_maker.title})` : ''}`);
  const haveEmail = emailOf(lead), havePhone = phoneOf(lead);
  if (ex.email && !haveEmail && !(lead.note || '').toLowerCase().includes(ex.email)) lines.push(`Emails: ${ex.email}`);

  const patch = { note: (lead.note ? lead.note.replace(/\s+$/, '') + '\n' : '') + lines.join('\n') };
  if (ex.followup && (!lead.followup || ex.followup < lead.followup || lead.followup < todayISO(now))) patch.followup = ex.followup;
  if (ex.coi_requested && lead.coi !== 'sent' && lead.coi !== 'requested') patch.coi = 'requested';
  if (ex.email && !haveEmail) patch.email = ex.email;
  if (ex.phone && !havePhone) patch.phone = ex.phone;

  // status: the only automatic move is the one Command makes itself — a real exchange turns Prospect/New into Contacted
  const suggestion = ex.status_suggest && ex.status_suggest !== lead.status ? { status: ex.status_suggest, reason: ex.status_reason } : null;
  if (['prospect', 'new'].includes(lead.status) && (ex.relevant !== false)) patch.status = 'contacted';
  if (!auto && suggestion && suggestion.status !== 'contacted') { /* the card UI shows it as a one-tap suggestion */ }
  if (auto && suggestion && suggestion.status === 'contacted') { /* already covered */ }
  return { patch, lines, suggestion: suggestion && suggestion.status !== 'contacted' ? suggestion : null };
}

/* ---------- photo reading ---------- */
const PHOTO_SYSTEM = `You read photos taken in the field by Paige (owner of Wrapt, Franklin TN — free custom-wrapped smart coolers placed in local businesses; needs ~3 ft of wall and a standard outlet). For EACH image return an object in a JSON array, in order:
{
 "type": "business_card"|"site"|"competitor_machine"|"receipt"|"wrap"|"other",
 "note": "<= 150 chars of what matters for the placement, past tense, specific>",
 "contact": {"name":"","title":"","phone":"","email":"","company":""} | null,   // business_card only
 "placement": {"fits": true|false|null, "outlet_visible": true|false|null, "wall_ft_estimate": number|null, "spot": "lobby / break room / ..."} | null,   // site only
 "current_vending": "" | null,     // competitor_machine: brand/type/what it sells, condition
 "receipt": {"vendor":"","date":"YYYY-MM-DD","total":0.00,"category":"product|fuel|supplies|wrap|equipment|other","items":"short list"} | null,
 "confidence": 0.0-1.0
}
Only report what is visible. Never guess a name or number you can't read. Return the JSON array only.`;

export async function readPhotos(images, { lead = null, now = new Date() } = {}) {
  const { today } = weekdayISO(now);
  const ctx = lead ? `Lead: ${lead.co || ''} (${lead.venue || ''}, ${lead.city || ''}), status ${lead.status || ''}.` : 'No lead context (receipt scan).';
  const user = `Today is ${today}. ${ctx} Read the ${images.length} image${images.length === 1 ? '' : 's'} and return the JSON array.`;
  const arr = await claudeJSON({ system: PHOTO_SYSTEM, user, images, maxTokens: 1200 });
  const list = Array.isArray(arr) ? arr : [arr];
  return list.slice(0, images.length).map(normalizePhoto);
}
export function normalizePhoto(o) {
  o = o && typeof o === 'object' ? o : {};
  const s = v => (v == null ? '' : String(v).trim());
  const type = ['business_card', 'site', 'competitor_machine', 'receipt', 'wrap', 'other'].includes(s(o.type)) ? s(o.type) : 'other';
  const out = { type, note: s(o.note).slice(0, 150), confidence: Math.max(0, Math.min(1, +o.confidence || 0)) };
  if (type === 'business_card' && o.contact) out.contact = { name: s(o.contact.name), title: s(o.contact.title), phone: s(o.contact.phone), email: s(o.contact.email).toLowerCase(), company: s(o.contact.company) };
  if (type === 'site' && o.placement) out.placement = { fits: o.placement.fits ?? null, outlet_visible: o.placement.outlet_visible ?? null, wall_ft_estimate: o.placement.wall_ft_estimate == null ? null : +o.placement.wall_ft_estimate, spot: s(o.placement.spot) };
  if (type === 'competitor_machine') out.current_vending = s(o.current_vending).slice(0, 100);
  if (type === 'receipt' && o.receipt) out.receipt = { vendor: s(o.receipt.vendor), date: /^\d{4}-\d{2}-\d{2}$/.test(s(o.receipt.date)) ? s(o.receipt.date) : '', total: Math.round((+o.receipt.total || 0) * 100) / 100, category: s(o.receipt.category) || 'other', items: s(o.receipt.items).slice(0, 120) };
  return out;
}
/* photo readings → the same patch shape the card UI applies */
export function photoPatch(lead, readings, { now = new Date() } = {}) {
  const st = stamp(now), lines = [];
  let email = '', phone = '', dm = null, cv = '';
  readings.forEach(r => {
    if (r.type === 'business_card' && r.contact) {
      if (r.contact.name) dm = { name: r.contact.name, title: r.contact.title };
      email = email || r.contact.email; phone = phone || r.contact.phone;
      lines.push(`${st} Photo: business card — ${[r.contact.name, r.contact.title, r.contact.phone, r.contact.email].filter(Boolean).join(', ')}`);
    } else if (r.type === 'site') {
      const p = r.placement || {};
      lines.push(`${st} Photo: site — ${r.note}${p.fits === true ? ' · fits' : p.fits === false ? ' · may not fit' : ''}${p.outlet_visible ? ' · outlet visible' : ''}${p.spot ? ' · ' + p.spot : ''}`);
    } else if (r.type === 'competitor_machine') {
      cv = cv || r.current_vending; lines.push(`${st} Photo: current vending — ${r.current_vending || r.note}`);
    } else if (r.type === 'wrap') lines.push(`${st} Photo: wrap — ${r.note}`);
    else if (r.type !== 'receipt') lines.push(`${st} Photo: ${r.note}`);
  });
  const curDM = dmOf(lead);
  if (dm && (!curDM || curDM.name.toLowerCase() !== dm.name.toLowerCase())) lines.push(`Decision-makers: ${dm.name}${dm.title ? ` (${dm.title})` : ''}`);
  if (email && !emailOf(lead)) lines.push(`Emails: ${email}`);
  if (cv) lines.push(`Current vending: ${cv}`);
  const patch = {};
  if (lines.length) patch.note = (lead.note ? lead.note.replace(/\s+$/, '') + '\n' : '') + lines.join('\n');
  if (email && !emailOf(lead)) patch.email = email;
  if (phone && !phoneOf(lead)) patch.phone = phone;
  return { patch, lines };
}
