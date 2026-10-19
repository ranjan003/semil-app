#!/usr/bin/env bash
# Applies every migration to a throwaway database, runs each constraint-check file, and verifies that
# the number of refused writes equals the "-- EXPECT_ERRORS: N" marker at the top of that file.
# Also proves the 003 rollback leaves the earlier schema intact and can be re-applied.
# Usage: PGHOST=... PGPORT=... PGUSER=... bash scripts/test-db.sh
set -euo pipefail
DB=semil_schema_test
psql -X -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" 2>&1 | grep -v NOTICE || true
for f in db/migrations/*.sql; do psql -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f "$f"; done
status=0
for f in test/schema_checks.sql test/schema_checks_003.sql; do
  want=$(sed -n 's/^-- EXPECT_ERRORS: \([0-9]*\).*/\1/p' "$f" | head -1)
  out=$(psql -X -q -d $DB -f "$f" 2>&1 || true)
  got=$(grep -c "ERROR:" <<<"$out" || true)
  if [ "$got" = "$want" ]; then echo "PASS $f: $got of $want invalid writes were refused"; else echo "FAIL $f: expected $want refusals, got $got"; echo "$out"; status=1; fi
done
grep -q "Q-00022" <<<"$(psql -X -q -d $DB -Atc "select question_code from question_bank where text_hash='x15'")" && echo "PASS code generator skips taken codes" || { echo "FAIL code generator"; status=1; }
# 004 (camera monitoring) rolls back first; its rollback must leave the earlier schema valid
psql -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f db/rollback/004_camera_monitor.down.sql
m=$(psql -X -d $DB -Atc "select count(*) from information_schema.columns where table_name='assessments' and column_name='monitor_mode'")
[ "$m" = "0" ] && echo "PASS 004 rollback removed monitor_mode" || { echo "FAIL 004 rollback"; status=1; }
psql -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f db/rollback/003_question_bank.down.sql
left=$(psql -X -d $DB -Atc "select count(*) from information_schema.tables where table_schema='public' and table_name in ('question_bank','attempt_papers','round_settings')")
cand=$(psql -X -d $DB -Atc "select count(*) from candidates")
[ "$left" = "0" ] && [ "$cand" -ge 1 ] && echo "PASS rollback removed 003 objects and kept earlier data" || { echo "FAIL rollback"; status=1; }
psql -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f db/migrations/003_question_bank.sql && echo "PASS 003 re-applies after rollback"
psql -X -q -d $DB -v ON_ERROR_STOP=1 -1 -f db/migrations/004_camera_monitor.sql && echo "PASS 004 re-applies after rollback"
exit $status
