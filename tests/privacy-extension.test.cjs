const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const background = fs.readFileSync(path.join(__dirname, "..", "browser-extension", "background.js"), "utf8");
const start = background.indexOf("function publicSite(");
const end = background.indexOf("function sensitiveUrl(");
assert.ok(start >= 0 && end > start, "privacy functions must exist in background.js");
const context = { URL };
vm.runInNewContext(`${background.slice(start, end)}\nglobalThis.sanitizeResult = sanitizeResult;`, context);
const pickStart = background.indexOf("function pickMedia(");
const pickEnd = background.indexOf("// end pickMedia");
assert.ok(pickStart >= 0 && pickEnd > pickStart, "pickMedia must exist in background.js");
vm.runInNewContext(`${background.slice(pickStart, pickEnd)}\nglobalThis.pickMedia = pickMedia;`, context);

test("media matching tolerates Russian word endings and filler words", () => {
  const items = [
    { title: "Новости дня", shorts: false },
    { title: "Смешные котики 2026 — подборка", shorts: false },
    { title: "Котики в Shorts", shorts: true }
  ];
  const picked = context.pickMedia(items, "включи видео про смешных котиков");
  assert.equal(picked.item.title, "Смешные котики 2026 — подборка");
  assert.equal(context.pickMedia(items, "про футбол"), null);
  assert.equal(context.pickMedia(items, "видео"), null);
});

test("extension filters page secrets before Native Messaging", () => {
  const result = context.sanitizeResult({
    url: "https://example.org/reset?token=raw-token-123456",
    title: "Ваш код подтверждения 123456",
    text: "Пароль:\nsampleSecret\nКарта 4111 1111 1111 1111\nОткрыть чат",
    error: "Код:\nABCD-EFGH",
    frames: [{ href: "https://example.org/pay?card=4111111111111111" }]
  });
  const serialized = JSON.stringify(result);
  for (const secret of ["raw-token", "123456", "sampleSecret", "4111", "ABCD-EFGH"]) {
    assert.ok(!serialized.includes(secret), `${secret} leaked`);
  }
  assert.equal(result.url, "https://example.org");
  assert.equal(result.frames[0].href, "https://example.org");
  assert.ok(result.text.includes("Открыть чат"));
});

test("extension keeps ordinary titles, years and prices readable", () => {
  const result = context.sanitizeResult({
    title: "Visual Studio Code — проект 2026",
    text: "Исходный код на GitHub\nЦена 1 299 ₽\nCode: 4821"
  });
  assert.equal(result.title, "Visual Studio Code — проект 2026");
  assert.ok(result.text.startsWith("Исходный код на GitHub\nЦена 1 299 ₽\n"));
  assert.ok(!JSON.stringify(result).includes("4821"));
});
