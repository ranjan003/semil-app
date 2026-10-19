# 🔥 Firebase Setup & Deployment — Semil Talent Discovery

This project uses **Firebase Authentication** in the browser and a single **Express API**
(`api/index.js` on Vercel, or the `api` Cloud Function) for all database access.
The browser never writes to Firestore directly. The API uses the Firebase Admin SDK and
enforces role permissions on the server.

Firebase project: **`semil-a9cf1`**

---

## 1. Firebase Console checklist

1. **Authentication → Sign-in method**
   - Enable **Email/Password**.
   - Enable **Google**. Set the project support e-mail and save.
2. **Authentication → Settings → Authorized domains**
   - `localhost` (already present by default)
   - `semil-a9cf1.web.app`
   - `semil-a9cf1.firebaseapp.com`
   - Your Vercel production domain, for example `semil-app.vercel.app`
   - Any custom domain you use
   - Vercel **preview** URLs are different for every deployment. Either add the preview
     domain you are testing or use the production domain for Google sign-in.
3. **Firestore Database** — create the database in production mode if it does not exist.
4. **Project settings → Service accounts → Generate new private key**.
   Keep the downloaded JSON private; it is never put in the frontend.

---

## 2. Vercel environment variables

Add these under **Project → Settings → Environment Variables** for Production,
Preview and Development, then redeploy.

| Variable | Required | Purpose |
|---|---|---|
| `FIREBASE_API_KEY` | yes | Public web API key (already in `.env.example`) |
| `FIREBASE_AUTH_DOMAIN` | yes | `semil-a9cf1.firebaseapp.com` |
| `FIREBASE_PROJECT_ID` | yes | `semil-a9cf1` |
| `FIREBASE_STORAGE_BUCKET` | yes | `semil-a9cf1.firebasestorage.app` |
| `FIREBASE_APP_ID` | yes | Web app id from Project settings |
| `FIREBASE_MESSAGING_SENDER_ID` | yes | Web app sender id |
| `FIREBASE_SERVICE_ACCOUNT` | **yes for Firestore** | The **entire service-account JSON on one line** |
| `ADMIN_EMAILS` | recommended | Comma-separated e-mails that become Super Admin after a valid Firebase login |
| `FIREBASE_DISABLE_RTDB_FALLBACK` | recommended (`true`) | Prevents writing to the legacy Realtime Database when the service account is missing |
| `SESSION_SECRET` | optional | 32+ random characters for local session helpers |

> Never put `FIREBASE_SERVICE_ACCOUNT` in `public/`, `config.js`, or any browser file.
> The web config (`FIREBASE_API_KEY`, etc.) is public by design.

The browser configuration is generated server-side at **`/config.js`** from these
variables, so the deployed build uses the correct Firebase project automatically.

---

## 3. Deploy security rules (important)

The repository contains:

- `firestore.rules` — denies direct browser access; all access goes through the API.
- `database.rules.json` — disables anonymous Realtime Database access; only signed-in
  requests are accepted for the legacy fallback.
- `storage.rules` — private file storage rules.

Deploy them from the repository root:

```powershell
firebase login
firebase use semil-a9cf1
firebase deploy --only firestore:rules,database,storage
```

Without this step the project may still have the **public test-mode rules**, which allow
anyone on the internet to read and write the database. Verify in
**Firebase Console → Firestore → Rules** that the published rules contain
`allow read, write: if false;`.

---

## 4. Move existing Realtime Database data to Firestore

The previous build fell back to the Realtime Database when no service account was present.
Once `FIREBASE_SERVICE_ACCOUNT` (or `GOOGLE_APPLICATION_CREDENTIALS` locally) is available:

```powershell
cd semil-app
$env:GOOGLE_APPLICATION_CREDENTIALS="C:\path\to\serviceAccountKey.json"
$env:FIREBASE_DATABASE_URL="https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app"
node scripts/migrate-rtdb-to-firestore.js --dry-run
node scripts/migrate-rtdb-to-firestore.js
```

The script keeps document ids, merges into existing Firestore documents and never deletes
fields. It also copies nested sub-collections (`versions`, `applications`, `events`, …).

After migrating, set `FIREBASE_DISABLE_RTDB_FALLBACK=true` in Vercel and redeploy.
New questions, tests and attempts will then be written to **Cloud Firestore**.

---

## 5. Roles and the first admin

New e-mail/password and Google sign-ups are created with the **candidate** role. This is
deliberate: a public sign-up form must not be able to grant staff access.

To make an account a Super Admin, either:

- add its e-mail to `ADMIN_EMAILS` in Vercel and sign in with that account, or
- edit `users/{uid}.role` in **Firestore → Data** to `super_admin` / `hr_admin`.

The profile document id is the Firebase UID, so repeat sign-ins never create duplicate
profiles and never overwrite an existing role.

---

## 6. Verify the deployment

| Check | Expected |
|---|---|
| `https://your-domain/healthz` | `{ "ok": true, "dataBackend": "firestore" }` |
| `https://your-domain/api/health/firebase` | `firestoreConfigured: true`, correct `projectId` |
| `/config.js` | contains the project id / auth domain |
| Sign up with e-mail | profile created, candidate portal opens |
| Sign in after refresh | session is restored without a redirect loop |
| Google button | Google account chooser opens; otherwise check the authorized domain |
| Rounds / Tests tabs | render without a blank page |
| New question / New test | appears immediately and after refresh |
| Browser Console | no `permission-denied`, `auth/unauthorized-domain` or 500 errors |

### Local development

```powershell
npm install
npm start
# http://localhost:3000
```

For local Firestore/Auth emulators:

```powershell
$env:FIRESTORE_EMULATOR_HOST="localhost:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST="localhost:9099"
node semil-app/functions/src/dev-server.js
```

When using the emulators, set `window.FIREBASE_USE_EMULATOR = true` in the browser
(developer console) before signing in, or add
`<script>window.FIREBASE_USE_EMULATOR = true;</script>` temporarily.

---

## 7. Common errors

| Message | Cause / fix |
|---|---|
| `auth/unauthorized-domain` | Add the Vercel/custom domain under Authentication → Settings → Authorized domains |
| `auth/operation-not-allowed` | Enable Email/Password or Google in Authentication → Sign-in method |
| `auth/invalid-credential` | Wrong password, or the account was created with Google only |
| `permission-denied` / 403 | Check `users/{uid}.role` and the `ADMIN_EMAILS` override |
| `firebase_not_configured` (503) | `FIREBASE_SERVICE_ACCOUNT` is missing in Vercel; add it and redeploy |
| Data appears in Realtime Database but not Firestore | Service account is not configured, or the migration has not been run; see section 4 |
