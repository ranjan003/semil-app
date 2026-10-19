-- EXPECT_ERRORS: 10
-- Each block must raise; the runner expects every "EXPECT FAIL" to fail and the happy path to pass.
\set ON_ERROR_STOP off
INSERT INTO users(email,password_hash,full_name,role) VALUES ('hr@example.com','x','HR One','hr_admin'),('tech@example.com','x','Tech One','technical_assessor');
INSERT INTO vacancies(title,role_code,status) VALUES ('SDE I','SDE','active');
INSERT INTO candidates(full_name,email,phone) VALUES ('Aarav Nair','aarav@example.com','+919812345678'),('Diya Menon','diya@example.com','9898989898');
INSERT INTO applications(candidate_id,vacancy_id) SELECT c.id,(SELECT id FROM vacancies LIMIT 1) FROM candidates c;
SELECT 'OK candidate codes: ' || string_agg(candidate_code, ',' ORDER BY candidate_code) FROM candidates;
-- EXPECT FAIL: duplicate email differing only by case
INSERT INTO candidates(full_name,email,phone) VALUES ('Dup','AARAV@example.com','9811111111');
-- EXPECT FAIL: bad phone
INSERT INTO candidates(full_name,email,phone) VALUES ('Bad Phone','bp@example.com','12345');
-- EXPECT FAIL: manual stage change without reason
INSERT INTO stage_changes(application_id,to_stage,manual,reason) SELECT id,'rejected',true,'' FROM applications LIMIT 1;
-- OK: manual stage change with reason
INSERT INTO stage_changes(application_id,to_stage,manual,reason) SELECT id,'on_hold',true,'Awaiting documents' FROM applications LIMIT 1;
-- OK first interview, EXPECT FAIL overlapping one for same interviewer
INSERT INTO interviews(application_id,round,interviewer_id,starts_at,duration_minutes) SELECT a.id,5,u.id,'2026-10-14 10:00+05:30',45 FROM applications a, users u WHERE u.role='technical_assessor' LIMIT 1;
INSERT INTO interviews(application_id,round,interviewer_id,starts_at,duration_minutes) SELECT a.id,5,u.id,'2026-10-14 10:30+05:30',45 FROM applications a, users u WHERE u.role='technical_assessor' OFFSET 1 LIMIT 1;
-- OK: back to back is allowed
INSERT INTO interviews(application_id,round,interviewer_id,starts_at,duration_minutes) SELECT a.id,5,u.id,'2026-10-14 10:45+05:30',45 FROM applications a, users u WHERE u.role='technical_assessor' OFFSET 1 LIMIT 1;
-- EXPECT FAIL: submitted evaluation without evidence
INSERT INTO evaluations(application_id,round,evaluator_id,total_score,status,submitted_at) SELECT a.id,1,u.id,70,'submitted',now() FROM applications a, users u WHERE u.role='technical_assessor' LIMIT 1;
-- EXPECT FAIL: weights not summing to 100
UPDATE scoring_config SET weights='{"1":20,"2":20,"3":20,"4":30,"5":15}';
-- EXPECT FAIL: audit log update and delete
INSERT INTO audit_logs(action,entity_type) VALUES ('test','x');
UPDATE audit_logs SET action='tamper';
DELETE FROM audit_logs;
-- EXPECT FAIL: MCQ without correct answer
INSERT INTO assessments(title,type,round) VALUES ('T','mcq',1);
INSERT INTO questions(assessment_id,position,kind,prompt) SELECT id,1,'mcq','Q?' FROM assessments LIMIT 1;
-- EXPECT FAIL: submission with neither link nor file
INSERT INTO submissions(application_id,round) SELECT id,4 FROM applications LIMIT 1;
