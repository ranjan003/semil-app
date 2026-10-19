const esbuild = require('/opt/npm-tools/node_modules/esbuild');
const fs = require('fs'); const path = require('path');
(async () => {
  const r = await esbuild.build({
    entryPoints: ['entry.js'], bundle: true, write: false, format: 'iife', minify: true, target: 'es2020', legalComments: 'none', platform: 'browser',
    alias: { 'node:crypto': './shims/crypto.js', 'node:zlib': './shims/zlib.js', 'node:path': './shims/path.js', 'node:buffer': './shims/buffer.js' },
    inject: ['./shims/buffer-global.js'], logLevel: 'warning',
  });
  const bundle = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const P = '/home/claude/semil-app/public';
  const css = fs.readFileSync(P + '/app.css', 'utf8');
  const js = ['core', 'admin', 'monitor', 'candidate', 'main'].map(f => fs.readFileSync(`${P}/js/${f}.js`, 'utf8').replace(/<\/script/gi, '<\\/script'));
  const demoUi = fs.readFileSync('demo-ui.js', 'utf8'); const demoCss = fs.readFileSync('demo-ui.css', 'utf8');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Semil Talent Demo</title>
<style>${css}\n${demoCss}</style>
</head>
<body>
<noscript><p style="padding:2rem">This demo needs JavaScript.</p></noscript>
<div id="demo-bar"></div>
<div id="root"></div>
<div id="toasts" aria-live="polite"></div>
<script>${bundle}</script>
${js.map(s => `<script>${s}</script>`).join('\n')}
<script>${demoUi}</script>
</body>
</html>`;
  fs.writeFileSync('dist/semil-demo.html', html); console.log('bytes', html.length);
})().catch(e => { console.error(e); process.exit(1); });
