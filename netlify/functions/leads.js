// GET /.netlify/functions/leads
// Returns all wrapt-lead submissions merged with pipeline status/notes.
// Auth: X-Dash-Key header must match DASH_KEY env var (no default: unset = refused).
// Env vars required: DASH_KEY, NETLIFY_AUTH_TOKEN (personal access token).
// SITE_ID is provided automatically by Netlify.

import { getStore } from "@netlify/blobs";
import { dashKeyDenied } from "./lib/dash-key.mjs";

// Pipeline meta lives in per-lead blobs ("m:<id>") so two devices saving at
// once can't clobber each other. The old single "meta" blob is still read as
// a base layer for anything written before the migration.
export async function readMeta(store) {
  let meta = {};
  try {
    meta = (await store.get("meta", { type: "json" })) || {};
  } catch (e) {
    console.error("legacy meta read failed", e);
  }
  try {
    const { blobs } = await store.list({ prefix: "m:" });
    const entries = await Promise.all(
      blobs.map(async (b) => [b.key.slice(2), await store.get(b.key, { type: "json" }).catch(() => null)])
    );
    for (const [id, v] of entries) if (v) meta[id] = { ...(meta[id] || {}), ...v };
  } catch (e) {
    console.error("per-lead meta read failed", e);
  }
  return meta;
}

export async function fetchAllSubmissions(formId, headers) {
  const all = [];
  for (let page = 1; page <= 30; page++) { // hard stop at 3,000 submissions
    const r = await fetch(
      `https://api.netlify.com/api/v1/forms/${formId}/submissions?per_page=100&page=${page}`,
      { headers }
    );
    if (!r.ok) throw new Error("SUBMISSIONS_FETCH_" + r.status);
    const batch = await r.json();
    all.push(...batch);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }
  return all;
}

export default async (req, context) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  const token = (process.env.NETLIFY_AUTH_TOKEN || "").trim();
  const siteId = process.env.SITE_ID || context?.site?.id;
  if (!token) return Response.json({ error: "TOKEN_MISSING: NETLIFY_AUTH_TOKEN env var is empty on this deploy. Add it, then redeploy." }, { status: 500 });
  if (!siteId) return Response.json({ error: "SITE_UNKNOWN: could not resolve site id. Add a SITE_ID env var (Site configuration > Site details > Site ID), then redeploy." }, { status: 500 });

  const H = { Authorization: `Bearer ${token}` };
  const formsRes = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, { headers: H });
  if (formsRes.status === 401) return Response.json({ error: "TOKEN_REJECTED: Netlify refused the token (401). It was likely rotated or mis-pasted. Create a fresh personal access token, update NETLIFY_AUTH_TOKEN, redeploy." }, { status: 502 });
  if (!formsRes.ok) return Response.json({ error: "FORMS_FETCH_" + formsRes.status + ": Netlify API error reading forms for site " + siteId }, { status: 502 });
  const forms = await formsRes.json();
  const form = forms.find((f) => f.name === "wrapt-lead");

  const store = getStore("wrapt-command");
  const meta = await readMeta(store);

  if (!form) return Response.json({ leads: [], meta });

  let subs;
  try {
    subs = await fetchAllSubmissions(form.id, H);
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 502 });
  }

  const leads = subs.map((s) => ({
    id: s.id,
    created_at: s.created_at,
    data: s.data || {},
    status: meta[s.id]?.status || "new",
    note: meta[s.id]?.note || "",
    payout: meta[s.id]?.payout || "",
    followup: meta[s.id]?.followup || "",
    metaPhone: meta[s.id]?.phone || "",
    metaEmail: meta[s.id]?.email || "",
    signed_at: meta[s.id]?.signed_at || "",
    coi: meta[s.id]?.coi || "",
  }));

  return Response.json({ leads, meta });
};
