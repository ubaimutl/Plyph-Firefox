import { getSettings } from "./shared.js";

const listRoot = document.querySelector("#history-list");
const enabledToggle = document.querySelector("#history-enabled");
const clearButton = document.querySelector("#clear");
const settingsButton = document.querySelector("#open-settings");

let settings = await getSettings();

settingsButton.addEventListener("click", () =>
  browser.runtime.openOptionsPage(),
);

enabledToggle.addEventListener("change", async () => {
  try {
    await browser.storage.local.set({
      historyEnabled: enabledToggle.checked,
    });
  } catch (error) {
    showStorageError(error);
  }
});

clearButton.addEventListener("click", async () => {
  if (!confirm("Remove all stored results? This cannot be undone.")) return;

  try {
    await browser.storage.local.set({ history: [] });
  } catch (error) {
    showStorageError(error);
  }
});

browser.storage.onChanged.addListener(async (changes, area) => {
  if (
    area !== "local" ||
    !(
      "history" in changes ||
      "historyEnabled" in changes ||
      "historyLimit" in changes
    )
  ) {
    return;
  }

  settings = await getSettings();
  render();
});

function relativeTime(ts) {
  const minutes = Math.floor((Date.now() - ts) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.floor(hours / 24)}d ago`;
}

async function copyText(text = "") {
  await navigator.clipboard.writeText(text);
}

function copyButton(label, text) {
  return rowButton(label, async (event) => {
    const button = event.currentTarget;

    try {
      await copyText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }

    setTimeout(() => {
      button.textContent = label;
    }, 1200);
  });
}

function rowButton(label, click, danger = false) {
  const button = document.createElement("button");
  button.className = `text-button${danger ? " danger" : ""}`;
  button.textContent = label;
  button.addEventListener("click", click);
  return button;
}

function message(text, className) {
  const element = document.createElement("p");
  element.className = `history-message ${className}`;
  element.textContent = text;
  return element;
}

function showStorageError(error) {
  listRoot.replaceChildren(
    message(
      `Could not update history storage: ${error?.message || "unknown storage error"}`,
      "history-disabled",
    ),
  );
}

function render() {
  const list = Array.isArray(settings.history) ? settings.history : [];

  listRoot.replaceChildren();
  enabledToggle.checked = settings.historyEnabled === true;
  clearButton.disabled = !list.length;

  if (!settings.historyEnabled) {
    listRoot.append(
      message(
        "History is disabled. Enable “Save history” to start keeping results.",
        "history-disabled",
      ),
    );
    return;
  }

  if (!list.length) {
    listRoot.append(
      message(
        "No results yet. Run an action on selected text to build history.",
        "empty",
      ),
    );
    return;
  }

  for (const entry of list) {
    listRoot.append(createHistoryEntry(entry));
  }
}

function createHistoryEntry(entry) {
  const row = document.createElement("div");
  row.className = "history-entry";

  const content = document.createElement("div");
  content.className = "history-entry-content";

  const name = document.createElement("strong");
  name.className = "history-entry-name";
  name.textContent = entry.actionName || "Result";

  const meta = document.createElement("small");
  meta.className = "history-entry-meta";
  meta.textContent = [
    relativeTime(entry.ts),
    entry.provider || "provider",
    entry.model,
  ]
    .filter(Boolean)
    .join(" · ");

  const snippet = document.createElement("small");
  snippet.className = "history-entry-snippet";
  snippet.textContent =
    entry.output?.replace(/\s+/g, " ").slice(0, 180) || "No output preview";

  content.append(name, meta, snippet);

  const details = createDetails(entry);

  const controls = document.createElement("div");
  controls.className = "history-entry-actions";
  controls.append(
    copyButton("Copy", entry.output),
    rowButton("View", () => {
      details.hidden = !details.hidden;
    }),
    rowButton("Delete", () => removeEntry(entry.id), true),
  );

  row.append(content, controls, details);

  return row;
}

function createDetails(entry) {
  const details = document.createElement("div");
  details.className = "history-entry-details";
  details.hidden = true;

  const inputLabel = document.createElement("label");
  inputLabel.textContent = "Input";

  const input = document.createElement("textarea");
  input.readOnly = true;
  input.value = entry.input || "";

  const outputLabel = document.createElement("label");
  outputLabel.textContent = "Output";

  const output = document.createElement("textarea");
  output.readOnly = true;
  output.value = entry.output || "";

  const actions = document.createElement("div");
  actions.className = "history-detail-actions";
  actions.append(
    copyButton("Copy input", entry.input),
    copyButton("Copy output", entry.output),
  );

  details.append(inputLabel, input, outputLabel, output, actions);

  return details;
}

async function removeEntry(id) {
  try {
    const { history = [] } = await browser.storage.local.get("history");

    await browser.storage.local.set({
      history: history.filter((entry) => entry.id !== id),
    });
  } catch (error) {
    showStorageError(error);
  }
}

render();
