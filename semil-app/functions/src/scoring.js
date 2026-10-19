'use strict';
// Pure scoring engine. No I/O so it is easy to test and to keep configurable.
// Rules (from the product spec):
//  - overall = sum(score_i * weight_i) over rounds that HAVE a valid score, divided by the weights used
//  - a missing round is never treated as zero and never marks the candidate as failed
//  - a candidate "meets criteria" only when all five rounds are scored, every round meets its
//    minimum threshold, and the overall score reaches the target
//  - a documented human override replaces the calculated verdict but never the numbers

const ROUNDS = [1, 2, 3, 4, 5];

const DEFAULT_CONFIG = Object.freeze({
  weights: { 1: 20, 2: 20, 3: 15, 4: 30, 5: 15 },
  thresholds: { 1: 50, 2: 50, 3: 50, 4: 60, 5: 50 },
  target: 65,
});

function validateConfig(cfg) {
  const errors = [];
  let sum = 0;
  for (const r of ROUNDS) {
    const w = Number(cfg.weights && cfg.weights[r]);
    const t = Number(cfg.thresholds && cfg.thresholds[r]);
    if (!Number.isFinite(w) || w < 0 || w > 100) errors.push(`Weight for round ${r} must be 0-100`);
    else sum += w;
    if (!Number.isFinite(t) || t < 0 || t > 100) errors.push(`Threshold for round ${r} must be 0-100`);
  }
  if (Math.abs(sum - 100) > 1e-9) errors.push(`Weights must total 100 (currently ${sum})`);
  const target = Number(cfg.target);
  if (!Number.isFinite(target) || target < 0 || target > 100) errors.push('Target must be 0-100');
  return errors;
}

function isValidScore(s) {
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 && s <= 100;
}

/**
 * @param {Object<number, number|null|undefined>} scores  round number -> score (0-100) or missing
 * @param {{weights, thresholds, target}} cfg
 * @param {{decision:string, reason:string}|null} override
 */
function evaluate(scores, cfg = DEFAULT_CONFIG, override = null) {
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error('Invalid scoring config: ' + errors.join('; '));

  let weighted = 0;
  let weightUsed = 0;
  const scored = [];
  const missing = [];
  const belowThreshold = [];

  for (const r of ROUNDS) {
    const s = scores[r];
    if (!isValidScore(s)) { missing.push(r); continue; }
    scored.push(r);
    weighted += s * cfg.weights[r];
    weightUsed += cfg.weights[r];
    if (s < cfg.thresholds[r]) belowThreshold.push(r);
  }

  const overall = weightUsed > 0 ? round2(weighted / weightUsed) : null;
  const complete = missing.length === 0;

  let status;
  if (scored.length === 0) status = 'pending_review';
  else if (!complete) status = 'incomplete';
  else if (belowThreshold.length || overall < cfg.target) status = 'below_criteria';
  else status = 'meets_criteria';

  if (override) {
    if (!override.reason || override.reason.trim().length < 5) throw new Error('An override needs a documented reason');
    status = 'overridden';
  }

  return {
    overall,
    provisional: scored.length > 0 && !complete,   // true when some rounds are still missing
    complete,
    scoredRounds: scored,
    missingRounds: missing,
    belowThreshold,
    meetsTarget: overall != null && overall >= cfg.target,
    status,
    override: override ? { decision: override.decision, reason: override.reason } : null,
  };
}

// Auto-marking for objective questions. Returns marks awarded.
function markObjective(question, response) {
  const marks = Number(question.marks) || 0;
  const key = question.correct_answer;
  if (question.kind === 'mcq') return response === key ? marks : 0;
  if (question.kind === 'multi_select') {
    if (!Array.isArray(response) || !Array.isArray(key)) return 0;
    const a = [...new Set(response)].sort();
    const b = [...new Set(key)].sort();
    return a.length === b.length && a.every((v, i) => v === b[i]) ? marks : 0;   // all-or-nothing
  }
  return null; // written and file answers need a human reviewer
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { DEFAULT_CONFIG, ROUNDS, validateConfig, evaluate, markObjective, isValidScore };
