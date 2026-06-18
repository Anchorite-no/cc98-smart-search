(function () {
  "use strict";

  const QUERY_SESSION_KEY = "cc98-smart-search:lastQuery";
  const DEFAULT_SETTINGS = {
    enabled: true,
    fuzzyLevel: 1,
    rankingMode: "balanced",
    relevanceWeight: 70,
    timeWeight: 15,
    hotWeight: 15
  };

  const ALIASES = {
    "线性代数": ["线代", "linear algebra"],
    "线代": ["线性代数", "linear algebra"],
    "数据结构": ["DS", "FDS"],
    "ds": ["数据结构", "FDS"],
    "fds": ["数据结构", "DS"],
    "计算机系统": ["ICS", "CSAPP"],
    "ics": ["计算机系统", "CSAPP"],
    "微积分": ["微甲", "微乙", "calculus"],
    "概率论": ["概统", "概率统计", "probability"],
    "密码学": ["crypto", "cryptography"],
    "汇编": ["ASM", "assembly"],
    "操作系统": ["OS", "operating system"],
    "数据库": ["DB", "database"],
    "计算机网络": ["计网", "computer network"]
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    activeMode: DEFAULT_SETTINGS.rankingMode,
    isSorting: false,
    observer: null,
    sortTimer: null,
    suppressMutations: false
  };

  function normalizeSettings(settings) {
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function loadSettings() {
    if (!globalThis.chrome?.storage?.local) {
      state.settings = { ...DEFAULT_SETTINGS };
      state.activeMode = DEFAULT_SETTINGS.rankingMode;
      return state.settings;
    }

    try {
      const data = await chrome.storage.local.get("settings");
      state.settings = normalizeSettings(data.settings);
      state.activeMode = state.settings.rankingMode || "balanced";
      return state.settings;
    } catch (_error) {
      state.settings = { ...DEFAULT_SETTINGS };
      state.activeMode = DEFAULT_SETTINGS.rankingMode;
      return state.settings;
    }
  }

  function installSettingsListener() {
    if (!globalThis.chrome?.storage?.onChanged) return;

    try {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes.settings) return;
        state.settings = normalizeSettings(changes.settings.newValue);
        state.activeMode = state.settings.rankingMode || "balanced";
        if (state.settings.enabled) {
          sortNativeResultsSoon();
        } else {
          restoreNativeResults();
        }
      });
    } catch (_error) {
      // Ignore invalidated extension contexts.
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function uniq(values) {
    return Array.from(new Set(values.filter(Boolean)));
  }

  function parseQuery(input) {
    const include = [];
    const exclude = [];
    const terms = [];
    const tokens = String(input || "").trim().split(/\s+/).filter(Boolean);

    for (const token of tokens) {
      if (token.startsWith("+") && token.length > 1) {
        include.push(token.slice(1));
      } else if (token.startsWith("-") && token.length > 1) {
        exclude.push(token.slice(1));
      } else {
        terms.push(token);
      }
    }

    return { raw: String(input || "").trim(), include, exclude, terms };
  }

  function aliasesFor(term, fuzzyLevel) {
    const normalized = normalizeText(term);
    const foundKey = Object.keys(ALIASES).find((key) => normalizeText(key) === normalized);
    const direct = foundKey ? ALIASES[foundKey] : [];
    const level = Number.isFinite(fuzzyLevel) ? fuzzyLevel : state.settings.fuzzyLevel;

    if (level <= 0) return [term];
    if (level === 1) return uniq([term, ...direct.slice(0, 1)]);
    if (level === 2) return uniq([term, ...direct.slice(0, 2)]);
    return uniq([term, ...direct]);
  }

  function expandedMatchTerms(term) {
    return aliasesFor(term, state.settings.fuzzyLevel).map((value, index) => ({
      value,
      normalized: normalizeText(value),
      confidence: index === 0 ? 1 : index === 1 ? 0.85 : 0.6
    }));
  }

  function currentScopeText() {
    return document.querySelector(".searchBoxSelect")?.textContent?.trim() || "主题";
  }

  function currentInputValue() {
    return document.querySelector("#searchText")?.value?.trim() || "";
  }

  function getBoardIdFromPage(scopeText) {
    if (scopeText === "主题" || scopeText === "全站") return 0;

    const boardMatch = location.pathname.match(/\/board\/(\d+)/i);
    if (boardMatch) return Number.parseInt(boardMatch[1], 10);

    const searchBoard = new URLSearchParams(location.search).get("boardId");
    if (searchBoard) return Number.parseInt(searchBoard, 10) || 0;

    return 0;
  }

  function buildNativeSearchQuery(parsed) {
    return [...parsed.include, ...parsed.terms].filter(Boolean).join(" ").trim();
  }

  function doubleEncode(value) {
    return encodeURIComponent(encodeURIComponent(value));
  }

  function doubleDecode(value) {
    try {
      return decodeURIComponent(decodeURIComponent(value || ""));
    } catch (_error) {
      try {
        return decodeURIComponent(value || "");
      } catch (_ignored) {
        return value || "";
      }
    }
  }

  function rememberParsedQuery(parsed) {
    try {
      window.sessionStorage.setItem(QUERY_SESSION_KEY, JSON.stringify(parsed));
    } catch (_error) {
      // Session storage is a convenience only.
    }
  }

  function readRememberedQuery() {
    try {
      const raw = window.sessionStorage.getItem(QUERY_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_error) {
      return null;
    }
  }

  function getQueryForCurrentSearchPage() {
    const params = new URLSearchParams(location.search);
    const urlQuery = doubleDecode(params.get("keyword") || "");
    const remembered = readRememberedQuery();
    const rememberedNative = remembered ? buildNativeSearchQuery(remembered) : "";

    if (remembered && rememberedNative === urlQuery) return remembered;
    return parseQuery(urlQuery);
  }

  function navigateToNativeSearch(query) {
    const parsed = parseQuery(query);
    const nativeQuery = buildNativeSearchQuery(parsed);
    if (!nativeQuery) return;

    const scope = currentScopeText();
    if (scope === "用户" || scope === "版面") return;

    const boardId = getBoardIdFromPage(scope);
    rememberParsedQuery(parsed);
    window.location.assign(`/search?boardId=${boardId}&keyword=${doubleEncode(nativeQuery)}`);
  }

  function shouldHandleEvent(target) {
    if (!state.settings.enabled) return false;
    const scope = currentScopeText();
    if (scope === "用户" || scope === "版面") return false;
    return Boolean(target && (target.closest?.(".searchIco") || target.id === "searchText"));
  }

  function installSearchNavigation() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.(".searchIco")) return;
      if (!shouldHandleEvent(event.target)) return;
      const query = currentInputValue();
      if (!query) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigateToNativeSearch(query);
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.keyCode !== 13) return;
      if (!shouldHandleEvent(event.target)) return;
      const query = currentInputValue();
      if (!query) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      navigateToNativeSearch(query);
    }, true);
  }

  function toNumber(value) {
    if (typeof value === "number") return value;
    const text = String(value || "").trim();
    if (!text) return 0;
    if (text.endsWith("万")) return Number.parseFloat(text) * 10000 || 0;
    return Number.parseFloat(text) || 0;
  }

  function parseCc98Date(value) {
    const text = String(value || "").trim();
    if (!text) return null;

    const now = new Date();
    const timeMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const fullDateMatch = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);

    if (fullDateMatch) {
      const year = Number(fullDateMatch[1]);
      const month = Number(fullDateMatch[2]) - 1;
      const day = Number(fullDateMatch[3]);
      const hour = timeMatch ? Number(timeMatch[1]) : 0;
      const minute = timeMatch ? Number(timeMatch[2]) : 0;
      const second = timeMatch && timeMatch[3] ? Number(timeMatch[3]) : 0;
      return new Date(year, month, day, hour, minute, second);
    }

    const relativeDays = text.includes("今天")
      ? 0
      : text.includes("昨天")
        ? 1
        : text.includes("前天")
          ? 2
          : null;

    if (relativeDays !== null && timeMatch) {
      const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      date.setDate(date.getDate() - relativeDays);
      date.setHours(Number(timeMatch[1]), Number(timeMatch[2]), timeMatch[3] ? Number(timeMatch[3]) : 0, 0);
      return date;
    }

    const parsed = new Date(text);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  function getTimeScore(value) {
    const date = parseCc98Date(value);
    if (!date) return 0;
    const days = (Date.now() - date.getTime()) / 86400000;
    if (days <= 7) return 30;
    if (days <= 30) return 20;
    if (days <= 180) return 10;
    if (days <= 365) return 5;
    return 0;
  }

  function getHotScore(hitCount, replyCount) {
    return Math.log10(toNumber(hitCount) + 1) * 8 + Math.log10(toNumber(replyCount) + 1) * 15;
  }

  function getResultText(result) {
    return normalizeText([
      result.title,
      result.userName,
      result.boardName,
      result.infoText
    ].join(" "));
  }

  function shouldDropResult(result, parsed) {
    const haystack = getResultText(result);
    return parsed.exclude.some((term) => haystack.includes(normalizeText(term)));
  }

  function satisfiesInclude(result, parsed) {
    if (parsed.include.length === 0) return true;
    const haystack = getResultText(result);
    return parsed.include.every((term) => {
      return expandedMatchTerms(term).some((candidate) => haystack.includes(candidate.normalized));
    });
  }

  function getRelevanceScore(result, parsed) {
    const title = normalizeText(result.title);
    const haystack = getResultText(result);
    let score = 0;

    for (const term of parsed.include) {
      for (const candidate of expandedMatchTerms(term)) {
        if (haystack.includes(candidate.normalized)) {
          score += candidate.confidence >= 1 ? 80 : candidate.confidence >= 0.8 ? 60 : 35;
          break;
        }
      }
    }

    for (const term of parsed.terms) {
      for (const candidate of expandedMatchTerms(term)) {
        if (title.includes(candidate.normalized)) {
          score += candidate.confidence >= 1 ? 30 : candidate.confidence >= 0.8 ? 25 : 10;
          break;
        }
        if (haystack.includes(candidate.normalized)) {
          score += candidate.confidence >= 1 ? 12 : 8;
          break;
        }
      }
    }

    score += Math.max(0, 20 - result.originalIndex);
    return score;
  }

  function getWeights(mode, settings) {
    const presets = {
      balanced: [0.7, 0.15, 0.15],
      recent: [0.4, 0.45, 0.15],
      hot: [0.4, 0.1, 0.5]
    };

    if (mode !== "custom") return presets[mode] || presets.balanced;

    const total = Math.max(
      1,
      Number(settings.relevanceWeight || 0) +
        Number(settings.timeWeight || 0) +
        Number(settings.hotWeight || 0)
    );
    return [
      Number(settings.relevanceWeight || 0) / total,
      Number(settings.timeWeight || 0) / total,
      Number(settings.hotWeight || 0) / total
    ];
  }

  function scoreResult(result, parsed) {
    const relevanceScore = getRelevanceScore(result, parsed);
    const timeScore = getTimeScore(result.lastPostTime || result.time);
    const hotScore = getHotScore(result.hitCount, result.replyCount);
    const weights = getWeights(state.activeMode, state.settings);

    return {
      relevanceScore,
      timeScore,
      hotScore,
      finalScore: relevanceScore * weights[0] + timeScore * weights[1] + hotScore * weights[2]
    };
  }

  function extractNativeResult(card, originalIndex) {
    if (!card.dataset.cc98SmartSearchOriginalIndex) {
      card.dataset.cc98SmartSearchOriginalIndex = String(originalIndex);
    }
    if (!Object.prototype.hasOwnProperty.call(card.dataset, "cc98SmartSearchHadTitle")) {
      card.dataset.cc98SmartSearchHadTitle = card.hasAttribute("title") ? "1" : "0";
      card.dataset.cc98SmartSearchOriginalTitle = card.getAttribute("title") || "";
    }

    const title = card.querySelector(".focus-topic-title")?.textContent?.trim() || "";
    const userName = card.querySelector(".focus-topic-userName")?.textContent?.trim() || "";
    const boardName = card.querySelector(".focus-topic-board, .focus-topic-boardName")?.textContent?.trim() || "";
    const info = card.querySelector(".focus-topic-info");
    const infoText = info?.textContent?.replace(/\s+/g, " ").trim() || "";
    const infoItems = Array.from(info?.children || []).map((item) => item.textContent.replace(/\s+/g, " ").trim());
    const metricItems = infoItems.filter((item) => /^\d+(?:\.\d+)?万?$/.test(item));
    const fallbackMetrics = Array.from(infoText.matchAll(/(?:^|\s)(\d+(?:\.\d+)?万?)(?=\s|$)/g)).map((match) => match[1]);
    const dateItems = infoItems.filter((item) => /今天|昨天|前天|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}:\d{2}/.test(item));
    const lastPostTime = dateItems[dateItems.length - 1] || "";
    const time = dateItems[0] || "";

    return {
      card,
      title,
      userName,
      boardName,
      infoText,
      time,
      lastPostTime,
      hitCount: metricItems[0] || fallbackMetrics[0] || "0",
      replyCount: "0",
      originalIndex: Number.parseInt(card.dataset.cc98SmartSearchOriginalIndex, 10) || originalIndex
    };
  }

  function renderNativeHint(container, visibleCount, totalCount) {
    let hint = document.getElementById("cc98-smart-search-native-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "cc98-smart-search-native-hint";
      container.parentElement.insertBefore(hint, container);
    }

    const modeLabels = {
      balanced: "综合",
      recent: "最新",
      hot: "热门",
      custom: "自定义"
    };
    hint.textContent = `已按 ${modeLabels[state.activeMode] || "综合"} SearchRank 原生重排 ${visibleCount}/${totalCount} 条结果`;
  }

  function sortNativeResults() {
    if (!state.settings.enabled || state.isSorting || !location.pathname.toLowerCase().startsWith("/search")) return;

    const container = document.querySelector(".focus-topic-topicArea");
    if (!container) return;

    const cards = Array.from(container.querySelectorAll(":scope > .focus-topic"));
    if (!cards.length) return;

    state.isSorting = true;
    state.suppressMutations = true;
    state.observer?.disconnect();
    try {
      const parsed = getQueryForCurrentSearchPage();
      const ranked = cards
        .map((card, originalIndex) => extractNativeResult(card, originalIndex))
        .map((result) => ({ ...result, rank: scoreResult(result, parsed) }))
        .sort((a, b) => b.rank.finalScore - a.rank.finalScore);

      let visibleCount = 0;
      const fragment = document.createDocumentFragment();
      for (const result of ranked) {
        const keep = !shouldDropResult(result, parsed) && satisfiesInclude(result, parsed);
        result.card.classList.toggle("cc98-smart-search-hidden", !keep);
        result.card.dataset.cc98SmartSearchScore = result.rank.finalScore.toFixed(1);
        result.card.title = `SearchRank ${result.rank.finalScore.toFixed(1)} | 相关 ${result.rank.relevanceScore.toFixed(0)} | 时间 ${result.rank.timeScore.toFixed(0)} | 热度 ${result.rank.hotScore.toFixed(0)}`;
        if (keep) visibleCount += 1;
        fragment.appendChild(result.card);
      }
      container.appendChild(fragment);
      renderNativeHint(container, visibleCount, cards.length);
      window.setTimeout(() => {
        state.suppressMutations = false;
        observeNativeResults();
      }, 0);
    } finally {
      state.isSorting = false;
    }
  }

  function sortNativeResultsSoon() {
    window.clearTimeout(state.sortTimer);
    state.sortTimer = window.setTimeout(sortNativeResults, 250);
  }

  function restoreNativeResults() {
    const container = document.querySelector(".focus-topic-topicArea");
    if (!container) return;

    const cards = Array.from(container.querySelectorAll(":scope > .focus-topic"));
    if (!cards.length) return;

    state.suppressMutations = true;
    state.observer?.disconnect();
    cards
      .sort((a, b) => {
        const left = Number.parseInt(a.dataset.cc98SmartSearchOriginalIndex, 10);
        const right = Number.parseInt(b.dataset.cc98SmartSearchOriginalIndex, 10);
        return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
      })
      .forEach((card) => {
        card.classList.remove("cc98-smart-search-hidden");
        delete card.dataset.cc98SmartSearchScore;
        if (card.dataset.cc98SmartSearchHadTitle === "1") {
          card.setAttribute("title", card.dataset.cc98SmartSearchOriginalTitle || "");
        } else {
          card.removeAttribute("title");
        }
        container.appendChild(card);
      });

    document.getElementById("cc98-smart-search-native-hint")?.remove();
    window.setTimeout(() => {
      state.suppressMutations = false;
      observeNativeResults();
    }, 0);
  }

  function observeNativeResults() {
    if (!location.pathname.toLowerCase().startsWith("/search")) return;

    if (state.observer) state.observer.disconnect();
    state.observer = new MutationObserver(() => {
      if (!state.isSorting && !state.suppressMutations) sortNativeResultsSoon();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function installNativeSorter() {
    if (!location.pathname.toLowerCase().startsWith("/search")) return;

    sortNativeResultsSoon();
    observeNativeResults();
  }

  installSettingsListener();
  loadSettings()
    .catch(() => {
      state.settings = { ...DEFAULT_SETTINGS };
      state.activeMode = DEFAULT_SETTINGS.rankingMode;
    })
    .finally(() => {
      installSearchNavigation();
      installNativeSorter();
    });
})();
