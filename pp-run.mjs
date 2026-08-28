import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("pp-dist");
const server = http.createServer((req, res) => {
  const p = path.join(dist, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": p.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(5200, r));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1366 } });
const cdp = await page.context().newCDPSession(page);

async function bench(count, pts, pressure, throttle) {
  await page.goto("http://localhost:5200/index.html");
  await page.waitForFunction(() => !!window.__mount);
  const shape = await page.evaluate(([c, p, pr]) => window.__mount(c, p, pr), [count, pts, pressure]);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const res = await page.evaluate(() => {
    for (let i = 0; i < 10; i += 1) window.__pan(1); // warm
    const times = [];
    for (let i = 0; i < 60; i += 1) {
      const t0 = performance.now();
      window.__pan(i % 2 === 0 ? 1 : -1);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[30], p95: times[57], max: times[59] };
  });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  return { shape, ...res };
}

const cases = [
  ["20 nodes x 300pts, PRESSURE (line)", 20, 300, true],
  ["20 nodes x 300pts, NO pressure (path)", 20, 300, false],
  ["20 nodes x 120pts, PRESSURE (line)", 20, 120, true],
  ["60 nodes x 150pts, PRESSURE (line)", 60, 150, true],
  ["60 nodes x 150pts, NO pressure (path)", 60, 150, false],
];
for (const t of [1, 4]) {
  console.log(`\n--- CPU throttle ${t}x ---`);
  for (const [label, c, p, pr] of cases) {
    const r = await bench(c, p, pr, t);
    console.log(`${label.padEnd(42)} ${r.shape.padEnd(14)} median=${r.median.toFixed(2)}ms p95=${r.p95.toFixed(2)}ms max=${r.max.toFixed(2)}ms`);
  }
}
await browser.close();
server.close();
