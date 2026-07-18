// Focus Tracker soft-lock overlay. Injected on demand via chrome.scripting.executeScript.
(function () {
  if (window.__focusTrackerOverlayInit) return;
  window.__focusTrackerOverlayInit = true;

  const OVERLAY_ID = "focus-tracker-overlay-root";
  const BLACKOUT_ID = "focus-tracker-blackout-root";
  const GRACE_SECONDS = 3;

  function showOverlay(timeRemainingText) {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) existing.remove();

    const root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(20, 24, 28, 0.55);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      animation: focus-tracker-fade-in 0.2s ease-out;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
      padding: 32px 36px;
      max-width: 360px;
      text-align: center;
    `;

    const title = document.createElement("div");
    title.textContent = "You're off track";
    title.style.cssText = `
      font-size: 18px;
      font-weight: 600;
      color: #1f2933;
      margin-bottom: 8px;
    `;

    const message = document.createElement("div");
    message.textContent = `${timeRemainingText} left in this session`;
    message.style.cssText = `
      font-size: 14px;
      color: #52606d;
      margin-bottom: 20px;
    `;

    const barTrack = document.createElement("div");
    barTrack.style.cssText = `
      width: 100%;
      height: 6px;
      border-radius: 999px;
      background: #e4e7eb;
      overflow: hidden;
    `;

    const barFill = document.createElement("div");
    barFill.style.cssText = `
      height: 100%;
      width: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, #4fb0a5, #6bc9bd);
      transform-origin: left;
      transition: transform ${GRACE_SECONDS}s linear;
    `;

    barTrack.appendChild(barFill);
    card.appendChild(title);
    card.appendChild(message);
    card.appendChild(barTrack);
    root.appendChild(card);
    document.documentElement.appendChild(root);

    // Kick off the shrink animation on the next frame.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        barFill.style.transform = "scaleX(0)";
      });
    });

    setTimeout(() => {
      root.remove();
    }, GRACE_SECONDS * 1000);
  }

  // Hard lock's emergency cover: shown the moment Chrome's "user may be
  // dragging a tab" lock blocks a switch-away/close, so restricted content
  // stays hidden for as long as the hold lasts instead of just sitting there
  // while background.js retries. No timer, no dismiss — only removed by an
  // explicit hideBlackout message (or the tab closing, which ends this
  // script entirely).
  function showBlackout() {
    if (document.getElementById(BLACKOUT_ID)) return;
    const root = document.createElement("div");
    root.id = BLACKOUT_ID;
    root.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: #14181c;
    `;
    document.documentElement.appendChild(root);
  }

  function hideBlackout() {
    const existing = document.getElementById(BLACKOUT_ID);
    if (existing) existing.remove();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "showOverlay") {
      showOverlay(message.timeRemainingText);
    } else if (message?.type === "showBlackout") {
      showBlackout();
    } else if (message?.type === "hideBlackout") {
      hideBlackout();
    }
  });
})();
