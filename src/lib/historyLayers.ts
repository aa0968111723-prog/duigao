/**
 * History 層協調器（WB03 起；WB04 以序號硬化）。
 *
 * 問題（WB03）：白板 Focus 與對稿 overlay 各自掛 popstate listener —
 * overlay 疊在 Focus 上時按 back，白板的 listener 先收，板被退、overlay
 * 還在。單一 listener 只派給**棧頂**層，層與層之間不再互相誤傷。
 *
 * WB04 的硬化（S18/S19）：不再靠「數 pop 次數」猜自己走到哪，而是**每格
 * history 帶序號**（`{__layer, __seq}`），popstate 時直接讀落地那格的序號
 * 決定要關掉哪些層。這修掉兩條計數式做法根治不了的缺陷：
 * - forward 幽靈格：按瀏覽器「下一頁」會落在序號**更大**的舊格，計數式
 *   一律當成 back → 把白板關掉。序號式一眼看出是前進，不派發。
 * - 亂序關層：中段層被程式性關掉時，它那格 history 移不掉；序號式把它
 *   當成單純的舊格跳過，不需要 zombie 旗標，也不會誤傷還活著的層。
 *
 * 語意：
 * - push(name, onBack) → 入棧＋pushState 一格（帶序號）。回傳
 *   remove(viaBack)：viaBack=true 表示由 onBack 觸發（格已被消耗）；
 *   false 是 UI 按鈕等路徑，若在棧頂就 back() 吃掉自己那格。
 * - onBack() 回 "closed"＝這層關掉了；"repush"＝層自理了內層 UI（例：
 *   白板先關 sheet），層還活著，補一格新序號。
 *
 * 誠實邊界：使用者的 back **正在途中**時若同時發生程式性關層，兩格會被
 * 一起消耗（多退一層）。要根治得能問「這個 popstate 是誰觸發的」，
 * 瀏覽器不提供；競態窗只有一次 traversal。
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
  /** 這層目前佔用的 history 格序號。 */
  seq: number;
  /** push 這層之前所在的格序號 — 關掉它之後應該落回這裡。 */
  prevSeq: number;
  onBack: () => LayerBackResponse;
};

type LayerState = { __layer?: string; __seq?: number };

export type LayerStack = {
  push: (name: string, onBack: () => LayerBackResponse) => (viaBack: boolean) => void;
  /** popstate 入口：傳入 `event.state`（測試可直接給 state 物件）。 */
  handlePop: (state?: unknown) => void;
  /**
   * Escape 入口：語意與 back 相同 — 只派給棧頂層。兩個各自監聽 Escape 的
   * 元件會各關一件，一次按鍵關掉兩層；改由協調器獨佔派發後不再互踩。
   */
  handleEscape: () => void;
  /** 活層數（測試/偵錯）。 */
  depth: () => number;
};

function seqOf(state: unknown): number {
  const value = (state as LayerState | null | undefined)?.__seq;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function createLayerStack(history: HistoryLike): LayerStack {
  const stack: Layer[] = [];
  let seqCounter = 0;
  /** 我們認為自己所在的格序號（0＝所有層之下的基準格）。 */
  let currentSeq = 0;
  /** 自己呼叫 back() 後預期落地的格 — 那次 popstate 不該派給任何層。 */
  const selfConsume = new Set<number>();

  const occupy = (layer: Layer) => {
    seqCounter += 1;
    layer.seq = seqCounter;
    currentSeq = layer.seq;
    history.pushState({ __layer: layer.name, __seq: layer.seq }, "");
  };

  /** 關掉所有「序號比落地格大」的層（長按返回可能一次跨多層）。 */
  const dispatch = (landedSeq: number) => {
    while (stack.length && stack[stack.length - 1].seq > landedSeq) {
      const top = stack[stack.length - 1];
      if (top.onBack() === "closed") {
        stack.pop();
        continue;
      }
      // repush：層自理了內層 UI，補一格新序號後停手
      occupy(top);
      return;
    }
    currentSeq = landedSeq;
  };

  const handlePop = (state?: unknown) => {
    const landedSeq = seqOf(state);
    if (selfConsume.delete(landedSeq)) {
      currentSeq = landedSeq;
      return;
    }
    if (landedSeq > currentSeq) {
      // 前進（forward）到我們先前關掉的舊格 — 不是返回，不派發。
      currentSeq = landedSeq;
      return;
    }
    dispatch(landedSeq);
  };

  const consume = (layer: Layer) => {
    selfConsume.add(layer.prevSeq);
    currentSeq = layer.prevSeq;
    history.back();
  };

  const push = (name: string, onBack: () => LayerBackResponse) => {
    const layer: Layer = { name, seq: 0, prevSeq: currentSeq, onBack };
    stack.push(layer);
    occupy(layer);
    return (viaBack: boolean) => {
      const index = stack.indexOf(layer);
      if (index < 0) return; // 已移除（重複呼叫防禦）
      stack.splice(index, 1);
      if (viaBack) return; // 格已被使用者那次 pop 消耗
      if (index === stack.length) {
        // 原本是棧頂：吃掉自己那格
        consume(layer);
      }
      // 亂序（中段被關）：它那格 history 移不掉，留著當舊格 —
      // 序號派發會跳過它，代價是那一下 back 沒有可見效果。
    };
  };

  const handleEscape = () => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (top.onBack() !== "closed") return; // repush：層自理，history 不動
    stack.pop();
    consume(top);
  };

  return { push, handlePop, handleEscape, depth: () => stack.length };
}

// ---- 瀏覽器單例（懶掛全域 listener） ----
let singleton: LayerStack | null = null;

export function historyLayers(): LayerStack {
  if (!singleton) {
    singleton = createLayerStack(window.history);
    window.addEventListener("popstate", (event) => singleton!.handlePop(event.state));
    // Escape 也只由這裡派發。延遲到同步派發跑完才看 defaultPrevented —
    // 內層 ladder（pin/modal/sheet）消費時會 prevent，一次 Escape 只關
    // 一件事（沿用 Grok pr01a r2 N2 的既有紀律）。
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      setTimeout(() => {
        if (event.defaultPrevented) return;
        singleton!.handleEscape();
      }, 0);
    });
  }
  return singleton;
}
