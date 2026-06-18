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
  const LEXICON = globalThis.CC98_SMART_SEARCH_LEXICON || {};
  const RAW_ALIAS_GROUPS = Array.isArray(LEXICON.aliasGroups) ? LEXICON.aliasGroups : [];
  const SEGMENT_TERMS = Array.isArray(LEXICON.segmentTerms) ? LEXICON.segmentTerms : [];
  const SHORT_QUERY_EXPANSIONS = LEXICON.shortQueryExpansions || {};

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
    shortQueryPhrases: [],
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

  function compactText(value) {
    return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, "");
  }

  function uniq(values) {
    const seen = new Set();
    const result = [];
    for (const value of values.filter(Boolean)) {
      const key = normalizeText(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  function buildAliasMap(groups) {
    const aliasMap = {};

    for (const group of groups) {
      if (!Array.isArray(group)) continue;
      const terms = uniq(group.map((value) => String(value || "").trim()).filter(Boolean));

      for (const term of terms) {
        const related = terms.filter((value) => normalizeText(value) !== normalizeText(term));
        aliasMap[term] = uniq([...(aliasMap[term] || []), ...related]);
      }
    }

    return aliasMap;
  }

  const ALIASES = buildAliasMap(RAW_ALIAS_GROUPS);
  const NORMALIZED_ALIAS_KEYS = new Map(Object.keys(ALIASES).map((key) => [normalizeText(key), key]));

  let segmentEntries = null;

  function getSegmentEntries() {
    if (segmentEntries) return segmentEntries;

    const values = [
      ...SEGMENT_TERMS,
      ...Object.keys(ALIASES),
      ...Object.values(ALIASES).flat()
    ];
    segmentEntries = uniq(values)
      .map((term) => ({ term, compact: compactText(term) }))
      .filter((entry) => entry.compact.length >= 2)
      .sort((left, right) => right.compact.length - left.compact.length);
    return segmentEntries;
  }

  function matchSegmentAt(text, index) {
    return getSegmentEntries().find((entry) => text.startsWith(entry.compact, index)) || null;
  }

  function isAsciiLetterOrNumber(char) {
    return /^[a-z0-9]$/i.test(char);
  }

  function segmentToken(token) {
    const text = compactText(token);
    if (!text) return [];

    const result = [];
    let index = 0;
    while (index < text.length) {
      const matched = matchSegmentAt(text, index);
      if (matched) {
        result.push(matched.term);
        index += matched.compact.length;
        continue;
      }

      if (isAsciiLetterOrNumber(text[index])) {
        let end = index + 1;
        while (end < text.length && isAsciiLetterOrNumber(text[end]) && !matchSegmentAt(text, end)) {
          end += 1;
        }
        result.push(text.slice(index, end));
        index = end;
        continue;
      }

      let end = index + 1;
      while (end < text.length && !isAsciiLetterOrNumber(text[end]) && !matchSegmentAt(text, end)) {
        end += 1;
      }
      result.push(text.slice(index, end));
      index = end;
    }

    return uniq(result);
  }

  function splitQueryTokens(input) {
    return String(input || "")
      .normalize("NFKC")
      .replace(/[，,;；、|/\\()[\]{}<>《》【】"'“”‘’]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function textIncludes(haystack, needle) {
    const normalizedHaystack = normalizeText(haystack);
    const normalizedNeedle = normalizeText(needle);
    if (!normalizedNeedle) return false;
    if (normalizedHaystack.includes(normalizedNeedle)) return true;

    const compactHaystack = compactText(haystack);
    const compactNeedle = compactText(needle);
    return Boolean(compactNeedle && compactHaystack.includes(compactNeedle));
  }

  function parseQuery(input) {
    const include = [];
    const exclude = [];
    const terms = [];
    const tokens = splitQueryTokens(input);

    for (const rawToken of tokens) {
      const sign = rawToken.startsWith("+") || rawToken.startsWith("-") ? rawToken[0] : "";
      const body = sign ? rawToken.slice(1) : rawToken;
      const segmented = segmentToken(body);
      const values = segmented.length ? segmented : [body].filter(Boolean);

      if (sign === "+") {
        include.push(...values);
      } else if (sign === "-") {
        exclude.push(...values);
      } else {
        terms.push(...values);
      }
    }

    return {
      raw: String(input || "").trim(),
      include: uniq(include),
      exclude: uniq(exclude),
      terms: uniq(terms)
    };
  }

  function aliasesFor(term, fuzzyLevel) {
    const normalized = normalizeText(term);
    const foundKey = NORMALIZED_ALIAS_KEYS.get(normalized);
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
      confidence: index === 0 ? 1 : 0.85
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
    return uniq([...parsed.include, ...parsed.terms]).filter(Boolean).join(" ").trim();
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
    return buildSupplementalQueriesFromContainer(parsed, null);
  }

  function isSingleHanCharacter(value) {
    return /^[\p{Script=Han}]$/u.test(compactText(value));
  }

  function getShortQueryTerm(parsed) {
    if (parsed.exclude.length) return "";
    if (parsed.include.length > 1 || parsed.terms.length > 1) return "";
    if (parsed.include.length === 1 && parsed.terms.length === 0) {
      return isSingleHanCharacter(parsed.include[0]) ? parsed.include[0] : "";
    }
    if (parsed.include.length === 0 && parsed.terms.length === 1) {
      return isSingleHanCharacter(parsed.terms[0]) ? parsed.terms[0] : "";
    }
    return "";
  }

  function extractShortPhrasesFromText(text, shortTerm) {
    const target = compactText(shortTerm);
    if (!target) return [];

    const phrases = [];
    const sequences = String(text || "").match(/[\p{Script=Han}]{2,}/gu) || [];
    for (const sequence of sequences) {
      for (let size = 2; size <= 4; size += 1) {
        if (sequence.length < size) continue;
        for (let index = 0; index <= sequence.length - size; index += 1) {
          const phrase = sequence.slice(index, index + size);
          if (compactText(phrase).includes(target)) phrases.push(phrase);
        }
      }
    }
    return uniq(phrases);
  }

  function mineShortQueryPhrases(container, shortTerm) {
    if (!container || !shortTerm) return [];

    const scores = new Map();
    const cards = Array.from(container.querySelectorAll(":scope > .focus-topic"));
    for (const [cardIndex, card] of cards.entries()) {
      const title = card.querySelector(".focus-topic-title")?.textContent || "";
      for (const phrase of extractShortPhrasesFromText(title, shortTerm)) {
        if (compactText(phrase) === compactText(shortTerm)) continue;
        const current = scores.get(phrase) || 0;
        const lengthBonus = phrase.length === 2 ? 4 : phrase.length === 3 ? 2 : 1;
        const positionBonus = Math.max(0, 6 - Math.min(cardIndex, 6));
        scores.set(phrase, current + lengthBonus + positionBonus);
      }
    }

    return Array.from(scores.entries())
      .sort((left, right) => right[1] - left[1] || left[0].length - right[0].length)
      .map(([phrase]) => phrase);
  }

  function buildShortQuerySupplementalQueries(parsed, container, limit) {
    const shortTerm = getShortQueryTerm(parsed);
    if (!shortTerm || limit <= 0) return [];

    const manual = Array.isArray(SHORT_QUERY_EXPANSIONS[shortTerm])
      ? SHORT_QUERY_EXPANSIONS[shortTerm]
      : [];
    const mined = mineShortQueryPhrases(container, shortTerm);
    const original = [shortTerm];

    return uniq([...manual, ...mined, ...original])
      .filter(Boolean)
      .slice(0, limit);
  }

  function buildSupplementalQueriesFromContainer(parsed, container) {
    const limit = maxSupplementalQueries();
    if (limit <= 0) return [];

    const baseTerms = [...parsed.include, ...parsed.terms].filter(Boolean).slice(0, 5);
    if (!baseTerms.length) return [];

    const originalQuery = normalizeText(buildNativeSearchQuery(parsed));
    const queries = buildShortQuerySupplementalQueries(parsed, container, limit);

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
      parsed.exclude.join(" "),
      getShortQueryTerm(parsed)
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
    return parsed.exclude.some((term) => textIncludes(haystack, term));
  }

  function satisfiesInclude(result, parsed) {
    if (parsed.include.length === 0) return true;
    const haystack = getResultText(result);
    return parsed.include.every((term) => {
      return expandedMatchTerms(term).some((candidate) => textIncludes(haystack, candidate.normalized));
    });
  }

  function getRelevanceScore(result, parsed) {
    const title = normalizeText(result.title);
    const haystack = getResultText(result);
    let score = 0;

    for (const term of parsed.include) {
      for (const candidate of expandedMatchTerms(term)) {
        if (textIncludes(haystack, candidate.normalized)) {
          score += candidate.confidence >= 1 ? 80 : candidate.confidence >= 0.8 ? 60 : 35;
          break;
        }
      }
    }

    for (const term of parsed.terms) {
      for (const candidate of expandedMatchTerms(term)) {
        if (textIncludes(title, candidate.normalized)) {
          score += candidate.confidence >= 1 ? 30 : candidate.confidence >= 0.8 ? 25 : 10;
          break;
        }
        if (textIncludes(haystack, candidate.normalized)) {
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

  function getShortQueryCluster(result, shortTerm) {
    if (!shortTerm) return "";
    const phrases = extractShortPhrasesFromText(result.title, shortTerm);
    if (!phrases.length) return compactText(shortTerm);
    return compactText(phrases.find((phrase) => phrase.length === 2) || phrases[0]);
  }

  function diversifyShortQueryRanking(ranked, parsed) {
    const shortTerm = getShortQueryTerm(parsed);
    if (!shortTerm || ranked.length < 3) return ranked;

    const remaining = ranked.map((result) => ({
      ...result,
      shortQueryCluster: getShortQueryCluster(result, shortTerm)
    }));
    const selected = [];
    const clusterCounts = new Map();

    while (remaining.length) {
      let bestIndex = 0;
      let bestScore = -Infinity;

      for (let index = 0; index < remaining.length; index += 1) {
        const result = remaining[index];
        const seen = clusterCounts.get(result.shortQueryCluster) || 0;
        const penalty = Math.min(24, seen * 8);
        const score = result.rank.finalScore - penalty;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }

      const [next] = remaining.splice(bestIndex, 1);
      const seen = clusterCounts.get(next.shortQueryCluster) || 0;
      const penalty = Math.min(24, seen * 8);
      next.rank = {
        ...next.rank,
        diversityPenalty: penalty,
        shortQueryCluster: next.shortQueryCluster,
        finalScore: next.rank.finalScore - penalty
      };
      clusterCounts.set(next.shortQueryCluster, seen + 1);
      selected.push(next);
    }

    return selected;
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
    state.shortQueryPhrases = [];
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

    const queries = buildSupplementalQueriesFromContainer(parsed, container);
    state.supplementalQueries = queries;
    state.shortQueryPhrases = getShortQueryTerm(parsed)
      ? queries.filter((query) => normalizeText(query) !== normalizeText(buildNativeSearchQuery(parsed))).slice(0, 4)
      : [];
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

  function renderNativeHint(container, visibleCount, totalCount, parsed) {
    let hint = document.getElementById("cc98-smart-search-native-hint");
    if (!hint) {
      hint = document.createElement("div");
      hint.id = "cc98-smart-search-native-hint";
      container.parentElement.insertBefore(hint, container);
    }

    const modeLabels = {
      balanced: "综合",
      recent: "时间优先",
      hot: "热度优先",
      custom: "自定义"
    };

    const supplement = state.supplementalQueries.length
      ? ` · API 补召回${state.supplementalRunning ? "中" : ""}：${state.supplementalAdded} 条`
      : "";
    const shortQuery = state.shortQueryPhrases.length
      ? ` · 短词扩召回：${state.shortQueryPhrases.join(" / ")}`
      : "";
    const warning = state.supplementalStatus
      ? ` · ${state.supplementalStatus}`
      : state.supplementalError
        ? ` · ${state.supplementalError}`
        : "";
    hint.textContent = `已按 ${modeLabels[state.activeMode] || "综合"} SearchRank 原生重排 ${visibleCount}/${totalCount} 条结果${supplement}${shortQuery}${warning}`;
    if (parsed) {
      const include = parsed.include.length ? `+ ${parsed.include.join(" / ")}` : "";
      const terms = parsed.terms.length ? parsed.terms.join(" / ") : "";
      const exclude = parsed.exclude.length ? `- ${parsed.exclude.join(" / ")}` : "";
      hint.title = ["分词", include, terms, exclude].filter(Boolean).join("：");
    }
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
        renderNativeHint(container, 0, 0, parsed);
        return;
      }

      const ranked = diversifyShortQueryRanking(cards
        .map((card, originalIndex) => extractNativeResult(card, originalIndex))
        .map((result) => ({ ...result, rank: scoreResult(result, parsed) }))
        .sort((a, b) => b.rank.finalScore - a.rank.finalScore), parsed);

      let visibleCount = 0;
      const fragment = document.createDocumentFragment();
      for (const result of ranked) {
        const keep = !shouldDropResult(result, parsed) && satisfiesInclude(result, parsed);
        result.card.classList.toggle("cc98-smart-search-hidden", !keep);
        result.card.dataset.cc98SmartSearchScore = result.rank.finalScore.toFixed(1);
        const diversity = result.rank.diversityPenalty
          ? ` | 短词簇 ${result.rank.shortQueryCluster} -${result.rank.diversityPenalty.toFixed(0)}`
          : "";
        result.card.title = `SearchRank ${result.rank.finalScore.toFixed(1)} | 相关 ${result.rank.relevanceScore.toFixed(0)} | 时间 ${result.rank.timeScore.toFixed(0)} | 热度 ${result.rank.hotScore.toFixed(0)}${diversity}`;
        if (keep) visibleCount += 1;
        fragment.appendChild(result.card);
      }
      container.appendChild(fragment);
      renderNativeHint(container, visibleCount, cards.length, parsed);
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
