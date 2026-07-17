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
const eventSourceRowEl = document.getElementById("event-source-row");
const eventSourceTitleEl = document.getElementById("event-source-title");
const browserOnlyRowEl = document.getElementById("browser-only-row");

const addSiteInput = document.getElementById("add-site-input");
const addSiteBtn = document.getElementById("add-site-btn");
const addSiteReasonRow = document.getElementById("add-site-reason-row");
const addSiteReasonInput = document.getElementById("add-site-reason");
const addSiteCancelBtn = document.getElementById("add-site-cancel-btn");
const addSiteSubmitBtn = document.getElementById("add-site-submit-btn");
const addSiteStatusEl = document.getElementById("add-site-status");

const reviewAdditionsBtn = document.getElementById("review-additions-btn");

const SAVED_WHITELIST_KEY = "savedDomainWhitelist";
const SESSION_ADDITIONS_KEY = "sessionAddedDomains";

chrome.storage.local.get(SAVED_WHITELIST_KEY, (data) => {
  const saved = data[SAVED_WHITELIST_KEY];
  if (Array.isArray(saved) && saved.length > 0) {
    whitelistTextarea.value = saved.join("\n");
  }
});

// "Add a site" mid-session only applies to that one session — it's never
// written to SAVED_WHITELIST_KEY. Surface a button here (setup view only,
// i.e. only once there's no session running) whenever the last session
// added something that isn't already on the saved whitelist, so the user
// can fold it in instead of retyping it.
async function refreshReviewAdditionsButton() {
  const data = await chrome.storage.local.get([SESSION_ADDITIONS_KEY, SAVED_WHITELIST_KEY]);
  const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
  const saved = Array.isArray(data[SAVED_WHITELIST_KEY]) ? data[SAVED_WHITELIST_KEY] : [];
  const savedSet = new Set(saved.map((d) => (d || "").trim().toLowerCase()));

  const unsavedDomains = new Set(
    additions
      .map((entry) => (entry.domain || "").trim().toLowerCase())
      .filter((domain) => domain && !savedSet.has(domain))
  );

  if (unsavedDomains.size === 0) {
    reviewAdditionsBtn.classList.add("hidden");
    return;
  }
  reviewAdditionsBtn.textContent = `Add ${unsavedDomains.size} site${
    unsavedDomains.size === 1 ? "" : "s"
  } from last session`;
  reviewAdditionsBtn.classList.remove("hidden");
}

reviewAdditionsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("additions/additions.html") });
});

refreshReviewAdditionsButton();

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

whitelistTextarea.addEventListener("input", () => {
  whitelistTextarea.style.borderColor = "";
});

// If the desktop app is unreachable, a single click doesn't silently start a
// degraded, unsynced session — the button arms into a "confirm" state and
// the user has to click it again to actually start browser-only. Requiring
// that second, explicit click is the whole point: it's an intentional
// choice, not something that happens by default just because the desktop
// app happened to be closed.
let awaitingBrowserOnlyConfirm = false;
let browserOnlyArmTimeout = null;
const BROWSER_ONLY_ARM_WINDOW_MS = 5000;

function disarmBrowserOnlyConfirm() {
  awaitingBrowserOnlyConfirm = false;
  clearTimeout(browserOnlyArmTimeout);
  browserOnlyArmTimeout = null;
  startBtn.classList.remove("confirm-browser-only");
  startBtn.textContent = "Start Focus Session";
}

function armBrowserOnlyConfirm() {
  awaitingBrowserOnlyConfirm = true;
  startBtn.classList.add("confirm-browser-only");
  startBtn.textContent = "Desktop unreachable — click again for browser-only";
  clearTimeout(browserOnlyArmTimeout);
  browserOnlyArmTimeout = setTimeout(disarmBrowserOnlyConfirm, BROWSER_ONLY_ARM_WINDOW_MS);
}

startBtn.addEventListener("click", async () => {
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

  // Hard lock with an empty whitelist has nowhere safe to send you — every
  // tab looks like a violation and there's no fallback destination, so
  // enforcement just silently gives up and does nothing at all. Catch that
  // here instead of letting the session start and appear completely broken.
  if (selectedLockMode === "hard" && domainWhitelist.length === 0) {
    whitelistTextarea.style.borderColor = "#e5484d";
    whitelistTextarea.placeholder = "Add at least one site — hard lock needs somewhere to send you";
    return;
  }

  // This is the user's manually pre-filled whitelist — only the manual
  // start flow writes it. A calendar-event session's whitelist is a
  // temporary per-session override (set directly via the desktop API, not
  // through this popup) and must never land here, or the next manual
  // session would silently start with someone else's event's sites.
  //
  // Awaited deliberately: popups can be torn down the instant the user
  // clicks away, which aborts any storage write still in flight. Without
  // waiting for this to actually commit before doing anything else, an
  // edit made right before hitting Start (e.g. deleting a domain) could
  // silently fail to save, leaving the deleted domain back in the list the
  // next time the popup opens.
  await chrome.storage.local.set({ [SAVED_WHITELIST_KEY]: domainWhitelist });

  const browserOnly = awaitingBrowserOnlyConfirm;

  startBtn.disabled = true;
  chrome.runtime.sendMessage(
    {
      type: "startSession",
      payload: {
        durationMinutes,
        lockMode: selectedLockMode,
        domainWhitelist,
        browserOnly,
      },
    },
    (response) => {
      startBtn.disabled = false;
      if (response?.ok) {
        disarmBrowserOnlyConfirm();
        refreshStatus();
      } else if (response?.desktopUnreachable && !browserOnly) {
        armBrowserOnlyConfirm();
      } else {
        disarmBrowserOnlyConfirm();
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
  disarmBrowserOnlyConfirm();
  refreshReviewAdditionsButton();
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

  // Calendar-event sessions run on a whitelist scoped to that event, not
  // the whitelist saved in this popup's textarea — flag that here so the
  // "Allowed sites" list not matching what the user manually typed in
  // doesn't read as a bug.
  const isEventSourced = session.source === "calendar-event";
  eventSourceRowEl.classList.toggle("hidden", !isEventSourced);
  eventSourceTitleEl.textContent = isEventSourced
    ? session.eventTitle || "Calendar event"
    : "";

  browserOnlyRowEl.classList.toggle("hidden", session.source !== "browser-only");

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
