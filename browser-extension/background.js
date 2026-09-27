const HOST = "com.voltur.browser_control";
const RECONNECT_ALARM = "native-host-reconnect";
let nativePort = null;
let nativeReady = false;
let reconnectTimer = null;
let reconnectDelayMs = 1000;
let reconnectPending = false;
const expectedDisconnects = new Set();

function publicSite(value) {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? url.origin : "[адрес скрыт]";
  } catch (_) {
    return "[адрес скрыт]";
  }
}

function redactPageText(value, dropSensitiveLines = true) {
  const sensitiveWords = /(?:парол|одноразов|(?:^|[^\p{L}])код(?:$|[^\p{L}])|код\s*(?:подтвержден|доступа|безопасност)|номер\s*карт|срок\s*действия|секретн|токен|password|passcode|\bcode\b|verification\s*code|security\s*code|one.?time.?code|\botp\b|\bcvv\b|\bcvc\b|\bpin\b|api.?key|secret|access.?token|card\s*number|expiry)/iu;
  const text = String(value || "").slice(0, 20000);
  let hideFollowingLines = 0;
  return text.split(/\r?\n/).map((line) => {
    if (hideFollowingLines && line.trim()) {
      hideFollowingLines--;
      return "[конфиденциальная строка скрыта]";
    }
    if (dropSensitiveLines && sensitiveWords.test(line)) {
      hideFollowingLines = 2;
      return "[конфиденциальная строка скрыта]";
    }
    return line
      .replace(/https?:\/\/[^\s<>"']+/gi, (url) => publicSite(url))
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[адрес почты скрыт]")
      .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "[ключ скрыт]")
      .replace(/(?:\d[ -]?){3,19}/g, (sequence) => (sequence.replace(/\D/g, "").length >= 3 ? "[число скрыто]" : sequence));
  }).join("\n");
}

function sanitizeResult(value, key = "") {
  if (typeof value === "string") {
    return key === "url" || key === "href" ? publicSite(value) : redactPageText(value);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeResult(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeResult(item, name)]));
  }
  return value;
}

function sensitiveUrl(value) {
  try {
    const url = new URL(String(value));
    return /(?:login|log-in|sign-?in|auth|password|reset|verify|checkout|payment|billing|bank|wallet|card|otp|2fa|mfa)/i.test(url.pathname)
      || /(?:^|[.-])(?:bank|banking|pay|payment|wallet|checkout)(?:[.-]|$)/i.test(url.hostname);
  } catch (_) {
    return false;
  }
}

async function blockSensitivePage(tabId, tabUrl) {
  if (sensitiveUrl(tabUrl)) throw new Error("Работа с защищённой страницей отключена для сохранения приватных данных.");
  const frames = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const sensitive = /(?:парол|одноразов|код\s*(?:подтвержден|доступа|безопасност)|номер\s*карт|password|passcode|verification.?code|one.?time.?code|\botp\b|\bcvv\b|\bcvc\b|\bpin\b|card|credit|debit|payment|security.?code)/i;
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      return [...document.querySelectorAll("input,textarea,[contenteditable],[role='textbox']")].some((el) => {
        if (!visible(el)) return false;
        const autocomplete = el.getAttribute("autocomplete") || "";
        if (el instanceof HTMLInputElement && el.type === "password") return true;
        if (/^(?:cc-|one-time-code|current-password|new-password)/i.test(autocomplete)) return true;
        const labels = el.labels ? [...el.labels].map((label) => label.textContent).join(" ") : "";
        const description = [labels, el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("data-placeholder")].filter(Boolean).join(" ");
        return sensitive.test(description);
      });
    }
  });
  if (frames.some((frame) => frame.result)) throw new Error("На странице есть поле пароля, кода или платёжных данных; доступ к содержимому отключён.");
}

function clearReconnectSchedule() {
  reconnectPending = false;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  chrome.alarms.clear(RECONNECT_ALARM);
}

function attemptReconnect(fromAlarm = false) {
  if (!reconnectPending && !fromAlarm) return;
  if (nativeReady) {
    clearReconnectSchedule();
    return;
  }
  clearReconnectSchedule();
  if (nativePort) {
    const previousPort = nativePort;
    nativePort = null;
    expectedDisconnects.add(previousPort);
    try { previousPort.disconnect(); } catch (_) {}
  }
  connectNative();
}

function scheduleReconnect() {
  if (reconnectPending) return;
  reconnectPending = true;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10000);
  reconnectTimer = setTimeout(attemptReconnect, delay);
  chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay });
}

async function browserLabel() {
  const ua = navigator.userAgent || "";
  if (/YaBrowser|Yandex/i.test(ua)) return { code: "yandex", name: "Yandex Browser" };
  if (/Edg\//i.test(ua)) return { code: "edge", name: "Microsoft Edge" };
  try { if (navigator.brave?.isBrave && await navigator.brave.isBrave()) return { code: "brave", name: "Brave" }; } catch (_) {}
  if (/OPR\//i.test(ua)) return { code: "opera", name: "Opera" };
  if (/Vivaldi/i.test(ua)) return { code: "vivaldi", name: "Vivaldi" };
  if (/Chrome\//i.test(ua)) return { code: "chrome", name: "Google Chrome" };
  return { code: "unknown", name: "Chromium-based browser" };
}

function connectNative() {
  if (nativePort) return true;
  try {
    const port = chrome.runtime.connectNative(HOST);
    nativePort = port;
    nativeReady = false;
    chrome.storage.local.set({ nativeReady: false, nativeError: "Подключение к Astra…" });
    port.onMessage.addListener((message) => onNativeMessage(port, message));
    port.onDisconnect.addListener(() => {
      if (expectedDisconnects.delete(port)) return;
      const error = chrome.runtime.lastError?.message || "Связь закрыта";
      if (nativePort === port) nativePort = null;
      nativeReady = false;
      chrome.storage.local.set({ nativeReady: false, nativeError: error });
      scheduleReconnect();
    });
    browserLabel().then((browser) => {
      if (nativePort) nativePort.postMessage({ type: "browser_info", browser: browser.name, browser_code: browser.code });
    });
    return true;
  } catch (error) {
    nativePort = null;
    nativeReady = false;
    chrome.storage.local.set({ nativeReady: false, nativeError: String(error) });
    scheduleReconnect();
    return false;
  }
}

function onNativeMessage(port, message) {
  if (port !== nativePort || !message || typeof message !== "object") return;
  if (message.type === "native_ready") {
    nativeReady = Boolean(message.ok);
    chrome.storage.local.set({ nativeReady, nativeError: message.ok ? "" : (message.error || "Плагин Astra недоступен") });
    if (nativeReady) {
      reconnectDelayMs = 1000;
      clearReconnectSchedule();
    } else {
      scheduleReconnect();
    }
    return;
  }
  if (message.type === "command") {
    if (!nativeReady) return;
    handleCommand(message).then((result) => {
      if (port === nativePort && nativeReady) port.postMessage({ type: "result", id: message.id, ...sanitizeResult(result) });
    }).catch((error) => {
      if (port === nativePort && nativeReady) port.postMessage({ type: "result", id: message.id, ok: false, error: redactPageText(String(error)) });
    });
    return;
  }
  if (message.type === "native_error") {
    nativeReady = false;
    chrome.storage.local.set({ nativeReady: false, nativeError: message.error || "Связующий компонент недоступен" });
    scheduleReconnect();
  }
}

function currentActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
    if (!tabs.length || typeof tabs[0].id !== "number") throw new Error("В активном окне не найдена вкладка");
    return tabs[0];
  });
}

async function orderedTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.sort((a, b) => (a.windowId ?? 0) - (b.windowId ?? 0) || (a.index ?? 0) - (b.index ?? 0));
}

function requireWebTab(tab) {
  if (!/^https?:\/\//i.test(tab.url || "")) throw new Error("Эта команда работает только на обычных веб-страницах");
}

function safePageSnapshot(query = "") {
  const sensitive = /(?:парол|одноразов|код\s*(?:подтвержден|доступа|безопасност)|номер\s*карт|password|passcode|verification.?code|one.?time.?code|\botp\b|\bcvv\b|\bcvc\b|\bpin\b|card|credit|debit|payment|security.?code)/i;
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const protectedField = [...document.querySelectorAll("input,textarea,[contenteditable],[role='textbox']")].some((el) => {
    if (!visible(el)) return false;
    const autocomplete = el.getAttribute("autocomplete") || "";
    if (el instanceof HTMLInputElement && el.type === "password") return true;
    if (/^(?:cc-|one-time-code|current-password|new-password)/i.test(autocomplete)) return true;
    const labels = el.labels ? [...el.labels].map((label) => label.textContent).join(" ") : "";
    return sensitive.test([labels, el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder")].filter(Boolean).join(" "));
  });
  if (protectedField) return { blocked: true };
  const lines = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let length = 0;
  for (let node = walker.nextNode(), count = 0; node && count < 18000 && length < 16000; node = walker.nextNode(), count++) {
    const parent = node.parentElement;
    if (!parent || parent.closest("input,textarea,select,[contenteditable],[role='textbox'],[data-private],[data-sensitive],script,style,noscript,[aria-hidden='true']")) continue;
    if (!visible(parent)) continue;
    const value = (node.nodeValue || "").replace(/\s+/g, " ").trim();
    if (!value) continue;
    lines.push(value);
    length += value.length + 1;
  }
  const text = lines.join("\n").slice(0, 16000);
  const needle = String(query || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const matches = needle ? lines.filter((line) => line.toLocaleLowerCase().includes(needle)).slice(0, 12).map((line) => line.slice(0, 220)) : [];
  const interactive = needle ? [...document.querySelectorAll("a,button,[role='button'],[role='link']")].filter((el) => {
    if (!visible(el) || el.closest("[contenteditable],[role='textbox'],[data-private],[data-sensitive]") || el.querySelector("input,textarea,[contenteditable],[role='textbox']")) return false;
    const label = el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "";
    return label.toLocaleLowerCase().includes(needle);
  }).slice(0, 10).map((el) => ({ text: (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 160), tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "" })) : [];
  return { title: document.title || "", url: location.href, text, matches, interactive };
}

async function removeTabsAndConfirm(tabIds) {
  const ids = [...new Set(tabIds)];
  await chrome.tabs.remove(ids);
  const remaining = await chrome.tabs.query({});
  const stillOpen = remaining.filter((tab) => ids.includes(tab.id));
  if (stillOpen.length) {
    throw new Error(`Браузер не подтвердил закрытие ${stillOpen.length} вкладок. Обновите список и попробуйте ещё раз.`);
  }
}

function inspectClickableText(wanted, matchNumber = 0) {
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/ё/gi, "е").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const target = normalize(wanted);
  if (!target) return { ok: false, error: "Укажите текст элемента." };
  if (!Number.isInteger(matchNumber) || matchNumber < 0 || matchNumber > 20) return { ok: false, error: "Номер совпадения должен быть от 0 до 20." };
  const words = target.match(/\p{L}+/gu) || [];
  const selector = "a,button,[role='button'],[role='link'],[role='menuitem'],[role='option'],[tabindex],[onclick]";
  const styleCache = new WeakMap();
  const styleOf = (el) => {
    if (!styleCache.has(el)) styleCache.set(el, getComputedStyle(el));
    return styleCache.get(el);
  };
  const distance = (left, right, max) => {
    if (Math.abs(left.length - right.length) > max) return max + 1;
    let row = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i++) {
      const next = [i];
      let best = next[0];
      for (let j = 1; j <= right.length; j++) {
        next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
        best = Math.min(best, next[j]);
      }
      if (best > max) return max + 1;
      row = next;
    }
    return row[right.length];
  };
  const matchScore = (value) => {
    const text = normalize(value);
    if (!text || text.length > 300) return Infinity;
    if (text.includes(target)) return 0;
    if (words.length < 2 || words.length > 4) return Infinity;
    const candidateWords = text.match(/\p{L}+/gu) || [];
    if (candidateWords.length > 16) return Infinity;
    let total = 0;
    for (const word of words) {
      const max = word.length >= 6 ? 2 : 1;
      const plausible = candidateWords.filter((candidate) =>
        candidate[0] === word[0] && Math.abs(candidate.length - word.length) <= max
      );
      if (!plausible.length) return Infinity;
      const best = Math.min(...plausible.map((candidate) => distance(word, candidate, max)), max + 1);
      if (best > max) return Infinity;
      total += best;
    }
    return total > 3 ? Infinity : total + 1;
  };
  const clickableAncestor = (start) => {
    let pointer = null;
    for (let el = start, depth = 0; el && depth < 9; el = el.parentElement, depth++) {
      if (el.matches(selector)) return el;
      if (styleOf(el).cursor === "pointer") pointer = el;
      else if (pointer) break;
    }
    return pointer;
  };
  const candidates = new Map();
  let textFound = false;
  const consider = (value, start) => {
    const score = matchScore(value);
    if (!Number.isFinite(score)) return;
    textFound = true;
    const el = clickableAncestor(start);
    if (!el) return;
    const previous = candidates.get(el);
    if (!previous || score < previous.score) candidates.set(el, { score, matched_text: String(value).trim().slice(0, 160) });
  };
  const started = performance.now();
  let incomplete = false;
  for (const el of document.querySelectorAll(selector)) {
    const explicitLabel = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (explicitLabel && explicitLabel.length <= 300) consider(explicitLabel, el);
    if (performance.now() - started > 1200) { incomplete = true; break; }
  }
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let scanned = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (++scanned > 15000 || performance.now() - started > 1500) { incomplete = true; break; }
    if (node.parentElement?.closest("input,textarea,[contenteditable],[role='textbox'],[data-private],[data-sensitive]")) continue;
    const value = node.nodeValue?.trim() || "";
    if (value && value.length <= 300) consider(value, node.parentElement);
  }
  const visible = [...candidates.entries()].filter(([el]) => {
    const style = styleOf(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  });
  if (incomplete) return { ok: false, error: "Поиск на большой странице прерван до завершения. Уточните текст или воспользуйтесь списком элементов." };
  if (!visible.length) return { ok: false, error: textFound ? `Текст «${wanted}» виден, но рядом не найден кликабельный элемент.` : `Не нашёл на странице видимый текст «${wanted}».` };
  const bestScore = Math.min(...visible.map(([, match]) => match.score));
  const best = visible.filter(([, match]) => matchNumber > 0 || match.score === bestScore)
    .map(([el, match]) => ({ el, match, rect: el.getBoundingClientRect() }));
  const sameVisibleRow = (left, right) => {
    if (left.el.contains(right.el) || right.el.contains(left.el)) return true;
    const overlapY = Math.max(0, Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top));
    const overlapX = Math.max(0, Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left));
    return overlapY >= Math.min(left.rect.height, right.rect.height) * 0.8 &&
      overlapX >= Math.min(left.rect.width, right.rect.width) * 0.8;
  };
  const groups = [];
  for (const candidate of best) {
    const group = groups.find((items) => items.some((item) => sameVisibleRow(item, candidate)));
    if (group) group.push(candidate);
    else groups.push([candidate]);
  }
  const ranked = groups.map((items) => {
    const candidate = items.sort((left, right) =>
      right.rect.width * right.rect.height - left.rect.width * left.rect.height
    )[0];
    const rect = candidate.rect;
    const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    return { ...candidate, inViewport };
  }).sort((left, right) =>
    Number(right.inViewport) - Number(left.inViewport) ||
    left.rect.top - right.rect.top ||
    left.rect.left - right.rect.left
  );
  const summaries = ranked.slice(0, 5).map(({ el, match, rect }, index) => ({
    match_number: index + 1,
    text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim().slice(0, 120),
    approximate: match.score > 0,
    top: Math.round(rect.top)
  }));
  if (matchNumber === 0 && ranked.length > 1) {
    return { ok: false, ambiguous: true, candidates: summaries,
      error: `Нашёл ${ranked.length} отдельных видимых совпадений «${wanted}». Верхнее можно выбрать match_number=1, второе — match_number=2. Повторять без match_number бессмысленно.` };
  }
  if (matchNumber > ranked.length) {
    return { ok: false, ambiguous: true, candidates: summaries,
      error: `Найдено ${ranked.length} совпадений «${wanted}», но запрошено №${matchNumber}. Выберите номер из списка.` };
  }
  const { el: chosen, match } = ranked[(matchNumber || 1) - 1];
  const label = (chosen.innerText || chosen.getAttribute("aria-label") || chosen.getAttribute("title") || "").replace(/\s+/g, " ").trim();
  const elementId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  chosen.setAttribute("data-astra-browser-control-match", elementId);
  return { ok: true, text: label.slice(0, 160) || match.matched_text, matched_text: match.matched_text, approximate: match.score > 0, element_id: elementId, match_number: matchNumber || 1, total_matches: ranked.length };
}

function chooseScannedMatch(scanned, wanted) {
  const ambiguous = scanned.filter((frame) => frame.result?.ambiguous);
  if (ambiguous.length) {
    const details = ambiguous.flatMap(({ frameId, result }) =>
      (result.candidates || []).map((candidate) =>
        `№${candidate.match_number} (frame_id=${frameId}, сверху ${candidate.top}px): «${candidate.text}»`
      )
    );
    return { ambiguous: true, message: `КЛИК НЕ ВЫПОЛНЕН. ${ambiguous[0].result.error} ${details.join("; ")}. Если пользователь указал верхний контакт, повторите с match_number=1; для выбора по фрейму используйте browser_list_page_elements и browser_click_page_element.` };
  }
  const matches = scanned.filter((frame) => frame.result?.ok);
  if (matches.length > 1) {
    return { ambiguous: true, message: `КЛИК НЕ ВЫПОЛНЕН. «${wanted}» найдено в нескольких фреймах: ${matches.map((frame) => frame.frameId).join(", ")}. Уточните фрейм через browser_list_page_elements(include_frames=True), затем нажмите browser_click_page_element.` };
  }
  if (matches.length === 1) return { match: matches[0] };
  const errors = scanned.map((frame) => frame.result?.error).filter(Boolean);
  return { error: errors.find((error) => /несколько|прерван/.test(error)) || errors[0] || `Не нашёл кликабельный элемент «${wanted}».` };
}

function clickMarkedElement(mode, elementId, expectedText, deadlineMs, matchedText = "") {
  const marker = mode === "scan"
    ? `${document.documentElement.dataset.astraBrowserControlScan || ""}:${elementId}`
    : String(elementId);
  const attribute = mode === "scan" ? "data-astra-browser-control-id" : "data-astra-browser-control-match";
  const el = marker ? document.querySelector(`[${attribute}="${marker}"]`) : null;
  if (!el) return { ok: false, error: "Элемент страницы изменился. Найдите его заново." };
  const label = mode === "scan"
    ? (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent || "")
    : (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "");
  const text = label.replace(/\s+/g, " ").trim().slice(0, mode === "scan" ? 240 : 160);
  if (mode === "scan") {
    const originalText = el.getAttribute("data-astra-browser-control-text");
    if (!originalText || text !== originalText) return { ok: false, error: "Текст элемента изменился. Найдите его заново." };
  } else if (text !== expectedText) {
    return { ok: false, error: "Текст элемента изменился. Найдите его заново." };
  }
  // VK Messenger exposes each conversation as one button row. Click that row itself,
  // not the nested title/avatar node, so React receives the expected button target.
  const vkConversation = el.closest('button[data-testid="vkme_convo_list_item"].ConvoListItem--click');
  const clickTarget = vkConversation || el;
  if (clickTarget.disabled || clickTarget.getAttribute("aria-disabled") === "true") {
    return { ok: false, error: "Найденный элемент больше не доступен. Найдите его заново." };
  }
  clickTarget.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
  if (!clickTarget.isConnected) return { ok: false, error: "Элемент изменился во время прокрутки. Обновите список." };
  const style = getComputedStyle(clickTarget);
  const rect = clickTarget.getBoundingClientRect();
  if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) {
    return { ok: false, error: "Найденный элемент больше не виден. Обновите список." };
  }
  let point = rect;
  if (mode === "match" && matchedText) {
    const normalize = (value) => String(value || "").normalize("NFKC").replace(/ё/gi, "е").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const wanted = normalize(matchedText);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), count = 0; node && count < 250; node = walker.nextNode(), count++) {
      if (!normalize(node.nodeValue).includes(wanted)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const textRect = [...range.getClientRects()].find((part) => part.width > 0 && part.height > 0);
      if (textRect) point = textRect;
      break;
    }
  }
  const x = Math.max(0, Math.min(innerWidth - 1, point.left + point.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, point.top + point.height / 2));
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== clickTarget && !clickTarget.contains(hit))) {
    return { ok: false, error: "Элемент перекрыт другим элементом страницы. Нажатие не выполнено." };
  }
  if (deadlineMs && Date.now() >= deadlineMs) return { ok: false, error: "Время выполнения истекло; клик не выполнен." };
  if (typeof clickTarget.click === "function") clickTarget.click();
  else clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  return {
    ok: true,
    text,
    marker,
    target: vkConversation ? "vk_conversation_row" : clickTarget.tagName.toLowerCase(),
    peer_id: vkConversation?.getAttribute("data-peer-id") || ""
  };
}

function observePageOpenState(mode, elementId, label = "", targetPeerId = "") {
  const marker = mode === "scan"
    ? `${document.documentElement.dataset.astraBrowserControlScan || ""}:${elementId}`
    : String(elementId);
  const attribute = mode === "scan" ? "data-astra-browser-control-id" : "data-astra-browser-control-match";
  const el = marker ? document.querySelector(`[${attribute}="${marker}"]`) : null;
  const selected = (candidate) => Boolean(candidate && (
    candidate.getAttribute("aria-selected") === "true" ||
    candidate.hasAttribute("aria-current") ||
    candidate.getAttribute("aria-expanded") === "true" ||
    /(?:^|\s|--)(?:active|selected|current|open)(?:$|\s|--)/i.test(String(candidate.className || ""))
  ));
  const vkConversation = el?.closest('[data-testid="vkme_convo_list_item"]') ||
    (targetPeerId ? [...document.querySelectorAll('[data-testid="vkme_convo_list_item"]')].find((item) => item.getAttribute("data-peer-id") === String(targetPeerId)) : null);
  const anchor = el?.closest("a[href]");
  const headings = [...document.querySelectorAll("h1,h2,h3,[role='heading'],[role='dialog']")]
    .filter((candidate) => !el?.contains(candidate) && candidate.getClientRects().length > 0)
    .map((candidate) => (candidate.textContent || "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length >= 3 && value.length <= 180)
    .slice(0, 40);
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/ё/gi, "е").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const targetWords = normalize(label).match(/\p{L}+/gu)?.slice(0, 2) || [];
  const target = targetWords.join(" ");
  let targetMentions = 0;
  if (target) {
    const started = performance.now();
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(), count = 0; node && count < 12000; node = walker.nextNode(), count++) {
      if (performance.now() - started > 200) break;
      if (!normalize(node.nodeValue).includes(target)) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0) targetMentions++;
    }
  }
  return {
    url: location.href,
    title: document.title || "",
    headings,
    target_mentions: targetMentions,
    target_selected: selected(el) || selected(el?.parentElement) || selected(vkConversation),
    target_peer_id: vkConversation?.getAttribute("data-peer-id") || "",
    target_href: anchor?.href || "",
    target_link_target: anchor?.target || "",
    target_is_anchor: Boolean(anchor && (anchor === el || anchor.contains(el)))
  };
}

async function readPageOpenState(tabId, frameId, mode, elementId, deadlineMs = 0, label = "", targetPeerId = "") {
  const waitMs = Math.min(1000, deadlineMs ? deadlineMs - Date.now() - 400 : 1000);
  if (waitMs <= 0) return null;
  let timer;
  try {
    const injected = await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        args: [mode, elementId, label, targetPeerId],
        func: observePageOpenState
      }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })
    ]);
    return injected?.[0]?.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readTabUrl(tabId, deadlineMs = 0) {
  const waitMs = Math.min(500, deadlineMs ? deadlineMs - Date.now() - 400 : 500);
  if (waitMs <= 0) return "";
  let timer;
  try {
    const tab = await Promise.race([
      chrome.tabs.get(tabId),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); })
    ]);
    return tab?.url || "";
  } catch (_) {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function verifyOpenedElement(tabId, frameId, mode, elementId, label, before, deadlineMs, targetPeerId = "") {
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/ё/gi, "е").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const targetWords = normalize(label).match(/\p{L}+/gu)?.slice(0, 2) || [];
  const matchesTarget = (value) => targetWords.length > 0 && targetWords.every((word) => normalize(value).includes(word));
  let navigation = false;
  let selection = false;
  for (const delay of [300, 600, 1100]) {
    if (deadlineMs && Date.now() + delay >= deadlineMs) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
    const after = await readPageOpenState(tabId, frameId, mode, elementId, deadlineMs, label, targetPeerId);
    if (before && after) {
      if (!before.target_selected && after.target_selected) {
        selection = true;
        if (targetPeerId) return { confirmed: true, evidence: `Строка диалога ВК с peer_id=${targetPeerId} стала активной.` };
      }
      const newHeading = after.headings.find((heading) =>
        matchesTarget(heading) &&
        after.headings.filter((value) => value === heading).length > before.headings.filter((value) => value === heading).length
      );
      if (newHeading) return { confirmed: true, evidence: `Появился заголовок «${newHeading}».` };
      if (after.target_mentions > before.target_mentions) {
        return { confirmed: true, evidence: `Число видимых упоминаний выбранного текста выросло с ${before.target_mentions} до ${after.target_mentions}.` };
      }
      if (/^https?:\/\//i.test(before.target_href || "") && before.target_href !== before.url && after.url === before.target_href) {
        return { confirmed: true, evidence: `Браузер перешёл по адресу выбранной ссылки: ${after.url}` };
      }
      if (after.url !== before.url) navigation = true;
    }
    const currentUrl = await readTabUrl(tabId, deadlineMs);
    if (/^https?:\/\//i.test(before?.target_href || "") && before.target_href !== before.url && currentUrl === before.target_href) {
      return { confirmed: true, evidence: `Браузер перешёл по адресу выбранной ссылки: ${currentUrl}` };
    }
    if (currentUrl && before?.url && currentUrl !== before.url) navigation = true;
  }
  return selection
    ? { confirmed: false, navigation, evidence: "Выбранный элемент стал активным, но содержимое не удалось подтвердить." }
    : navigation
    ? { confirmed: false, navigation, evidence: "Адрес изменился, но открытие именно выбранного элемента не подтверждено." }
    : { confirmed: false, navigation, evidence: "Открытие выбранного элемента не подтверждено изменением страницы." };
}

async function fallbackAnchorNavigation(tabId, before, verification, deadlineMs) {
  const href = before?.target_href || "";
  const target = before?.target_link_target || "";
  if (!before?.target_is_anchor || !/^https?:\/\//i.test(href) || href === before.url ||
      (target && target !== "_self") || verification.confirmed || verification.navigation) return null;
  const currentUrl = await readTabUrl(tabId, deadlineMs);
  if (!currentUrl || currentUrl !== before.url || (deadlineMs && Date.now() >= deadlineMs)) return null;
  try {
    const updated = await chrome.tabs.update(tabId, { url: href });
    let landedUrl = updated?.url || "";
    const sameDestination = (left, right) => {
      try {
        const a = new URL(left);
        const b = new URL(right);
        return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
      } catch (_) {
        return left === right;
      }
    };
    for (const delay of [120, 240, 400, 600]) {
      if (landedUrl && sameDestination(landedUrl, href)) break;
      if (deadlineMs && Date.now() + delay + 500 >= deadlineMs) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
      landedUrl = await readTabUrl(tabId, deadlineMs);
    }
    if (landedUrl && sameDestination(landedUrl, href)) {
      return { confirmed: true, navigation: true, evidence: `Обычный клик не сменил страницу; браузер перешёл по адресу выбранной ссылки: ${landedUrl}` };
    }
    return { confirmed: false, navigation: Boolean(landedUrl && landedUrl !== before.url), evidence: `Переход по адресу ссылки был запрошен, но браузер не подтвердил его: ${href}` };
  } catch (_) {
    return null;
  }
}

function describeClickResult(verification) {
  return verification.confirmed
    ? `После клика обнаружено связанное изменение страницы: ${verification.evidence} Проверьте содержимое страницы, прежде чем утверждать, что нужный чат или раздел открыт.`
    : `ОТКРЫТИЕ НЕ ПОДТВЕРЖДЕНО. ${verification.evidence} Не утверждайте, что чат или раздел открыт, и не повторяйте клик без проверки страницы.`;
}

async function handleCommand(message) {
  const action = message.action;
  const deadlineMs = Number(message.deadline_ms) || 0;
  const requireTime = () => {
    if (deadlineMs && Date.now() >= deadlineMs) throw new Error("Время выполнения истекло; действие не выполнено.");
  };
  if (action === "ping") return { ok: true, message: "Связь работает" };
  if (action === "navigate") {
    const url = String(message.url || "");
    if (!/^https?:\/\//i.test(url) || url.length > 2048) throw new Error("Разрешены только адреса http и https");
    await chrome.tabs.create({ url, active: true });
    return { ok: true, message: `Открыл ${url} в новой вкладке` };
  }
  if (action === "list_tabs") {
    const tabs = await orderedTabs();
    const windowNumbers = new Map();
    for (const tab of tabs) {
      if (!windowNumbers.has(tab.windowId)) windowNumbers.set(tab.windowId, windowNumbers.size + 1);
    }
    const tabNumbers = new Map();
    return {
      ok: true,
      tabs: tabs.map((tab, index) => {
        const window = windowNumbers.get(tab.windowId);
        const tab_in_window = (tabNumbers.get(tab.windowId) || 0) + 1;
        tabNumbers.set(tab.windowId, tab_in_window);
        return { id: tab.id, number: index + 1, window, tab_in_window, title: sensitiveUrl(tab.url) ? "Защищённая страница" : (tab.title || "Без названия").slice(0, 180), url: tab.url || "", active: Boolean(tab.active), audible: Boolean(tab.audible), muted: Boolean(tab.mutedInfo?.muted) };
      })
    };
  }
  if (action === "find_and_open_text") {
    const wanted = String(message.text || "").trim();
    if (!wanted || wanted.length > 200) throw new Error("Укажите текст элемента, который нужно открыть");
    const matchNumber = Number(message.match_number ?? 0);
    if (!Number.isInteger(matchNumber) || matchNumber < 0 || matchNumber > 20) throw new Error("match_number должен быть от 0 до 20");
    const tabs = await orderedTabs();
    const requestedNumber = Number(message.tab_number) || 0;
    let sourceTab;
    let selection;
    if (requestedNumber > 0) {
      sourceTab = tabs[requestedNumber - 1];
      if (!sourceTab) throw new Error(`Вкладка №${requestedNumber} не найдена. Обновите список вкладок.`);
      selection = "указанной";
    } else {
      sourceTab = await currentActiveTab();
      selection = "активной";
    }
    requireWebTab(sourceTab);
    await blockSensitivePage(sourceTab.id, sourceTab.url);
    const scanned = await chrome.scripting.executeScript({
      target: { tabId: sourceTab.id, allFrames: true },
      args: [wanted, matchNumber],
      func: inspectClickableText
    });
    const choice = chooseScannedMatch(scanned, wanted);
    if (choice.ambiguous) return { ok: true, clicked: false, ambiguous: true, message: choice.message };
    if (choice.error) throw new Error(choice.error);
    const found = choice.match.result;
    const frameId = choice.match.frameId;
    requireTime();
    const elementId = found.element_id;
    const before = await readPageOpenState(sourceTab.id, frameId, "match", elementId, deadlineMs, found.matched_text || found.text);
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: sourceTab.id, frameIds: [frameId] },
      args: ["match", elementId, found.text, deadlineMs, found.matched_text],
      func: clickMarkedElement
    });
    if (!clicked?.result?.ok) throw new Error(clicked?.result?.error || "Не удалось нажать найденный элемент");
    let verification = await verifyOpenedElement(sourceTab.id, frameId, "match", elementId, found.matched_text || clicked.result.text, before, deadlineMs, clicked.result.peer_id);
    verification = (await fallbackAnchorNavigation(sourceTab.id, before, verification, deadlineMs)) || verification;
    const approximation = found.approximate ? `; надпись близка к запросу «${wanted}»` : "";
    const position = found.total_matches > 1 ? ` (совпадение №${found.match_number} из ${found.total_matches})` : "";
    const outcome = describeClickResult(verification);
    return { ok: true, clicked: true, page_change_confirmed: verification.confirmed, message: `${outcome} Клик отправлен по запросу «${wanted}»${position} на ${selection} вкладке (№${tabs.indexOf(sourceTab) + 1})${approximation}.`, tab_number: tabs.indexOf(sourceTab) + 1, title: sourceTab.title || "" };
  }
  if (action === "activate_tab") {
    const tabs = await orderedTabs();
    const target = tabs[Number(message.tab_id)];
    if (!target || typeof target.id !== "number") throw new Error("Вкладка с таким номером не найдена");
    if (typeof target.windowId === "number") await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.update(target.id, { active: true });
    const windowNumber = [...new Set(tabs.map((tab) => tab.windowId))].indexOf(target.windowId) + 1;
    return { ok: true, message: `Переключился на вкладку ${Number(message.tab_id) + 1}, окно ${windowNumber}` };
  }
  if (action === "close_tab") {
    let target;
    const index = Number(message.tab_id);
    if (index === -1) {
      target = await currentActiveTab();
    } else {
      const tabs = await orderedTabs();
      target = tabs[index];
    }
    if (!target || typeof target.id !== "number") throw new Error("Вкладка с таким номером не найдена");
    await removeTabsAndConfirm([target.id]);
    return { ok: true, message: `Закрыл вкладку «${(target.title || "Без названия").slice(0, 120)}»` };
  }
  if (action === "close_tabs") {
    if (Array.isArray(message.tab_numbers)) {
      const numbers = [...new Set(message.tab_numbers.map(Number))];
      const requestedWindow = Number(message.window_number) || 0;
      if (!numbers.length || numbers.some((number) => !Number.isInteger(number) || number < 1)) throw new Error("Передайте номера вкладок из списка");
      if (!Number.isInteger(requestedWindow) || requestedWindow < 0) throw new Error("Номер окна должен быть 1 или больше");
      const tabs = await orderedTabs();
      const windowNumbers = new Map();
      for (const tab of tabs) {
        if (!windowNumbers.has(tab.windowId)) windowNumbers.set(tab.windowId, windowNumbers.size + 1);
      }
      const targets = numbers.map((number) => tabs[number - 1]);
      if (targets.some((tab) => !tab || typeof tab.id !== "number")) throw new Error("Одна из вкладок уже закрыта или её номер изменился. Сначала обновите список вкладок.");
      if (requestedWindow && targets.some((tab) => windowNumbers.get(tab.windowId) !== requestedWindow)) {
        throw new Error(`Не все указанные вкладки находятся в окне ${requestedWindow}. Обновите список вкладок и проверьте номера.`);
      }
      await removeTabsAndConfirm(targets.map((tab) => tab.id));
      return { ok: true, message: `Закрыл вкладки: ${targets.map((tab, index) => `${numbers[index]} «${(tab.title || "Без названия").slice(0, 80)}»`).join(", ")}${requestedWindow ? ` в окне ${requestedWindow}` : ""}` };
    }
    const indexes = [...new Set((Array.isArray(message.tab_ids) ? message.tab_ids : []).map(Number))];
    if (!indexes.length || indexes.some((index) => !Number.isInteger(index) || index < 0)) throw new Error("Передайте номера вкладок из списка");
    const tabs = await orderedTabs();
    const targets = indexes.map((index) => tabs[index]);
    if (targets.some((tab) => !tab || typeof tab.id !== "number")) throw new Error("Одна из вкладок уже закрыта или её номер изменился. Сначала обновите список вкладок.");
    await removeTabsAndConfirm(targets.map((tab) => tab.id));
    return { ok: true, message: `Закрыл вкладки: ${targets.map((tab, index) => `${indexes[index] + 1} «${(tab.title || "Без названия").slice(0, 80)}»`).join(", ")}` };
  }
  let tab;
  if ((action === "type_text" || action === "clear_text" || action === "find_text_fields" || action === "find_page_text" || action === "click_text" || action === "list_page_elements" || action === "click_page_element") && Number(message.tab_number) > 0) {
    const tabs = await orderedTabs();
    tab = tabs[Number(message.tab_number) - 1];
    if (!tab || typeof tab.id !== "number") throw new Error("Вкладка с таким номером не найдена. Сначала обновите список вкладок.");
  } else {
    tab = await currentActiveTab();
  }
  requireWebTab(tab);
  if (["type_text", "clear_text", "find_text_fields", "find_page_text", "click_text", "list_page_elements", "click_page_element", "read_page"].includes(action)) {
    await blockSensitivePage(tab.id, tab.url);
  }
  if (action === "list_page_elements") {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: Boolean(message.include_frames) },
      args: [String(message.query || "")],
      func: (query) => {
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const needle = normalize(query);
        const selector = "a,button,[role='button'],[role='link'],[role='menuitem'],[role='option'],[tabindex],[onclick]";
        const started = performance.now();
        const styles = new WeakMap();
        const styleOf = (el) => {
          if (!styles.has(el)) styles.set(el, getComputedStyle(el));
          return styles.get(el);
        };
        const candidates = new Set();
        let incomplete = false;
        for (const el of document.querySelectorAll(selector)) {
          if (el.closest("[contenteditable],[role='textbox'],[data-private],[data-sensitive]") || el.querySelector("input,textarea,[contenteditable],[role='textbox']")) continue;
          const label = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
          if (label.length <= 500 && (!needle || normalize(label).includes(needle))) candidates.add(el);
          if (candidates.size >= 600 || performance.now() - started > 1000) { incomplete = true; break; }
        }
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
        let visited = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (++visited > 12000 || performance.now() - started > 1300 || candidates.size >= 800) { incomplete = true; break; }
          const value = node.nodeValue?.trim() || "";
          if (value.length < 2 || value.length > 240 || (needle && !normalize(value).includes(needle))) continue;
          if (node.parentElement?.closest("input,textarea,[contenteditable],[role='textbox'],[data-private],[data-sensitive]")) continue;
          let target = null;
          for (let el = node.parentElement, depth = 0; el && depth < 9; el = el.parentElement, depth++) {
            if (el.matches(selector)) { target = el; break; }
            if (styleOf(el).cursor === "pointer") target = el;
            else if (target) break;
          }
          if (target) candidates.add(target);
        }
        const ordered = [...candidates].sort((left, right) =>
          left === right ? 0 : (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        );
        const elements = [];
        for (const el of ordered) {
          if (el.closest("[contenteditable],[role='textbox'],[data-private],[data-sensitive]") || el.querySelector("input,textarea,[contenteditable],[role='textbox']")) continue;
          if (performance.now() - started > 1800) { incomplete = true; break; }
          const raw = el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "";
          if (!raw || raw.length > 500 || (needle && !normalize(raw).includes(needle))) continue;
          const style = styleOf(el);
          if (style.display === "none" || style.visibility === "hidden") continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const text = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || raw).replace(/\s+/g, " ").trim();
          if (!text || text.length > 500) continue;
          elements.push({ el, text });
          if (elements.length > 120) { incomplete = true; break; }
        }
        const scanId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
        document.documentElement.dataset.astraBrowserControlScan = scanId;
        return { total: elements.length, truncated: incomplete, elements: elements.slice(0, 120).map(({ el, text }, index) => {
          el.setAttribute("data-astra-browser-control-id", `${scanId}:${index + 1}`);
          el.setAttribute("data-astra-browser-control-text", text.slice(0, 240));
          return {
            element_number: index + 1,
            text: text.slice(0, 240),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            href: el instanceof HTMLAnchorElement ? el.href : ""
          };
        }) };
      }
    });
    const frames = injected.flatMap(({ frameId, result }) =>
      (Array.isArray(result?.elements) && (result.elements.length || result.truncated) ? [{ frame_id: frameId, total: result.total, truncated: result.truncated, elements: result.elements }] : [])
    );
    const tabNumber = (await orderedTabs()).findIndex((candidate) => candidate.id === tab.id) + 1;
    return { ok: true, title: tab.title || "", url: tab.url || "", tab_number: tabNumber, frames };
  }
  if (action === "click_page_element") {
    const elementNumber = Number(message.element_number);
    const frameId = Number(message.frame_id);
    const expectedText = String(message.expected_text || "").replace(/\s+/g, " ").trim();
    if (!Number.isInteger(elementNumber) || elementNumber < 1) throw new Error("Укажите номер элемента из browser_list_page_elements");
    if (!Number.isInteger(frameId) || frameId < 0) throw new Error("Укажите frame_id элемента из browser_list_page_elements");
    if (!expectedText) throw new Error("Укажите expected_text из browser_list_page_elements, чтобы проверить, что список не устарел");
    const before = await readPageOpenState(tab.id, frameId, "scan", elementNumber, deadlineMs, expectedText);
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      args: ["scan", elementNumber, expectedText, deadlineMs],
      func: clickMarkedElement
    });
    if (!clicked?.result?.ok) throw new Error(clicked?.result?.error || "Не удалось нажать элемент");
    let verification = await verifyOpenedElement(tab.id, frameId, "scan", elementNumber, expectedText, before, deadlineMs, clicked.result.peer_id);
    verification = (await fallbackAnchorNavigation(tab.id, before, verification, deadlineMs)) || verification;
    const outcome = describeClickResult(verification);
    return { ok: true, clicked: true, page_change_confirmed: verification.confirmed, message: `${outcome} Клик отправлен по выбранному элементу №${elementNumber}.`, title: tab.title || "" };
  }
  if (action === "find_text_fields") {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const visible = (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
        };
        const editable = [...document.querySelectorAll("input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']")]
          .filter((el) => !(el instanceof HTMLInputElement && ["password", "hidden", "file", "button", "submit", "reset", "checkbox", "radio"].includes(el.type)) &&
            (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) && visible(el));
        return editable.map((el, index) => {
          const label = el.labels ? [...el.labels].map((item) => item.innerText.trim()).filter(Boolean).join(" ") : "";
          return {
            field_number: index + 1,
            tag: el.tagName.toLowerCase(),
            type: el instanceof HTMLInputElement ? el.type : (el.isContentEditable ? "contenteditable" : "textarea"),
            label,
            placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || el.getAttribute("data-lexical-placeholder") || "",
            aria_label: el.getAttribute("aria-label") || "",
            name: el.getAttribute("name") || "",
            role: el.getAttribute("role") || "",
            active: el === document.activeElement
          };
        });
      }
    });
    const fields = injected.flatMap(({ frameId, result }) =>
      (Array.isArray(result) ? result : []).map((field) => ({ ...field, frame_id: frameId }))
    );
    return { ok: true, fields };
  }
  if (action === "find_page_text") {
    const query = String(message.query || "").trim();
    if (!query) throw new Error("Укажите слово или фразу для поиска на странице");
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      args: [query],
      func: safePageSnapshot
    });
    if (injected.some(({ result }) => result?.blocked)) throw new Error("Содержимое защищённой страницы не передаётся в Astra.");
    const frames = injected.map(({ frameId, result }) => ({
      frame_id: frameId,
      title: result?.title || "",
      url: result?.url || "",
      matches: result?.matches || [],
      interactive: result?.interactive || []
    }));
    const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const found = frames.some((frame) => Boolean(frame.matches?.length || frame.interactive?.length || normalize(frame.title).includes(normalize(query))));
    return { ok: true, query, found, frames };
  }
  if (action === "read_page") {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: safePageSnapshot
    });
    if (injected?.result?.blocked) throw new Error("Содержимое защищённой страницы не передаётся в Astra.");
    return { ok: true, ...injected.result };
  }
  if (action === "click_text") {
    const wanted = String(message.text || "").trim();
    if (!wanted) throw new Error("Укажите текст видимого элемента, который нужно открыть");
    const matchNumber = Number(message.match_number ?? 0);
    if (!Number.isInteger(matchNumber) || matchNumber < 0 || matchNumber > 20) throw new Error("match_number должен быть от 0 до 20");
    const requestedFrame = Number(message.frame_id);
    const target = { tabId: tab.id };
    if (Number.isInteger(requestedFrame) && requestedFrame >= 0) target.frameIds = [requestedFrame];
    else target.allFrames = true;
    const scanned = await chrome.scripting.executeScript({ target, args: [wanted, matchNumber], func: inspectClickableText });
    const choice = chooseScannedMatch(scanned, wanted);
    if (choice.ambiguous) return { ok: true, clicked: false, ambiguous: true, message: choice.message };
    if (choice.error) throw new Error(choice.error);
    const found = choice.match.result;
    const frameId = choice.match.frameId;
    const elementId = found.element_id;
    const before = await readPageOpenState(tab.id, frameId, "match", elementId, deadlineMs, found.matched_text || found.text);
    const [clicked] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      args: ["match", elementId, found.text, deadlineMs, found.matched_text],
      func: clickMarkedElement
    });
    if (!clicked?.result?.ok) throw new Error(clicked?.result?.error || "Не удалось нажать найденный элемент");
    let verification = await verifyOpenedElement(tab.id, frameId, "match", elementId, found.matched_text || clicked.result.text, before, deadlineMs, clicked.result.peer_id);
    verification = (await fallbackAnchorNavigation(tab.id, before, verification, deadlineMs)) || verification;
    const approximation = found.approximate ? `; надпись близка к запросу «${wanted}»` : "";
    const position = found.total_matches > 1 ? ` (совпадение №${found.match_number} из ${found.total_matches})` : "";
    const outcome = describeClickResult(verification);
    return { ok: true, clicked: true, page_change_confirmed: verification.confirmed, message: `${outcome} Клик отправлен по запросу «${wanted}»${position}${approximation}.` };
  }
  if (action === "type_text" || action === "clear_text") {
    const target = { tabId: tab.id };
    if (Number.isInteger(Number(message.frame_id)) && Number(message.frame_id) >= 0) {
      target.frameIds = [Number(message.frame_id)];
    }
    const [injected] = await chrome.scripting.executeScript({
      target,
      args: [String(message.text || ""), String(message.field || ""), Number(message.field_number) || 0, action === "clear_text"],
      func: (text, wantedField, fieldNumber, clear) => {
        const normalize = (value) => (value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const field = normalize(wantedField);
        const isEditable = (el) => {
          if (el instanceof HTMLInputElement) return !["password", "hidden", "file", "button", "submit", "reset", "checkbox", "radio"].includes(el.type);
          return el instanceof HTMLTextAreaElement || el.isContentEditable;
        };
        const labelOf = (el) => {
          const labels = el.labels ? [...el.labels].map((label) => label.innerText).join(" ") : "";
          return [labels, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("data-placeholder"), el.getAttribute("data-lexical-placeholder"), el.getAttribute("name"), el.getAttribute("title")].filter(Boolean).join(" ");
        };
        const visible = (el) => {
          const style = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
        };
        const currentText = (el) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : (el.innerText || el.textContent || "")).replace(/\u00a0/g, " ").trim();
        let el = document.activeElement;
        if (field || fieldNumber > 0) {
          const candidates = [...document.querySelectorAll("input,textarea,[contenteditable]:not([contenteditable='false']),[role='textbox']")].filter((item) => isEditable(item) && visible(item));
          if (fieldNumber > 0) {
            if (fieldNumber > candidates.length) return { ok: false, error: "Номер поля устарел. Найдите поля ввода ещё раз." };
            el = candidates[fieldNumber - 1];
          } else {
          const exact = candidates.filter((item) => normalize(labelOf(item)) === field);
          const matches = exact.length ? exact : candidates.filter((item) => normalize(labelOf(item)).includes(field));
          if (matches.length > 1) return { ok: false, error: `Нашёл несколько полей «${wantedField}». Уточните подпись или placeholder.` };
          if (!matches.length) return { ok: false, error: `Не нашёл доступное текстовое поле «${wantedField}» на странице.` };
          el = matches[0];
          }
        }
        if (!el || !isEditable(el) || !visible(el)) return { ok: false, error: "Укажите field (подпись/placeholder) или сначала выберите текстовое поле. Поля пароля не поддерживаются." };
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const start = clear ? 0 : (el.selectionStart ?? el.value.length);
          const end = clear ? el.value.length : (el.selectionEnd ?? start);
          const value = clear ? "" : el.value.slice(0, start) + text + el.value.slice(end);
          const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          const caret = clear ? 0 : start + text.length;
          try { el.setSelectionRange(caret, caret); } catch (_) {}
        } else {
          if (clear) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
            const deleted = document.execCommand("delete");
            if (!deleted) el.textContent = "";
          } else {
            const inserted = document.execCommand("insertText", false, text);
            if (!inserted) return { ok: false, error: "Не удалось вставить текст в это поле страницы." };
          }
        }
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: clear ? "deleteContentBackward" : "insertText", data: clear ? null : text }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (clear) {
          const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 120));
          return waitForRender().then(() => {
            if (currentText(el).length !== 0) {
              // Some controlled contenteditable editors restore their previous state after the first input event.
              if (el.isContentEditable) {
                el.focus();
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(el);
                selection.removeAllRanges();
                selection.addRange(range);
                document.execCommand("delete");
                el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                if (setter) setter.call(el, "");
                else el.value = "";
                el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
              }
              return waitForRender();
            }
            return undefined;
          }).then(() => currentText(el).length === 0
            ? { ok: true, message: "Поле проверено после обновления страницы: текста больше нет." }
            : { ok: false, error: "Редактор восстановил текст после очистки. Поле не пустое; очистка не подтверждена." });
        }
        return { ok: true, message: `Введено ${text.length} символов` };
      }
    });
    return injected.result;
  }
  if (action === "scroll_page") {
    const direction = message.direction === "up" ? -1 : 1;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [direction], func: (dir) => window.scrollBy({ top: dir * Math.max(300, window.innerHeight * 0.7), behavior: "smooth" }) });
    return { ok: true, message: direction > 0 ? "Прокрутил страницу вниз" : "Прокрутил страницу вверх" };
  }
  throw new Error("Неизвестное действие браузера");
}

function startKeepalive() {
  chrome.alarms.create("native-host-keepalive", { periodInMinutes: 0.5 });
  connectNative();
}

chrome.runtime.onInstalled.addListener(startKeepalive);
chrome.runtime.onStartup.addListener(startKeepalive);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) {
    if (!nativePort) attemptReconnect(true);
  } else if (alarm.name === "native-host-keepalive") {
    if (!nativePort) connectNative();
    else if (!nativeReady) scheduleReconnect();
    else nativePort.postMessage({ type: "ping" });
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "get-status") {
    chrome.storage.local.get(["nativeReady", "nativeError"], (state) => {
      browserLabel().then((browser) => sendResponse({ connected: Boolean(state.nativeReady), error: state.nativeError || "", browser: browser.name }));
    });
    return true;
  }
  if (message?.type === "reconnect") {
    clearReconnectSchedule();
    if (nativePort) {
      const previousPort = nativePort;
      nativePort = null;
      expectedDisconnects.add(previousPort);
      previousPort.disconnect();
    }
    const started = connectNative();
    sendResponse({ started });
    return false;
  }
});

startKeepalive();
