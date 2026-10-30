# Recall Loop 0.1

A web-first study workspace for learners who want a focused review loop. Create subject folders, keep related notes and files together, then study from one selected file or the subject as a whole. Each learner's materials and progress stay in that browser; the shared website does not contain their study content.

## Run locally

```bash
npm install
npm run web
```

## Build the shareable web app

```bash
npm run build:web
```

This creates the static site in `dist/`. The repository includes Vercel settings for this export. To host it free and have it update after pushes to GitHub:

1. In Vercel, import the GitHub repository `jaexmachine/recall-loop`.
2. Keep the repository root as the project root and select `main` for production deploys.
3. Deploy. The Vercel configuration runs the web export and serves `dist/` as the static site.

Vercel gives the site a shareable `*.vercel.app` address. Each push to `main` triggers a new build and updates the live site. A pull request gets a preview deploy before it reaches the live version.

## Included in 0.1

- Cram, Steady, and Deep study paths.
- Subject folders with pasted notes, formative questions, and uploaded source files.
- Source upload for PDF, DOCX, PPTX, TXT, and Markdown files, extracted in the browser.
- Choose one source file, just pasted notes, or all source material in a subject as the study baseline.
- Transparent keyword matching from questions to source paragraphs.
- Review suggested links, move them to another paragraph, or clear them.
- Start with retrieval, open a linked source after a miss, then retry.
- Recent attempts and progress metrics saved in browser local storage.
- Original uploads kept in browser IndexedDB so source links can reopen PDFs at their page and show extracted passages for DOCX/PPTX/text files.
- Private ZIP backup and restore for folders, notes, questions, progress, and originals.
- Clear workspace confirmation before deleting saved folders and progress.
- Responsive web interface with reduced-motion-aware visual effects.

## Limits of this release

- Text extraction runs locally in the browser; study files are not uploaded to the hosting provider. Scanned PDFs that contain only images need OCR and cannot be read yet.
- Large extracted files are limited to keep browser storage usable. Files over 20 MB or extracted text over the browser workspace limit are rejected.
- Matching and practice-question drafting use local heuristics, not an AI model. Suggested links must be verified, and custom answers are not automatically graded.
- Materials and progress are stored separately in each browser profile. There is no account or automatic cloud sync yet.
- Backup ZIPs contain private study content and original documents. Keep them somewhere secure. Browser storage is not shared between devices unless you move a backup.
- Android packaging and native file picking are not included in this web-first build.
- Register is a visual placeholder and does not create an account.
