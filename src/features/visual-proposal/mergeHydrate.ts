import type { VisualProposal } from "./store";

/**
 * IndexedDB hydrate must not wipe a working layer that startComposeEditing
 * just wrote into memory. Keep the newer doc per id; keep memory-only docs.
 */
export function mergeProposalDocsForHydrate(
  memory: VisualProposal[],
  saved: VisualProposal[],
): VisualProposal[] {
  const byId = new Map<string, VisualProposal>();
  for (const doc of saved) byId.set(doc.id, doc);
  for (const doc of memory) {
    const prev = byId.get(doc.id);
    if (!prev || doc.updatedAt >= prev.updatedAt) byId.set(doc.id, doc);
  }
  return [...byId.values()];
}

export function mergeActiveByVersionForHydrate(
  memory: Record<string, string>,
  saved: Record<string, string>,
  docs: VisualProposal[],
): Record<string, string> {
  const next: Record<string, string> = { ...saved, ...memory };
  for (const [versionId, docId] of Object.entries(next)) {
    const ok = docs.some((doc) => doc.id === docId && doc.versionId === versionId);
    if (ok) continue;
    const fallback = docs.find((doc) => doc.versionId === versionId);
    if (fallback) next[versionId] = fallback.id;
    else delete next[versionId];
  }
  return next;
}
