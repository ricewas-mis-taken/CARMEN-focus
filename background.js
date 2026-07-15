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

// Epoch-ms timestamps are ~13 digits; epoch-seconds are ~10. Normalize
// defensively since the desktop app's units for end_time aren't pinned down
// here — if this guess is wrong, fix it in this one spot.
function normalizeEndTime(value) {
  if (!value) return 0;
  return value < 1e12 ? value * 1000 : value;
}

async function getSession() {
  try {
    const data = await apiFetch("/status", { method: "GET" });
    return {
      isActive: !!data.active,
      endTime: normalizeEndTime(data.end_time),
      lockMode: data.lock_mode || "soft",
      domainWhitelist: data.domain_whitelist || [],
      processWhitelist: data.process_whitelist || [],
      violationCount: data.violation_count || 0,
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

// Tracks the last URL we already evaluated per tab, so repeated onUpdated /
// onActivated events for the same navigation don't double-count violations.
const lastHandledUrlByTab = new Map();

async function handleTabUrl(tabId, url) {
  if (!url || !/^https?:\/\//i.test(url)) return;
  if (lastHandledUrlByTab.get(tabId) === url) return;
  lastHandledUrlByTab.set(tabId, url);

  const session = await getSession();
  if (!session.isActive) return;

  if (isWhitelisted(url, session.domainWhitelist)) {
    lastAcceptableUrl = url;
    return;
  }

  // Violation counting itself is owned by the desktop app (see /status);
  // the extension has no endpoint to report this violation upstream.

  if (session.lockMode === "hard") {
    if (lastAcceptableUrl && lastAcceptableUrl !== url) {
      try {
        await chrome.tabs.update(tabId, { url: lastAcceptableUrl });
      } catch (err) {
        // Tab may no longer exist; ignore.
      }
    }
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
  try {
    const tab = await chrome.tabs.get(tabId);
    await handleTabUrl(tabId, tab.url);
  } catch (err) {
    // Ignore.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
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
      const { durationMinutes, lockMode, domainWhitelist, processWhitelist } =
        message.payload;

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
            process_whitelist: processWhitelist,
          }),
        });

        lastHandledUrlByTab.clear();
        const endTime =
          normalizeEndTime(data.end_time) ||
          Date.now() + durationMinutes * 60 * 1000;
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
