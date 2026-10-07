// POST: records a pageview { src } — called by a beacon on the public site.
// GET (with X-Dash-Key): returns counts for the Command dashboard.
import { getStore } from "@netlify/blobs";

const SOURCES = ["card", "pamphlet", "direct", "search", "social", "other"];
const EVENTS = ["calc_used", "form_start", "form_step2", "form_submit"];

export default async (req) => {
  const store = getStore("wrapt-analytics");

  if (req.method === "POST") {
    let src = "direct", ev = "";
    try {
      const b = await req.json();
      if (b && b.ev !== undefined) {
        const rawEv = String(b.ev).toLowerCase().slice(0, 24);
        if (!EVENTS.includes(rawEv)) return new Response("", { status: 204 });
        ev = rawEv;
      } else {
        const raw = String(b.src || "direct").toLowerCase().slice(0, 24);
        src = SOURCES.includes(raw) ? raw : "other";
      }
    } catch (_) {}
    const day = new Date().toISOString().slice(0, 10);
    if (ev) { // funnel event — its own counters, not a pageview
      try {
        const c = (await store.get("counts", { type: "json" })) || { total: 0, bySrc: {}, byDay: {} };
        c.ev = c.ev || {};
        c.ev[ev] = (c.ev[ev] || 0) + 1;
        await store.setJSON("counts", c);
      } catch (e) {
        console.error("event write failed", e);
      }
      return new Response("", { status: 204 });
    }
    try {
      const c = (await store.get("counts", { type: "json" })) || { total: 0, bySrc: {}, byDay: {} };
      c.total = (c.total || 0) + 1;
      c.bySrc[src] = (c.bySrc[src] || 0) + 1;
      c.byDay[day] = c.byDay[day] || { total: 0 };
      c.byDay[day].total += 1;
      c.byDay[day][src] = (c.byDay[day][src] || 0) + 1;
      // prune to last 60 days
      const days = Object.keys(c.byDay).sort();
      while (days.length > 60) delete c.byDay[days.shift()];
      await store.setJSON("counts", c);
    } catch (e) {
      console.error("track write failed", e);
    }
    return new Response("", { status: 204 });
  }

  if (req.method === "GET") {
    const REQUIRED_KEY = process.env.DASH_KEY || "wrapt";
    if (req.headers.get("x-dash-key") !== REQUIRED_KEY) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    }
    const c = (await store.get("counts", { type: "json" })) || { total: 0, bySrc: {}, byDay: {} };
    // compute last-7-days total
    let wk = 0;
    const cutoff = Date.now() - 7 * 864e5;
    for (const [d, v] of Object.entries(c.byDay || {})) {
      if (new Date(d).getTime() >= cutoff) wk += v.total || 0;
    }
    return Response.json({ total: c.total || 0, week: wk, bySrc: c.bySrc || {}, byDay: c.byDay || {}, ev: c.ev || {} });
  }

  return new Response("method not allowed", { status: 405 });
};
