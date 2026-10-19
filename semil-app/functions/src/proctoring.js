'use strict';
// Test-lock rules. Pure functions, so the browser prototype, the API and the tests share one definition.
// A web page cannot stop a person opening another tab or app. It can detect that the test window lost
// focus and refuse to continue. The server holds the deadline and the status, so refreshing the page,
// editing client code or going offline does not bring a blocked attempt back.
//
// Attempt statuses: in_progress -> blocked -> ready (HR reinstated) -> in_progress -> submitted
// Lock modes: strict = block on first exit, warn = two warnings then block, off = log only.

const MODES = ['strict', 'warn', 'off'];
const MAX_WARNINGS = 2;

function pxTime(x) { return x instanceof Date ? x.getTime() : new Date(x).getTime(); }

function pxViolation(attempt, mode) {
  const warnings = (attempt && attempt.warnings) || 0;
  if (!attempt || attempt.status !== 'in_progress') return { action: 'ignore', warnings };
  if (!MODES.includes(mode) || mode === 'off') return { action: 'log', warnings };
  if (mode === 'strict') return { action: 'block', warnings: warnings + 1 };
  const w = warnings + 1;
  return w > MAX_WARNINGS ? { action: 'block', warnings: w } : { action: 'warn', warnings: w };
}

function pxRemaining(attempt, now) {
  if (attempt.status === 'in_progress') return Math.max(0, pxTime(attempt.deadline_at) - now);
  return Math.max(0, Number(attempt.remaining_ms) || 0);
}

// Freeze the clock while blocked, so HR can give the candidate back exactly the time they had left.
function pxBlock(attempt, now) {
  return { status: 'blocked', remaining_ms: pxRemaining(attempt, now), blocked_at: now };
}

function pxReinstate(attempt, now, reason) {
  if (attempt.status !== 'blocked') throw new Error('Only a blocked attempt can be reinstated');
  if (!reason || String(reason).trim().length < 5) throw new Error('A reason is required to reinstate an attempt');
  return { status: 'ready', warnings: 0, reinstated_count: (attempt.reinstated_count || 0) + 1, reinstated_at: now };
}

function pxResume(attempt, now) {
  if (!['idle', 'ready'].includes(attempt.status)) throw new Error('This attempt cannot be started');
  return { status: 'in_progress', deadline_at: now + Math.max(0, Number(attempt.remaining_ms) || 0) };
}

// May answers be saved or submitted right now? 5 seconds of grace covers network delay.
function pxCanWrite(attempt, now, graceMs = 5000) {
  if (!attempt) return { ok: false, reason: 'no_attempt' };
  if (attempt.status === 'blocked') return { ok: false, reason: 'blocked' };
  if (attempt.status === 'submitted') return { ok: false, reason: 'already_submitted' };
  if (attempt.status !== 'in_progress') return { ok: false, reason: 'not_started' };
  if (pxTime(attempt.deadline_at) + graceMs < now) return { ok: false, reason: 'time_expired' };
  return { ok: true };
}

module.exports = { MODES, MAX_WARNINGS, pxViolation, pxRemaining, pxBlock, pxReinstate, pxResume, pxCanWrite };
