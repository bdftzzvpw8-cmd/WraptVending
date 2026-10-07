// Ops documents (mileage log, expense log, ops settings, field prospects) stored in Netlify Blobs.
// GET  /.netlify/functions/ops?doc=mileage          -> { data: {...} | null }
// POST /.netlify/functions/ops  { doc, data }       -> replace the document
// Auth: X-Dash-Key header must match DASH_KEY env var (defaults to "wrapt").

import { getStore } from "@netlify/blobs";

const DOCS = ["mileage", "expenses", "opsettings", "prospects"];
const MAX_BYTES = 400 * 1024;

export default async (req) => {
  const REQUIRED_KEY = process.env.DASH_KEY || "wrapt";
  if (req.headers.get("x-dash-key") !== REQUIRED_KEY) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }
  const store = getStore("wrapt-ops");

  if (req.method === "GET") {
    const doc = new URL(req.url).searchParams.get("doc") || "";
    if (!DOCS.includes(doc)) return Response.json({ error: "bad doc" }, { status: 400 });
    let data = null;
    try { data = await store.get(doc, { type: "json" }); } catch (e) { console.error("ops read failed", e); }
    return Response.json({ data });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
    const { doc, data } = body || {};
    if (!DOCS.includes(doc)) return Response.json({ error: "bad doc" }, { status: 400 });
    const raw = JSON.stringify(data ?? null);
    if (raw.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });
    await store.setJSON(doc, data);
    return Response.json({ ok: true });
  }

  return new Response("method not allowed", { status: 405 });
};
