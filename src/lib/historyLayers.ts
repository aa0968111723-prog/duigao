/**
 * History 層協調器（WB03）。
 *
 * 問題：白板 Focus 與對稿 overlay 各自掛 popstate listener — overlay 疊在
 * Focus 上時按 back，白板的 listener 先收，板被退、overlay 還在。單一
 * listener 只派給**棧頂**層，層與層之間不再互相誤傷。
 *
 * 語意：
 * - pushHistoryLayer(name, onBack) → 入棧＋history.pushState 一層。
 * - back/popstate → 棧頂 onBack()：
 *     "closed"  = 這層被消耗（pop 吃掉它 push 的那格，棧移除）。
 *     "repush"  = 這層自理了內層 UI（例：白板先關 sheet），層還活著 —
 *                 補 pushState 一格。
 * - 回傳的 remove(viaBack) 做程式性關閉：viaBack=true 表示由 onBack 觸發
 *   （格已被 pop 消耗，不補 back）；false 表示 UI 按鈕等路徑 — 若在棧頂
 *   就 history.back() 消耗自己那格。
 * - 亂序移除（關閉時不在棧頂）：無法選擇性移除中段 history 格 — 標記
 *   zombie，之後的 pop 撞到 zombie 只消耗格、不叫任何 onBack。已知限制
 *   （誠實）：那一下 back 無可見效果，下一下恢復正常。
 *
 * 可測性：createLayerStack(historyLike) 注入 history 樣式，單元直測；
 * 瀏覽器用 default 單例（懶掛 listener）。
 */
export type LayerBackResponse = "closed" | "repush";

type HistoryLike = {
  pushState: (state: unknown, unused: string) => void;
  back: () => void;
};

type Layer = {
  name: string;
  onBack: () => LayerBackResponse;
  zombie: boolean;
};

export type LayerStack = {
  push: (name: string, onBack: () => LayerBackResponse) => (viaBack: boolean) => void;
  /** popstate 事件入口（瀏覽器 listener 或測試直接呼叫）。 */
  handlePop: () => void;
  /** 活層數（測試/偵錯）。 */
  depth: () => number;
};

export function createLayerStack(history: HistoryLike): LayerStack {
  const stack: Layer[] = [];
  // 程式性 remove 自己呼叫的 history.back() 也會觸發 popstate — 這種
  // pop 是「消耗自己的格」，絕不能派給下層活層的 onBack。用計數抑制。
  let pendingConsume = 0;

  const handlePop = () => {
    if (pendingConsume > 0) {
      pendingConsume -= 1;
      return;
    }
    // zombie：pop 消耗的是 zombie 留下的格，活層不受牽連（一次 pop
    // 只消耗一格）
    if (stack.length && stack[stack.length - 1].zombie) {
      stack.pop();
      return;
    }
    const top = stack[stack.length - 1];
    if (!top) return; // 不是我們的格（外層導航），不干預
    const result = top.onBack();
    if (result === "closed") {
      stack.pop();
    } else {
      history.pushState({ layer: top.name }, "");
    }
  };

  const push = (name: string, onBack: () => LayerBackResponse) => {
    const layer: Layer = { name, onBack, zombie: false };
    stack.push(layer);
    history.pushState({ layer: name }, "");
    return (viaBack: boolean) => {
      const index = stack.indexOf(layer);
      if (index < 0) return; // 已移除（重複呼叫防禦）
      if (viaBack) {
        // onBack 路徑：格已被 pop 消耗 — 若還在棧（onBack 回 closed 時
        // handlePop 已 pop；此分支只防禦沒走 handlePop 的直呼）
        stack.splice(index, 1);
        return;
      }
      if (index === stack.length - 1) {
        stack.pop();
        pendingConsume += 1;
        history.back(); // 消耗自己 push 的那格（pop 由計數吃掉）
      } else {
        layer.zombie = true; // 亂序：格移不掉，標記讓之後的 pop 吃掉
      }
    };
  };

  return { push, handlePop, depth: () => stack.filter((layer) => !layer.zombie).length };
}

// ---- 瀏覽器單例（懶掛全域 listener） ----
let singleton: LayerStack | null = null;

export function historyLayers(): LayerStack {
  if (!singleton) {
    singleton = createLayerStack(window.history);
    window.addEventListener("popstate", () => singleton!.handlePop());
  }
  return singleton;
}
