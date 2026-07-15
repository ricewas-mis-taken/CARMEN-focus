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

// Hard lock never touches the offending tab's page — it just moves the
// user's attention to a whitelisted one instead. Prefers an already-open
// whitelisted tab; if none is open, opens the first whitelist entry in a
// new tab. Either way, focuses that tab and its window.
async function focusWhitelistedTab(offendingTabId, domainWhitelist) {
  try {
    const tabs = await chrome.tabs.query({});
    let target = tabs.find(
      (t) =>
        t.id !== offendingTabId &&
        t.url &&
        /^https?:\/\//i.test(t.url) &&
        isWhitelisted(t.url, domainWhitelist)
    );

    if (!target) {
      const fallbackUrl = buildFallbackUrl(domainWhitelist);
      if (!fallbackUrl) {
        console.warn(
          "Focus Tracker: hard lock triggered but domainWhitelist has no usable entries to open."
        );
        return;
      }
      target = await chrome.tabs.create({ url: fallbackUrl, active: true });
    }

    await chrome.tabs.update(target.id, { active: true });
    await chrome.windows.update(target.windowId, { focused: true });
    lastAcceptableUrl = target.url || buildFallbackUrl(domainWhitelist);
  } catch (err) {
    // Tab or window may no longer exist; ignore.
  }
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
    await focusWhitelistedTab(tabId, session.domainWhitelist);
    return;
  }

  // Soft lock: inject overlay script, then message it to render.
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

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  console.log("Focus Tracker: onActivated fired", { tabId });
  try {
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

  if (message?.type === "getStatus") {
    (async () => {
      const session = await getSession();
      sendResponse({ ok: true, session });
    })();
    return true;
  }

  return false;
});
