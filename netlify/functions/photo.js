// Per-prospect/lead photos, stored in Netlify Blobs.
// POST   (X-Dash-Key) { id, image: dataURL }  -> store compressed JPEG/PNG
// GET    ?id=...&k=KEY                        -> serve the image (img-tag friendly)
// GET    ?list=1  (X-Dash-Key or ?k=)         -> { ids: [...] }
// POST   { id, remove: true }                 -> delete
import { getStore } from "@netlify/blobs";
import { dashKeyDenied } from "./lib/dash-key.mjs";

const MAX_BYTES = 4.5 * 1024 * 1024;

export default async (req) => {
  const url = new URL(req.url);
  const denied = dashKeyDenied(req, { allowQuery: true }); // <img src> can't send headers
  if (denied) return denied;

  const store = getStore("wrapt-photos");

  if (req.method === "GET") {
    if (url.searchParams.get("list")) {
      const ids = [];
      try {
        const { blobs } = await store.list();
        for (const b of blobs) ids.push(b.key);
      } catch (e) {
        console.error("photo list failed", e);
      }
      return Response.json({ ids });
    }
    const id = (url.searchParams.get("id") || "").slice(0, 80);
    if (!id) return new Response("missing id", { status: 400 });
    const buf = await store.get(id, { type: "arrayBuffer" });
    if (!buf) return new Response("not found", { status: 404 });
    const meta = await store.getMetadata(id).catch(() => null);
    const type = meta?.metadata?.type || "image/jpeg";
    return new Response(buf, {
      status: 200,
      headers: { "Content-Type": type, "Cache-Control": "private, max-age=300" },
    });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch (_) {
      return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
    }
    const id = String(body.id || "").slice(0, 80);
    if (!/^[\w:-]+$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 });

    if (body.remove) {
      await store.delete(id).catch(() => {});
      return Response.json({ ok: true, removed: id });
    }

    const dataUrl = String(body.image || "");
    const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return Response.json({ error: "bad image" }, { status: 400 });
    const bytes = Buffer.from(m[2], "base64");
    if (bytes.length > MAX_BYTES) return Response.json({ error: "too large" }, { status: 413 });

    await store.set(id, bytes, { metadata: { type: m[1], at: new Date().toISOString() } });
    return Response.json({ ok: true, id, size: bytes.length });
  }

  return new Response("method not allowed", { status: 405 });
};
