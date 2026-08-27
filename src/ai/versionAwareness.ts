import type { Version } from "../lib/types";
import { activeVersions } from "../lib/types";

/**
 * AI defaults to the latest non-archived version (改二, not 初稿) unless the
 * user asks to compare named drafts.
 */
export function currentVersion(versions: Version[]): Version | undefined {
  const live = activeVersions(versions);
  if (!live.length) return undefined;
  return [...live].sort((a, b) => {
    const byLabel = versionRank(b.label) - versionRank(a.label);
    if (byLabel) return byLabel;
    return live.indexOf(b) - live.indexOf(a);
  })[0];
}

export function versionRank(label: string): number {
  const text = label.trim();
  if (/改三|第三/.test(text)) return 3;
  if (/改二|第二|二稿/.test(text)) return 2;
  if (/改一|第一|一稿/.test(text)) return 1;
  if (/初稿|原稿|draft/i.test(text)) return 0;
  return 1;
}

export function findVersionByLabel(versions: Version[], label: string): Version | undefined {
  const needle = label.trim();
  return versions.find((version) => version.label === needle)
    ?? versions.find((version) => version.label.includes(needle));
}

const COMPARE_PAIR = /比較\s*([^\s與和]+)\s*(?:與|和|跟)\s*([^\s。？?]+)/;

export function requestedCompareLabels(query: string): string[] {
  const match = query.match(COMPARE_PAIR);
  if (!match) return [];
  return [match[1], match[2]].filter((item): item is string => Boolean(item));
}

export function versionsForQuery(versions: Version[], query: string): Version[] {
  const labels = requestedCompareLabels(query);
  if (!labels.length) {
    const current = currentVersion(versions);
    return current ? [current] : [];
  }
  return labels
    .map((label) => findVersionByLabel(versions, label))
    .filter((version): version is Version => Boolean(version));
}

export function isCurrentVersionId(versions: Version[], versionId: string): boolean {
  return currentVersion(versions)?.id === versionId;
}
