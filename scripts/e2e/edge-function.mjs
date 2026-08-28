/**
 * Loads the REAL `supabase/functions/share-preview/index.ts` into Node so the
 * acceptance runs exercise the deployed source instead of a hand-written copy
 * that would quietly drift out of date.
 *
 * The function targets Deno, so it is transpiled with the TypeScript already in
 * devDependencies and imported against a two-method `Deno` shim (`env.get` and
 * `serve`). Nothing else about it is stubbed — the routing, the RPC call, the
 * HTML and the escaping are the shipped ones.
 */
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { createRequire } from "node:module";

// tmpdir 裡的 bare specifier 解析不到本 repo 的 node_modules：把
// supabase-js 換成絕對 file URL。
const localRequire = createRequire(import.meta.url);
const SUPABASE_JS_URL = pathToFileURL(localRequire.resolve("@supabase/supabase-js")).href;

const FN_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "supabase",
  "functions",
  "share-preview",
  "index.ts",
);

/**
 * @returns {Promise<(req: Request) => Promise<Response>>} the function's handler
 */
/**
 * 通用版：載入任一 supabase/functions/<name>/index.ts（同一 Deno shim）。
 * env 由呼叫端整包給 — cutos-bridge 之類的函式各自有自己的變數。
 */
export async function loadEdgeHandler(name, env) {
  let source = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "functions", name, "index.ts"),
    "utf8",
  );
  // Deno 的 https import 在 Node ESM 走不動：supabase-js 換成 devDependency
  // 的同一套件（版本語意一致，程式碼不變）。
  source = source.replace(/from "https:\/\/esm\.sh\/@supabase\/supabase-js@[^"]+"/g, 'from "' + SUPABASE_JS_URL + '"');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "index.ts",
  }).outputText;
  const dir = await mkdtemp(join(tmpdir(), "duigao-fn-"));
  const file = join(dir, name + ".mjs");
  await writeFile(file, js, "utf8");
  let handler = null;
  globalThis.Deno = {
    env: { get: (key) => env[key] },
    serve: (fn) => {
      handler = fn;
      return { finished: Promise.resolve() };
    },
  };
  // Node 20（CI）沒有全域 WebSocket；supabase-js 的 realtime 在建立
  // client 時偵測不到會直接 throw。bridge 從不開 realtime — 給一個
  // 「存在但不能用」的 stub 滿足偵測即可（Node 22+ 原生存在，跳過）。
  if (!globalThis.WebSocket) {
    globalThis.WebSocket = class WebSocketStub {
      constructor() {
        throw new Error("harness: realtime websocket not supported");
      }
    };
  }
  await import(pathToFileURL(file).href);
  if (!handler) throw new Error(name + " did not register a handler");
  return handler;
}

export async function loadSharePreviewHandler({ supabaseUrl, anonKey, appOrigin }) {
  const source = await readFile(FN_SOURCE, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "index.ts",
  }).outputText;

  // A fresh directory per load keeps the module registry from serving a copy
  // that captured a previous set of env values at evaluation time.
  const dir = await mkdtemp(join(tmpdir(), "duigao-fn-"));
  const file = join(dir, "share-preview.mjs");
  await writeFile(file, js, "utf8");

  let handler = null;
  const env = { SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: anonKey, APP_ORIGIN: appOrigin };
  globalThis.Deno = {
    env: { get: (key) => env[key] },
    serve: (fn) => {
      handler = fn;
      return { finished: Promise.resolve() };
    },
  };
  await import(pathToFileURL(file).href);
  if (!handler) throw new Error("share-preview did not register a handler");
  return handler;
}

/** Bridge a Node req/res pair onto a fetch-style handler. */
export async function serveHandler(handler, req, res, origin) {
  const headers = [];
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.push([k, v]);
  }
  // POST 函式（cutos-bridge）需要 body；share-preview 的 GET/HEAD 不受影響。
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  const out = await handler(new Request(`${origin}${req.url}`, { method: req.method, headers, ...(body && body.length ? { body } : {}) }));
  const outBody = req.method === "HEAD" ? "" : await out.text();
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  res.end(outBody);
}
