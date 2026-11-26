# Contributing

Logbook is a Next.js app (web process and worker) in one repository.
`AGENTS.md` has the layout and the rules; this file has the setup and the
checks. Bug reports, ideas, and pull requests are welcome.

## Development setup

Requirements: Node.js 26, npm, and Docker.

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 (port 55432) and Keycloak (port 8090)
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev                                # http://localhost:3000
npm run worker                             # in a second terminal
```

`compose.yaml` is the production setup. To leave out `-f compose.dev.yaml` in
every Compose command, `export COMPOSE_FILE=compose.dev.yaml` in your shell.

Test users in the development Keycloak (password `logbook-dev`): `erika`
(has access), `adam` (admin), and `olga` (no access). The Keycloak admin
console is at http://localhost:8090 (`admin` / `admin`).

## Checks

```sh
node scripts/check-public-repository.mjs
npm run lint
npm run format:check       # npm run format fixes it
npm run typecheck
npm test                   # unit tests
npm run test:integration   # against the PostgreSQL from compose.dev.yaml
npm run build
```

End-to-end tests run against production builds; `AGENTS.md` lists the steps.
CI (`.github/workflows/ci.yaml`) runs all of these on every pull request,
scans the history for secrets (Gitleaks, `.gitleaks.toml` lists the invented
values), checks that the migrations match the schema, and builds and starts
the Docker image with `compose.yaml`.

## Conventions

`AGENTS.md` describes the architecture and the rules the code follows: where
writes happen, how access is checked, how notifications and the webhook are
recorded, and why nothing is deleted. In short:

- Keep pages and Server Actions thin; put logic in `src/lib/<module>/`, with
  tests next to it.
- Change the database schema in `src/lib/db/schema.ts` and generate the
  migration with `npm run db:generate`.
- Add or change environment variables in `src/lib/config.ts` and document
  them in `docs/configuration.md`.
- A new app setting also needs a line in the Deploy workflow's `SETTINGS`
  (`docs/deployment.md`, Settings).
- Change the webhook payload only together with `docs/webhooks.md`, and
  label the pull request `breaking` when receivers must change.
- UI text is English (US), short and plain.

## Pull requests

- One topic per pull request, with tests for new behavior. Write the title
  as one plain line of what changes.
- Describe what changes for users and admins, and how you tested it. Label
  a pull request `breaking` when the people who run the app must act on it,
  and describe the steps in it. Update the docs when behavior or
  configuration changes.
- Never commit secrets, real personal data, or data from a real organization,
  also not in tests and fixtures. Use `example.org` addresses.

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens pull requests for npm (checked
daily), GitHub Actions, the Docker base image, and the Compose images
(weekly). Minor and patch updates come grouped; a major update comes alone
and may need code changes. Two versions it cannot see; update them by hand
in the same pull request:

- `NODE_VERSION` in `.github/workflows/ci.yaml`, with the `node` image in the
  `Dockerfile`.
- The Keycloak image in `.github/workflows/ci.yaml`, with the one in
  `compose.dev.yaml`.

## Builds and deploys

Every commit on `main` that passes CI is built and deployed; there are no
releases, and no file holds the version (`package.json` stays at `0.0.0`).
The Deploy workflow (`.github/workflows/deploy.yml`) builds
`ghcr.io/projecttogether/logbook` with `APP_VERSION` set to the first 12
characters of the commit, pushes it as `sha-<commit>` and `latest`, and sends
it to the server of the GitHub environment `production`
([deployment](docs/deployment.md#builds-and-deploys)). Merging deploys:
take steps that must come first before merging.

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
