# WRAPT — OFFSITE LAUNCH PLAYBOOK
Three setups, ~45 minutes total. Everything below is paste-ready.

---

## 1. GOOGLE BUSINESS PROFILE  (~20 min · biggest local-SEO lever)

Go to: business.google.com → "Add your business"

**Business name:** Wrapt
**Category (primary):** Vending machine supplier
**Categories (additional):** Business to business service
**Do you want to add a location customers can visit?** NO — choose
"service-area business" (you go to them; keeps your home address private)
**Service areas:** Franklin TN, Spring Hill TN, Brentwood TN,
Thompson's Station TN, Columbia TN, Murfreesboro TN, Nashville TN
**Phone:** (615) 948-2976
**Website:** https://wraptvending.com

**Business description (paste — 733 chars):**
Wrapt places free smart vending machines and coolers at gyms, offices,
apartment communities, hotels, schools, and venues across Franklin,
Spring Hill, and Greater Nashville. Hosting costs nothing: we supply the
machine, install it, stock it, and service it — and pay your business a
10% commission on every sale, with a monthly statement and deposit.
Every machine is wrapped in a full custom vinyl design in your own
branding, included free. Machines are card-only with modern grab-and-go
checkout, restocked before they run empty, and monitored around the
clock. Locally owned and operated. Text or call for a free location
score and a proposal within 24 hours.

**Services to list:** Free vending machine placement · Smart cooler
placement · Custom-wrapped vending machines · Multi-property vending
programs · Vending machine restocking & service
**Hours:** Open with main hours, 8am–8pm daily (you answer texts anyway)
**Verification:** Google will verify by phone, email, or video. Do it
immediately — the profile is invisible until verified.

After it's live: add photos the day the first machine installs (wrapped
machine on site = the money shot), and ask your first host for a Google
review within a week of install. Reviews + photos are 80% of ranking.

---

## 2. GOOGLE SEARCH CONSOLE  (~10 min · makes Google index the site)

Go to: search.google.com/search-console → Add property

**Property type:** Domain (covers www + non-www)
**Domain:** wraptvending.com
**Verification:** it gives you a TXT record. Since DNS lives at Netlify:
Netlify → Domains → wraptvending.com → DNS records → Add record →
type TXT, name @, value = the google-site-verification string → Save →
back in Search Console press Verify (may take a few minutes).

**Then submit the sitemap:** left menu → Sitemaps → enter
`https://wraptvending.com/sitemap.xml` → Submit.

Done. Within days you'll see impressions for "vending machine franklin
tn"-type searches. Check monthly, not daily.

---

## 3. TWILIO A2P 10DLC REGISTRATION  (~15 min · unlocks the lead auto-reply)

Without this, US carriers filter business texts. Your OWNER alerts to
your own phone mostly pass, but the auto-reply to LEADS needs
registration. Twilio Console → Messaging → Regulatory Compliance →
A2P 10DLC → Register.

**Business profile:**
- Legal business name: (your LLC name as registered — if Wrapt isn't an
  LLC yet, register as Sole Proprietor tier)
- Business type: Sole Proprietor or LLC as applicable
- Industry: Retail
- Website: https://wraptvending.com

**Campaign registration:**
- Use case: **Customer Care** (or "Mixed" if offered)
- Campaign description (paste):
  "Wrapt sends one-to-one service messages to business owners who
  submit a vending machine placement inquiry through our website form.
  Messages confirm receipt of their inquiry, coordinate scheduling, and
  answer questions. Recipients explicitly request contact by submitting
  our form and choosing text as their preferred channel. Volume is low
  (under 100 messages/month). Reply STOP to opt out."
- Message flow / opt-in description (paste):
  "Users opt in by submitting the lead form at wraptvending.com and
  selecting 'Text me' as their preferred contact method. The form
  states we will contact them about their inquiry."
- Sample message 1 (paste):
  "Hi Jordan — Wrapt here. Your proposal for Iron House Gym is in the
  works; we'll text it shortly. Reply here with any questions. Reply
  STOP to opt out."
- Sample message 2 (paste):
  "Hi Sam — Wrapt here. Your proposal for your location is in the
  works. We'll call Tuesday morning; reply here if sooner works better.
  Reply STOP to opt out."

**After approval** (sole prop: usually days): set env var
`AUTO_REPLY=true` in Netlify → redeploy → leads who choose text get an
instant confirmation, which is the single biggest speed-to-lead move
available.

---

## ALREADY HANDLED IN CODE (no action)
- robots.txt allows everything on purpose; /command.html, /proposal.html,
  /wrap-studio.html and /brand-guide.html are kept out of Google with noindex
  (meta tag + X-Robots-Tag header), which only works if Google can crawl them
- sitemap.xml exists and references the live pages
- LocalBusiness + FAQ schema markup embedded on the site
- Honeypot spam protection on the form

## STILL IN THE PHYSICAL-WORLD QUEUE
- VistaPrint sample kit → proof runs → QR scan test → full print order
- Machine photos into /img when hardware arrives
- First host testimonial after first placement
- Referrals are unpaid goodwill — the site makes no payout promise
