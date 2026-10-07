// Ops documents (mileage log, expense log, ops settings, field prospects) stored in Netlify Blobs.
// GET  /.netlify/functions/ops?doc=mileage          -> { data: {...} | null, updated: ISO | null }
// POST /.netlify/functions/ops  { doc, data, base? } -> replace the document -> { ok, updated }
//   base = the `updated` value the client loaded. If the stored doc changed since (another phone saved),
//   the save is refused with 409 { error: "conflict", data, updated } so the client can merge instead of
//   overwriting. Without `base` the save goes through as before (older Command builds).
// Auth: X-Dash-Key header must match DASH_KEY env var (no default: unset = refused).

import { getStore } from "@netlify/blobs";
import { dashKeyDenied } from "./lib/dash-key.mjs";

const DOCS = ["mileage", "expenses", "opsettings", "prospects"];
const MAX_BYTES = 400 * 1024;
const stampKey = doc => `${doc}:updated`; // kept beside the doc so the doc's own shape never changes

export default async (req) => {
  const denied = dashKeyDenied(req);
  if (denied) return denied;
  const store = getStore("wrapt-ops");
  const readStamp = async doc => { try { return (await store.get(stampKey(doc), { type: "json" }))?.updated || null; } catch { return null; } };

  if (req.method === "GET") {
    const doc = new URL(req.url).searchParams.get("doc") || "";
    if (!DOCS.includes(doc)) return Response.json({ error: "bad doc" }, { status: 400 });
    let data = null;
    try { data = await store.get(doc, { type: "json" }); } catch (e) { console.error("ops read failed", e); }
    return Response.json({ data, updated: await readStamp(doc) });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const { doc, data, base } = body || {};
    if (!DOCS.includes(doc)) return Response.json({ error: "bad doc" }, { status: 400 });
    const raw = JSON.stringify(data ?? null);
    if (raw.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    if (base !== undefined) {
      const cur = await readStamp(doc);
      if (cur && (!base || cur > String(base))) {
        let current = null;
        try { current = await store.get(doc, { type: "json" }); } catch (e) {}
        return Response.json({ error: "conflict", data: current, updated: cur }, { status: 409 });
      }
    }
    const updated = new Date().toISOString();
    try {
      await store.setJSON(doc, data);
      await store.setJSON(stampKey(doc), { updated });
    } catch (e) {
      console.error("ops write failed", e);
      return Response.json({ error: "could not save, try again" }, { status: 503 });
    }
    return Response.json({ ok: true, updated });
  }

  return new Response("method not allowed", { status: 405 });
};
