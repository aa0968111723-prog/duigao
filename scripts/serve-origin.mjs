#!/usr/bin/env node
/**
 * App-origin HTTP server for Zeabur.
 *
 * zbpack `output_dir: dist` makes Zeabur host the Vite SPA with its own
 * Caddy try_files → index.html. That catch-all turns `/functions`, `/api`,
 * and `/rest` into HTTP 200 HTML. This process is the real handler:
 * those prefixes return JSON 404; everything else is SPA fallback.
 *
 * zbpack.json must set start_command (Vite otherwise stays static).
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_ORIGIN_API_PREFIXES = ["/functions", "/api", "/rest"];
export const ORIGIN_API_NOT_FOUND = JSON.stringify({
  ok: false,
  code: "NOT_FOUND",
  message: "this origin has no API",
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

export function isAppOriginApiPath(pathname) {
  const path = (pathname.split("?")[0] || "/") ;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return APP_ORIGIN_API_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function safeFile(root, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = resolve(root, relative);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + "\\") && !resolved.startsWith(rootResolved + "/")) {
    return null;
  }
  return resolved;
}

export function createOriginServer(root) {
  const dist = resolve(root);
  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://origin.invalid").pathname;
    if (isAppOriginApiPath(pathname)) {
      res.writeHead(404, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(ORIGIN_API_NOT_FOUND);
      return;
    }

    const target = safeFile(dist, decodeURIComponent(pathname));
    const tryPaths = target && existsSync(target) ? [target] : [join(dist, "index.html")];
    for (const file of tryPaths) {
      try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch {
        /* next */
      }
    }
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("origin missing dist/index.html");
  });
}

export function listenOrigin({ root, port, host = "0.0.0.0" }) {
  const server = createOriginServer(root);
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

function isDirectRun() {
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "dist");
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  if (!existsSync(join(root, "index.html"))) {
    console.error(`serve-origin: missing ${join(root, "index.html")} — run npm run build first`);
    process.exit(1);
  }
  const server = await listenOrigin({ root, port, host });
  const address = server.address();
  console.log(`serve-origin listening on ${host}:${typeof address === "object" && address ? address.port : port}`);
}
