'use strict';
const bcrypt = require('bcryptjs');
const { db, logAudit } = require('./db');

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MINUTES = 15;

function attachAuth(app) {
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${mins} minute(s).` });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      const attempts = user.failed_attempts + 1;
      const lockedUntil = attempts >= LOCKOUT_THRESHOLD
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() : null;
      db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, lockedUntil, user.id);
      logAudit(username, 'login_failed', 'users', user.id, { attempts });
      if (lockedUntil) return res.status(423).json({ error: `Too many failed attempts. Locked for ${LOCKOUT_MINUTES} minutes.` });
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
    req.session.user = { id: user.id, username: user.username, full_name: user.full_name, role: user.role };
    logAudit(username, 'login', 'users', user.id, null);
    res.json({ ok: true, user: req.session.user });
  });

  app.post('/api/logout', (req, res) => {
    const u = req.session.user;
    req.session.destroy(() => {
      if (u) logAudit(u.username, 'logout', 'users', u.id, null);
      res.json({ ok: true });
    });
  });

  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.session.user, permissions: permissionsForRole(req.session.user.role) });
  });
}

function permissionsForRole(role) {
  const rows = db.prepare('SELECT section, allowed FROM access_permissions WHERE role = ?').all(role);
  const out = {};
  for (const r of rows) out[r.section] = !!r.allowed;
  return out;
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.user.role)) return res.status(403).json({ error: 'Not permitted' });
    next();
  };
}

function requireSection(section) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.user.role === 'super_user') return next();
    const row = db.prepare('SELECT allowed FROM access_permissions WHERE role = ? AND section = ?')
      .get(req.session.user.role, section);
    if (!row || !row.allowed) return res.status(403).json({ error: `No access to ${section}` });
    next();
  };
}

module.exports = { attachAuth, requireAuth, requireRole, requireSection, permissionsForRole };
