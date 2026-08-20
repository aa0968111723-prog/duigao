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
  const out = await handler(new Request(`${origin}${req.url}`, { method: req.method, headers }));
  const body = req.method === "HEAD" ? "" : await out.text();
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  res.end(body);
}
