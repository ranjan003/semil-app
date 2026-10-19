// Browser entry: replaces fetch for /api/* with the in-browser backend, turns /api/ download links into file saves,
// adds the demo bar and sign-in shortcuts, then lets the real UI scripts (core, admin, candidate, main) run.
import { Buffer } from './shims/buffer.js';
import backend from './backend.js';
window.Buffer = Buffer;

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase(); const headers = init.headers || {};
  let body, raw, mime;
  if (init.body instanceof Blob) { raw = Buffer.from(new Uint8Array(await init.body.arrayBuffer())); mime = headers['Content-Type'] || init.body.type || ''; }
  else if (typeof init.body === 'string' && init.body) { try { body = JSON.parse(init.body); } catch { body = {}; } }
  await new Promise(r => setTimeout(r, 20));
  const out = backend.handle(method, url, { body, raw, mime });
  if (out.file) return new Response(out.file.body, { status: 200, headers: { 'Content-Type': out.file.mime, 'X-File-Name': out.file.fileName } });
  return new Response(JSON.stringify(out.json), { status: out.status, headers: { 'Content-Type': 'application/json' } });
};

document.addEventListener('click', async e => {
  const a = e.target.closest && e.target.closest('a[href^="/api/"]'); if (!a) return;
  e.preventDefault();
  const res = await fetch(a.getAttribute('href'));
  if (!res.ok) { NT.toast((await res.json()).message || 'Download failed', 'bad'); return; }
  const blob = await res.blob(); const l = document.createElement('a'); l.href = URL.createObjectURL(blob); l.download = res.headers.get('X-File-Name') || 'download'; document.body.append(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(l.href), 2000);
});

setInterval(() => backend.sweep(), 10000);

window.__demo = {
  accounts: backend.users(),
  reset() { backend.reset(); try { sessionStorage.removeItem('nt_demo_user'); } catch { /* ignore */ } location.reload(); },
};
