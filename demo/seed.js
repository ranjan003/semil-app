'use strict';
const { textHash } = require('../semil-app/src/qb/schema');

// Realistic starter content so the demo is usable straight away. Everything here is invented sample data.
function seedData(uid) {
  const t0 = new Date(Date.now() - 3 * 86400000).toISOString();
  const users = [
    { id: uid(), email: 'admin@semil.demo', full_name: 'Sanjay Super Admin', role: 'super_admin' },
    { id: uid(), email: 'hr@semil.demo', full_name: 'Hannah HR', role: 'hr_admin' },
  ];
  const cands = [
    ['Asha Candidate', 'asha@semil.demo', 'SDE', 'round_1'], ['Rahul Verma', 'rahul@semil.demo', 'DATA_ANALYST', 'round_1'], ['Meera Iyer', 'meera@semil.demo', 'SDE', 'round_1'],
    ['Karthik S', 'karthik@semil.demo', 'SDE', 'round_2'], ['Divya N', 'divya@semil.demo', 'DATA_ANALYST', 'applied'],
  ];
  const candidates = cands.map(([name, email, role, stage], i) => {
    const u = { id: uid(), email, full_name: name, role: 'candidate' }; users.push(u);
    return { id: uid(), user_id: u.id, candidate_code: 'NT-C' + String(1001 + i), full_name: name, email, role_code: role, stage, application_id: uid() };
  });
  const rounds = [
    [1, 'Skills-Based Shortlisting', 45, 50, true, true], [2, 'Group Project Development', 60, 50, true, false], [3, 'Mindset and Reasoning Assessment', 45, 50, true, false],
    [4, 'Individual Practical Creation', 90, 60, true, false], [5, 'HR and Founder Interview', 45, 50, true, false],
  ].map(([round, name, d, p, enabled, published]) => ({ round, name, description: null, enabled, published, duration_minutes: d, pass_threshold_pct: p, eligibility: { require_stage: true, min_previous_pct: null }, updated_at: t0 }));

  const questions = []; let n = 1;
  const add = (o) => {
    const q = { id: uid(), question_code: 'Q-' + String(n++).padStart(5, '0'), reference_answer: null, explanation: null, role_code: null, negative_marks: 0, shuffle_options: true, status: 'active', version: 1, import_batch_id: null, created_at: t0, updated_at: t0, versions: [{ version: 1, change_note: 'Created', changed_at: t0, changed_by: 'Seed data' }], ...o };
    q.text_hash = textHash(q.question_text, q.type); questions.push(q);
  };
  const MARKS = { easy: [1, 0.25], medium: [2, 0.5], hard: [3, 1] };
  const mcq = (round, topic, difficulty, text, opts, right, explanation, role) => { const [m, ng] = MARKS[difficulty]; add({ round, topic, difficulty, question_text: text, type: 'mcq', options: opts, correct_answer: right, explanation, role_code: role || null, marks: m, negative_marks: ng }); };
  const multi = (round, topic, difficulty, text, opts, right, explanation, role) => { const [m, ng] = MARKS[difficulty]; add({ round, topic, difficulty, question_text: text, type: 'multi_select', options: opts, correct_answer: right, explanation, role_code: role || null, marks: m + 1, negative_marks: ng }); };
  const written = (round, topic, difficulty, text, ref, role) => add({ round, topic, difficulty, question_text: text, type: 'descriptive', options: null, correct_answer: null, reference_answer: ref, marks: 5, negative_marks: 0, role_code: role || null });
  const shuffleIdx = (opts, right, k) => { const o = opts.slice(); const rot = k % 4; const r = o.splice(0, rot); o.push(...r); return { opts: o, right: (right - rot + 4) % 4 }; };

  // ---- Round 1 Aptitude: numeric, generated with exact answers
  const fmt = x => String(Math.round(x * 100) / 100);
  const apt = (difficulty, i, text, ans, wrongs, why) => { const all = [ans, ...wrongs].map(fmt); const s = shuffleIdx(all, 0, i + 1); mcq(1, 'Aptitude', difficulty, text, s.opts, s.right, why); };
  [[200, 15], [640, 25], [90, 40], [1250, 8]].forEach(([a, p], i) => apt('easy', i, `What is ${p}% of ${a}?`, a * p / 100, [a * p / 100 + 5, a * p / 100 - 4, a * p / 10], `${p}% of ${a} = ${a} × ${p}/100 = ${a * p / 100}.`));
  [[12, 5, 60], [8, 7, 56], [15, 4, 60], [9, 9, 81]].forEach(([a, b, c], i) => apt('easy', i + 4, `A shop sells pens in packs of ${a}. How many pens are in ${b} packs?`, a * b, [a * b + a, a * b - b, a + b], `${a} × ${b} = ${a * b}.`));
  [[60, 3, 1.5], [45, 4, 2], [72, 5, 3], [80, 2.5, 4]].forEach(([sp, h], i) => apt('medium', i, `A bus travels at ${sp} km/h for ${h} hours. What distance does it cover (in km)?`, sp * h, [sp * h + 20, sp * h - 15, sp + h], `Distance = speed × time = ${sp} × ${h} = ${sp * h} km.`));
  [[5000, 8, 2], [8000, 5, 3], [12000, 10, 2], [6400, 5, 5]].forEach(([pr, r, y], i) => apt('medium', i + 4, `Find the simple interest on ₹${pr} at ${r}% per annum for ${y} years (in ₹).`, pr * r * y / 100, [pr * r * y / 100 + 100, pr * r * y / 100 - 80, pr * r / 100], `SI = P × R × T / 100 = ${pr} × ${r} × ${y} / 100 = ${pr * r * y / 100}.`));
  [[3, 5, 40], [2, 3, 30], [4, 7, 88], [5, 6, 66]].forEach(([a, b, tot], i) => { const part = tot * a / (a + b); apt('hard', i, `₹${tot} is divided between two people in the ratio ${a}:${b}. How much does the first person get (in ₹)?`, part, [tot * b / (a + b), part + 2, part - 3], `First share = ${tot} × ${a}/${a + b} = ${part}.`); });
  [[4, 12], [6, 9], [3, 6], [10, 15]].forEach(([a, b], i) => { const t = a * b / (a + b); apt('hard', i + 4, `Pipe A fills a tank in ${a} hours and pipe B in ${b} hours. Working together, how many hours do they take (to 2 decimals)?`, t, [(a + b) / 2, t + 0.5, a * b / (a + b + 1)], `Combined rate = 1/${a} + 1/${b}; time = ${a}×${b}/(${a}+${b}) = ${fmt(t)} hours.`); });
  multi(1, 'Aptitude', 'medium', 'Which of these numbers are prime?', ['2', '9', '11', '15'], [0, 2], '2 and 11 have no divisors other than 1 and themselves.');
  multi(1, 'Aptitude', 'easy', 'Select all the even numbers.', ['14', '21', '30', '47'], [0, 2], 'Even numbers are divisible by 2.');

  // ---- Round 1 Logical Reasoning
  const L = (d, t, o, r, e) => mcq(1, 'Logical Reasoning', d, t, o, r, e);
  L('easy', 'Find the next number: 2, 4, 8, 16, ?', ['18', '24', '32', '30'], 2, 'Each number doubles.');
  L('easy', 'Find the odd one out: Apple, Banana, Carrot, Mango', ['Apple', 'Banana', 'Carrot', 'Mango'], 2, 'Carrot is a vegetable; the others are fruits.');
  L('easy', 'If CAT is written as DBU, how is DOG written?', ['EPH', 'DPH', 'EOH', 'FPI'], 0, 'Each letter moves one place forward in the alphabet.');
  L('medium', 'All roses are flowers. Some flowers fade quickly. Which conclusion must be true?', ['All roses fade quickly', 'Some roses fade quickly', 'Roses are flowers', 'No flower is a rose'], 2, 'Only "Roses are flowers" follows directly from the first statement.');
  L('medium', 'Find the next number: 3, 6, 11, 18, 27, ?', ['36', '38', '40', '42'], 1, 'The differences are 3, 5, 7, 9, so the next difference is 11: 27 + 11 = 38.');
  L('medium', 'Meera is taller than Asha. Asha is taller than Rahul. Who is the shortest?', ['Meera', 'Asha', 'Rahul', 'Cannot be said'], 2, 'Meera > Asha > Rahul, so Rahul is the shortest.');
  L('hard', 'A clock shows 3:15. What is the angle between the hour and minute hands?', ['0°', '7.5°', '15°', '22.5°'], 1, 'Minute hand is at 90°; hour hand is at 90° + 7.5° = 97.5°; the gap is 7.5°.');
  L('hard', 'In a row of 40 students Asha is 12th from the left. What is her position from the right?', ['27th', '28th', '29th', '30th'], 2, '40 − 12 + 1 = 29, so she is 29th from the right.');
  L('hard', 'If 5 machines make 5 items in 5 minutes, how many minutes do 100 machines need to make 100 items?', ['1', '5', '20', '100'], 1, 'Each machine makes one item in 5 minutes, so 100 machines make 100 items in 5 minutes.');

  // ---- Round 1 Verbal
  const V = (d, t, o, r, e) => mcq(1, 'Verbal Ability', d, t, o, r, e);
  V('easy', 'Choose the correct word: She ___ to school every day.', ['go', 'goes', 'going', 'gone'], 1, 'A singular subject takes "goes" in the simple present.');
  V('easy', 'Choose the synonym of "rapid".', ['Slow', 'Quick', 'Heavy', 'Quiet'], 1, 'Rapid means quick.');
  V('medium', 'Choose the antonym of "scarce".', ['Rare', 'Plentiful', 'Costly', 'Tiny'], 1, 'Scarce means in short supply; plentiful is the opposite.');
  V('medium', 'Pick the correctly spelt word.', ['Accomodate', 'Acommodate', 'Accommodate', 'Acomodate'], 2, 'Accommodate has a double c and a double m.');
  V('hard', 'Choose the sentence with correct grammar.', ['Neither of the answers are right.', 'Neither of the answers is right.', 'Neither of the answer are right.', 'Neither answers is right.'], 1, '"Neither" takes a singular verb.');
  V('hard', 'Choose the best meaning of the idiom "to burn the midnight oil".', ['To waste fuel', 'To work late into the night', 'To start a fire', 'To sleep early'], 1, 'It means to work or study late at night.');
  written(1, 'Written Response', 'easy', 'In 3 to 5 sentences, describe a time you solved a problem at work or college. What did you do and what was the result?', 'A clear situation, the candidate\'s own action, and a measurable or concrete result.');
  written(1, 'Written Response', 'easy', 'Why do you want to work with Semil? Answer in about 100 words.', 'Specific interest in the company, role fit, and what they would contribute.');
  written(1, 'Written Response', 'easy', 'Explain, in your own words, why customer feedback matters to a retail brand.', 'Mentions product improvement, trust and repeat business.');

  // ---- Round 2 technical
  const T = (topic, role, d, t, o, r, e) => mcq(2, topic, d, t, o, r, e, role);
  T('SQL', 'DATA_ANALYST', 'easy', 'Which SQL clause is used to filter rows?', ['GROUP BY', 'WHERE', 'ORDER BY', 'LIMIT'], 1, 'WHERE filters rows before grouping.');
  T('SQL', 'DATA_ANALYST', 'easy', 'Which function counts the number of rows?', ['SUM()', 'COUNT()', 'AVG()', 'MAX()'], 1, 'COUNT() returns the number of rows.');
  T('SQL', 'DATA_ANALYST', 'medium', 'Which JOIN returns all rows from the left table and matching rows from the right?', ['INNER JOIN', 'LEFT JOIN', 'CROSS JOIN', 'SELF JOIN'], 1, 'LEFT JOIN keeps every left row.');
  T('SQL', 'DATA_ANALYST', 'medium', 'Which clause filters groups after aggregation?', ['WHERE', 'HAVING', 'FILTER', 'ON'], 1, 'HAVING applies after GROUP BY.');
  T('SQL', 'DATA_ANALYST', 'hard', 'Which window function gives the same rank to ties and leaves gaps after them?', ['ROW_NUMBER()', 'RANK()', 'DENSE_RANK()', 'NTILE()'], 1, 'RANK() leaves gaps; DENSE_RANK() does not.');
  T('JavaScript', 'SDE', 'easy', 'Which keyword declares a block-scoped variable that can be reassigned?', ['var', 'let', 'const', 'static'], 1, '"let" is block scoped and reassignable.');
  T('JavaScript', 'SDE', 'easy', 'What does typeof null return?', ['"null"', '"undefined"', '"object"', '"number"'], 2, 'A long-standing quirk: typeof null is "object".');
  T('JavaScript', 'SDE', 'medium', 'What is the output of [1, 2, 3].map(x => x * 2)?', ['[1, 2, 3]', '[2, 4, 6]', '6', 'undefined'], 1, 'map returns a new array with each item doubled.');
  T('JavaScript', 'SDE', 'medium', 'Which method adds an item to the end of an array?', ['push', 'pop', 'shift', 'unshift'], 0, 'push appends.');
  T('JavaScript', 'SDE', 'hard', 'What does Promise.all do if one promise rejects?', ['Waits for all, then resolves', 'Rejects immediately with that reason', 'Ignores the rejection', 'Retries it once'], 1, 'Promise.all rejects as soon as any input promise rejects.');
  T('Networks', 'SDE', 'easy', 'Which protocol resolves domain names to IP addresses?', ['HTTP', 'DNS', 'FTP', 'SMTP'], 1, 'DNS maps names to addresses.');
  T('Networks', 'SDE', 'medium', 'Which port does HTTPS use by default?', ['21', '80', '443', '8080'], 2, 'HTTPS defaults to port 443.');
  multi(2, 'Networks', 'medium', 'Which of these are transport-layer protocols?', ['TCP', 'UDP', 'HTTP', 'IP'], [0, 1], 'TCP and UDP operate at the transport layer.', 'SDE');

  return { users, candidates, rounds, questions, counters: { q: n }, batches: [], assessments: [], attempts: [], audit: [], seeded_at: t0 };
}
module.exports = { seedData };
