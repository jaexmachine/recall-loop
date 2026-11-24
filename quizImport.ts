export type ImportedFlashcard = { front: string; back: string; source: string };
export type ImportedMultipleChoice = {
  question: string;
  options: string[];
  optionExplanations: string[];
  correctIndex: number;
  explanation: string;
  source: string;
  module?: string;
};

const cleanText = (value: string | null | undefined) => (value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const keyFor = (value: string) => cleanText(value).toLocaleLowerCase();

export function parseQuizResultsHtml(html: string, source: string): ImportedFlashcard[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const items = Array.from(document.querySelectorAll<HTMLElement>('[data-automation="sdk-item-wrapper"]'));
  const cards: ImportedFlashcard[] = [];

  for (const item of items) {
    const stem = cleanText(item.querySelector('.user_content.css-1c6fwkb')?.textContent || item.querySelector('.user_content')?.textContent);
    if (!stem) continue;

    const checked = Array.from(item.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'))
      .filter((input) => input.hasAttribute('checked'));
    const answers = checked.map((input) => {
      const label = input.id
        ? Array.from(item.querySelectorAll<HTMLLabelElement>('label[for]')).find((candidate) => candidate.htmlFor === input.id)
        : input.closest('label');
      if (!label) return '';
      const option = label.querySelector('.user_content.css-qgwghj') || label.querySelector('.user_content');
      return cleanText(option?.textContent || label.textContent);
    }).filter(Boolean);

    if (answers.length) cards.push({ front: stem, back: [...new Set(answers)].join(' · '), source });
  }

  return deduplicateCards(cards);
}

function deduplicateCards(cards: ImportedFlashcard[]) {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = `${keyFor(card.front)}\u0000${keyFor(card.back)}`;
    if (!card.front || !card.back || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseCsvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(value); value = '';
      if (row.some((cell) => cleanText(cell))) rows.push(row);
      row = [];
    } else value += char;
  }
  row.push(value);
  if (row.some((cell) => cleanText(cell))) rows.push(row);
  return rows;
}

export function parseFlashcardCsv(text: string, fallbackSource: string): ImportedFlashcard[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (!rows.length) return [];
  const frontHeaders = new Set(['front', 'question', 'prompt', 'term', 'q', 'cardfront', 'questiontext', 'clue']);
  const backHeaders = new Set(['back', 'answer', 'response', 'definition', 'a', 'cardback', 'answertext', 'correctanswer']);
  const sourceHeaders = new Set(['source', 'material', 'file', 'module']);
  const headers = rows[0].map((cell) => keyFor(cell).replace(/[^a-z0-9]/g, ''));
  const frontHeaderIndex = headers.findIndex((header) => frontHeaders.has(header));
  const backHeaderIndex = headers.findIndex((header) => backHeaders.has(header));
  const isHeaderRow = frontHeaderIndex >= 0 || backHeaderIndex >= 0 || headers.some((header) => sourceHeaders.has(header));
  const frontIndex = isHeaderRow ? frontHeaderIndex : 0;
  const backIndex = isHeaderRow ? backHeaderIndex : 1;
  const sourceIndex = isHeaderRow ? headers.findIndex((header) => sourceHeaders.has(header)) : 2;
  if (frontIndex < 0 || backIndex < 0 || (!isHeaderRow && rows.some((row) => row.length < 2))) return [];

  const cards = (isHeaderRow ? rows.slice(1) : rows).map((row) => ({
    front: cleanText(row[frontIndex]),
    back: cleanText(row[backIndex]),
    source: cleanText(sourceIndex >= 0 ? row[sourceIndex] : '') || fallbackSource,
  }));
  return deduplicateCards(cards);
}

const normalizeHeader = (value: string) => keyFor(value).replace(/[^a-z0-9]/g, '');

function correctOptionIndex(value: string, options: string[]) {
  const normalized = cleanText(value).toLocaleLowerCase().replace(/[.)\s]+$/, '');
  if (!normalized) return -1;
  const labeledText = normalized.match(/^(?:option\s*)?([a-z])[.)]\s+(.+)$/i)?.[2];
  if (labeledText) {
    const byText = options.findIndex((option) => cleanText(option).toLocaleLowerCase() === labeledText);
    if (byText >= 0) return byText;
  }
  const letter = normalized.match(/^(?:option\s*)?([a-z])(?:[.)])?$/i);
  if (letter) {
    const index = letter[1].toUpperCase().charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) return index;
  }
  const number = normalized.match(/^(?:option\s*)?(\d+)$/i);
  if (number) {
    const index = Number(number[1]) - 1;
    if (index >= 0 && index < options.length) return index;
  }
  return options.findIndex((option) => cleanText(option).toLocaleLowerCase() === normalized);
}

export function parseMultipleChoiceCsv(text: string, fallbackSource: string): ImportedMultipleChoice[] {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeHeader);
  const questionIndex = headers.findIndex((header) => ['question', 'prompt', 'q', 'questiontext'].includes(header));
  const answerIndex = headers.findIndex((header) => ['correctanswer', 'correctanswerkey', 'correct', 'answer', 'answerkey', 'key', 'correctoption'].includes(header));
  const explanationIndex = headers.findIndex((header) => ['explanation', 'rationale', 'feedback'].includes(header));
  const sourceIndex = headers.findIndex((header) => ['source', 'material', 'file', 'module'].includes(header));
  const moduleIndex = headers.findIndex((header) => ['module', 'topic', 'section'].includes(header));
  const optionIndices = headers.map((header, index) => {
    const letter = header.match(/^(?:option|choice|answer|opt)?([abcd])$/)?.[1];
    const numbered = header.match(/^(?:option|choice|answer|opt)([1-9])$/)?.[1];
    return letter || numbered ? { index, sort: letter ? letter.charCodeAt(0) - 97 : Number(numbered) - 1 } : null;
  }).filter((entry): entry is { index: number; sort: number } => entry !== null).sort((a, b) => a.sort - b.sort);
  const optionsCellIndex = headers.findIndex((header) => ['options', 'choices', 'answers'].includes(header));
  if (questionIndex < 0 || answerIndex < 0 || (!optionIndices.length && optionsCellIndex < 0)) return [];

  return rows.slice(1).flatMap((row) => {
    const question = cleanText(row[questionIndex]);
    const options = optionIndices.length
      ? optionIndices.map(({ index }) => cleanText(row[index]))
      : cleanText(row[optionsCellIndex]).split(/\s*\|\s*|\s*;\s*/).map(cleanText);
    const correctIndex = correctOptionIndex(row[answerIndex] || '', options);
    if (!question || options.length < 2 || options.some((option) => !option) || correctIndex < 0) return [];
    return [{
      question,
      options,
      optionExplanations: options.map((_, index) => index === correctIndex ? cleanText(explanationIndex >= 0 ? row[explanationIndex] : '') : ''),
      correctIndex,
      explanation: cleanText(explanationIndex >= 0 ? row[explanationIndex] : ''),
      source: cleanText(sourceIndex >= 0 ? row[sourceIndex] : '') || fallbackSource,
      ...(moduleIndex >= 0 && cleanText(row[moduleIndex]) ? { module: cleanText(row[moduleIndex]) } : {}),
    }];
  });
}

export function parsePracticeQuizHtml(html: string, fallbackSource: string): ImportedMultipleChoice[] {
  const dataMatch = html.match(/\b(?:const|let|var)\s+DATA\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!dataMatch) return [];
  try {
    const modules = JSON.parse(dataMatch[1]) as Array<{ n?: string; title?: string; qs?: Array<{ q?: string; a?: number | string; o?: Array<{ t?: string; e?: string }> }> }>;
    return modules.flatMap((module) => (module.qs || []).flatMap((item) => {
      const options = (item.o || []).map((option) => cleanText(option.t || '')).filter(Boolean);
      const correctIndex = typeof item.a === 'number' ? item.a : correctOptionIndex(String(item.a ?? ''), options);
      if (!cleanText(item.q) || options.length < 2 || correctIndex < 0 || correctIndex >= options.length) return [];
      return [{
        question: cleanText(item.q),
        options,
        optionExplanations: (item.o || []).map((option) => cleanText(option.e || '')),
        correctIndex,
        explanation: cleanText(item.o?.[correctIndex]?.e || ''),
        source: fallbackSource,
        ...(cleanText(module.title || module.n) ? { module: cleanText(module.title || module.n) } : {}),
      }];
    }));
  } catch {
    return [];
  }
}
