'use strict';
// Camera proctoring endpoints.
// The browser analyses video and sound locally on the candidate's device and sends
// only short alert codes. Nothing is recorded or stored on the server.
//
// Alert types:
//   no_face        — candidate's face not visible
//   multiple_faces — more than one person detected
//   face_away      — candidate looking away from screen
//   loud_noise     — unexpected audio detected
//   camera_off     — camera feed stopped
//   mic_off        — microphone feed stopped
//
// The server logs these as attempt_events with kind='monitor'.
// HR can view them on the proctoring dashboard in real time via WebSocket.

const { z } = require('zod');

const ALERT_TYPES = ['no_face', 'multiple_faces', 'face_away', 'loud_noise', 'camera_off', 'mic_off'];

const alertSchema = z.object({
  type: z.enum(ALERT_TYPES),
  confidence: z.number().min(0).max(1).optional(),
  detail: z.string().max(200).optional(),
  timestamp: z.string().optional(),   // client-side timestamp for correlation
});

const alertBatchSchema = z.object({
  alerts: z.array(alertSchema).min(1).max(20),
});

/**
 * Mount camera proctoring routes on the Express app.
 *
 * @param {import('express').Application} app
 * @param {object} deps
 * @param {object} deps.db
 * @param {Function} deps.requireAuth
 * @param {Function} deps.audit
 * @param {object} [deps.realtime]  Real-time module for live alerts
 */
function mountCamera(app, { db, requireAuth, audit, realtime }) {
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const uuid = z.string().uuid();

  // Report a single camera/mic alert
  app.post('/api/attempts/:id/monitor', requireAuth, h(async (req, res) => {
    const attemptId = uuid.parse(req.params.id);
    const alert = alertSchema.parse(req.body);

    // Verify the attempt belongs to this candidate and the assessment requires monitoring
    const { rows } = await db.query(
      `SELECT t.id, t.status, a.monitor_mode, c.full_name
         FROM attempts t
         JOIN assignments g ON g.id = t.assignment_id
         JOIN assessments a ON a.id = g.assessment_id
         JOIN applications ap ON ap.id = g.application_id
         JOIN candidates c ON c.id = ap.candidate_id
        WHERE t.id = $1 AND c.user_id = $2`, [attemptId, req.user.id]);

    const attempt = rows[0];
    if (!attempt) return res.status(404).json({ error: 'not_found' });
    if (attempt.monitor_mode === 'off') return res.status(409).json({ error: 'monitoring_not_enabled' });
    if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'attempt_not_active' });

    // Log the alert as an attempt event
    await db.query(
      `INSERT INTO attempt_events(attempt_id, kind, detail)
       VALUES ($1, 'monitor', $2)`,
      [attemptId, JSON.stringify({ type: alert.type, confidence: alert.confidence, detail: alert.detail, ts: alert.timestamp })]);

    // Send live alert to HR dashboard via WebSocket
    if (realtime) {
      realtime.proctorAlert(attemptId, {
        type: alert.type,
        confidence: alert.confidence,
        candidateName: attempt.full_name,
        detail: alert.detail,
      });
    }

    res.json({ ok: true });
  }));

  // Report a batch of alerts (reduces HTTP overhead during tests)
  app.post('/api/attempts/:id/monitor/batch', requireAuth, h(async (req, res) => {
    const attemptId = uuid.parse(req.params.id);
    const { alerts } = alertBatchSchema.parse(req.body);

    const { rows } = await db.query(
      `SELECT t.id, t.status, a.monitor_mode, c.full_name
         FROM attempts t
         JOIN assignments g ON g.id = t.assignment_id
         JOIN assessments a ON a.id = g.assessment_id
         JOIN applications ap ON ap.id = g.application_id
         JOIN candidates c ON c.id = ap.candidate_id
        WHERE t.id = $1 AND c.user_id = $2`, [attemptId, req.user.id]);

    const attempt = rows[0];
    if (!attempt) return res.status(404).json({ error: 'not_found' });
    if (attempt.monitor_mode === 'off') return res.status(409).json({ error: 'monitoring_not_enabled' });
    if (attempt.status !== 'in_progress') return res.status(409).json({ error: 'attempt_not_active' });

    // Batch insert
    const values = alerts.map((a, i) => {
      const base = i * 2;
      return `($${base + 1}, 'monitor', $${base + 2})`;
    }).join(', ');
    const params = alerts.flatMap(a => [attemptId, JSON.stringify({ type: a.type, confidence: a.confidence, detail: a.detail, ts: a.timestamp })]);
    await db.query(`INSERT INTO attempt_events(attempt_id, kind, detail) VALUES ${values}`, params);

    // Send alerts to dashboard
    if (realtime) {
      for (const a of alerts) {
        realtime.proctorAlert(attemptId, {
          type: a.type,
          confidence: a.confidence,
          candidateName: attempt.full_name,
          detail: a.detail,
        });
      }
    }

    res.json({ ok: true, logged: alerts.length });
  }));

  // Get monitoring status for an attempt (HR only)
  app.get('/api/attempts/:id/monitor/summary', requireAuth, h(async (req, res) => {
    if (!['super_admin', 'hr_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const attemptId = uuid.parse(req.params.id);

    const events = await db.query(
      `SELECT kind, detail, created_at FROM attempt_events
       WHERE attempt_id = $1 AND kind = 'monitor'
       ORDER BY created_at DESC LIMIT 100`, [attemptId]);

    // Aggregate alert counts by type
    const counts = {};
    for (const row of events.rows) {
      try {
        const d = JSON.parse(row.detail);
        counts[d.type] = (counts[d.type] || 0) + 1;
      } catch { /* skip malformed */ }
    }

    res.json({
      total_alerts: events.rows.length,
      alert_counts: counts,
      recent: events.rows.slice(0, 20),
    });
  }));
}

module.exports = { mountCamera, ALERT_TYPES };
