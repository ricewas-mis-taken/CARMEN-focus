// Focus Tracker background service worker (MV3)
//
// Session state (active/inactive, lock mode, duration, whitelists, violation
// count) lives in the desktop app, not chrome.storage.local. This service
// worker only keeps `lastAcceptableUrl` in memory, since it's a per-tab-check
// bookkeeping detail the desktop API has no endpoint to store.

const API_BASE = "http://127.0.0.1:5847";
const ALARM_NAME = "focusSessionEnd";

function defaultSession() {
  return {
    isActive: false,
    isPaused: false,
    endTime: 0,
    lockMode: "soft",
    domainWhitelist: [],
    processWhitelist: [],
    lastAcceptableUrl: "",
    violationCount: 0,
    violationLog: [],
  };
}

let lastAcceptableUrl = "";

async function apiFetch(path, options) {
  const res = await fetch(`${API_BASE}${path}`, options);
  if (!res.ok) {
    throw new Error(`Desktop API ${path} responded with ${res.status}`);
  }
  return res.json();
}

async function getSession() {
  try {
    const data = await apiFetch("/status", { method: "GET" });
    return {
      isActive: !!data.isActive,
      isPaused: !!data.isPaused,
      // The API reports secondsRemaining, not an absolute end_time — derive
      // one for the countdown/alarm logic that wants a timestamp to compare against.
      endTime: data.isActive ? Date.now() + (data.secondsRemaining || 0) * 1000 : 0,
      lockMode: data.lockMode || "soft",
      domainWhitelist: data.domainWhitelist || [],
      processWhitelist: data.processWhitelist || [],
      violationCount: data.violationCount || 0,
      violationLog: data.violationLog || [],
      lastAcceptableUrl,
    };
  } catch (err) {
    console.warn(
      "Focus Tracker: could not reach desktop app at",
      API_BASE,
      "- treating session as inactive.",
      err
    );
    return defaultSession();
  }
}

// Chrome briefly rejects tab-editing calls right after a user clicks/drags a
// tab ("Tabs cannot be edited right now (user may be dragging a tab)") even
// though nothing is actually being dragged — this is a known false-positive
// in Chrome's drag-detection heuristic. The error clears itself within a
// couple hundred ms, so retry a few times instead of giving up outright.
async function withDragRetry(fn, attempts = 10, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const isDragLock = /may be dragging a tab/i.test(err?.message || "");
      if (!isDragLock || i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function isWhitelisted(url, whitelist) {
  if (!url) return true;
  if (!whitelist || whitelist.length === 0) return false;
  const lowerUrl = url.toLowerCase();
  return whitelist.some((entry) => {
    const trimmed = (entry || "").trim().toLowerCase();
    return trimmed.length > 0 && lowerUrl.includes(trimmed);
  });
}

// Hard lock needs somewhere safe to send the user. If we haven't seen a
// whitelisted URL yet this session, fall back to the first whitelist entry
// instead of doing nothing.
function buildFallbackUrl(domainWhitelist) {
  const first = (domainWhitelist || []).find((entry) => (entry || "").trim().length > 0);
  if (!first) return "";
  const trimmed = first.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function formatTimeRemaining(endTime) {
  const msLeft = Math.max(0, endTime - Date.now());
  const totalSeconds = Math.ceil(msLeft / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatDurationSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

// Fires the "session complete" notification for a natural (alarm-based) end.
// GET /status self-finalizes an expired session on any poll (e.g. the popup's
// 3s status poll), which resets violationCount/violationLog to zero before
// our own /session/end call can see them — so read the just-appended entry
// from GET /history instead, which always has the real numbers regardless of
// who finalized the session first.
async function notifySessionComplete() {
  try {
    const history = await apiFetch("/history", { method: "GET" });
    const lastEntry = history[history.length - 1];
    if (!lastEntry) return;

    const violationLog = lastEntry.violationLog || [];
    const domainViolations = violationLog.filter((entry) => entry.kind === "domain");

    const now = Date.now();
    const offTaskSeconds = domainViolations.reduce((total, entry) => {
      if (typeof entry.durationSeconds === "number") {
        return total + entry.durationSeconds;
      }
      // Still open when the session ended: count it through to session end.
      const startedAt = new Date(entry.timestamp).getTime();
      return total + Math.max(0, (now - startedAt) / 1000);
    }, 0);

    const count = domainViolations.length;
    const message =
      count > 0
        ? `${count} tab violation${count === 1 ? "" : "s"}, ${formatDurationSeconds(
            offTaskSeconds
          )} off-task.`
        : "No tab violations — nice work.";

    chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon128.png"),
      title: "Focus session complete — you're free to go!",
      message,
    });
  } catch (err) {
    console.warn("Focus Tracker: could not build session-complete notification.", err);
  }
}

// Tracks the last URL we already evaluated per tab, so repeated onUpdated /
// onActivated events for the same navigation don't double-count violations.
const lastHandledUrlByTab = new Map();

// Tracks which restricted domain the soft-lock overlay was last shown for in
// a given tab, so navigating around within that same domain (SPA routing,
// clicking links) doesn't re-pop the overlay on every single navigation.
// Cleared only when the tab actually loses focus (switched away from), so
// coming back to the same domain after switching tabs still shows it again.
const overlayDomainByTab = new Map();
const activeTabByWindow = new Map();

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return url;
  }
}

async function handleTabUrl(tabId, url) {
  console.log("Focus Tracker: handleTabUrl fired", { tabId, url });

  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  const session = await getSession();
  if (!session.isActive) return;

  const whitelisted = isWhitelisted(url, session.domainWhitelist);
  console.log("Focus Tracker: checking url against domainWhitelist", {
    url,
    domainWhitelist: session.domainWhitelist,
    whitelisted,
  });

  if (whitelisted) {
    lastAcceptableUrl = url;
    // The desktop app can't observe tab changes itself, so tell it whenever
    // the active tab goes from off-whitelist to on-whitelist, in case a
    // domain violation was open and needs to be resolved.
    try {
      await apiFetch("/violation/resolved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "domain" }),
      });
    } catch (err) {
      console.warn(
        "Focus Tracker: could not report violation resolution to desktop app.",
        err
      );
    }
    return;
  }

  // Violation counting is owned by the desktop app; report it so /status's
  // violation_count reflects what actually happened in the browser.
  try {
    await apiFetch("/violation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  } catch (err) {
    console.warn("Focus Tracker: could not report violation to desktop app.", err);
  }

  if (session.lockMode === "hard") {
    // Normal case: don't touch the offending tab itself — leave its URL
    // alone and just switch focus away from it, so it's still open but not
    // what the user is looking at. The one case this can't handle is the
    // user grabbing the tab to drag it (there's no API to disable dragging
    // itself) — Chrome rejects our tabs.update/tabs.create calls with "user
    // may be dragging a tab" while that's happening. When that specific
    // error shows up, it means a switch-away won't work, so close the
    // offending tab instead — dragging a tab that no longer exists reveals
    // nothing.
    const isDragLockError = (err) => /may be dragging a tab/i.test(err?.message || "");

    try {
      const currentTab = await chrome.tabs.get(tabId);
      const tabs = await chrome.tabs.query({});
      const isCandidate = (t) =>
        t.id !== tabId &&
        t.url &&
        /^https?:\/\//i.test(t.url) &&
        isWhitelisted(t.url, session.domainWhitelist);

      const regulatedTab =
        tabs.find((t) => isCandidate(t) && t.windowId === currentTab.windowId) ||
        tabs.find(isCandidate);

      console.log("Focus Tracker: hard lock triggered", {
        tabId,
        url,
        currentWindowId: currentTab.windowId,
        regulatedTab: regulatedTab
          ? { id: regulatedTab.id, url: regulatedTab.url, windowId: regulatedTab.windowId }
          : null,
      });

      try {
        if (regulatedTab) {
          await chrome.tabs.update(regulatedTab.id, { active: true });
          if (regulatedTab.windowId !== currentTab.windowId) {
            const win = await chrome.windows.get(regulatedTab.windowId);
            await chrome.windows.update(regulatedTab.windowId, {
              focused: true,
              ...(win.state === "minimized" ? { state: "normal" } : {}),
            });
          }
          lastAcceptableUrl = regulatedTab.url;
        } else {
          const fallback = buildFallbackUrl(session.domainWhitelist);
          if (!fallback) {
            console.warn(
              "Focus Tracker: hard lock triggered but domainWhitelist has no usable entries to open."
            );
            return;
          }
          await chrome.tabs.create({
            url: fallback,
            active: true,
            windowId: currentTab.windowId,
          });
          lastAcceptableUrl = fallback;
        }
      } catch (err) {
        if (!isDragLockError(err)) throw err;
        console.log(
          "Focus Tracker: switch-away blocked by an in-progress drag, closing the offending tab instead",
          { tabId }
        );
        await withDragRetry(() => chrome.tabs.remove(tabId));
      }
    } catch (err) {
      console.error("Focus Tracker: hard lock action failed.", err);
    }
    return;
  }

  // Soft lock: inject overlay script, then message it to render — but only
  // if this is a fresh arrival at the domain (first visit, or coming back
  // after switching away to another tab), not just another navigation
  // within the same restricted domain in the tab that's already active.
  const hostname = getHostname(url);
  if (overlayDomainByTab.get(tabId) === hostname) return;
  overlayDomainByTab.set(tabId, hostname);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/overlay.js"],
    });
    const timeRemainingText = formatTimeRemaining(session.endTime);
    await chrome.tabs.sendMessage(tabId, {
      type: "showOverlay",
      timeRemainingText,
    });
  } catch (err) {
    // Tab may not support script injection (e.g. chrome:// pages); ignore.
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  console.log("Focus Tracker: onActivated fired", { tabId, windowId });
  try {
    // Only treat this as a genuine "left and came back" if a DIFFERENT tab
    // was active in this window beforehand — that's what should let the
    // soft-lock overlay pop again. Clear the previously-active tab's
    // overlay suppression, not this one's.
    const previousTabId = activeTabByWindow.get(windowId);
    if (previousTabId !== undefined && previousTabId !== tabId) {
      overlayDomainByTab.delete(previousTabId);
    }
    activeTabByWindow.set(windowId, tabId);

    const tab = await chrome.tabs.get(tabId);
    // Switching back to a tab is a fresh "the user is looking at this now"
    // event — re-evaluate even if we already handled this exact URL before,
    // so the soft-lock overlay (which auto-dismisses after its grace period)
    // reappears instead of staying silently suppressed.
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {
    // Ignore.
  }
});

// onActivated only fires when the *active tab within a window* changes. If
// the offending tab is the active tab of its window and the user simply
// refocuses that window (e.g. Alt+Tab back to it) without switching tabs
// inside it, no tab-activation event fires at all — so hard lock never
// re-evaluates it and the "switch away" never re-triggers. Catch that case
// by re-checking whichever tab is active in a window the moment it gains
// OS focus.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  console.log("Focus Tracker: onFocusChanged fired", { windowId });
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab) return;
    lastHandledUrlByTab.delete(activeTab.id);
    await handleTabUrl(activeTab.id, activeTab.url);
  } catch (err) {
    // Ignore.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  console.log("Focus Tracker: onUpdated fired", { tabId, changeInfo });
  if (changeInfo.status === "complete" && tab.url) {
    await handleTabUrl(tabId, tab.url);
  } else if (changeInfo.url) {
    await handleTabUrl(tabId, changeInfo.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastHandledUrlByTab.delete(tabId);
  overlayDomainByTab.delete(tabId);
});

// Dragging a tab (reordering it, or tearing it into its own window) doesn't
// fire onActivated if the tab was already active going into the drag — it's
// exactly the case where our own tabs.update/tabs.create calls hit Chrome's
// "user may be dragging a tab" lock. onMoved/onAttached fire once the drag
// actually changes something, so use them as a second chance to re-enforce
// hard lock once the drag settles, in case the retries during the drag ran
// out before it ended.
async function recheckIfActive(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return;
    lastHandledUrlByTab.delete(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {
    // Ignore.
  }
}

chrome.tabs.onMoved.addListener((tabId) => {
  console.log("Focus Tracker: onMoved fired", { tabId });
  recheckIfActive(tabId);
});

chrome.tabs.onAttached.addListener((tabId) => {
  console.log("Focus Tracker: onAttached fired", { tabId });
  recheckIfActive(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    lastAcceptableUrl = "";
    try {
      await apiFetch("/session/end", { method: "POST" });
      await notifySessionComplete();
    } catch (err) {
      console.warn(
        "Focus Tracker: could not reach desktop app to end session.",
        err
      );
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      const { durationMinutes, lockMode, domainWhitelist } = message.payload;

      let seedUrl = "";
      try {
        const [activeTab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        // Only seed lastAcceptableUrl if the starting tab is actually
        // whitelisted — otherwise hard-lock has nowhere safe to redirect to
        // and can loop between two non-whitelisted tabs.
        if (activeTab?.url && isWhitelisted(activeTab.url, domainWhitelist)) {
          seedUrl = activeTab.url;
        }
      } catch (err) {
        // Ignore.
      }
      lastAcceptableUrl = seedUrl;

      try {
        const data = await apiFetch("/session/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            duration_minutes: durationMinutes,
            lock_mode: lockMode,
            domain_whitelist: domainWhitelist,
            process_whitelist: null,
          }),
        });

        lastHandledUrlByTab.clear();
        const endTime =
          typeof data.secondsRemaining === "number"
            ? Date.now() + data.secondsRemaining * 1000
            : Date.now() + durationMinutes * 60 * 1000;
        await chrome.alarms.clear(ALARM_NAME);
        chrome.alarms.create(ALARM_NAME, { when: endTime });

        sendResponse({ ok: true });
      } catch (err) {
        console.warn(
          "Focus Tracker: could not reach desktop app to start session.",
          err
        );
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      lastAcceptableUrl = "";
      await chrome.alarms.clear(ALARM_NAME);
      try {
        await apiFetch("/session/end", { method: "POST" });
        await notifySessionComplete();
        sendResponse({ ok: true });
      } catch (err) {
        console.warn(
          "Focus Tracker: could not reach desktop app to end session.",
          err
        );
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "pauseSession") {
    (async () => {
      try {
        // Lock enforcement stays on while paused — only the countdown
        // freezes — so just stop the end-of-session alarm from firing
        // early; handleTabUrl's checks are untouched.
        await chrome.alarms.clear(ALARM_NAME);
        await apiFetch("/session/pause", { method: "POST" });
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("Focus Tracker: could not reach desktop app to pause session.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "resumeSession") {
    (async () => {
      try {
        const data = await apiFetch("/session/resume", { method: "POST" });
        const endTime =
          typeof data.secondsRemaining === "number"
            ? Date.now() + data.secondsRemaining * 1000
            : 0;
        if (endTime > 0) {
          chrome.alarms.create(ALARM_NAME, { when: endTime });
        }
        sendResponse({ ok: true });
      } catch (err) {
        console.warn("Focus Tracker: could not reach desktop app to resume session.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "addWhitelistDomain") {
    (async () => {
      const { domain, reason } = message.payload || {};
      if (!domain || !domain.trim() || !reason || !reason.trim()) {
        sendResponse({ ok: false, error: "domain and reason are both required" });
        return;
      }
      try {
        const data = await apiFetch("/whitelist/domains/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: domain.trim(), reason: reason.trim() }),
        });
        sendResponse({ ok: true, domainWhitelist: data.domainWhitelist });
      } catch (err) {
        console.warn("Focus Tracker: could not add domain to whitelist.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "getStatus") {
    (async () => {
      const session = await getSession();
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  if (message?.type === "getHistory") {
    (async () => {
      try {
        const history = await apiFetch("/history", { method: "GET" });
        sendResponse({ ok: true, history });
      } catch (err) {
        console.warn("Focus Tracker: could not fetch history.", err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return false;
});
