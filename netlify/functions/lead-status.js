// POST /.netlify/functions/lead-status  { id, status?, note?, payout?, followup?, phone?, email? }
// Persists pipeline status + note per submission id in Netlify Blobs.
// Auth: X-Dash-Key header must match DASH_KEY env var (defaults to "wrapt").
//
// Each lead's meta lives in its own blob ("m:<id>") so concurrent saves from
// two devices touch different keys instead of racing over one shared JSON.
// The old single "meta" blob is read once as a fallback base per lead.

import { getStore } from "@netlify/blobs";

const STATUSES = ["prospect", "new", "contacted", "proposal", "signed", "waitlist", "installed", "dead"];
const PAYOUTS = ["", "unpaid", "paid"];
const COI = ["", "requested", "sent"];

export default async (req) => {
  const REQUIRED_KEY = process.env.DASH_KEY || "wrapt";
  if (req.headers.get("x-dash-key") !== REQUIRED_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const { id, status, note, payout, followup, phone, email, signed_at, coi } = body || {};
  if (!id || typeof id !== "string" || id.length > 80) return Response.json({ error: "id required" }, { status: 400 });
  if (status !== undefined && !STATUSES.includes(status))
    return Response.json({ error: "bad status" }, { status: 400 });
  if (payout !== undefined && !PAYOUTS.includes(payout))
    return Response.json({ error: "bad payout" }, { status: 400 });

  const store = getStore("wrapt-command");

  // base: this lead's own blob, else its entry in the legacy shared blob
  let cur = null;
  try { cur = await store.get("m:" + id, { type: "json" }); } catch (e) {}
  if (!cur) {
    try {
      const legacy = (await store.get("meta", { type: "json" })) || {};
      cur = legacy[id] || {};
    } catch (e) { cur = {}; }
  }

  if (status !== undefined) cur.status = status;
  if (note !== undefined) cur.note = String(note).slice(0, 5000);
  if (payout !== undefined) cur.payout = payout;
  if (followup !== undefined) {
    const f = String(followup).slice(0, 10);
    if (f === "" || /^\d{4}-\d{2}-\d{2}$/.test(f)) cur.followup = f;
  }
  if (signed_at !== undefined) {
    const sa = String(signed_at).slice(0, 10);
    if (sa === "" || /^\d{4}-\d{2}-\d{2}$/.test(sa)) cur.signed_at = sa;
  }
  if (coi !== undefined && COI.includes(coi)) cur.coi = coi;
  if (phone !== undefined) cur.phone = String(phone).replace(/[^\d+() .-]/g, "").slice(0, 24);
  if (email !== undefined) cur.email = String(email).trim().slice(0, 120);
  cur.updated = new Date().toISOString();

  await store.setJSON("m:" + id, cur);

  return Response.json({ ok: true, meta: cur });
};
