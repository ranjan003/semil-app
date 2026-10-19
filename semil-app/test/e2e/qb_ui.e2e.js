'use strict';
// Browser test of the real web app against real PostgreSQL (needs Playwright + Chromium; not part of `npm test`).
//   node test/e2e/qb_ui.e2e.js            screenshots go to $SHOTS or ./e2e-shots
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const env = require('../helpers/testenv');
const { createHarness } = require('../helpers/harness');
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const SHOTS = process.env.SHOTS || path.join(process.cwd(), 'e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const L = 'ABCD';

function bankCsv() {
  const head = 'question_id,question_text,question_type,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,job_role,round,topic,marks,negative_marks,status';
  const rows = []; let n = 0;
  for (const topic of ['Aptitude', 'Logic']) for (const d of ['easy', 'medium', 'hard']) for (let i = 1; i <= 4; i++) { n++; const a = L[n % 4]; rows.push(`,"${topic} ${d} question ${i}: pick the right option",mcq,Alpha ${n},Bravo ${n},Charlie ${n},Delta ${n},${a},"Because ${a} is right",${d},ALL,1,${topic},2,0.5,active`); }
  for (let i = 1; i <= 3; i++) rows.push(`,"Written question ${i}: describe your approach",descriptive,,,,,"Look for structure",,easy,ALL,1,Written,5,,active`);
  rows.push(',"Bad row with no answer",mcq,x,y,,,,,easy,ALL,1,Aptitude,1,0,');
  return head + '\r\n' + rows.join('\r\n') + '\r\n';
}

(async () => {
  const db = env.createDb('qb_e2e'); const hx = createHarness(db);
  const hr = await env.addUser(db, 'hr_admin', 'Hannah HR'), sa = await env.addUser(db, 'super_admin', 'Sam Super');
  const vac = await env.addVacancy(db, 'SDE');
  const cA = await env.addCandidate(db, vac, { name: 'Asha Candidate' }), cB = await env.addCandidate(db, vac, { name: 'Bala Candidate' });
  [hr, sa, cA.user, cB.user].forEach(hx.registerUser);
  const { server, port } = await hx.serve(0);
  const base = `http://127.0.0.1:${port}`;
  const csvPath = path.join(SHOTS, 'bank.csv'); fs.writeFileSync(csvPath, bankCsv());
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const errors = [];
  const watch = (page, who) => { page.on('pageerror', e => errors.push(`${who} pageerror: ${e.message}`)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${who} console: ${m.text()}`); }); };
  const login = async (page, user) => { await page.goto(base + '/'); await page.fill('#email', user.email); await page.fill('#password', 'whatever'); await page.click('button[type=submit]'); };
  const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
  const step = name => console.log('  ✓ ' + name);

  try {
    // ---------------- HR: import
    const hrCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const p = await hrCtx.newPage(); watch(p, 'hr');
    await login(p, hr);
    await p.waitForSelector('text=Question bank'); step('HR signs in');
    await p.click('[role=tab]:has-text("Import")');
    await p.setInputFiles('input[type=file]', csvPath);
    await p.waitForSelector('text=Review “bank.csv”');
    assert.ok(await p.locator('text=Errors: 1').count(), 'error count shown');
    assert.ok(await p.locator('text=Correct answer is required').count(), 'row error message shown');
    await shot(p, '01-import-preview');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM question_bank')).rows[0].n, 0, 'nothing saved at preview');
    await p.click('#confirm-import'); await p.waitForSelector('text=Import complete');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM question_bank')).rows[0].n, 27); step('preview, errors, confirm: 27 questions saved');

    // ---------------- HR: browse, search, create
    await p.click('[role=tab]:has-text("Question bank")');
    await p.waitForSelector('table tbody tr');
    await p.fill('input[type=search]', 'Written question 2'); await p.waitForTimeout(600);
    assert.equal(await p.locator('table tbody tr').count(), 1, 'search narrows the list');
    await p.fill('input[type=search]', ''); await p.waitForTimeout(500);
    await p.click('text=+ New question');
    await p.fill('.modal textarea >> nth=0', 'Which protocol resolves names to IP addresses?');
    const optIn = l => p.locator(`.modal .field:has-text("Option ${l}") input[type=text]`).first();
    await p.fill('.modal input[list="topic-list"]', 'Networks');
    await optIn("A").fill("HTTP"); await optIn("B").fill("DNS");
    await p.click('.modal input[type=radio] >> nth=1');
    await p.click('.modal button:has-text("Create question")');
    await p.waitForSelector('.toast:has-text("Question created")'); step('new question created through the form');
    await p.click('text=+ New question'); await p.click('.modal button:has-text("Create question")');
    await p.waitForSelector('.modal .banner.bad'); await p.click('.modal button:has-text("Cancel")'); step('invalid form shows field errors');
    await shot(p, '02-question-bank');

    // ---------------- SA: publish round 1
    const saCtx = await browser.newContext({ viewport: { width: 1280, height: 860 } }); const ps = await saCtx.newPage(); watch(ps, 'sa');
    await login(ps, sa); await ps.click('[role=tab]:has-text("Rounds")');
    const r1 = ps.locator('.card:has(h3:text-is("Round 1"))');
    await r1.locator('label:has-text("Published to candidates") input').check(); await r1.locator('button:has-text("Save round")').click();
    await ps.waitForSelector('.toast:has-text("Round saved")'); step('Super Admin publishes round 1');
    // HR sees rounds read-only
    await p.click('[role=tab]:has-text("Rounds")'); await p.waitForSelector('text=Only the Super Admin can change round settings');
    assert.equal(await p.locator('button:has-text("Save round")').count(), 0); step('HR cannot edit rounds');

    // ---------------- HR: build, publish and assign a test
    await p.click('[role=tab]:has-text("Tests")'); await p.click('text=+ New test');
    await p.fill('.modal input[type=text] >> nth=0', 'Round 1 Aptitude Check');
    const rule1 = p.locator('.modal .row:has(input[list="rule-topics"])').nth(0);
    await rule1.locator('input[list="rule-topics"]').fill('Aptitude'); await p.keyboard.press('Tab'); await p.waitForTimeout(150); await rule1.locator('input[type=number]').fill('3'); await rule1.locator('select').selectOption('easy');
    await rule1.locator('input[type=number]').blur();
    await p.click('.modal button:has-text("+ Add rule")');
    const rule2 = p.locator('.modal .row:has(input[list="rule-topics"])').nth(1);
    await rule2.locator('input[list="rule-topics"]').fill('Logic'); await p.keyboard.press('Tab'); await p.waitForTimeout(150); await rule2.locator('input[type=number]').fill('2');
    await rule2.locator('input[type=number]').blur();
    await p.click('.modal button:has-text("+ Add rule")');
    const rule3 = p.locator('.modal .row:has(input[list="rule-topics"])').nth(2);
    await rule3.locator('input[list="rule-topics"]').fill('Written'); await p.keyboard.press('Tab'); await p.waitForTimeout(150); await rule3.locator('input[type=number]').fill('1'); await rule3.locator('input[type=number]').blur();
    await shot(p, '03-test-builder');
    await p.selectOption('.modal .field:has-text("Results shown") select', 'score_and_review');
    await p.selectOption('.modal .field:has-text("Camera and microphone") select', 'required');
    await p.click('.modal button:has-text("Save")');
    await p.waitForSelector('#btn-publish'); await p.click('#btn-publish'); await p.waitForSelector('.toast:has-text("Published")');
    await p.waitForSelector('text=Assign candidates');
    await p.locator('label:has-text("Asha Candidate") input').check(); await p.locator('label:has-text("Bala Candidate") input').check();
    await p.click('button:has-text("Assign selected")'); await p.waitForSelector('.toast:has-text("2 assigned")'); step('HR builds, publishes and assigns a test');
    await shot(p, '04-test-detail');

    // ---------------- Candidate A on a phone
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] }); const a = await phone.newPage(); watch(a, 'candA');
    await login(a, cA.user);
    await a.waitForSelector('text=Round 1 Aptitude Check'); await shot(a, '05-candidate-home-mobile');
    await a.click('button:has-text("Open")'); await a.waitForSelector('text=Before you start');
    assert.equal(await a.locator('#start-test').isDisabled(), true); await a.check('#agree'); await shot(a, '06-instructions-mobile');
    await a.waitForSelector('.consent'); await a.click('#start-test'); await a.waitForSelector('#qpanel');
    await a.waitForSelector('.cam-box video'); assert.ok(await a.evaluate(() => { const v = document.querySelector('.cam-box video'); return !!v.srcObject && v.srcObject.getTracks().every(t => t.readyState === 'live'); }), 'camera stream is live'); await shot(a, '07a-camera-on-mobile');
    for (let k = 0; k < 20 && !(await db.query(`SELECT 1 FROM attempt_events WHERE kind='monitor' AND detail LIKE 'Camera and microphone allowed%'`)).rows.length; k++) await a.waitForTimeout(250);
    assert.ok((await db.query(`SELECT 1 FROM attempt_events WHERE kind='monitor' AND detail LIKE 'Camera and microphone allowed%'`)).rows.length, 'camera_on alert stored (a code only, no media)'); step('camera and microphone allowed; live preview shown; only an alert code is stored');
    const html = await a.content(); for (const bad of ['correct_answer', 'Because ', 'explanation']) assert.ok(!html.includes(bad), 'no key in page: ' + bad);
        const total = await a.locator('.nav button').count(); assert.equal(total, 6); step('candidate starts: 6 questions, no answer key in the page');
    // answer the first question, go next, answer, then refresh
    const firstText = await a.locator('#qpanel p').first().innerText();
    if (await a.locator('.opt').count()) await a.locator('.opt').nth(1).click(); else await a.fill('textarea', 'My written answer');
    await a.click('button:has-text("Next")'); if (await a.locator('.opt').count()) await a.locator('.opt').nth(0).click(); else await a.fill('textarea', 'More text');
    await a.waitForSelector('text=All answers saved'); await shot(a, '07-test-mobile');
    await a.reload();  await a.waitForSelector('text=Resume'); await a.click('button:has-text("Resume")'); await a.waitForSelector('#qpanel');
    assert.equal(await a.locator('.nav button.done').count(), 2, 'both answers survive a refresh'); step('refresh and resume keep answers and the same paper');
    assert.equal(await a.locator('#qpanel p').first().innerText(), firstText, 'same first question after refresh');

    // leaving the window blocks the test
    await a.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await a.waitForSelector('text=Your test is paused'); await shot(a, '08-blocked-mobile'); step('leaving the window pauses the test');
    await a.click('button:has-text("Ask for a review")'); await a.waitForSelector('button:has-text("Review requested")');
    // HR reinstates from Results
    await p.click('[role=tab]:has-text("Results")'); await p.waitForSelector('tr:has-text("Asha")');
    await p.locator('tr:has-text("Asha") button').first().click(); await p.waitForSelector('.modal input[placeholder^="Reason"]');
    await p.fill('.modal input[placeholder^="Reason"]', 'Browser tab switched by mistake, confirmed by phone');
    await p.click('.modal button:has-text("Reinstate")'); await p.waitForSelector('.toast:has-text("Reinstated")'); await p.click('.modal button:has-text("Close")');
    await a.reload(); await a.click('button:has-text("Open")'); await a.check('#agree'); await a.click('#start-test'); await a.waitForSelector('#qpanel');
    assert.equal(await a.locator('.nav button.done').count(), 2); step('HR reinstates; candidate resumes with answers intact');

    // finish and submit
    for (let i = 0; i < 6; i++) { await a.locator('.nav button').nth(i).click(); if (await a.locator('.opt').count()) { if (!(await a.locator('.opt.sel').count())) await a.locator('.opt').nth(0).click(); } else if (!(await a.inputValue('textarea'))) await a.fill('textarea', 'A structured written answer.'); }
    await a.waitForSelector('text=All answers saved');
    await a.click('aside button:has-text("Submit")'); await a.waitForSelector('.modal'); await shot(a, '09-submit-confirm-mobile');
    await a.click('.modal button:has-text("Submit now")'); await a.waitForSelector('text=Submitted'); assert.equal(await a.locator('.cam-box').count(), 0, 'camera preview removed after submit'); step('candidate submits');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM attempts WHERE status='submitted'`)).rows[0].n, 1);

    // HR marks the written answer and publishes results
    await p.click('[role=tab]:has-text("Results")'); await p.waitForSelector('tr:has-text("Asha")');
    await p.locator('tr:has-text("Asha") button').first().click(); await p.waitForSelector('.modal input[aria-label="Marks awarded"]');
    await shot(p, '10-marking');
    await p.fill('.modal input[aria-label="Marks awarded"]', '4'); await p.click('.modal button:has-text("Save marks")'); await p.waitForSelector('.toast:has-text("Final score")'); await p.click('.modal button:has-text("Close")');
    await p.click('[role=tab]:has-text("Tests")'); await p.locator('tr:has-text("Round 1 Aptitude Check") button').click();
    await p.waitForSelector('button:has-text("Publish results")'); await p.click('button:has-text("Publish results")'); await p.waitForSelector('.toast:has-text("Results published")');
    await a.reload(); await a.waitForSelector('button:has-text("View result")'); await a.click('button:has-text("View result")');
    await a.waitForSelector('text=Your answers'); await shot(a, '11-result-mobile'); step('results appear for the candidate only after HR publishes them');

    // exports download
    const [dl] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('[role=tab]:has-text("Results")'); await p.click('a:has-text("Export Excel")'); })()]);
    assert.match(dl.suggestedFilename(), /^semil-results-.*\.xlsx$/); step('Excel export downloads');

    // Candidate B cannot see A's data through the portal (API level)
    const denied = await (await browser.newContext()).newPage(); watch(denied, 'candB-denied');
    await denied.addInitScript(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })); });
    await login(denied, cB.user); await denied.click('button:has-text("Open")'); await denied.check('#agree'); await denied.click('#start-test');
    await denied.waitForSelector('text=Camera and microphone needed'); await denied.waitForSelector('text=was blocked'); await shot(denied, '07b-camera-denied');
    assert.equal((await db.query(`SELECT t.status FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.application_id=$1`, [cB.applicationId])).rows[0].status, 'ready', 'test does not start without the camera'); step('blocked camera permission: test does not start');
    const b = await (await browser.newContext()).newPage(); watch(b, 'candB'); await login(b, cB.user);
    const attA = (await db.query(`SELECT t.id FROM attempts t JOIN assignments g ON g.id=t.assignment_id WHERE g.application_id=$1`, [cA.applicationId])).rows[0].id;
    const status = await b.evaluate(async id => (await fetch('/api/qb/my/attempts/' + id + '/paper', { credentials: 'same-origin' })).status, attA);
    assert.equal(status, 404); step('another candidate gets 404 for this attempt');
    // desktop views for the record
    await p.click('[role=tab]:has-text("Results")'); await p.waitForSelector('table'); await shot(p, '12-results-desktop');
    assert.deepEqual(errors, [], 'no browser console errors: ' + errors.join(' | '));
    step('no JavaScript errors in any browser');
    console.log('E2E PASSED');
  } catch (e) {
    console.error('E2E FAILED:', e.message); console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally { await browser.close(); server.close(); await db.end(); }
})();
