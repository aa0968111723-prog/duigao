import { useEffect, useMemo, useState } from "react";
import type { LibraryAsset } from "../../cloud/assetLibrary";
import type { Version } from "../../lib/types";
import type { ShowToast } from "../../toast";
import {
  COMPOSE_PLACE_FAIL,
  isComposeDataUrl,
  listComposeMaterials,
  placeComposeMaterial,
  type ComposeMaterial,
} from "./composeMaterials";
import type { ProposalImageItem, VisualProposal } from "./store";

export const OPEN_COMPOSE_PICKER_EVENT = "duigao-open-compose-picker";

type Props = {
  materials: ComposeMaterial[];
  loading?: boolean;
  libraryError?: boolean;
  placingId?: string | null;
  onPick: (material: ComposeMaterial) => void;
  onClose?: () => void;
};

/** Room-asset sheet. Visual language matches wb-content-picker; no whiteboard imports. */
export function ComposeAssetPicker({ materials, loading, libraryError, placingId, onPick, onClose }: Props) {
  return (
    <div
      className="compose-asset-picker"
      data-testid="poster-compose-asset-picker"
      data-count={materials.length}
      role="dialog"
      aria-label="房間素材"
    >
      <div className="compose-asset-picker-head">
        <h3>房間素材</h3>
        {onClose && (
          <button type="button" className="proposal-quiet" onClick={onClose}>
            關閉
          </button>
        )}
      </div>
      {libraryError && <p className="compose-asset-warn">素材庫暫時沒讀到，仍可撿房間文宣／現傳</p>}
      {loading && <p className="proposal-muted">讀取中…</p>}
      {!loading && materials.length === 0 && (
        <p className="proposal-muted">這個房間還沒有可撿的圖。先現傳一張。</p>
      )}
      <div className="compose-asset-list">
        {materials.map((material) => (
          <button
            key={material.id}
            type="button"
            className="compose-asset-row"
            data-testid="poster-compose-asset-row"
            disabled={Boolean(placingId)}
            onClick={() => onPick(material)}
          >
            {material.previewUrl ? (
              <img className="compose-asset-thumb" src={material.previewUrl} alt="" />
            ) : (
              <span className="compose-asset-thumb" aria-hidden />
            )}
            <span>
              <strong>{material.title}</strong>
              <small>{material.sourceLabel}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

const STUB_DOC: VisualProposal = {
  id: "vp_place",
  versionId: "v_place",
  name: "工作層",
  title: "工作層",
  description: "",
  type: "layout",
  status: "draft",
  createdBy: "local",
  authorName: "",
  supports: [],
  comments: [],
  items: [],
  background: {
    color: "#000000",
    colorOpacity: 0,
    gradient: "none",
    gradientFrom: "#000",
    gradientTo: "#000",
    gradientOpacity: 0,
    imageOpacity: 1,
    imageFit: "cover",
  },
  createdAt: 0,
  updatedAt: 0,
};

export function useComposeAssetPick(opts: {
  versions: Version[];
  branches?: { id: string; name: string }[];
  editingVersionId: string;
  listLibrary?: () => Promise<LibraryAsset[]>;
  resolveMaterial?: (material: ComposeMaterial) => Promise<string>;
  canManage: boolean;
  showToast: ShowToast;
  onPlaced: (item: ProposalImageItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [libraryError, setLibraryError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [placingId, setPlacingId] = useState<string | null>(null);

  const versionKey = opts.versions.map((version) => version.id).join(",");
  const labeled = useMemo(
    () =>
      opts.versions.map((version) => {
        const branch = opts.branches?.find((item) => item.id === version.branchId);
        return branch ? { ...version, label: `${branch.name} · ${version.label}` } : version;
      }),
    // versionKey stands in for opts.versions identity; labels follow room data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [versionKey, opts.branches, opts.versions],
  );

  const materials = useMemo(
    () =>
      listComposeMaterials({
        versions: labeled,
        library,
        editingVersionId: opts.editingVersionId,
      }),
    [labeled, library, opts.editingVersionId],
  );

  useEffect(() => {
    if (!open) return;
    if (!opts.listLibrary) {
      setLibrary([]);
      setLibraryError(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLibraryError(false);
    void opts
      .listLibrary()
      .then((rows) => {
        if (cancelled) return;
        setLibrary(rows);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLibraryError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, opts.listLibrary]);

  useEffect(() => {
    const onOpen = () => {
      if (!opts.canManage) return;
      setOpen(true);
    };
    window.addEventListener(OPEN_COMPOSE_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMPOSE_PICKER_EVENT, onOpen);
  }, [opts.canManage]);

  const pick = async (material: ComposeMaterial) => {
    if (!opts.canManage || placingId) return;
    setPlacingId(material.id);
    try {
      const dataUrl = opts.resolveMaterial ? await opts.resolveMaterial(material) : material.previewUrl;
      if (!isComposeDataUrl(dataUrl)) throw new Error(COMPOSE_PLACE_FAIL);
      const placed = placeComposeMaterial(STUB_DOC, material, dataUrl);
      if (!placed.ok) {
        opts.showToast(placed.reason, { tone: "error" });
        return;
      }
      opts.onPlaced(placed.item);
      setOpen(false);
      opts.showToast("已放到畫布，拖到想要的位置");
    } catch (err) {
      opts.showToast(err instanceof Error ? err.message : COMPOSE_PLACE_FAIL, { tone: "error" });
    } finally {
      setPlacingId(null);
    }
  };

  return { open, setOpen, materials, libraryError, loading, placingId, pick };
}
