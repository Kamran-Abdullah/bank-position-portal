'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const { db, isSea, getSessionSecret, runBackup } = require('./db');
const { attachAuth, requireAuth } = require('./auth');

const staticDir = isSea() ? path.join(path.dirname(process.execPath), 'public') : path.join(__dirname, 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' },
}));

// public assets (login page + shared css/js) before auth gate
app.use(express.static(staticDir, { index: false, extensions: ['html'] }));

attachAuth(app);
require('./routes/config')(app);
require('./routes/upload')(app);
require('./routes/dashboard')(app);
require('./routes/admin')(app);

require('./routes/inbox')(app);
require('./routes/funds')(app);
require('./routes/adjust')(app);
require('./routes/unpresented')(app);

app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Called by the Outlook agent right after it saves statements: process the Inbox Drop now (post balances, prepare the
// "all statements received" e-mail) instead of waiting for the next 20 s watcher tick. Loopback only, no login needed;
// it only triggers work the watcher would do anyway.
app.post('/api/agent/scan', async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return res.status(403).json({ error: 'Local only.' });
  try {
    const ingest = require('./services/ingest');
    await ingest.scan();
    await require('./services/notify').check();
    res.json({ ok: true, ...ingest.status() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/funds.html', (req, res) => res.redirect('/reports.html'));
app.get(['/', '/index.html'], (req, res) => {
  res.redirect(req.session && req.session.user ? '/dashboard.html' : '/login.html');
});

// guard app pages (anything .html except login) — redirect to login when not signed in
app.get(/\.html$/, (req, res, next) => {
  if (req.path === '/login.html') return next();
  if (!req.session || !req.session.user) return res.redirect('/login.html');
  next();
}, express.static(staticDir, { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// daily VACUUM INTO backup, keep 14
setInterval(() => { try { runBackup(14); } catch (e) { console.error('backup failed', e.message); } }, 24 * 60 * 60 * 1000);
try { runBackup(14); } catch { /* first-run best effort */ }

const PORT = process.env.PORT || 4201;
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`
  Bank Position Portal is READY  ->  http://localhost:${PORT}
`);
  require('./services/ingest').start();
  const notify = require('./services/notify');
  setTimeout(() => notify.check(), 20000); setInterval(() => notify.check(), 60000);   // "all statements in" e-mail     // pick up statements the Outlook agent dropped (also catches up after being off)
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`
  Port ${PORT} is already in use. Another copy of the portal may be running.
` +
      `  Close the other window (or restart your PC) and run the launcher again.
`);
  } else {
    console.error('Server failed to start:', e.message);
  }
  process.exit(1);
});
