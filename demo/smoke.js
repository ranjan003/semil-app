const { chromium } = require('/opt/npm-tools/node_modules/playwright');
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push('pageerror ' + e.message)); p.on('console', m => { if (m.type() === 'error') errs.push('console ' + m.text()); });
  await p.goto('file:///home/claude/demo/dist/semil-demo.html'); await p.waitForTimeout(1500); console.log(errs, (await p.innerText('body')).slice(0,200)); await p.waitForSelector('.demo-quick', {timeout:3000});
  await p.screenshot({ path: 'shots/01-login.png' });
  await p.click('button:has-text("Hannah HR")'); await p.waitForSelector('table tbody tr');
  console.log('rows', await p.locator('table tbody tr').count()); await p.screenshot({ path: 'shots/02-bank.png' });
  console.log(errs);
  await b.close();
})();
