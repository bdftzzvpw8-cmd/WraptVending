// One rule for every function that checks the dashboard key.
// Fails closed: no DASH_KEY set → every request is refused (503), never "open" and never a default key.
// Constant-time compare. `allowQuery` lets <img src="...?k="> photo URLs keep working; nothing else should use it.
import { timingSafeEqual } from "node:crypto";

export function dashKeyCheck(req, { allowQuery = false } = {}) {
  const want = process.env.DASH_KEY || "";
  if (!want) return { ok: false, status: 503, error: "DASH_KEY is not set on the site" };
  let got = req.headers.get("x-dash-key") || "";
  if (!got && allowQuery) { const u = new URL(req.url); got = u.searchParams.get("k") || u.searchParams.get("key") || ""; }
  const a = Buffer.from(got), b = Buffer.from(want);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
}

export function dashKeyDenied(req, opts) {
  const r = dashKeyCheck(req, opts);
  return r.ok ? null : new Response(JSON.stringify({ error: r.error }), { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
