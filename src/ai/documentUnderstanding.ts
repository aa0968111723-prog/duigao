/**
 * Document extraction and chunks.
 *
 * The production path still calls tku-zen-agent when configured. This module is
 * the in-repo DocumentUnderstandingProvider: it turns already-fetched text (or
 * a best-effort PdfReader extract) into bounded `asset_document_chunks`.
 */

export type DocumentChunkDraft = {
  asset_id: string;
  chunk_index: number;
  content: string;
  page?: number;
  heading?: string;
  start_offset: number;
  end_offset: number;
};

export type DocumentUnderstandingInput = {
  assetId: string;
  title?: string;
  mimeType?: string;
  textContent?: string;
  bytes?: Uint8Array;
};

export class PdfReader {
  /**
   * Best-effort text extraction. A full PDF parser is not bundled into the
   * phone app; when the bytes look like a PDF we pull literal strings, and
   * otherwise treat the payload as UTF-8 text.
   */
  static extractText(bytes: Uint8Array | string): string {
    if (typeof bytes === "string") return bytes;
    const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000/g, "");
    if (utf8.startsWith("%PDF")) {
      const strings = [...utf8.matchAll(/\((?:\\.|[^\\)]){2,400}\)/g)].map((match) =>
        match[0].slice(1, -1).replace(/\\n/g, "\n").replace(/\\\)/g, ")").replace(/\\\(/g, "("),
      );
      const joined = strings.join("\n").trim();
      if (joined) return joined;
    }
    return utf8;
  }
}

export class DocumentUnderstandingProvider {
  constructor(private readonly maxChunk = 3000) {}

  understand(input: DocumentUnderstandingInput): { chunks: DocumentChunkDraft[]; summary: string } {
    const raw = (input.textContent?.trim() || (input.bytes ? PdfReader.extractText(input.bytes) : "")).replace(/\r\n/g, "\n").trim();
    const chunks = chunkDocument(raw, input.assetId, this.maxChunk);
    const summary = raw ? raw.slice(0, 280).trim() : (input.title ?? "").trim();
    return { chunks, summary };
  }
}

export function chunkDocument(content: string, assetId: string, max = 3000): DocumentChunkDraft[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: DocumentChunkDraft[] = [];
  for (let offset = 0, index = 0; offset < normalized.length; offset += max, index += 1) {
    const part = normalized.slice(offset, offset + max).trim();
    if (!part) continue;
    chunks.push({
      asset_id: assetId,
      chunk_index: index,
      content: part.slice(0, 10000),
      start_offset: offset,
      end_offset: Math.min(normalized.length, offset + max),
    });
  }
  return chunks;
}
