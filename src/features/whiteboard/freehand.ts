/**
 * Freehand 筆畫幾何（WB03）— 純函式，無 DOM。
 *
 * 資料模型（0026）：node_type='freehand'，content.points 是**相對節點左上**
 * 的 [x,y][]（節點 x/y/width/height 是筆畫外接框＋pad）。搬動節點＝搬筆畫，
 * 不用重寫每個點；undo/redo 走既有 x/y mask。
 */
export type StrokePoint = { x: number; y: number; pressure?: number };

/** 抽點：與上一保留點距離 < minDist 的點丟棄（觸控抖動不進資料）。首尾必留。 */
export function thinStroke(points: StrokePoint[], minDist = 3): StrokePoint[] {
  if (points.length <= 2) return points.slice();
  const out: StrokePoint[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = out[out.length - 1];
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) >= minDist) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

export type NormalizedStroke = {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 相對節點左上的點（含 pad 位移），存進 content.points。 */
  points: [number, number][];
  /** 每個點的筆壓（WB05；沒有壓感的輸入是空陣列）。 */
  pressures: number[];
};

const STROKE_PAD = 8;
const MIN_SIZE = 24;
/** DB CHECK（0014）：width/height ≤ 2000 — 超界的筆畫等比縮到框內，
 *  否則本地樂觀節點進得去、雲端 insert 被 CHECK 打回（永久 400）。 */
const MAX_SIZE = 2000;

/** 世界座標筆畫 → 節點框＋相對點。少於 2 點（誤觸）回 null。 */
export function normalizeStroke(points: StrokePoint[], pad = STROKE_PAD): NormalizedStroke | null {
  if (points.length < 2) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const rawW = maxX - minX + pad * 2;
  const rawH = maxY - minY + pad * 2;
  const scale = Math.min(1, MAX_SIZE / rawW, MAX_SIZE / rawH);
  const x = minX - pad;
  const y = minY - pad;
  // clamp 在**乘回之後**（S7）：rawW * (MAX_SIZE / rawW) 的浮點回程可能
  // 得 2000.0000000000002 — DB CHECK 是 <= 2000，差 1 ulp 就永久 400、
  // 失敗寫入還會進 IndexedDB 重試佇列反覆重放。
  return {
    x,
    y,
    width: Math.min(MAX_SIZE, Math.max(MIN_SIZE, rawW * scale)),
    height: Math.min(MAX_SIZE, Math.max(MIN_SIZE, rawH * scale)),
    points: points.map((point) => [(point.x - x) * scale, (point.y - y) * scale]),
    pressures: points.some((point) => typeof point.pressure === "number")
      ? points.map((point) => (typeof point.pressure === "number" ? point.pressure : 0.5))
      : [],
  };
}

/** 相對點 → SVG path d（折線；點少時仍畫得出一小段）。 */
export function strokePath(points: [number, number][]): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return `M ${first[0]} ${first[1]}` + rest.map(([px, py]) => ` L ${px} ${py}`).join("");
}

/** content.pressures 的防禦性讀取（長度對不上就當作沒有壓感）。 */
export function readStrokePressures(value: unknown, pointCount: number): number[] {
  if (!Array.isArray(value) || value.length !== pointCount) return [];
  const out: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return [];
    out.push(item);
  }
  return out;
}

/** content.points 的防禦性讀取（DB 來的 jsonb 什麼形狀都可能）。 */
export function readStrokePoints(value: unknown): [number, number][] {
  if (!Array.isArray(value)) return [];
  const out: [number, number][] = [];
  for (const item of value) {
    if (Array.isArray(item) && item.length >= 2 && typeof item[0] === "number" && typeof item[1] === "number" && Number.isFinite(item[0]) && Number.isFinite(item[1])) {
      out.push([item[0], item[1]]);
    }
  }
  return out;
}
