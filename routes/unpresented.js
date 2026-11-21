'use strict';
const multer = require('multer');
const { requireSection } = require('../auth');
const U = require('../services/unpresented');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const A = (req) => req.session.user.username;
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const guard = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); console.error('unpresented', e); res.status(500).json({ error: e.message || String(e) }); }
};

module.exports = function (app) {
  U.syncFundsHead();          // the Available Funds reserve follows the open list
  const canView = requireSection('funds');
  const canEdit = requireSection('funds_edit');

  app.get('/api/unpresented', canView, guard((req, res) => {
    const status = ['open', 'presented', 'excluded', 'removed'].includes(req.query.status) ? req.query.status : 'open';
    res.json(U.list({ status }));
  }));
  app.post('/api/unpresented', canEdit, guard((req, res) => res.json({ ok: true, id: U.add(req.body || {}, A(req)) })));
  app.put('/api/unpresented/:id', canEdit, guard((req, res) => { U.update(Number(req.params.id), req.body || {}, A(req)); res.json({ ok: true }); }));
  app.post('/api/unpresented/:id/present', canEdit, guard((req, res) => { U.present(Number(req.params.id), (req.body || {}).date, A(req)); res.json({ ok: true }); }));
  app.post('/api/unpresented/:id/reopen', canEdit, guard((req, res) => { U.reopen(Number(req.params.id), A(req)); res.json({ ok: true }); }));
  app.post('/api/unpresented/:id/dismiss-flag', canEdit, guard((req, res) => { U.dismissFlag(Number(req.params.id), A(req)); res.json({ ok: true }); }));
  app.delete('/api/unpresented/:id', canEdit, guard((req, res) => { U.remove(Number(req.params.id), A(req)); res.json({ ok: true }); }));

  // the existing Excel list (first sheet) + its "BS" statement sheet, once
  app.post('/api/unpresented/import', canEdit, upload.single('file'), guard(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose the Excel file.' });
    const out = await U.importWorkbook(req.file.buffer, A(req));
    res.json({ ok: true, ...out });
  }));
  // look for open cheques in the statements that were already uploaded
  app.post('/api/unpresented/rematch', canEdit, guard(async (req, res) => {
    const b = req.body || {};
    res.json({ ok: true, ...(await U.rematchRecent({ days: Number(b.days) || 45, photos: !!b.photos })) });
  }));
  app.get('/api/unpresented/export', canView, guard(async (req, res) => {
    const buf = await U.exportWorkbook(/^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayISO());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Unpresented Cheques ${todayISO()}.xlsx"`);
    res.send(Buffer.from(buf));
  }));
};
