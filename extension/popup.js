"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  fuzzyLevel: 1,
  maxQueries: 1,
  requestDelayMs: 1200,
  rankingMode: "balanced",
  relevanceWeight: 70,
  timeWeight: 15,
  hotWeight: 15
};

const ids = [
  "enabled",
  "fuzzyLevel",
  "maxQueries",
  "requestDelayMs",
  "rankingMode",
  "relevanceWeight",
  "timeWeight",
  "hotWeight"
];

const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const status = document.getElementById("status");

function normalizeSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}

function render(settings) {
  elements.enabled.checked = Boolean(settings.enabled);
  elements.fuzzyLevel.value = String(settings.fuzzyLevel);
  elements.maxQueries.value = String(settings.maxQueries);
  elements.requestDelayMs.value = String(settings.requestDelayMs);
  elements.rankingMode.value = settings.rankingMode;
  elements.relevanceWeight.value = String(settings.relevanceWeight);
  elements.timeWeight.value = String(settings.timeWeight);
  elements.hotWeight.value = String(settings.hotWeight);
  updateOutputs(settings);
}

function updateOutputs(settings) {
  document.getElementById("maxQueriesValue").textContent = `${settings.maxQueries} 组`;
  document.getElementById("requestDelayValue").textContent = `${settings.requestDelayMs} ms`;
  document.getElementById("relevanceValue").textContent = `${settings.relevanceWeight}%`;
  document.getElementById("timeValue").textContent = `${settings.timeWeight}%`;
  document.getElementById("hotValue").textContent = `${settings.hotWeight}%`;
}

function readForm() {
  return {
    enabled: elements.enabled.checked,
    fuzzyLevel: Number.parseInt(elements.fuzzyLevel.value, 10),
    maxQueries: Number.parseInt(elements.maxQueries.value, 10),
    requestDelayMs: Number.parseInt(elements.requestDelayMs.value, 10),
    rankingMode: elements.rankingMode.value,
    relevanceWeight: Number.parseInt(elements.relevanceWeight.value, 10),
    timeWeight: Number.parseInt(elements.timeWeight.value, 10),
    hotWeight: Number.parseInt(elements.hotWeight.value, 10)
  };
}

async function save() {
  const settings = readForm();
  updateOutputs(settings);
  await chrome.storage.local.set({ settings });
  status.textContent = "已保存";
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  render(normalizeSettings(settings));
}

for (const element of Object.values(elements)) {
  element.addEventListener("input", () => {
    status.textContent = "保存中...";
    save();
  });
}

document.getElementById("reset").addEventListener("click", async () => {
  await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  render(DEFAULT_SETTINGS);
  status.textContent = "已恢复默认";
});

load();
