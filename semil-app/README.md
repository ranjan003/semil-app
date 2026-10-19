# Semil Talent Discovery (backend foundation)

> **Current deployment:** Firebase Authentication + Cloud Firestore, served by the Express
> API in `api/index.js` on Vercel. See [FIREBASE_SETUP.md](FIREBASE_SETUP.md) for the
> Firebase Console, Vercel environment variable, security-rule and data-migration steps.
> The PostgreSQL/Docker material below is the original backend reference and is not used
> by the Firebase deployment.

Recruitment, assessment and onboarding platform for Semil Retail Industries.
This is the first backend slice: database, authentication, role permissions, candidates,
private resume storage, vacancies, evaluations and the weighted scoring engine.
`prototype.html` is the clickable UI prototype; the React app will be built on this API.

## Quick Start (Development)
```bash
cp .env.example .env          # set DATABASE_URL and a 32+ character STORAGE_SIGNING_SECRET
npm install
npm run migrate               # creates all tables
ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='a-long-passphrase-1' npm run seed
npm start                     # API on :3000, health check at /healthz
npm test                      # unit tests (no database needed)
PGHOST=localhost PGUSER=postgres bash scripts/test-db.sh   # schema constraint tests
```

## Docker Deployment (Production)
```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD, STORAGE_SIGNING_SECRET, SMTP_* etc.

# 2. Start all services (app + PostgreSQL + Redis + MinIO + Nginx)
docker compose up -d

# 3. Run database migrations
docker compose exec app node src/migrate.js

# 4. Create the admin user
docker compose exec app node scripts/seed.js

# 5. (Optional) Create SSL certs for HTTPS
mkdir -p certs
# Place server.crt and server.key in certs/
# Or use Let's Encrypt: certbot certonly --webroot -w /var/www/certbot -d yourdomain.com

# 6. View logs
docker compose logs -f app
```

### Services
| Service | Port | Description |
|---------|------|-------------|
| `app` | 3000 | Node.js API + WebSocket |
| `postgres` | 5432 | PostgreSQL 16 |
| `redis` | 6379 | Redis 7 (sessions, rate limiting, pub/sub) |
| `minio` | 9000 / 9001 | S3-compatible storage (API / Console) |
| `nginx` | 80 / 443 | Reverse proxy with HTTPS |

### MinIO Console
Access at `http://localhost:9001` with the credentials from your `.env`.

## Architecture

### Plugins

| Plugin | Module | Description |
|--------|--------|-------------|
| **Email** | `src/mailer.js` | Nodemailer over SMTP; templated emails for password resets, interview invites, test notifications, offer letters |
| **S3 Storage** | `src/storage-s3.js` | AWS S3 / MinIO / DigitalOcean Spaces with presigned URLs; factory in `src/storage-factory.js` |
| **Redis** | `src/redis.js` | Redis-backed rate limiter, session cache, and pub/sub for cross-server events |
| **WebSocket** | `src/realtime.js` | Socket.IO for live proctoring alerts, notifications, and dashboard updates |
| **Camera Proctoring** | `src/camera.js` | Browser-side camera/mic analysis; server logs alert codes only (no media stored) |
| **Reports** | `src/reports.js` | Dashboard KPIs, funnel metrics, college analytics, CSV exports |

### Plugin Fallbacks
All plugins gracefully fall back for development:
- **No SMTP_HOST** → emails logged to console
- **No S3_BUCKET** → local disk storage (`./storage`)
- **No REDIS_URL** → in-memory rate limiter and no session cache
- **WebSocket** always works (Redis pub/sub only needed for multi-server)

## What is in place
| Area | Where | Notes |
|---|---|---|
| Schema (29+ tables) | `db/migrations/001_init.sql` | candidates, applications, assessments, attempts, submissions, evaluations, interviews, offers, audit log |
| Auth | `src/app.js`, `src/sessions.js`, `src/passwords.js` | scrypt hashes, hashed session tokens, 30 min idle / 12 h absolute expiry, lockout after 5 failures, password reset |
| Permissions | `src/permissions.js` | per-role capabilities plus per-record checks; internal notes and answer keys never serialised to candidates |
| Files | `src/storage.js`, `src/storage-s3.js` | private storage, magic-byte type checks, size limits, 10-minute signed links bound to the user |
| Scoring | `src/scoring.js` | configurable weights and thresholds; missing rounds are never zero; documented overrides |
| Test lock | `src/proctoring.js`, `002_test_lock_and_imports.sql`, `/api/attempts/*` | leaving the test window blocks the attempt; the server holds the clock and status; only HR or the Super Admin can reinstate, with a written reason |
| Camera monitoring | `src/camera.js`, `004_camera_monitor.sql`, `/api/attempts/*/monitor` | browser analyses video/sound locally, sends only alert codes; HR sees alerts in real time |
| Question import | `src/importer.js`, `/api/questions/import*` | CSV or JSON for rounds 1 to 5, row-by-row checking, nothing saved until confirmed |
| Audit | `audit_logs` table | append-only (database trigger blocks update and delete) |
| Scheduling | `interviews` table | database exclusion constraint blocks overlapping interviews per interviewer |
| Reports | `src/reports.js`, `/api/reports/*` | dashboard KPIs, funnel metrics, college analytics, CSV exports for candidates/scores/audit |
| Real-time | `src/realtime.js`, WebSocket at `/ws` | live proctoring alerts, notifications, dashboard updates |

## Question bank and randomised assessments
See [docs/QUESTION_BANK.md](docs/QUESTION_BANK.md): upload formats and template columns, randomisation, permissions, rollback. The browser UI is served from `public/`.

## About the test lock
A web page cannot stop someone opening another tab or app. It can detect that the test window lost focus,
left full screen or was hidden, then block the attempt. The server decides what that means, so refreshing,
editing the page or going offline does not unblock it. It cannot see a second device or a phone beside the
laptop. For high-stakes tests add a locked-down exam browser or camera proctoring later.
Modes per assessment: `strict` (block on first exit), `warn` (two warnings, then block), `off` (log only).

## API Endpoints (Summary)

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | End session |
| GET | `/api/me` | Current user |
| POST | `/api/auth/forgot` | Request password reset email |
| POST | `/api/auth/reset` | Reset password with token |

### Candidates
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates` | List (filtered, paginated) |
| POST | `/api/candidates` | Create |
| GET | `/api/candidates/:id` | Detail |
| PATCH | `/api/candidates/:id` | Update |
| DELETE | `/api/candidates/:id` | Soft delete |

### Documents
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/candidates/:id/documents` | Upload file |
| GET | `/api/documents/:id/link` | Get signed download link |

### Vacancies
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/vacancies` | List (role-filtered) |
| POST | `/api/vacancies` | Create |
| PATCH | `/api/vacancies/:id` | Update |
| POST | `/api/vacancies/:id/status` | Change status |
| POST | `/api/vacancies/:id/duplicate` | Duplicate |

### Assessments & Proctoring
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/attempts/:id/events` | Report proctoring violation |
| PUT | `/api/attempts/:id/answers/:qid` | Save answer |
| POST | `/api/attempts/:id/submit` | Submit attempt |
| POST | `/api/attempts/:id/resume` | Start/resume attempt |
| POST | `/api/attempts/:id/reinstate` | HR reinstates blocked attempt |
| POST | `/api/attempts/:id/monitor` | Camera/mic alert |
| POST | `/api/attempts/:id/monitor/batch` | Batch camera alerts |
| GET | `/api/attempts/:id/monitor/summary` | Alert summary (HR only) |

### Evaluations & Scoring
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/applications/:id/stage` | Change stage |
| POST | `/api/applications/:id/evaluations` | Submit evaluation |
| GET | `/api/applications/:id/score` | Get weighted score |
| PUT | `/api/scoring/config` | Update scoring config |
| POST | `/api/applications/:id/override` | Record score override |

### Reports & Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reports/dashboard` | Dashboard KPIs |
| GET | `/api/reports/colleges` | College-wise analytics |
| GET | `/api/reports/scoring` | Scoring summary |
| GET | `/api/reports/interviews` | Interview schedule |
| GET | `/api/reports/sources` | Source effectiveness |
| GET | `/api/reports/export/candidates` | CSV: candidates |
| GET | `/api/reports/export/scores` | CSV: scores |
| GET | `/api/reports/export/audit` | CSV: audit log |
| GET | `/api/reports/export/funnel` | CSV: hiring funnel |

### WebSocket (Socket.IO at `/ws`)
| Event | Direction | Description |
|-------|-----------|-------------|
| `proctor` | Server → Client | Live camera/proctoring alerts |
| `attempt` | Server → Client | Attempt status changes |
| `notifications` | Server → Client | User notifications |
| `dashboard` | Server → Client | Dashboard KPI updates |

## Before going live
- Serve over HTTPS only (`NODE_ENV=production` makes the session cookie `Secure`).
- Use S3/MinIO for file storage (set `S3_BUCKET` in `.env`).
- Configure a real SMTP sender for invitations and password resets.
- Set up Redis for multi-server session sharing and rate limiting.
- Schedule daily database backups with point-in-time recovery, and test a restore.
- Place SSL certificates in `certs/` for the Nginx reverse proxy.
