(() => {
  const socket = io({ transports: ["websocket", "polling"], reconnection: true });

  const state = {
    quizzes: [], locks: {}, order: [], activeUsers: 0, activeQuizzes: 0,
    myActiveQuizId: null, pendingLock: false, selectedQuizId: null,
    pendingQuizWindow: null, quizWindowPoll: null,
  };

  const cardGrid = document.getElementById("cardGrid");
  const activeQuizStatus = document.getElementById("activeQuizStatus");
  const loadingOverlay = document.getElementById("loadingOverlay");
  const toastContainer = document.getElementById("toastContainer");

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function sortedQuizzes() {
    return [...state.quizzes].sort((a, b) => a.id - b.id);
  }

  function syncMyActiveQuiz() {
    const mine = Object.entries(state.locks).find(([, lock]) => lock?.socketId === socket.id);
    state.myActiveQuizId = mine ? Number(mine[0]) : null;
  }

  function closePendingWindow() {
    if (state.pendingQuizWindow && !state.pendingQuizWindow.closed) {
      state.pendingQuizWindow.close();
    }
    state.pendingQuizWindow = null;
  }

  function watchQuizWindow(quizId, quizWindow) {
    if (state.quizWindowPoll) clearInterval(state.quizWindowPoll);

    state.quizWindowPoll = setInterval(() => {
      if (!quizWindow || !quizWindow.closed) return;

      clearInterval(state.quizWindowPoll);
      state.quizWindowPoll = null;

      if (state.myActiveQuizId === quizId) {
        socket.emit("submit_quiz", { quizId });
      }
    }, 900);
  }

  function updateStatus() {
    activeQuizStatus.textContent = `${state.activeQuizzes} Active`;
  }

  function createCard(quiz) {
    const hasLink = !!quiz.link;
    const locked = !!state.locks[quiz.id];
    const blocked = locked || !hasLink;

    const card = document.createElement("button");
    card.className = `card ${blocked ? "locked" : ""}`;
    card.type = "button";
    card.disabled = locked || state.pendingLock || !hasLink || !!state.myActiveQuizId;
    card.setAttribute("aria-label", quiz.title);
    card.innerHTML = `<img class="card-icon" src="/bulb.png" alt="" aria-hidden="true" />`;

    card.addEventListener("click", () => {
      if (locked || state.pendingLock || !hasLink || state.myActiveQuizId) return;
      state.selectedQuizId = quiz.id;
      state.pendingQuizWindow = window.open("about:blank", `quiz_${quiz.id}_${Date.now()}`);

      if (!state.pendingQuizWindow) {
        showToast("Please allow popups for this page");
        return;
      }

      state.pendingLock = true;
      renderCards();
      socket.emit("lock_quiz", { quizId: quiz.id });
    });

    return card;
  }

  function renderCards(animateShuffle = false) {
    const ordered = sortedQuizzes();
    cardGrid.innerHTML = "";
    for (const quiz of ordered) cardGrid.appendChild(createCard(quiz));
    syncMyActiveQuiz();
    updateStatus();
    if (animateShuffle) {
      cardGrid.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 280, easing: "ease-out" });
    }
  }

  function applyState(payload, animateShuffle = false) {
    state.quizzes = payload.quizzes || state.quizzes;
    state.locks = payload.locks || state.locks;
    state.order = payload.order || state.order;
    state.activeUsers = payload.activeUsers ?? state.activeUsers;
    state.activeQuizzes = payload.activeQuizzes ?? Object.keys(state.locks).length;
    renderCards(animateShuffle);
    loadingOverlay.classList.remove("visible");
  }

  socket.on("connect", () => socket.emit("sync_request"));
  socket.on("state_sync", (payload) => applyState(payload));
  socket.on("active_users_update", () => {});

  socket.on("quiz_locked", ({ quizId, lock, locks, activeQuizzes }) => {
    state.pendingLock = false;
    state.locks = locks || state.locks;
    state.activeQuizzes = activeQuizzes ?? Object.keys(state.locks).length;
    if (lock?.socketId === socket.id) {
      const quiz = state.quizzes.find((q) => q.id === quizId);
      if (quiz?.link && state.pendingQuizWindow && !state.pendingQuizWindow.closed) {
        state.pendingQuizWindow.location.href = quiz.link;
        watchQuizWindow(quizId, state.pendingQuizWindow);
      }
      state.pendingQuizWindow = null;
      showToast(`${quiz?.title || "Quiz"} started`);
    }
    renderCards();
  });

  socket.on("lock_failed", ({ quizId, reason }) => {
    state.pendingLock = false;
    state.selectedQuizId = null;
    closePendingWindow();
    renderCards();
    if (reason === "in_use") showToast(`Quiz Set ${quizId} is in use`);
    else if (reason === "no_link") showToast(`Quiz Set ${quizId} link not set`);
    else showToast("Unable to start quiz");
  });

  socket.on("quiz_unlocked", ({ locks, activeQuizzes }) => {
    const hadMine = !!state.myActiveQuizId;
    state.locks = locks || state.locks;
    state.activeQuizzes = activeQuizzes ?? Object.keys(state.locks).length;
    renderCards();
    if (hadMine && !state.myActiveQuizId) showToast("Submitted");
  });

  socket.on("cards_shuffled", ({ quizzes, order }) => {
    state.quizzes = quizzes || state.quizzes;
    state.order = order || state.order;
    renderCards(true);
  });

  fetch("/api/state")
    .then((res) => res.json())
    .then((payload) => applyState(payload))
    .catch(() => {
      loadingOverlay.classList.remove("visible");
      showToast("Sync failed");
    });
})();
