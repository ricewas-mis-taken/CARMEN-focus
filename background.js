// Focus Tracker background service worker (MV3)
//
// Session state (active/inactive, lock mode, duration, whitelists, violation
// count) lives in the desktop app, not chrome.storage.local — except for
// browser-only sessions (see LOCAL_SESSION_KEY below), which run without a
// desktop app at all and so need somewhere durable of their own to live.
// This service worker only keeps `lastAcceptableUrl` in memory, since it's a
// per-tab-check bookkeeping detail neither store needs to persist.

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
    source: "manual",
    eventId: null,
    eventTitle: null,
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

// Fallback session store for when the desktop app is unreachable. Unlike the
// desktop-backed session (server-side state, polled via /status), this has
// to survive service-worker restarts on its own, so it lives in
// chrome.storage.local rather than an in-memory variable.
const LOCAL_SESSION_KEY = "browserOnlySession";

function defaultLocalSession() {
  return {
    isActive: false,
    isPaused: false,
    endTime: 0,
    pausedRemainingMs: 0,
    lockMode: "soft",
    domainWhitelist: [],
    violationCount: 0,
  };
}

async function getLocalSession() {
  const data = await chrome.storage.local.get(LOCAL_SESSION_KEY);
  return { ...defaultLocalSession(), ...(data[LOCAL_SESSION_KEY] || {}) };
}

async function setLocalSession(session) {
  await chrome.storage.local.set({ [LOCAL_SESSION_KEY]: session });
}

// Sites added mid-session via "Add a site" only apply to that one session —
// they're never written to SAVED_WHITELIST_KEY (popup.js's persisted
// whitelist), so they're gone the moment the session ends unless the user
// retypes them. Track them separately here so the popup can offer to fold
// them into the saved whitelist once the session is over. Reset at the
// start of each session (see startSession below) and left alone when a
// session ends, so this always reflects "what got added during the most
// recently started session" for the setup view to read back.
const SESSION_ADDITIONS_KEY = "sessionAddedDomains";

// chrome.storage.local has no read-modify-write primitive, so two
// "addWhitelistDomain" messages handled concurrently (e.g. the popup was
// closed and reopened mid-request, so the second add isn't actually waiting
// on the first) can both read the same starting array/object before either
// write lands, and whichever set() resolves last silently clobbers the
// other's addition. Route every read-modify-write against session/whitelist
// storage through this single queue so they're never interleaved.
let storageQueue = Promise.resolve();
function withStorageLock(fn) {
  const result = storageQueue.then(fn, fn);
  storageQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

async function recordSessionAddition(domain, reason) {
  return withStorageLock(async () => {
    const data = await chrome.storage.local.get(SESSION_ADDITIONS_KEY);
    const additions = Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : [];
    additions.push({ domain, reason, addedAt: Date.now() });
    await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: additions });
  });
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
      // "manual" (popup-started, using the saved whitelist) or
      // "calendar-event" (a temporary per-session override from the desktop
      // API). Purely descriptive — enforcement below still just reads
      // domainWhitelist/lockMode the same way regardless of source; this is
      // only surfaced so the popup can show why the active whitelist isn't
      // the user's manually saved one.
      source: data.source || "manual",
      eventId: data.eventId || null,
      eventTitle: data.eventTitle || null,
      desktopReachable: true,
    };
  } catch (err) {
    console.warn(
      "Focus Tracker: could not reach desktop app at",
      API_BASE,
      "- checking for a browser-only session instead.",
      err
    );
    const local = await getLocalSession();
    if (!local.isActive) {
      return { ...defaultSession(), desktopReachable: false };
    }
    return {
      isActive: true,
      isPaused: local.isPaused,
      endTime: local.endTime,
      lockMode: local.lockMode,
      domainWhitelist: local.domainWhitelist,
      processWhitelist: [],
      violationCount: local.violationCount,
      violationLog: [],
      lastAcceptableUrl,
      source: "browser-only",
      eventId: null,
      eventTitle: null,
      desktopReachable: false,
    };
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

// chrome.tabs.remove() can resolve without throwing yet not actually close
// the tab — when a tab was torn off into its own window and is still being
// tracked by an in-progress OS-level window drag, removing it out from
// under that drag leaves the window itself behind as an orphaned, empty
// shell that reads as "minimized" instead of gone. A clean resolve from
// remove() isn't proof the tab is actually closed, so confirm it, and treat
// "still there" as the same kind of transient drag-lock failure that
// withDragRetry already knows how to retry.
async function removeTabVerified(tabId) {
  await chrome.tabs.remove(tabId);
  try {
    await chrome.tabs.get(tabId);
  } catch (err) {
    return; // Gone, as expected — chrome.tabs.get throws for a missing tab.
  }
  throw new Error("Tabs cannot be edited right now (user may be dragging a tab)");
}

// Same "resolved but not actually gone" gap as removeTabVerified, one level
// up: chrome.windows.remove() can also get rejected (or silently not take)
// while the drag lock is held, and an interrupted drag on a torn-off window
// is exactly what Windows tends to leave as a stray *minimized* window
// instead of removing it — so this needs the same verify-and-retry treatment
// as the tab-level removal, not a single unguarded attempt.
async function removeWindowVerified(windowId) {
  await chrome.windows.remove(windowId);
  try {
    await chrome.windows.get(windowId);
  } catch (err) {
    return; // Gone, as expected — chrome.windows.get throws for a missing window.
  }
  throw new Error("Tabs cannot be edited right now (user may be dragging a tab)");
}

// Last resort once every retry above is exhausted and the tab is still
// sitting there: it's very likely the sole tab of a torn-off window stuck
// mid-drag, so go one level up and close that window directly instead of
// leaving it stranded on screen.
async function forceCloseTab(tabId) {
  try {
    await withDragRetry(() => removeTabVerified(tabId));
  } catch (err) {
    try {
      const tab = await chrome.tabs.get(tabId);
      await withDragRetry(() => removeWindowVerified(tab.windowId));
    } catch (cleanupErr) {
      console.error(
        "Focus Tracker: could not force-close a stranded drag tab/window.",
        cleanupErr
      );
    }
  }
}

// A whitelist entry is either a bare domain ("docs.google.com") or a
// domain-plus-path substring ("docs.google.com/document/d/xyz") — the
// popup's own hint text says "one domain or URL substring per line", so
// path-scoped entries have to keep working. But matching that substring
// against the *entire* URL (as this used to) is a self-defeating check for
// a self-imposed lock: any restricted page can "become whitelisted" just by
// having the string appear in its query string or hash, e.g.
// "https://reddit.com/?ref=docs.google.com", and a bare-domain entry like
// "github.com" would also match unrelated hosts like "evilgithub.com" or
// "github.com.evil.com" since those literally contain the substring. Bare
// domains are matched against the hostname only (exact or subdomain);
// path-scoped entries are matched against origin+pathname, which excludes
// the attacker/self-controllable query string and hash.
// A handful of well-known services are commonly typed as one domain but
// actually served from another (Gmail is "gmail.com" in every user's head
// but its pages live on mail.google.com) — bare-domain matching alone can
// never bridge that since neither is a subdomain of the other. Each group
// here is treated as mutually interchangeable: whitelisting any member
// whitelists the hostname (and its subdomains) of every other member too.
const DOMAIN_EQUIVALENTS = [["gmail.com", "mail.google.com"]];

function equivalentHostnames(domain) {
  const group = DOMAIN_EQUIVALENTS.find((g) => g.includes(domain));
  return group || [domain];
}

function isWhitelisted(url, whitelist) {
  if (!url) return true;
  if (!whitelist || whitelist.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  const originAndPath = (parsed.origin + parsed.pathname).toLowerCase();

  return whitelist.some((entry) => {
    const trimmed = (entry || "").trim().toLowerCase();
    if (!trimmed) return false;
    const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
    if (!withoutProtocol.includes("/")) {
      return equivalentHostnames(withoutProtocol).some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    }
    return originAndPath.includes(withoutProtocol);
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

// Service workers have no Audio()/Web Audio API, so a completion chime has
// to be played from an offscreen document instead — the only extension
// context that has a DOM at all. The document plays its chime immediately
// on load (see offscreen.js) rather than waiting for a runtime message, so
// there's nothing that can race a not-yet-registered listener. Close any
// previous document first (chrome.offscreen only allows one at a time) so
// createDocument always yields a genuinely fresh, guaranteed-to-load
// document instead of silently reusing a stale one from a prior call.
async function playCompletionSound() {
  try {
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      // No existing document to close — fine, that's the common case.
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a completion chime when a focus session ends.",
    });
    // Give the chime (~0.5s) time to finish before tearing the document
    // back down.
    setTimeout(() => {
      chrome.offscreen.closeDocument().catch(() => {});
    }, 1500);
  } catch (err) {
    console.warn("Focus Tracker: could not play completion sound.", err);
  }
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
      silent: false,
    });
    await playCompletionSound();
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

// Tracks tabs that currently have an unresolved (already-counted) violation
// open. onActivated/onFocusChanged/onMoved/onAttached all clear
// lastHandledUrlByTab to force hard/soft lock to re-enforce a tab that's
// still sitting on a restricted page (e.g. re-switch-away after a drag
// settles) — but re-running enforcement isn't a new violation, so counting
// must be gated separately or every one of those re-checks (a redirect hop
// landing on a second non-whitelisted URL, onMoved firing dozens of times
// during a single tab drag, switching away and back) adds its own count for
// what's really one continuous episode. Only cleared when the tab reaches a
// whitelisted URL (paired with /violation/resolved) or closes.
const openViolationTabs = new Set();

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
    const hadOpenViolation = openViolationTabs.delete(tabId);
    // Browser-only sessions have no desktop app to tell — violation state
    // lives entirely in local storage for that mode.
    if (session.source === "browser-only") return;
    // The desktop app can't observe tab changes itself, so tell it whenever
    // the active tab goes from off-whitelist to on-whitelist, in case a
    // domain violation was open and needs to be resolved. Only bother if we
    // actually had one open — an already-whitelisted tab re-evaluating
    // (e.g. a drag settling) has nothing to resolve.
    if (!hadOpenViolation) return;
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
  // violation_count reflects what actually happened in the browser. Browser-
  // only sessions have no desktop app to report to, so count locally instead.
  // Only count once per open violation episode — re-enforcement re-checks
  // (drag settling, refocusing the window, a redirect hop that's still
  // off-whitelist) land here too, but they're the same ongoing violation,
  // not a new one.
  if (!openViolationTabs.has(tabId)) {
    openViolationTabs.add(tabId);
    if (session.source === "browser-only") {
      const local = await getLocalSession();
      if (local.isActive) {
        await setLocalSession({ ...local, violationCount: (local.violationCount || 0) + 1 });
      }
    } else {
      try {
        await apiFetch("/violation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
        });
      } catch (err) {
        console.warn("Focus Tracker: could not report violation to desktop app.", err);
      }
    }
  }

  // onUpdated fires for every tab regardless of whether it's the one the
  // user is actually looking at — e.g. middle-clicking a search result opens
  // a background tab, or a background tab auto-refreshes. Without this
  // check, that background navigation would still trigger hard lock's
  // switch-away/close (stealing focus from whatever the user IS legitimately
  // doing) or inject the soft-lock overlay into a tab nobody's viewing. Only
  // enforce on the tab that's actually active; if a restricted background
  // tab later gets clicked into, onActivated re-evaluates it fresh at that
  // point anyway.
  let currentTab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch (err) {
    return;
  }
  if (!currentTab.active) return;

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

      const switchAway = async () => {
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
      };

      // A plain click also trips the drag lock on its first attempt (see
      // the withDragRetry comment below) and clears on the very next retry
      // — so blackout can't arm on the first failure or it would flash on
      // every ordinary click. Only a hold keeps failing past that, so arm
      // it after a few consecutive failures (~600ms), which a click never
      // reaches but a sustained hold does.
      const BLACKOUT_AFTER_FAILURES = 3;
      let consecutiveFailures = 0;
      let blackoutShown = false;
      const ensureBlackout = async () => {
        if (blackoutShown) return;
        blackoutShown = true;
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content/overlay.js"],
          });
          await chrome.tabs.sendMessage(tabId, { type: "showBlackout" });
        } catch (err) {
          // Tab may not support script injection (e.g. chrome:// pages); ignore.
        }
      };
      const clearBlackout = async () => {
        if (!blackoutShown) return;
        try {
          await chrome.tabs.sendMessage(tabId, { type: "hideBlackout" });
        } catch (err) {
          // Tab already gone or never had it injected; ignore.
        }
      };

      try {
        // A plain click on the tab also trips Chrome's "user may be
        // dragging a tab" heuristic for a brief moment (mouse button down),
        // not just an actual drag — so the switch-away itself needs the
        // same retry treatment as the tab-close fallback below, instead of
        // giving up after a single attempt. A real, sustained drag will
        // still exhaust these retries and fall through to closing the tab;
        // a click releases well within the retry window and just succeeds.
        await withDragRetry(async () => {
          try {
            await switchAway();
            consecutiveFailures = 0;
            await clearBlackout();
          } catch (err) {
            if (isDragLockError(err)) {
              consecutiveFailures++;
              if (consecutiveFailures >= BLACKOUT_AFTER_FAILURES) await ensureBlackout();
            }
            throw err;
          }
        });
      } catch (err) {
        if (!isDragLockError(err)) throw err;
        console.log(
          "Focus Tracker: switch-away still blocked after retries, closing the offending tab instead",
          { tabId }
        );
        await forceCloseTab(tabId);
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

// Whatever just changed (session started, a domain got whitelisted
// mid-session) makes whichever tab is currently active in each window
// possibly-stale — it may have been evaluated under the old rules. Re-check
// it immediately instead of waiting for some unrelated tab/window event to
// happen to trigger a re-evaluation.
async function recheckAllActiveTabs() {
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const t of activeTabs) {
      lastHandledUrlByTab.delete(t.id);
      await handleTabUrl(t.id, t.url);
    }
  } catch (err) {
    // Ignore.
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
  openViolationTabs.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  activeTabByWindow.delete(windowId);
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

async function notifyLocalSessionComplete(session) {
  const count = session.violationCount || 0;
  const message =
    count > 0
      ? `${count} tab violation${count === 1 ? "" : "s"} (browser-only session — no desktop sync).`
      : "No tab violations — nice work. (browser-only session)";
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon128.png"),
    title: "Focus session complete — you're free to go!",
    message,
    silent: false,
  });
  await playCompletionSound();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    lastAcceptableUrl = "";
    const local = await getLocalSession();
    if (local.isActive) {
      await setLocalSession(defaultLocalSession());
      await notifyLocalSessionComplete(local);
      return;
    }
    // The popup's own 3s status poll can beat this alarm to the punch and
    // self-finalize the session server-side first (see the comment on
    // notifySessionComplete) — when that happens, /session/end 404s/errors
    // here since there's nothing left to end. That's not a reason to skip
    // the notification: /history has the finalized entry either way, so
    // always try to notify regardless of whether our own /session/end call
    // succeeded.
    try {
      await apiFetch("/session/end", { method: "POST" });
    } catch (err) {
      console.warn(
        "Focus Tracker: could not reach desktop app to end session (it may have already self-finalized).",
        err
      );
    }
    await notifySessionComplete();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startSession") {
    (async () => {
      const {
        durationMinutes,
        lockMode,
        domainWhitelist,
        // Optional — a future calendar-integration caller (e.g. a companion
        // content script) can pass these to tag the session the same way
        // the desktop API's /session/start does directly. Not written to
        // chrome.storage.local's SAVED_WHITELIST_KEY below regardless of
        // source: that key is the user's manually pre-filled whitelist, and
        // an event-sourced whitelist is a temporary override that must
        // never overwrite it. Manual sessions from the popup already skip
        // this since popup.js writes that key itself before sending this
        // message.
        source = "manual",
        eventId = null,
        eventTitle = null,
        // Set only after the popup has explicitly confirmed (its own
        // double-click-to-confirm flow) that it's OK to start a session
        // entirely in the browser if the desktop app turns out to be
        // unreachable. Without this confirmation a failed desktop call is
        // just reported back as a plain failure, same as before.
        browserOnly = false,
      } = message.payload;

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
            source,
            event_id: eventId,
            event_title: eventTitle,
          }),
        });

        lastHandledUrlByTab.clear();
        openViolationTabs.clear();
        await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: [] });
        const endTime =
          typeof data.secondsRemaining === "number"
            ? Date.now() + data.secondsRemaining * 1000
            : Date.now() + durationMinutes * 60 * 1000;
        await chrome.alarms.clear(ALARM_NAME);
        chrome.alarms.create(ALARM_NAME, { when: endTime });

        // Enforce immediately if the user was already sitting on a
        // restricted tab when the session started — otherwise nothing
        // re-checks it until they happen to switch tabs or navigate.
        await recheckAllActiveTabs();

        sendResponse({ ok: true });
      } catch (err) {
        console.warn(
          "Focus Tracker: could not reach desktop app to start session.",
          err
        );

        if (!browserOnly) {
          sendResponse({ ok: false, error: String(err), desktopUnreachable: true });
          return;
        }

        // Confirmed fallback: run the session entirely in the browser, with
        // no desktop app to enforce it, log violations, or survive if the
        // browser closes. State lives in chrome.storage.local instead of
        // the desktop app's /status.
        const endTime = Date.now() + durationMinutes * 60 * 1000;
        await setLocalSession({
          isActive: true,
          isPaused: false,
          endTime,
          pausedRemainingMs: 0,
          lockMode,
          domainWhitelist,
          violationCount: 0,
        });
        lastHandledUrlByTab.clear();
        openViolationTabs.clear();
        await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: [] });
        await chrome.alarms.clear(ALARM_NAME);
        chrome.alarms.create(ALARM_NAME, { when: endTime });
        await recheckAllActiveTabs();
        sendResponse({ ok: true, mode: "browser-only" });
      }
    })();
    return true;
  }

  if (message?.type === "endSession") {
    (async () => {
      lastAcceptableUrl = "";
      await chrome.alarms.clear(ALARM_NAME);

      const local = await getLocalSession();
      if (local.isActive) {
        await setLocalSession(defaultLocalSession());
        sendResponse({ ok: true });
        return;
      }

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
      const local = await getLocalSession();
      if (local.isActive) {
        const remainingMs = Math.max(0, local.endTime - Date.now());
        await setLocalSession({ ...local, isPaused: true, pausedRemainingMs: remainingMs });
        await chrome.alarms.clear(ALARM_NAME);
        sendResponse({ ok: true });
        return;
      }

      try {
        // Lock enforcement stays on while paused — only the countdown
        // freezes. Only clear the end-of-session alarm AFTER the desktop
        // app confirms the pause — clearing it first and then having the
        // API call fail would leave the session running server-side with
        // no local alarm left to catch its natural end, so it'd never
        // finalize or fire the completion notification.
        await apiFetch("/session/pause", { method: "POST" });
        await chrome.alarms.clear(ALARM_NAME);
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
      const local = await getLocalSession();
      if (local.isActive) {
        const endTime = Date.now() + local.pausedRemainingMs;
        await setLocalSession({ ...local, isPaused: false, endTime, pausedRemainingMs: 0 });
        chrome.alarms.create(ALARM_NAME, { when: endTime });
        sendResponse({ ok: true });
        return;
      }

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

      const local = await getLocalSession();
      if (local.isActive) {
        const updated = await withStorageLock(async () => {
          const current = await getLocalSession();
          const updatedList = [...current.domainWhitelist, domain.trim()];
          await setLocalSession({ ...current, domainWhitelist: updatedList });
          return updatedList;
        });
        await recordSessionAddition(domain.trim(), reason.trim());
        await recheckAllActiveTabs();
        sendResponse({ ok: true, domainWhitelist: updated });
        return;
      }

      try {
        const data = await apiFetch("/whitelist/domains/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain: domain.trim(), reason: reason.trim() }),
        });
        await recordSessionAddition(domain.trim(), reason.trim());

        // The domain just became allowed — clear a hard-lock switch-away or
        // soft-lock overlay from before the add immediately, instead of
        // waiting on some unrelated tab/window event to happen to re-check it.
        await recheckAllActiveTabs();

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
