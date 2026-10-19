'use strict';
// Reports and analytics module.
// CSV export, dashboard KPIs, funnel metrics, and pipeline analytics.

const { z } = require('zod');

/**
 * Mount reports & analytics routes on the Express app.
 *
 * @param {import('express').Application} app
 * @param {object} deps
 * @param {object} deps.db
 * @param {Function} deps.requireAuth
 * @param {object} deps.perms
 */
function mountReports(app, { db, requireAuth, perms }) {
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // =====================================================================================
  // Dashboard KPIs
  // =====================================================================================
  app.get('/api/reports/dashboard', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:read')) return res.status(403).json({ error: 'forbidden' });

    const [candidates, vacancies, applications, stages, recent] = await Promise.all([
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
                       count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month
                  FROM candidates WHERE deleted_at IS NULL`),
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE status = 'active')::int AS active,
                       sum(openings)::int AS total_openings
                  FROM vacancies`),
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE stage IN ('selected','offer_sent','offer_accepted','joined'))::int AS selected,
                       count(*) FILTER (WHERE stage = 'rejected')::int AS rejected
                  FROM applications`),
      db.query(`SELECT stage, count(*)::int AS count FROM applications GROUP BY stage ORDER BY
                CASE stage WHEN 'applied' THEN 1 WHEN 'round_1' THEN 2 WHEN 'round_2' THEN 3
                           WHEN 'round_3' THEN 4 WHEN 'round_4' THEN 5 WHEN 'round_5' THEN 6
                           WHEN 'selected' THEN 7 WHEN 'offer_sent' THEN 8 WHEN 'offer_accepted' THEN 9
                           WHEN 'joined' THEN 10 WHEN 'rejected' THEN 11 WHEN 'on_hold' THEN 12 END`),
      db.query(`SELECT c.full_name, c.candidate_code, a.stage, a.stage_entered_at
                  FROM applications a JOIN candidates c ON c.id = a.candidate_id
                 WHERE c.deleted_at IS NULL
                 ORDER BY a.stage_entered_at DESC LIMIT 10`),
    ]);

    res.json({
      candidates: candidates.rows[0],
      vacancies: vacancies.rows[0],
      applications: applications.rows[0],
      funnel: stages.rows,
      recent_activity: recent.rows,
    });
  }));

  // =====================================================================================
  // College-wise analytics
  // =====================================================================================
  app.get('/api/reports/colleges', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:read')) return res.status(403).json({ error: 'forbidden' });

    const r = await db.query(
      `SELECT col.name AS college, count(DISTINCT c.id)::int AS candidates,
              count(DISTINCT a.id)::int AS applications,
              count(DISTINCT a.id) FILTER (WHERE a.stage IN ('selected','offer_sent','offer_accepted','joined'))::int AS selected,
              round(avg(CASE WHEN e.total_score IS NOT NULL THEN e.total_score END), 1) AS avg_score
         FROM colleges col
         JOIN candidates c ON c.college_id = col.id AND c.deleted_at IS NULL
         LEFT JOIN applications a ON a.candidate_id = c.id
         LEFT JOIN evaluations e ON e.application_id = a.id AND e.status = 'submitted'
        GROUP BY col.name ORDER BY candidates DESC`);

    res.json(r.rows);
  }));

  // =====================================================================================
  // Scoring summary per vacancy
  // =====================================================================================
  app.get('/api/reports/scoring', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:read')) return res.status(403).json({ error: 'forbidden' });

    const vacancyId = req.query.vacancy_id;
    const params = [];
    let where = '';
    if (vacancyId) {
      z.string().uuid().parse(vacancyId);
      params.push(vacancyId);
      where = `AND a.vacancy_id = $${params.length}`;
    }

    const r = await db.query(
      `SELECT c.candidate_code, c.full_name, c.email, v.title AS vacancy, a.stage,
              json_agg(json_build_object('round', e.round, 'score', e.total_score, 'recommendation', e.recommendation)
                       ORDER BY e.round) AS evaluations
         FROM applications a
         JOIN candidates c ON c.id = a.candidate_id AND c.deleted_at IS NULL
         JOIN vacancies v ON v.id = a.vacancy_id
         LEFT JOIN evaluations e ON e.application_id = a.id AND e.status = 'submitted'
        WHERE 1=1 ${where}
        GROUP BY c.id, c.candidate_code, c.full_name, c.email, v.title, a.stage
        ORDER BY c.full_name`, params);

    res.json(r.rows);
  }));

  // =====================================================================================
  // CSV exports
  // =====================================================================================

  // Export candidates list
  app.get('/api/reports/export/candidates', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:export')) return res.status(403).json({ error: 'forbidden' });

    const r = await db.query(
      `SELECT c.candidate_code, c.full_name, c.email, c.phone, c.city,
              col.name AS college, c.degree, c.branch, c.graduation_year,
              array_to_string(c.skills, '; ') AS skills, c.source,
              c.joining_availability, c.expected_compensation,
              a.stage, v.title AS vacancy, v.role_code,
              c.created_at
         FROM candidates c
         LEFT JOIN colleges col ON col.id = c.college_id
         LEFT JOIN applications a ON a.candidate_id = c.id
         LEFT JOIN vacancies v ON v.id = a.vacancy_id
        WHERE c.deleted_at IS NULL
        ORDER BY c.created_at DESC`);

    sendCsv(res, 'candidates', r.rows);
  }));

  // Export scores
  app.get('/api/reports/export/scores', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:export')) return res.status(403).json({ error: 'forbidden' });

    const r = await db.query(
      `SELECT c.candidate_code, c.full_name, v.title AS vacancy, a.stage,
              e.round, e.total_score, e.recommendation, e.evidence,
              u.full_name AS evaluator, e.submitted_at
         FROM evaluations e
         JOIN applications a ON a.id = e.application_id
         JOIN candidates c ON c.id = a.candidate_id AND c.deleted_at IS NULL
         JOIN vacancies v ON v.id = a.vacancy_id
         JOIN users u ON u.id = e.evaluator_id
        WHERE e.status = 'submitted'
        ORDER BY c.full_name, e.round`);

    sendCsv(res, 'scores', r.rows);
  }));

  // Export audit log
  app.get('/api/reports/export/audit', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:export') || req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    const limit = Math.min(Number(req.query.limit) || 5000, 50000);

    const r = await db.query(
      `SELECT al.id, al.action, al.entity_type, al.entity_id,
              al.actor_role, u.full_name AS actor_name, al.ip::text,
              al.created_at
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.actor_id
        ORDER BY al.created_at DESC LIMIT $1`, [limit]);

    sendCsv(res, 'audit_log', r.rows);
  }));

  // Export hiring funnel by vacancy
  app.get('/api/reports/export/funnel', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:export')) return res.status(403).json({ error: 'forbidden' });

    const r = await db.query(
      `SELECT v.title AS vacancy, v.role_code, v.openings, a.stage,
              count(*)::int AS count
         FROM vacancies v
         JOIN applications a ON a.vacancy_id = v.id
        GROUP BY v.title, v.role_code, v.openings, a.stage
        ORDER BY v.title, CASE a.stage
          WHEN 'applied' THEN 1 WHEN 'round_1' THEN 2 WHEN 'round_2' THEN 3
          WHEN 'round_3' THEN 4 WHEN 'round_4' THEN 5 WHEN 'round_5' THEN 6
          WHEN 'selected' THEN 7 WHEN 'offer_sent' THEN 8 WHEN 'offer_accepted' THEN 9
          WHEN 'joined' THEN 10 WHEN 'rejected' THEN 11 WHEN 'on_hold' THEN 12 END`);

    sendCsv(res, 'hiring_funnel', r.rows);
  }));

  // =====================================================================================
  // Interview schedule report
  // =====================================================================================
  app.get('/api/reports/interviews', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:read')) return res.status(403).json({ error: 'forbidden' });

    const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const r = await db.query(
      `SELECT i.starts_at, i.duration_minutes, i.location, i.status,
              c.full_name AS candidate, c.candidate_code,
              u.full_name AS interviewer, v.title AS vacancy, i.round
         FROM interviews i
         JOIN applications a ON a.id = i.application_id
         JOIN candidates c ON c.id = a.candidate_id
         JOIN vacancies v ON v.id = a.vacancy_id
         JOIN users u ON u.id = i.interviewer_id
        WHERE i.starts_at::date BETWEEN $1 AND $2
        ORDER BY i.starts_at`, [from, to]);

    res.json(r.rows);
  }));

  // =====================================================================================
  // Source effectiveness
  // =====================================================================================
  app.get('/api/reports/sources', requireAuth, h(async (req, res) => {
    if (!perms.can(req.user, 'report:read')) return res.status(403).json({ error: 'forbidden' });

    const r = await db.query(
      `SELECT coalesce(c.source, 'Unknown') AS source,
              count(DISTINCT c.id)::int AS candidates,
              count(DISTINCT a.id)::int AS applications,
              count(DISTINCT a.id) FILTER (WHERE a.stage IN ('selected','offer_sent','offer_accepted','joined'))::int AS selected,
              CASE WHEN count(DISTINCT a.id) > 0
                   THEN round(100.0 * count(DISTINCT a.id) FILTER (WHERE a.stage IN ('selected','offer_sent','offer_accepted','joined')) / count(DISTINCT a.id), 1)
                   ELSE 0 END AS conversion_pct
         FROM candidates c
         LEFT JOIN applications a ON a.candidate_id = c.id
        WHERE c.deleted_at IS NULL
        GROUP BY coalesce(c.source, 'Unknown')
        ORDER BY candidates DESC`);

    res.json(r.rows);
  }));
}

// ---- CSV helper ----
function sendCsv(res, name, rows) {
  if (!rows.length) {
    res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${name}.csv"` });
    return res.send('');
  }
  const cols = Object.keys(rows[0]);
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))];
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}_${new Date().toISOString().slice(0, 10)}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.send('\uFEFF' + lines.join('\n'));   // BOM for Excel compatibility
}

module.exports = { mountReports };
