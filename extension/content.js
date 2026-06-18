(function () {
  "use strict";

  const API_BASE = "https://api.cc98.org";
  const MAX_QUERIES = 4;
  const PAGE_SIZE = 20;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const ROOT_ID = "cc98-smart-search-root";

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
    activeMode: "balanced",
    lastPayload: null,
    cache: new Map(),
    boardNames: new Map()
  };

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

  function aliasesFor(term) {
    const normalized = normalizeText(term);
    const foundKey = Object.keys(ALIASES).find((key) => normalizeText(key) === normalized);
    const direct = foundKey ? ALIASES[foundKey] : [];
    return uniq([term, ...direct]);
  }

  function expandedMatchTerms(term) {
    return aliasesFor(term).map((value, index) => ({
      value,
      normalized: normalizeText(value),
      confidence: index === 0 ? 1 : index === 1 ? 0.85 : 0.6
    }));
  }

  function generateSearchPlan(parsed) {
    const searchableTerms = [...parsed.include, ...parsed.terms].filter(Boolean);
    if (searchableTerms.length === 0) return [];

    const base = searchableTerms.slice(0, 5);
    const plans = [base.join(" ")];

    for (let index = 0; index < base.length && plans.length < MAX_QUERIES; index += 1) {
      const term = base[index];
      const aliases = aliasesFor(term).filter((alias) => normalizeText(alias) !== normalizeText(term));

      for (const alias of aliases) {
        if (plans.length >= MAX_QUERIES) break;
        const next = base.slice();
        next[index] = alias;
        plans.push(next.join(" "));
      }
    }

    return uniq(plans).slice(0, MAX_QUERIES).map((query, index) => ({
      query,
      isOriginal: index === 0
    }));
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
    const headers = new Headers(options && options.headers ? options.headers : undefined);
    const authorization = getAuthorizationHeader();
    if (authorization) headers.set("Authorization", authorization);
    headers.set("Accept", "application/json");

    const response = await fetch(new URL(path, API_BASE).toString(), {
      ...options,
      headers
    });

    if (response.status === 401) {
      throw new Error("需要登录 CC98 后才能使用增强主题搜索。");
    }
    if (response.status === 403) {
      throw new Error("搜索请求被 CC98 拒绝，可能是请求过于频繁。");
    }
    if (!response.ok) {
      throw new Error(`CC98 搜索请求失败：${response.status}`);
    }
    return response.json();
  }

  async function resolveBoardIdForScope(scopeText) {
    if (scopeText === "主题" || scopeText === "全站") return 0;
    if (scopeText !== "版内") return null;

    const boardMatch = location.pathname.match(/\/board\/(\d+)/i);
    if (boardMatch) return Number.parseInt(boardMatch[1], 10);

    const searchBoard = new URLSearchParams(location.search).get("boardId");
    if (searchBoard && Number.parseInt(searchBoard, 10) > 0) {
      return Number.parseInt(searchBoard, 10);
    }

    const topicMatch = location.pathname.match(/\/topic\/(\d+)/i);
    if (!topicMatch) return 0;

    try {
      const topic = await cc98Fetch(`/topic/${topicMatch[1]}`);
      return Number.parseInt(topic.boardId, 10) || 0;
    } catch (_error) {
      return 0;
    }
  }

  async function getBoardName(boardId) {
    if (!boardId) return "全站";
    if (state.boardNames.has(boardId)) return state.boardNames.get(boardId);

    try {
      const boards = await cc98Fetch("/board/all");
      for (const board of boards || []) {
        state.boardNames.set(board.id, board.name);
      }
    } catch (_error) {
      return `版面 ${boardId}`;
    }

    return state.boardNames.get(boardId) || `版面 ${boardId}`;
  }

  async function fetchTopicSearch(boardId, query) {
    const cacheKey = `${boardId}:${query}`;
    const cached = state.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
      return cached.data;
    }

    const encoded = encodeURIComponent(query);
    const path = boardId === 0
      ? `/topic/search?keyword=${encoded}&size=${PAGE_SIZE}&from=0`
      : `/topic/search/board/${boardId}?keyword=${encoded}&size=${PAGE_SIZE}&from=0`;

    const data = await cc98Fetch(path);
    state.cache.set(cacheKey, { time: Date.now(), data: Array.isArray(data) ? data : [] });
    return Array.isArray(data) ? data : [];
  }

  function getResultText(result) {
    return normalizeText([
      result.title,
      result.userName,
      result.boardName,
      result.lastPostUser
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

  function dateFromResult(result) {
    const value = result.lastPostTime || result.time;
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
  }

  function toNumber(value) {
    if (typeof value === "number") return value;
    const text = String(value || "").trim();
    if (!text) return 0;
    if (text.endsWith("万")) return Number.parseFloat(text) * 10000 || 0;
    return Number.parseFloat(text) || 0;
  }

  function getTimeScore(result) {
    const date = dateFromResult(result);
    if (!date) return 0;
    const days = (Date.now() - date.getTime()) / 86400000;
    if (days <= 7) return 30;
    if (days <= 30) return 20;
    if (days <= 180) return 10;
    if (days <= 365) return 5;
    return 0;
  }

  function getHotScore(result) {
    const hitCount = toNumber(result.hitCount);
    const replyCount = toNumber(result.replyCount);
    return Math.log10(hitCount + 1) * 8 + Math.log10(replyCount + 1) * 15;
  }

  function getRelevanceScore(result, parsed, originalQuery) {
    const title = normalizeText(result.title);
    const haystack = getResultText(result);
    let score = 0;

    if (title.includes(normalizeText(originalQuery))) score += 100;

    for (const term of parsed.include) {
      for (const candidate of expandedMatchTerms(term)) {
        if (haystack.includes(candidate.normalized)) {
          score += candidate.confidence >= 1 ? 80 : candidate.confidence >= 0.8 ? 60 : 35;
          break;
        }
      }
    }

    for (const term of parsed.terms) {
      const candidates = expandedMatchTerms(term);
      for (const candidate of candidates) {
        if (title.includes(candidate.normalized)) {
          score += candidate.confidence >= 1 ? 30 : candidate.confidence >= 0.8 ? 25 : 10;
          break;
        }
      }
    }

    const extraMatches = Math.max(0, (result.matchedQueries || []).length - 1);
    score += extraMatches * 20;

    const sourceRank = result.bestSourceRank || 0;
    score += Math.max(0, 15 - sourceRank * 3);

    return score;
  }

  function scoreResult(result, parsed, mode) {
    const relevanceScore = getRelevanceScore(result, parsed, parsed.raw);
    const timeScore = getTimeScore(result);
    const hotScore = getHotScore(result);

    const weights = {
      balanced: [0.7, 0.15, 0.15],
      recent: [0.4, 0.45, 0.15],
      hot: [0.4, 0.1, 0.5]
    }[mode] || [0.7, 0.15, 0.15];

    return {
      relevanceScore,
      timeScore,
      hotScore,
      finalScore: relevanceScore * weights[0] + timeScore * weights[1] + hotScore * weights[2]
    };
  }

  function mergeResults(batches, parsed) {
    const merged = new Map();

    for (const batch of batches) {
      batch.results.forEach((raw, sourceRank) => {
        const id = raw.id || raw.topicId;
        if (!id) return;

        const existing = merged.get(id);
        const next = existing || {
          ...raw,
          id,
          matchedQueries: [],
          bestSourceRank: sourceRank
        };

        next.matchedQueries.push(batch.query);
        next.bestSourceRank = Math.min(next.bestSourceRank, sourceRank);
        merged.set(id, next);
      });
    }

    return Array.from(merged.values())
      .filter((result) => !shouldDropResult(result, parsed))
      .filter((result) => satisfiesInclude(result, parsed));
  }

  function rankResults(results, parsed, mode) {
    return results
      .map((result) => ({
        ...result,
        rank: scoreResult(result, parsed, mode)
      }))
      .sort((a, b) => b.rank.finalScore - a.rank.finalScore);
  }

  function formatDate(value) {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function currentScopeText() {
    return document.querySelector(".searchBoxSelect")?.textContent?.trim() || "主题";
  }

  function currentInputValue() {
    return document.querySelector("#searchText")?.value?.trim() || "";
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("section");
    root.id = ROOT_ID;

    const focus = document.querySelector(".focus");
    const mainContainer = document.querySelector(".main-container");
    const search = document.querySelector("#search");
    const anchor = focus || mainContainer || search || document.body;

    if (focus) {
      focus.prepend(root);
    } else if (anchor === document.body) {
      document.body.prepend(root);
    } else {
      anchor.parentElement.insertBefore(root, anchor.nextSibling);
    }

    return root;
  }

  function renderShell(message) {
    const root = ensureRoot();
    root.innerHTML = `
      <div class="cc98-ss-panel">
        <div class="cc98-ss-header">
          <div>
            <div class="cc98-ss-kicker">CC98 Smart Search</div>
            <h2>增强搜索</h2>
          </div>
          <div class="cc98-ss-status">${escapeHtml(message)}</div>
        </div>
      </div>
    `;
  }

  function explainMatches(result, parsed) {
    const haystack = getResultText(result);
    const matches = [];

    for (const term of [...parsed.include, ...parsed.terms]) {
      const hit = expandedMatchTerms(term).find((candidate) => haystack.includes(candidate.normalized));
      if (hit) {
        matches.push(hit.value === term ? term : `${hit.value} ← ${term}`);
      }
    }

    return uniq(matches).join("；") || "未识别到显式关键词";
  }

  function renderResults(payload) {
    state.lastPayload = payload;
    const root = ensureRoot();
    const ranked = rankResults(payload.results, payload.parsed, state.activeMode);
    const modes = [
      ["balanced", "综合"],
      ["recent", "最新"],
      ["hot", "热门"]
    ];

    root.innerHTML = `
      <div class="cc98-ss-panel">
        <div class="cc98-ss-header">
          <div>
            <div class="cc98-ss-kicker">CC98 Smart Search</div>
            <h2>${escapeHtml(payload.parsed.raw)}</h2>
          </div>
          <div class="cc98-ss-mode" role="group" aria-label="排序方式">
            ${modes.map(([id, label]) => `
              <button class="${id === state.activeMode ? "active" : ""}" data-cc98-ss-mode="${id}" type="button">${label}</button>
            `).join("")}
          </div>
        </div>
        <div class="cc98-ss-plan">
          <strong>搜索计划</strong>
          ${payload.plan.map((item, index) => `<span>${index + 1}. ${escapeHtml(item.query)}</span>`).join("")}
        </div>
        <div class="cc98-ss-summary">
          找到 ${ranked.length} 条增强结果 · 范围：${escapeHtml(payload.boardName)}
        </div>
        <div class="cc98-ss-results">
          ${ranked.length ? ranked.map((result) => renderResultItem(result, payload.parsed)).join("") : renderEmpty()}
        </div>
      </div>
    `;

    root.querySelectorAll("[data-cc98-ss-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeMode = button.getAttribute("data-cc98-ss-mode") || "balanced";
        renderResults(payload);
      });
    });
  }

  function renderResultItem(result, parsed) {
    const topicUrl = `https://www.cc98.org/topic/${result.id}/1`;
    const boardUrl = result.boardId ? `https://www.cc98.org/board/${result.boardId}` : "https://www.cc98.org/";
    const boardName = result.boardName || (result.boardId ? `版面 ${result.boardId}` : "全站");
    const replyCount = toNumber(result.replyCount);
    const hitCount = toNumber(result.hitCount);
    const score = result.rank.finalScore.toFixed(1);

    return `
      <article class="cc98-ss-item">
        <a class="cc98-ss-title" href="${topicUrl}" target="_blank" rel="noreferrer">${escapeHtml(result.title || "(无标题)")}</a>
        <div class="cc98-ss-meta">
          <a href="${boardUrl}" target="_blank" rel="noreferrer">${escapeHtml(boardName)}</a>
          <span>${escapeHtml(result.userName || "匿名用户")}</span>
          <span>发帖 ${escapeHtml(formatDate(result.time))}</span>
          <span>最后回复 ${escapeHtml(formatDate(result.lastPostTime))}</span>
        </div>
        <div class="cc98-ss-hit">命中：${escapeHtml(explainMatches(result, parsed))}</div>
        <div class="cc98-ss-score">
          <span>SearchRank ${score}</span>
          <span>相关 ${result.rank.relevanceScore.toFixed(0)}</span>
          <span>时间 ${result.rank.timeScore.toFixed(0)}</span>
          <span>热度 ${result.rank.hotScore.toFixed(0)}</span>
          <span>浏览 ${Math.round(hitCount)}</span>
          <span>回复 ${Math.round(replyCount)}</span>
        </div>
      </article>
    `;
  }

  function renderEmpty() {
    return `
      <div class="cc98-ss-empty">
        没有找到符合增强过滤条件的结果。可以减少 + 必须词或 - 排除词后再试。
      </div>
    `;
  }

  function renderError(error) {
    const root = ensureRoot();
    root.innerHTML = `
      <div class="cc98-ss-panel cc98-ss-error">
        <div class="cc98-ss-header">
          <div>
            <div class="cc98-ss-kicker">CC98 Smart Search</div>
            <h2>搜索失败</h2>
          </div>
        </div>
        <p>${escapeHtml(error.message || String(error))}</p>
      </div>
    `;
  }

  async function runSmartSearch() {
    const query = currentInputValue();
    if (!query) return;

    const scope = currentScopeText();
    if (scope === "用户" || scope === "版面") {
      return;
    }

    renderShell("正在生成搜索计划...");

    try {
      const parsed = parseQuery(query);
      const plan = generateSearchPlan(parsed);
      if (!plan.length) {
        throw new Error("请输入至少一个普通关键词或 + 必须词。");
      }

      const boardId = await resolveBoardIdForScope(scope);
      const boardName = await getBoardName(boardId || 0);
      renderShell(`正在搜索 ${plan.length} 组关键词...`);

      const batches = [];
      for (const item of plan) {
        const results = await fetchTopicSearch(boardId || 0, item.query);
        batches.push({ query: item.query, results });
      }

      const merged = mergeResults(batches, parsed);
      renderResults({ parsed, plan, results: merged, boardId: boardId || 0, boardName });
    } catch (error) {
      renderError(error);
    }
  }

  function shouldHandleEvent(target) {
    const scope = currentScopeText();
    if (scope === "用户" || scope === "版面") return false;
    return Boolean(target && (target.closest?.(".searchIco") || target.id === "searchText"));
  }

  function installInterceptors() {
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.(".searchIco")) return;
      if (!shouldHandleEvent(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runSmartSearch();
    }, true);

    document.addEventListener("keypress", (event) => {
      if (event.key !== "Enter" && event.keyCode !== 13) return;
      if (!shouldHandleEvent(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runSmartSearch();
    }, true);
  }

  installInterceptors();
})();
