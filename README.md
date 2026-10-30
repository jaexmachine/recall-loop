# Recall Loop 0.1

A web-first study workspace for learners who need a focused, practical review loop. This release keeps materials and progress in the current browser and does not require an account.

## Run locally

```bash
npm install
npm run web
```

## Included in 0.1

- Cram, Steady, and Deep study paths.
- Paste study notes and formative questions, or upload `.txt` and `.md` files.
- Transparent keyword matching from questions to source paragraphs.
- Review suggested links, move them to another paragraph, or clear them.
- Start with retrieval, open a linked source after a miss, then retry.
- Demo questions receive objective feedback; answers for custom materials are self-rated.
- Draft practice prompts from notes using local sentence patterns. Review and edit every draft before studying.
- Recent attempts and progress metrics saved in browser local storage.
- Responsive, web-first interface with reduced-motion-aware visual effects.

## Limits of this release

- Matching and prompt drafting are local heuristics, not an AI model. Links are suggestions and must be verified.
- Custom free-response answers are not automatically graded.
- Files are limited to plain text and Markdown. PDF/DOCX extraction is not included.
- Data stays in this browser profile. There is no account, cloud sync, or backup yet.
- Android packaging, native file picking, and native persistent storage are not included in this web-first release.
- Register is a visual placeholder and does not create an account.

## Build direction

1. Test the study flow on real, permitted class materials.
2. Improve passage matching and prompt drafting against manually reviewed examples.
3. Add document parsing and native Android storage.
4. Evaluate whether an AI explanation layer improves source accuracy and learner outcomes before connecting a model.
