export type ImportedFlashcard = { front: string; back: string; source: string };

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
  if (rows.length < 2) return [];
  const headers = rows[0].map((cell) => keyFor(cell).replace(/[ _-]/g, ''));
  const frontIndex = headers.findIndex((header) => ['front', 'question', 'prompt'].includes(header));
  const backIndex = headers.findIndex((header) => ['back', 'answer', 'response'].includes(header));
  const sourceIndex = headers.findIndex((header) => ['source', 'material', 'file'].includes(header));
  if (frontIndex < 0 || backIndex < 0) return [];

  return deduplicateCards(rows.slice(1).map((row) => ({
    front: cleanText(row[frontIndex]),
    back: cleanText(row[backIndex]),
    source: cleanText(sourceIndex >= 0 ? row[sourceIndex] : '') || fallbackSource,
  })));
}
