'use strict';
// Role-based access control — identical to the original, works with Firebase Auth custom claims.
// req.user.role comes from the decoded Firebase ID token.

const CAPS = {
  super_admin: ['*'],
  hr_admin: [
    'candidate:read', 'candidate:write', 'candidate:notes', 'candidate:delete',
    'vacancy:write', 'campaign:write', 'interview:write', 'offer:send',
    'assessment:assign', 'assessment:read', 'report:read', 'report:export',
    'stage:change', 'document:read', 'evaluation:read',
    'qbank:read', 'qbank:write', 'qbank:import', 'assessment:publish', 'results:read', 'results:publish',
  ],
  technical_assessor: ['candidate:read:assigned', 'assessment:read:assigned', 'evaluation:write:assigned', 'document:read:assigned', 'interview:read:own'],
  business_assessor: ['candidate:read:assigned', 'assessment:read:assigned', 'evaluation:write:assigned', 'document:read:assigned', 'interview:read:own'],
  candidate: ['self:read', 'self:write', 'attempt:own', 'submission:own', 'document:own'],
};

const SUPER_ADMIN_ONLY = ['config:write', 'user:manage', 'override:record', 'offer:approve'];

function can(user, cap) {
  if (!user || !user.role) return false;
  const caps = CAPS[user.role];
  if (!caps) return false;
  if (user.role === 'super_admin') return true;
  if (SUPER_ADMIN_ONLY.includes(cap)) return false;
  return caps.includes(cap);
}

function canAccessCandidate(user, candidate) {
  if (!user || !candidate) return false;
  if (user.role === 'super_admin' || user.role === 'hr_admin') return true;
  if (user.role === 'candidate') return candidate.userId === user.id;
  if (user.role === 'technical_assessor' || user.role === 'business_assessor') return candidate.assessorId === user.id;
  return false;
}

const NEVER_PUBLIC = ['internalNotes'];
function candidateView(user, row) {
  if (!canAccessCandidate(user, row)) return null;
  const out = { ...row };
  const privileged = user.role === 'super_admin' || user.role === 'hr_admin';
  if (!privileged) for (const f of NEVER_PUBLIC) delete out[f];
  if (user.role === 'candidate') { delete out.hrOwnerId; delete out.assessorId; delete out.source; }
  return out;
}

function questionForCandidate(q) {
  const { correctAnswer, rubricHint, ...safe } = q;
  return safe;
}
function assessmentForCandidate(a) {
  const { rubric, reviewers, questions, ...rest } = a;
  return { ...rest, questions: (questions || []).map(questionForCandidate) };
}

function requireCap(cap) {
  return (req, res, next) => (can(req.user, cap) ? next() : res.status(403).json({ error: 'forbidden' }));
}

module.exports = { CAPS, SUPER_ADMIN_ONLY, can, canAccessCandidate, candidateView, questionForCandidate, assessmentForCandidate, requireCap };
