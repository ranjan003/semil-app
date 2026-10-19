const R = require('../semil-app/src/qb/random');
const pool = []; for (let i = 0; i < 30; i++) pool.push({ id: 'id' + i, question_code: 'Q' + i, topic: 'T', difficulty: 'easy', role_code: null, status: 'active', type: 'mcq', options: ['a', 'b', 'c', 'd'], correct_answer: i % 4, marks: 1, negative_marks: 0, question_text: 'q' + i, shuffle_options: true, version: 1 });
const p = R.drawPaper({ pool, rules: [{ topic: 'T', difficulty: 'easy', count: 8 }], role: null, seed: 'fixedseed', shuffleQuestions: true, shuffleOptions: true });
console.log(JSON.stringify(p.questions.map(q => [q.question.question_code, q.optionOrder])));
