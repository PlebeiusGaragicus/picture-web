# Project Guidance

## Breaking Changes Preferred

This project is in active local development and does not preserve backwards compatibility for internal schemas, storage formats, API shapes, or UI state.

- Do not add `v1`, `v2`, `v3` compatibility layers or migrations unless explicitly requested for a one-off data rescue.
- When changing `canvas.json`, asset metadata, API payloads, or TypeScript/Pydantic models, update the current shape directly.
- Remove obsolete schema branches, compatibility validators, and upgrade code instead of carrying them forward.
- Prefer clear breaking changes over shims. Existing local data can be regenerated or manually adjusted during development.
