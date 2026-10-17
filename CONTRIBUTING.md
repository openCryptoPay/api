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
- `bun run build`
- `bun run e2e` — HTTP checks against `GET /`, `GET /healthz`, `/map/places`, and `/admin/places`

Do not lower a coverage threshold to land a change. A genuinely unreachable branch needs a `v8 ignore` comment that says why.

## CI / CD

| Workflow               | Trigger                                                               | Action                                                                  |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ci.yaml`              | Pull request, and push to `develop`                                   | Typecheck, lint, handbook, e2e-check, test (100% coverage), build, e2e  |
| `publish-dev.yaml`     | Push to `develop`, except Markdown-only, or a manual run on `develop` | Build and push `dfxswiss/opencryptopay-api:beta`                        |
| `publish-prd.yaml`     | Push to `main`, except Markdown-only, or a manual run on `main`       | Build and push `dfxswiss/opencryptopay-api:latest`                      |
| `auto-release-pr.yaml` | Push to `develop`                                                     | Open the release pull request (`develop` → `main`) when there is a diff |

Images are `linux/arm64`. The publish workflows push the image and do not deploy it.

Publish workflows need these Actions secrets:

| Secret            | Purpose                                                                     |
| ----------------- | --------------------------------------------------------------------------- |
| `DOCKER_USERNAME` | Docker Hub username for the push                                            |
| `DOCKER_PASSWORD` | Docker Hub access token with read and write on `dfxswiss/opencryptopay-api` |
