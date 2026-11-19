import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
export const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);
const MAX_BODY_BYTES = 64 * 1024;

const INVALID_INPUT = { status: "invalid_input" };
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

class InvalidInput extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new InvalidInput("body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InvalidInput("malformed JSON");
  }
  const text = body !== null && typeof body === "object" && !Array.isArray(body) ? body.text : undefined;
  if (typeof text !== "string" || text.trim() === "") throw new InvalidInput("text must be a non-empty string");
  return text;
}

/**
 * Единственное место, где проверяется ответ модели.
 * Возвращает { topic, draft } или null, если ответ нельзя показывать менеджеру.
 */
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { topic, draft } = data;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft: draft.trim() };
}

/** Вызывает модель с жёстким лимитом; при любом сбое возвращает null. */
async function callModel(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  try {
    // race: даже если провайдер проигнорирует signal, ждём не дольше лимита
    const raw = await Promise.race([classify(text, { signal: controller.signal }), timeout]);
    return parseModelOutput(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ classify = mockClassify, timeoutMs = MODEL_TIMEOUT_MS, html } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html ?? "");
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    let text;
    try {
      text = await readText(request);
    } catch (error) {
      if (error instanceof InvalidInput) return json(response, 400, INVALID_INPUT);
      return json(response, 500, { status: "server_error" });
    }
    const result = await callModel(classify, text, timeoutMs);
    if (!result) return json(response, 200, MANUAL_REVIEW);
    return json(response, 200, { status: "ready", ...result });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const html = await readFile(new URL("./index.html", import.meta.url));
  const port = Number(process.env.PORT || 3000);
  createApp({ html }).listen(port, "127.0.0.1", () => {
    console.log(`Listening on http://127.0.0.1:${port}`);
  });
}
