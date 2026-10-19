-- EXPECT_ERRORS: 17
-- Constraint checks for 003_question_bank.sql. Every statement marked "EXPECT FAIL" must be refused by the database.
\set ON_ERROR_STOP off
SET client_min_messages = warning;

-- valid rows of each type
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,role_code,round,topic,marks,negative_marks,text_hash)
  VALUES ('Which HTTP method is idempotent?','mcq','["POST","PUT","PATCH","CONNECT"]','1','medium','SDE',1,'Technical',2,0.5,'h1');
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,role_code,round,topic,marks,negative_marks,text_hash)
  VALUES ('Select all safe HTTP methods.','multi_select','["GET","POST","HEAD","DELETE"]','[0,2]','easy',NULL,1,'Technical',3,1,'h2');
INSERT INTO question_bank(question_text,type,difficulty,role_code,round,topic,marks,text_hash,reference_answer)
  VALUES ('Explain what a database index does.','descriptive','easy','SDE',1,'Technical',5,'h3','An index speeds up reads at the cost of writes.');
SELECT 'OK generated codes: ' || string_agg(question_code, ',' ORDER BY question_code) FROM question_bank;

-- EXPECT FAIL 1: mcq answer index beyond the options
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Index out of range question','mcq','["a","b"]','3','easy',1,'T',1,'x1');
-- EXPECT FAIL 2: mcq answer stored as a list
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Answer is a list question','mcq','["a","b"]','[0]','easy',1,'T',1,'x2');
-- EXPECT FAIL 3: multi-select with one correct answer
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Only one answer given multi','multi_select','["a","b","c"]','[1]','easy',1,'T',1,'x3');
-- EXPECT FAIL 4: descriptive with options
INSERT INTO question_bank(question_text,type,options,difficulty,round,topic,marks,text_hash) VALUES ('Descriptive with options here','descriptive','["a","b"]','easy',1,'T',1,'x4');
-- EXPECT FAIL 5: descriptive with negative marks
INSERT INTO question_bank(question_text,type,difficulty,round,topic,marks,negative_marks,text_hash) VALUES ('Descriptive with penalty here','descriptive','easy',1,'T',2,1,'x5');
-- EXPECT FAIL 6: negative marks larger than marks
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,negative_marks,text_hash) VALUES ('Penalty bigger than marks one','mcq','["a","b"]','0','easy',1,'T',1,2,'x6');
-- EXPECT FAIL 7: only one option
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Single option question text','mcq','["a"]','0','easy',1,'T',1,'x7');
-- EXPECT FAIL 8: five options
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Five options question text','mcq','["a","b","c","d","e"]','0','easy',1,'T',1,'x8');
-- EXPECT FAIL 9: same wording in the same round while still in use
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Which HTTP method is idempotent?','mcq','["a","b"]','0','easy',1,'T',1,'h1');
-- OK: the same wording is allowed in another round
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Which HTTP method is idempotent?','mcq','["a","b"]','0','easy',2,'T',1,'h1');
-- OK: and again in round 1 once the original is archived
UPDATE question_bank SET status='archived' WHERE text_hash='h1' AND round=1;
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Which HTTP method is idempotent?','mcq','["a","b"]','0','easy',1,'T',1,'h1');
-- EXPECT FAIL 10: question code reused with different case
INSERT INTO question_bank(question_code,question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('q-00001','Code reuse in other case','mcq','["a","b"]','0','easy',3,'T',1,'x10');
-- EXPECT FAIL 11: code with a space
INSERT INTO question_bank(question_code,question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('bad code!','Code with bad characters','mcq','["a","b"]','0','easy',3,'T',1,'x11');
-- EXPECT FAIL 12: lower-case role
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,role_code,round,topic,marks,text_hash) VALUES ('Lower case role question','mcq','["a","b"]','0','easy','sde',3,'T',1,'x12');
-- EXPECT FAIL 13: round 6
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Round six does not exist','mcq','["a","b"]','0','easy',6,'T',1,'x13');
-- OK: an admin-chosen code does not break the generator, which skips it
SELECT setval('question_code_seq', 20) > 0;
INSERT INTO question_bank(question_code,question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Q-00021','Admin chosen code question','mcq','["a","b"]','0','easy',3,'T',1,'x14');
INSERT INTO question_bank(question_text,type,options,correct_answer,difficulty,round,topic,marks,text_hash) VALUES ('Generated after a taken code','mcq','["a","b"]','0','easy',3,'T',1,'x15');
SELECT 'OK generator skipped the taken code, next is ' || question_code FROM question_bank WHERE text_hash='x15';

-- attempt chain
INSERT INTO users(email,password_hash,full_name,role) VALUES ('qb-cand@example.com','x','QB Candidate','candidate');
INSERT INTO vacancies(title,role_code) VALUES ('QB Role','SDE');
INSERT INTO candidates(full_name,email,phone,user_id) SELECT 'QB Candidate','qb-cand@example.com','9800000001',id FROM users WHERE email='qb-cand@example.com';
INSERT INTO applications(candidate_id,vacancy_id) SELECT c.id,v.id FROM candidates c, vacancies v WHERE c.email='qb-cand@example.com' AND v.title='QB Role';
INSERT INTO assessments(title,type,round,source) VALUES ('QB Assessment','bank',1,'bank');
INSERT INTO assignments(assessment_id,assessment_version,application_id) SELECT a.id,1,ap.id FROM assessments a, applications ap WHERE a.title='QB Assessment' AND ap.candidate_id=(SELECT id FROM candidates WHERE email='qb-cand@example.com');
INSERT INTO attempts(assignment_id,attempt_no) SELECT id,1 FROM assignments WHERE assessment_id=(SELECT id FROM assessments WHERE title='QB Assessment');
INSERT INTO attempt_papers(attempt_id,seed,generator_version,assessment_version,blueprint,total_marks) SELECT id,'abcd','v1',1,'{}',5 FROM attempts WHERE assignment_id IN (SELECT id FROM assignments WHERE assessment_id=(SELECT id FROM assessments WHERE title='QB Assessment'));
INSERT INTO attempt_questions(attempt_id,position,bank_question_id,question_code,question_version,snapshot,option_order,marks) SELECT a.id,1,q.id,q.question_code,1,'{}','[1,0]',2 FROM attempts a, question_bank q WHERE q.text_hash='h2';
-- EXPECT FAIL 14: same position twice in one paper
INSERT INTO attempt_questions(attempt_id,position,bank_question_id,question_code,question_version,snapshot,option_order,marks) SELECT a.id,1,q.id,q.question_code,1,'{}','[0,1]',2 FROM attempts a, question_bank q WHERE q.text_hash='h3';
-- EXPECT FAIL 15: same bank question twice in one paper
INSERT INTO attempt_questions(attempt_id,position,bank_question_id,question_code,question_version,snapshot,option_order,marks) SELECT a.id,2,q.id,q.question_code,1,'{}','[0,1]',2 FROM attempts a, question_bank q WHERE q.text_hash='h2';
-- EXPECT FAIL 16: results policy outside the list
INSERT INTO assessment_blueprints(assessment_id,results_policy) SELECT id,'everything' FROM assessments WHERE title='QB Assessment';
-- EXPECT FAIL 17: a round that does not exist
INSERT INTO round_settings(round,name) VALUES (6,'Round six');
SELECT 'OK paper rows: ' || count(*) FROM attempt_questions;
