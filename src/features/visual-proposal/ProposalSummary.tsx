import { useProposalStore, type ProposalAuthor, type VisualProposal } from "./store";
import { fontStyleLabel, proposalStatusLabel, proposalTypeLabel, textRoleLabel } from "./helpers";
import type { ShowToast } from "../../toast";

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast?: ShowToast;
};

function describePosition(x: number, y: number): string {
  const col = x < 0.34 ? "左" : x > 0.66 ? "右" : "中";
  const row = y < 0.34 ? "上" : y > 0.66 ? "下" : "中";
  if (col === "中" && row === "中") return "畫面中央";
  return `${row}${col === "中" ? "方" : col}方`;
}

function overview(doc: VisualProposal): string {
  const texts = doc.items.filter((i) => i.type === "text").length;
  const images = doc.items.filter((i) => i.type === "image").length;
  const shapes = doc.items.filter((i) => i.type === "shape").length;
  const bg = doc.background;
  const bgActive = bg.imageDataUrl || bg.colorOpacity > 0 || (bg.gradient !== "none" && bg.gradientOpacity > 0);
  const parts = [`背景 ${bgActive ? 1 : 0}`, `文字 ${texts}`, `素材 ${images}`, `色塊 ${shapes}`];
  const head = `${doc.title}（${proposalTypeLabel(doc.type)}・${proposalStatusLabel(doc.status)}・作者：${doc.authorName}）`;
  const desc = doc.description.trim() ? `\n想解決：${doc.description.trim()}` : "";
  return `${head}${desc}\n改動：${parts.join("・")}`;
}

function suggestions(doc: VisualProposal): string[] {
  const lines: string[] = [];
  for (const item of doc.items) {
    if (!item.visible) continue;
    if (item.type === "shape") {
      lines.push(`在${describePosition(item.x, item.y)}加一塊色塊（${item.color}），約 ${Math.round(item.width)}% 寬`);
      continue;
    }
    if (item.type === "text") {
      const role = textRoleLabel(item.role);
      lines.push(`${role}文案改為：「${item.text.trim() || "（未填）"}」`);
      lines.push(`${role}字體感覺：${fontStyleLabel(item.fontStyle)}`);
    } else {
      lines.push(`素材「${item.name}」放到${describePosition(item.x, item.y)}，約 ${Math.round(item.width)}% 大小`);
    }
  }
  const bg = doc.background;
  if (bg.gradient !== "none" && bg.gradientOpacity > 0) lines.push(`背景加上${bg.gradient === "vertical" ? "上下" : bg.gradient === "horizontal" ? "左右" : "對角"}漸層`);
  else if (bg.colorOpacity > 0) lines.push(`背景加上深色遮罩（濃度約 ${Math.round(bg.colorOpacity * 100)}%）`);
  if (bg.imageDataUrl) lines.push("背景換成另一張圖片");
  if (lines.length === 0) lines.push("（尚未加入任何模擬元素）");
  return lines;
}

export function ProposalSummary({ roomId, versionId, author, showToast }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const active = proposal.active;
  if (!active) return null;

  const suggestionText = `${overview(active)}\n\n修改建議：\n${suggestions(active)
    .map((line) => `- ${line}`)
    .join("\n")}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(suggestionText);
      showToast?.("修改建議已複製，貼給設計者即可", { tone: "success" });
    } catch {
      showToast?.("複製失敗，請長按下方文字手動複製", { tone: "error" });
    }
  };

  return (
    <div className="proposal-summary">
      <div className="proposal-summary-head">
        <strong>提案摘要</strong>
        <button type="button" className="proposal-action" onClick={copy}>
          轉成修改建議
        </button>
      </div>
      <pre className="proposal-summary-text" aria-label="提案摘要文字">
        {suggestionText}
      </pre>
    </div>
  );
}
