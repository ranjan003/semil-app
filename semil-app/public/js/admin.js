'use strict';
// Admin / HR / assessor workspace for the question bank module.
(function () {
  const { h, api, toast, chip, statusChip, fmtDate, field, sel, qs, pager } = NT;
  const ROUNDS = [1, 2, 3, 4, 5];
  const LET = ['A', 'B', 'C', 'D'];
  let META = null, ROUND_NAMES = {};
  const roundLabel = n => `Round ${n}${ROUND_NAMES[n] ? ' · ' + ROUND_NAMES[n] : ''}`;
  const loadMeta = async () => { META = await api.get('/api/qb/meta'); ROUND_NAMES = Object.fromEntries(META.rounds.map(r => [r.round, r.name])); return META; };
  const topicsFor = round => [...new Set(META.topics.filter(t => !round || t.round === Number(round)).map(t => t.topic))].sort();
  const fieldErrors = e => { const m = {}; (e.fields || []).forEach(f => { m[f.path] = (m[f.path] ? m[f.path] + ' ' : '') + f.message; }); return m; };

  // ======================================================================= Question bank
  function QuestionBank(user) {
    const root = h('div');
    const f = { q: '', round: '', type: '', difficulty: '', topic: '', status: 'live', page: 1 };
    const body = h('div');
    const canWrite = user.role === 'super_admin' || user.role === 'hr_admin';

    async function load() {
      let data;
      try { data = await api.get('/api/qb/questions' + qs({ ...f, per: 25 })); } catch (e) { return NT.err(e); }
      const rows = data.items.map(q => h('tr', {},
        h('td', { 'data-label': 'ID', class: 'mono small', text: q.question_code }),
        h('td', { 'data-label': 'Question', class: 'q' }, h('div', { text: q.question_text.length > 140 ? q.question_text.slice(0, 140) + '…' : q.question_text }), h('div', { class: 'muted small', text: q.topic })),
        h('td', { 'data-label': 'Type', text: q.type.replace('_', ' ') }),
        h('td', { 'data-label': 'Round', text: 'R' + q.round }),
        h('td', { 'data-label': 'Level' }, chip(q.difficulty)),
        h('td', { 'data-label': 'Role', text: q.role_code || 'All' }),
        h('td', { 'data-label': 'Marks', text: `${q.marks}${q.negative_marks ? ' / −' + q.negative_marks : ''}` }),
        h('td', { 'data-label': 'Status' }, statusChip(q.status)),
        h('td', { 'data-label': '' }, canWrite ? h('div', { class: 'row' },
          h('button', { class: 'btn small', onclick: () => openEditor(q.id), text: 'Edit' }),
          q.status === 'archived'
            ? h('button', { class: 'btn small', onclick: () => setStatus(q, 'active'), text: 'Restore' })
            : [h('button', { class: 'btn small', onclick: () => setStatus(q, q.status === 'active' ? 'inactive' : 'active'), text: q.status === 'active' ? 'Deactivate' : 'Activate' }),
               h('button', { class: 'btn small danger', onclick: () => setStatus(q, 'archived'), text: 'Archive' })]) : null)));
      NT.mount(body, data.items.length ? h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['ID', 'Question', 'Type', 'Round', 'Level', 'Role', 'Marks', 'Status', ''].map(t => h('th', { text: t })))), h('tbody', {}, rows))
        : h('p', { class: 'muted', text: 'No questions match. Import a file or add one with "New question".' }), pager(data.page, data.per, data.total, p => { f.page = p; load(); }));
    }
    async function setStatus(q, status) {
      if (status === 'archived' && !(await NT.confirm('Archive question', `Archive ${q.question_code}? It stops being used in new tests. Papers already issued keep their copy.`, 'Archive', 'danger'))) return;
      try { await api.post('/api/qb/questions/status', { ids: [q.id], status }); toast('Updated', 'ok'); load(); } catch (e) { NT.err(e); }
    }
    async function openEditor(id) {
      let q = null;
      if (id) { try { q = await api.get('/api/qb/questions/' + id); } catch (e) { return NT.err(e); } }
      const flat = q ? q.flat : { question_text: '', question_type: 'mcq', option_a: '', option_b: '', option_c: '', option_d: '', correct_answer: '', explanation: '', difficulty: 'medium', job_role: '', round: f.round || 1, topic: '', marks: 1, negative_marks: 0, status: 'active' };
      const v = { ...flat };
      const area = h('div');
      let errs = {};
      const set = k => ev => { v[k] = ev.target.value; };
      function draw() {
        const t = v.question_type;
        const answer = t === 'mcq'
          ? h('div', { class: 'field' + (errs.correct_answer ? ' bad' : '') }, h('span', { class: 'lbl', text: 'Correct answer' }), h('div', { class: 'row', role: 'radiogroup' }, LET.map(l => h('label', { class: 'row' }, h('input', { type: 'radio', name: 'ans', checked: v.correct_answer === l, onchange: () => { v.correct_answer = l; } }), ' ' + l))), errs.correct_answer ? h('div', { class: 'err', text: errs.correct_answer }) : null)
          : t === 'multi_select'
            ? h('div', { class: 'field' + (errs.correct_answer ? ' bad' : '') }, h('span', { class: 'lbl', text: 'Correct answers (two or more)' }), h('div', { class: 'row' }, LET.map(l => h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: String(v.correct_answer).split(',').includes(l), onchange: ev => { const s = new Set(String(v.correct_answer).split(',').filter(Boolean)); ev.target.checked ? s.add(l) : s.delete(l); v.correct_answer = LET.filter(x => s.has(x)).join(','); } }), ' ' + l))), errs.correct_answer ? h('div', { class: 'err', text: errs.correct_answer }) : null)
            : field('Model answer / marking notes (reviewers only)', h('textarea', { value: v.correct_answer, oninput: set('correct_answer') }), { error: errs.correct_answer });
        const opts = t === 'descriptive' ? null : h('div', {}, LET.map((l, i) => field(`Option ${l}${i < 2 ? ' (required)' : ''}`, h('input', { type: 'text', maxlength: 500, value: v['option_' + l.toLowerCase()], oninput: set('option_' + l.toLowerCase()) }))), errs.options ? h('div', { class: 'err', text: errs.options }) : null);
        const dl = h('datalist', { id: 'topic-list' }, topicsFor(v.round).map(t2 => h('option', { value: t2 })));
        NT.mount(area,
          Object.keys(errs).length ? h('div', { class: 'banner bad', role: 'alert' }, 'Please fix: ' + Object.values(errs).join(' ')) : null,
          field('Question', h('textarea', { value: v.question_text, maxlength: 2000, oninput: set('question_text') }), { error: errs.question_text }),
          h('div', { class: 'grid' },
            field('Type', sel([['mcq', 'Single choice (MCQ)'], ['multi_select', 'Multi-select'], ['descriptive', 'Descriptive']], v.question_type, { onchange: ev => { v.question_type = ev.target.value; if (v.question_type === 'descriptive') v.negative_marks = 0; v.correct_answer = ''; draw(); } }), { error: errs.question_type }),
            field('Round', sel(ROUNDS.map(n => [n, roundLabel(n)]), v.round, { onchange: ev => { v.round = Number(ev.target.value); draw(); } }), { error: errs.round }),
            field('Topic / category', h('input', { type: 'text', list: 'topic-list', maxlength: 60, value: v.topic, oninput: set('topic') }), { error: errs.topic }),
            field('Difficulty', sel(['easy', 'medium', 'hard'], v.difficulty, { onchange: set('difficulty') }), { error: errs.difficulty }),
            field('Job role', h('input', { type: 'text', placeholder: 'All roles', maxlength: 20, value: v.job_role, oninput: set('job_role') }), { hint: 'Role code such as SDE. Blank = every role.', error: errs.job_role }),
            field('Marks', h('input', { type: 'number', step: '0.25', min: '0.25', max: '100', value: v.marks, oninput: set('marks') }), { error: errs.marks }),
            t === 'descriptive' ? null : field('Negative marks', h('input', { type: 'number', step: '0.25', min: '0', value: v.negative_marks, oninput: set('negative_marks') }), { hint: 'Deducted for a wrong answer. Optional.', error: errs.negative_marks }),
            field('Status', sel(['active', 'inactive'], v.status === 'archived' ? 'inactive' : v.status, { onchange: set('status') }), { error: errs.status })),
          opts, answer, dl,
          field('Explanation (optional)', h('textarea', { value: v.explanation, maxlength: 2000, oninput: set('explanation') }), { hint: 'Shown to the candidate only when results review is switched on.', error: errs.explanation }),
          q ? h('p', { class: 'muted small', text: `ID ${q.question_code} · version ${q.version} · issued in ${q.times_issued} paper(s)` }) : null);
      }
      draw();
      NT.modal(q ? 'Edit question' : 'New question', area, [
        { label: 'Cancel' },
        { label: q ? 'Save changes' : 'Create question', kind: 'primary', close: false, run: async (ev, close) => {
          const payload = { ...v, question_type: v.question_type, round: Number(v.round), marks: v.marks, negative_marks: v.negative_marks };
          try { if (q) await api.put('/api/qb/questions/' + q.id, payload); else await api.post('/api/qb/questions', payload); close(); toast(q ? 'Question updated' : 'Question created', 'ok'); await loadMeta(); load(); }
          catch (e) { if (e.status === 400 || e.status === 409) { errs = fieldErrors(e); if (!Object.keys(errs).length) errs = { question_text: e.message }; draw(); } else NT.err(e); }
        } }]);
    }

    const filters = h('div', { class: 'card' }, h('div', { class: 'grid' },
      field('Search', h('input', { type: 'search', placeholder: 'Text, ID or topic', oninput: NT.debounce(ev => { f.q = ev.target.value; f.page = 1; load(); }, 300) })),
      field('Round', sel([['', 'All rounds'], ...ROUNDS.map(n => [n, 'Round ' + n])], f.round, { onchange: ev => { f.round = ev.target.value; f.page = 1; load(); } })),
      field('Type', sel([['', 'All types'], ['mcq', 'MCQ'], ['multi_select', 'Multi-select'], ['descriptive', 'Descriptive']], f.type, { onchange: ev => { f.type = ev.target.value; f.page = 1; load(); } })),
      field('Difficulty', sel([['', 'Any'], 'easy', 'medium', 'hard'], f.difficulty, { onchange: ev => { f.difficulty = ev.target.value; f.page = 1; load(); } })),
      field('Topic', h('input', { type: 'text', list: 'topic-filter', placeholder: 'Any topic', oninput: NT.debounce(ev => { f.topic = ev.target.value; f.page = 1; load(); }, 300) }), {}),
      field('Show', sel([['live', 'Active and inactive'], ['active', 'Active only'], ['inactive', 'Inactive only'], ['archived', 'Archived'], ['all', 'Everything']], f.status, { onchange: ev => { f.status = ev.target.value; f.page = 1; load(); } }))),
      h('datalist', { id: 'topic-filter' }, topicsFor().map(t => h('option', { value: t }))));
    const bar = h('div', { class: 'row', style: 'margin-bottom:.75rem' }, h('h2', { text: 'Question bank' }), h('span', { class: 'sp' }),
      canWrite ? h('button', { class: 'btn primary', onclick: () => openEditor(null), text: '+ New question' }) : null,
      h('a', { class: 'btn', href: '/api/qb/questions/export?format=xlsx', text: 'Export Excel' }), h('a', { class: 'btn', href: '/api/qb/questions/export?format=csv', text: 'Export CSV' }));
    root.append(bar, filters, h('div', { class: 'card' }, body));
    load();
    return root;
  }

  // ======================================================================= Import
  function ImportView() {
    const root = h('div');
    const out = h('div');
    let conflict = 'skip';
    const links = h('div', { class: 'row small' }, h('span', { class: 'muted', text: 'Templates:' }), ...['xlsx', 'csv', 'docx'].map(fm => h('a', { href: `/api/qb/templates/${fm}`, text: fm === 'xlsx' ? 'Excel (.xlsx)' : fm === 'csv' ? 'CSV (.csv)' : 'Word (.docx)' })));

    function pick() {
      const input = h('input', { type: 'file', accept: '.csv,.xlsx,.docx', 'aria-label': 'Choose a question file', onchange: () => input.files[0] && send(input.files[0]) });
      const dz = h('div', { class: 'dz' }, h('p', {}, h('strong', { text: 'Choose a file' }), ' or drop it here'), h('p', { class: 'muted small', text: 'Excel (.xlsx), CSV (.csv) or Word (.docx), up to 5 MB, 5,000 rows' }), input);
      dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('on'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('on'));
      dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('on'); if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); });
      return h('div', { class: 'card' }, h('h3', { text: '1. Upload a file' }),
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'If a question ID already exists' }), h('div', { class: 'row' },
          h('label', { class: 'row' }, h('input', { type: 'radio', name: 'oc', checked: true, onchange: () => { conflict = 'skip'; } }), ' Skip it'),
          h('label', { class: 'row' }, h('input', { type: 'radio', name: 'oc', onchange: () => { conflict = 'update'; } }), ' Update it with the file\'s values'))),
        dz, h('div', { style: 'margin-top:.6rem' }, links));
    }
    async function send(file) {
      NT.mount(out, h('div', { class: 'card' }, h('p', { text: 'Checking ' + file.name + '…' })));
      try { const r = await api.upload('/api/qb/import/preview' + qs({ name: file.name, on_conflict: conflict }), file); showPreview(r); }
      catch (e) { NT.mount(out, pick(), h('div', { class: 'banner bad', role: 'alert' }, e.message)); }
    }
    function chipBtn(label, n, kind, active, on) { return h('button', { class: 'chip ' + kind, style: 'border:0;cursor:pointer;' + (active ? 'outline:2px solid #1f3a5f' : ''), onclick: on, text: `${label}: ${n}` }); }
    function showPreview(r) {
      if (r.fileErrors && r.fileErrors.length) { NT.mount(out, pick(), h('div', { class: 'banner bad', role: 'alert' }, h('strong', { text: 'The file cannot be imported' }), h('ul', {}, r.fileErrors.map(m => h('li', { text: m }))))); return; }
      let current = r, filter = '';
      const tbl = h('div');
      async function reload(status, page = 1) {
        filter = status;
        try { current = await api.get(`/api/qb/import/${r.batchId}` + qs({ status: status || '', page })); } catch (e) { return NT.err(e); }
        drawRows();
      }
      function drawRows() {
        const rows = current.rows.map(x => h('tr', {},
          h('td', { 'data-label': 'Row', text: String(x.row) }), h('td', { 'data-label': 'Result' }, statusChip(x.status)),
          h('td', { 'data-label': 'Question', class: 'q' }, h('div', { text: x.preview ? (x.preview.question_text.length > 110 ? x.preview.question_text.slice(0, 110) + '…' : x.preview.question_text) : '' }), x.preview ? h('div', { class: 'muted small', text: `${x.preview.type.replace('_', ' ')} · R${x.preview.round} · ${x.preview.topic} · ${x.preview.difficulty}${x.preview.answer ? ' · answer ' + x.preview.answer : ''}` }) : null),
          h('td', { 'data-label': 'Messages' }, x.errors.map(e => h('div', { style: 'color:var(--bad)', text: (e.field && e.field !== '*' ? e.field + ': ' : '') + e.message })), x.warnings.map(w => h('div', { class: 'muted small', text: w.message })))));
        NT.mount(tbl, rows.length ? h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['Row', 'Result', 'Question', 'Messages'].map(t => h('th', { text: t })))), h('tbody', {}, rows)) : h('p', { class: 'muted', text: 'No rows in this view.' }));
      }
      const s = r.summary;
      drawRows();
      const done = h('div');
      NT.mount(out, h('div', { class: 'card' }, h('h3', { text: `2. Review “${r.fileName}”` }),
        (r.warnings || []).map(w => h('div', { class: 'banner warn', text: w })),
        s.error ? h('div', { class: 'banner warn', text: `${s.error} row(s) have problems and will NOT be imported. Fix them in your file and upload again, or continue with the valid rows.` }) : null,
        h('div', { class: 'stat' }, chipBtn('All', s.total, '', filter === '', () => reload('')), chipBtn('New', s.new, 'ok', false, () => reload('new')), chipBtn('Update', s.update, 'info', false, () => reload('update')), chipBtn('Duplicate (skipped)', s.duplicate, 'warn', false, () => reload('duplicate')), chipBtn('Errors', s.error, 'bad', false, () => reload('error')), chipBtn('Example rows', s.ignored, '', false, () => reload('ignored'))),
        h('div', { style: 'margin-top:.75rem' }, tbl),
        h('div', { class: 'row end', style: 'margin-top:1rem' },
          h('button', { class: 'btn', onclick: async () => { try { await api.post(`/api/qb/import/${r.batchId}/cancel`); } catch { /* ignore */ } NT.mount(out, pick()); }, text: 'Cancel' }),
          h('button', { class: 'btn primary', disabled: !s.importable, id: 'confirm-import', onclick: async ev => {
            ev.target.disabled = true;
            try { const res = await api.post(`/api/qb/import/${r.batchId}/commit`); await loadMeta(); NT.mount(out, h('div', { class: 'card' }, h('div', { class: 'banner ok', role: 'status' }, h('strong', { text: 'Import complete. ' }), `${res.created} added, ${res.updated} updated, ${res.skipped} skipped.`), res.skippedRows.length ? h('ul', {}, res.skippedRows.map(x => h('li', { text: `Row ${x.row}: ${x.reason}` }))) : null, h('button', { class: 'btn', onclick: () => NT.mount(out, pick()), text: 'Import another file' }))); history(); }
            catch (e) { ev.target.disabled = false; NT.err(e); }
          }, text: s.importable ? `Import ${s.importable} question${s.importable === 1 ? '' : 's'}` : 'Nothing to import' })), done));
    }
    const hist = h('div', { class: 'card' });
    async function history() {
      try { const d = await api.get('/api/qb/import'); NT.mount(hist, h('h3', { text: 'Recent imports' }), d.items.length ? h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['File', 'By', 'Status', 'Result', 'When'].map(t => h('th', { text: t })))), h('tbody', {}, d.items.map(b => h('tr', {}, h('td', { 'data-label': 'File', text: b.file_name }), h('td', { 'data-label': 'By', text: b.created_by }), h('td', { 'data-label': 'Status' }, statusChip(b.status)), h('td', { 'data-label': 'Result', text: b.result ? `${b.result.created} added, ${b.result.updated} updated, ${b.result.skipped} skipped` : `${b.summary.new + b.summary.update} ready` }), h('td', { 'data-label': 'When', text: fmtDate(b.committed_at || b.created_at) }))))) : h('p', { class: 'muted', text: 'No imports yet.' })); } catch (e) { NT.err(e); }
    }
    NT.mount(out, pick());
    root.append(h('h2', { text: 'Import questions' }), out, hist);
    history();
    return root;
  }

  // ======================================================================= Rounds
  function RoundsView(user) {
    const root = h('div');
    const isSA = user.role === 'super_admin';
    async function load() {
      let d; try { d = await api.get('/api/qb/rounds'); } catch (e) { return NT.err(e); }
      NT.mount(root, h('h2', { text: 'Rounds' }), isSA ? null : h('p', { class: 'muted', text: 'Only the Super Admin can change round settings.' }),
        h('p', { class: 'muted small', text: 'A round must be published before candidates can open its tests. Candidates are never moved between rounds automatically: use the pipeline stage as before.' }),
        d.items.map(r => card(r)));
    }
    function card(r) {
      const v = { name: r.name, description: r.description || '', enabled: r.enabled, published: r.published, duration_minutes: r.duration_minutes, pass_threshold_pct: r.pass_threshold_pct, require_stage: r.eligibility.require_stage, min_previous_pct: r.eligibility.min_previous_pct === null ? '' : r.eligibility.min_previous_pct };
      const dis = !isSA;
      return h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { text: `Round ${r.round}` }), r.published ? chip('published', 'ok') : chip('not published', 'warn'), !r.enabled ? chip('disabled', 'bad') : null, h('span', { class: 'sp' }), h('span', { class: 'muted small', text: `${r.active_questions} active questions · ${r.live_assessments} live test(s)` })),
        h('div', { class: 'grid' },
          field('Name', h('input', { type: 'text', value: v.name, disabled: dis, oninput: e => { v.name = e.target.value; } })),
          field('Duration (minutes)', h('input', { type: 'number', min: 1, max: 480, value: v.duration_minutes, disabled: dis, oninput: e => { v.duration_minutes = Number(e.target.value); } })),
          field('Pass threshold (%)', h('input', { type: 'number', min: 0, max: 100, value: v.pass_threshold_pct, disabled: dis, oninput: e => { v.pass_threshold_pct = Number(e.target.value); } })),
          field('Minimum % in previous round', h('input', { type: 'number', min: 0, max: 100, placeholder: 'No minimum', value: v.min_previous_pct, disabled: dis, oninput: e => { v.min_previous_pct = e.target.value; } }), { hint: 'Eligibility rule. Blank = none.' })),
        h('div', { class: 'row' },
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.require_stage, disabled: dis, onchange: e => { v.require_stage = e.target.checked; } }), ' Candidate must be at this round in the pipeline'),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.enabled, disabled: dis, onchange: e => { v.enabled = e.target.checked; } }), ' Enabled'),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.published, disabled: dis, onchange: e => { v.published = e.target.checked; } }), ' Published to candidates'),
          h('span', { class: 'sp' }), isSA ? h('button', { class: 'btn primary', onclick: async () => {
            try { await api.put('/api/qb/rounds/' + r.round, { name: v.name, enabled: v.enabled, published: v.published, duration_minutes: v.duration_minutes, pass_threshold_pct: v.pass_threshold_pct, eligibility: { require_stage: v.require_stage, min_previous_pct: v.min_previous_pct === '' ? null : Number(v.min_previous_pct) } }); toast('Round saved', 'ok'); await loadMeta(); load(); } catch (e) { NT.err(e); } }, text: 'Save round' }) : null));
    }
    load();
    return root;
  }

  // ======================================================================= Assessments
  function AssessmentsView(user, goResults) {
    const root = h('div');
    const canPublish = user.role === 'super_admin' || user.role === 'hr_admin';
    async function list() {
      let d; try { d = await api.get('/api/qb/assessments'); } catch (e) { return NT.err(e); }
      NT.mount(root, h('div', { class: 'row' }, h('h2', { text: 'Tests' }), h('span', { class: 'sp' }), h('button', { class: 'btn primary', onclick: () => editor(null), text: '+ New test' })),
        h('div', { class: 'card' }, d.items.length ? h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['Test', 'Round', 'Questions', 'Status', 'Assigned', 'Submitted', ''].map(t => h('th', { text: t })))),
          h('tbody', {}, d.items.map(a => h('tr', {}, h('td', { 'data-label': 'Test', text: a.title }), h('td', { 'data-label': 'Round', text: 'R' + a.round }), h('td', { 'data-label': 'Questions', text: String(a.rules.reduce((s, r) => s + r.count, 0)) }), h('td', { 'data-label': 'Status' }, statusChip(a.status === 'active' ? 'published' : a.status)), h('td', { 'data-label': 'Assigned', text: String(a.assigned) }), h('td', { 'data-label': 'Submitted', text: String(a.submitted) }), h('td', {}, h('button', { class: 'btn small', onclick: () => detail(a.id), text: 'Open' })))))) : h('p', { class: 'muted', text: 'No tests yet. Create one from the question bank.' })));
    }
    async function editor(a) {
      const v = a ? { title: a.title, round: a.round, roles: a.roles.join(', '), instructions: a.instructions || '', time_limit_minutes: a.time_limit_minutes, pass_mark_pct: a.pass_mark_pct, lock_mode: a.lock_mode, monitor_mode: a.monitor_mode, shuffle_questions: a.shuffle_questions, shuffle_options: a.shuffle_options, results_policy: a.results_policy, opens_at: a.opens_at ? a.opens_at.slice(0, 16) : '', closes_at: a.closes_at ? a.closes_at.slice(0, 16) : '', rules: a.rules.map(r => ({ ...r })) }
        : { title: '', round: 1, roles: '', instructions: '', time_limit_minutes: null, pass_mark_pct: null, lock_mode: 'strict', monitor_mode: 'off', shuffle_questions: true, shuffle_options: true, results_policy: 'hidden', opens_at: '', closes_at: '', rules: [{ topic: '', difficulty: 'any', count: 1 }] };
      let pool = [], errs = '';
      const rounds = (await api.get('/api/qb/rounds')).items;
      const area = h('div');
      const loadPool = async () => { try { pool = (await api.get('/api/qb/pool' + qs({ round: v.round, role: v.roles.split(',')[0].trim().toUpperCase() }))).cells; } catch { pool = []; } };
      const avail = r => pool.filter(c => c.topic.toLowerCase() === String(r.topic).trim().toLowerCase() && (r.difficulty === 'any' || c.difficulty === r.difficulty)).reduce((s, c) => s + c.n, 0);
      function draw() {
        const rs = rounds.find(x => x.round === Number(v.round));
        const total = v.rules.reduce((s, r) => s + (Number(r.count) || 0), 0);
        NT.mount(area, errs ? h('div', { class: 'banner bad', role: 'alert', text: errs }) : null,
          h('div', { class: 'grid' },
            field('Title', h('input', { type: 'text', maxlength: 150, value: v.title, oninput: e => { v.title = e.target.value; } })),
            field('Round', sel(ROUNDS.map(n => [n, roundLabel(n)]), v.round, { onchange: async e => { v.round = Number(e.target.value); await loadPool(); draw(); } })),
            field('Roles (blank = all)', h('input', { type: 'text', placeholder: 'SDE, DATA_ANALYST', value: v.roles, onchange: async e => { v.roles = e.target.value; await loadPool(); draw(); } }), { hint: 'Role codes, comma separated.' }),
            field('Duration (minutes)', h('input', { type: 'number', min: 1, max: 480, placeholder: rs ? String(rs.duration_minutes) : '', value: v.time_limit_minutes ?? '', oninput: e => { v.time_limit_minutes = e.target.value === '' ? null : Number(e.target.value); } }), { hint: 'Blank = round default.' }),
            field('Pass mark (%)', h('input', { type: 'number', min: 0, max: 100, placeholder: rs ? String(rs.pass_threshold_pct) : '', value: v.pass_mark_pct ?? '', oninput: e => { v.pass_mark_pct = e.target.value === '' ? null : Number(e.target.value); } })),
            field('Test lock', sel([['strict', 'Strict: block on leaving the window'], ['warn', 'Two warnings, then block'], ['off', 'Off: log only']], v.lock_mode, { onchange: e => { v.lock_mode = e.target.value; } })),
            field('Camera and microphone', sel([['off', 'Off'], ['required', 'Required: live checks, nothing recorded']], v.monitor_mode, { onchange: e => { v.monitor_mode = e.target.value; } }), { hint: 'Candidate must allow camera and mic. Video and sound are checked on their device and never saved. HR sees short alerts only.' }),
            field('Opens (optional)', h('input', { type: 'datetime-local', value: v.opens_at, oninput: e => { v.opens_at = e.target.value; } })),
            field('Closes (optional)', h('input', { type: 'datetime-local', value: v.closes_at, oninput: e => { v.closes_at = e.target.value; } }))),
          field('Instructions shown to candidates', h('textarea', { maxlength: 4000, value: v.instructions, oninput: e => { v.instructions = e.target.value; } })),
          h('div', { class: 'row' },
            h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.shuffle_questions, onchange: e => { v.shuffle_questions = e.target.checked; } }), ' Shuffle question order'),
            h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: v.shuffle_options, onchange: e => { v.shuffle_options = e.target.checked; } }), ' Shuffle answer options'),
            field('Results shown to candidates', sel([['hidden', 'Never'], ['score', 'Score only'], ['score_and_review', 'Score and answer review']], v.results_policy, { onchange: e => { v.results_policy = e.target.value; } }))),
          h('h3', { text: `Question rules (${total} question${total === 1 ? '' : 's'} per candidate)` }),
          h('p', { class: 'muted small', text: 'Each candidate gets a random draw of this many active questions for every topic and difficulty.' }),
          v.rules.map((r, i) => { const n = avail(r); return h('div', { class: 'row', style: 'align-items:flex-end' },
            field('Topic', h('input', { type: 'text', list: 'rule-topics', value: r.topic, oninput: e => { r.topic = e.target.value; }, onchange: draw })),
            field('Difficulty', sel([['any', 'Any'], 'easy', 'medium', 'hard'], r.difficulty, { onchange: e => { r.difficulty = e.target.value; draw(); } })),
            field('How many', h('input', { type: 'number', min: 1, max: 200, value: r.count, style: 'width:90px', oninput: e => { r.count = Number(e.target.value); }, onchange: draw })),
            h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'In bank' }), chip(String(n), n >= r.count ? 'ok' : 'bad')),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => { v.rules.splice(i, 1); draw(); }, text: 'Remove' })); }),
          h('datalist', { id: 'rule-topics' }, topicsFor(v.round).map(t => h('option', { value: t }))),
          h('button', { class: 'btn small', type: 'button', onclick: () => { v.rules.push({ topic: '', difficulty: 'any', count: 1 }); draw(); }, text: '+ Add rule' }));
      }
      await loadPool(); draw();
      NT.modal(a ? 'Edit test' : 'New test', area, [{ label: 'Cancel' }, { label: 'Save', kind: 'primary', close: false, run: async (ev, close) => {
        const payload = { title: v.title, round: v.round, roles: v.roles.split(',').map(s => s.trim()).filter(Boolean), instructions: v.instructions, lock_mode: v.lock_mode, monitor_mode: v.monitor_mode, shuffle_questions: v.shuffle_questions, shuffle_options: v.shuffle_options, results_policy: v.results_policy, rules: v.rules.filter(r => String(r.topic).trim()), opens_at: v.opens_at ? new Date(v.opens_at).toISOString() : null, closes_at: v.closes_at ? new Date(v.closes_at).toISOString() : null };
        if (v.time_limit_minutes) payload.time_limit_minutes = v.time_limit_minutes; if (v.pass_mark_pct !== null) payload.pass_mark_pct = v.pass_mark_pct;
        try { const saved = a ? await api.put('/api/qb/assessments/' + a.id, payload) : await api.post('/api/qb/assessments', payload); close(); toast('Saved', 'ok'); detail(saved.id); } catch (e) { errs = e.message; draw(); }
      } }]);
    }
    async function detail(id) {
      let a; try { a = await api.get('/api/qb/assessments/' + id); } catch (e) { return NT.err(e); }
      const live = a.status === 'active';
      const av = a.availability;
      NT.mount(root, h('p', {}, h('button', { class: 'btn small', onclick: list, text: '← All tests' })),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { text: a.title }), statusChip(live ? 'published' : a.status), h('span', { class: 'chip', text: `version ${a.current_version}` }), h('span', { class: 'sp' }),
          a.status !== 'archived' ? h('button', { class: 'btn', onclick: () => editor(a), text: 'Edit' }) : null,
          h('button', { class: 'btn', onclick: () => preview(a.id), text: 'Preview a paper' }),
          canPublish && a.status !== 'archived' ? h('button', { class: 'btn ' + (live ? '' : 'primary'), id: 'btn-publish', onclick: async () => { try { await api.post(`/api/qb/assessments/${a.id}/publish`, { action: live ? 'unpublish' : 'publish' }); toast(live ? 'Unpublished' : 'Published', 'ok'); detail(a.id); } catch (e) { NT.err(e); } }, text: live ? 'Unpublish' : 'Publish' }) : null),
          h('p', { class: 'muted', text: `Round ${a.round} · ${a.time_limit_minutes} min · pass ${a.pass_mark_pct}% · lock: ${a.lock_mode} · camera: ${a.monitor_mode === 'required' ? 'required' : 'off'} · roles: ${a.roles.length ? a.roles.join(', ') : 'all'} · results: ${a.results_policy.replace(/_/g, ' ')}${a.results_published_at ? ' (published)' : ''}` }),
          av && !av.ok ? h('div', { class: 'banner warn', text: 'The bank does not currently have enough active questions for every rule.' }) : null,
          h('table', {}, h('thead', {}, h('tr', {}, ['Topic', 'Difficulty', 'Per candidate', 'In bank'].map(t => h('th', { text: t })))), h('tbody', {}, a.rules.map((r, i) => { const x = av ? av.byRole[0].rules[i] : null; return h('tr', {}, h('td', { text: r.topic }), h('td', { text: r.difficulty }), h('td', { text: String(r.count) }), h('td', {}, x ? chip(String(x.available), x.ok ? 'ok' : 'bad') : '')); }))),
          av ? h('p', { class: 'muted small', text: `About ${av.estimatedMarks} marks in total.` }) : null),
        live ? assignCard(a) : h('div', { class: 'banner info', text: 'Publish the test to assign candidates. The round must also be published in Rounds.' }),
        canPublish ? resultsCard(a) : null,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => goResults(a.id), text: 'View submissions and reports' })));
    }
    function resultsCard(a) {
      let policy = a.results_policy === 'hidden' ? 'score' : a.results_policy;
      const pub = !!a.results_published_at;
      return h('div', { class: 'card' }, h('h3', { text: 'Results for candidates' }), h('p', { class: 'muted small', text: 'Candidates see results only after you publish them here. Written answers must be marked first; until then those candidates see "under review".' }),
        h('div', { class: 'row' }, sel([['score', 'Score only'], ['score_and_review', 'Score and answer review']], policy, { 'aria-label': 'What candidates see', onchange: e => { policy = e.target.value; } }),
          h('button', { class: 'btn ' + (pub ? '' : 'primary'), onclick: async () => { try { const r = await api.post(`/api/qb/assessments/${a.id}/results`, { published: !pub, results_policy: policy }); toast(pub ? 'Results hidden' : `Results published${r.pending_review ? ` (${r.pending_review} still under review)` : ''}`, 'ok'); detail(a.id); } catch (e) { NT.err(e); } }, text: pub ? 'Hide results' : 'Publish results' })));
    }
    async function preview(id) {
      try { const p = await api.get(`/api/qb/assessments/${id}/preview`); NT.modal('Sample paper (not stored)', h('div', {}, h('p', { class: 'muted small', text: p.note + ` Total ${p.totalMarks} marks.` }), p.questions.map(q => h('div', { class: 'card' }, h('div', { class: 'muted small', text: `${q.position}. ${q.topic} · ${q.difficulty} · ${q.marks} marks` }), h('p', { text: q.text }), q.options ? h('ol', { type: 'A' }, q.options.map((o, i) => h('li', { style: (q.type === 'mcq' ? q.correct === i : (q.correct || []).includes(i)) ? 'font-weight:700;color:var(--ok)' : '', text: o }))) : h('p', { class: 'muted', text: 'Written answer' })))), [{ label: 'Close' }]); } catch (e) { NT.err(e); }
    }
    function assignCard(a) {
      const box = h('div'); const state = { all: false, picked: new Set() };
      async function draw() {
        let d; try { d = await api.get('/api/candidates' + qs({ stage: state.all ? '' : 'round_' + a.round, per: 100 })); } catch (e) { return NT.err(e); }
        const items = d.items.filter(c => !a.roles.length || a.roles.includes(c.role_code));
        NT.mount(box, h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: state.all, onchange: e => { state.all = e.target.checked; draw(); } }), ` Also show candidates at other stages (they will be refused unless eligible)`),
          items.length ? h('div', {}, items.map(c => h('label', { class: 'row', style: 'padding:.2rem 0' }, h('input', { type: 'checkbox', checked: state.picked.has(c.application_id), onchange: e => { e.target.checked ? state.picked.add(c.application_id) : state.picked.delete(c.application_id); } }), ` ${c.full_name} `, h('span', { class: 'muted small', text: `${c.candidate_code || ''} · ${c.role_code || ''} · ${c.stage}` })))) : h('p', { class: 'muted', text: `No candidates at stage Round ${a.round} for this test. Move candidates into the round from the pipeline first.` }),
          h('button', { class: 'btn primary', onclick: async () => { if (!state.picked.size) return toast('Choose at least one candidate', 'bad'); try { const r = await api.post(`/api/qb/assessments/${a.id}/assign`, { application_ids: [...state.picked] }); const bad = r.results.filter(x => x.status !== 'assigned'); toast(`${r.assigned} assigned${bad.length ? `, ${bad.length} not assigned` : ''}`, bad.length ? 'bad' : 'ok'); if (bad.length) NT.modal('Not assigned', h('ul', {}, bad.map(x => h('li', { text: `${x.status.replace(/_/g, ' ')}: ${x.reason || ''}` }))), [{ label: 'OK' }]); state.picked.clear(); draw(); } catch (e) { NT.err(e); } }, text: 'Assign selected' }));
      }
      draw();
      return h('div', { class: 'card' }, h('h3', { text: 'Assign candidates' }), box);
    }
    list();
    return root;
  }

  // ======================================================================= Results
  function ResultsView(user, preset) {
    const root = h('div');
    const isStaff = user.role === 'super_admin' || user.role === 'hr_admin';
    const f = { assessment_id: preset || '', status: '', result: '', q: '', page: 1 };
    const rep = h('div'), body = h('div');
    let tests = [];
    async function loadReport() {
      if (!f.assessment_id || !isStaff) return NT.mount(rep);
      try { const r = await api.get(`/api/qb/assessments/${f.assessment_id}/report`);
        NT.mount(rep, h('div', { class: 'card' }, h('h3', { text: r.assessment.title }), h('div', { class: 'stat' }, chip(`Assigned ${r.counts.assigned}`), chip(`Not started ${r.counts.not_started}`), chip(`In progress ${r.counts.in_progress}`, 'info'), chip(`Blocked ${r.counts.blocked}`, r.counts.blocked ? 'bad' : ''), chip(`Submitted ${r.counts.submitted}`, 'ok'), chip(`Awaiting marking ${r.counts.pending_review}`, r.counts.pending_review ? 'warn' : ''), chip(`Completion ${r.completion_rate}%`)),
          r.scores ? h('p', { text: `Average ${r.scores.average_pct}% · highest ${r.scores.highest_pct}% · lowest ${r.scores.lowest_pct}% · pass rate ${r.scores.pass_rate}% (${r.scores.passed} passed, ${r.scores.failed} not)` }) : h('p', { class: 'muted', text: 'No finished results yet.' }),
          r.topics.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Topic', 'Questions asked', 'Answered', 'Correct', 'Accuracy'].map(t => h('th', { text: t })))), h('tbody', {}, r.topics.map(t => h('tr', {}, h('td', { text: t.topic }), h('td', { text: String(t.asked) }), h('td', { text: String(t.answered) }), h('td', { text: String(t.correct) }), h('td', { text: t.accuracy_pct + '%' }))))) : null)); } catch (e) { NT.err(e); }
    }
    async function load() {
      let d; try { d = await api.get('/api/qb/submissions' + qs({ ...f, per: 25 })); } catch (e) { return NT.err(e); }
      NT.mount(body, d.items.length ? h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['Candidate', 'Test', 'Status', 'Score', 'Result', 'Submitted', ''].map(t => h('th', { text: t })))), h('tbody', {}, d.items.map(s => h('tr', {},
        h('td', { 'data-label': 'Candidate' }, h('div', { text: s.full_name }), h('div', { class: 'muted small', text: `${s.candidate_code} · ${s.role_code || ''}` })),
        h('td', { 'data-label': 'Test', text: s.assessment_title }), h('td', { 'data-label': 'Status' }, statusChip(s.attempt_status), s.monitor_flags ? chip(`${s.monitor_flags} camera alert${s.monitor_flags > 1 ? 's' : ''}`, 'warn') : null, s.warnings ? chip(`${s.warnings} warning${s.warnings > 1 ? 's' : ''}`, 'warn') : null),
        h('td', { 'data-label': 'Score', text: s.final_score !== null ? `${s.final_score} / ${s.max_score} (${s.final_pct}%)` : s.attempt_status === 'submitted' ? 'pending' : '' }),
        h('td', { 'data-label': 'Result' }, s.result_status === 'final' ? statusChip(s.passed ? 'passed' : 'failed') : s.result_status ? statusChip(s.result_status) : ''),
        h('td', { 'data-label': 'Submitted', text: fmtDate(s.submitted_at) }), h('td', {}, h('button', { class: 'btn small', onclick: () => open(s.attempt_id), text: s.attempt_status === 'blocked' ? 'Review' : 'Open' })))))) : h('p', { class: 'muted', text: 'No submissions match.' }), pager(d.page, d.per, d.total, p => { f.page = p; load(); }));
    }
    async function open(id) {
      let a; try { a = await api.get('/api/qb/attempts/' + id); } catch (e) { return NT.err(e); }
      const area = h('div');
      function draw(a) {
        NT.mount(area, h('p', {}, h('strong', { text: a.full_name }), ` · ${a.assessment_title} · `, statusChip(a.attempt_status), a.result_status ? statusChip(a.result_status) : null),
          h('p', { class: 'muted small', text: `Score ${a.final_score !== null ? a.final_score + ' / ' + a.max_score : 'not final'} · submitted ${fmtDate(a.submitted_at) || 'no'} · lock warnings ${a.warnings}` + (a.paper ? ` · paper v${a.paper.assessment_version} issued ${fmtDate(a.paper.generated_at)}` : '') }),
          a.attempt_status === 'blocked' && isStaff ? h('div', { class: 'banner warn' }, h('p', { text: 'This candidate left the test window and is blocked.' }), reinstateForm(a)) : null,
          a.questions.map(q => h('div', { class: 'card' }, h('div', { class: 'muted small', text: `${q.position}. ${q.code} · ${q.topic} · ${q.difficulty} · ${q.marks} marks` }), h('p', { text: q.text }),
            q.options ? h('ol', { type: 'A' }, q.options.map((o, i) => { const mine = q.type === 'mcq' ? q.response === i : Array.isArray(q.response) && q.response.includes(i); const right = q.type === 'mcq' ? q.correct === i : (q.correct || []).includes(i); return h('li', { style: right ? 'color:var(--ok);font-weight:600' : mine ? 'color:var(--bad)' : '', text: o + (mine ? '  ← chosen' : '') + (right ? '  ✓' : '') }); }))
              : h('div', {}, h('div', { class: 'muted small', text: 'Candidate answer' }), h('p', { style: 'white-space:pre-wrap;border-left:3px solid var(--line);padding-left:.6rem', text: q.response || '(no answer)' }), q.reference_answer ? h('p', { class: 'muted small', text: 'Marking notes: ' + q.reference_answer }) : null, markForm(a, q)),
            q.options ? h('div', { class: 'muted small', text: q.auto_marks !== null ? `Marks: ${q.auto_marks}` : 'Not answered: 0' }) : null)),
          h('h3', { text: 'Timeline' }), h('ul', { class: 'small' }, a.events.map(e => h('li', { text: `${fmtDate(e.created_at)} · ${e.kind}${e.detail ? ' · ' + e.detail : ''}` }))));
      }
      function reinstateForm(a) { const r = h('input', { type: 'text', placeholder: 'Reason (required)', maxlength: 500, 'aria-label': 'Reason for reinstating' }); return h('div', { class: 'row' }, r, h('button', { class: 'btn primary', onclick: async () => { try { await api.post(`/api/qb/attempts/${a.attempt_id}/reinstate`, { reason: r.value }); toast('Reinstated: the candidate can resume', 'ok'); draw(await api.get('/api/qb/attempts/' + id)); load(); } catch (e) { NT.err(e); } }, text: 'Reinstate' })); }
      function markForm(a, q) {
        if (a.attempt_status !== 'submitted') return null;
        const m = h('input', { type: 'number', min: 0, max: q.marks, step: '0.25', value: q.manual_marks ?? '', style: 'width:110px', 'aria-label': 'Marks awarded' }), c = h('input', { type: 'text', placeholder: 'Comment (optional)', value: q.review_comment || '', maxlength: 1000 });
        return h('div', { class: 'row' }, h('span', { class: 'small', text: `Marks (0–${q.marks})` }), m, c, h('button', { class: 'btn small primary', onclick: async () => { try { const r = await api.put(`/api/qb/attempts/${a.attempt_id}/review/${q.id}`, { marks: m.value, comment: c.value }); toast(r.result_status === 'final' ? `Marked. Final score ${r.score}/${r.max}` : 'Marked', 'ok'); draw(await api.get('/api/qb/attempts/' + id)); load(); } catch (e) { NT.err(e); } }, text: 'Save marks' }));
      }
      draw(a);
      NT.modal('Attempt', area, [{ label: 'Close' }]);
    }
    async function init() {
      if (isStaff) { try { tests = (await api.get('/api/qb/assessments')).items; } catch { tests = []; } }
      const sel1 = sel([['', 'All tests'], ...tests.map(t => [t.id, `${t.title} (R${t.round})`])], f.assessment_id, { 'aria-label': 'Test', onchange: e => { f.assessment_id = e.target.value; f.page = 1; loadReport(); load(); } });
      const exp = () => '/api/qb/submissions/export' + qs({ assessment_id: f.assessment_id, status: f.status, result: f.result, q: f.q, format: 'xlsx' });
      NT.mount(root, h('div', { class: 'row' }, h('h2', { text: isStaff ? 'Results' : 'Answers to mark' }), h('span', { class: 'sp' }), isStaff ? [h('a', { class: 'btn', href: '#', onclick: e => { e.currentTarget.href = exp(); }, text: 'Export Excel' }), h('a', { class: 'btn', href: '#', onclick: e => { e.currentTarget.href = exp().replace('xlsx', 'csv'); }, text: 'Export CSV' })] : null),
        h('div', { class: 'card' }, h('div', { class: 'grid' }, isStaff ? field('Test', sel1) : null,
          field('Attempt status', sel([['', 'Any'], ['ready', 'Not started'], ['in_progress', 'In progress'], ['blocked', 'Blocked'], ['submitted', 'Submitted']], f.status, { onchange: e => { f.status = e.target.value; f.page = 1; load(); } })),
          field('Result', sel([['', 'Any'], ['passed', 'Passed'], ['failed', 'Not passed'], ['pending_review', 'Awaiting marking']], f.result, { onchange: e => { f.result = e.target.value; f.page = 1; load(); } })),
          field('Candidate', h('input', { type: 'search', placeholder: 'Name, e-mail or ID', oninput: NT.debounce(e => { f.q = e.target.value; f.page = 1; load(); }, 300) })))),
        rep, h('div', { class: 'card' }, body));
      loadReport(); load();
    }
    init();
    return root;
  }

  // ======================================================================= Audit
  function AuditView() {
    const root = h('div'); let page = 1;
    async function load() {
      let d; try { d = await api.get('/api/qb/audit' + qs({ page })); } catch (e) { return NT.err(e); }
      NT.mount(root, h('h2', { text: 'Change history' }), h('div', { class: 'card' }, h('table', { class: 'cards' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Item', 'Details'].map(t => h('th', { text: t })))), h('tbody', {}, d.items.map(l => h('tr', {}, h('td', { 'data-label': 'When', text: fmtDate(l.created_at) }), h('td', { 'data-label': 'Who', text: l.actor || 'system' }), h('td', { 'data-label': 'Action', class: 'mono small', text: l.action }), h('td', { 'data-label': 'Item', class: 'mono small', text: `${l.entity_type} ${String(l.entity_id).slice(0, 18)}` }), h('td', { 'data-label': 'Details', class: 'small muted', text: l.after ? JSON.stringify(l.after).slice(0, 140) : '' }))))),
        h('div', { class: 'pager' }, h('button', { class: 'btn small', disabled: page <= 1, onclick: () => { page--; load(); }, text: 'Newer' }), h('button', { class: 'btn small', disabled: d.items.length < 50, onclick: () => { page++; load(); }, text: 'Older' }))));
    }
    load();
    return root;
  }

  // ======================================================================= shell
  NT.admin = async function (root, user) {
    const staff = user.role === 'super_admin' || user.role === 'hr_admin';
    if (staff) { try { await loadMeta(); } catch (e) { NT.err(e); } }
    const tabs = staff ? [['bank', 'Question bank', () => QuestionBank(user)], ['import', 'Import', () => ImportView()], ['rounds', 'Rounds', () => RoundsView(user)], ['tests', 'Tests', () => AssessmentsView(user, id => select('results', id))], ['results', 'Results', p => ResultsView(user, p)], ['audit', 'History', () => AuditView()]] : [['results', 'Answers to mark', p => ResultsView(user, p)]];
    const view = h('main', { id: 'view' });
    const bar = h('nav', { class: 'tabs', role: 'tablist' });
    function select(key, arg) {
      const t = tabs.find(x => x[0] === key);
      [...bar.children].forEach(b => b.setAttribute('aria-selected', String(b.dataset.key === key)));
      NT.mount(view, t[2](arg));
      NT.safeStore.set('nt_tab', key);
    }
    tabs.forEach(([k, label]) => bar.append(h('button', { role: 'tab', 'data-key': k, 'aria-selected': 'false', onclick: () => select(k), text: label })));
    NT.mount(root, bar, view);
    select(tabs.some(t => t[0] === NT.safeStore.get('nt_tab')) ? NT.safeStore.get('nt_tab') : tabs[0][0]);
  };
})();
