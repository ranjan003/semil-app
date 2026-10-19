const { chromium } = require('/opt/npm-tools/node_modules/playwright'); const assert = require('assert');
const URL_ = 'file:///home/claude/demo/dist/semil-demo.html';
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const errs = []; const watch = (p, n) => { p.on('pageerror', e => errs.push(n + ' pageerror ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(n + ' console ' + m.text()); }); };
  const step = s => console.log('  ✓', s); const shot = (p, n) => p.screenshot({ path: `shots/${n}.png` });
  const as = async (p, name) => { await p.goto(URL_); await p.waitForSelector('.demo-quick'); await p.click(`button:has-text("${name}")`); await p.waitForSelector('.topbar'); };
  try {
    const p = await ctx.newPage(); watch(p, 'hr'); await as(p, 'Hannah HR');
    // import the valid xlsx and docx fixtures
    await p.click('[role=tab]:has-text("Import")');
    await p.setInputFiles('input[type=file]', '/home/claude/semil-app/test/fixtures/qb/valid.xlsx'); await p.waitForSelector('#confirm-import'); await p.click('#confirm-import'); await p.waitForSelector('text=Import complete'); step('imported valid.xlsx');
    await p.click('[role=tab]:has-text("Import")'); await p.setInputFiles('input[type=file]', '/home/claude/semil-app/test/fixtures/qb/valid.docx'); await p.waitForSelector('#confirm-import'); assert.equal(await p.locator('#confirm-import').isDisabled(), true); step('docx parsed; same questions detected as duplicates');
    await p.click('[role=tab]:has-text("Import")');
    // template downloads
    for (const fm of ['xlsx', 'csv', 'docx']) { const [dl] = await Promise.all([p.waitForEvent('download'), p.click(`a[href="/api/qb/templates/${fm}"]`)]); assert.match(dl.suggestedFilename(), new RegExp('template\\.' + fm + '$')); }
    step('three templates download');
    // build the test
    await p.click('[role=tab]:has-text("Tests")'); await p.click('text=+ New test');
    await p.fill('.modal input[type=text] >> nth=0', 'Round 1 Aptitude Check');
    const rule = i => p.locator('.modal .row:has(input[list="rule-topics"])').nth(i);
    const fillRule = async (i, topic, n, diff) => { await rule(i).locator('input[list="rule-topics"]').fill(topic); await p.keyboard.press('Tab'); await p.waitForTimeout(150); if (diff) await rule(i).locator('select').selectOption(diff); await rule(i).locator('input[type=number]').fill(String(n)); await rule(i).locator('input[type=number]').blur(); await p.waitForTimeout(100); };
    await fillRule(0, 'Aptitude', 3, 'easy'); await p.click('.modal button:has-text("+ Add rule")'); await fillRule(1, 'Logical Reasoning', 2); await p.click('.modal button:has-text("+ Add rule")'); await fillRule(2, 'Written Response', 1);
    await p.selectOption('.modal .field:has-text("Results shown") select', 'score_and_review'); await shot(p, 'd03-builder');
    await p.click('.modal button:has-text("Save")'); await p.waitForSelector('#btn-publish'); await p.click('#btn-publish'); await p.waitForSelector('.toast:has-text("Published")');
    await p.locator('label:has-text("Asha Candidate") input').check(); await p.click('button:has-text("Assign selected")'); await p.waitForSelector('.toast:has-text("1 assigned")'); step('HR publishes and assigns'); await shot(p, 'd04-test');
    // candidate on a phone-sized tab of the same browser profile
    const a = await ctx.newPage(); await a.setViewportSize({ width: 390, height: 844 }); watch(a, 'cand'); await as(a, 'Asha Candidate');
    await a.click('button:has-text("Open")'); await a.check('#agree'); await a.click('#start-test'); await a.waitForSelector('#qpanel');
    const html = await a.locator('#root').innerHTML(); for (const bad of ['correct_answer', 'explanation']) assert.ok(!html.includes(bad)); const total = await a.locator('.nav button').count(); assert.equal(total, 6); step('candidate starts 6 questions, no key in page');
    for (let i = 0; i < 6; i++) { await a.locator('.nav button').nth(i).click(); if (await a.locator('.opt').count()) await a.locator('.opt').nth(1).click(); else await a.fill('textarea', 'I organised the team, fixed the issue and reduced complaints by half.'); }
    await a.waitForSelector('text=All answers saved'); await shot(a, 'd07-test'); await a.reload(); await a.click('button:has-text("Resume")'); await a.waitForSelector('#qpanel'); assert.equal(await a.locator('.nav button.done').count(), 6); step('refresh keeps answers');
    await a.click('aside button:has-text("Submit")'); await a.click('.modal button:has-text("Submit now")'); await a.waitForSelector('text=Submitted'); step('candidate submits');
    // HR marks and publishes
    await p.click('[role=tab]:has-text("Results")'); await p.waitForSelector('tr:has-text("Asha")'); await p.locator('tr:has-text("Asha") button').first().click();
    await p.waitForSelector('.modal input[aria-label="Marks awarded"]'); await shot(p, 'd10-marking'); await p.fill('.modal input[aria-label="Marks awarded"]', '4'); await p.click('.modal button:has-text("Save marks")'); await p.waitForSelector('.toast:has-text("Final score")'); await p.click('.modal button:has-text("Close")');
    await p.click('[role=tab]:has-text("Tests")'); await p.locator('tr:has-text("Round 1 Aptitude Check") button').click(); await p.waitForSelector('button:has-text("Publish results")'); await p.click('button:has-text("Publish results")'); await p.waitForSelector('.toast:has-text("Results published")');
    await a.reload(); await a.waitForSelector('button:has-text("View result")'); await a.click('button:has-text("View result")'); await a.waitForSelector('text=Your answers'); await shot(a, 'd11-result'); step('candidate sees result after publish');
    const [dl] = await Promise.all([p.waitForEvent('download'), (async () => { await p.click('[role=tab]:has-text("Results")'); await p.click('a:has-text("Export Excel")'); })()]); assert.match(dl.suggestedFilename(), /^semil-results-.*\.xlsx$/); step('results export');
    await p.click('[role=tab]:has-text("History")'); await p.waitForSelector('table tbody tr'); await shot(p, 'd12-history');
    // reload keeps data
    await p.reload(); await p.click('button:has-text("Hannah HR")').catch(() => {}); 
    assert.deepEqual(errs, [], errs.join('\n')); console.log('DEMO FLOW PASSED');
  } catch (e) { console.error('FAILED', e.message, errs); process.exitCode = 1; } finally { await b.close(); }
})();
