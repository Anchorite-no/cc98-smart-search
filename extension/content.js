(function () {
  "use strict";

  const API_BASE = "https://api.cc98.org";
  const PAGE_SIZE = 20;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const API_TIMEOUT_MS = 8000;
  const QUERY_SESSION_KEY = "cc98-smart-search:lastQuery";
  const DEFAULT_SETTINGS = {
    enabled: true,
    fuzzyLevel: 1,
    requestDelayMs: 1200,
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
    suppressMutations: false,
    cache: new Map(),
    users: new Map(),
    supplementalKey: "",
    supplementalRunning: false,
    supplementalAdded: 0,
    supplementalQueries: [],
    supplementalError: "",
    supplementalStatus: ""
  };

  function normalizeSettings(settings) {
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function getChromeStorageLocal() {
    try {
      return globalThis.chrome?.storage?.local || null;
    } catch (_error) {
      return null;
    }
  }

  function getChromeStorageOnChanged() {
    try {
      return globalThis.chrome?.storage?.onChanged || null;
    } catch (_error) {
      return null;
    }
  }

  async function loadSettings() {
    const storage = getChromeStorageLocal();
    if (!storage) {
      state.settings = { ...DEFAULT_SETTINGS };
      state.activeMode = DEFAULT_SETTINGS.rankingMode;
      return state.settings;
    }

    try {
      const data = await storage.get("settings");
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
    const onChanged = getChromeStorageOnChanged();
    if (!onChanged) return;

    try {
      onChanged.addListener((changes, areaName) => {
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

  function getCurrentSearchBoardId() {
    const searchBoard = new URLSearchParams(location.search).get("boardId");
    return Number.parseInt(searchBoard, 10) || 0;
  }

  function maxSupplementalQueries() {
    const level = Math.max(0, Math.min(3, Number.parseInt(state.settings.fuzzyLevel, 10) || 0));
    return [0, 2, 4, 6][level] || 0;
  }

  function supplementalDelayMs(multiplier = 1) {
    const value = Number.parseInt(state.settings.requestDelayMs, 10);
    const base = Number.isFinite(value) ? value : DEFAULT_SETTINGS.requestDelayMs;
    return Math.max(600, Math.min(10000, base * multiplier));
  }

  function buildSupplementalQueries(parsed) {
    const limit = maxSupplementalQueries();
    if (limit <= 0) return [];

    const baseTerms = [...parsed.include, ...parsed.terms].filter(Boolean).slice(0, 5);
    if (!baseTerms.length) return [];

    const originalQuery = normalizeText(buildNativeSearchQuery(parsed));
    const queries = [];

    for (let index = 0; index < baseTerms.length && queries.length < limit; index += 1) {
      const term = baseTerms[index];
      const aliases = aliasesFor(term, state.settings.fuzzyLevel).slice(1);

      for (const alias of aliases) {
        if (queries.length >= limit) break;
        const nextTerms = baseTerms.slice();
        nextTerms[index] = alias;
        const query = nextTerms.join(" ").trim();
        if (query && normalizeText(query) !== originalQuery) {
          queries.push(query);
        }
      }
    }

    const seen = new Set();
    return queries.filter((query) => {
      const key = normalizeText(query);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function supplementalKeyFor(parsed) {
    return [
      getCurrentSearchBoardId(),
      state.settings.fuzzyLevel,
      buildNativeSearchQuery(parsed),
      parsed.exclude.join(" ")
    ].map(normalizeText).join("|");
  }

  function readCc98Storage(key) {
    const raw = window.localStorage.getItem(key);
    const expiresAt = window.localStorage.getItem(`${key}_expirationTime`);
    if (expiresAt && Date.now() > Number.parseInt(expiresAt, 10) * 1000) {
      return null;
    }
    if (!raw) return null;
    if (raw.startsWith("str-")) return raw.slice(4);
    if (raw.startsWith("obj-")) {
      try {
        return JSON.parse(raw.slice(4));
      } catch (_error) {
        return null;
      }
    }
    return raw;
  }

  function getAuthorizationHeader() {
    const token = readCc98Storage("accessToken");
    return typeof token === "string" && token.startsWith("Bearer ") ? token : null;
  }

  async function cc98Fetch(path, options) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    const headers = new Headers(options && options.headers ? options.headers : undefined);
    const authorization = getAuthorizationHeader();
    if (authorization) headers.set("Authorization", authorization);
    headers.set("Accept", "application/json");

    try {
      const response = await fetch(new URL(path, API_BASE).toString(), {
        ...options,
        headers,
        signal: controller.signal
      });

      if (response.status === 401) {
        const error = new Error("需要登录 CC98 后才能使用 API 补召回。");
        error.code = "CC98_UNAUTHORIZED";
        throw error;
      }
      if (response.status === 403) {
        const error = new Error("CC98 暂时拒绝 API 补召回请求。");
        error.code = "CC98_RATE_LIMITED";
        throw error;
      }
      if (!response.ok) {
        throw new Error(`CC98 API 补召回失败：${response.status}`);
      }
      return response.json();
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function fetchTopicSearch(boardId, query) {
    const cacheKey = `${boardId || 0}:${query}`;
    const cached = state.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      return cached.data;
    }

    const encoded = encodeURIComponent(query);
    const path = boardId === 0
      ? `/topic/search?keyword=${encoded}&size=${PAGE_SIZE}&from=0`
      : `/topic/search/board/${boardId}?keyword=${encoded}&size=${PAGE_SIZE}&from=0`;
    const data = await cc98Fetch(path);
    const normalized = Array.isArray(data) ? await enrichTopicResults(data) : [];
    state.cache.set(cacheKey, { time: Date.now(), data: normalized });
    return normalized;
  }

  async function fetchTopicSearchWithRetry(boardId, query) {
    const retryMultipliers = [0, 0.75, 1.25, 2];
    for (let attempt = 0; attempt < retryMultipliers.length; attempt += 1) {
      try {
        return await fetchTopicSearch(boardId, query);
      } catch (error) {
        if (error.code !== "CC98_RATE_LIMITED" || attempt === retryMultipliers.length - 1) {
          throw error;
        }

        const waitMs = supplementalDelayMs(retryMultipliers[attempt + 1]);
        state.supplementalError = "";
        state.supplementalStatus = `API 限流，${(waitMs / 1000).toFixed(1)}s 后重试`;
        sortNativeResultsSoon();
        await sleep(waitMs);
      }
    }

    return [];
  }

  async function fetchBasicUsersInfo(userIds) {
    const needed = uniq(
      userIds
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => Number.isFinite(id) && id > 0)
    ).filter((id) => !state.users.has(id));

    if (needed.length) {
      const query = needed.map((id) => `id=${encodeURIComponent(id)}`).join("&");
      try {
        const data = await cc98Fetch(`/user/basic?${query}`);
        if (Array.isArray(data)) {
          data.forEach((user) => {
            if (user && user.id) state.users.set(Number(user.id), user);
          });
        }
      } catch (_error) {
        // Avatar enrichment is best-effort. Topic results should still render.
      }
    }

    return state.users;
  }

  async function enrichTopicResults(results) {
    const userIds = results.map((item) => item.userId).filter(Boolean);
    const users = await fetchBasicUsersInfo(userIds);

    return results.map((item) => {
      if (!item.userId) {
        return {
          ...item,
          portraitUrl: item.portraitUrl || "/static/images/_心灵之约.png",
          userName: item.userName || "匿名用户"
        };
      }

      const user = users.get(Number(item.userId));
      return {
        ...item,
        portraitUrl: item.portraitUrl || user?.portraitUrl || "/static/images/default_avatar_boy.png",
        userName: item.userName || user?.name || "匿名用户"
      };
    });
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

  function formatDateLabel(value) {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getTopicKeyFromCard(card) {
    const datasetId = card.dataset.cc98SmartSearchTopicId;
    if (datasetId) return `topic:${datasetId}`;

    const topicLink = card.querySelector('a[href*="/topic/"], [href*="/topic/"]');
    const href = topicLink?.getAttribute("href") || "";
    const match = href.match(/\/topic\/(\d+)/i);
    if (match) return `topic:${match[1]}`;

    const title = card.querySelector(".focus-topic-title")?.textContent || "";
    const userName = card.querySelector(".focus-topic-userName")?.textContent || "";
    const infoText = card.querySelector(".focus-topic-info")?.textContent || "";
    return `fallback:${normalizeText([title, userName, infoText].join("|"))}`;
  }

  function createApiResultCard(raw, sourceQuery, index) {
    const topicId = raw.id || raw.topicId;
    if (!topicId) return null;

    const card = createElement("div", "focus-topic cc98-smart-search-api-card");
    card.dataset.cc98SmartSearchSupplemental = "1";
    card.dataset.cc98SmartSearchTopicId = String(topicId);
    card.dataset.cc98SmartSearchSourceQuery = sourceQuery;
    card.dataset.cc98SmartSearchOriginalIndex = String(10000 + index);
    card.dataset.cc98SmartSearchHadTitle = "0";
    card.dataset.cc98SmartSearchHitCount = String(raw.hitCount || 0);
    card.dataset.cc98SmartSearchReplyCount = String(raw.replyCount || 0);

    const userUrl = raw.userId ? `/user/id/${raw.userId}` : "";
    const topicUrl = `/topic/${topicId}`;
    const boardUrl = raw.boardId ? `/board/${raw.boardId}` : "/";
    const lastPostUserUrl = raw.lastPostUser ? `/user/name/${encodeURIComponent(raw.lastPostUser)}` : "";
    const portraitUrl = raw.portraitUrl || (raw.userId ? "/static/images/default_avatar_boy.png" : "/static/images/_心灵之约.png");

    const userColumn = createElement(raw.userId ? "a" : "div", "focus-topic-left");
    if (raw.userId) {
      userColumn.href = userUrl;
      userColumn.target = "_blank";
      userColumn.id = `user_cc98ss_${topicId}`;
    }
    const avatar = createElement("img", "focus-topic-portraitUrl");
    avatar.src = portraitUrl;
    avatar.alt = raw.userName || "匿名用户";
    avatar.onerror = () => {
      avatar.src = "/static/images/default_avatar_boy.png";
    };
    const userName = createElement("div", "focus-topic-userName", raw.userName || "匿名用户");
    userColumn.append(avatar, userName);

    const main = createElement("div", "focus-topic-middle");
    const title = createElement("a", "focus-topic-title", raw.title || "(无标题)");
    title.href = topicUrl;
    title.target = "_blank";
    const info = createElement("div", "focus-topic-info");
    const lastPost = createElement("div", "");
    lastPost.append("最后回复：");
    if (lastPostUserUrl) {
      const lastPostLink = createElement("a", "", raw.lastPostUser);
      lastPostLink.href = lastPostUserUrl;
      lastPostLink.target = "_blank";
      lastPost.append(lastPostLink);
    } else {
      lastPost.append("未知");
    }
    const timeInfo = createElement("div", "");
    timeInfo.append(createElement("i", "fa fa-clock-o fa-lg"), formatDateLabel(raw.time));
    const hitInfo = createElement("div", "");
    hitInfo.append(createElement("i", "fa fa-eye fa-lg"), ` ${raw.hitCount || 0}`);
    info.append(
      timeInfo,
      hitInfo,
      lastPost
    );
    main.append(title, info);

    const rightBar = createElement("div", "focus-topic-rightBar");
    const boardLink = createElement("a", "focus-topic-right");
    boardLink.href = boardUrl;
    boardLink.target = "_blank";
    const board = createElement("div", "focus-topic-board", raw.boardName || (raw.boardId ? `版面 ${raw.boardId}` : "全站"));
    boardLink.append(board);

    card.append(userColumn, main, rightBar, boardLink);
    return card;
  }

  function clearSupplementalCards(container) {
    container.querySelectorAll('[data-cc98-smart-search-supplemental="1"]').forEach((card) => card.remove());
    state.supplementalAdded = 0;
    state.supplementalQueries = [];
    state.supplementalError = "";
    state.supplementalStatus = "";
  }

  function appendApiResults(container, results, sourceQuery) {
    const known = new Set(
      Array.from(container.querySelectorAll(":scope > .focus-topic")).map((card) => getTopicKeyFromCard(card))
    );
    const fragment = document.createDocumentFragment();
    let appended = 0;

    for (const raw of results) {
      const card = createApiResultCard(raw, sourceQuery, state.supplementalAdded + appended);
      if (!card) continue;

      const key = getTopicKeyFromCard(card);
      if (known.has(key)) continue;

      known.add(key);
      fragment.appendChild(card);
      appended += 1;
    }

    if (appended > 0) {
      state.suppressMutations = true;
      container.appendChild(fragment);
      window.setTimeout(() => {
        state.suppressMutations = false;
      }, 0);
    }

    return appended;
  }

  function describeSupplementalError(error) {
    if (!error) return "";
    if (error.name === "AbortError") return "API 超时";
    if (error.code === "CC98_RATE_LIMITED") return "API 被限流";
    if (error.code === "CC98_UNAUTHORIZED") return "未登录或授权失效";
    return "API 暂不可用";
  }

  function ensureSupplementalResults(container, parsed) {
    const key = supplementalKeyFor(parsed);
    if (state.supplementalKey === key && state.supplementalRunning) return;
    if (state.supplementalKey === key && state.supplementalQueries.length) return;
    if (state.supplementalRunning && state.supplementalKey !== key) {
      state.supplementalRunning = false;
    }

    clearSupplementalCards(container);
    state.supplementalKey = key;

    const queries = buildSupplementalQueries(parsed);
    state.supplementalQueries = queries;
    if (!queries.length) return;
    state.supplementalStatus = `等待 ${(supplementalDelayMs() / 1000).toFixed(1)}s 后补召回`;

    runSupplementalSearches(container, key, queries);
  }

  async function runSupplementalSearches(container, key, queries) {
    state.supplementalRunning = true;
    state.supplementalError = "";
    const boardId = getCurrentSearchBoardId();

    try {
      await sleep(supplementalDelayMs());
      if (state.supplementalKey !== key) return;
      state.supplementalStatus = "API 请求中";
      sortNativeResultsSoon();

      for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        try {
          const results = await fetchTopicSearchWithRetry(boardId, query);
          if (state.supplementalKey !== key) return;
          state.supplementalAdded += appendApiResults(container, results, query);
          state.supplementalStatus = "";
          sortNativeResultsSoon();
          if (index < queries.length - 1) {
            await sleep(supplementalDelayMs());
            if (state.supplementalKey !== key) return;
          }
        } catch (error) {
          if (state.supplementalKey !== key) return;
          state.supplementalError = describeSupplementalError(error);
          break;
        }
      }
    } finally {
      if (state.supplementalKey === key) {
        state.supplementalRunning = false;
        sortNativeResultsSoon();
      }
    }
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
      hitCount: metricItems[0] || card.dataset.cc98SmartSearchHitCount || fallbackMetrics[0] || "0",
      replyCount: metricItems[1] || card.dataset.cc98SmartSearchReplyCount || "0",
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

    const supplement = state.supplementalQueries.length
      ? ` · API 补召回${state.supplementalRunning ? "中" : ""}：${state.supplementalAdded} 条`
      : "";
    const warning = state.supplementalStatus
      ? ` · ${state.supplementalStatus}`
      : state.supplementalError
        ? ` · ${state.supplementalError}`
        : "";
    hint.textContent = `已按 ${modeLabels[state.activeMode] || "综合"} SearchRank 原生重排 ${visibleCount}/${totalCount} 条结果${supplement}${warning}`;
  }

  function sortNativeResults() {
    if (!state.settings.enabled || state.isSorting || !location.pathname.toLowerCase().startsWith("/search")) return;

    const container = document.querySelector(".focus-topic-topicArea");
    if (!container) return;

    state.isSorting = true;
    state.suppressMutations = true;
    state.observer?.disconnect();
    try {
      const parsed = getQueryForCurrentSearchPage();
      ensureSupplementalResults(container, parsed);

      const cards = Array.from(container.querySelectorAll(":scope > .focus-topic"));
      if (!cards.length) {
        renderNativeHint(container, 0, 0);
        return;
      }

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
    if (!container) {
      document.getElementById("cc98-smart-search-native-hint")?.remove();
      return;
    }

    state.supplementalKey = "";
    state.supplementalRunning = false;
    clearSupplementalCards(container);

    const cards = Array.from(container.querySelectorAll(":scope > .focus-topic"));
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
