'use strict';
(function () {
  const { h, api } = NT;
  const root = document.getElementById('root');
  const ROLE = { super_admin: 'Super Admin', hr_admin: 'HR', technical_assessor: 'Assessor', business_assessor: 'Assessor', candidate: 'Candidate' };

  function login(msg) {
    const email = h('input', { type: 'email', required: true, autocomplete: 'username', id: 'email' }), pw = h('input', { type: 'password', required: true, autocomplete: 'current-password', id: 'password' });
    const err = h('div', { class: 'banner bad', role: 'alert', style: 'display:none' });
    NT.mount(root, h('div', { class: 'login' }, h('h1', { text: 'Semil Talent Discovery' }), h('p', { class: 'muted', text: 'Sign in to continue.' }), msg ? h('div', { class: 'banner info', text: msg }) : null,
      h('form', { onsubmit: async ev => {
        ev.preventDefault();
        err.style.display = 'none';
        try {
          const res = await api.post('/api/auth/login', { email: email.value.trim(), password: pw.value });
          if (res && res.token) {
            document.cookie = `__session=${res.token}; path=/; max-age=604800; SameSite=Lax`;
          }
          start();
        } catch (e) {
          err.textContent = e.status === 429 ? 'Too many attempts. Wait a few minutes.' : (e.message || 'E-mail or password is not correct.');
          err.style.display = 'block';
        }
      } },
        NT.field('E-mail', email), NT.field('Password', pw), err, h('button', { class: 'btn primary', type: 'submit', style: 'width:100%', text: 'Sign in' }))));
  }

  async function start() {
    let me;
    try { me = await api.get('/api/me'); } catch { return login(); }
    const shell = h('div');
    const top = h('header', { class: 'topbar' }, h('span', { class: 'brand', text: 'Semil Talent Discovery' }), h('span', { class: 'sp' }), h('span', { class: 'who', text: `${me.full_name || me.email} · ${ROLE[me.role] || me.role}` }),
      h('button', { onclick: async () => {
        if (NT.auth && NT.auth.logout) await NT.auth.logout();
        try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
        login();
      }, text: 'Sign out' }));
    const body = h('div');
    shell.append(top, body);
    NT.mount(root, shell);
    NT.onUnauth = () => login('Your session ended. Please sign in again.');
    if (me.role === 'candidate') NT.candidate(body, me); else NT.admin(body, me);
  }
  start();
})();
