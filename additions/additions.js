const SESSION_ADDITIONS_KEY = "sessionAddedDomains";
const SAVED_WHITELIST_KEY = "savedDomainWhitelist";

const emptyStateEl = document.getElementById("empty-state");
const listEl = document.getElementById("additions-list");
const actionsRowEl = document.getElementById("actions-row");
const addSelectedBtn = document.getElementById("add-selected-btn");
const dismissBtn = document.getElementById("dismiss-btn");
const statusMessageEl = document.getElementById("status-message");

function normalizeDomain(domain) {
  return (domain || "").trim().toLowerCase();
}

// Mid-session additions can include the same domain more than once (added,
// removed some other way, added again) — collapse to one row per domain,
// keeping the most recent reason.
function dedupeAdditions(additions) {
  const byDomain = new Map();
  additions.forEach((entry) => {
    const key = normalizeDomain(entry.domain);
    if (!key) return;
    byDomain.set(key, entry);
  });
  return [...byDomain.values()].sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
}

async function load() {
  const data = await chrome.storage.local.get([SESSION_ADDITIONS_KEY, SAVED_WHITELIST_KEY]);
  const additions = dedupeAdditions(
    Array.isArray(data[SESSION_ADDITIONS_KEY]) ? data[SESSION_ADDITIONS_KEY] : []
  );
  const savedWhitelist = Array.isArray(data[SAVED_WHITELIST_KEY]) ? data[SAVED_WHITELIST_KEY] : [];
  const savedSet = new Set(savedWhitelist.map(normalizeDomain));

  if (additions.length === 0) {
    emptyStateEl.classList.remove("hidden");
    return;
  }

  listEl.innerHTML = "";
  additions.forEach((entry) => {
    const alreadySaved = savedSet.has(normalizeDomain(entry.domain));

    const li = document.createElement("li");
    li.className = "addition-row" + (alreadySaved ? " already-saved" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.disabled = alreadySaved;
    checkbox.dataset.domain = entry.domain;
    li.appendChild(checkbox);

    const body = document.createElement("div");
    body.className = "addition-body";
    const domainEl = document.createElement("div");
    domainEl.className = "addition-domain";
    domainEl.textContent = entry.domain;
    body.appendChild(domainEl);
    if (entry.reason) {
      const reasonEl = document.createElement("div");
      reasonEl.className = "addition-reason";
      reasonEl.textContent = entry.reason;
      body.appendChild(reasonEl);
    }
    li.appendChild(body);

    if (alreadySaved) {
      const badge = document.createElement("span");
      badge.className = "addition-badge";
      badge.textContent = "Already saved";
      li.appendChild(badge);
    }

    listEl.appendChild(li);
  });

  actionsRowEl.classList.remove("hidden");
}

addSelectedBtn.addEventListener("click", async () => {
  const checkedDomains = [...listEl.querySelectorAll("input[type='checkbox']:checked:not(:disabled)")]
    .map((cb) => cb.dataset.domain.trim())
    .filter((domain) => domain.length > 0);

  addSelectedBtn.disabled = true;

  const data = await chrome.storage.local.get(SAVED_WHITELIST_KEY);
  const savedWhitelist = Array.isArray(data[SAVED_WHITELIST_KEY]) ? data[SAVED_WHITELIST_KEY] : [];
  const savedSet = new Set(savedWhitelist.map(normalizeDomain));

  const toAdd = checkedDomains.filter((domain) => !savedSet.has(normalizeDomain(domain)));
  const updatedWhitelist = [...savedWhitelist, ...toAdd];

  await chrome.storage.local.set({
    [SAVED_WHITELIST_KEY]: updatedWhitelist,
    [SESSION_ADDITIONS_KEY]: [],
  });

  statusMessageEl.textContent =
    toAdd.length > 0
      ? `Added ${toAdd.length} site${toAdd.length === 1 ? "" : "s"} to your saved whitelist.`
      : "Nothing new to add.";
  actionsRowEl.classList.add("hidden");
  listEl.innerHTML = "";
  emptyStateEl.classList.remove("hidden");
});

dismissBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ [SESSION_ADDITIONS_KEY]: [] });
  actionsRowEl.classList.add("hidden");
  listEl.innerHTML = "";
  emptyStateEl.classList.remove("hidden");
  statusMessageEl.textContent = "Dismissed.";
});

load();
