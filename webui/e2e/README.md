# E2E smoke rig

- Run: `npm run test:e2e` (boots API on :8799 with an isolated library at `e2e/.library`, Vite on :5199).
- Update screenshots after an intentional visual change: `npm run test:e2e:update` and commit `e2e/baselines/`.
- The fixture project is seeded via the REST API in `seed.ts`; no Gemini or pi needed.
- `e2e/.library`, `e2e/.trash`, `e2e/test-results`, `e2e/.fixture.json` are disposable and gitignored.
