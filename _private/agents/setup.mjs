#!/usr/bin/env node
/* =====================================================================
   WRAPT AGENTS — one-command setup
   ---------------------------------------------------------------------
   Easiest: double-click install.cmd (or drag the site folder onto it). Or, from any folder:

       node wrapt-agents\setup.mjs [path\to\site] [--force]

   It finds the site folder by itself when the zip was extracted into it, next to it, or you pass the path.
   What it does, in order — and it says so as it goes:
     0. installs the 10/10 build of Command (command.html, sw.js, command-manifest.json; your current files are backed up as .bak)
     1. copies netlify/functions/* into the site (adds new files; a same-named file that differs is kept unless --force)
     2. patches command.html with the brief panel, inbox section, AI note, photo reader, receipt scan
     3. adds the function bundler lines to netlify.toml (once, behind a marker)
     4. shows the environment variables it wants to set on the Netlify site and asks before setting them
        (keeps an existing INBOX_SECRET — never regenerates one it can't see; asks for ANTHROPIC_API_KEY)
     5. writes gmail-sync/gmail-sync.ready.gs with the webhook URL + secret filled in — paste that into Paige's script.google.com
     6. asks "Deploy now?" — default No. Nothing deploys unless you say y.
   Re-running is safe: it replaces its own blocks and skips what's already there.
   ===================================================================== */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { applyPatch } from './command-patch/apply.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const isSite = (d) => existsSync(join(d, 'netlify.toml')) && existsSync(join(d, 'command.html'));
const FORCE = process.argv.includes('--force');
function findSite() {
  const arg = (process.argv.slice(2).find(a => !a.startsWith('--')) || '').trim();
  if (arg && isSite(resolve(arg))) return resolve(arg);
  if (isSite(process.cwd())) return process.cwd();
  let d = here; // the zip was extracted into the site folder, or next to it
  for (let i = 0; i < 4; i++) { d = dirname(d); if (isSite(d)) return d; for (const n of ['wraptvending', 'wraptsite', 'wrapt', 'site']) if (isSite(join(d, n))) return join(d, n); }
  return arg ? resolve(arg) : process.cwd();
}
const site = findSite();
/* prompts that work both interactively and with piped answers (lines are queued, EOF = accept defaults) */
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
const lineQ = []; let waiter = null, closed = false;
rl.on('line', l => { if (waiter) { const w = waiter; waiter = null; w(l); } else lineQ.push(l); });
rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(''); } });
const ask = async (q, dflt = '') => {
  process.stdout.write(`${q}${dflt ? ` [${dflt}]` : ''}: `);
  const a = lineQ.length ? lineQ.shift() : closed ? '' : await new Promise(r => { waiter = r; });
  if (!process.stdin.isTTY) process.stdout.write(a + '\n');
  return a.trim() || dflt;
};
const yes = async (q, dflt = false) => /^y/i.test(await ask(`${q} (${dflt ? 'Y/n' : 'y/N'})`, dflt ? 'y' : 'n'));
const say = (s) => console.log(s);
const win = process.platform === 'win32';
const run = (cmd, args, opts = {}) => spawnSync(cmd, win ? args.map(a => `"${String(a).replace(/"/g, '\\"')}"`) : args, { encoding: 'utf8', shell: win, ...opts }); // netlify is a .cmd shim on Windows

say('\nWRAPT AGENTS SETUP\n');
if (!isSite(site)) {
  say(`Couldn't find the site folder (looked for netlify.toml + command.html in ${site}).\nDrag the wraptvending site folder onto install.cmd, or run:  node wrapt-agents\\setup.mjs path\\to\\site`);
  await ask('Press Enter to close'); process.exit(1);
}
say(`Site folder: ${site}`);

/* 0. the 10/10 build of Command */
const cmdDir = join(here, 'command');
if (existsSync(join(cmdDir, 'command.html'))) {
  const cur = readFileSync(join(site, 'command.html'), 'utf8');
  const mine = readFileSync(join(cmdDir, 'command.html'), 'utf8');
  if (cur === mine || cur.includes('MORNING BRIEF (pipeline + deal-watch agents)') && cur.includes("BUILD='2026.10.06'")) say('\n0. Command: the 10/10 build is already in place.');
  else if (await yes('\n0. Install the 10/10 build of Command (command.html, sw.js, manifest — current files kept as *.before-1010.bak)?', true)) {
    for (const f of ['command.html', 'sw.js', 'command-manifest.json']) {
      const dst = join(site, f); if (existsSync(dst)) copyFileSync(dst, dst + '.before-1010.bak'); // the file you had before the 10/10 build
      copyFileSync(join(cmdDir, f), dst);
    }
    say('   Installed command.html, sw.js, command-manifest.json (your previous files: *.before-1010.bak)');
  } else say('   Skipped — keeping your current command.html.');
}

/* 1. functions */
const rel = p => p.replace(site, '').replace(/^[\\/]/, '');
const copyDir = (from, to) => { mkdirSync(to, { recursive: true }); for (const f of readdirSync(from)) { const a = join(from, f), b = join(to, f); if (statSync(a).isDirectory()) { copyDir(a, b); continue; }
  if (existsSync(b)) { if (readFileSync(a).equals(readFileSync(b))) continue; if (!FORCE) { kept.push(rel(b)); continue; } }
  copyFileSync(a, b); copied.push(rel(b)); } };
const copied = [], kept = [];
copyDir(join(here, 'netlify', 'functions'), join(site, 'netlify', 'functions'));
say(`\n1. Functions copied (${copied.length} files)${copied.length ? ':\n   ' + copied.join('\n   ') : ''}`);
if (kept.length) say(`   Kept your existing version of ${kept.length} file(s) that differ (re-run with --force to replace):\n   ${kept.join('\n   ')}`);

/* 2. command.html */
const cmdPath = join(site, 'command.html');
try {
  const { html, log } = applyPatch(readFileSync(cmdPath, 'utf8'));
  const firstBak = !existsSync(cmdPath + '.bak');
  if (firstBak) copyFileSync(cmdPath, cmdPath + '.bak');
  writeFileSync(cmdPath, html);
  say(`\n2. command.html patched (${firstBak ? 'backup: command.html.bak' : 'original backup command.html.bak kept from the first run'})\n   ${log.join('\n   ')}`);
} catch (e) {
  say(`\n2. command.html NOT patched: ${e.message}\n   Your local Command differs from the copy this was written against. Make that one edit by hand (anchors are listed at the top of command-patch/*.js), then re-run.`);
}

/* 3. netlify.toml */
const tomlPath = join(site, 'netlify.toml');
let toml = readFileSync(tomlPath, 'utf8');
const MARK = '# --- wrapt agents (added by setup.mjs) ---';
if (!toml.includes(MARK)) {
  const names = ['agents-run-background', 'agents-daily', 'brief', 'inbox', 'inbox-worker-background', 'inbox-queue', 'note-ai', 'photo-ai', 'ack'];
  toml = toml.replace(/\s*$/, '\n\n') + MARK + '\n' + names.map(n => `[functions."${n}"]\n  node_bundler = "esbuild"\n`).join('') + '# --- /wrapt agents ---\n';
  writeFileSync(tomlPath, toml);
  say('\n3. netlify.toml: bundler lines added for the 9 new functions');
} else if (!toml.includes('[functions."inbox-worker-background"]')) {
  writeFileSync(tomlPath, toml.replace('# --- /wrapt agents ---', '[functions."inbox-worker-background"]\n  node_bundler = "esbuild"\n# --- /wrapt agents ---'));
  say('\n3. netlify.toml: added the inbox-worker-background bundler line');
} else say('\n3. netlify.toml: already has the wrapt agents lines');

/* 4. environment variables */
say('\n4. Environment variables');
const cli = run('netlify', ['--version']);
const hasCli = cli.status === 0;
let existing = {}, envKnown = false;
if (hasCli) {
  const r = run('netlify', ['env:list', '--json'], { cwd: site });
  try { const j = JSON.parse(r.stdout); existing = Array.isArray(j) ? Object.fromEntries(j.map(x => [x.key, x.value])) : (j || {}); envKnown = r.status === 0; } catch { /* not linked or not logged in */ }
}
const have = (k) => k in existing && existing[k] !== '';
let siteUrl = 'https://wraptvending.com';
const vars = {};
// A new secret would silently cut off the Gmail sync that already uses the old one, so only mint one when we
// can see the site has none. If the CLI can't read the site (not linked / not logged in / values masked), ask.
let secret = '';
if (have('INBOX_SECRET') && !/^\*+$/.test(existing.INBOX_SECRET)) secret = existing.INBOX_SECRET;
else if (envKnown && !('INBOX_SECRET' in existing)) { secret = randomBytes(24).toString('hex'); vars.INBOX_SECRET = secret; }
else {
  say('   Could not read INBOX_SECRET from the Netlify site (CLI not linked, not logged in, or the value is hidden).');
  secret = await ask('   Paste the current INBOX_SECRET (Netlify → Site configuration → Environment variables), or type NEW to make one');
  if (/^new$/i.test(secret)) { secret = randomBytes(24).toString('hex'); vars.INBOX_SECRET = secret; say('   New secret generated — re-paste the Gmail script after this, the old one stops working.'); }
  else if (!secret) { say('   No secret given — stopping before anything that depends on it. Nothing in steps 4–6 was changed.'); rl.close(); process.exit(1); }
}
vars.PAIGE_EMAILS = have('PAIGE_EMAILS') ? existing.PAIGE_EMAILS : 'paige@wraptvending.com';
// No hardcoded location: the repo is public, and Netlify's secret scan fails the build when an env value appears in it.
// Unset = the agents' built-in default home base (see CFG.home in netlify/functions/lib/wrapt-agents.mjs).
vars.HOME_LATLNG = have('HOME_LATLNG') ? existing.HOME_LATLNG : '';
say(`   Defaults: site ${siteUrl} · Paige's email ${vars.PAIGE_EMAILS} · home base ${vars.HOME_LATLNG || '(built-in default)'}`);
if (await yes('   Change any of these?', false)) {
  siteUrl = await ask('   Site URL', siteUrl);
  vars.PAIGE_EMAILS = await ask('   Paige\'s email address(es), comma-separated', vars.PAIGE_EMAILS);
  vars.HOME_LATLNG = await ask('   Home base lat,lng (blank = built-in default)', vars.HOME_LATLNG);
}
if (have('ANTHROPIC_API_KEY')) say('   ANTHROPIC_API_KEY: already set on the site — keeping it.');
else {
  const k = await ask('   ANTHROPIC_API_KEY (console.anthropic.com → API keys; Enter to skip = template drafts, no smart notes/photos yet)');
  if (k) vars.ANTHROPIC_API_KEY = k;
}
const smtpNames = Object.keys(existing).filter(k => /SMTP|EMAIL|MAIL|GMAIL/i.test(k));
if (smtpNames.length) say(`   Existing email settings found: ${smtpNames.join(', ')} — the acknowledgment and brief email can use these (set ACK_ENABLED=1 to turn auto-replies on).`);

say('\n   Will set on the Netlify site:');
if (!vars.HOME_LATLNG) delete vars.HOME_LATLNG;
Object.entries(vars).forEach(([k, v]) => say(`     ${k} = ${k === 'ANTHROPIC_API_KEY' ? v.slice(0, 12) + '…' : v}`));
let envSet = false;
if (hasCli && (await yes('   Set these now with the Netlify CLI?', true))) {
  let ok = 0;
  for (const [k, v] of Object.entries(vars)) {
    const r = run('netlify', ['env:set', k, v, '--force'], { cwd: site });
    if (r.status === 0) ok++; else say(`     ${k}: failed — ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  }
  envSet = ok === Object.keys(vars).length;
  say(envSet ? '   Environment variables set.' : '   Some variables did not set — add the rest in Netlify → Site configuration → Environment variables.');
} else say('   Not set. Add them in Netlify → Site configuration → Environment variables (values above).');

/* 5. the Gmail sync script, ready to paste */
const webhook = `${siteUrl.replace(/\/$/, '')}/.netlify/functions/inbox?s=${secret}`;
const gsSrc = readFileSync(join(here, 'gmail-sync', 'gmail-sync.gs'), 'utf8').replace('__WEBHOOK__', webhook);
const gsOut = join(here, 'gmail-sync', 'gmail-sync.ready.gs');
writeFileSync(gsOut, gsSrc);
say(`\n5. Gmail sync script written with the webhook filled in:\n   ${gsOut}\n   Signed in as Paige: script.google.com → New project → paste the file → pick "setup" → Run → approve Gmail access. Done.`);

/* 6. deploy — only on an explicit yes */
say('\n6. Deploy');
if (hasCli && (await yes('   Deploy to production now (netlify deploy --prod)?', false))) {
  const r = run('netlify', ['deploy', '--prod'], { cwd: site, stdio: 'inherit' });
  say(r.status === 0 ? '   Deployed.' : '   Deploy did not finish cleanly — run  netlify deploy --prod  yourself and read the output.');
} else say('   Not deployed. When ready:  netlify deploy --prod');

say(`\nAfter deploy:
   • Command → Today → "Run now" builds the first brief.
   • In the Gmail script, run "test" to confirm the connection, then "setup".
   • Auto-replies stay OFF until you set ACK_ENABLED=1 (needs the email settings).
   Webhook (keep private): ${webhook}\n`);
if (process.env.WRAPT_PAUSE) await ask('Press Enter to close');
rl.close();
