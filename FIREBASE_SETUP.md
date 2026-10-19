# 🔥 Firebase Setup & Deployment Guide — Semil Talent Discovery

The backend has been migrated to **Firebase** (Google Cloud Firestore, Firebase Authentication, Cloud Functions v2, Firebase Cloud Storage, and Firebase Hosting).

---

## 🚀 Quick Start — Running Locally with Firebase Emulators

You can run and test the complete application locally with the Firebase Emulator Suite without incurring any cloud costs or needing a credit card.

### 1. Prerequisites

- **Node.js**: v20+ installed
- **Java Runtime (JRE)**: Required for the Firestore emulator (`java -version`)
- **Firebase CLI**: Already installed globally (`firebase-tools`)

### 2. Install Functions Dependencies

```powershell
cd c:\data\semil-app\semil-app\functions
npm install
```

### 3. Start the Firebase Emulator Suite

From the project root:

```powershell
cd c:\data\semil-app\semil-app
firebase emulators:start
```

This will launch:
| Service | Local URL / Port |
|---------|------------------|
| **Hosting & Web App** | http://localhost:5000 |
| **Cloud Functions (API)** | http://localhost:5001 |
| **Firestore Database** | http://localhost:8080 |
| **Firebase Auth** | http://localhost:9099 |
| **Storage** | http://localhost:9199 |
| **Emulator UI Dashboard** | http://localhost:4000 |

### 4. Seed the Super Admin Account & Default Data

In a second terminal window (while emulators are running):

```powershell
cd c:\data\semil-app\semil-app\functions
$env:FIRESTORE_EMULATOR_HOST="localhost:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST="localhost:9099"
node scripts/firebase-seed.js
```

### 5. Log in to the Application

1. Open your browser to **http://localhost:5000**
2. Sign in with the seeded credentials:
   - **Email**: `admin@semil.local`
   - **Password**: `SemilPass2026!`

---

## 🌐 Deploying to Production (Firebase Cloud)

### 1. Your Firebase Project (`semil-a9cf1`)

Ensure the following are enabled in [Firebase Console](https://console.firebase.google.com/project/semil-a9cf1):
- **Authentication**: Enable the **Email/Password** sign-in provider.
- **Firestore Database**: Create database in **Production mode**.
- **Storage**: Enabled with bucket `semil-a9cf1.firebasestorage.app`.
- **Functions**: Upgraded to Blaze plan (Pay-as-you-go; includes generous free tiers: 2M Cloud Function invocations, 50k Firestore reads/day).

### 2. Login to Firebase CLI

```powershell
cd c:\data\semil-app\semil-app
firebase login
firebase use default
```

### 3. Deploy to Production with One Command

```powershell
cd c:\data\semil-app\semil-app
firebase deploy
```

This deploys:
- ✅ **Cloud Functions** (`api` Express function on Node 20)
- ✅ **Firestore Rules & Indexes** (`firestore.rules`, `firestore.indexes.json`)
- ✅ **Storage Rules** (`storage.rules`)
- ✅ **Hosting** (Static frontend with automatic SSL and global CDN)

Your app will be live at:
- **`https://semil-a9cf1.web.app`**
- **`https://semil-a9cf1.firebaseapp.com`**

### 4. Create Your Super Admin User

In Firebase Console (or with a service account private key):
1. Go to **Authentication** → **Add user**.
2. Enter your admin email and password.
3. Or run the seed script locally with your service account key:
```powershell
cd c:\data\semil-app\semil-app\functions
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccountKey.json"
$env:ADMIN_EMAIL="admin@yourcompany.com"
$env:ADMIN_PASSWORD="YourSecurePasswordHere"
node scripts/firebase-seed.js
```
