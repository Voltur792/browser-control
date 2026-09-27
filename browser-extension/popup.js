const $ = (id) => document.getElementById(id);

function render(state) {
  $("browser").textContent = state.browser || "Chromium-based browser";
  $("state").textContent = state.connected ? "Связь установлена" : "Нет связи с Astra";
  $("detail").textContent = state.connected ? "Плагин готов принимать команды" : (state.error || "Запустите Astra и проверьте установку Native Host");
  $("dot").className = `dot ${state.connected ? "ok" : "error"}`;
}

function refresh() {
  chrome.runtime.sendMessage({ type: "get-status" }, (state) => {
    if (chrome.runtime.lastError) render({ connected: false, error: chrome.runtime.lastError.message });
    else render(state || { connected: false, error: "Фоновая служба расширения не ответила" });
  });
}

$("reconnect").addEventListener("click", () => {
  const button = $("reconnect");
  button.disabled = true;
  chrome.runtime.sendMessage({ type: "reconnect" }, () => {
    setTimeout(() => { button.disabled = false; refresh(); }, 1200);
  });
});

refresh();
setInterval(refresh, 2500);
