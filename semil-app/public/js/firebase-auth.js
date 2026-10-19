'use strict';
// Frontend Firebase Authentication helper
// Connects to Firebase Auth (or emulator if running locally), manages ID tokens,
// and ensures all API calls carry the Firebase token.

(function () {
  const NT = window.NT = window.NT || {};

  // Production Firebase project configuration
  const defaultFirebaseConfig = {
    apiKey: window.FIREBASE_API_KEY || "AIzaSyCdRMtDEgohaX74lylHfH0PrqDewTfR3Xw",
    authDomain: window.FIREBASE_AUTH_DOMAIN || "semil-a9cf1.firebaseapp.com",
    databaseURL: window.FIREBASE_DATABASE_URL || "https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: window.FIREBASE_PROJECT_ID || "semil-a9cf1",
    storageBucket: window.FIREBASE_STORAGE_BUCKET || "semil-a9cf1.firebasestorage.app",
    messagingSenderId: "124354464493",
    appId: "1:124354464493:web:06fc3d812bc641513c9ae4",
    measurementId: "G-TZYB5VGRVH"
  };

  let currentUser = null;
  let currentToken = null;

  // Initialize Firebase App
  if (typeof firebase !== 'undefined') {
    if (!firebase.apps || !firebase.apps.length) {
      firebase.initializeApp(window.FIREBASE_CONFIG || defaultFirebaseConfig);
    }

    // Connect to emulator on localhost
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (isLocal && firebase.auth) {
      try {
        firebase.auth().useEmulator(`http://${window.location.hostname}:9099`);
        console.log('Firebase Auth connected to local emulator at port 9099');
      } catch (err) {
        // Emulator already connected or not available
      }
    }

    // Listen for auth state changes
    firebase.auth().onAuthStateChanged(async user => {
      currentUser = user;
      if (user) {
        try {
          currentToken = await user.getIdToken();
          // Store token in __session cookie for Firebase Hosting rewrite forwarding
          document.cookie = `__session=${currentToken}; path=/; max-age=3600; SameSite=Lax`;
        } catch (e) {
          console.warn('Failed to retrieve ID token:', e);
        }
      } else {
        currentToken = null;
        document.cookie = '__session=; path=/; max-age=0; SameSite=Lax';
      }
    });
  }

  NT.auth = {
    async getToken(forceRefresh = false) {
      if (currentUser) {
        try {
          currentToken = await currentUser.getIdToken(forceRefresh);
          document.cookie = `__session=${currentToken}; path=/; max-age=3600; SameSite=Lax`;
          return currentToken;
        } catch (e) {
          console.warn('Could not refresh ID token', e);
        }
      }
      return currentToken || (document.cookie.match(/(?:^|; )__session=([^;]*)/) || [])[1] || null;
    },

    async login(email, password) {
      if (typeof firebase === 'undefined' || !firebase.auth) {
        throw new Error('Firebase Auth SDK is not loaded.');
      }
      const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
      currentUser = cred.user;
      currentToken = await cred.user.getIdToken(true);
      document.cookie = `__session=${currentToken}; path=/; max-age=3600; SameSite=Lax`;
      return cred.user;
    },

    async logout() {
      if (typeof firebase !== 'undefined' && firebase.auth) {
        await firebase.auth().signOut();
      }
      currentUser = null;
      currentToken = null;
      document.cookie = '__session=; path=/; max-age=0; SameSite=Lax';
    },

    getUser() {
      return currentUser;
    }
  };
})();
