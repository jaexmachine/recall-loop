# Recall Loop repository workflow

- Treat this directory as the source of truth for the app.
- After each requested code change, run `npx tsc --noEmit` and sync the deliverable copy at `C:\Users\Jae\Documents\Codex\2026-10-29\s\outputs\Recall Loop`.
- Once `origin` is configured and GitHub authentication is available, commit completed changes and push them to `main` as part of the same task. Use a concise commit message; never force-push.
- If the remote is missing or authentication is unavailable, keep the work committed locally when possible and tell the user exactly which setup step is needed.
- Never commit secrets, `.env` files, user study content, or browser local-storage data.
