# Contributing

The map API keeps the same gates as the 21.gifts API.

## Branches

| Branch    | Purpose                                                  | Image                               |
| --------- | -------------------------------------------------------- | ----------------------------------- |
| `develop` | Integration branch. Open pull requests here.             | `dfxswiss/opencryptopay-api:beta`   |
| `main`    | Production. Moves only through the release pull request. | `dfxswiss/opencryptopay-api:latest` |

- Land work on `develop` through a feature branch and a pull request. Do not push `develop` or `main` directly.
- A push to `develop` publishes `dfxswiss/opencryptopay-api:beta`, except a push that changes only Markdown, and runs CI on that commit. The release pull request shows that same CI run. A manual run publishes only when it is started on `develop`.
- A push to `main` publishes `dfxswiss/opencryptopay-api:latest`, except a push that changes only Markdown. A manual run publishes only when it is started on `main`.
- `auto-release-pr.yaml` opens `Release: develop -> main` when `develop` is ahead of `main`.
- Never force-push, and never amend a published commit.

## Commit messages

English, concise, and about what changed.

## Checks

Before a change is ready, run the same commands CI runs. Bun is pinned to `1.3.14` in CI.

- `bun run typecheck`
- `bun run lint` (ESLint and Prettier)
- `bun run handbook:check` — every exported function and every HTTP route has a handbook section
- `bun run e2e:check` — every exported function and every HTTP route has an end-to-end title or request
- `bun run test:coverage` — 100 percent lines, branches, functions, and statements under `src`, except `src/index.ts`
- `bun run test:schema` — `docs/database/` matches the schema `SqliteMapPlaceStore` creates at boot (regenerate with `bun run db:docs`)
- `bun run build`
- `bun run e2e` — HTTP checks against `GET /`, `GET /healthz`, and `/map/places`

Do not lower a coverage threshold to land a change. A genuinely unreachable branch needs a `v8 ignore` comment that says why.

## Database

- **Schema reference.** `docs/database/` is generated from the schema `SqliteMapPlaceStore` creates at boot: every table and column with kind, SQLite type, nullable, default, foreign key, and indexes. Regenerate it with `bun run db:docs` in the same pull request as any schema change. The CI step "Database schema reference" (`bun run test:schema`) fails when the committed pages differ. A new table also needs an entry in `TABLE_TYPES` in `integration/db-schema-reference.ts` (a TypeScript type, or `null`). Do not edit `docs/database/` by hand. `docs/schema/map-place.sql` stays the hand-written DDL.
- **Database change notice.** A pull request into `develop` that changes the database or database access must contain the exact line `⚠️ 🗄️ Attention: database change` in the visible part of its description (not inside `<details>`, an HTML comment, or a code fence). The check "Database change notice" fails otherwise and runs again when the pull request text is edited. It triggers on changes under `docs/schema/`, `docs/database/`, `integration/`, on `src/lib/map/sqlite.ts` and `src/lib/map/store.ts`, and on non-test `src/**/*.ts` diffs that add or remove SQL or database calls (`_SCHEMA_SQL`, `.exec(`, `.query(`, `.prepare(`, `.run(`, `new Database(`, `PRAGMA`, `SELECT … FROM`, `INSERT INTO`, `UPDATE … SET`, `DELETE FROM`, `CREATE`/`ALTER`/`DROP`, `ON CONFLICT`).

## CI / CD

| Workflow                | Trigger                                                               | Action                                                                                            |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ci.yaml`               | Pull request, and push to `develop`                                   | Typecheck, lint, handbook, e2e-check, test (100% coverage), database schema reference, build, e2e |
| `db-change-notice.yaml` | Pull request into `develop` (opened, edited, synchronize, reopened)   | Require the database change notice                                                                |
| `publish-dev.yaml`      | Push to `develop`, except Markdown-only, or a manual run on `develop` | Build and push `dfxswiss/opencryptopay-api:beta`                                                  |
| `publish-prd.yaml`      | Push to `main`, except Markdown-only, or a manual run on `main`       | Build and push `dfxswiss/opencryptopay-api:latest`                                                |
| `auto-release-pr.yaml`  | Push to `develop`                                                     | Open the release pull request (`develop` → `main`) when there is a diff                           |

Images are `linux/arm64`. The publish workflows push the image and do not deploy it.

Publish workflows need these Actions secrets:

| Secret            | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `DOCKER_USERNAME` | Docker Hub username for the push                                            |
| `DOCKER_PASSWORD` | Docker Hub access token with read and write on `dfxswiss/opencryptopay-api` |
