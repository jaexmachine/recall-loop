export type SourceChunkInput = { sourceId: string; sourceName: string; label: string; text: string };
export type VectorRecord = SourceChunkInput & {
  id: string;
  subjectId: string;
  contentHash: string;
  provider: 'gemini' | 'openai';
  model: 'gemini-embedding-001' | 'text-embedding-3-small';
  embedding: number[];
};
export type VectorSearchResult = VectorRecord & { score: number };

export function chunkSourceText(input: SourceChunkInput, maxLength = 1100, overlap = 180): SourceChunkInput[] {
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) return [];
  if (text.length <= maxLength) return [{ ...input, text }];

  const chunks: SourceChunkInput[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('. ', end), text.lastIndexOf('? ', end), text.lastIndexOf('! ', end), text.lastIndexOf('; ', end));
      if (boundary > start + maxLength * 0.55) end = boundary + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push({ ...input, text: chunk });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  const divisor = Math.sqrt(leftMagnitude * rightMagnitude);
  return divisor ? dot / divisor : 0;
}

export function searchVectorRecords(query: number[], records: VectorRecord[], limit = 5): VectorSearchResult[] {
  return records
    .map((record) => ({ ...record, score: cosineSimilarity(query, record.embedding) }))
    .filter((record) => Number.isFinite(record.score) && record.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
