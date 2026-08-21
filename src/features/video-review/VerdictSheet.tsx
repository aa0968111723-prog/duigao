import { useState } from "react";
import { ModalSheet } from "../../components/BottomSheet";
import { VERDICTS, VERDICT_LABEL, type Verdict } from "../../lib/types";

/**
 * 看完了，這版你覺得？
 *
 * Three answers, not five stars. A review meeting ends with "ship it / tweak it
 * / redo it"; nobody has ever acted on a 3.4. The note is optional and stays
 * optional — the whole sheet must be answerable with one tap.
 */

type Props = {
  current: Verdict | null;
  currentNote?: string;
  onSubmit: (verdict: Verdict, note?: string) => void;
  onClose: () => void;
};

export function VerdictSheet({ current, currentNote, onSubmit, onClose }: Props) {
  const [picked, setPicked] = useState<Verdict | null>(current);
  const [note, setNote] = useState(currentNote ?? "");

  const submit = (verdict: Verdict) => {
    setPicked(verdict);
    onSubmit(verdict, note.trim() || undefined);
    onClose();
  };

  return (
    <ModalSheet title="看完了，這版你覺得？" onClose={onClose}>
      <div className="m-more v-verdict">
        <div className="v-verdict-options" role="radiogroup" aria-label="這一版的結論">
          {VERDICTS.map((v) => (
            <button
              key={v}
              type="button"
              className={`m-row v-verdict-btn ${picked === v ? "is-on" : ""}`}
              aria-pressed={picked === v}
              onClick={() => submit(v)}
            >
              {VERDICT_LABEL[v]}
            </button>
          ))}
        </div>
        <label className="v-brief-field">
          <span>還有一句想說的……（可略過）</span>
          <textarea
            className="m-input"
            rows={2}
            maxLength={200}
            value={note}
            placeholder="例如：整體很好，只有結尾想再看一次。"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {current && <p className="m-share-note">你已經表態過，選一個新的就會覆蓋。</p>}
      </div>
    </ModalSheet>
  );
}
