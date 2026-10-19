'use strict';
// Server-side paper generation. Every candidate gets their own random seed; from that seed the draw is fully
// reproducible, so an audit can recompute exactly which questions and option order were issued.
//   - selection, question order and each question's option order use separate labelled streams,
//     so they are independent of one another
//   - integers are drawn by rejection sampling (no modulo bias) and shuffled with Fisher-Yates
const crypto = require('node:crypto');

const GENERATOR_VERSION = 'qb-draw-1';
const newSeed = () => crypto.randomBytes(16).toString('hex');

class Stream {
  constructor(seed, label) {
    this.key = crypto.createHmac('sha256', String(seed)).update(String(label)).digest();
    this.counter = 0; this.buf = Buffer.alloc(0); this.pos = 0;
  }
  _u32() {
    if (this.pos + 4 > this.buf.length) {
      const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(this.counter++));
      this.buf = crypto.createHmac('sha256', this.key).update(c).digest(); this.pos = 0;
    }
    const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v;
  }
  int(n) {                                     // uniform in [0, n)
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError('bad range');
    const limit = 0x100000000 - (0x100000000 % n);
    let v; do { v = this._u32(); } while (v >= limit);
    return v % n;
  }
  shuffle(a) { const r = a.slice(); for (let i = r.length - 1; i > 0; i--) { const j = this.int(i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; }
}

const DIFFS = ['easy', 'medium', 'hard'];
const sameTopic = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Rules are cells of (topic, difficulty|any). Cells must not overlap, otherwise availability would depend on draw order.
function validateRules(rules) {
  const errors = [];
  if (!Array.isArray(rules) || !rules.length) return ['Add at least one rule (topic, difficulty and count).'];
  if (rules.length > 60) errors.push('Too many rules (maximum 60).');
  const out = [];
  rules.forEach((r, i) => {
    const n = i + 1;
    const topic = String(r && r.topic || '').trim(), diff = String(r && r.difficulty || 'any').toLowerCase(), count = r && r.count;
    if (!topic) errors.push(`Rule ${n}: topic is required.`);
    if (![...DIFFS, 'any'].includes(diff)) errors.push(`Rule ${n}: difficulty must be easy, medium, hard or any.`);
    if (!Number.isInteger(count) || count < 1 || count > 200) errors.push(`Rule ${n}: count must be a whole number from 1 to 200.`);
    out.push({ topic, difficulty: diff, count });
  });
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
    const a = out[i], b = out[j];
    if (sameTopic(a.topic, b.topic) && (a.difficulty === b.difficulty || a.difficulty === 'any' || b.difficulty === 'any'))
      errors.push(`Rules ${i + 1} and ${j + 1} overlap (${a.topic}, ${a.difficulty} / ${b.difficulty}). Each topic and difficulty may appear only once.`);
  }
  return errors.length ? errors : (rules.splice(0, rules.length, ...out), []);
}

function eligible(pool, role) {
  return pool.filter(q => q.status === 'active' && (!q.role_code || q.role_code === role));
}
const cell = (pool, rule) => pool.filter(q => sameTopic(q.topic, rule.topic) && (rule.difficulty === 'any' || q.difficulty === rule.difficulty));

function availability(pool, rules, role) {
  const p = eligible(pool, role);
  return rules.map(r => { const a = cell(p, r).length; return { ...r, available: a, ok: a >= r.count }; });
}

// pool: bank rows (already limited to the assessment's round). Returns the ordered paper.
function drawPaper({ pool, rules, role, seed, shuffleQuestions = true, shuffleOptions = true }) {
  const avail = availability(pool, rules, role);
  const short = avail.filter(a => !a.ok);
  if (short.length) {
    const e = new Error('The question bank does not have enough active questions for: ' + short.map(s => `${s.topic}/${s.difficulty} (need ${s.count}, have ${s.available})`).join('; ') + '.');
    e.code = 'insufficient_pool'; e.shortfalls = short; throw e;
  }
  const p = eligible(pool, role).sort((a, b) => a.question_code < b.question_code ? -1 : 1);   // stable base order
  let chosen = [];
  rules.forEach((r, i) => {
    chosen.push(...new Stream(seed, `select:${i}`).shuffle(cell(p, r)).slice(0, r.count));
  });
  if (shuffleQuestions) chosen = new Stream(seed, 'order').shuffle(chosen);
  const questions = chosen.map((q, i) => {
    const n = Array.isArray(q.options) ? q.options.length : 0;
    const ident = Array.from({ length: n }, (_, k) => k);
    const optionOrder = n ? ((shuffleOptions && q.shuffle_options !== false) ? new Stream(seed, `options:${q.question_code}`).shuffle(ident) : ident) : null;
    return { position: i + 1, question: q, optionOrder };
  });
  const totalMarks = questions.reduce((s, x) => s + Number(x.question.marks), 0);
  return { questions, totalMarks: Math.round(totalMarks * 100) / 100, generatorVersion: GENERATOR_VERSION };
}

module.exports = { GENERATOR_VERSION, newSeed, Stream, validateRules, availability, drawPaper, eligible };
