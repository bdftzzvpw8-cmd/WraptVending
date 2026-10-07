// Scheduled function: weekday morning pipeline digest via SMS.
// Runs at 13:00 UTC (8:00 AM Central in summer / 7:00 AM in winter — adjust
// `schedule` below if the winter hour matters).
// Uses: NETLIFY_AUTH_TOKEN, SITE_ID (auto), TWILIO_* and ALERT_TO env vars.
// Skips sending if there's nothing worth reporting.

import { getStore } from "@netlify/blobs";

async function readMeta(store) {
  let meta = {};
  try { meta = (await store.get("meta", { type: "json" })) || {}; } catch (e) {}
  try {
    const { blobs } = await store.list({ prefix: "m:" });
    const entries = await Promise.all(
      blobs.map(async (b) => [b.key.slice(2), await store.get(b.key, { type: "json" }).catch(() => null)])
    );
    for (const [id, v] of entries) if (v) meta[id] = { ...(meta[id] || {}), ...v };
  } catch (e) {}
  return meta;
}

export default async (req, context) => {
  const token = process.env.NETLIFY_AUTH_TOKEN;
  const siteId = process.env.SITE_ID || context?.site?.id;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ALERT_TO } = process.env;
  if (!token || !siteId || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM || !ALERT_TO) {
    console.log("digest: missing env vars, skipping");
    return new Response("no-config");
  }

  const H = { Authorization: `Bearer ${token}` };
  const forms = await (await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/forms`, { headers: H })).json();
  const form = Array.isArray(forms) ? forms.find((f) => f.name === "wrapt-lead") : null;
  if (!form) return new Response("no-form");

  const subs = [];
  for (let page = 1; page <= 30; page++) {
    const r = await fetch(`https://api.netlify.com/api/v1/forms/${form.id}/submissions?per_page=100&page=${page}`, { headers: H });
    if (!r.ok) break;
    const batch = await r.json();
    subs.push(...batch);
    if (!Array.isArray(batch) || batch.length < 100) break;
  }

  const meta = await readMeta(getStore("wrapt-command"));

  const now = Date.now();
  const day = 864e5;
  const status = (s) => meta[s.id]?.status || "new";

  const newToday = subs.filter((s) => now - new Date(s.created_at) < day);
  const hotUntouched = subs.filter((s) => status(s) === "new" && (+s.data?.lead_score || 0) >= 70);
  const stale = subs.filter(
    (s) => ["new", "contacted"].includes(status(s)) && now - new Date(s.created_at) > 3 * day
  );
  const activeCount = subs.filter((s) => !["dead", "installed"].includes(status(s))).length;

  if (!newToday.length && !hotUntouched.length && !stale.length) {
    console.log("digest: quiet day, not sending");
    return new Response("quiet");
  }

  const nameOf = (s) => {
    const d = s.data || {};
    return `${d.name || "?"}${d.company ? ` (${d.company})` : ""} [${d.lead_score || "?"}]`;
  };

  let msg = `WRAPT AM DIGEST — ${activeCount} active in pipeline`;
  if (newToday.length) msg += `\nNew (24h): ${newToday.length} — ${newToday.slice(0, 3).map(nameOf).join("; ")}`;
  if (hotUntouched.length) msg += `\nHOT untouched: ${hotUntouched.slice(0, 3).map(nameOf).join("; ")}`;
  if (stale.length) msg += `\nGoing stale (3d+): ${stale.length}`;
  msg += `\nwraptvending.com/command.html`;

  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  for (const to of ALERT_TO.split(",").map((n) => n.trim()).filter(Boolean)) {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: msg.slice(0, 1500) }),
    });
    console.log(r.ok ? `digest sent to ${to}` : `digest failed: ${r.status}`);
  }
  return new Response("sent");
};

export const config = { schedule: "0 13 * * 1-5" };
