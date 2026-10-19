'use strict';
// Candidate portal: current test, instructions, the test itself (timer, navigation, autosave, lock), submission and result.
(function () {
  const { h, api, toast, chip, fmtDate } = NT;
  const LET = 'ABCDEFGH';
  let teardown = null;                       // stops timers and listeners of a running test

  NT.candidate = async function (root, user) {
    const view = h('main', { id: 'view' });
    NT.mount(root, view);
    home();

    async function home() {
      if (teardown) { teardown(); teardown = null; }
      let d; try { d = await api.get('/api/qb/my/assessments'); } catch (e) { return NT.mount(view, h('div', { class: 'banner bad', text: e.message })); }
      const card = t => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('h3', { text: t.title }), h('div', { class: 'muted small', text: `${t.round_name} · ${t.duration_minutes} minutes` })), h('span', { class: 'sp' }),
        t.state === 'available' ? h('button', { class: 'btn primary', onclick: () => open(t.attempt_id), text: 'Open' })
          : t.state === 'in_progress' ? [chip('in progress', 'info'), h('button', { class: 'btn primary', onclick: () => open(t.attempt_id), text: 'Resume' })]
          : t.state === 'blocked' ? [chip('paused', 'bad'), h('button', { class: 'btn', onclick: () => open(t.attempt_id), text: 'See status' })]
          : chip('scheduled', 'warn')), t.message ? h('p', { class: 'muted small', text: t.message }) : null);
      NT.mount(view, h('h1', { text: `Welcome, ${user.full_name.split(' ')[0]}` }),
        h('h2', { text: 'Your assessments' }), d.current.length ? d.current.map(card) : h('div', { class: 'card' }, h('p', { class: 'muted', text: 'Nothing is open for you right now. When the hiring team opens your next assessment it will appear here.' })),
        d.completed.length ? h('h2', { text: 'Completed' }) : null,
        d.completed.map(t => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', {}, h('h3', { text: t.title }), h('div', { class: 'muted small', text: `${t.round_name} · submitted ${fmtDate(t.submitted_at)}` })), h('span', { class: 'sp' }),
          t.result === 'available' ? h('button', { class: 'btn', onclick: () => showResult(t.attempt_id), text: 'View result' }) : chip(t.result === 'under_review' ? 'result under review' : 'result not published yet', 'warn')))));
    }

    async function open(id) {
      let i; try { i = await api.get('/api/qb/my/attempts/' + id); } catch (e) { toast(e.message, 'bad'); return home(); }
      if (i.status === 'submitted') return showResult(id);
      if (i.status === 'blocked') return blocked(i);
      if (i.status === 'in_progress') return begin(id);
      let agreed = false;
      const btn = h('button', { class: 'btn primary', id: 'start-test', disabled: true, onclick: () => begin(id, i), text: 'Start the test' });
      NT.mount(view, h('p', {}, h('button', { class: 'btn small', onclick: home, text: '← Back' })),
        h('div', { class: 'card' }, h('h1', { text: i.title }),
          h('div', { class: 'stat' }, chip(`${i.duration_minutes} minutes`), chip(`${i.questions} questions`), chip(i.round_name || `Round ${i.round}`)),
          i.instructions ? h('p', { style: 'white-space:pre-wrap', text: i.instructions }) : null,
          h('h3', { text: 'Before you start' }),
          h('ul', {}, h('li', { text: 'Your answers are saved automatically. If your connection drops or you refresh, you continue where you left off.' }),
            h('li', { text: 'The timer runs on our server. Closing the page does not pause it.' }),
            h('li', { text: i.lock_mode === 'off' ? 'Leaving this page is recorded.' : i.lock_mode === 'warn' ? `Do not switch to another tab or app. After ${i.max_warnings} warnings your test is paused and the hiring team must review it.` : 'Do not switch to another tab or app. If you do, your test is paused immediately and the hiring team must review it.' }),
            h('li', { text: 'Some questions may lose marks for a wrong answer. Unanswered questions score zero.' }),
            h('li', { text: 'Each candidate gets a different set of questions in a different order.' })),
          i.monitor_mode === 'required' ? h('div', { class: 'consent' }, h('strong', { text: 'Camera and microphone checks' }),
            h('ul', {}, h('li', { text: 'This test needs your camera and microphone. Your browser will ask for permission when you start.' }),
              h('li', { text: 'Nothing is recorded or saved. Your video and sound are checked on your own device only.' }),
              h('li', { text: 'Only short alerts are sent to the hiring team, for example "no face seen" or "loud noise". People review alerts; they do not fail anyone automatically.' }),
              h('li', { text: 'Sit in a well-lit place, alone, with your face visible. Switching the camera or microphone off pauses the test.' }))) : null,
          i.can_start ? [h('label', { class: 'row' }, h('input', { type: 'checkbox', id: 'agree', onchange: e => { agreed = e.target.checked; btn.disabled = !agreed; } }), ' I have read and understood these instructions.'), h('div', { style: 'margin-top:1rem' }, btn)]
            : h('div', { class: 'banner warn', text: i.message || 'This assessment cannot be started now.' })));
    }

    function blocked(i) {
      let timer, asked = i.review_requested;
      const msg = h('div');
      function draw(st) {
        NT.mount(view, h('div', { class: 'card' }, h('h1', { text: 'Your test is paused' }),
          st === 'ready' ? h('div', { class: 'banner ok', role: 'status' }, h('strong', { text: 'The hiring team has reinstated your test. ' }), 'Your time and answers have been kept.') :
            h('div', { class: 'banner bad' }, 'You left the test window, so the test was paused. Your saved answers and the time you had left are kept. The hiring team must review this before you can continue.'),
          st === 'ready' ? h('button', { class: 'btn primary', onclick: () => begin(i.attempt_id), text: 'Resume the test' }) : h('div', { class: 'row' },
            h('button', { class: 'btn', disabled: asked, onclick: async e => { try { await api.post(`/api/qb/my/attempts/${i.attempt_id}/request-review`); asked = true; e.target.disabled = true; e.target.textContent = 'Review requested'; toast('Review requested', 'ok'); } catch (er) { NT.err(er); } }, text: asked ? 'Review requested' : 'Ask for a review' }),
            h('button', { class: 'btn', onclick: home, text: 'Back' })), msg));
      }
      draw('blocked');
      timer = setInterval(async () => { try { const n = await api.get('/api/qb/my/attempts/' + i.attempt_id); if (n.status === 'ready') { clearInterval(timer); draw('ready'); } else if (n.status === 'submitted') { clearInterval(timer); showResult(i.attempt_id); } } catch { /* keep polling */ } }, 10000);
      teardown = () => clearInterval(timer);
    }

    function cameraNeeded(id, msg) {
      NT.mount(view, h('div', { class: 'card' }, h('h1', { text: 'Camera and microphone needed' }), h('div', { class: 'banner bad', role: 'alert', text: msg }),
        h('p', { class: 'muted', text: 'This test cannot start without them. If you had already started, your timer keeps running, so fix this quickly.' }),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => begin(id), text: 'Try again' }), h('button', { class: 'btn', onclick: home, text: 'Back' }))));
    }
    async function begin(id, known) {
      let mon = null;
      try {
        const i = known || await api.get('/api/qb/my/attempts/' + id);
        if (i.monitor_mode === 'required' && (i.status === 'ready' || i.status === 'in_progress')) mon = await NT.monitor.request();
      } catch (e) { if (!(e instanceof NT.ApiError)) return cameraNeeded(id, e.message); }
      const stopMon = () => { if (mon) mon.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } }); };
      let p; try { p = await api.post(`/api/qb/my/attempts/${id}/start`); } catch (e) {
        stopMon();
        if (e.code === 'blocked') { try { return blocked(await api.get('/api/qb/my/attempts/' + id)); } catch { /* fall through */ } }
        if (e.code === 'already_submitted' || e.code === 'time_expired') { toast(e.message, e.code === 'time_expired' ? 'bad' : ''); return showResult(id); }
        toast(e.message, 'bad'); return home();
      }
      if (p.attempt.monitor_mode === 'required' && !mon) { try { mon = await NT.monitor.request(); } catch (e) { return cameraNeeded(id, e.message); } }
      runTest(id, p, mon);
    }

    function runTest(id, p, mon) {
      const Q = p.questions; const A = {}; const flags = new Set();
      for (const [qid, a] of Object.entries(p.answers || {})) A[qid] = { response: a.response, rev: a.rev };
      const qKey = 'nt_pending_' + id;
      const queue = new Map();
      try { const saved = JSON.parse(NT.safeStore.get(qKey) || '{}'); for (const [qid, it] of Object.entries(saved)) if (Q.some(q => q.id === qid) && (!A[qid] || it.rev > A[qid].rev)) { A[qid] = { response: it.response, rev: it.rev }; queue.set(qid, it); } } catch { /* ignore a damaged backup */ }
      const persist = () => NT.safeStore.set(qKey, JSON.stringify(Object.fromEntries(queue)));
      let idx = 0, deadline = performance.now() + p.attempt.remaining_ms, busy = false, finished = false, saving = false, retry = 0, retryTimer = null, lastViolation = 0, warnings = p.attempt.warnings, status = 'Saved';
      const maxWarn = p.attempt.max_warnings;
      const timerEl = h('span', { class: 'timer', role: 'timer', 'aria-label': 'Time left' }), saveEl = h('span', { class: 'save', role: 'status' }), progEl = h('span', {}), bar = h('i'), banner = h('div'), main = h('div'), nav = h('div', { class: 'nav' });
      const answered = q => { const a = A[q.id]; return a && a.response !== null && a.response !== undefined && a.response !== '' && !(Array.isArray(a.response) && !a.response.length) && !(typeof a.response === 'string' && !a.response.trim()); };
      const count = () => Q.filter(answered).length;

      function setSave(t) { status = t; saveEl.textContent = t; }
      function updateHeader() { const n = count(); progEl.textContent = `${n} of ${Q.length} answered`; bar.style.width = (Q.length ? n / Q.length * 100 : 0) + '%'; }
      function drawNav() { NT.mount(nav, Q.map((q, i) => h('button', { type: 'button', class: (answered(q) ? 'done ' : '') + (i === idx ? 'cur ' : '') + (flags.has(q.id) ? 'flag' : ''), 'aria-label': `Question ${i + 1}${answered(q) ? ', answered' : ''}${flags.has(q.id) ? ', marked for review' : ''}`, 'aria-current': i === idx ? 'true' : null, onclick: () => go(i), text: String(i + 1) }))); }
      const go = i => { idx = Math.max(0, Math.min(Q.length - 1, i)); drawQ(); drawNav(); window.scrollTo({ top: 0 }); };

      function change(q, response, delay) {
        const rev = ((A[q.id] && A[q.id].rev) || 0) + 1;
        A[q.id] = { response, rev };
        queue.set(q.id, { response, rev }); persist(); setSave('Saving…'); updateHeader(); drawNav();
        clearTimeout(change.t); change.t = setTimeout(flush, delay);
      }
      async function flush() {
        if (saving || finished || !queue.size) return;
        saving = true; clearTimeout(retryTimer);
        const batch = [...queue.entries()].slice(0, 20).map(([qid, it]) => ({ id: qid, rev: it.rev, response: it.response }));
        try {
          const r = await api.put(`/api/qb/my/attempts/${id}/responses`, { items: batch });
          for (const s of r.saved) { const cur = queue.get(s.id); if (cur && cur.rev <= s.rev) queue.delete(s.id); }
          persist(); retry = 0; setSave(queue.size ? 'Saving…' : 'All answers saved');
          saving = false; if (queue.size) flush();
        } catch (e) {
          saving = false;
          if (e.code === 'blocked') return toBlocked();
          if (e.code === 'time_expired' || e.code === 'already_submitted') { finished = true; cleanup(); return showResult(id, true); }
          if (e.status === 400 || e.status === 404) { batch.forEach(b => queue.delete(b.id)); persist(); setSave('Some answers were rejected'); toast(e.message, 'bad'); return; }
          setSave('Offline: your answers are kept and will be saved when you reconnect');
          retry = Math.min(retry + 1, 5); retryTimer = setTimeout(flush, Math.min(30000, 1000 * 2 ** retry));
        }
      }
      async function flushAll() { for (let n = 0; n < 40 && queue.size; n++) { await flush(); await new Promise(r => setTimeout(r, saving ? 150 : 0)); if (retry) break; } return !queue.size; }

      function drawQ() {
        const q = Q[idx]; const a = A[q.id] ? A[q.id].response : null;
        let input;
        if (q.type === 'descriptive') {
          const ta = h('textarea', { 'aria-label': 'Your answer', maxlength: 10000, style: 'min-height:220px;width:100%', value: a || '', oninput: e => change(q, e.target.value, 700) });
          input = h('div', { class: 'field' }, ta, h('div', { class: 'hint', text: 'Write your answer. It is saved as you type.' }));
        } else {
          const multi = q.type === 'multi_select';
          input = h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'muted small', text: multi ? 'Select all that apply' : 'Select one answer' }),
            q.options.map((o, i) => { const on = multi ? Array.isArray(a) && a.includes(i) : a === i; const inp = h('input', { type: multi ? 'checkbox' : 'radio', name: 'opt', checked: on, onchange: () => { if (multi) { const s = new Set(Array.isArray(A[q.id] && A[q.id].response) ? A[q.id].response : []); s.has(i) ? s.delete(i) : s.add(i); change(q, s.size ? [...s].sort((x, y) => x - y) : null, 0); } else change(q, i, 0); drawQ(); } });
              return h('label', { class: 'opt' + (on ? ' sel' : '') }, inp, h('span', {}, h('strong', { text: LET[i] + '. ' }), o)); }),
            !multi && a !== null && a !== undefined ? h('button', { class: 'btn small', type: 'button', onclick: () => { change(q, null, 0); drawQ(); }, text: 'Clear my answer' }) : null);
        }
        NT.mount(main, h('div', { class: 'card', id: 'qpanel' }, h('div', { class: 'row' }, h('span', { class: 'muted small', text: `Question ${idx + 1} of ${Q.length}` }), chip(`${q.marks} mark${q.marks === 1 ? '' : 's'}`), q.negativeMarks ? chip(`−${q.negativeMarks} if wrong`, 'warn') : null, h('span', { class: 'sp' }),
          h('button', { class: 'btn small', type: 'button', onclick: () => { flags.has(q.id) ? flags.delete(q.id) : flags.add(q.id); drawQ(); drawNav(); }, text: flags.has(q.id) ? 'Unmark review' : 'Mark for review' })),
          h('p', { style: 'font-size:1.05rem;white-space:pre-wrap;margin:.8rem 0', text: q.text }), input),
          h('div', { class: 'row' }, h('button', { class: 'btn', disabled: idx === 0, onclick: () => go(idx - 1), text: '← Previous' }), h('span', { class: 'sp' }), idx < Q.length - 1 ? h('button', { class: 'btn primary', onclick: () => go(idx + 1), text: 'Next →' }) : h('button', { class: 'btn primary', onclick: submitFlow, text: 'Review and submit' })));
      }

      async function submitFlow() {
        if (busy || finished) return;
        const un = Q.length - count(), fl = flags.size;
        const ok = await NT.confirm('Submit your answers?', `${count()} of ${Q.length} answered${un ? `, ${un} not answered` : ''}${fl ? `, ${fl} marked for review` : ''}. You cannot change your answers after submitting.`, 'Submit now');
        if (ok) doSubmit(false);
      }
      async function doSubmit(auto) {
        if (busy || finished) return; busy = true;
        setSave('Submitting…');
        await flushAll();
        try {
          const r = await api.post(`/api/qb/my/attempts/${id}/submit`, { ref: `${id}-${Date.now()}` });
          finished = true; cleanup(); NT.safeStore.del(qKey); confirmation(r, auto);
        } catch (e) {
          busy = false;
          if (e.code === 'blocked') return toBlocked();
          setSave('Not submitted'); toast(e.message + ' Your answers are safe: try again.', 'bad');
        }
      }
      function toBlocked() { finished = true; cleanup(); api.get('/api/qb/my/attempts/' + id).then(blocked).catch(() => home()); }

      // ---- test lock: leaving the window is reported; the server decides whether it blocks
      async function violation(why) {
        if (finished || busy) return; const now = Date.now(); if (now - lastViolation < 2000) return; lastViolation = now;
        try {
          const r = await api.post(`/api/qb/my/attempts/${id}/events`, { kind: 'violation', detail: why });
          if (r.action === 'block') { toBlocked(); }
          else if (r.action === 'warn') { warnings = r.warnings; NT.mount(banner, h('div', { class: 'banner warn', role: 'alert' }, h('strong', { text: `Warning ${r.warnings} of ${r.max_warnings}. ` }), 'You left the test window. One more time and your test will be paused.')); }
        } catch { /* offline: the server also enforces the deadline; nothing to do */ }
      }
      let monCtl = null;
      async function monitorAlert(code) {
        if (finished || busy) return;
        try {
          const r = await api.post(`/api/qb/my/attempts/${id}/events`, { kind: 'monitor', code });
          if (r.action === 'block') toBlocked();
          else if (r.action === 'warn') { warnings = r.warnings; NT.mount(banner, h('div', { class: 'banner warn', role: 'alert' }, h('strong', { text: `Warning ${r.warnings} of ${r.max_warnings}. ` }), 'Your camera or microphone was switched off. Turn it back on. One more time and your test will be paused.')); }
        } catch { /* offline: the alert is lost, the deadline is still enforced by the server */ }
      }
      if (mon) monCtl = NT.monitor.run(mon, monitorAlert, document.body);
      const onVis = () => { if (document.hidden && !leaving) violation('Switched tab or minimised the window'); };
      const onBlur = () => { if (!leaving && (!document.hasFocus() || document.hidden)) violation('Window lost focus'); };
      let leaving = false, leaveT;
      const onBefore = e => { if (!finished) { leaving = true; clearTimeout(leaveT); leaveT = setTimeout(() => { leaving = false; }, 3000); e.preventDefault(); e.returnValue = ''; } };
      const onOnline = () => { retry = 0; flush(); };
      const noCopy = e => { if (e.target.closest && e.target.closest('#qpanel') && e.target.tagName !== 'TEXTAREA') e.preventDefault(); };
      document.addEventListener('visibilitychange', onVis); window.addEventListener('blur', onBlur); window.addEventListener('beforeunload', onBefore); window.addEventListener('online', onOnline);
      document.addEventListener('copy', noCopy); document.addEventListener('contextmenu', noCopy);

      // ---- clock: the server's remaining time, re-read every minute
      const tick = setInterval(() => {
        const left = Math.max(0, deadline - performance.now());
        const s = Math.ceil(left / 1000), hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
        timerEl.textContent = (hh ? hh + ':' + String(mm).padStart(2, '0') : String(mm)) + ':' + String(ss).padStart(2, '0');
        timerEl.classList.toggle('low', left < 5 * 60000);
        if (left <= 0 && !finished && !busy) { toast('Time is up: submitting your answers', 'bad'); doSubmit(true); }
      }, 500);
      const resync = setInterval(async () => { if (finished || busy) return; try { const n = await api.get(`/api/qb/my/attempts/${id}/paper`); if (n.attempt.status === 'in_progress') deadline = performance.now() + n.attempt.remaining_ms; else if (n.attempt.status === 'blocked') toBlocked(); else if (n.attempt.status === 'submitted') { finished = true; cleanup(); showResult(id, true); } } catch { /* offline */ } }, 60000);
      function cleanup() { if (monCtl) { monCtl.stop(); monCtl = null; } clearInterval(tick); clearInterval(resync); clearTimeout(retryTimer); clearTimeout(change.t); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', onBlur); window.removeEventListener('beforeunload', onBefore); window.removeEventListener('online', onOnline); document.removeEventListener('copy', noCopy); document.removeEventListener('contextmenu', noCopy); }
      teardown = cleanup;

      NT.mount(view, h('div', { class: 'teststrip' }, h('strong', { text: p.assessment.title }), h('span', { class: 'sp' }), progEl, saveEl, timerEl),
        h('div', { class: 'progress', 'aria-hidden': 'true' }, bar), banner,
        h('div', { class: 'test', style: 'margin-top:1rem' }, main, h('aside', {}, h('div', { class: 'card' }, h('h3', { text: 'Questions' }), nav, h('p', { class: 'muted small', text: 'Green = answered. Orange bar = marked for review.' }), h('button', { class: 'btn primary', style: 'width:100%', onclick: submitFlow, text: 'Submit' })))));
      try { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {}); } catch { /* optional */ }
      setSave(queue.size ? 'Saving…' : 'All answers saved'); updateHeader(); drawQ(); drawNav();
      if (queue.size) flush();
    }

    function confirmation(r, auto) {
      NT.mount(view, h('div', { class: 'card' }, h('h1', { text: auto ? 'Time is up: your answers were submitted' : 'Submitted' }),
        h('div', { class: 'banner ok', role: 'status', text: `${r.message} You answered ${r.answered} of ${r.total} questions.` }),
        r.result && r.result.visible ? resultCard(r.result) : h('p', { class: 'muted', text: (r.result && r.result.message) || 'The hiring team will share the next steps.' }),
        h('button', { class: 'btn primary', onclick: home, text: 'Back to my assessments' })));
    }
    function resultCard(r) {
      return h('div', {}, h('h2', { text: r.passed ? 'You passed' : 'Not passed this time' }), h('p', {}, `Score ${r.score} of ${r.max} (${r.percent}%). Pass mark ${r.pass_mark_percent}%.`),
        r.review ? h('div', {}, h('h3', { text: 'Your answers' }), r.review.map(q => h('div', { class: 'card' }, h('div', { class: 'muted small', text: `Question ${q.position} · ${q.marks_awarded} of ${q.marks} marks · ${q.outcome.replace(/_/g, ' ')}` }), h('p', { text: q.text }),
          q.options ? h('ol', { type: 'A' }, q.options.map((o, i) => { const mine = q.type === 'mcq' ? q.your_answer === i : Array.isArray(q.your_answer) && q.your_answer.includes(i); const right = q.type === 'mcq' ? q.correct_answer === i : (q.correct_answer || []).includes(i); return h('li', { style: right ? 'color:var(--ok);font-weight:600' : mine ? 'color:var(--bad)' : '', text: o + (mine ? '  ← your answer' : '') + (right ? '  ✓' : '') }); })) : h('p', { style: 'white-space:pre-wrap', text: q.your_answer || '(no answer)' }),
          q.explanation ? h('p', { class: 'muted small', text: 'Explanation: ' + q.explanation }) : null))) : null);
    }
    async function showResult(id, expired) {
      if (teardown) { teardown(); teardown = null; }
      try { const r = await api.get(`/api/qb/my/attempts/${id}/result`); NT.mount(view, h('p', {}, h('button', { class: 'btn small', onclick: home, text: '← My assessments' })), h('div', { class: 'card' }, h('h1', { text: 'Result' }), expired ? h('div', { class: 'banner info', text: 'Your answers were submitted.' }) : null, r.visible ? resultCard(r) : h('p', { class: 'muted', text: r.message || 'Results are not available yet.' }))); }
      catch (e) { toast(e.message, 'bad'); home(); }
    }
  };
})();
