import { useMemo, useState } from "react";
import { searchOpenStickers, type CatalogHit } from "./openCatalog";

type Props = {
  onPick: (hit: CatalogHit) => void;
};

export function OpenStickerPicker({ onPick }: Props) {
  const [query, setQuery] = useState("");
  const hits = useMemo(() => searchOpenStickers(query), [query]);
  return (
    <div className="pcatalog" data-testid="poster-open-catalog">
      <input
        className="text-input"
        data-testid="poster-catalog-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="搜尋開源貼圖…"
        aria-label="搜尋開源貼圖"
      />
      <div className="pcatalog-hits">
        {hits.map((hit) => (
          <button
            type="button"
            className="pcatalog-hit"
            key={hit.id}
            data-testid={`poster-catalog-hit-${hit.id}`}
            onClick={() => onPick(hit)}
          >
            <img src={hit.pngDataUrl} alt="" />
            <span>{hit.name}</span>
          </button>
        ))}
        {!hits.length && <p className="proposal-muted">沒有符合的貼圖</p>}
      </div>
    </div>
  );
}
