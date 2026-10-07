# Wrapt agents — fixed installer and Gmail sync

These replace the copies inside the `wrapt-agents-v5.zip` bundle. Drop `setup.mjs` over
`wrapt-agents/setup.mjs` and `gmail-sync.gs` over `wrapt-agents/gmail-sync/gmail-sync.gs`
before running the installer again. (`_private/` is never served — netlify.toml 404s it.)

## setup.mjs
- **Never replaces an INBOX_SECRET it can't see.** If the Netlify CLI can't read the site's variables
  (not linked, not logged in, value hidden) it asks you to paste the current secret, or type `NEW`.
  Before, it quietly made a new one and the Gmail sync stopped filing mail with no error.
- Backs up `command.html` once (`command.html.bak` is the true original; later runs keep it).
- Doesn't overwrite a function file that already exists and differs. Use `--force` to replace.
- Adds the new `inbox-worker-background` function to the netlify.toml bundler block.
- Worker functions are named `*-background` (`agents-run-background`, `inbox-worker-background`): Netlify only runs a function in the
  background when its name ends in `-background` — `export const config = { background: true }` is ignored. The v5 zip still ships
  `agents-run.mjs`; rename it (and delete the old file from the site) if you reinstall from the zip.

## gmail-sync.gs + appsscript.json
- A script lock, so a slow run and the next timer can't post the same mail twice.
- Pages past Gmail's 100-thread search limit (up to 500 threads per run).
- Keeps at most 300 seen ids (about 5 KB, under the 9 KB property limit).
- Skips `category:updates` (bank, receipts, shipping) and `label:personal` by default.
  Edit `PERSONAL_EXCLUDE`, or set `ONLY_LABEL = 'label:wrapt'` to sync just one label.
- Stops on a 401 from the inbox and says so in the log, instead of moving past mail that never got filed.
  (The inbox webhook now rejects a bad secret synchronously.)
- `appsscript.json` asks for **read-only** Gmail access (`gmail.readonly`) plus outbound fetch, triggers
  and the account email. If Google refuses to authorize `GmailApp` with the read-only scope, replace that
  line with `https://mail.google.com/`. That still works, but it's broader access than the script needs.
