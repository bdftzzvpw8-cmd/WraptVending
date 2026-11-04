# CLAUDE.md — working on wraptvending.com

Builds on this site are Claude's job. JARVIS (sir's operator agent) hands them over as a short brief, either in
`jarvis-2\workspace\claude-inbox\` or through `scripts\ask_claude.py`. Address the user as **sir**.

**This repo is public.** Never commit host terms, commission figures, host names, prospect data or keys here. The
private terms live in the jarvis-2 repo (`brain/skills/jarvis/wrapt-ops/SKILL.md`, "Facts that are law"). Public
wording comes from sir or from that file's "Approved public wording", verbatim. Never invent a term.

## Deploys are sir's
- Netlify builds `main` with `node build.mjs` (it copies the root into `dist/`, skipping `SKIP` in `build.mjs` and
  every dot-folder). **A merge to `main` is a production deploy.** Never push `main`, never merge, never run
  `netlify deploy` (a folder deploy replaces production with whatever the folder holds).
- A pull request based on `main` gets an unlisted deploy preview. A stacked PR (based on another branch) gets none.
- Never copy a fetched live page into the repo: Netlify rewrites quotes and links and strips `data-netlify` from
  forms. The live page is a comparison base only.

## Where a claim lives
A claim repeats in `<title>`, the meta description, og/twitter tags, JSON-LD (`priceRange`, offers, FAQ answers),
the hero, the visible FAQ, lead-form option text, the footer, and every templated city/venue landing page. Also check
`proposal.html`, `brand-guide.html` and `leave-behind.html` (public, noindex). `command.html` (key-gated CRM; its
AI email/SMS templates quote terms to hosts) is internal. A term
change is one sweep across all of them in one PR, not a homepage fix.

## Public copy rules (enforced in part by `tests/no-commission-public.test.mjs`)
- Nothing a stranger can load mentions commission, a rate, NGR, payout frequency or old trial/minimum terms
  (including comments, JS constants and JSON-LD).
- Never "free" (the existing "free proposal" stays), "zero cost", "costs you nothing", "nothing to pay". The cost
  line is "no upfront cost" plus the approved wrap-fee sentence.
- No wrap photos, case studies, turnaround times or "wrapped machines" claims; no host names, machine counts,
  results or testimonials without sir's word; no agreement page count.
- Leave true uses alone ("free proposal", "hassle-free", "toll-free" in prospect notes) and name them in the PR.

## How to make an edit
1. `git fetch`, branch off `origin/main` (on sir's PC use a separate worktree outside OneDrive with `C:/...` paths:
   `git worktree add C:/Users/david/Projects/wraptvending-work -b <topic> origin/main --no-track`).
2. Census first: count the old phrases per page, so the PR can say "N replaced on M pages, 0 left".
3. Edit the source by an exact-match script when a change repeats: assert each old string's count, stop before writing
   on any mismatch, preserve each file's line endings. Keep the script with the PR notes if the fact may change again.
4. Check, all on the branch:
   - every `application/ld+json` block parses (`JSON.parse`);
   - `node --check` on any inline script you touched;
   - `node build.mjs`, then `node --test tests/*.test.mjs` (all pass; never loosen a test to pass it);
   - the lead form keeps `data-netlify` and its honeypot; re-run the census (zero left, intended hits named).
5. Commit, push the branch by name, open the PR against `main`. The body lists what changed (old → new, counts),
   what was left alone and why, what was checked and what was not (rendering), and that **merging deploys**. On
   Windows write the body to a real Windows path and pass `--body-file` (an MSYS `/tmp` path fails in `gh.exe`).
6. When the deploy preview is ready, fetch its pages and diff against live: only the edit plus Netlify's preview
   toolbar should differ. Stop there; the merge is sir's.

## Proving the lead form without sending a lead
In a browser, install a script before navigation (`Page.addScriptToEvaluateOnNewDocument` or Playwright
`addInitScript`) that overrides `fetch` for POST and `navigator.sendBeacon` to record and return OK. Drive the form
with an obviously fake identity and read the recorded post: last screen reached, no errors, one post with every field
including the hidden ones. A real POST reaches Netlify Forms and the notification function: never let one through.

## New pages and removed features
- A new standalone page (the leave-behind pattern): root-level static file, `noindex` meta plus an `X-Robots-Tag`
  block in `netlify.toml`, print CSS if it is a handout, field values written with `textContent` and length-capped,
  and a `tests/<page>.test.mjs`. Wording sir has not supplied is a blank constant that prints nothing.
- Removing a feature: inventory every hook first (section, nav link, `#anchor` links, CSS, script block, form fields,
  submit-time code, analytics events), cut by exact match, then grep for its ids and function names (zero left).
  Keep hidden lead plumbing the CRM reads unless sir says otherwise.
- Anything private goes in `_private/` (never served) or `SKIP` in `build.mjs`.
