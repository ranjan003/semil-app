'use strict';
// Real-time module: Socket.IO for live proctoring updates, notifications, and dashboard events.
// Integrates with Redis PubSub for horizontal scaling across multiple servers.

const { Server } = require('socket.io');
const sessions = require('./sessions');

// Channel names
const CH = {
  PROCTOR:       'proctor',         // live proctoring events (HR monitors)
  NOTIFICATIONS: 'notifications',   // per-user notifications
  DASHBOARD:     'dashboard',       // global dashboard KPI updates
  ATTEMPT:       'attempt',         // attempt status changes
};

/**
 * @param {import('http').Server} httpServer
 * @param {object} deps
 * @param {object} deps.db             Database pool
 * @param {object} [deps.pubsub]       RedisPubSub instance (optional, for multi-server)
 * @param {boolean} [deps.isProd]      Production flag
 * @returns {object}
 */
function createRealtime(httpServer, { db, pubsub, isProd = false }) {
  const io = new Server(httpServer, {
    cors: isProd ? undefined : { origin: '*', methods: ['GET', 'POST'] },
    path: '/ws',
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ---- Authentication middleware ----
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || parseCookie(socket.handshake.headers.cookie, 'ntg_session');
      if (!token) return next(new Error('authentication_required'));
      const user = await sessions.lookupSession(db, token);
      if (!user) return next(new Error('invalid_session'));
      socket.user = user;
      next();
    } catch (err) {
      next(new Error('authentication_failed'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket;

    // Join user-specific room for targeted notifications
    socket.join(`user:${user.id}`);

    // HR/Admin joins monitoring rooms
    if (['super_admin', 'hr_admin'].includes(user.role)) {
      socket.join('staff');
      socket.join('proctor-monitor');
    }

    // Assessors join their room
    if (user.role.endsWith('assessor')) {
      socket.join('assessors');
    }

    socket.on('disconnect', () => { /* cleanup if needed */ });
  });

  // ---- Broadcast helpers ----

  const rt = {
    io,

    /** Notify a specific user (e.g. new message, stage change). */
    notifyUser(userId, event, data) {
      io.to(`user:${userId}`).emit(event, data);
      if (pubsub) pubsub.publish('rt:user', { userId, event, data });
    },

    /** Broadcast to all staff (HR + Super Admin). */
    notifyStaff(event, data) {
      io.to('staff').emit(event, data);
      if (pubsub) pubsub.publish('rt:staff', { event, data });
    },

    /** Send proctoring alert to monitoring dashboard. */
    proctorAlert(attemptId, alert) {
      const payload = { attemptId, ...alert, timestamp: new Date().toISOString() };
      io.to('proctor-monitor').emit(CH.PROCTOR, payload);
      if (pubsub) pubsub.publish('rt:proctor', payload);
    },

    /** Broadcast attempt status change (started, blocked, submitted). */
    attemptUpdate(attemptId, status, candidateName) {
      const payload = { attemptId, status, candidateName, timestamp: new Date().toISOString() };
      io.to('proctor-monitor').emit(CH.ATTEMPT, payload);
      if (pubsub) pubsub.publish('rt:attempt', payload);
    },

    /** Broadcast dashboard KPI update (new candidate, stage change, etc.). */
    dashboardUpdate(kind, data) {
      io.to('staff').emit(CH.DASHBOARD, { kind, ...data, timestamp: new Date().toISOString() });
    },

    /** Get count of connected clients. */
    connectedCount() {
      return io.engine.clientsCount;
    },
  };

  // ---- Cross-server sync via Redis PubSub ----
  if (pubsub) {
    pubsub.subscribe('rt:user', ({ userId, event, data }) => {
      io.to(`user:${userId}`).emit(event, data);
    });
    pubsub.subscribe('rt:staff', ({ event, data }) => {
      io.to('staff').emit(event, data);
    });
    pubsub.subscribe('rt:proctor', (payload) => {
      io.to('proctor-monitor').emit(CH.PROCTOR, payload);
    });
    pubsub.subscribe('rt:attempt', (payload) => {
      io.to('proctor-monitor').emit(CH.ATTEMPT, payload);
    });
  }

  return rt;
}

// Parse a specific cookie from a cookie header string
function parseCookie(cookieStr, name) {
  if (!cookieStr) return null;
  const match = cookieStr.split(';').find(c => c.trim().startsWith(`${name}=`));
  return match ? match.split('=')[1].trim() : null;
}

module.exports = { createRealtime, CH };
