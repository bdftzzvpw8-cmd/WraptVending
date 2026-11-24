// POST /.netlify/functions/lead-status  { id, status?, note?, base?, append?, payout?, followup?, phone?, email? }
// Persists pipeline status + note per submission id in Netlify Blobs.
// `append` adds lines to the note as stored right now (agents and Command's loggers use it so they never overwrite a newer note);
// notes keep their newest 5000 chars, since every writer adds at the end.
// `note` replaces the whole note. With `base` (the card's `updated` the phone last saw) it is refused with
// 409 { error: "conflict", meta } if the card changed since, so the phone merges instead of overwriting.
// Without `base` it replaces as before (older cached copies of Command).
// Auth: X-Dash-Key header must match DASH_KEY env var (no default: unset = refused).
//
// Each lead's meta lives in its own blob ("m:<id>") so concurrent saves from
// two devices touch different keys instead of racing over one shared JSON.
// The old single "meta" blob is read once as a fallback base per lead.

import { getStore } from "@netlify/blobs";
import { dashKeyDenied } from "./lib/dash-key.mjs";

const STATUSES = ["prospect", "new", "contacted", "proposal", "signed", "waitlist", "installed", "dead"];
const PAYOUTS = ["", "unpaid", "paid"];
const COI = ["", "requested", "sent"];

export default async (req) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  // strong: an edge-cached read can be a minute stale, and the write below is built on it
  return saveCard(getStore({ name: "wrapt-command", consistency: "strong" }), body);
};

// the save itself, store injected (tests run it on a memory store)
export async function saveCard(store, body) {
  const { id, status, note, base, append, payout, followup, phone, email, signed_at, coi } = body || {};
  if (!id || typeof id !== "string" || id.length > 80) return Response.json({ error: "id required" }, { status: 400 });
  if (status !== undefined && !STATUSES.includes(status))
    return Response.json({ error: "bad status" }, { status: 400 });
  if (payout !== undefined && !PAYOUTS.includes(payout))
    return Response.json({ error: "bad payout" }, { status: 400 });

  // base: this lead's own blob, else its entry in the legacy shared blob. Only null means "new card":
  // a read that throws would otherwise write this patch over the whole card (status, follow-up, note).
  let cur;
  try {
    cur = await store.get("m:" + id, { type: "json" });
    if (!cur) cur = ((await store.get("meta", { type: "json" })) || {})[id] || {};
  } catch (e) {
    console.error("lead-status read failed", id, e);
    return Response.json({ error: "couldn't read the card — nothing saved, try again" }, { status: 503 });
  }
  if (note !== undefined && base !== undefined && cur.updated && cur.updated !== String(base))
    return Response.json({ error: "conflict", meta: cur }, { status: 409 });

  if (status !== undefined) cur.status = status;
  if (note !== undefined) cur.note = String(note).slice(-5000);
  if (append) cur.note = ((cur.note || "").replace(/\s+$/, "") + (cur.note ? "\n" : "") + String(append).trim()).slice(-5000);
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
}
