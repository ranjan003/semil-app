'use strict';
// Role-based access control. The API calls these on every request; hiding a button in the
// browser is never the only protection.

const CAPS = {
  super_admin: ['*'],
  hr_admin: [
    'candidate:read', 'candidate:write', 'candidate:notes', 'candidate:delete',
    'vacancy:write', 'campaign:write', 'interview:write', 'offer:send',
    'assessment:assign', 'assessment:read', 'report:read', 'report:export',
    'stage:change', 'document:read', 'evaluation:read',
    // question bank module: manage questions and imports, publish tests, read and publish results
    'qbank:read', 'qbank:write', 'qbank:import', 'assessment:publish', 'results:read', 'results:publish',
  ],
  technical_assessor: ['candidate:read:assigned', 'assessment:read:assigned', 'evaluation:write:assigned', 'document:read:assigned', 'interview:read:own'],
  business_assessor: ['candidate:read:assigned', 'assessment:read:assigned', 'evaluation:write:assigned', 'document:read:assigned', 'interview:read:own'],
  candidate: ['self:read', 'self:write', 'attempt:own', 'submission:own', 'document:own'],
};

// Only these capabilities are reserved for the Super Admin; HR never receives them.
const SUPER_ADMIN_ONLY = ['config:write', 'user:manage', 'override:record', 'offer:approve'];

function can(user, cap) {
  if (!user || !user.role) return false;
  const caps = CAPS[user.role];
  if (!caps) return false;
  if (user.role === 'super_admin') return true;
  if (SUPER_ADMIN_ONLY.includes(cap)) return false;
  return caps.includes(cap);
}

// Object-level check: may this user open this specific candidate record?
function canAccessCandidate(user, candidate) {
  if (!user || !candidate) return false;
  if (user.role === 'super_admin' || user.role === 'hr_admin') return true;
  if (user.role === 'candidate') return candidate.user_id === user.id;
  if (user.role === 'technical_assessor' || user.role === 'business_assessor') return candidate.assessor_id === user.id;
  return false;
}

// Serializers decide which fields leave the server for each viewer.
const NEVER_PUBLIC = ['internal_notes'];
function candidateView(user, row) {
  if (!canAccessCandidate(user, row)) return null;
  const out = { ...row };
  const privileged = user.role === 'super_admin' || user.role === 'hr_admin';
  if (!privileged) for (const f of NEVER_PUBLIC) delete out[f];
  if (user.role === 'candidate') { delete out.hr_owner_id; delete out.assessor_id; delete out.source; }
  return out;
}

// Candidates must never receive the answer key or reviewer-only material.
function questionForCandidate(q) {
  const { correct_answer, rubric_hint, ...safe } = q;
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
