import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, parseModelOutput, MODEL_TIMEOUT_MS } from "../server.mjs";

const MANUAL = { status: "manual_review", topic: null, draft: null };

function start(options) {
  return new Promise((resolve) => {
    const server = createApp(options).listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/api/triage` });
    });
  });
}

async function post(url, body) {
  const reply = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

let app;
before(async () => { app = await start(); }); // реальный mock-ai.mjs
after(() => app.server.close());

test("успех: тема и черновик", async () => {
  const res = await post(app.url, { text: "Когда будет доставка?" });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ready");
  assert.equal(res.body.topic, "delivery");
  assert.ok(res.body.draft.trim().length > 0);

  const pricing = await post(app.url, { text: "Какая стоимость?" });
  assert.equal(pricing.body.topic, "pricing");
});

for (const [name, body] of [
  ["пустая строка", { text: "" }],
  ["только пробелы", { text: "   \n" }],
  ["нет поля text", {}],
  ["text не строка", { text: 42 }],
  ["null вместо объекта", "null"],
  ["массив", "[\"текст\"]"],
  ["битый JSON", "{text:"],
  ["пустое тело", ""],
]) {
  test(`некорректный ввод → 400: ${name}`, async () => {
    const res = await post(app.url, body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { status: "invalid_input" });
  });
}

for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${marker} → manual_review`, async () => {
    const res = await post(app.url, { text: `Доставка ${marker}` });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, MANUAL);
  });
}

test("таймаут модели → manual_review не дольше лимита", async () => {
  const started = Date.now();
  const res = await post(app.url, { text: "Доставка [timeout]" });
  const elapsed = Date.now() - started;
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, MANUAL);
  assert.ok(elapsed < MODEL_TIMEOUT_MS + 400, `ответ занял ${elapsed} мс`);
});

test("провайдер игнорирует AbortSignal → всё равно manual_review по таймауту", async () => {
  const hanging = await start({ classify: () => new Promise(() => {}), timeoutMs: 50 });
  try {
    const res = await post(hanging.url, { text: "Доставка" });
    assert.deepEqual(res.body, MANUAL);
  } finally {
    hanging.server.close();
  }
});

test("parseModelOutput отбрасывает неподходящие ответы", () => {
  assert.deepEqual(parseModelOutput('{"topic":"other","draft":" Ок "}'), { topic: "other", draft: "Ок" });
  for (const raw of [undefined, 1, "", "null", "[]", '{"topic":"other"}', '{"topic":"other","draft":5}',
    '{"topic":"toString","draft":"x"}', '{"topic":"refund","draft":"x"}']) {
    assert.equal(parseModelOutput(raw), null, String(raw));
  }
});
