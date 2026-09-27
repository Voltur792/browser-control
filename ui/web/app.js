const browserLabels = {
  default: "По умолчанию", yandex: "Яндекс Браузер", chrome: "Google Chrome",
  edge: "Microsoft Edge", brave: "Brave", opera: "Opera", vivaldi: "Vivaldi", firefox: "Firefox"
};
const extensionUrls = {
  yandex: "browser://extensions/", chrome: "chrome://extensions/", edge: "edge://extensions/",
  brave: "brave://extensions/", opera: "opera:extensions", vivaldi: "vivaldi://extensions/"
};
const state = { mode: "simple", browser: "default" };
const $ = (id) => document.getElementById(id);

async function callBackend(method, params = {}) {
  if (!window.astra?.callBackend) throw new Error("Откройте эту страницу из окна Astra");
  return window.astra.callBackend(method, params);
}

function showFeedback(message = "", error = false) {
  const node = $("feedback");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function renderSettings() {
  document.querySelectorAll(".mode-option").forEach((button) => {
    const selected = button.dataset.mode === state.mode;
    button.setAttribute("aria-pressed", String(selected));
  });
  $("browser-current").textContent = browserLabels[state.browser] || browserLabels.default;
  $("extensions-url").value = extensionUrls[state.browser] || extensionUrls.yandex;
  document.querySelectorAll("[data-browser]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.browser === state.browser)));
  const advanced = state.mode === "extension";
  const firefox = document.querySelector('[data-browser="firefox"]');
  firefox.disabled = advanced;
  firefox.title = advanced ? "Firefox доступен только в базовом режиме" : "";
  $("extension-guide").hidden = !advanced;
  document.querySelectorAll(".advanced-example").forEach((node) => node.hidden = !advanced);
  $("mode-hint").textContent = advanced
    ? "С расширением можно работать с активной страницей и вкладками:"
    : "Скажите одну из команд, чтобы проверить работу:";
}

function paintDot(id, good, warn) {
  const dot = $(id);
  dot.classList.toggle("is-connected", good);
  dot.classList.toggle("is-error", warn);
}

function renderConnection(status) {
  const pluginReady = Boolean(status.plugin_ready);
  paintDot("plugin-dot", pluginReady, !pluginReady);
  $("plugin-title").textContent = pluginReady ? "Плагин Astra работает" : "Плагин Astra не отвечает";

  const connected = Boolean(status.connected);
  const required = status.mode === "extension";
  const mismatch = required && connected && status.browser_matches === false;
  paintDot("extension-dot", connected && !mismatch, (required && !connected) || mismatch);
  $("extension-title").textContent = mismatch
    ? `Подключён ${status.browser || "другой браузер"}`
    : connected ? "Связь с расширением установлена" : required ? "Расширение не подключено" : "Расширение не подключено";
  const selectedBrowser = browserLabels[status.preferred_browser] || browserLabels[state.browser];
  const visibleBrowser = selectedBrowser !== browserLabels.default ? selectedBrowser : connected ? status.browser : selectedBrowser;
  $("browser-current").textContent = visibleBrowser || browserLabels.default;
}

async function refreshStatus() {
  try {
    const status = await callBackend("browser_get_status");
    if (status.mode && state.mode !== status.mode) state.mode = status.mode;
    if (status.preferred_browser && state.browser !== status.preferred_browser) state.browser = status.preferred_browser;
    renderSettings();
    renderConnection(status);
  } catch (error) {
    renderConnection({ connected: false, plugin_ready: false, mode: state.mode });
    showFeedback(String(error.message || error), true);
  }
}

async function saveSettings() {
  try {
    const response = await callBackend("browser_set_settings", { mode: state.mode, browser: state.browser });
    if (!response?.ok) throw new Error(response?.error || "Не удалось сохранить настройки");
    showFeedback("Настройки сохранены.");
    renderSettings();
  } catch (error) {
    showFeedback(String(error.message || error), true);
  }
}

document.querySelectorAll(".mode-option").forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    renderSettings();
    saveSettings();
  });
});

$("browser-trigger").addEventListener("click", () => {
  const options = $("browser-options");
  options.hidden = !options.hidden;
  $("browser-trigger").setAttribute("aria-expanded", String(!options.hidden));
  if (!options.hidden) options.querySelector("button")?.focus();
});
document.querySelectorAll("[data-browser]").forEach((button) => {
  button.addEventListener("click", () => {
    state.browser = button.dataset.browser;
    $("browser-options").hidden = true;
    $("browser-trigger").setAttribute("aria-expanded", "false");
    $("browser-trigger").focus();
    renderSettings();
    saveSettings();
  });
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".browser-picker")) {
    $("browser-options").hidden = true;
    $("browser-trigger").setAttribute("aria-expanded", "false");
  }
});

$("test-connection").addEventListener("click", async () => {
  const button = $("test-connection");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  showFeedback("Проверяю локальный мост…");
  try {
    const result = await callBackend("browser_test_connection");
    renderConnection(result);
    showFeedback(result.ok ? "Связь проверена." : (result.error || "Расширение не ответило"), !result.ok);
  } catch (error) {
    showFeedback(String(error.message || error), true);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
});

$("open-folder").addEventListener("click", async () => {
  try {
    const result = await callBackend("browser_open_extension_folder");
    if (!result.ok) throw new Error(result.error || "Не удалось открыть папку расширения");
    showFeedback("Открыл папку расширения в Проводнике.");
  } catch (error) {
    showFeedback(String(error.message || error), true);
  }
});

$("install-extension").addEventListener("click", async () => {
  const button = $("install-extension");
  button.disabled = true;
  try {
    const result = await callBackend("browser_install_extension", { browser: state.browser });
    if (!result.ok) throw new Error(result.error || "Не удалось запустить установщик");
    showFeedback(result.message || "Установщик запущен.");
  } catch (error) {
    showFeedback(String(error.message || error), true);
  } finally {
    button.disabled = false;
  }
});

$("copy-extensions-url").addEventListener("click", async () => {
  const input = $("extensions-url");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(input.value);
    } else {
      input.select();
      if (!document.execCommand("copy")) throw new Error("Копирование недоступно");
    }
    showFeedback("Адрес скопирован. Вставьте его в адресную строку браузера и нажмите Enter.");
  } catch (error) {
    input.focus();
    input.select();
    showFeedback("Скопируйте выделенный адрес сочетанием Ctrl+C и вставьте его в браузере.");
  }
});

refreshStatus();
setInterval(refreshStatus, 5000);
