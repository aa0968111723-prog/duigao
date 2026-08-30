import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { VIDEO_ACCEPT } from "../features/video-review/media";

/**
 * Universal Intake（PR-01b）：所有檔案入口共用的單一收件層。
 *
 * 每個入口用 profile 描述「收什麼」，用 mode 描述「長什麼樣」：
 *   - zone        既有 UploadZone 的 drop＋click＋Enter＋hidden input 行為，逐字保留。
 *   - trigger     不渲染可見 UI，暴露 open()/openCamera() 給既有按鈕呼叫。
 *   - select-only 只選檔不上傳（CreateSheet 要先等 createBranch 的 FK 落地）。
 *
 * Profile registry 逐字複製今天各入口的語意 — 凍結行為（share cover 的三
 * MIME、video 單檔、proposal 的圖片白名單）不因收斂而改變。附件是唯一新
 * profile。驗證只做「上傳前就能擋下」的事（大小／型別）；各入口既有的
 * 深度驗證（acceptVideoFile、prepareImageFile）留在原地，不搬。
 */
export const INTAKE_PROFILES = {
  poster: { accept: "image/*", multiple: true },
  video: { accept: VIDEO_ACCEPT, multiple: false },
  proposal: { accept: "image/png,image/jpeg,image/webp,image/svg+xml", multiple: true },
  "share-cover": { accept: "image/png,image/jpeg,image/webp", multiple: false },
  attachment: {
    // 檔案卡：pdf／音訊／常見文件／planform 場佈 JSON（PR-06）。
    // 連結卡不經檔案系統，不在此處。
    accept: "application/pdf,audio/*,.docx,.pptx,.xlsx,.txt,.csv,.zip,.json,application/json",
    multiple: false,
    // RLS 擋不了大小；client 端先擋，數字寫進 UX 文案。
    maxBytes: 25 * 1024 * 1024,
  },
} as const satisfies Record<string, { accept: string; multiple: boolean; maxBytes?: number }>;

export type IntakeProfileId = keyof typeof INTAKE_PROFILES;

export type IntakeHandle = { open: () => void; openCamera: () => void };

type Props = {
  profile: IntakeProfileId;
  mode: "zone" | "trigger" | "select-only";
  /** 與既有各站簽名一致：一律交付 FileList（過濾後以 DataTransfer 重建）。 */
  onFiles: (files: FileList | null) => void;
  /** 拒收原因回報（超過大小上限等）；不傳就靜默丟棄。 */
  onReject?: (reason: string) => void;
  /**
   * 手機相機：渲染第二個 capture="environment" 的 hidden input，由
   * openCamera() 觸發。絕不在主 input 上掛 capture — 那會殺掉 iOS 的
   * 相簿選取。
   */
  camera?: boolean;
  className?: string;
  children?: ReactNode;
};

/**
 * 一份與 `<input>` 完全脫鉤的 FileList。
 *
 * 這是 DataTransfer 不能用時的替代品，而不是「退回原本那個 FileList」——
 * input 給的 FileList 是活的：onChange 一結束就 `input.value = ""`，那個物件
 * 當場變成空的。CreateSheet 會把選取放進 state 一直留到按「建立」，拿到活的
 * 那份等於什麼都沒選到，舊 WebView 上建立文宣／影片就永遠做不成。
 *
 * 消費端只用 length、索引、item() 與展開／for..of，這四件事這裡都給足。
 */
export function staticFileList(files: File[]): FileList {
  // 快照：呼叫端之後怎麼動它的陣列都與這份清單無關。
  const snapshot = [...files];
  const list: Record<PropertyKey, unknown> = {
    length: snapshot.length,
    item: (index: number) => snapshot[index] ?? null,
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  };
  snapshot.forEach((file, index) => {
    list[index] = file;
  });
  return list as unknown as FileList;
}

function filterBySize(
  files: FileList | null,
  maxBytes: number | undefined,
  onReject?: (reason: string) => void,
): FileList | null {
  if (!files) return null;
  const kept = maxBytes ? [...files].filter((file) => file.size <= maxBytes) : [...files];
  if (maxBytes && kept.length < files.length) {
    onReject?.(`檔案太大了，單檔上限 ${Math.round(maxBytes / 1024 / 1024)}MB。`);
  }
  if (!kept.length) return null;
  // 一律以 DataTransfer 物化：input 的 FileList 是 live 的，reset input
  // 之後就變空。呼叫端（如 CreateSheet）要能把選取「持有」到 submit，
  // 必須與 input 解耦。
  try {
    const dt = new DataTransfer();
    for (const file of kept) dt.items.add(file);
    return dt.files;
  } catch {
    // 舊 WebView／被鎖住的 in-app 瀏覽器沒有可用的 DataTransfer 建構子。
    // 以前這裡會直接把例外丟進 onChange handler，整批檔案無聲蒸發 —
    // 使用者只看到「選完檔案什麼都沒發生」。改用自己做的靜態清單，脫鉤這
    // 件事就還在：把 input 的活 FileList 交出去，reset 之後它就空了。
    return staticFileList(kept);
  }
}

export const UniversalIntake = forwardRef<IntakeHandle, Props>(function UniversalIntake(
  { profile, mode, onFiles, onReject, camera = false, className = "", children },
  ref,
) {
  const spec = INTAKE_PROFILES[profile];
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  useImperativeHandle(ref, () => ({
    open: () => inputRef.current?.click(),
    openCamera: () => (camera ? cameraRef.current : inputRef.current)?.click(),
  }), [camera]);

  const handle = (files: FileList | null) => {
    // 收件層丟出來的例外會被 React 的事件系統吞掉，畫面上什麼都不會發生。
    // 檔案入口最不能有的就是「靜靜失敗」。
    try {
      const kept = filterBySize(files, "maxBytes" in spec ? spec.maxBytes : undefined, onReject);
      if (kept) onFiles(kept);
    } catch {
      onReject?.("讀取這個檔案時出了問題，請再選一次。");
    }
  };

  const inputs = (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={spec.accept}
        multiple={spec.multiple}
        hidden
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = "";
        }}
      />
      {camera && (
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            handle(e.target.files);
            e.target.value = "";
          }}
        />
      )}
    </>
  );

  if (mode !== "zone") {
    // trigger／select-only：不渲染可見容器，input 由 handle 觸發。
    return <span hidden>{inputs}</span>;
  }

  // zone：UploadZone 的行為逐字保留（drop＋click＋Enter），input reset 一致。
  return (
    <div
      className={`${className} ${drag ? "upload-drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        handle(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && inputRef.current?.click()}
    >
      {inputs}
      {children}
    </div>
  );
});
