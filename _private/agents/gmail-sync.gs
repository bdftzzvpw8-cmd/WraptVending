/* =====================================================================
   WRAPT GMAIL SYNC — runs inside Paige's Google account (script.google.com)
   ---------------------------------------------------------------------
   Every few minutes it finds mail that arrived or was sent since the last
   run and posts each message to the Wrapt inbox agent, which files it as a
   note on the right card in Command. Both directions, nothing to remember.

   One-time setup (2 minutes):
     1. Signed in as Paige, open https://script.google.com → New project.
     2. Delete the sample code, paste this whole file, name the project "Wrapt Gmail Sync".
     3. Project Settings → tick "Show appsscript.json", open it and paste the appsscript.json that came
        with this file (read-only Gmail access instead of full mailbox control).
     4. In the toolbar pick the function  setup  and press Run. Approve the
        permissions (it's your own script: Advanced → Go to Wrapt Gmail Sync).
   That's it. setup() installs the timer and syncs the last 24 hours once.
   To stop it: pick  stop  and press Run.
   ===================================================================== */
var WEBHOOK = '__WEBHOOK__';            // filled in by setup.mjs — or paste: https://wraptvending.com/.netlify/functions/inbox?s=<INBOX_SECRET>
var EVERY_MINUTES = 10;                 // 5–30. Gmail search + one POST per new message; well inside Google's free quotas.
var OVERLAP_MS = 20 * 60 * 1000;        // look back a little past the last run so nothing slips between runs
var SKIP = '-in:spam -in:trash -in:chats -category:promotions -category:social -category:forums';
// Personal mail never needs to leave the mailbox. Updates = bank statements, receipts, shipping, accounts.
// Add more, e.g. ' -from:(mybank.com OR family@gmail.com) -label:personal'.
var PERSONAL_EXCLUDE = '-category:updates -label:personal';
// Optional: only sync mail under one label (e.g. 'label:wrapt'). Empty = everything not excluded above.
var ONLY_LABEL = '';
var MAX_BODY = 20000;
var PAGE = 100, MAX_THREADS = 500;      // GmailApp.search returns at most 100 threads per call — page through
var SEEN_MAX = 300;                     // ~16 chars per id → ~5 KB, well under the 9 KB script-property limit

function query_(floor) { return ['after:' + Math.floor(floor / 1000), SKIP, PERSONAL_EXCLUDE, ONLY_LABEL].join(' ').replace(/\s+/g, ' ').trim(); }

function setup() {
  stop();
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(EVERY_MINUTES).create();
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('since'); p.deleteProperty('seen');
  var n = sync();
  Logger.log('Wrapt Gmail Sync is on — runs every ' + EVERY_MINUTES + ' min. First pass sent ' + n + ' message(s).');
}
function stop() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
}
function sync() {
  if (WEBHOOK.indexOf('http') !== 0) throw new Error('WEBHOOK is not set — paste the inbox URL at the top of the script.');
  var lock = LockService.getScriptLock(); // a slow run and the next trigger must not post the same mail twice
  if (!lock.tryLock(5000)) { Logger.log('sync: previous run still going — skipped'); return 0; }
  try { return syncLocked_(); } finally { lock.releaseLock(); }
}
function syncLocked_() {
  var p = PropertiesService.getScriptProperties();
  var now = Date.now();
  var since = Number(p.getProperty('since') || (now - 24 * 3600 * 1000));
  var floor = since - OVERLAP_MS;
  var seen = {};
  (p.getProperty('seen') || '').split(',').forEach(function (id) { if (id) seen[id] = 1; });
  var me = '';
  try { me = (Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) { /* fine — the server knows Paige's addresses */ }

  var threads = [], q = query_(floor);
  for (var start = 0; start < MAX_THREADS; start += PAGE) {
    var page = GmailApp.search(q, start, PAGE);
    threads = threads.concat(page);
    if (page.length < PAGE) break;
  }
  var sent = 0, failed = 0, keep = [], authFailed = false;
  threads.forEach(function (th) {
    if (authFailed) return;
    th.getMessages().forEach(function (m) {
      if (authFailed) return;
      var ts = m.getDate().getTime(), id = m.getId();
      if (ts < floor || m.isDraft() || m.isInChats() || m.isInTrash()) return;
      if (seen[id]) { keep.push(id); return; }
      var code = post_({
        provider: 'gmail', account: me,
        from: m.getFrom(), to: m.getTo(), cc: m.getCc(), subject: m.getSubject(),
        text: (m.getPlainBody() || '').slice(0, MAX_BODY), date: m.getDate().toISOString(),
        message_id: hdr_(m, 'Message-ID'), in_reply_to: hdr_(m, 'In-Reply-To'), references: hdr_(m, 'References'),
        gmail_id: id, thread_id: th.getId()
      });
      if (code >= 200 && code < 300) { keep.push(id); sent++; }
      else { failed++; if (code === 401 || code === 503) authFailed = true; }
    });
  });
  p.setProperty('seen', keep.slice(-SEEN_MAX).join(','));
  if (!failed && threads.length < MAX_THREADS) p.setProperty('since', String(now)); // a failure (or a capped scan) keeps the window open so it's retried
  if (authFailed) Logger.log('sync STOPPED: the inbox refused the secret (HTTP 401/503). Nothing was skipped — fix INBOX_SECRET / the WEBHOOK line and it catches up.');
  Logger.log('sync: ' + sent + ' sent, ' + failed + ' failed, ' + threads.length + ' threads scanned');
  return sent;
}
function hdr_(m, name) { try { return m.getHeader(name) || ''; } catch (e) { return ''; } }
function post_(obj) {
  try {
    var r = UrlFetchApp.fetch(WEBHOOK, { method: 'post', contentType: 'application/json', payload: JSON.stringify(obj), muteHttpExceptions: true });
    var c = r.getResponseCode();
    if (c < 200 || c >= 300) Logger.log('inbox returned HTTP ' + c + ' for "' + obj.subject + '"');
    return c;
  } catch (e) { Logger.log('post failed: ' + e); return 0; }
}
/* run this to check the connection without touching Gmail: posts one harmless test message */
function test() {
  var c = post_({ provider: 'gmail', account: '', from: 'Wrapt Gmail Sync <test@example.com>', to: 'paige@wraptvending.com', subject: 'Automatic reply: connection test', text: 'If you can read this in the Netlify function log, the sync is connected.', date: new Date().toISOString(), message_id: '<gmail-sync-test-' + Date.now() + '@wrapt>' });
  Logger.log(c >= 200 && c < 300 ? 'Connected — the inbox agent accepted the test (it files it as "skipped: auto-reply").'
    : c === 401 ? 'Not connected — the inbox refused the secret. Re-paste the WEBHOOK line from setup.mjs.' : 'Not connected (HTTP ' + c + ') — check WEBHOOK.');
}
