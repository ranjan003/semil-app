'use strict';
// Frontend Firebase Authentication helper.
//
// Responsibilities:
//   • initialise Firebase once, using the public config served by /config.js;
//   • expose a ready promise so protected pages wait for the persisted session;
//   • email/password sign-in, sign-up, Google sign-in, logout and password reset;
//   • keep a fresh ID token on every API call;
//   • turn Firebase error codes into short, human-readable messages.
//
// No private key, service account or password is ever stored in this file.
(function () {
  const NT = window.NT = window.NT || {};

  const fallbackConfig = {
    apiKey: 'AIzaSyCdRMtDEgohaX74lylHfH0PrqDewTfR3Xw',
    authDomain: 'semil-a9cf1.firebaseapp.com',
    databaseURL: 'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'semil-a9cf1',
    storageBucket: 'semil-a9cf1.firebasestorage.app',
    messagingSenderId: '124354464493',
    appId: '1:124354464493:web:06fc3d812bc641513c9ae4',
    measurementId: 'G-TZYB5VGRVH',
  };
  const provided = {};
  Object.entries(window.FIREBASE_CONFIG || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') provided[key] = value;
  });
  const config = Object.assign({}, fallbackConfig, provided);

  let currentUser = null;
  let currentToken = null;
  let initialised = false;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const listeners = new Set();
  let resolveFirstState;
  const firstState = new Promise(resolve => { resolveFirstState = resolve; });

  function mapError(error) {
    const code = (error && (error.code || error.errorCode)) || '';
    const map = {
      'auth/email-already-in-use': 'An account with this e-mail already exists. Sign in instead.',
      'auth/invalid-email': 'Enter a valid e-mail address.',
      'auth/weak-password': 'Use a password with at least 6 characters.',
      'auth/missing-password': 'Enter your password.',
      'auth/user-not-found': 'E-mail or password is not correct.',
      'auth/wrong-password': 'E-mail or password is not correct.',
      'auth/invalid-credential': 'E-mail or password is not correct.',
      'auth/invalid-login-credentials': 'E-mail or password is not correct.',
      'auth/user-disabled': 'This account has been disabled. Contact an administrator.',
      'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
      'auth/popup-closed-by-user': 'Google sign-in was closed before it finished.',
      'auth/cancelled-popup-request': 'Another Google sign-in is already open.',
      'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups and try again.',
      'auth/unauthorized-domain': 'This domain is not authorised in Firebase Authentication. Add it under Authentication → Settings → Authorised domains.',
      'auth/operation-not-allowed': 'This sign-in method is not enabled in the Firebase Console.',
      'auth/network-request-failed': 'Cannot reach Firebase. Check your connection and try again.',
      'auth/account-exists-with-different-credential': 'This e-mail already uses a different sign-in method. Sign in with that method first.',
      'auth/requires-recent-login': 'Please sign in again before making this change.',
    };
    return map[code] || (error && error.message) || 'Sign-in failed. Please try again.';
  }

  function firebaseAvailable() {
    return typeof firebase !== 'undefined' && firebase.auth && firebase.initializeApp;
  }

  function init() {
    if (initialised) return;
    initialised = true;
    if (!firebaseAvailable()) {
      console.error('Firebase SDK did not load. Check the script tags in index.html and your network connection.');
      resolveReady(null);
      resolveFirstState(null);
      return;
    }

    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(config);
      const auth = firebase.auth();
      auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => { /* private mode: session still works for this tab */ });

      const useEmulator = window.FIREBASE_USE_EMULATOR === true;
      if (useEmulator) {
        try { auth.useEmulator(`http://${window.location.hostname}:9099`); } catch { /* already connected */ }
      }

      auth.onAuthStateChanged(async user => {
        currentUser = user || null;
        if (user) {
          try {
            currentToken = await user.getIdToken();
            if (!user.displayName && user.email) { /* keep the e-mail as the display name */ }
          } catch (err) {
            console.warn('Could not refresh the Firebase ID token:', err.message);
            currentToken = null;
          }
        } else {
          currentToken = null;
        }
        listeners.forEach(fn => { try { fn(user); } catch { /* listener errors must not break auth */ } });
        resolveReady(user || null);
        resolveFirstState(user || null);
      }, err => {
        console.error('Firebase auth state listener failed:', err);
        resolveReady(null);
        resolveFirstState(null);
      });
    } catch (err) {
      console.error('Firebase initialisation failed:', err);
      resolveReady(null);
      resolveFirstState(null);
    }
  }

  async function idToken(forceRefresh) {
    if (!firebaseAvailable()) return null;
    const user = firebase.auth().currentUser || currentUser;
    if (!user) return currentToken;
    try {
      currentToken = await user.getIdToken(!!forceRefresh);
      return currentToken;
    } catch (err) {
      console.warn('Could not read the Firebase ID token:', err.message);
      return currentToken;
    }
  }

  async function postProfile(fullName) {
    const token = await idToken(true);
    if (!token) return null;
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Requested-With': 'semil',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(fullName ? { fullName } : {}),
    });
    if (!res.ok) {
      // A failed profile sync must not hide a successful sign-in. /api/me will retry it.
      console.warn('Profile sync returned', res.status);
      return null;
    }
    return res.json().catch(() => null);
  }

  async function afterSignIn(user, fullName) {
    currentUser = user;
    currentToken = await user.getIdToken(true);
    const profile = await postProfile(fullName || user.displayName || '');
    return { user, profile };
  }

  init();

  NT.auth = {
    ready,
    config,
    mapError,
    onChange(fn) {
      listeners.add(fn);
      if (currentUser !== null) { try { fn(currentUser); } catch { /* ignore */ } }
      return () => listeners.delete(fn);
    },
    getToken(forceRefresh = false) {
      return idToken(forceRefresh);
    },
    getUser() {
      return currentUser;
    },

    async signIn(email, password) {
      if (!firebaseAvailable()) throw new Error('Firebase Authentication is not available. Check your connection.');
      const cred = await firebase.auth().signInWithEmailAndPassword(String(email).trim(), password);
      return afterSignIn(cred.user);
    },

    async signUp(email, password, fullName) {
      if (!firebaseAvailable()) throw new Error('Firebase Authentication is not available. Check your connection.');
      const cred = await firebase.auth().createUserWithEmailAndPassword(String(email).trim(), password);
      if (fullName && cred.user.updateProfile) {
        try { await cred.user.updateProfile({ displayName: String(fullName).trim() }); } catch { /* not fatal */ }
      }
      return afterSignIn(cred.user, fullName);
    },

    async signInWithGoogle() {
      if (!firebaseAvailable()) throw new Error('Firebase Authentication is not available. Check your connection.');
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const cred = await firebase.auth().signInWithPopup(provider);
      return afterSignIn(cred.user);
    },

    async resetPassword(email) {
      if (!firebaseAvailable()) throw new Error('Firebase Authentication is not available.');
      await firebase.auth().sendPasswordResetEmail(String(email).trim());
    },

    async logout() {
      if (firebaseAvailable()) {
        try { await firebase.auth().signOut(); } catch { /* ignore */ }
      }
      currentUser = null;
      currentToken = null;
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'X-Requested-With': 'semil', Accept: 'application/json' },
        });
      } catch { /* the local sign-out is what matters */ }
    },

    // Kept for code that needs to wait for the first persisted session.
    waitForFirstState() {
      return firstState;
    },
  };
})();
