/**
 * 手勢仲裁狀態機（WB02）— 純函式、零 DOM。
 *
 * 稽核抓到的四個缺陷在此根治，各有反例測試：
 *  1. pinch 起手**清 drag**（audit §2：殘留手指把節點拖跳一段 pinch 位移）
 *     — 第二指落下時發出 cancel-drag，previewNodes 由呼叫端回滾。
 *  2. 長按帶 **slop**（8px）：位移在 slop 內不取消計時 — 手指自然抖動
 *     不再讓行動端唯一的多選入口失效。
 *  3. **雙指平移**：pinch 期間中點位移併入 camera（zoomAt 只處理縮放錨，
 *     中點平移原本在數學上被抵銷）。
 *  4. **pointer 雙擊**：兩次 tap 在 300ms／24px 內 — 不再依賴瀏覽器
 *     dblclick 合成（iOS 不穩，audit UNVERIFIED 項）。
 *
 * 用法：呼叫端把 pointer 事件餵給 reducer，拿回 (新狀態, 效果清單) 並
 * 執行效果。狀態機不碰 React/DOM — WB02 的 WhiteboardWorkspace 是唯一
 * 消費者，單元測試直接打純函式。
 */

export type GPoint = { x: number; y: number };

export type GestureTool = "pan" | "select" | "lasso";

export type GestureState = {
  tool: GestureTool;
  pointers: Map<number, GPoint>;
  mode: "idle" | "drag" | "pan" | "pinch" | "marquee" | "lasso";
  /** drag 起手資訊（node ids 由呼叫端在 begin-drag 效果時決定並回填）。 */
  dragIds: string[];
  dragLast: GPoint | null;
  pinch: { distance: number; zoom: number; mid: GPoint } | null;
  marquee: { a: GPoint; b: GPoint } | null;
  lassoPath: GPoint[];
  longPress: { at: GPoint; deadline: number } | null;
  lastTap: { at: GPoint; time: number } | null;
};

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP = 8;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 24;

export function initialGestureState(tool: GestureTool = "pan"): GestureState {
  return {
    tool,
    pointers: new Map(),
    mode: "idle",
    dragIds: [],
    dragLast: null,
    pinch: null,
    marquee: null,
    lassoPath: [],
    longPress: null,
    lastTap: null,
  };
}

export type GestureEffect =
  | { kind: "hit-test"; screen: GPoint }            // 呼叫端做命中，回填 beginDrag/beginPan
  | { kind: "cancel-drag" }                          // pinch 起手：回滾 preview、清 drag
  | { kind: "move-nodes"; dxWorld: number; dyWorld: number }
  | { kind: "pan"; dx: number; dy: number }          // 螢幕座標平移
  | { kind: "pinch-zoom"; mid: GPoint; scale: number; midDelta: GPoint }
  | { kind: "marquee-update"; a: GPoint; b: GPoint } // 世界座標由呼叫端換算
  | { kind: "marquee-commit" }
  | { kind: "lasso-update" }
  | { kind: "lasso-commit" }
  | { kind: "commit-drag" }
  | { kind: "long-press-armed"; deadline: number }   // 呼叫端設 timer
  | { kind: "long-press-cancelled" }
  | { kind: "double-tap"; screen: GPoint }
  | { kind: "tap"; screen: GPoint };

export type GestureInput =
  | { type: "down"; pointerId: number; point: GPoint; time: number }
  | { type: "move"; pointerId: number; point: GPoint; time: number; zoom: number }
  | { type: "up"; pointerId: number; point: GPoint; time: number }
  /** 呼叫端命中後回填：這次 down 是拖節點還是平移/框選。 */
  | { type: "begin-drag"; ids: string[]; world: GPoint }
  | { type: "begin-pan"; point: GPoint }
  | { type: "begin-marquee"; world: GPoint }
  | { type: "begin-lasso"; world: GPoint };

export function gestureReducer(
  state: GestureState,
  input: GestureInput,
): { state: GestureState; effects: GestureEffect[] } {
  const effects: GestureEffect[] = [];
  const next: GestureState = { ...state, pointers: new Map(state.pointers) };

  switch (input.type) {
    case "down": {
      next.pointers.set(input.pointerId, input.point);
      if (next.pointers.size === 2) {
        // pinch 起手：**先清 drag**（缺陷 1 的根治點）
        if (next.mode === "drag") effects.push({ kind: "cancel-drag" });
        const [a, b] = [...next.pointers.values()];
        next.mode = "pinch";
        next.dragIds = [];
        next.dragLast = null;
        next.marquee = null;
        next.pinch = {
          distance: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: 0, // 呼叫端以當下 camera.zoom 補（見 move 的 zoom 參數）
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        if (next.longPress) {
          next.longPress = null;
          effects.push({ kind: "long-press-cancelled" });
        }
        return { state: next, effects };
      }
      if (next.pointers.size > 2) return { state: next, effects };
      // 單指：交給呼叫端命中（節點 / 空白 / 工具態），回填 begin-*
      next.longPress = { at: input.point, deadline: input.time + LONG_PRESS_MS };
      effects.push({ kind: "hit-test", screen: input.point });
      effects.push({ kind: "long-press-armed", deadline: input.time + LONG_PRESS_MS });
      return { state: next, effects };
    }

    case "begin-drag":
      next.mode = "drag";
      next.dragIds = input.ids;
      next.dragLast = input.world;
      return { state: next, effects };

    case "begin-pan":
      next.mode = "pan";
      next.dragIds = [];
      next.dragLast = input.point;
      return { state: next, effects };

    case "begin-marquee":
      next.mode = "marquee";
      next.marquee = { a: input.world, b: input.world };
      next.longPress = null;
      return { state: next, effects };

    case "begin-lasso":
      next.mode = "lasso";
      next.lassoPath = [input.world];
      next.longPress = null;
      return { state: next, effects };

    case "move": {
      const previous = next.pointers.get(input.pointerId);
      // hover 防護（WB03 e2e 逼出的真 bug）：沒按下的滑鼠移動不是手勢 —
      // 未追蹤的 pointer 一旦入 map，下一次真按下會被當成「第二指」進
      // pinch，長按/點擊全滅。只更新已按下的 pointer。
      if (!previous) return { state: next, effects };
      next.pointers.set(input.pointerId, input.point);

      // 長按 slop（缺陷 2）：只有位移超過 slop 才取消
      if (next.longPress) {
        const moved = Math.hypot(input.point.x - next.longPress.at.x, input.point.y - next.longPress.at.y);
        if (moved > LONG_PRESS_SLOP) {
          next.longPress = null;
          effects.push({ kind: "long-press-cancelled" });
        }
      }

      if (next.mode === "pinch" && next.pinch && next.pointers.size >= 2) {
        const [a, b] = [...next.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // 增量語意（Grok wb02 F1）：scale 是「相對上一次 move」的比值，
        // 呼叫端乘在當下 zoom 上 — 乘法鏈收斂於總距離比。若以「相對起手」
        // 的絕對比乘當下 zoom，每個 move 連乘一次會指數失控（實抓）。
        const midDelta = { x: mid.x - next.pinch.mid.x, y: mid.y - next.pinch.mid.y };
        const scale = next.pinch.distance > 0 ? distance / next.pinch.distance : 1;
        effects.push({ kind: "pinch-zoom", mid, scale, midDelta });
        next.pinch = { distance, zoom: next.pinch.zoom, mid };
        return { state: next, effects };
      }

      if (next.mode === "marquee" && next.marquee) {
        effects.push({ kind: "marquee-update", a: next.marquee.a, b: input.point });
        return { state: next, effects };
      }
      if (next.mode === "lasso") {
        next.lassoPath = [...next.lassoPath, input.point];
        effects.push({ kind: "lasso-update" });
        return { state: next, effects };
      }
      if (next.mode === "pan" && next.dragLast) {
        effects.push({ kind: "pan", dx: input.point.x - next.dragLast.x, dy: input.point.y - next.dragLast.y });
        next.dragLast = input.point;
        return { state: next, effects };
      }
      if (next.mode === "drag" && next.dragLast && previous) {
        // 世界座標位移由呼叫端以 camera.zoom 換算 — 這裡回報螢幕差
        effects.push({
          kind: "move-nodes",
          dxWorld: (input.point.x - previous.x) / input.zoom,
          dyWorld: (input.point.y - previous.y) / input.zoom,
        });
        return { state: next, effects };
      }
      return { state: next, effects };
    }

    case "up": {
      // 對稱防護：非追蹤中的 pointer 放開（hover release）不進手勢
      if (!next.pointers.has(input.pointerId)) return { state: next, effects };
      next.pointers.delete(input.pointerId);
      // tap 判定（Grok wb02 F2 修正）：up 時長按仍 armed ＝ 位移未超過
      // slop 且未到長按時限 — 這就是一次 tap，**與 mode 無關**（drag/pan
      // 起手但手指沒真的動也算）。原本的 mode 條件讓節點上的雙擊永遠
      // 走不到（begin-drag 已把 dragLast 設非 null）。
      const wasTap = next.longPress !== null && input.time < next.longPress.deadline;
      if (next.longPress) {
        next.longPress = null;
        effects.push({ kind: "long-press-cancelled" });
      }
      if (wasTap) {
        const lastTap = next.lastTap;
        if (
          lastTap &&
          input.time - lastTap.time <= DOUBLE_TAP_MS &&
          Math.hypot(input.point.x - lastTap.at.x, input.point.y - lastTap.at.y) <= DOUBLE_TAP_SLOP
        ) {
          next.lastTap = null;
          effects.push({ kind: "double-tap", screen: input.point });
        } else {
          next.lastTap = { at: input.point, time: input.time };
          effects.push({ kind: "tap", screen: input.point });
        }
      }
      if (next.mode === "pinch") {
        if (next.pointers.size < 2) {
          next.pinch = null;
          // 殘指不得復活 drag：直接回 idle（缺陷 1 的下半）
          next.mode = next.pointers.size === 1 ? "pan" : "idle";
          const remaining = [...next.pointers.values()][0];
          next.dragLast = remaining ?? null;
        }
        return { state: next, effects };
      }
      if (next.mode === "marquee") {
        effects.push({ kind: "marquee-commit" });
        next.marquee = null;
        next.mode = "idle";
        return { state: next, effects };
      }
      if (next.mode === "lasso") {
        effects.push({ kind: "lasso-commit" });
        next.mode = "idle";
        return { state: next, effects };
      }
      if (next.mode === "drag") {
        effects.push({ kind: "commit-drag" });
      }
      next.mode = "idle";
      next.dragIds = [];
      next.dragLast = null;
      return { state: next, effects };
    }
  }
  return { state: next, effects };
}


/** 套索命中：射線法點在多邊形內（節點中心點計）。 */
export function lassoHits(
  nodes: Array<{ id: string; x: number; y: number; width: number; height: number }>,
  path: GPoint[],
): string[] {
  if (path.length < 3) return [];
  return nodes
    .filter((node) => pointInPolygon({ x: node.x + node.width / 2, y: node.y + node.height / 2 }, path))
    .map((node) => node.id);
}

function pointInPolygon(point: GPoint, polygon: GPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}
