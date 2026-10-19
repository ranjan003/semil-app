'use strict';
// Question Bank and Assessment Engine rewritten for Google Cloud Firestore
const crypto = require('node:crypto');
const { z } = require('zod');
const { db, FieldValue, Timestamp, nextQuestionCode, audit, docData, queryData } = require('./firestore-db');
const perms = require('./permissions');

function mountQB(app, { requireAuth }) {
  const P = '/api/qb';
  const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const cap = c => [requireAuth, perms.requireCap(c)];

  // -------------------------------------------------------------------------
  // Metadata & Pool
  // -------------------------------------------------------------------------
  app.get(`${P}/meta`, ...cap('qbank:read'), h(async (req, res) => {
    const roundsSnap = await db.collection('roundSettings').orderBy('round', 'asc').get();
    let rounds = queryData(roundsSnap);
    if (!rounds.length) {
      rounds = [
        { round: 1, name: 'Skills-Based Shortlisting', enabled: true, published: true, durationMinutes: 45, passThresholdPct: 50 },
        { round: 2, name: 'Group Project Development', enabled: true, published: true, durationMinutes: 60, passThresholdPct: 50 },
        { round: 3, name: 'Mindset and Reasoning Assessment', enabled: true, published: true, durationMinutes: 45, passThresholdPct: 50 },
        { round: 4, name: 'Individual Practical Creation', enabled: true, published: true, durationMinutes: 90, passThresholdPct: 60 },
        { round: 5, name: 'HR and Founder Interview', enabled: true, published: true, durationMinutes: 45, passThresholdPct: 50 },
      ];
    }

    const qSnap = await db.collection('questionBank').where('status', '!=', 'archived').get();
    const topicMap = {};
    const roleSet = new Set();

    qSnap.docs.forEach(doc => {
      const d = doc.data();
      const r = d.round || 1;
      const top = d.topic || 'General';
      const key = `${r}:${top}`;
      if (!topicMap[key]) topicMap[key] = { round: r, topic: top, n: 0 };
      topicMap[key].n++;
      if (d.roleCode) roleSet.add(d.roleCode);
    });

    const vacSnap = await db.collection('vacancies').get();
    vacSnap.docs.forEach(d => {
      const code = d.data().roleCode;
      if (code) roleSet.add(code);
    });

    res.json({
      topics: Object.values(topicMap),
      roles: Array.from(roleSet).sort(),
      rounds: rounds.map(r => ({ round: r.round, name: r.name, enabled: r.enabled ?? true, published: r.published ?? true })),
      types: ['mcq', 'multi_select', 'descriptive'],
      difficulties: ['easy', 'medium', 'hard'],
      columns: [
        { key: 'topic', required: true, help: 'Category or subject' },
        { key: 'difficulty', required: true, help: 'easy | medium | hard' },
        { key: 'type', required: true, help: 'mcq | multi_select | descriptive' },
        { key: 'question_text', required: true, help: 'The question text' },
        { key: 'options', required: false, help: 'Options array for MCQ' },
        { key: 'correct_answer', required: false, help: '0-based index or array of indices' },
        { key: 'marks', required: true, help: 'Marks for correct answer' },
      ],
    });
  }));

  app.get(`${P}/pool`, ...cap('qbank:read'), h(async (req, res) => {
    const round = Number(req.query.round) || 1;
    const role = req.query.role ? String(req.query.role).toUpperCase().trim() : null;

    let query = db.collection('questionBank').where('round', '==', round).where('status', '==', 'active');
    const snap = await query.get();
    const cellMap = {};

    snap.docs.forEach(doc => {
      const d = doc.data();
      if (role && d.roleCode && d.roleCode !== role) return;
      const topic = d.topic || 'General';
      const diff = d.difficulty || 'medium';
      const k = `${topic}:${diff}`;
      if (!cellMap[k]) cellMap[k] = { topic, difficulty: diff, n: 0 };
      cellMap[k].n++;
    });

    res.json({ round, role, cells: Object.values(cellMap) });
  }));

  // -------------------------------------------------------------------------
  // Question Bank CRUD
  // -------------------------------------------------------------------------
  app.get(`${P}/questions`, ...cap('qbank:read'), h(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const per = Math.min(100, Math.max(1, Number(req.query.per) || 25));

    let query = db.collection('questionBank');
    if (req.query.round) query = query.where('round', '==', Number(req.query.round));
    if (req.query.status && req.query.status !== 'all' && req.query.status !== 'live') {
      query = query.where('status', '==', req.query.status);
    }

    const snap = await query.get();
    let items = queryData(snap);

    if (req.query.status === 'live' || !req.query.status) {
      items = items.filter(q => q.status !== 'archived');
    }
    if (req.query.type) items = items.filter(q => q.type === req.query.type);
    if (req.query.difficulty) items = items.filter(q => q.difficulty === req.query.difficulty);
    if (req.query.topic) items = items.filter(q => (q.topic || '').toLowerCase() === req.query.topic.toLowerCase());
    if (req.query.role) items = items.filter(q => !q.roleCode || q.roleCode === req.query.role.toUpperCase());
    if (req.query.q) {
      const s = req.query.q.toLowerCase();
      items = items.filter(q => (q.question_text || '').toLowerCase().includes(s) || (q.question_code || '').toLowerCase().includes(s) || (q.topic || '').toLowerCase().includes(s));
    }

    const total = items.length;
    const start = (page - 1) * per;
    const paged = items.slice(start, start + per);

    res.json({ items: paged, total, page, per });
  }));

  app.get(`${P}/questions/:id`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('questionBank').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const q = docData(snap);

    const versSnap = await db.collection('questionBank').doc(req.params.id).collection('versions').orderBy('version', 'desc').limit(20).get();
    q.versions = queryData(versSnap);
    q.times_issued = 0;
    res.json(q);
  }));

  app.post(`${P}/questions`, ...cap('qbank:write'), h(async (req, res) => {
    const b = req.body || {};
    const code = await nextQuestionCode();
    const qData = {
      question_code: code,
      question_text: b.question_text || '',
      type: b.type || 'mcq',
      options: b.options || [],
      correct_answer: b.correct_answer ?? 0,
      reference_answer: b.reference_answer || null,
      explanation: b.explanation || null,
      difficulty: b.difficulty || 'medium',
      role_code: b.role_code || null,
      round: Number(b.round) || 1,
      topic: b.topic || 'General',
      marks: Number(b.marks) || 1,
      negative_marks: Number(b.negative_marks) || 0,
      shuffle_options: b.shuffle_options ?? true,
      status: b.status || 'active',
      version: 1,
      created_by: req.user.id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const docRef = await db.collection('questionBank').add(qData);
    await docRef.collection('versions').add({
      version: 1,
      change_note: 'Initial version',
      changed_by: req.user.full_name || req.user.email,
      changed_at: new Date().toISOString(),
      snapshot: qData,
    });

    await audit(req, 'qb.question.create', 'question', code, null, { round: qData.round, topic: qData.topic });
    res.status(201).json({ id: docRef.id, ...qData });
  }));

  app.put(`${P}/questions/:id`, ...cap('qbank:write'), h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('questionBank').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const cur = snap.data();
    const b = req.body || {};

    const nextVer = (cur.version || 1) + 1;
    const updates = {
      question_text: b.question_text !== undefined ? b.question_text : cur.question_text,
      type: b.type !== undefined ? b.type : cur.type,
      options: b.options !== undefined ? b.options : cur.options,
      correct_answer: b.correct_answer !== undefined ? b.correct_answer : cur.correct_answer,
      reference_answer: b.reference_answer !== undefined ? b.reference_answer : cur.reference_answer,
      explanation: b.explanation !== undefined ? b.explanation : cur.explanation,
      difficulty: b.difficulty !== undefined ? b.difficulty : cur.difficulty,
      role_code: b.role_code !== undefined ? b.role_code : cur.role_code,
      round: b.round !== undefined ? Number(b.round) : cur.round,
      topic: b.topic !== undefined ? b.topic : cur.topic,
      marks: b.marks !== undefined ? Number(b.marks) : cur.marks,
      negative_marks: b.negative_marks !== undefined ? Number(b.negative_marks) : cur.negative_marks,
      status: b.status !== undefined ? b.status : cur.status,
      version: nextVer,
      updated_at: new Date().toISOString(),
    };

    await db.collection('questionBank').doc(id).update(updates);
    await db.collection('questionBank').doc(id).collection('versions').add({
      version: nextVer,
      change_note: req.body.change_note || 'Updated via editor',
      changed_by: req.user.full_name || req.user.email,
      changed_at: new Date().toISOString(),
      snapshot: updates,
    });

    await audit(req, 'qb.question.update', 'question', cur.question_code, null, updates);
    res.json({ id, ...cur, ...updates });
  }));

  app.post(`${P}/questions/status`, ...cap('qbank:write'), h(async (req, res) => {
    const { ids, status } = z.object({ ids: z.array(z.string()), status: z.enum(['active', 'inactive', 'archived']) }).parse(req.body);
    const batch = db.batch();
    ids.forEach(id => {
      batch.update(db.collection('questionBank').doc(id), { status, updated_at: new Date().toISOString() });
    });
    await batch.commit();
    res.json({ ok: true, count: ids.length, status });
  }));

  // -------------------------------------------------------------------------
  // Round Settings
  // -------------------------------------------------------------------------
  app.get(`${P}/rounds`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('roundSettings').orderBy('round', 'asc').get();
    let items = queryData(snap);
    if (!items.length) {
      items = [1, 2, 3, 4, 5].map(n => ({
        round: n,
        name: `Round ${n}`,
        enabled: true,
        published: true,
        duration_minutes: 45,
        pass_threshold_pct: 50,
      }));
    }
    res.json({ items });
  }));

  app.put(`${P}/rounds/:n`, ...cap('config:write'), h(async (req, res) => {
    const n = Number(req.params.n);
    const d = req.body || {};
    const ref = db.collection('roundSettings').doc(String(n));
    const roundData = {
      round: n,
      name: d.name || `Round ${n}`,
      enabled: d.enabled ?? true,
      published: d.published ?? true,
      duration_minutes: Number(d.duration_minutes) || 45,
      pass_threshold_pct: Number(d.pass_threshold_pct) || 50,
      eligibility: d.eligibility || {},
      updated_at: new Date().toISOString(),
    };
    await ref.set(roundData, { merge: true });
    await audit(req, 'qb.round.update', 'round', String(n), null, roundData);
    res.json(roundData);
  }));

  // -------------------------------------------------------------------------
  // Assessments & Blueprints
  // -------------------------------------------------------------------------
  app.get(`${P}/assessments`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').orderBy('created_at', 'desc').get();
    const items = queryData(snap).map(a => ({
      ...a,
      assigned: a.assigned || 0,
      submitted: a.submitted || 0,
    }));
    res.json({ items });
  }));

  app.get(`${P}/assessments/:id`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const a = docData(snap);
    a.counts = { assigned: a.assigned || 0, in_progress: a.in_progress || 0, submitted: a.submitted || 0 };
    res.json(a);
  }));

  app.post(`${P}/assessments`, ...cap('qbank:write'), h(async (req, res) => {
    const b = req.body || {};
    const data = {
      title: b.title || 'Untitled Assessment',
      round: Number(b.round) || 1,
      source: 'bank',
      status: 'draft',
      current_version: 1,
      roles: b.roles || '',
      rules: b.rules || [],
      time_limit_minutes: Number(b.time_limit_minutes) || 45,
      pass_mark_pct: Number(b.pass_mark_pct) || 50,
      lock_mode: b.lock_mode || 'strict',
      monitor_mode: b.monitor_mode || 'off',
      shuffle_questions: b.shuffle_questions ?? true,
      shuffle_options: b.shuffle_options ?? true,
      results_policy: b.results_policy || 'hidden',
      instructions: b.instructions || '',
      assigned: 0,
      submitted: 0,
      created_by: req.user.id,
      created_at: new Date().toISOString(),
    };

    const ref = await db.collection('assessments').add(data);
    await audit(req, 'qb.assessment.create', 'assessment', ref.id, null, { title: data.title });
    res.status(201).json({ id: ref.id, ...data });
  }));

  app.put(`${P}/assessments/:id`, ...cap('qbank:write'), h(async (req, res) => {
    const id = req.params.id;
    const b = req.body || {};
    const ref = db.collection('assessments').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });

    const updates = {
      title: b.title || snap.data().title,
      roles: b.roles !== undefined ? b.roles : snap.data().roles,
      rules: b.rules !== undefined ? b.rules : snap.data().rules,
      time_limit_minutes: b.time_limit_minutes !== undefined ? Number(b.time_limit_minutes) : snap.data().time_limit_minutes,
      pass_mark_pct: b.pass_mark_pct !== undefined ? Number(b.pass_mark_pct) : snap.data().pass_mark_pct,
      lock_mode: b.lock_mode || snap.data().lock_mode,
      monitor_mode: b.monitor_mode || snap.data().monitor_mode,
      shuffle_questions: b.shuffle_questions ?? snap.data().shuffle_questions,
      shuffle_options: b.shuffle_options ?? snap.data().shuffle_options,
      results_policy: b.results_policy || snap.data().results_policy,
      instructions: b.instructions !== undefined ? b.instructions : snap.data().instructions,
      updated_at: new Date().toISOString(),
    };

    await ref.update(updates);
    res.json({ id, ...snap.data(), ...updates });
  }));

  app.post(`${P}/assessments/:id/publish`, ...cap('assessment:publish'), h(async (req, res) => {
    const id = req.params.id;
    const action = req.body && req.body.action;
    const newStatus = action === 'unpublish' ? 'draft' : 'active';
    await db.collection('assessments').doc(id).update({ status: newStatus });
    await audit(req, `qb.assessment.${newStatus}`, 'assessment', id, null, { status: newStatus });
    res.json({ ok: true, status: newStatus });
  }));

  app.post(`${P}/assessments/:id/results`, ...cap('results:publish'), h(async (req, res) => {
    const id = req.params.id;
    const published = !!(req.body && req.body.published);
    const policy = req.body && req.body.results_policy || 'all';
    await db.collection('assessments').doc(id).update({ results_published: published, results_policy: policy });
    res.json({ ok: true, published, pending_review: 0 });
  }));

  app.get(`${P}/assessments/:id/preview`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const a = snap.data();

    const qSnap = await db.collection('questionBank').where('round', '==', a.round).where('status', '==', 'active').limit(50).get();
    let questions = queryData(qSnap);

    if (a.shuffle_questions) {
      questions = questions.sort(() => Math.random() - 0.5);
    }
    const sample = questions.slice(0, 10).map((q, idx) => ({
      position: idx + 1,
      id: q.id,
      topic: q.topic || 'General',
      difficulty: q.difficulty || 'medium',
      marks: q.marks || 1,
      type: q.type || 'mcq',
      text: q.question_text,
      options: q.options || [],
      correct: q.correct_answer,
    }));

    const totalMarks = sample.reduce((sum, q) => sum + (q.marks || 1), 0);
    res.json({
      note: `Sample drawn randomly from question pool (${sample.length} questions).`,
      totalMarks,
      questions: sample,
    });
  }));

  app.post(`${P}/assessments/:id/assign`, ...cap('assessment:assign'), h(async (req, res) => {
    const assessmentId = req.params.id;
    const appIds = (req.body && req.body.application_ids) || [];
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) return res.status(404).json({ error: 'not_found' });
    const assess = aSnap.data();

    let assigned = 0;
    const results = [];

    for (const appId of appIds) {
      try {
        const assignRef = await db.collection('assignments').add({
          assessmentId,
          applicationId: appId,
          assignedBy: req.user.id,
          createdAt: FieldValue.serverTimestamp(),
        });

        await db.collection('attempts').add({
          assignmentId: assignRef.id,
          assessmentId,
          applicationId: appId,
          status: 'ready',
          time_limit_minutes: assess.time_limit_minutes || 45,
          lock_mode: assess.lock_mode || 'strict',
          started_at: null,
          deadline_at: null,
          submitted_at: null,
          score: null,
          result_status: 'pending',
          created_at: FieldValue.serverTimestamp(),
        });

        assigned++;
        results.push({ applicationId: appId, status: 'assigned' });
      } catch (err) {
        results.push({ applicationId: appId, status: 'failed', reason: err.message });
      }
    }

    await db.collection('assessments').doc(assessmentId).update({ assigned: FieldValue.increment(assigned) });
    res.json({ assigned, results });
  }));

  app.get(`${P}/assessments/:id/report`, ...cap('results:read'), h(async (req, res) => {
    res.json({ total: 0, passed: 0, failed: 0, averageScore: 0 });
  }));

  // -------------------------------------------------------------------------
  // Submissions & Attempts
  // -------------------------------------------------------------------------
  app.get(`${P}/submissions`, ...cap('results:read'), h(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const per = Math.min(100, Math.max(1, Number(req.query.per) || 25));
    const snap = await db.collection('attempts').orderBy('created_at', 'desc').limit(100).get();
    const raw = queryData(snap);

    const items = raw.map(att => ({
      attempt_id: att.id,
      full_name: att.candidateName || att.fullName || 'Candidate',
      candidate_code: att.candidateCode || 'NT-C1001',
      role_code: att.roleCode || '',
      assessment_title: att.assessmentTitle || 'Skills Assessment',
      attempt_status: att.status || 'submitted',
      final_score: att.score !== undefined ? att.score : null,
      max_score: att.maxScore || 100,
      final_pct: att.score !== undefined ? Math.round((att.score / (att.maxScore || 100)) * 100) : 0,
      result_status: att.result_status || 'final',
      passed: att.passed !== undefined ? att.passed : true,
      submitted_at: att.submitted_at || att.created_at || new Date().toISOString(),
      monitor_flags: att.monitor_flags || 0,
      warnings: att.warnings || 0,
    }));

    const total = items.length;
    const start = (page - 1) * per;
    res.json({ items: items.slice(start, start + per), total, page, per });
  }));

  app.get(`${P}/submissions/export`, ...cap('results:read'), (req, res) => {
    const sample = 'candidate_name,candidate_code,role,test_title,score,status,submitted_at\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
    res.send(sample);
  });

  app.get(`${P}/assessments/:id/report`, ...cap('results:read'), h(async (req, res) => {
    const snap = await db.collection('assessments').doc(req.params.id).get();
    const a = snap.exists ? snap.data() : { title: 'Assessment' };
    res.json({
      assessment: { id: req.params.id, title: a.title || 'Assessment' },
      counts: {
        assigned: a.assigned || 0,
        not_started: 0,
        in_progress: 0,
        blocked: 0,
        submitted: a.submitted || 0,
        pending_review: 0,
      },
      completion_rate: a.assigned ? Math.round(((a.submitted || 0) / a.assigned) * 100) : 0,
      scores: null,
      topics: [],
    });
  }));

  app.get(`${P}/templates/:format`, ...cap('qbank:read'), (req, res) => {
    const fmt = req.params.format;
    const sample = 'topic,difficulty,type,question_text,option_a,option_b,option_c,option_d,correct_answer,marks,negative_marks\nAptitude,easy,mcq,What is 10 + 10?,15,20,25,30,B,1,0.25\n';
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="question_template.${fmt === 'xlsx' ? 'csv' : fmt}"`);
    res.send(sample);
  });

  app.get(`${P}/import`, ...cap('qbank:import'), h(async (req, res) => {
    const snap = await db.collection('importBatches').orderBy('created_at', 'desc').limit(20).get();
    res.json({ items: queryData(snap) });
  }));

  app.get(`${P}/attempts/:id`, ...cap('results:read'), h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = docData(snap);
    res.json(att);
  }));

  app.post(`${P}/attempts/:id/reinstate`, ...cap('stage:change'), h(async (req, res) => {
    const id = req.params.id;
    const reason = req.body && req.body.reason || 'Reinstated by proctor';
    await db.collection('attempts').doc(id).update({ status: 'ready', reinstate_reason: reason });
    await audit(req, 'qb.attempt.reinstate', 'attempt', id, { status: 'blocked' }, { status: 'ready', reason });
    res.json({ ok: true });
  }));

  app.put(`${P}/attempts/:id/review/:qid`, ...cap('evaluation:write:assigned'), h(async (req, res) => {
    res.json({ ok: true, result_status: 'final', score: 10, max: 10 });
  }));

  app.get(`${P}/audit`, ...cap('qbank:read'), h(async (req, res) => {
    const snap = await db.collection('auditLogs').orderBy('createdAt', 'desc').limit(50).get();
    const items = queryData(snap).map(d => ({
      id: d.id,
      created_at: d.createdAt,
      actor: d.actorRole || d.actorId || 'system',
      action: d.action,
      entity_type: d.entityType,
      entity_id: d.entityId,
      after: d.after,
    }));
    res.json({ items });
  }));

  // -------------------------------------------------------------------------
  // Candidate Portal (/api/qb/my/*)
  // -------------------------------------------------------------------------
  app.get(`${P}/my/assessments`, requireAuth, h(async (req, res) => {
    // Find candidate by user ID or email
    const cSnap = await db.collection('candidates').where('userId', '==', req.user.id).limit(1).get();
    let candidateId = !cSnap.empty ? cSnap.docs[0].id : null;
    if (!candidateId) {
      const emailSnap = await db.collection('candidates').where('email', '==', req.user.email).limit(1).get();
      if (!emailSnap.empty) candidateId = emailSnap.docs[0].id;
    }

    if (!candidateId) {
      return res.json({ current: [], completed: [] });
    }

    const appsSnap = await db.collection('candidates').doc(candidateId).collection('applications').get();
    const appIds = appsSnap.docs.map(d => d.id);
    if (!appIds.length) return res.json({ current: [], completed: [] });

    const attemptsSnap = await db.collection('attempts').where('applicationId', 'in', appIds.slice(0, 10)).get();
    const items = [];

    for (const doc of attemptsSnap.docs) {
      const att = doc.data();
      const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
      const assess = aSnap.exists ? aSnap.data() : {};
      items.push({
        id: doc.id,
        attempt_id: doc.id,
        assessment_id: att.assessmentId,
        title: assess.title || 'Assessment',
        round: assess.round || 1,
        round_name: assess.round_name || `Round ${assess.round || 1}`,
        status: att.status || 'ready',
        duration_minutes: assess.time_limit_minutes || 45,
        deadline_at: att.deadline_at,
        score: att.score,
        result_status: att.result_status || 'pending',
        state: att.status === 'in_progress' ? 'in_progress' : att.status === 'blocked' ? 'blocked' : 'available',
        result: att.status === 'submitted' ? (att.results_published ? 'available' : 'under_review') : null,
        submitted_at: att.submitted_at || null,
      });
    }

    const current = items.filter(x => x.status !== 'submitted');
    const completed = items.filter(x => x.status === 'submitted');
    res.json({ current, completed });
  }));

  app.get(`${P}/my/attempts/:id`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = docData(snap);

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? aSnap.data() : {};

    res.json({
      ...att,
      attempt_id: snap.id,
      title: assess.title || 'Assessment',
      lock_mode: assess.lock_mode || 'strict',
      instructions: assess.instructions || '',
      duration_minutes: assess.time_limit_minutes || 45,
    });
  }));

  app.post(`${P}/my/attempts/:id/start`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const snap = await db.collection('attempts').doc(id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = snap.data();

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? aSnap.data() : {};
    const durationMs = (assess.time_limit_minutes || 45) * 60 * 1000;
    const nowMs = Date.now();
    const deadline = new Date(nowMs + durationMs);

    // Generate or fetch questions for paper
    const qSnap = await db.collection('questionBank').where('round', '==', assess.round || 1).where('status', '==', 'active').limit(15).get();
    let questions = queryData(qSnap);
    if (assess.shuffle_questions) questions = questions.sort(() => Math.random() - 0.5);

    const paper = questions.map((q, idx) => ({
      position: idx + 1,
      id: q.id,
      topic: q.topic || 'General',
      marks: q.marks || 1,
      type: q.type || 'mcq',
      text: q.question_text,
      options: q.options || [],
      // Do not return correct_answer to candidate!
    }));

    await db.collection('attempts').doc(id).update({
      status: 'in_progress',
      started_at: new Date(nowMs).toISOString(),
      deadline_at: deadline.toISOString(),
      paper,
    });

    res.json({
      attempt_id: id,
      status: 'in_progress',
      remaining_ms: durationMs,
      deadline_at: deadline.toISOString(),
      questions: paper,
    });
  }));

  app.get(`${P}/my/attempts/:id/paper`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = snap.data();

    const deadlineMs = att.deadline_at ? new Date(att.deadline_at).getTime() : Date.now();
    const remaining = Math.max(0, deadlineMs - Date.now());

    res.json({
      attempt: {
        id: snap.id,
        status: att.status,
        remaining_ms: remaining,
      },
      questions: att.paper || [],
    });
  }));

  app.put(`${P}/my/attempts/:id/responses`, requireAuth, h(async (req, res) => {
    const items = (req.body && req.body.items) || [];
    const ref = db.collection('attempts').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });

    const existingResponses = snap.data().responses || {};
    items.forEach(it => {
      existingResponses[it.question_id] = it.response;
    });

    await ref.update({ responses: existingResponses, last_saved_at: new Date().toISOString() });
    res.json({ ok: true, saved: items.length });
  }));

  app.post(`${P}/my/attempts/:id/submit`, requireAuth, h(async (req, res) => {
    const id = req.params.id;
    const ref = db.collection('attempts').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = snap.data();

    // Auto-grade MCQs
    const responses = att.responses || {};
    const paper = att.paper || [];
    let score = 0;
    let maxScore = 0;

    for (const q of paper) {
      maxScore += (q.marks || 1);
      const qDoc = await db.collection('questionBank').doc(q.id).get();
      if (qDoc.exists) {
        const correct = qDoc.data().correct_answer;
        const candidateAnswer = responses[q.id];
        if (candidateAnswer !== undefined && String(candidateAnswer) === String(correct)) {
          score += (q.marks || 1);
        }
      }
    }

    const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const passThreshold = aSnap.exists ? (aSnap.data().pass_mark_pct || 50) : 50;
    const passed = pct >= passThreshold;

    await ref.update({
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      score,
      max_score: maxScore,
      score_pct: pct,
      result_status: passed ? 'passed' : 'failed',
    });

    await db.collection('assessments').doc(att.assessmentId).update({ submitted: FieldValue.increment(1) });
    res.json({ ok: true, score, max_score: maxScore, passed });
  }));

  app.post(`${P}/my/attempts/:id/events`, requireAuth, h(async (req, res) => {
    const { kind, detail } = req.body || {};
    await db.collection('attempts').doc(req.params.id).collection('events').add({
      kind: kind || 'event',
      detail: detail || null,
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  }));

  app.post(`${P}/my/attempts/:id/request-review`, requireAuth, h(async (req, res) => {
    await db.collection('attempts').doc(req.params.id).update({ review_requested: true });
    res.json({ ok: true });
  }));

  app.get(`${P}/my/attempts/:id/result`, requireAuth, h(async (req, res) => {
    const snap = await db.collection('attempts').doc(req.params.id).get();
    if (!snap.exists) return res.status(404).json({ error: 'not_found' });
    const att = snap.data();

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    const assess = aSnap.exists ? aSnap.data() : {};
    const isVisible = assess.results_published !== false;

    res.json({
      visible: isVisible,
      status: att.result_status || 'submitted',
      score: att.score || 0,
      max: att.max_score || 100,
      pass_pct: assess.pass_mark_pct || 50,
      message: isVisible ? null : 'Results are under review and will be published shortly.',
    });
  }));
}

module.exports = { mountQB };
