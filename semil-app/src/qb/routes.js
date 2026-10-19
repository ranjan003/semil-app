'use strict';
// HTTP surface of the question bank module, mounted under /api/qb. Authentication, the CSRF header check and the
// error handler come from app.js; every route re-checks permission on the server. No third-party imports here.
const svc = require('./service');
const asm = require('./assess');
const att = require('./attempt');
const { buildTemplate } = require('./templates');
const importer = require('./importer');
const U = require('./util');

function mount(app, { db, requireAuth, perms, audit, raw }) {
  const P = '/api/qb';
  const ctxOf = req => ({ db, actor: req.user, audit: (a, t, i, b, af, c) => audit(req, a, t, i, b, af, c || db) });
  const cap = c => [requireAuth, perms.requireCap(c)];
  const anyCap = (...caps) => [requireAuth, (req, res, next) => (caps.some(c => perms.can(req.user, c)) ? next() : res.status(403).json({ error: 'forbidden' }))];
  const h = fn => async (req, res, next) => {
    try { await fn(req, res, ctxOf(req)); }
    catch (e) {
      if (e && e.status && e.code) {
        const body = { error: e.code, message: e.message };
        for (const k of ['fields', 'shortfalls', 'existing', 'result']) if (e[k] !== undefined) body[k] = e[k];
        return res.status(e.status).json(body);
      }
      next(e);
    }
  };
  const file = (res, f) => {
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `attachment; filename="${f.fileName.replace(/[^\w.\-]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(f.body);
  };

  // ---------------- question bank
  app.get(`${P}/meta`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await svc.meta(ctx))));
  app.get(`${P}/pool`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await svc.poolMatrix(ctx, req.query))));
  app.get(`${P}/templates/:format`, ...cap('qbank:read'), h(async (req, res) => {
    const t = buildTemplate(req.params.format);
    if (!t) return res.status(404).json({ error: 'not_found' });
    file(res, t);
  }));
  app.get(`${P}/questions/export`, ...cap('qbank:read'), h(async (req, res, ctx) => file(res, await svc.exportQuestions(ctx, req.query))));
  app.get(`${P}/questions`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await svc.listQuestions(ctx, req.query))));
  app.post(`${P}/questions/status`, ...cap('qbank:write'), h(async (req, res, ctx) => res.json(await svc.setStatus(ctx, req.body && req.body.ids, req.body && req.body.status))));
  app.post(`${P}/questions`, ...cap('qbank:write'), h(async (req, res, ctx) => res.status(201).json(await svc.createQuestion(ctx, req.body))));
  app.get(`${P}/questions/:id`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await svc.getQuestion(ctx, req.params.id))));
  app.put(`${P}/questions/:id`, ...cap('qbank:write'), h(async (req, res, ctx) => res.json(await svc.updateQuestion(ctx, req.params.id, req.body, req.body && req.body.change_note))));

  // ---------------- import (the file is the request body; its name and type come from the query and Content-Type)
  app.post(`${P}/import/preview`, ...cap('qbank:import'), raw, h(async (req, res, ctx) => {
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'no_file', message: 'Send the file as the request body.' });
    try {
      const out = await svc.previewImport(ctx, { buffer: req.body, fileName: String(req.query.name || ''), mime: req.get('content-type'), onConflict: req.query.on_conflict });
      res.status(out.batchId ? 201 : 200).json(out);
    } catch (e) {
      if (e instanceof importer.UploadError) return res.status(e.status).json({ error: e.code, message: e.message });
      throw e;
    }
  }));
  app.get(`${P}/import`, ...cap('qbank:import'), h(async (req, res, ctx) => res.json(await svc.listBatches(ctx))));
  app.get(`${P}/import/:id`, ...cap('qbank:import'), h(async (req, res, ctx) => res.json(await svc.getBatch(ctx, req.params.id, req.query))));
  app.post(`${P}/import/:id/commit`, ...cap('qbank:import'), h(async (req, res, ctx) => res.status(201).json(await svc.commitImport(ctx, req.params.id))));
  app.post(`${P}/import/:id/cancel`, ...cap('qbank:import'), h(async (req, res, ctx) => res.json(await svc.cancelBatch(ctx, req.params.id))));

  // ---------------- rounds
  app.get(`${P}/rounds`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await svc.listRounds(ctx))));
  app.put(`${P}/rounds/:n`, ...cap('config:write'), h(async (req, res, ctx) => res.json(await svc.updateRound(ctx, req.params.n, req.body))));

  // ---------------- assessments
  app.get(`${P}/assessments`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await asm.listAssessments(ctx, req.query))));
  app.post(`${P}/assessments`, ...cap('qbank:write'), h(async (req, res, ctx) => res.status(201).json(await asm.createAssessment(ctx, req.body))));
  app.get(`${P}/assessments/:id`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await asm.getAssessment(ctx, req.params.id))));
  app.put(`${P}/assessments/:id`, ...cap('qbank:write'), h(async (req, res, ctx) => res.json(await asm.updateAssessment(ctx, req.params.id, req.body))));
  app.post(`${P}/assessments/:id/publish`, ...cap('assessment:publish'), h(async (req, res, ctx) => res.json(await asm.setPublished(ctx, req.params.id, req.body && req.body.action))));
  app.get(`${P}/assessments/:id/preview`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await asm.previewPaper(ctx, req.params.id, req.query))));
  app.post(`${P}/assessments/:id/assign`, ...cap('assessment:assign'), h(async (req, res, ctx) => res.json(await asm.assign(ctx, req.params.id, req.body))));
  app.post(`${P}/assessments/:id/results`, ...cap('results:publish'), h(async (req, res, ctx) => res.json(await asm.publishResults(ctx, req.params.id, req.body))));
  app.get(`${P}/assessments/:id/report`, ...cap('results:read'), h(async (req, res, ctx) => res.json(await asm.report(ctx, req.params.id))));

  // ---------------- submissions, marking, history
  app.get(`${P}/submissions/export`, ...cap('results:read'), h(async (req, res, ctx) => file(res, await asm.exportSubmissions(ctx, req.query))));
  app.get(`${P}/submissions`, ...anyCap('results:read', 'evaluation:write:assigned'), h(async (req, res, ctx) => res.json(await asm.listSubmissions(ctx, req.query))));
  app.get(`${P}/attempts/:id`, ...anyCap('results:read', 'evaluation:write:assigned'), h(async (req, res, ctx) => res.json(await asm.attemptDetail(ctx, req.params.id))));
  app.put(`${P}/attempts/:id/review/:qid`, ...anyCap('results:read', 'evaluation:write:assigned'), h(async (req, res, ctx) => res.json(await asm.reviewResponse(ctx, req.params.id, req.params.qid, req.body))));
  app.post(`${P}/attempts/:id/reinstate`, ...cap('stage:change'), h(async (req, res, ctx) => res.json(await att.reinstate(ctx, req.params.id, req.body))));
  app.get(`${P}/audit`, ...cap('qbank:read'), h(async (req, res, ctx) => res.json(await asm.auditTrail(ctx, req.query))));

  // ---------------- candidate portal (a candidate can only ever reach their own attempts)
  const mine = (path, method, fn) => app[method](`${P}/my/${path}`, ...cap('attempt:own'), h(fn));
  mine('assessments', 'get', async (req, res, ctx) => res.json(await att.listMine(ctx)));
  mine('attempts/:id', 'get', async (req, res, ctx) => res.json(await att.info(ctx, req.params.id)));
  mine('attempts/:id/start', 'post', async (req, res, ctx) => res.json(await att.start(ctx, req.params.id)));
  mine('attempts/:id/paper', 'get', async (req, res, ctx) => res.json(await att.getPaper(ctx, req.params.id)));
  mine('attempts/:id/responses', 'put', async (req, res, ctx) => res.json(await att.saveResponses(ctx, req.params.id, req.body && req.body.items)));
  mine('attempts/:id/submit', 'post', async (req, res, ctx) => res.json(await att.submit(ctx, req.params.id, req.body || {})));
  mine('attempts/:id/events', 'post', async (req, res, ctx) => res.json(await att.recordEvent(ctx, req.params.id, req.body)));
  mine('attempts/:id/request-review', 'post', async (req, res, ctx) => res.json(await att.requestReview(ctx, req.params.id)));
  mine('attempts/:id/result', 'get', async (req, res, ctx) => res.json(await att.result(ctx, req.params.id)));
}

module.exports = { mount };
