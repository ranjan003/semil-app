# Question bank and randomised assessments

Module added by migration `003_question_bank.sql`. All routes are under `/api/qb/*` (`src/qb/routes.js`) and use the existing session authentication; nothing in the login flow was replaced.

## Upload formats

| Format | Rules |
|---|---|
| `.csv` | UTF-8 (windows-1252 accepted as fallback), comma separated, header in row 1. |
| `.xlsx` | Sheet named `Questions` (or the first sheet), header in row 1. No formulas, no macros (`.xlsm` refused). |
| `.docx` | The **first table** in the document, header in the first row, one question per row. No nested tables. |
| `.xls` / `.doc` | Not supported. Save as `.xlsx` / `.docx`. |

Limits: 5 MB, 5,000 rows. Extension, declared MIME type and file signature must agree. ZIP-based files are checked for decompression bombs; XML with DOCTYPE/ENTITY is refused.
Templates for all three formats: **Import > Download template** (`GET /api/qb/templates/csv|xlsx|docx`). Rows whose `question_id` starts with `SAMPLE-` are ignored.

## Template columns

| Column | Required | Notes |
|---|---|---|
| question_id | no | Your own ID; blank = `Q-00001…`. Existing ID = update (when "update existing" is chosen). |
| question_text | yes | 5–2000 characters. |
| question_type | yes | `mcq`, `multi_select`, `descriptive` (`aptitude`/`technical` are read as `mcq`; use `topic` to categorise). |
| option_a … option_d | A, B required for mcq / multi_select | No gaps (C before D). |
| correct_answer | yes for objective | mcq: `B`. multi_select: `A,C`. descriptive: optional model answer. |
| explanation | no | Shown to candidates only if the test's results policy is `score_and_review`. |
| difficulty | yes | `easy`, `medium`, `hard`. |
| job_role | no | Role code; blank or `ALL` = every role. |
| round | yes | 1–5. |
| topic | yes | Category, max 60 characters. |
| marks | yes | > 0, ≤ 100. |
| negative_marks | no | Deducted for a wrong answer; ≤ marks; not for descriptive. |
| status | no | `active` (default) or `inactive`. |

Import flow: upload → **preview** (nothing saved; new / update / duplicate / error / example rows, row-level messages) → **confirm**. Commit runs in one transaction; a second commit of the same preview returns 409. Duplicates = same question type and normalised text in the same round.

## Rounds
Rounds 1–5 are supported and seeded with the existing process names (the spec's four rounds map onto these; the Super Admin can rename them). Each round has duration, total marks, pass %, eligibility (`require_stage`, `min_previous_pct`) and a published flag. Only the Super Admin edits round settings (`config:write`). Candidates are never moved to a later round automatically: the application stage must already equal `round_N` through the existing workflow.

## Randomisation and marking
* Each candidate's paper is drawn on the server from a per-candidate seed (HMAC-SHA256 streams, Fisher-Yates), using the test's rules (topic × difficulty × count). Question order and each question's option order are shuffled independently; options such as "None of the above" can be locked.
* Stored: question IDs, option order, generator version, blueprint version, assignment time. The paper is created once and reused on refresh, logout/resume and reconnect.
* Candidate endpoints never return `correct_answer`, `explanation` or reference answers (until a result is published with review enabled). Responses are stored as positions and mapped back server-side.
* Objective questions are all-or-nothing; negative marks apply to wrong answers; score floors at 0. Descriptive answers are marked manually; result becomes `final` when all are reviewed.
* Server owns the deadline; autosave is revision-guarded; submit is idempotent; a sweeper submits abandoned attempts after the deadline.

## Permissions
| Permission | Super Admin | HR admin | Candidate |
|---|---|---|---|
| qbank:read / write / import | yes | yes | – |
| assessment:publish, results:read, results:publish | yes | yes | – |
| config:write (round settings) | yes | – | – |
| `/api/qb/my/*` | – | – | own attempts only (others return 404) |

Every admin write is recorded in the audit log (History tab, `GET /api/qb/audit`).

## Camera and microphone checks (live, not recorded)
Migration `004_camera_monitor.sql`. A test can set **Camera and microphone: Required** (test builder).
* The candidate sees a consent notice, and the browser asks for camera and microphone permission before the test starts. If it is refused, the test does not start and the timer does not begin.
* A small live preview of the candidate's own camera stays on screen ("Camera and mic on · not recorded").
* Video and sound are analysed **on the candidate's device**. No video, audio or image is recorded, uploaded or stored. The server receives only short alert codes: `camera_on`, `no_face`, `multiple_faces`, `camera_covered`, `loud_noise`, `face_check_unavailable`, `camera_lost`, `mic_lost`.
* Alerts are stored as attempt events and shown to HR (a "camera alerts" chip in Results and the timeline in the attempt). They never fail or block a candidate by themselves.
* `camera_lost` / `mic_lost` (device switched off, permission removed) count like leaving the window: the test lock mode decides between a warning and an immediate pause for HR review.
* Face counting uses the browser's built-in `FaceDetector` where it exists (some Chrome versions). Where it does not, only the camera-covered and sound checks run and `face_check_unavailable` is logged once.
* Limits: automatic checks can be wrong (poor light, weak devices). They are prompts for a person to review, not proof. Get legal advice on consent and privacy notices (for India, the DPDP Act) before use. A live video view for an invigilator is not included.
* Rollback: `db/rollback/004_camera_monitor.down.sql` (run before the 003 rollback).

## Rollback
1. Export the bank first (Question bank > Export) and the results (Results > Export).
2. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f db/rollback/003_question_bank.down.sql` — drops only the objects created by 003; earlier data is untouched (verified by `scripts/test-db.sh`).
3. Redeploy the previous code version. The legacy answer/submit routes are unchanged for non-bank attempts.

## Tests
`npm test` (84 tests; DB-backed ones skip without Postgres), `npm run test:db` (migrations, constraints, rollback), `npm run test:e2e` (Playwright, mobile + desktop).
