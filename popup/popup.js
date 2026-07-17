const setupView = document.getElementById("setup-view");
const activeView = document.getElementById("active-view");

const presetButtons = document.querySelectorAll(".preset-btn");
const customMinutesInput = document.getElementById("custom-minutes");
const lockSoftBtn = document.getElementById("lock-soft");
const lockHardBtn = document.getElementById("lock-hard");
const whitelistTextarea = document.getElementById("whitelist");
const startBtn = document.getElementById("start-btn");

const countdownEl = document.getElementById("countdown");
const lockModeBadgeEl = document.getElementById("lock-mode-badge");
const pausedBadgeEl = document.getElementById("paused-badge");
const pauseBtn = document.getElementById("pause-btn");
const allowedSitesEl = document.getElementById("allowed-sites");
const nuclearBtn = document.getElementById("nuclear-btn");
const violationsCountEl = document.getElementById("violations-count");
const viewLogBtn = document.getElementById("view-log-btn");

const addSiteInput = document.getElementById("add-site-input");
const addSiteBtn = document.getElementById("add-site-btn");
const addSiteReasonRow = document.getElementById("add-site-reason-row");
const addSiteReasonInput = document.getElementById("add-site-reason");
const addSiteCancelBtn = document.getElementById("add-site-cancel-btn");
const addSiteSubmitBtn = document.getElementById("add-site-submit-btn");
const addSiteStatusEl = document.getElementById("add-site-status");

const SAVED_WHITELIST_KEY = "savedDomainWhitelist";

chrome.storage.local.get(SAVED_WHITELIST_KEY, (data) => {
  const saved = data[SAVED_WHITELIST_KEY];
  if (Array.isArray(saved) && saved.length > 0) {
    whitelistTextarea.value = saved.join("\n");
  }
});

let selectedMinutes = null;
let selectedLockMode = "soft";
let countdownInterval = null;
let statusPollInterval = null;

presetButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    presetButtons.forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedMinutes = Number(btn.dataset.minutes);
    customMinutesInput.value = "";
  });
});

customMinutesInput.addEventListener("input", () => {
  if (customMinutesInput.value) {
    presetButtons.forEach((b) => b.classList.remove("selected"));
    selectedMinutes = null;
  }
});

function selectLockMode(mode) {
  selectedLockMode = mode;
  lockSoftBtn.classList.toggle("selected", mode === "soft");
  lockHardBtn.classList.toggle("selected", mode === "hard");
}

lockSoftBtn.addEventListener("click", () => selectLockMode("soft"));
lockHardBtn.addEventListener("click", () => selectLockMode("hard"));

startBtn.addEventListener("click", () => {
  const customValue = Number(customMinutesInput.value);
  const durationMinutes = customValue > 0 ? customValue : selectedMinutes;

  if (!durationMinutes || durationMinutes <= 0) {
    customMinutesInput.style.borderColor = "#e5484d";
    return;
  }

  const parseLines = (value) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  const domainWhitelist = parseLines(whitelistTextarea.value);

  chrome.storage.local.set({ [SAVED_WHITELIST_KEY]: domainWhitelist });

  startBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "startSession",
      payload: {
        durationMinutes,
        lockMode: selectedLockMode,
        domainWhitelist,
      },
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        refreshStatus();
      } else {
        startBtn.textContent = "Desktop app unreachable — try again";
        setTimeout(() => {
          startBtn.textContent = "Start Focus Session";
        }, 2500);
      }
    }
  );
});

pauseBtn.addEventListener("click", () => {
  const willPause = !pauseBtn.classList.contains("is-paused");
  pauseBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: willPause ? "pauseSession" : "resumeSession" },
    (response) => {
      pauseBtn.disabled = false;
      if (response?.ok) {
        refreshStatus();
      } else {
        pauseBtn.textContent = "Desktop app unreachable — try again";
        setTimeout(() => {
          pauseBtn.textContent = willPause ? "Pause Timer" : "Resume Timer";
        }, 2500);
      }
    }
  );
});

viewLogBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("log/log.html") });
});

nuclearBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "endSession" }, () => {
    stopStatusPoll();
    stopCountdown();
    showSetupView();
  });
});

// Adding a site mid-session is a two-step flow: typing a domain and hitting
// Add only reveals the reason box — nothing is sent to the desktop app until
// a non-empty reason is submitted, so every addition has an audit trail.
let pendingAddSiteDomain = null;

function resetAddSiteForm() {
  pendingAddSiteDomain = null;
  addSiteReasonRow.classList.add("hidden");
  addSiteBtn.disabled = false;
  addSiteInput.disabled = false;
  addSiteInput.value = "";
  addSiteReasonInput.value = "";
}

addSiteBtn.addEventListener("click", () => {
  const domain = addSiteInput.value.trim();
  if (!domain) return;
  pendingAddSiteDomain = domain;
  addSiteReasonRow.classList.remove("hidden");
  addSiteBtn.disabled = true;
  addSiteInput.disabled = true;
  addSiteReasonInput.value = "";
  addSiteStatusEl.textContent = "";
  addSiteReasonInput.focus();
});

addSiteCancelBtn.addEventListener("click", () => {
  resetAddSiteForm();
  addSiteStatusEl.textContent = "";
});

addSiteSubmitBtn.addEventListener("click", () => {
  const reason = addSiteReasonInput.value.trim();
  if (!pendingAddSiteDomain || !reason) {
    addSiteStatusEl.textContent = "A reason is required.";
    return;
  }

  const domain = pendingAddSiteDomain;
  addSiteSubmitBtn.disabled = true;
  chrome.runtime.sendMessage(
    { type: "addWhitelistDomain", payload: { domain, reason } },
    (response) => {
      addSiteSubmitBtn.disabled = false;
      if (response?.ok) {
        addSiteStatusEl.textContent = `Added ${domain}.`;
        resetAddSiteForm();
        refreshStatus();
      } else {
        addSiteStatusEl.textContent = "Couldn't add site — desktop app unreachable.";
      }
    }
  );
});

function showSetupView() {
  activeView.classList.add("hidden");
  setupView.classList.remove("hidden");
  resetAddSiteForm();
  addSiteStatusEl.textContent = "";
}

function showActiveView() {
  setupView.classList.add("hidden");
  activeView.classList.remove("hidden");
}

function formatCountdown(msLeft) {
  const totalSeconds = Math.max(0, Math.ceil(msLeft / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function startCountdown(endTime) {
  stopCountdown();
  const tick = () => {
    const msLeft = endTime - Date.now();
    countdownEl.textContent = formatCountdown(msLeft);
    if (msLeft <= 0) {
      stopCountdown();
      showSetupView();
    }
  };
  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

function renderActiveSession(session) {
  showActiveView();
  const isHard = session.lockMode === "hard";
  lockModeBadgeEl.textContent = isHard ? "Hard Lock" : "Soft Lock";
  lockModeBadgeEl.classList.toggle("hard", isHard);
  lockModeBadgeEl.classList.toggle("soft", !isHard);
  const sites = session.domainWhitelist || [];
  allowedSitesEl.innerHTML = "";
  sites.forEach((site) => {
    const li = document.createElement("li");
    li.textContent = site;
    allowedSitesEl.appendChild(li);
  });

  const violationCount = session.violationCount || 0;
  violationsCountEl.textContent = `${violationCount} violation${violationCount === 1 ? "" : "s"}`;
  violationsCountEl.classList.toggle("has-violations", violationCount > 0);

  pausedBadgeEl.classList.toggle("hidden", !session.isPaused);
  pauseBtn.classList.toggle("is-paused", !!session.isPaused);
  pauseBtn.textContent = session.isPaused ? "Resume Timer" : "Pause Timer";

  // While paused the desktop app freezes secondsRemaining, so stop ticking
  // locally too — otherwise the displayed countdown would drift down between
  // 3s status polls even though the real session clock isn't moving.
  if (session.isPaused) {
    stopCountdown();
    countdownEl.textContent = formatCountdown(session.endTime - Date.now());
  } else {
    startCountdown(session.endTime);
  }
}

function stopStatusPoll() {
  if (statusPollInterval) {
    clearInterval(statusPollInterval);
    statusPollInterval = null;
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "getStatus" }, (response) => {
    const session = response?.session;
    if (session?.isActive) {
      renderActiveSession(session);
    } else {
      stopStatusPoll();
      stopCountdown();
      showSetupView();
    }
  });
}

refreshStatus();
statusPollInterval = setInterval(refreshStatus, 3000);
