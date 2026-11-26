import { readFile, writeFile } from 'node:fs/promises';

const indexPath = new URL('../dist/index.html', import.meta.url);
const description = 'Recall Loop turns lecture notes, PDFs, and quiz questions into AI-assisted summaries, flashcards, and focused study sessions.';
let html = await readFile(indexPath, 'utf8');

if (!/<meta\s+name=["']description["']/i.test(html)) {
  html = html.replace('</head>', `  <meta name="description" content="${description}">\n  </head>`);
}

await writeFile(indexPath, html);
