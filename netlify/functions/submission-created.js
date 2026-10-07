// Fires automatically on every Netlify Forms submission (event: submission-created).
// Sends an SMS via Twilio's REST API — no npm packages needed.
//
// Required environment variables (Netlify: Site settings → Environment variables):
//   TWILIO_ACCOUNT_SID   e.g. ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_AUTH_TOKEN    from the Twilio console
//   TWILIO_FROM          your Twilio number, e.g. +16155551234
//   ALERT_TO             your cell, e.g. +16155559876
//                        (comma-separate multiple: +1615...,+1629...)

exports.handler = async (event) => {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, ALERT_TO } = process.env;
  const SMS_OK = !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM && ALERT_TO);
  if (!SMS_OK) console.error("Missing Twilio env vars — SMS skipped (email still sends).");

  const d = JSON.parse(event.body).payload.data || {};

  // Parse the ROI snapshot if the lead used the calculator
  let roi = "";
  try {
    if (d.roi_snapshot) {
      const r = JSON.parse(d.roi_snapshot);
      roi = ` | Site ${r.grade || "?"}: ${r.monthlyGross || "?"}/mo, ${r.annualValue || "?"}/yr`;
    }
  } catch (_) {}

  const typeLabel = { host: "HOST", multi: "MULTI-SITE", referral: "REFERRAL", other: "OTHER" }[d.lead_type] || "LEAD";
  const score = d.lead_score ? ` [${d.lead_score}/100]` : "";
  const contact =
    d.contact_method === "Call me"
      ? ` | CALL ${d.best_time && d.best_time !== "Anytime" ? d.best_time : "anytime"}`
      : d.contact_method === "Text me"
      ? " | WANTS TEXT"
      : "";

  const situation = d.current_vending ? ` | Now: ${d.current_vending}` : "";
  const wants = d.product_interests ? ` | Wants: ${d.product_interests}` : "";
  const role = d.role ? ` | ${d.role}` : "";
  const src = d.lead_source && d.lead_source !== "direct" ? ` | via ${d.lead_source}` : "";

  const msg =
    `WRAPT ${typeLabel}${score}: ${d.name || "?"}` +
    (d.company ? ` (${d.company})` : "") +
    role +
    `${/referral/i.test(d.lead_type||"") ? ` | REFERS: ${d.referred_business || "?"}${d.referred_contact ? " (ask for " + d.referred_contact + ")" : ""}` : ""} | ${d.venue_type || "venue?"} in ${d.city || "?"}${d.address ? " @ " + d.address : ""}` +
    ` | traffic ${d.daily_traffic || "?"} | ${d.timeline || "?"}` +
    situation +
    wants +
    roi +
    contact +
    src +
    ` | ${d.phone || "no phone"} | ${d.email || ""}`;

  const auth = SMS_OK ? Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") : "";
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  const recipients = SMS_OK ? ALERT_TO.split(",").map((n) => n.trim()).filter(Boolean) : [];
  const results = await Promise.allSettled(
    recipients.map((to) =>
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: msg.slice(0, 1500) }),
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return to;
      })
    )
  );

  results.forEach((r, i) =>
    r.status === "fulfilled"
      ? console.log(`SMS sent to ${recipients[i]}`)
      : console.error(`SMS failed for ${recipients[i]}:`, r.reason)
  );

  // ---- Instant auto-reply to the LEAD (speed-to-lead) ----
  // Requires AUTO_REPLY=true in env vars AND an A2P 10DLC-registered Twilio number.
  // (Texting yourself works on any Twilio setup; texting customers requires registration.)
  if (SMS_OK && process.env.AUTO_REPLY === "true" && d.phone && d.contact_method !== "Email only") {
    const first = (d.name || "").trim().split(" ")[0] || "there";
    const leadMsg =
      d.contact_method === "Call me"
        ? `Hi ${first} — Wrapt here. Your proposal for ${d.company || "your location"} is in the works. We'll call ${d.best_time && d.best_time !== "Anytime" ? d.best_time.toLowerCase() : "shortly"}; reply here if sooner works better.`
        : `Hi ${first} — Wrapt here. Your proposal for ${d.company || "your location"} is in the works; we'll text it shortly. Reply here with any questions.`;
    const to = "+1" + d.phone.replace(/\D/g, "").replace(/^1/, "");
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: leadMsg }),
      });
      console.log(r.ok ? `Auto-reply sent to lead ${to}` : `Auto-reply failed: ${r.status} ${await r.text()}`);
    } catch (e) {
      console.error("Auto-reply error:", e);
    }
  }

  // ---- Direct email to Paige with the full lead ----
  // Env vars: SMTP_USER (paige@wraptvending.com), SMTP_PASS (Google app password),
  // LEAD_EMAIL_TO (optional; defaults to SMTP_USER; comma-separate multiple).
  const { SMTP_USER, SMTP_PASS } = process.env;
  if (SMTP_USER && SMTP_PASS) {
    try {
      const nodemailer = require("nodemailer");
      const to = process.env.LEAD_EMAIL_TO || "paige@wraptvending.com";
      const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      let roiObj = null;
      try { roiObj = d.roi_snapshot ? JSON.parse(d.roi_snapshot) : null; } catch (_) {}
      const isRef = /referral/i.test(d.lead_type || "");
      const phoneDigits = (d.phone || "").replace(/\D/g, "").replace(/^1/, "");
      const subject = `New Wrapt ${isRef ? "referral" : "lead"}${d.lead_score ? ` — ${d.lead_score}/100` : ""}: ${d.name || "?"}${d.company ? ` (${d.company})` : ""} · ${d.venue_type || "venue?"} · ${d.city || "?"}`;

      const row = (label, val) => val ? `<tr><td style="padding:7px 14px 7px 0;color:#8F5E16;font:700 11px 'Courier New',monospace;letter-spacing:.1em;text-transform:uppercase;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:7px 0;color:#111;font:14px Arial,sans-serif">${esc(val)}</td></tr>` : "";
      const btn = (href, label, solid) => `<a href="${href}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;font:700 12px 'Courier New',monospace;letter-spacing:.1em;text-transform:uppercase;text-decoration:none;${solid ? "background:#B37922;color:#221B0E;border:2px solid #B37922" : "color:#111;border:2px solid #111"}">${label}</a>`;

      // proposal deep link (same payload format command.html builds)
      const pd = Buffer.from(JSON.stringify({
        name: d.name || "", co: d.company || "", city: d.city || "", venue: d.venue_type || "",
        wants: d.product_interests || "", grade: roiObj?.grade || "", gross: roiObj?.monthlyGross || "",
        annual: roiObj?.annualValue || "", share: "15%",
      }), "utf8").toString("base64");

      const html = `
<div style="max-width:600px;margin:0 auto;border-top:8px solid #B37922;background:#fff">
  <div style="padding:26px 26px 0">
    <span style="display:inline-block;border:3px solid #111;padding:8px 12px 6px;font:900 14px Arial Black,Arial,sans-serif;letter-spacing:-.01em">WRAPT</span>
    <h1 style="font:900 26px Arial Black,Arial,sans-serif;text-transform:uppercase;margin:18px 0 4px;color:#111">${isRef ? "New referral" : "New lead"}${d.lead_score ? ` · ${esc(d.lead_score)}/100` : ""}</h1>
    <p style="font:14px Arial,sans-serif;color:#55534E;margin:0 0 18px">${esc(d.name || "?")}${d.company ? ` at <b style="color:#111">${esc(d.company)}</b>` : ""}${d.role ? ` · ${esc(d.role)}` : ""}</p>
    <div style="margin-bottom:20px">
      ${phoneDigits ? btn(`tel:+1${phoneDigits}`, "Call", 1) + btn(`sms:+1${phoneDigits}`, "Text") : ""}
      ${d.email ? btn(`mailto:${esc(d.email)}`, "Email") : ""}
      ${btn(`https://wraptvending.com/proposal.html#${pd}`, "Open proposal")}
      ${btn("https://wraptvending.com/command.html", "Command")}
    </div>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid #111;border-bottom:1px solid #D7D2C7;padding:8px 0">
      ${row("Venue", [d.venue_type, d.city].filter(Boolean).join(" · "))}
      ${row("Address", d.address)}
      ${isRef ? row("Referring", [d.referred_business, d.referred_contact ? "ask for " + d.referred_contact : ""].filter(Boolean).join(" · ")) : ""}
      ${row("Traffic", d.daily_traffic)}
      ${row("Timeline", d.timeline)}
      ${row("Today", d.current_vending)}
      ${row("Wants", d.product_interests)}
      ${roiObj ? row("Site score", `${roiObj.grade || "?"} · ${roiObj.monthlyGross || "?"}/mo gross · ${roiObj.annualValue || "?"}/yr to host${roiObj.basis === "form estimate" ? " (estimated from form answers)" : ""}`) : ""}
      ${row("Reach them", [d.contact_method, d.contact_method === "Call me" && d.best_time && d.best_time !== "Anytime" ? d.best_time : ""].filter(Boolean).join(" · "))}
      ${row("Phone", d.phone)}
      ${row("Email", d.email)}
      ${row("Source", d.lead_source && d.lead_source !== "direct" ? d.lead_source : "")}
      ${row("Notes", d.notes)}
    </table>
    <p style="font:11px 'Courier New',monospace;color:#A39C8F;letter-spacing:.08em;margin:16px 0 26px">WRAPT COMMAND · wraptvending.com/command.html</p>
  </div>
</div>`;

      const transporter = nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true,
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transporter.sendMail({
        from: `"Wrapt Leads" <${SMTP_USER}>`,
        to,
        subject,
        html,
        text: msg, // fall back to the SMS-formatted summary for plain-text clients
      });
      console.log("Lead email sent to " + to);
    } catch (e) {
      console.error("Lead email failed:", e && e.message);
    }
  } else {
    console.log("SMTP env vars not set — lead email skipped.");
  }

  return { statusCode: 200, body: "ok" };
};
