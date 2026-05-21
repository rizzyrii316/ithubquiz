const path = require("path");
const http = require("http");
require("dotenv").config();
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS || 45 * 60 * 1000);

const quizCards = Array.from({ length: 10 }, (_, i) => {
  const id = i + 1;
  const envLink = process.env[`FORM_LINK_${id}`];
  return {
    id,
    title: `Quiz Set ${id}`,
    link: envLink && envLink.trim() ? envLink.trim() : null,
  };
});

let linkAssignments = Object.fromEntries(quizCards.map((quiz) => [quiz.id, quiz.link]));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
  pingInterval: 25000,
  pingTimeout: 20000,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let activeUsers = 0;
const cardOrder = quizCards.map((q) => q.id);

// quizLocks: quizId -> { socketId, startedAt }
const quizLocks = {};

// socketLocks: socketId -> Set<quizId>
const socketLocks = new Map();

function now() {
  return Date.now();
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function getQuizzesForClient() {
  return quizCards.map((quiz) => ({
    ...quiz,
    link: linkAssignments[quiz.id] || null,
  }));
}

function shuffleAvailableLinks() {
  const availableQuizIds = quizCards
    .map((quiz) => quiz.id)
    .filter((quizId) => !quizLocks[quizId]);
  const links = availableQuizIds.map((quizId) => linkAssignments[quizId]).filter(Boolean);
  const shuffledSlots = shuffleArray(availableQuizIds);

  for (const quizId of availableQuizIds) {
    linkAssignments[quizId] = null;
  }

  links.forEach((link, index) => {
    linkAssignments[shuffledSlots[index]] = link;
  });
}

function isLockExpired(lock) {
  return !lock || now() - lock.startedAt > LOCK_TTL_MS;
}

function cleanupExpiredLocks() {
  const expiredIds = [];
  for (const q of quizCards) {
    const lock = quizLocks[q.id];
    if (lock && isLockExpired(lock)) {
      expiredIds.push(q.id);
      delete quizLocks[q.id];
      const ownerSet = socketLocks.get(lock.socketId);
      if (ownerSet) {
        ownerSet.delete(q.id);
      }
    }
  }

  if (expiredIds.length) {
    io.emit("quiz_unlocked", {
      quizIds: expiredIds,
      locks: quizLocks,
    });
  }
}

function getActiveQuizzesCount() {
  return Object.keys(quizLocks).length;
}

function lockQuizAtomic(quizId, socketId) {
  const lock = quizLocks[quizId];

  if (!lock) {
    quizLocks[quizId] = {
      socketId,
      startedAt: now(),
    };

    if (!socketLocks.has(socketId)) {
      socketLocks.set(socketId, new Set());
    }
    socketLocks.get(socketId).add(quizId);

    return { ok: true };
  }

  if (isLockExpired(lock)) {
    delete quizLocks[quizId];
    const ownerSet = socketLocks.get(lock.socketId);
    if (ownerSet) {
      ownerSet.delete(quizId);
    }
    return lockQuizAtomic(quizId, socketId);
  }

  return { ok: false, reason: "in_use", owner: lock.socketId };
}

function unlockQuiz(quizId, socketId) {
  const lock = quizLocks[quizId];
  if (!lock) {
    return { ok: false, reason: "not_locked" };
  }

  if (lock.socketId !== socketId) {
    return { ok: false, reason: "not_owner" };
  }

  delete quizLocks[quizId];
  const ownerSet = socketLocks.get(socketId);
  if (ownerSet) {
    ownerSet.delete(quizId);
  }

  return { ok: true };
}

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeUsers,
    activeQuizzes: getActiveQuizzesCount(),
  });
});

app.get("/api/state", (_req, res) => {
  cleanupExpiredLocks();
  res.json({
    quizzes: getQuizzesForClient(),
    locks: quizLocks,
    order: cardOrder,
    activeUsers,
    activeQuizzes: getActiveQuizzesCount(),
    lockTtlMs: LOCK_TTL_MS,
    serverTime: now(),
  });
});

setInterval(cleanupExpiredLocks, 15000);

io.on("connection", (socket) => {
  activeUsers += 1;
  socketLocks.set(socket.id, new Set());

  socket.emit("state_sync", {
    quizzes: getQuizzesForClient(),
    locks: quizLocks,
    order: cardOrder,
    activeUsers,
    activeQuizzes: getActiveQuizzesCount(),
    lockTtlMs: LOCK_TTL_MS,
    serverTime: now(),
  });

  io.emit("active_users_update", { activeUsers });

  socket.on("lock_quiz", ({ quizId }) => {
    cleanupExpiredLocks();

    const numericQuizId = Number(quizId);
    const selectedQuiz = getQuizzesForClient().find((q) => q.id === numericQuizId);

    if (!selectedQuiz) {
      socket.emit("lock_failed", { quizId: numericQuizId, reason: "invalid_quiz" });
      return;
    }

    if (!selectedQuiz.link) {
      socket.emit("lock_failed", { quizId: numericQuizId, reason: "no_link" });
      return;
    }

    const result = lockQuizAtomic(numericQuizId, socket.id);

    if (!result.ok) {
      socket.emit("lock_failed", {
        quizId: numericQuizId,
        reason: result.reason,
      });
      return;
    }

    io.emit("quiz_locked", {
      quizId: numericQuizId,
      lock: quizLocks[numericQuizId],
      locks: quizLocks,
      activeQuizzes: getActiveQuizzesCount(),
    });
  });

  socket.on("submit_quiz", ({ quizId }) => {
    cleanupExpiredLocks();

    const numericQuizId = Number(quizId);
    const result = unlockQuiz(numericQuizId, socket.id);

    if (!result.ok) {
      socket.emit("unlock_failed", { quizId: numericQuizId, reason: result.reason });
      return;
    }

    io.emit("quiz_unlocked", {
      quizIds: [numericQuizId],
      locks: quizLocks,
      activeQuizzes: getActiveQuizzesCount(),
    });

    shuffleAvailableLinks();
    io.emit("cards_shuffled", {
      quizzes: getQuizzesForClient(),
      order: cardOrder,
      shuffledAt: now(),
    });
  });

  socket.on("disconnect", () => {
    activeUsers = Math.max(0, activeUsers - 1);

    const heldLocks = socketLocks.get(socket.id) || new Set();
    const releasedQuizIds = [];

    for (const quizId of heldLocks) {
      const lock = quizLocks[quizId];
      if (lock && lock.socketId === socket.id) {
        delete quizLocks[quizId];
        releasedQuizIds.push(Number(quizId));
      }
    }

    socketLocks.delete(socket.id);

    if (releasedQuizIds.length) {
      io.emit("quiz_unlocked", {
        quizIds: releasedQuizIds,
        locks: quizLocks,
        activeQuizzes: getActiveQuizzesCount(),
      });

      shuffleAvailableLinks();
      io.emit("cards_shuffled", {
        quizzes: getQuizzesForClient(),
        order: cardOrder,
        shuffledAt: now(),
      });
    }

    io.emit("active_users_update", { activeUsers });
  });

  socket.on("sync_request", () => {
    socket.emit("state_sync", {
      quizzes: getQuizzesForClient(),
      locks: quizLocks,
      order: cardOrder,
      activeUsers,
      activeQuizzes: getActiveQuizzesCount(),
      lockTtlMs: LOCK_TTL_MS,
      serverTime: now(),
    });
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`IT Hub Quiz Portal running on http://localhost:${PORT}`);
});
