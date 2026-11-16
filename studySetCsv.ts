import type { AiStudySet } from './ai';

function csvCell(value: string) {
  return `"${String(value || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function csvDocument(rows: string[][]) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
}

export function flashcardCsv(studySet: AiStudySet) {
  return csvDocument([
    ['Front', 'Back'],
    ...studySet.cards.map(({ front, back }) => [front, back]),
  ]);
}

export function quizCsv(studySet: AiStudySet) {
  return csvDocument([
    ['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct answer', 'Explanation', 'Source'],
    ...studySet.quiz.map(({ question, options, answer, explanation, source }) => [question, ...options, answer, explanation, source]),
  ]);
}
