# Contributing

The map API keeps the same gates as the 21.gifts API.

## Branches

| Branch    | Purpose                                                  |
| --------- | -------------------------------------------------------- |
| `develop` | Integration branch. Open pull requests here.             |
| `main`    | Production. Moves only through the release pull request. |

- Land work on `develop` through a feature branch and a pull request. Do not push `develop` or `main` directly.
- A push to `develop` runs CI on that commit. The release pull request shows that same CI run.
- This repository does not publish a container image.
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
- `bun run e2e` — HTTP checks against `GET /healthz` and `/map/places`

Do not lower a coverage threshold to land a change. A genuinely unreachable branch needs a `v8 ignore` comment that says why.

## CI / CD

| Workflow               | Trigger                             | Action                                                                  |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `ci.yaml`              | Pull request, and push to `develop` | Typecheck, lint, handbook, e2e-check, test (100% coverage), build, e2e  |
| `auto-release-pr.yaml` | Push to `develop`                   | Open the release pull request (`develop` → `main`) when there is a diff |
