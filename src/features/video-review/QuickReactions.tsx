import { REACTION_LABEL, REACTION_TYPES, type ReactionType } from "../../lib/types";

/**
 * 快速反應 — the entire point is that it costs one tap.
 *
 * No typing, no pausing, no category, no confirmation. The video keeps playing;
 * the moment is taken from the player, not from the person. Most people asked to
 * review a cut will never write a sentence, and a review tool that only hears
 * from the ones who do is hearing from the wrong sample.
 */

type Props = {
  onReact: (type: ReactionType) => void;
  disabled?: boolean;
};

export function QuickReactions({ onReact, disabled }: Props) {
  return (
    <div className="v-reactions" role="group" aria-label="快速反應">
      {REACTION_TYPES.map((type) => {
        const { emoji, text } = REACTION_LABEL[type];
        return (
          <button
            key={type}
            type="button"
            className="v-reaction"
            disabled={disabled}
            onClick={() => onReact(type)}
            aria-label={`${text}（記在現在的時間）`}
          >
            <span className="v-reaction-emoji" aria-hidden>
              {emoji}
            </span>
            <span className="v-reaction-text">{text}</span>
          </button>
        );
      })}
    </div>
  );
}
