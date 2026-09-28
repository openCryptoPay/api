# Contributing

The map API keeps the same gates as the 21.gifts API.

## Branches

| Branch    | Purpose                                                  | Image                      |
| --------- | -------------------------------------------------------- | -------------------------- |
| `develop` | Integration branch. Open pull requests here.             | `opencryptopay/api:beta`   |
| `main`    | Production. Moves only through the release pull request. | `opencryptopay/api:latest` |

- Land work on `develop` through a feature branch and a pull request. Do not push `develop` or `main` directly.
- A push to `develop` publishes `:beta` for the dev environment and runs CI on that commit. The release pull request shows that same CI run.
- A push to `main` publishes `:latest` for production.
- `auto-release-pr.yaml` opens `Release: develop -> main` when `develop` is ahead of `main`. A normal production publish waits for that pull request. The dev and production workflows also have a manual run, and that run publishes `:beta` or `:latest` for whichever commit you start it on.
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
- `bun run e2e` — HTTP checks against `GET /healthz` and `/map/places`

Do not lower a coverage threshold to land a change. A genuinely unreachable branch needs a `v8 ignore` comment that says why.

## CI / CD

| Workflow               | Trigger                             | Action                                                                  |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `ci.yaml`              | Pull request, and push to `develop` | Typecheck, lint, handbook, e2e-check, test (100% coverage), build, e2e  |
| `deploy-dev.yaml`      | Push to `develop`                   | Build and push `opencryptopay/api:beta`, then wait for the deploy       |
| `deploy-prd.yaml`      | Push to `main`                      | Build and push `opencryptopay/api:latest`, then wait for the deploy     |
| `auto-release-pr.yaml` | Push to `develop`                   | Open the release pull request (`develop` → `main`) when there is a diff |

Images target `linux/arm64`.

Deploy workflows need these Actions secrets:

| Secret            | Purpose                                               |
| ----------------- | ----------------------------------------------------- |
| `DOCKER_USERNAME` | Registry username for the image push                  |
| `DOCKER_PASSWORD` | Registry token for the image push                     |
| `DISPATCH_TOKEN`  | Token that sends `image-published` and reads that run |
| `DISPATCH_REPO`   | `owner/repo` that receives `image-published`          |

If `DISPATCH_TOKEN` or `DISPATCH_REPO` is missing, deploy fails after the image push. The job then waits for the infrastructure run titled `image-published opencryptopay/api:<tag> <sha>` and fails when that run does not succeed.
