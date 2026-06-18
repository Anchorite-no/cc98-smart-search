"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  fuzzyLevel: 1,
  rankingMode: "balanced",
  relevanceWeight: 70,
  timeWeight: 15,
  hotWeight: 15
};

const ids = [
  "enabled",
  "fuzzyLevel",
  "rankingMode",
  "relevanceWeight",
  "timeWeight",
  "hotWeight"
];

const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const status = document.getElementById("status");
const storage = globalThis.chrome?.storage?.local || {
  async get(key) {
    const raw = window.localStorage.getItem(`cc98-smart-search:${key}`);
    return { [key]: raw ? JSON.parse(raw) : undefined };
  },
  async set(values) {
    for (const [key, value] of Object.entries(values)) {
      window.localStorage.setItem(`cc98-smart-search:${key}`, JSON.stringify(value));
    }
  }
};

function normalizeSettings(raw) {
  return { ...DEFAULT_SETTINGS, ...(raw || {}) };
}

function render(settings) {
  elements.enabled.checked = Boolean(settings.enabled);
  elements.fuzzyLevel.value = String(settings.fuzzyLevel);
  elements.rankingMode.value = settings.rankingMode;
  elements.relevanceWeight.value = String(settings.relevanceWeight);
  elements.timeWeight.value = String(settings.timeWeight);
  elements.hotWeight.value = String(settings.hotWeight);
  updateOutputs(settings);
}

function updateOutputs(settings) {
  document.getElementById("relevanceValue").textContent = `${settings.relevanceWeight}%`;
  document.getElementById("timeValue").textContent = `${settings.timeWeight}%`;
  document.getElementById("hotValue").textContent = `${settings.hotWeight}%`;
}

function readForm() {
  return {
    enabled: elements.enabled.checked,
    fuzzyLevel: Number.parseInt(elements.fuzzyLevel.value, 10),
    rankingMode: elements.rankingMode.value,
    relevanceWeight: Number.parseInt(elements.relevanceWeight.value, 10),
    timeWeight: Number.parseInt(elements.timeWeight.value, 10),
    hotWeight: Number.parseInt(elements.hotWeight.value, 10)
  };
}

async function save() {
  const settings = readForm();
  updateOutputs(settings);
  await storage.set({ settings });
  status.textContent = "已保存";
}

async function load() {
  const { settings } = await storage.get("settings");
  render(normalizeSettings(settings));
}

for (const element of Object.values(elements)) {
  element.addEventListener("input", () => {
    status.textContent = "保存中...";
    save();
  });
}

document.getElementById("reset").addEventListener("click", async () => {
  await storage.set({ settings: DEFAULT_SETTINGS });
  render(DEFAULT_SETTINGS);
  status.textContent = "已恢复默认";
});

load();
