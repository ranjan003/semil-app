'use strict';
// Creates the first Super Admin user in Firebase.
// Usage:
//   cd functions
//   GOOGLE_APPLICATION_CREDENTIALS=path/to/serviceAccountKey.json node scripts/firebase-seed.js
//
// Or locally with emulators:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 node scripts/firebase-seed.js

const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

// Initialize — uses GOOGLE_APPLICATION_CREDENTIALS env var or emulator
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || 'semil-a9cf1',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'semil-a9cf1.firebasestorage.app',
    databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://semil-a9cf1-default-rtdb.asia-southeast1.firebasedatabase.app',
  });
}

const auth = admin.auth();
const db = admin.firestore();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@semil.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SemilPass2026!';
const ADMIN_NAME = process.env.ADMIN_NAME || 'Super Admin';

(async () => {
  console.log(`\n🔥 Semil Talent Discovery — Firebase Seed\n`);
  console.log(`  Email    : ${ADMIN_EMAIL}`);
  console.log(`  Password : ${'*'.repeat(ADMIN_PASSWORD.length)}`);
  console.log(`  Name     : ${ADMIN_NAME}\n`);

  // ── 1. Create Firebase Auth user ──
  let uid;
  try {
    const existing = await auth.getUserByEmail(ADMIN_EMAIL);
    uid = existing.uid;
    console.log(`✓ Auth user already exists (uid: ${uid})`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      const userRecord = await auth.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        displayName: ADMIN_NAME,
        emailVerified: true,
      });
      uid = userRecord.uid;
      console.log(`✓ Created Auth user (uid: ${uid})`);
    } else {
      throw err;
    }
  }

  // ── 2. Set custom claims (role) ──
  await auth.setCustomUserClaims(uid, { role: 'super_admin' });
  console.log('✓ Set custom claims: { role: "super_admin" }');

  // ── 3. Create Firestore user document ──
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    await userRef.set({
      email: ADMIN_EMAIL,
      fullName: ADMIN_NAME,
      role: 'super_admin',
      isActive: true,
      failedLogins: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('✓ Created Firestore /users document');
  } else {
    console.log('✓ Firestore /users document already exists');
  }

  // ── 4. Create default scoring config ──
  const configSnap = await db.collection('scoringConfig').where('isActive', '==', true).limit(1).get();
  if (configSnap.empty) {
    await db.collection('scoringConfig').add({
      weights: { '1': 20, '2': 20, '3': 15, '4': 30, '5': 15 },
      thresholds: { '1': 50, '2': 50, '3': 50, '4': 60, '5': 50 },
      overallTarget: 65,
      isActive: true,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });
    console.log('✓ Created default scoring config');
  } else {
    console.log('✓ Scoring config already exists');
  }

  // ── 5. Create default round settings ──
  const rounds = [
    { round: 1, name: 'Skills-Based Shortlisting', durationMinutes: 45, passThresholdPct: 50 },
    { round: 2, name: 'Group Project Development', durationMinutes: 60, passThresholdPct: 50 },
    { round: 3, name: 'Mindset and Reasoning Assessment', durationMinutes: 45, passThresholdPct: 50 },
    { round: 4, name: 'Individual Practical Creation', durationMinutes: 90, passThresholdPct: 60 },
    { round: 5, name: 'HR and Founder Interview', durationMinutes: 45, passThresholdPct: 50 },
  ];
  const batch = db.batch();
  for (const r of rounds) {
    const ref = db.collection('roundSettings').doc(String(r.round));
    batch.set(ref, {
      ...r,
      description: null,
      enabled: true,
      published: false,
      eligibility: { requireStage: true, minPreviousPct: null },
      updatedBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
  console.log('✓ Created/updated round settings (1-5)');

  // ── 6. Create default vacancies ──
  const roles = [
    ['Software Development Engineer (SDE I)', 'SDE', 'technical'],
    ['Cloud & DevOps Engineer', 'DEVOPS', 'technical'],
    ['Frontend Engineer', 'FE', 'technical'],
    ['Business Development Associate', 'BDA', 'business'],
    ['Operations & Logistics Associate', 'OPS', 'business'],
  ];
  for (const [title, code, track] of roles) {
    const existing = await db.collection('vacancies').where('roleCode', '==', code).limit(1).get();
    if (existing.empty) {
      await db.collection('vacancies').add({
        title, roleCode: code, track,
        department: null, description: null, requiredSkills: [],
        minQualifications: null, openings: 1, salaryMinLpa: null, salaryMaxLpa: null,
        location: 'Bengaluru, India', employmentType: 'full_time',
        joiningTimeline: null, applicationDeadline: null,
        assessmentTemplate: null, selectionCriteria: null, hiringManagerId: null,
        status: 'draft', applicantCount: 0,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`  + Vacancy: ${title}`);
    }
  }
  console.log('✓ Default vacancies seeded');

  // ── 7. Initialize counters ──
  await db.collection('counters').doc('candidateCode').set({ value: 0 }, { merge: true });
  await db.collection('counters').doc('questionCode').set({ value: 0 }, { merge: true });
  console.log('✓ Counters initialized');

  // ── 8. Seed sample question bank questions ──
  const qSnap = await db.collection('questionBank').limit(1).get();
  if (qSnap.empty) {
    const sampleQuestions = [
      {
        question_code: 'Q-00001',
        question_text: 'What is the average time complexity of searching an element in a balanced Binary Search Tree?',
        type: 'mcq',
        options: ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'],
        correct_answer: 1,
        difficulty: 'easy',
        round: 1,
        topic: 'Data Structures',
        marks: 2,
        status: 'active',
        version: 1,
      },
      {
        question_code: 'Q-00002',
        question_text: 'Which HTTP status code signifies that a resource was successfully created on the server?',
        type: 'mcq',
        options: ['200 OK', '201 Created', '204 No Content', '301 Moved Permanently'],
        correct_answer: 1,
        difficulty: 'easy',
        round: 1,
        topic: 'Web Architecture',
        marks: 2,
        status: 'active',
        version: 1,
      },
      {
        question_code: 'Q-00003',
        question_text: 'Which data structure follows the First-In, First-Out (FIFO) principle?',
        type: 'mcq',
        options: ['Stack', 'Queue', 'Priority Queue', 'Binary Tree'],
        correct_answer: 1,
        difficulty: 'easy',
        round: 1,
        topic: 'Data Structures',
        marks: 2,
        status: 'active',
        version: 1,
      },
      {
        question_code: 'Q-00004',
        question_text: 'Explain the difference between optimistic concurrency control and pessimistic concurrency control in distributed databases.',
        type: 'descriptive',
        reference_answer: 'Optimistic concurrency control assumes conflicts are rare and verifies before committing. Pessimistic locks resources beforehand.',
        difficulty: 'medium',
        round: 1,
        topic: 'Databases',
        marks: 5,
        status: 'active',
        version: 1,
      },
    ];

    for (const q of sampleQuestions) {
      await db.collection('questionBank').add({
        ...q,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    await db.collection('counters').doc('questionCode').set({ value: sampleQuestions.length }, { merge: true });
    console.log(`✓ Seeded ${sampleQuestions.length} sample questions in Question Bank`);
  }

  console.log('\n✅ Seed complete! You can now log in with:');
  console.log(`   Email    : ${ADMIN_EMAIL}`);
  console.log(`   Password : ${ADMIN_PASSWORD}\n`);

  process.exit(0);
})().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
