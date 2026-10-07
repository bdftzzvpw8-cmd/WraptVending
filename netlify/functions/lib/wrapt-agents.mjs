/* =====================================================================
   WRAPT AGENTS — shared library
   ---------------------------------------------------------------------
   Two agents that read the same data Command reads and write ONE brief:
     • Pipeline agent  — what to work today, who fell through the cracks,
                         which doors to knock, with ready-to-send drafts.
     • Deal-watch agent — install countdowns, COI requests, stale proposals,
                         the waitlist, and month-start host statements.

   Rules of the house:
     • The brief agents never change a lead: they read /leads, the ops
       "prospects" doc and command.html, and write only the brief (Blobs
       store "wrapt-agents"). Other code built on this library does write:
       the inbox agent appends note lines, follow-up dates, COI flags and the
       sender's own email to cards through /lead-status (contact details the
       model reads out of an email are only suggested); ack.mjs stamps the
       card after its auto-reply. Status moves beyond Contacted stay suggestions.
     • Drafts are never sent: Paige approves and sends them from Command
       (Text / Email buttons open sms: / mailto:). The only automatic sends are
       the opt-in ack email (ack.mjs) and the brief to BRIEF_TO.
     • Mirrors Command's own logic (tiers, last-touch stamps, follow-up
       rules, 14-day install clock) so the brief and the app agree.

   Env vars (set in Netlify → Site configuration → Environment variables):
     URL                 (Netlify sets this)  site origin, e.g. https://wraptvending.com
     DASH_KEY            same key the existing functions check; required (blank = every endpoint refuses)
     ANTHROPIC_API_KEY   optional — turns on AI-written drafts (template drafts without it)
     AGENT_MODEL         optional — default claude-sonnet-5-5
     INBOX_MODEL         optional — model for inbox email extraction, default claude-haiku-4-5
     AGENT_DAILY_LLM_MAX optional — Claude calls per Central day across all features, default 200
     AGENT_MAX_DRAFTS    optional — default 8 drafts per run
     HOME_LATLNG         optional — "lat,lng" of home base for door-run ranking
     BRIEF_TO            optional — email the brief here each run, at most once per 30 min (needs SMTP_* below)
     BRIEF_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   optional — nodemailer transport
   ===================================================================== */
import { dashKeyCheck } from './dash-key.mjs';
import { claudeCall, textOf } from './claude.mjs';

export const CFG = {
  site: (process.env.URL || 'https://wraptvending.com').replace(/\/$/, ''),
  dashKey: process.env.DASH_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.AGENT_MODEL || 'claude-sonnet-5-5',
  inboxModel: process.env.INBOX_MODEL || 'claude-haiku-4-5',
  maxDrafts: Math.max(0, +(process.env.AGENT_MAX_DRAFTS || 8)),
  // Home base for door-run ranking. Default ≈ Legacy Cool Springs, 2000 Aureum Dr, Franklin — set HOME_LATLNG to pin it.
  home: parseLatLng(process.env.HOME_LATLNG) || [35.9125, -86.8140],
  tz: 'America/Chicago',
  storeName: 'wrapt-agents',
  paige: { name: 'Paige Fryer', first: 'Paige', phone: '615.948.2976', email: 'paige@wraptvending.com' },
};

function parseLatLng(s) {
  if (!s) return null;
  const m = String(s).split(/[ ,]+/).map(Number);
  return m.length === 2 && m.every(Number.isFinite) ? m : null;
}
/* prefer the live site URL Netlify hands the function (deploy previews, branch deploys) over the env default */
export function useSite(context) {
  const u = context?.site?.url || process.env.URL;
  if (u) CFG.site = String(u).replace(/\/$/, '');
  return CFG.site;
}
/* fire the background worker and return at once (used by the schedule and by Command's "Run now") */
export async function kickWorker(trigger = 'manual') {
  const r = await fetch(`${CFG.site}/.netlify/functions/agents-run-background?trigger=${encodeURIComponent(trigger)}`, {
    method: 'POST', headers: { 'X-Dash-Key': CFG.dashKey, 'content-type': 'application/json' }, body: '{}',
  });
  if (r.status !== 202 && !r.ok) throw new Error(`agents-run-background: HTTP ${r.status}`);
  return r.status;
}

/* ---------- Central-time calendar helpers (never the UTC day) ---------- */
export function todayISO(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: CFG.tz }); // YYYY-MM-DD
}
export function centralParts(d = new Date()) {
  const [y, m, day] = todayISO(d).split('-').map(Number);
  return { y, m, d: day };
}
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);
export function daysSinceISO(iso, now = new Date()) {
  // iso may be "YYYY-MM-DD" (a Central calendar day) or a full timestamp
  if (!iso) return null;
  const t = centralParts(now);
  let y, m, d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) [y, m, d] = iso.split('-').map(Number);
  else { const p = centralParts(new Date(iso)); if (!Number.isFinite(new Date(iso).getTime())) return null; ({ y, m, d } = p); }
  return dayNum(t.y, t.m, t.d) - dayNum(y, m, d);
}
export function isoPlusDays(n, now = new Date()) {
  return todayISO(new Date(now.getTime() + n * 864e5));
}
export function fmtMD(iso) { // "2026-10-06" → "10/6"
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
  return `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
}

/* ---------- ports of Command's own rules (keep in step with command.html) ---------- */
export const STATUSES = ['prospect', 'new', 'contacted', 'proposal', 'signed', 'waitlist', 'installed', 'dead'];
const TIER_A_TYPES = new Set(['Dealership service', 'Laundromat', 'Pickleball club', 'Youth sports', 'Auto repair', 'Ice / skate rink']);
const TIER_C_TYPES = new Set(['Medical / hospital', 'Corporate campus', 'Public / civic']);
const TIER_A_IDS = new Set(['pros-v01', 'pros-e02', 'pros-e21', 'pros-e22', 'pros-e23', 'pros-s01', 'pros-s14']);
const TIER_B_GYMS = /life time|ymca|recreation|sportsplex/i;
const TIER_C_CO = /marriott|drury|embassy suites|doubletree|the harpeth|gaylord|topgolf|dave & buster|pinewood social|eastside bowl|five iron|amc |regal |malco /i;
const TIER_C_IDS = new Set(['pros-h12']);

export function tierOf(l) {
  if (!l.prospect) return '';
  if (TIER_A_IDS.has(l.id)) return 'A';
  if (TIER_C_IDS.has(l.id)) return 'C';
  const vt = l.data.venue_type || '', co = l.data.company || '';
  if (TIER_C_CO.test(co)) return 'C';
  if (TIER_C_TYPES.has(vt)) return 'C';
  if (vt === 'Gym / fitness') return TIER_B_GYMS.test(co) ? 'B' : 'A';
  if (TIER_A_TYPES.has(vt)) return 'A';
  return 'B';
}

/* last touch = newest "[M/D h:mmap]" stamp in the note (Command stamps every logged action) */
export function lastTouchDays(l, now = new Date()) {
  const ms = [...(l.note || '').matchAll(/\[(\d{1,2})\/(\d{1,2})[^\]]*\]/g)];
  if (!ms.length) return null;
  const t = centralParts(now), today = dayNum(t.y, t.m, t.d);
  let best = null;
  ms.forEach(m => {
    let n = dayNum(t.y, +m[1], +m[2]);
    if (n > today) n = dayNum(t.y - 1, +m[1], +m[2]);
    if (best == null || n > best) best = n;
  });
  return Math.max(0, today - best);
}
/* decision-maker from the note: last "Decision-makers: Name (Title); ..." line wins */
export function dmOf(l) {
  const ms = [...((l && l.note) || '').matchAll(/Decision-makers?: ([^\n]+)/gi)];
  if (!ms.length) return null;
  const raw = ms[ms.length - 1][1].trim();
  if (!raw || /^(none|n\/a|unknown|tbd|not |\?|-)/i.test(raw)) return null;
  const first = raw.split(/; |\s[|·]\s/)[0];
  const t = /^(.*?)\s*\(([^)]*)\)/.exec(first);
  const name = (t ? t[1] : first).trim(), title = t ? t[2].trim() : '';
  return name ? { name, title } : null;
}
export const firstName = n => (n || '').trim().split(' ')[0] || '';
export function doorTouched(l) { return /\] (No answer|Left card|Come back|Interested|NOT NOW)/.test((l && l.note) || ''); }
export function fuDue(l, today) { return !!l.followup && l.followup <= today && !['dead', 'installed'].includes(l.status); }
export function installDaysLeft(l, now = new Date()) { const d = daysSinceISO(l.signed_at, now); return d == null ? null : 14 - d; }
export function distMi(a, b, c, d) {
  const R = 3958.8, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export function distFromHome(l) { return l.lat ? distMi(CFG.home[0], CFG.home[1], l.lat, l.lng) : null; }
export function phoneOf(l) { return (l.data.phone || l.metaPhone || '').trim(); }
export function emailOf(l) {
  const e = (l.data.email || l.metaEmail || '').trim();
  if (e) return e;
  const m = /Emails?: *([^\s,;]+@[^\s,;]+)/i.exec(l.note || '');
  return m ? m[1] : '';
}
export function greetName(l) {
  return firstName(l.data.name) || (dmOf(l) ? firstName(dmOf(l).name) : '');
}

/* ---------- data loading ---------- */
async function fetchJSON(url, opts = {}, ms = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { ok: r.ok, status: r.status, json: j, text };
  } finally { clearTimeout(t); }
}
const keyHeaders = () => ({ 'X-Dash-Key': CFG.dashKey });

export async function fetchLeads() {
  const r = await fetchJSON(`${CFG.site}/.netlify/functions/leads`, { headers: keyHeaders() });
  if (!r.ok || !r.json) throw new Error(`leads: HTTP ${r.status}${r.json?.error ? ' — ' + r.json.error : ''}`);
  return { leads: r.json.leads || [], meta: r.json.meta || {} };
}

/* The prospect database lives in command.html (single source of truth Paige edits).
   Pull the same array the browser evaluates, so the brief never drifts from the app. */
export function extractProspects(html) {
  const grab = (startTok, endTok) => {
    const s = html.indexOf(startTok); if (s < 0) return null;
    const e = html.indexOf(endTok, s + startTok.length); if (e < 0) return null;
    return html.slice(s + startTok.length, e + (endTok === '\n];' ? 2 : 1));
  };
  const src = grab('const PROSPECTS=', '\n];');
  if (!src) throw new Error('PROSPECTS not found in command.html');
  const prospects = new Function(`"use strict"; return (${src.trim().replace(/;$/, '')});`)();
  let renames = {};
  const rs = grab('const RENAMES=', ';\n');
  if (rs) { try { renames = new Function(`"use strict"; return (${rs.trim().replace(/;$/, '')});`)(); } catch { /* optional */ } }
  if (!Array.isArray(prospects)) throw new Error('PROSPECTS did not evaluate to an array');
  return { prospects, renames };
}
export async function fetchProspects() {
  const r = await fetch(`${CFG.site}/command.html`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`command.html: HTTP ${r.status}`);
  return extractProspects(await r.text());
}
/* Field-added prospects (Command's "+Add"), if this build of ops.js persists them. Tolerant: any shape, any failure → none. */
export async function fetchFieldProspects() {
  try {
    const r = await fetchJSON(`${CFG.site}/.netlify/functions/ops?doc=prospects`, { headers: keyHeaders() }, 8000);
    if (!r.ok || !r.json) return [];
    const d = r.json.data ?? r.json;
    const arr = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : Array.isArray(d?.prospects) ? d.prospects : [];
    return arr.filter(p => p && p.id && (p.company || p.name));
  } catch { return []; }
}

/* mirrors Command's mergeFieldMeta(): the phone's copy (ops "prospects" doc) wins, but lines the agents
   appended through lead-status are kept, and blank contact fields are filled from them */
export function mergeFieldMeta(pm, sm) {
  const m = Object.assign({}, sm, pm), have = new Set(String(pm.note || '').split('\n'));
  const extra = String(sm.note || '').split('\n').filter(x => x.trim() && !have.has(x));
  m.note = extra.length ? (pm.note ? pm.note + '\n' : '') + extra.join('\n') : (pm.note || '');
  for (const k of ['followup', 'email', 'phone', 'coi']) m[k] = pm[k] || sm[k] || '';
  return m;
}

/* same shape Command builds in buildFrom() */
export function buildLeads({ leads, meta }, prospects, renames = {}) {
  const inbound = leads.map(l => {
    const m = meta[l.id] || {};
    return {
      id: l.id, created_at: l.created_at || null, prospect: false,
      data: l.data || {},
      fit: 0, flag: '', lat: l.lat, lng: l.lng, geoApprox: false,
      status: l.status || m.status || 'new',
      payout: l.payout || m.payout || '',
      followup: l.followup || m.followup || '',
      metaPhone: m.phone || '', metaEmail: m.email || '',
      signed_at: l.signed_at || m.signed_at || '',
      coi: l.coi || m.coi || '',
      note: l.note || m.note || '',
    };
  }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  const seen = new Set(inbound.map(l => l.id));
  const pros = prospects.filter(p => p && p.id && !seen.has(p.id)).map(p => {
    const m = p.meta ? mergeFieldMeta(p.meta, meta[p.id] || {}) : (meta[p.id] || {}); // field-added prospects carry their own status/notes
    const rn = renames[p.id];
    return {
      id: p.id, created_at: null, prospect: true,
      data: {
        name: '', company: rn?.[0] || p.company || p.name || '', venue_type: p.venue_type || '', city: p.city || '',
        address: p.address || '', phone: p.phone || '', website: p.website || '', size: p.size || '', brand: p.brand || '',
        intel: (rn ? 'Formerly ' + rn[1] + '. ' : '') + (p.intel || ''), lead_type: 'Prospect',
      },
      fit: +p.fit || 0, flag: p.flag || '', lat: p.lat, lng: p.lng, geoApprox: p.geo === 'approx',
      status: m.status || 'prospect', payout: m.payout || '', followup: m.followup || '',
      metaPhone: m.phone || '', metaEmail: m.email || '',
      signed_at: m.signed_at || '', coi: m.coi || '', note: m.note || '',
    };
  });
  return [...inbound, ...pros];
}

/* ---------- brief items ---------- */
function noteTail(note, n = 2) {
  const lines = (note || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines.slice(-n).join(' · ').slice(0, 180);
}
export function item(l, why, extra = {}) {
  const dm = dmOf(l), dist = distFromHome(l);
  return {
    id: l.id, co: l.data.company || l.data.name || l.id, name: l.data.name || '', first: greetName(l),
    dm: dm ? dm.name + (dm.title ? ` (${dm.title})` : '') : '',
    status: l.status, tier: tierOf(l), fit: l.prospect ? l.fit : null, score: l.prospect ? null : (+l.data.lead_score || 0),
    city: l.data.city || '', venue: l.data.venue_type || '', address: l.data.address || '',
    phone: phoneOf(l), email: emailOf(l),
    followup: l.followup || '', touch_days: lastTouchDays(l),
    dist_mi: dist == null ? null : Math.round(dist * 10) / 10, approx: !!l.geoApprox,
    why, note_tail: noteTail(l.note), ...extra,
  };
}

/* =====================================================================
   PIPELINE AGENT
   ===================================================================== */
export function pipelineAgent(leads, { now = new Date(), prevCounts = null } = {}) {
  const today = todayISO(now);
  const P = { due: [], hot: [], fresh: [], unscheduled: [], door_run: [] };
  const rank = { proposal: 0, signed: 1, waitlist: 2, contacted: 3, new: 4, prospect: 5 };

  // 1. Follow-ups due today or overdue
  leads.filter(l => fuDue(l, today)).forEach(l => {
    const over = daysSinceISO(l.followup, now) || 0;
    P.due.push(item(l, over > 0 ? `Follow-up was due ${fmtMD(l.followup)} — ${over} day${over === 1 ? '' : 's'} overdue` : 'Follow-up due today', { overdue: over }));
  });
  P.due.sort((a, b) => (b.overdue - a.overdue) || ((rank[a.status] ?? 9) - (rank[b.status] ?? 9)));

  // 2. Hot inbound (site form, score ≥ 70) still New/Contacted and untouched for 2+ days
  leads.filter(l => !l.prospect && (+l.data.lead_score || 0) >= 70 && ['new', 'contacted'].includes(l.status)).forEach(l => {
    const ageD = l.created_at ? Math.floor((now - new Date(l.created_at)) / 864e5) : 0;
    const t = lastTouchDays(l, now);
    if (ageD >= 2 && (t == null || t >= 2) && !fuDue(l, today))
      P.hot.push(item(l, `Hot lead (score ${+l.data.lead_score}) — ${t == null ? `no touch logged, came in ${ageD} days ago` : `last touch ${t} days ago`}`, { age_days: ageD }));
  });
  P.hot.sort((a, b) => (b.score - a.score) || (b.age_days - a.age_days));

  // 3. Fresh inbound — anything from the site in the last 24h, respond today
  leads.filter(l => !l.prospect && l.created_at && now - new Date(l.created_at) < 864e5 && l.status === 'new')
    .forEach(l => P.fresh.push(item(l, `New ${/referral/i.test(l.data.lead_type || '') ? 'referral' : 'site lead'} — ${l.data.contact_method ? 'wants: ' + l.data.contact_method + (l.data.best_time ? ', ' + l.data.best_time : '') : 'respond today'}`)));

  // 4. Fell through the cracks: Contacted with no follow-up date and no touch in 5+ days (quiet proposals are deal-watch's job)
  leads.filter(l => l.status === 'contacted' && !l.followup).forEach(l => {
    const t = lastTouchDays(l, now);
    if (t == null || t >= 5) P.unscheduled.push(item(l, `Contacted, no follow-up scheduled — ${t == null ? 'no touch logged' : `last touch ${t} days ago`}. Set a date or mark dead.`));
  });
  P.unscheduled.sort((a, b) => ((b.touch_days ?? 999) - (a.touch_days ?? 999)));
  P.unscheduled = P.unscheduled.slice(0, 12);

  // 5. Door run — untouched Tier-A prospects ranked the way Command's Today plan ranks them, from home base
  const cand = leads.filter(l => l.prospect && l.status === 'prospect' && !l.flag && tierOf(l) === 'A' && lastTouchDays(l, now) == null && !l.followup);
  const key = l => (l.fit || 0) + (dmOf(l) ? 8 : 0) - Math.min(distFromHome(l) ?? 15, 30) * 1.5 - (l.geoApprox ? 4 : 0);
  cand.sort((a, b) => key(b) - key(a));
  P.door_run = cand.slice(0, 6).map(l => item(l, `Tier A · fit ${l.fit}${dmOf(l) ? ' · ask for ' + firstName(dmOf(l).name) : ''}${distFromHome(l) != null ? ` · ${l.geoApprox ? '~' : ''}${Math.round(distFromHome(l))} mi` : ''}`));

  // Stats + movement since the last brief
  const counts = {}; STATUSES.forEach(s => counts[s] = leads.filter(l => l.status === s).length);
  counts.inbound = leads.filter(l => !l.prospect).length;
  const delta = {};
  if (prevCounts) STATUSES.forEach(s => { const d = counts[s] - (prevCounts[s] ?? counts[s]); if (d) delta[s] = d; });
  return { sections: P, counts, delta };
}

/* =====================================================================
   DEAL-WATCH AGENT
   ===================================================================== */
export function dealWatchAgent(leads, { now = new Date() } = {}) {
  const today = todayISO(now);
  const D = { installs: [], coi: [], stale_proposals: [], waitlist: [], statements: [] };

  // 1. Signed → installed: 14-day clock (Command sets signed_at the day status flips to Signed)
  leads.filter(l => l.status === 'signed').forEach(l => {
    if (!l.signed_at) { D.installs.push(item(l, 'Signed but no signed date on the card — set it so the 14-day clock runs', { days_left: null, level: 'warn' })); return; }
    const left = installDaysLeft(l, now);
    const level = left < 0 ? 'overdue' : left <= 4 ? 'soon' : 'ok';
    const by = isoPlusDays(left, now);
    D.installs.push(item(l, left < 0 ? `Install OVERDUE by ${-left} day${left === -1 ? '' : 's'} (promised by ${fmtMD(by)})` : left === 0 ? 'Install due TODAY' : `Install due in ${left} day${left === 1 ? '' : 's'} (by ${fmtMD(by)})`, { days_left: left, level, signed_at: l.signed_at }));
  });
  D.installs.sort((a, b) => ((a.days_left ?? -99) - (b.days_left ?? -99)));

  // 2. COI requested and not yet sent
  leads.filter(l => ['proposal', 'signed', 'waitlist', 'installed'].includes(l.status) && l.coi === 'requested')
    .forEach(l => D.coi.push(item(l, 'Insurance form (COI) requested — send it', { level: 'soon' })));

  // 3. Proposals going quiet: out 7+ days with no touch and nothing scheduled
  leads.filter(l => l.status === 'proposal' && !fuDue(l, today)).forEach(l => { // a due follow-up is already in the pipeline list
    const t = lastTouchDays(l, now);
    const scheduled = l.followup && l.followup > today;
    if (!scheduled && (t == null || t >= 7))
      D.stale_proposals.push(item(l, `Proposal out, ${t == null ? 'no touch logged' : `quiet ${t} days`} — nudge or ask what's holding it up`));
  });
  D.stale_proposals.sort((a, b) => ((b.touch_days ?? 999) - (a.touch_days ?? 999)));

  // 4. Waitlist — hosts who said yes and are waiting on a machine
  leads.filter(l => l.status === 'waitlist').forEach(l => {
    const t = lastTouchDays(l, now);
    D.waitlist.push(item(l, `Waiting on a machine${t != null ? ` · last touch ${t} days ago` : ''}${l.coi === 'requested' ? ' · COI requested' : ''}`));
  });
  D.waitlist.sort((a, b) => ((b.touch_days ?? 0) - (a.touch_days ?? 0)));

  // 5. Month start: host statements + 10% disbursements for every installed location (days 1–3 Central)
  const dom = centralParts(now).d;
  if (dom <= 3) {
    leads.filter(l => l.status === 'installed').forEach(l => D.statements.push(item(l, 'Monthly statement + 10% host disbursement due for last month')));
  }
  return { sections: D, month_start: dom <= 3 };
}

/* =====================================================================
   DRAFTS — AI-written when ANTHROPIC_API_KEY is set, template otherwise.
   Nothing is sent: Command shows them with Copy / Text / Email buttons.
   ===================================================================== */
const SIGN_SMS = `— Paige, Wrapt ${CFG.paige.phone}`;
const SIGN_EMAIL = `${CFG.paige.name}\nOwner, Wrapt\n${CFG.paige.phone} · wraptvending.com`;

export function templateDraft(it) {
  const hi = it.first ? `Hi ${it.first},` : 'Hi there,';
  const co = it.co;
  if (it.kind === 'hot' || it.kind === 'fresh') {
    return {
      sms: `${hi} Paige with Wrapt here in Franklin — thanks for reaching out about a cooler at ${co}. Is there a good time this week for a quick call or a five-minute visit? ${SIGN_SMS}`,
      email_subject: `Your smart cooler at ${co}`,
      email_body: `${hi}\n\nThanks for reaching out about a cooler at ${co}. The short version: we place a custom-wrapped smart cooler in your space at zero cost, we stock and service it weekly, and ${co} keeps 10% of net sales, paid monthly with a statement.\n\nIs there a good time this week for a quick call, or could I stop by for five minutes with a mockup in your colors?\n\n${SIGN_EMAIL}`,
    };
  }
  if (it.status === 'proposal') {
    return {
      sms: `${hi} Paige with Wrapt — checking in on the proposal for ${co}. Happy to answer anything: where it would go, what goes in it, or how the 10% gets paid. Want me to swing by this week? ${SIGN_SMS}`,
      email_subject: `Following up — Wrapt at ${co}`,
      email_body: `${hi}\n\nChecking in on the proposal for ${co}. Happy to answer anything — where it would go, what goes in it, or how the 10% gets paid.\n\nIf it's easier, I can swing by for five minutes this week and show you the wrap mockup with your logo on it.\n\n${SIGN_EMAIL}`,
    };
  }
  const visited = /\] (No answer|Left card|Come back|Interested|NOT NOW)/.test(it.note_full || it.note_tail || '');
  return {
    sms: `${hi} Paige with Wrapt here in Franklin — ${visited ? `I stopped by ${co} recently` : `circling back on the smart cooler for ${co}`}. It's free to the host, wrapped in your branding, and ${co} keeps 10% of net sales. Could I show you a quick mockup this week? ${SIGN_SMS}`,
    email_subject: `Following up — Wrapt at ${co}`,
    email_body: `${hi}\n\nJust circling back on the smart cooler for ${co}. Happy to answer anything — where it would go, what goes in it, or how the 10% gets paid.\n\nIf it's easier, I can swing by for five minutes this week and show you the wrap mockup with your logo on it.\n\n${SIGN_EMAIL}`,
  };
}

const DRAFT_SYSTEM = `You draft outreach messages for Paige Fryer, owner of Wrapt (wraptvending.com), a Franklin, Tennessee company that places free, custom-wrapped smart coolers in local businesses. The cooler is a grab-and-go AI cooler: tap a card, grab, auto-checkout. No coins, no buttons.

FACTS YOU MAY USE — never invent others:
- Zero cost to the host. Wrapt installs, stocks and services the cooler weekly.
- The host keeps 10% of net sales, paid monthly with a statement.
- The cooler is wrapped in the host's branding so it looks like theirs. A custom wrap is a premium perk for select locations — mention it as a mockup Paige can show, never as a guarantee.
- The agreement is two pages. It is a multi-year placement (host chooses 3, 4 or 5 years). NEVER mention a trial, a 30-day out, referral payments, or any dollar figure.
- Install takes about an hour and needs three feet of wall plus a standard outlet.
- Paige: 615.948.2976 · paige@wraptvending.com.

VOICE: Paige's. Warm, plain, short sentences, local ("here in Franklin"). Never salesy or corporate. No exclamation marks, no emojis, no "I hope this finds you well", no "touching base". Use the lead's note history (who she spoke with, what they said, what she promised, whether she stopped by or got no answer) when it exists — and never invent a prior conversation that is not in the notes. Address the person by first name only when a name is given.

OUTPUT: a JSON array only, no prose, no code fence:
[{"id":"<lead id>","sms":"<≤ 300 chars, ends with '— Paige, Wrapt 615.948.2976'>","email_subject":"<≤ 60 chars>","email_body":"<≤ 110 words, plain text, ends with 'Paige Fryer\\nOwner, Wrapt\\n615.948.2976 · wraptvending.com'>"}]`;

export async function draftWithClaude(items) {
  const payload = items.map(it => ({
    id: it.id, company: it.co, contact_first_name: it.first || null, decision_maker: it.dm || null,
    venue_type: it.venue, city: it.city, pipeline_status: it.status, why_now: it.why, kind: it.kind,
    note_history: it.note_full || '', product_interests: it.product_interests || '', referral: it.referral || false,
  }));
  const j = await claudeCall({
    // no temperature: current Claude models reject non-default sampling. Low effort keeps thinking short so the run fits its timeout.
    model: CFG.model, max_tokens: 8000, output_config: { effort: 'low' }, system: DRAFT_SYSTEM,
    messages: [{ role: 'user', content: `Today is ${todayISO()}. Draft one text and one email for each of these leads:\n${JSON.stringify(payload, null, 1)}` }],
  }, { apiKey: CFG.anthropicKey, timeoutMs: 60000 }); // background worker only (15-min limit)
  const text = textOf(j);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('claude: no JSON array in reply');
  const arr = JSON.parse(m[0]);
  const out = {};
  arr.forEach(d => { if (d && d.id && (d.sms || d.email_body)) out[d.id] = { sms: String(d.sms || ''), email_subject: String(d.email_subject || ''), email_body: String(d.email_body || '') }; });
  return out;
}

/* pick who gets a draft this morning, in priority order, capped */
export function pickDraftTargets(pipe, deal, leads, max) {
  const byId = new Map(leads.map(l => [l.id, l]));
  const tag = (arr, kind) => arr.map(it => ({ ...it, kind }));
  const ordered = [
    ...tag(pipe.sections.due.filter(i => i.overdue > 0), 'due'),
    ...tag(pipe.sections.hot, 'hot'),
    ...tag(pipe.sections.fresh, 'fresh'),
    ...tag(pipe.sections.due.filter(i => !i.overdue), 'due'),
    ...tag(deal.sections.stale_proposals, 'stale'),
  ];
  const seen = new Set(), out = [];
  for (const it of ordered) {
    if (seen.has(it.id) || (it.status === 'prospect' && !it.followup)) continue; // never cold-draft an untouched prospect
    seen.add(it.id);
    const l = byId.get(it.id);
    out.push({ ...it, note_full: (l?.note || '').slice(-1200), product_interests: l?.data?.product_interests || '', referral: /referral/i.test(l?.data?.lead_type || '') });
    if (out.length >= max) break;
  }
  return out;
}

/* =====================================================================
   RUN — load, think, store, (email), return the brief
   ===================================================================== */
export function summaryLine(pipe, deal) {
  const P = pipe.sections, D = deal.sections, bits = [];
  const over = P.due.filter(i => i.overdue > 0).length;
  if (P.due.length) bits.push(`${P.due.length} follow-up${P.due.length === 1 ? '' : 's'} due${over ? ` (${over} overdue)` : ''}`);
  if (P.fresh.length) bits.push(`${P.fresh.length} new site lead${P.fresh.length === 1 ? '' : 's'}`);
  if (P.hot.length) bits.push(`${P.hot.length} hot lead${P.hot.length === 1 ? '' : 's'} untouched`);
  const inst = D.installs.filter(i => i.level === 'overdue' || i.level === 'soon').length;
  if (inst) bits.push(`${inst} install${inst === 1 ? '' : 's'} due this week`);
  if (D.coi.length) bits.push(`${D.coi.length} COI to send`);
  if (D.stale_proposals.length) bits.push(`${D.stale_proposals.length} proposal${D.stale_proposals.length === 1 ? '' : 's'} gone quiet`);
  if (P.unscheduled.length) bits.push(`${P.unscheduled.length} with no follow-up set`);
  if (D.waitlist.length) bits.push(`${D.waitlist.length} on the waitlist`);
  if (D.statements.length) bits.push(`${D.statements.length} host statement${D.statements.length === 1 ? '' : 's'} due`);
  return bits.length ? bits.join(' · ') : 'Pipeline is clean — nothing due. Knock some doors.';
}

export async function getStoreSafe(injected) {
  if (injected) return injected;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: CFG.storeName, consistency: 'strong' });
}

export async function getLatestBrief(store) {
  try { const s = await getStoreSafe(store); return await s.get('brief/latest', { type: 'json' }); } catch { return null; }
}

// aiDrafts:false → template drafts only (the inline fallback inside a 30-second scheduled function can't wait on Claude)
export async function runAgents({ trigger = 'scheduled', store = null, now = new Date(), fetchers = {}, aiDrafts = true } = {}) {
  const t0 = Date.now(), errors = [];
  const load = async (name, fn, fallback) => { try { return await fn(); } catch (e) { errors.push(`${name}: ${e.message}`); return fallback; } };

  const prev = await load('previous brief', () => getLatestBrief(store), null);
  const raw = await load('leads', fetchers.leads || fetchLeads, { leads: [], meta: {} });
  const pr = await load('prospects', fetchers.prospects || fetchProspects, { prospects: [], renames: {} });
  const field = await load('field prospects', fetchers.fieldProspects || fetchFieldProspects, []);
  const leads = buildLeads(raw, [...pr.prospects, ...field], pr.renames);

  const pipe = pipelineAgent(leads, { now, prevCounts: prev?.counts || null });
  const deal = dealWatchAgent(leads, { now });

  // drafts
  const targets = pickDraftTargets(pipe, deal, leads, CFG.maxDrafts);
  let drafts = {}, drafts_source = 'none';
  if (targets.length) {
    drafts_source = 'template';
    targets.forEach(it => { drafts[it.id] = templateDraft(it); });
    if (CFG.anthropicKey && aiDrafts) {
      try { const ai = await draftWithClaude(targets); Object.assign(drafts, ai); drafts_source = Object.keys(ai).length ? 'claude' : 'template'; }
      catch (e) { errors.push(e.message); }
    }
  }

  const brief = {
    v: 1, generated_at: now.toISOString(), day: todayISO(now), trigger, site: CFG.site,
    summary: summaryLine(pipe, deal),
    counts: pipe.counts, delta: pipe.delta, total_leads: leads.length, inbound: pipe.counts.inbound,
    pipeline: pipe.sections, dealwatch: deal.sections, month_start: deal.month_start,
    drafts, drafts_source, draft_targets: targets.map(t => t.id),
    errors, ms: Date.now() - t0,
  };

  try {
    const s = await getStoreSafe(store);
    await s.setJSON('brief/latest', brief);
    await s.setJSON(`brief/${brief.day}`, brief);
  } catch (e) { errors.push(`store: ${e.message}`); }

  if (process.env.BRIEF_TO) { // every "Run now" would otherwise send another email: at most one per 30 minutes
    try {
      const s = await getStoreSafe(store), last = (await s.get('brief/emailed_at', { type: 'json' }).catch(() => null))?.ts;
      if (last && now - new Date(last) < 30 * 60e3) brief.email_skipped = `brief emailed at ${last}; next one after 30 minutes`;
      else { await emailBrief(brief); await s.setJSON('brief/emailed_at', { ts: now.toISOString() }).catch(() => {}); }
    } catch (e) { errors.push(`email: ${e.message}`); }
  }
  return brief;
}

/* ---------- optional email (nodemailer is already a site dependency) ---------- */
export function briefText(b) {
  const L = [];
  const sec = (title, arr, f) => { if (!arr?.length) return; L.push('', `## ${title} (${arr.length})`); arr.forEach(i => L.push(`- ${i.co}${i.city ? ', ' + i.city : ''} — ${f ? f(i) : i.why}`)); };
  L.push(`WRAPT MORNING BRIEF — ${b.day}`, b.summary);
  const d = Object.entries(b.delta || {}).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`).join(', ');
  if (d) L.push(`Since last brief: ${d}`);
  L.push('', '# PIPELINE');
  sec('Follow-ups due', b.pipeline.due); sec('Hot & untouched', b.pipeline.hot); sec('New from the site', b.pipeline.fresh);
  sec('No follow-up scheduled', b.pipeline.unscheduled); sec('Door run (Tier A, from home)', b.pipeline.door_run);
  L.push('', '# DEAL WATCH');
  sec('Installs', b.dealwatch.installs); sec('COI to send', b.dealwatch.coi); sec('Proposals gone quiet', b.dealwatch.stale_proposals);
  sec('Waitlist', b.dealwatch.waitlist); sec('Host statements due', b.dealwatch.statements);
  const ids = Object.keys(b.drafts || {});
  if (ids.length) {
    L.push('', `# DRAFTS (${b.drafts_source})`);
    ids.forEach(id => { const dr = b.drafts[id]; const it = [...b.pipeline.due, ...b.pipeline.hot, ...b.pipeline.fresh, ...b.dealwatch.stale_proposals].find(i => i.id === id); L.push('', `## ${it?.co || id}`, `TEXT: ${dr.sms}`, '', `EMAIL — ${dr.email_subject}`, dr.email_body); });
  }
  if (b.errors?.length) L.push('', '# NOTES', ...b.errors.map(e => '- ' + e));
  L.push('', `Open Command → Today to act on this. Generated ${b.generated_at} (${b.ms} ms).`);
  return L.join('\n');
}
/* SMTP settings: SMTP_* first, then the names the site's existing email function may already use */
const pickEnv = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return ''; };
export function smtpConfig() {
  const host = pickEnv('SMTP_HOST', 'EMAIL_HOST', 'MAIL_HOST');
  const user = pickEnv('SMTP_USER', 'SMTP_USERNAME', 'EMAIL_USER', 'MAIL_USER', 'GMAIL_USER');
  const pass = pickEnv('SMTP_PASS', 'SMTP_PASSWORD', 'EMAIL_PASS', 'EMAIL_PASSWORD', 'MAIL_PASS', 'GMAIL_PASS', 'GMAIL_APP_PASSWORD');
  const port = +(pickEnv('SMTP_PORT', 'EMAIL_PORT', 'MAIL_PORT') || 587);
  const from = pickEnv('BRIEF_FROM', 'EMAIL_FROM', 'MAIL_FROM') || user;
  // a Gmail / Workspace app password with no host given → Google's SMTP
  const h = host || (/@(gmail\.com|wraptvending\.com)$/i.test(user) && pass ? 'smtp.gmail.com' : '');
  return { ok: !!(h && from), host: h, port, secure: port === 465, user, pass, from };
}
export async function makeTransport() {
  const c = smtpConfig();
  if (!c.ok) throw new Error('SMTP not configured (SMTP_HOST / SMTP_USER / SMTP_PASS / BRIEF_FROM)');
  const nodemailer = (await import('nodemailer')).default;
  return nodemailer.createTransport({ host: c.host, port: c.port, secure: c.secure, auth: c.user ? { user: c.user, pass: c.pass } : undefined });
}
export async function emailBrief(b) {
  const tr = await makeTransport();
  const text = briefText(b);
  await tr.sendMail({
    from: smtpConfig().from, to: process.env.BRIEF_TO,
    subject: `Wrapt brief ${fmtMD(b.day)} — ${b.summary.slice(0, 90)}`,
    text, html: `<pre style="font:14px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap">${text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`,
  });
}

/* ---------- auth for the HTTP endpoint: same header Command sends ---------- */
export function authOk(req) {
  return dashKeyCheck(req).ok; // header only; refuses everything when DASH_KEY is unset
}
export const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
