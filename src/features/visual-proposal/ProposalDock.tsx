import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProposalStore, type ProposalAuthor, type ProposalType, type TextRole } from "./store";
import { ProposalQuickElement } from "./ProposalQuickElement";
import { ProposalListPanel } from "./ProposalListPanel";
import { ProposalCompare } from "./ProposalCompare";
import { ProposalPreference } from "./ProposalPreference";
import type { ProposalPinBinding } from "./ProposalCard";
import {
  createImageItem,
  createShapeItem,
  createTextItem,
  prepareImageFile,
  proposalStatusLabel,
  proposalTypeLabel,
} from "./helpers";
import type { ShowToast } from "../../toast";
import type { ProposalPref } from "../../lib/types";
import "./proposal.css";

export type ProposalPrefBinding = { prefs: ProposalPref[]; userId: string; onChoose: (choice: string) => void };

/** How the dock was opened: plain, from a 修改點, or straight onto one proposal. */
export type ProposalIntent =
  | { kind: "create"; linkedCommentId: string; type?: ProposalType; title?: string }
  | { kind: "open"; proposalId: string };

type Props = {
  roomId: string;
  versionId: string;
  author: ProposalAuthor;
  showToast: ShowToast;
  onExit: () => void;
  onHeight?: (px: number) => void;
  pref?: ProposalPrefBinding;
  pin?: ProposalPinBinding;
  intent?: ProposalIntent | null;
};

type Panel = "none" | "element" | "compare" | "list";

/** New text elements walk down the poster hierarchy so one tap needs no setup. */
const TEXT_ORDER: TextRole[] = ["title", "subtitle", "body", "custom"];

/**
 * Mobile proposal surface. Five fixed actions, nothing else — every extra
 * control appears only after an element is selected or a panel is opened, so
 * the first glance never gets busier than the poster itself.
 */
export function ProposalDock({ roomId, versionId, author, showToast, onExit, onHeight, pref, pin, intent }: Props) {
  const proposal = useProposalStore(roomId, versionId, author);
  const materialRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [pickMaterial, setPickMaterial] = useState(false);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  // Enter edit mode on mount; return to a clean original poster on exit.
  useEffect(() => {
    proposal.setViewMode("proposal");
    proposal.setEditing(true);
    return () => {
      proposal.setEditing(false);
      proposal.setViewMode("original");
      proposal.selectItem(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Arriving from a 修改點 card: start (or open) the proposal it points at.
  const seededIntent = useRef(false);
  useEffect(() => {
    if (!intent || seededIntent.current) return;
    seededIntent.current = true;
    if (intent.kind === "create") {
      proposal.create({ linkedCommentId: intent.linkedCommentId, type: intent.type, title: intent.title });
    } else {
      proposal.selectProposal(intent.proposalId);
    }
    setPanel("list");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  // When an element is picked on the canvas, jump straight to its settings.
  useEffect(() => {
    if (proposal.selectedItem) setPanel("element");
  }, [proposal.selectedItem]);

  const active = proposal.active;

  const addText = () => {
    setPickMaterial(false);
    const used = active?.items.filter((i) => i.type === "text").length ?? 0;
    proposal.addText(createTextItem(TEXT_ORDER[Math.min(used, TEXT_ORDER.length - 1)]));
    setPanel("element");
  };

  const addShape = () => {
    setPickMaterial(false);
    proposal.addShape(createShapeItem());
    setPanel("element");
  };

  const uploadMaterial = async (files: FileList | null) => {
    const file = files?.[0];
    if (materialRef.current) materialRef.current.value = "";
    if (!file) return;
    try {
      const prepared = await prepareImageFile(file);
      proposal.addImage(createImageItem(prepared.dataUrl, prepared.name));
      setPickMaterial(false);
      setPanel("element");
      showToast(prepared.note ?? "已加入素材，拖到想要的位置");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "素材讀取失敗", { tone: "error" });
    }
  };

  const togglePanel = (next: Panel) => {
    setPickMaterial(false);
    setPanel((current) => (current === next ? "none" : next));
  };

  return (
    <section className="pdock" aria-label="視覺提案" ref={rootRef}>
      {proposal.error && (
        <div className="proposal-error" role="alert">
          <span>{proposal.error}</span>
          <button type="button" onClick={proposal.dismissError} aria-label="關閉錯誤訊息">
            ×
          </button>
        </div>
      )}

      {active ? (
        <button type="button" className="pdock-current" onClick={() => togglePanel("list")}>
          <span className="pdock-current-title">{active.title}</span>
          <span className="pdock-current-type">{proposalTypeLabel(active.type)}</span>
          <span className={`pcard-status is-${active.status}`}>{proposalStatusLabel(active.status)}</span>
        </button>
      ) : (
        <button type="button" className="proposal-primary pdock-create" onClick={() => proposal.create()}>
          ＋ 建立這一版的視覺提案
        </button>
      )}

      {panel !== "none" && (
        <div className="pdock-body">
          {panel === "element" && (
            <ProposalQuickElement roomId={roomId} versionId={versionId} author={author} showToast={showToast} />
          )}
          {panel === "compare" && <ProposalCompare roomId={roomId} versionId={versionId} author={author} />}
          {panel === "list" && (
            <>
              <ProposalListPanel
                roomId={roomId}
                versionId={versionId}
                author={author}
                showToast={showToast}
                pin={pin}
              />
              {pref && proposal.docs.length > 0 && (
                <ProposalPreference
                  versionId={versionId}
                  proposals={proposal.docs.map((d) => ({ id: d.id, name: d.title }))}
                  prefs={pref.prefs}
                  userId={pref.userId}
                  onChoose={pref.onChoose}
                />
              )}
            </>
          )}
        </div>
      )}

      {pickMaterial && (
        <div className="pdock-pick" role="group" aria-label="選擇素材種類">
          <button type="button" className="proposal-chip" onClick={() => materialRef.current?.click()}>
            圖片
          </button>
          <button type="button" className="proposal-chip" onClick={addShape}>
            色塊
          </button>
        </div>
      )}

      <nav className="pdock-bar" aria-label="視覺提案操作">
        <button type="button" className="pdock-act" onClick={addText}>
          ＋文字
        </button>
        <button
          type="button"
          className={`pdock-act ${pickMaterial ? "is-on" : ""}`}
          onClick={() => {
            setPanel("none");
            setPickMaterial((v) => !v);
          }}
        >
          ＋素材
        </button>
        <button
          type="button"
          className={`pdock-act ${panel === "compare" ? "is-on" : ""}`}
          onClick={() => togglePanel("compare")}
        >
          比較
        </button>
        <button
          type="button"
          className={`pdock-act ${panel === "list" ? "is-on" : ""}`}
          onClick={() => togglePanel("list")}
        >
          提案{proposal.docs.length > 1 ? ` ${proposal.docs.length}` : ""}
        </button>
        <button type="button" className="pdock-done" onClick={onExit}>
          完成
        </button>
      </nav>

      <input
        ref={materialRef}
        className="proposal-file"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        onChange={(e) => void uploadMaterial(e.target.files)}
      />
      <p className="proposal-local-note">提案只是覆蓋層，原稿永遠不會被改到。</p>
    </section>
  );
}
