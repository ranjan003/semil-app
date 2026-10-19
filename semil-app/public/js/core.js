'use strict';
// Shared helpers: DOM builder, API client, toasts, modal. Everything that comes from the server is inserted with
// textContent (never innerHTML), so question text or names cannot inject markup.
(function () {
  const NT = (window.NT = window.NT || {});

  NT.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'required' || k === 'multiple') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = k => { if (k === null || k === undefined || k === false) return; if (Array.isArray(k)) k.forEach(add); else el.append(k.nodeType ? k : document.createTextNode(String(k))); };
    kids.forEach(add);
    return el;
  };
  const h = NT.h;
  NT.clear = el => { const ae = document.activeElement; if (ae && ae !== document.body && el.contains(ae) && ae.blur) ae.blur(); if (el.replaceChildren) el.replaceChildren(); else { while (el.firstChild) el.removeChild(el.firstChild); } return el; };
  NT.mount = (el, ...kids) => { NT.clear(el); kids.flat().forEach(k => k && el.append(k)); };

  class ApiError extends Error { constructor(status, body) { super((body && body.message) || (body && body.error) || 'Request failed'); this.status = status; this.code = body && body.error; this.fields = body && body.fields; this.body = body || {}; } }
  NT.ApiError = ApiError;
  NT.onUnauth = () => {};
  async function call(method, url, body, headers = {}) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
    if (method !== 'GET') init.headers['X-Requested-With'] = 'semil';
    if (NT.auth && NT.auth.getToken) {
      try {
        const token = await NT.auth.getToken();
        if (token && !init.headers['Authorization']) {
          init.headers['Authorization'] = 'Bearer ' + token;
        }
      } catch (e) { /* ignore */ }
    }
    if (body !== undefined) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) init.body = body;
      else if (body instanceof Blob) init.body = body;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    }
    let res;
    try { res = await fetch(url, init); } catch (e) { const err = new ApiError(0, { error: 'network', message: 'Cannot reach the server. Check your connection.' }); throw err; }
    let data = null;
    const text = await res.text();
    if (text) { try { data = JSON.parse(text); } catch { data = { error: 'bad_response', message: 'Unexpected response from the server.' }; } }
    if (!res.ok) { if (res.status === 401 && url !== '/api/auth/login') NT.onUnauth(); throw new ApiError(res.status, data); }
    return data;
  }
  NT.api = { get: u => call('GET', u), post: (u, b) => call('POST', u, b === undefined ? {} : b), put: (u, b) => call('PUT', u, b === undefined ? {} : b),
    upload: (u, file) => {
      if (typeof FormData !== 'undefined' && file instanceof FormData) return call('POST', u, file);
      const fd = new FormData();
      fd.append('file', file, (file && file.name) || 'upload');
      return call('POST', u, fd);
    } };

  NT.toast = function (msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || ''), role: 'status', text: msg });
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
  };
  NT.err = e => NT.toast(e && e.message ? e.message : 'Something went wrong.', 'bad');

  NT.modal = function (title, body, actions = []) {
    const prevFocus = document.activeElement;
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('h2', { text: title }), body,
      actions.length ? h('div', { class: 'row end', style: 'margin-top:1rem' }, actions.map(a => h('button', { class: 'btn ' + (a.kind || ''), type: 'button', onclick: async ev => { if (a.close !== false) close(); if (a.run) await a.run(ev, close); } , text: a.label }))) : null);
    const ov = h('div', { class: 'overlay' }, box);
    ov.addEventListener('mousedown', e => { if (e.target === ov && !NT.modalLocked) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(ov);
    const first = box.querySelector('input,select,textarea,button');
    if (first) first.focus();
    return close;
  };

  NT.confirm = (title, text, label = 'Confirm', kind = 'primary') => new Promise(res => {
    let done = false;
    const fin = v => { if (!done) { done = true; res(v); } };
    NT.modal(title, h('p', { text }), [{ label: 'Cancel', run: () => fin(false) }, { label, kind, run: () => fin(true) }]);
  });

  NT.fmtDate = d => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  NT.chip = (text, kind) => h('span', { class: 'chip ' + (kind || ''), text });
  NT.statusChip = s => NT.chip(String(s).replace(/_/g, ' '), { active: 'ok', published: 'ok', final: 'ok', passed: 'ok', submitted: 'ok', inactive: 'warn', in_progress: 'info', blocked: 'bad', archived: 'bad', error: 'bad', failed: 'bad', pending_review: 'warn', new: 'ok', update: 'info', duplicate: 'warn', ignored: '' }[s]);
  NT.qs = obj => { const p = new URLSearchParams(); Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) p.set(k, v); }); const s = p.toString(); return s ? '?' + s : ''; };
  NT.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  NT.field = (label, input, { hint, error, id } = {}) => { const i = id || 'f' + Math.random().toString(36).slice(2, 8); input.id = input.id || i; return h('div', { class: 'field' + (error ? ' bad' : '') }, h('label', { for: input.id, text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null, error ? h('div', { class: 'err', role: 'alert', text: error }) : null); };
  NT.sel = (options, value, attrs = {}) => h('select', attrs, options.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value) }, t); }));
  NT.pager = (page, per, total, go) => { const pages = Math.max(1, Math.ceil(total / per)); return h('div', { class: 'pager' }, h('span', { class: 'muted small', text: `${total} item${total === 1 ? '' : 's'} · page ${page} of ${pages}` }), h('button', { class: 'btn small', disabled: page <= 1, onclick: () => go(page - 1), text: 'Previous' }), h('button', { class: 'btn small', disabled: page >= pages, onclick: () => go(page + 1), text: 'Next' })); };
  NT.safeStore = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };
})();
