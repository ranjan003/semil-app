'use strict';
(function () {
  const { h, api, toast } = NT;
  const root = document.getElementById('root');
  const ROLE = { super_admin: 'Super Admin', hr_admin: 'HR', technical_assessor: 'Assessor', business_assessor: 'Assessor', candidate: 'Candidate' };
  let showingLogin = false;
  let authBusy = false;

  const emailOk = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim());
  const passwordOk = value => String(value).length >= 6;

  function banner(kind, text) {
    return h('div', { class: 'banner ' + kind, role: kind === 'bad' ? 'alert' : 'status', text });
  }

  function fieldWithError(label, input, error, hint) {
    return NT.field(label, input, { error, hint });
  }

  function googleButton(onClick, disabled) {
    return h('button', {
      class: 'btn google-btn', type: 'button', disabled: !!disabled, onclick: onClick,
      'aria-label': 'Continue with Google', 'data-label': 'Continue with Google',
    }, h('span', { class: 'g-mark', 'aria-hidden': 'true', text: 'G' }), 'Continue with Google');
  }

  function login(msg, noticeKind) {
    if (showingLogin && !msg) return;
    showingLogin = true;
    authBusy = false;
    let mode = 'signin'; // signin | signup
    const notice = h('div');
    const errorBox = h('div');
    const body = h('div');

    function setNotice(text, kind) {
      NT.mount(notice, text ? banner(kind || 'info', text) : null);
    }
    function setError(text) {
      NT.mount(errorBox, text ? banner('bad', text) : null);
    }
    function setBusy(button, busy, label) {
      authBusy = busy;
      button.disabled = busy;
      button.textContent = busy ? label : button.dataset.label;
      button.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function draw() {
      const isSignup = mode === 'signup';
      const fullName = h('input', { type: 'text', autocomplete: 'name', placeholder: 'Your full name', maxlength: 120, id: 'fullName' });
      const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com', id: 'email' });
      const password = h('input', { type: 'password', required: true, autocomplete: isSignup ? 'new-password' : 'current-password', placeholder: 'At least 6 characters', id: 'password' });
      const confirm = isSignup ? h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: 'Repeat your password', id: 'confirmPassword' }) : null;
      const submit = h('button', { class: 'btn primary auth-submit', type: 'submit', 'data-label': isSignup ? 'Create account' : 'Sign in', text: isSignup ? 'Create account' : 'Sign in' });
      const google = googleButton(handleGoogle);
      const form = h('form', { novalidate: true, onsubmit: handleSubmit },
        isSignup ? fieldWithError('Full name', fullName, null) : null,
        fieldWithError('E-mail', email, null),
        fieldWithError('Password', password, null, isSignup ? 'Use at least 6 characters.' : null),
        isSignup ? fieldWithError('Confirm password', confirm, null) : null,
        errorBox,
        submit,
        h('div', { class: 'auth-divider' }, h('span', { text: 'or' })),
        google,
        isSignup ? null : h('div', { class: 'auth-links' },
          h('button', { class: 'linklike', type: 'button', onclick: handleForgot, text: 'Forgot your password?' })));

      NT.mount(body,
        h('div', { class: 'auth-tabs', role: 'tablist', 'aria-label': 'Account access' },
          h('button', { type: 'button', role: 'tab', class: 'auth-tab' + (!isSignup ? ' active' : ''), 'aria-selected': String(!isSignup), onclick: () => switchMode('signin'), text: 'Sign in' }),
          h('button', { type: 'button', role: 'tab', class: 'auth-tab' + (isSignup ? ' active' : ''), 'aria-selected': String(isSignup), onclick: () => switchMode('signup'), text: 'Sign up' })),
        form,
        h('p', { class: 'auth-switch' },
          isSignup ? 'Already have an account? ' : 'New to Semil? ',
          h('button', { class: 'linklike', type: 'button', onclick: () => switchMode(isSignup ? 'signin' : 'signup'), text: isSignup ? 'Sign in' : 'Create an account' })));

      setTimeout(() => { if (body.isConnected) email.focus(); }, 0);

      async function handleSubmit(ev) {
        ev.preventDefault();
        if (authBusy) return;
        setError('');
        const e = email.value.trim();
        const p = password.value;
        const problems = [];
        if (isSignup && String(fullName.value).trim().length < 2) problems.push('Enter your full name.');
        if (!emailOk(e)) problems.push('Enter a valid e-mail address.');
        if (!passwordOk(p)) problems.push('Password must be at least 6 characters.');
        if (isSignup && p !== confirm.value) problems.push('The passwords do not match.');
        if (problems.length) return setError(problems.join(' '));

        setBusy(submit, true, isSignup ? 'Creating account…' : 'Signing in…');
        google.disabled = true;
        try {
          if (isSignup) {
            await NT.auth.signUp(e, p, String(fullName.value).trim());
            toast('Account created. Welcome to Semil.', 'ok');
          } else {
            await NT.auth.signIn(e, p);
            toast('Signed in successfully.', 'ok');
          }
          showingLogin = false;
          authBusy = false;
          await start();
        } catch (err) {
          setError(NT.auth.mapError(err) || 'Something went wrong. Please try again.');
          setBusy(submit, false, '');
          google.disabled = false;
        }
      }

      async function handleGoogle() {
        if (authBusy) return;
        setError('');
        setBusy(google, true, 'Opening Google…');
        submit.disabled = true;
        try {
          await NT.auth.signInWithGoogle();
          toast('Signed in with Google.', 'ok');
          showingLogin = false;
          authBusy = false;
          await start();
        } catch (err) {
          setError(NT.auth.mapError(err) || 'Google sign-in failed. Please try again.');
          setBusy(google, false, '');
          submit.disabled = false;
        }
      }

      async function handleForgot() {
        const e = email.value.trim();
        if (!emailOk(e)) return setError('Enter your e-mail address first, then choose “Forgot your password?”.');
        try {
          await NT.auth.resetPassword(e);
          setNotice('Password reset e-mail sent. Check your inbox and spam folder.', 'ok');
          setError('');
        } catch (err) {
          setError(NT.auth.mapError(err));
        }
      }
    }

    function switchMode(next) {
      if (authBusy || mode === next) return;
      mode = next;
      setError('');
      setNotice('');
      draw();
    }

    NT.mount(root, h('div', { class: 'login' },
      h('h1', { text: 'Semil Talent Discovery' }),
      h('p', { class: 'muted', text: 'Sign in or create an account to continue.' }),
      notice,
      msg ? banner(noticeKind || 'info', msg) : null,
      body));
    draw();
  }

  async function loadMe(forceRefresh) {
    if (forceRefresh) await NT.auth.getToken(true);
    return api.get('/api/me');
  }

  async function start() {
    showingLogin = false;
    // Critical: wait for Firebase to restore the persisted session before calling /api/me.
    // Without this, a refresh can send an unauthenticated request and bounce the user to login.
    await NT.auth.ready;
    const firebaseUser = NT.auth.getUser();
    if (!firebaseUser) return login();

    let me;
    try {
      me = await loadMe(false);
    } catch (e) {
      if (e && e.status === 401) {
        // One retry with a force-refreshed token covers the post-refresh race.
        try { me = await loadMe(true); } catch (e2) {
          if (e2 && e2.status === 401) return login('Your session ended. Please sign in again.');
          return showLoadError(e2);
        }
      } else if (e && e.status === 403) {
        return login(e.message || 'This account has been disabled. Contact an administrator.', 'bad');
      } else {
        return showLoadError(e);
      }
    }

    const shell = h('div');
    const top = h('header', { class: 'topbar' },
      h('span', { class: 'brand', text: 'Semil Talent Discovery' }),
      h('span', { class: 'sp' }),
      h('span', { class: 'who', text: `${me.full_name || me.email} · ${ROLE[me.role] || me.role}` }),
      h('button', {
        onclick: async () => {
          try { await NT.auth.logout(); } catch { /* ignore */ }
          NT.onUnauth = () => {};
          toast('Signed out.', 'ok');
          login();
        }, text: 'Sign out',
      }));
    const body = h('div');
    shell.append(top, body);
    NT.mount(root, shell);
    NT.onUnauth = () => login('Your session ended. Please sign in again.');

    try {
      if (me.role === 'candidate') await NT.candidate(body, me);
      else await NT.admin(body, me);
    } catch (e) {
      console.error('Could not render the workspace:', e);
      NT.mount(body, h('div', { class: 'card' }, h('h2', { text: 'This page could not load' }),
        h('p', { class: 'muted', text: e && e.message ? e.message : 'Unexpected error.' }),
        h('button', { class: 'btn primary', onclick: start, text: 'Try again' })));
    }
  }

  function showLoadError(e) {
    const message = (e && e.message) || 'Cannot reach the server.';
    NT.mount(root, h('div', { class: 'login' },
      h('h1', { text: 'Semil Talent Discovery' }),
      banner('bad', message),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: start, text: 'Try again' }),
        h('button', { class: 'btn', onclick: () => login(), text: 'Sign in again' }))));
  }

  // If another tab signs out, return to the login screen.
  NT.auth.onChange(user => {
    if (!user && !showingLogin && document.querySelector('.topbar')) login('You have been signed out.');
  });

  start();
})();
