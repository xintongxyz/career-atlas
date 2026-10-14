# Contributing

Thanks for helping improve Career Atlas.

## Ground rules

- **No personal data, ever.** Do not commit real job applications, resumes, contacts, emails, database exports, screenshots with personal information, tokens or deployment logs. Fixtures must be fictional and use `example.com`, `example.test` or similar domains.
- **Security issues** must be reported privately (see [SECURITY.md](SECURITY.md)).
- Keep the product principles: capture first, human in the loop, evidence over guessing, private by default, source preservation, bilingual from the start.

## Development

```bash
npm install
npm run dev                                          # dev database in .dev-data/, http://127.0.0.1:5173
CAREER_ATLAS_INSTANCE=dev npm run local -- seed-demo # optional fictional data (stop the dev server first)
```

Never develop or test against your personal database (`npm run start:local`).

Before opening a PR:

```bash
npm run typecheck && npm test && npm run build && npm run check:secrets
npm run test:e2e
```

## Conventions

- **TypeScript strict.** Validate API input with zod (`src/shared/schemas.ts`).
- **Business rules belong in `src/server/services`.** Routes stay thin.
- **Status changes** go only through `services/pipeline.ts › changeStatus`.
- **Database changes:**
  1. Edit `src/server/db/schema.ts`.
  2. Run `npm run db:generate`.
  3. Commit the generated SQL in `migrations/`.
  4. Never edit an applied migration.
- **UI text:** add every string to both `src/client/i18n/locales/en.ts` and `zh-CN.ts`. In Chinese, don't insert spaces between Chinese and Latin text or numbers.
- **Accessibility:** keyboard reachable, visible focus, labels on every input, and color is never the only signal.
- **Dependencies:** pin exact versions (at least two weeks old); avoid native modules (SQLite comes from `node:sqlite`) and anything that needs a cloud service.

## Commit / PR

Small, focused PRs with a clear description. CI must be green. PRs never run deploy workflows or receive secrets.
