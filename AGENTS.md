# AGENTS.md

Logbook is ProjectTogether's open-source log of decisions, updates, and
learnings, with a consent-based decision process. User documentation is in
`docs/`; contributor setup and the checks are in `CONTRIBUTING.md`.

## Stack

Next.js 16 (App Router, Server Actions, `src/proxy.ts`), Node.js 26, npm,
strict TypeScript, PostgreSQL 18 with Drizzle ORM (`pg` driver), Better Auth
with one OpenID Connect provider (PKCE), pg-boss worker, zod 4, Tailwind 4
with shadcn/ui components (Radix) in `src/components/ui/` and
ProjectTogether's colors, sonner, pino, Vitest, Playwright, Prettier.

## Layout

- `src/app/`: routes. Pages, Server Actions, and route handlers stay thin:
  check access, validate input with zod, call a module.
- `src/components/ui/`: the shadcn/ui components (`@/components/ui/<name>`),
  `cn` (`utils.ts`), the theme with ProjectTogether's colors (`styles.css`,
  imported in `src/app/globals.css`), the light and dark switch (`theme.ts`),
  the toaster (root layout), and the frame (`app-frame.tsx` with `frame/`:
  sidebar, search, header, breadcrumbs, user menu, keys). Use them for every
  control, list, and panel, and keep them close to shadcn/ui.
  `LogbookFrame` in `src/components/logbook-frame.tsx` fills the frame; its
  items and breadcrumbs come from `src/lib/navigation.ts`. Pages use `Page`
  and `PageHeader` from `@/components/ui/page`. `src/components/brand.tsx`:
  the app icon (Lucide's notebook-pen on PT Sky, also `src/app/icon.svg`) and
  ProjectTogether's logo (`src/assets/projecttogether-logo.png`).
- `src/lib/<module>/`: `auth`, `directory` (manual and Keycloak directory),
  `db`, `entries`, `process`, `calendar`, `audit`, `health`, `jobs` (queues,
  schedules, and `Stopping`, which tells the worker's loops that it stops),
  `security`, `notifications`, `measures`, `webhooks`, `csv-import`,
  `integrations` (Slack, email, and the webhook: Admin › Integrations and
  `cli settings`).
- `src/workers/`: the pg-boss worker. `src/scripts/`: migrate, directory
  sync, and the CSV import. `src/cli/`: the operator command (`cli` in the
  image). All are bundled with esbuild into `dist/`.
- `drizzle/`: SQL migrations. `e2e/`: Playwright. `tests/`: test helpers and
  fixtures. Unit tests sit next to the code (`*.test.ts`), integration tests
  too (`*.int.test.ts`).

## Rules

- Every page, Server Action, and route handler calls `requireUser()` or
  `requireAdmin()` from `src/lib/auth/session.ts`. Layouts do not re-render
  on navigation, so a check in a layout is not enough.
- Sign-in, the OIDC callback, the session behind a request, and sign-out go
  through `getLogbookAuth()` in `src/lib/auth/auth.ts`; nothing else calls
  Better Auth. Reading a session can end it: when its person lost access or
  the OIDC subject, `requestSession` deletes it and `requireUser()` shows
  `/no-access`.
- Never delete Logbook data. The only exceptions are unsubmitted drafts and
  Better Auth sessions. Triggers in `drizzle/0001_no_deletion.sql` enforce it,
  and the audit log is append-only. People who leave lose access; teams and
  tags are deactivated.
- Entry writes go through `src/lib/entries/commands.ts`: one transaction per
  write. A command checks, writes, and states its effects (audit event,
  search text, channel post, addendum messages, webhook); `writeEntry` runs
  them in one fixed order. Server Actions validate with the zod schemas
  in `src/lib/entries/schemas.ts`, which the forms share, and call
  `consumeRateLimit` first. Content forms require the personal data
  confirmation; the server checks it again.
- Proposal status changes only through `src/lib/process/commands.ts`. The
  rules of the decision process (`docs/decision-process.md`) live as pure
  functions in `src/lib/process/rules.ts` (table-tested); commands lock the
  proposal, check the rules, write, and state their effects (audit events,
  the process event, search text, webhook) in one transaction.
  `withProposal` reloads the proposal once and runs them in one fixed order,
  including `ready_since` (`nextReadySince` in the rules). The UI asks the
  same rules what to show.
- Notifications are rows in `notification_delivery`, written in the
  command's transaction through `src/lib/notifications/notify.ts`, which only
  loads facts. Who gets which message is planned by pure functions in
  `src/lib/notifications/plan.ts` (tested); each delivery key names the
  event, the occurrence, and the recipient, so nothing is recorded twice. Only the worker sends
  (`dispatch.ts`): Slack for events and email for reminders, each falling back
  to the other channel when it is off or cannot reach the person. Never put the proposal text in a
  message. Messages carry dates as tokens (`dateToken`), written in each
  recipient's date format when sent.
- A command that publishes, edits, decides, supersedes, changes the impact
  of, or adds an addendum to an entry calls `requestWebhook`
  (`src/lib/webhooks/sync.ts`) in its transaction, by stating `webhook: true`
  as an effect; the worker sends. The payload mapping in `payload.ts` is a
  pure function.
- Who has access comes from the directory (`DIRECTORY`). Only
  `getDirectory()` in `src/lib/directory/directory.ts` reads it; callers ask
  the directory (`editable`, `sync`, `admitNewLogin`) instead. Two adapters:
  the manual directory (`manual.ts`, invitations linked at the first login)
  and the Keycloak sync (`keycloak-adapter.ts`, `sync.ts`). What admins may
  change about people and teams is decided in `rules.ts` (table-tested);
  `manage.ts` enforces it and the admin pages ask it. Link logins by the OIDC
  `sub`; match an email only once, and only when the provider verified it (or
  `OIDC_TRUST_EMAIL` is set). Settings without which the app cannot be used
  (the first admins, the Keycloak groups) are required in `config.ts`, so a
  deployment fails at startup instead of later.
- Deadlines, working days (Monday to Friday), reminders, and statistics use
  the server's time zone (`serverDate`, `serverDateTime` in `src/lib/format.ts`).
  Everything shown to a person uses their preferences: `getFormatter()` in
  server components, `createDateFormatter()` elsewhere.
- Form Server Actions use `handleFormAction` from `src/lib/form-actions.ts`
  (access, validation, rate limit, write, revalidate, redirect). Forms submit
  through `useFormAction`, which keeps input after a rejected submit.
- After a Server Action redirect, call `revalidatePath` for the target, or a
  redirect to the same page shows stale data.
- Change the schema in `src/lib/db/schema.ts`, then run `npm run db:generate`
  and commit the migration. CI fails if they differ.
- Slack, email, and the webhook live in the database, not in the
  environment: `src/lib/integrations/service.ts` saves, checks, seals
  (AES-256-GCM with a key derived from `BETTER_AUTH_SECRET`), audits, and
  tests them. The page's Server Actions and `cli settings` both call it; the
  command acts as the operator (`operator()` in `src/lib/audit/actor.ts`,
  created only in `src/cli/`). The worker reads them each round
  (`runtime.ts`). The webhook's URL is a secret too: show only its server
  (`urlHint`). The key's derivation never changes (a test pins it): every
  saved secret would become unreadable.
- Restarts: a deploy may restart `web` and `worker` at any time. The worker's
  loops claim one item at a time and record its result; on SIGTERM they
  finish the item at hand and take no new one (`Stopping` in
  `src/lib/jobs/stopping.ts`). Keep that when adding a loop or a job
  (`docs/deployment.md`, Restarts and deploys).
- The running installation's data must keep working: stored setting keys,
  enum values, session cookies and the sealed secrets' key derivation stay as
  they are; add only migrations that the previous image survives.
- Read application settings only through `src/lib/config.ts`, and
  operational settings (`LOG_LEVEL`, `LOGBOOK_PROCESS`,
  `WORKER_HEARTBEAT_FILE`, `MIGRATIONS_DIR`) through `envValue()` in
  `src/lib/env.ts`. Both treat blank values as unset. Framework variables
  (`NODE_ENV`, `NEXT_RUNTIME`, `TZ`) are read directly. Document every new
  variable in `docs/configuration.md`.
- Design: ProjectTogether's colors and app identity (PT Sky for buttons,
  focus and selected states, with PT Ocean text on it; links in the darker
  `--link`); the tokens are in `src/components/ui/styles.css`.
- UI text is English (US).
- Use Logbook in the UI, documentation, and notification text. Use
  `LOGBOOK_*` for environment variables, `logbook` for the default database
  and development Keycloak realm, and `Logbook-*` for webhook headers.

## Commands

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 (port 55432) and Keycloak (port 8090)
cp .env.example .env.local
npm ci
npm run db:migrate
npm run dev                                # http://localhost:3000, users erika / adam / olga, password logbook-dev
npm run worker                             # pg-boss worker in a second terminal
npm run cli -- settings list               # the operator command (docs/deployment.md)

node scripts/check-public-repository.mjs
npm run lint
npm run format:check                       # npm run format fixes it
npm run typecheck
npm test                                   # unit tests
npm run test:integration                   # needs the PostgreSQL from compose.dev.yaml
npm run build                              # Next.js standalone build and dist/ bundles
```

`compose.yaml` is the production setup, so every Compose command for the
development services needs `-f compose.dev.yaml`.

End-to-end tests run against production builds, Keycloak, and PostgreSQL:
one instance with the Keycloak directory (port 3000) and one with the manual
directory and a fresh database (port 3001). CI's `e2e` job shows the exact
steps; locally:

```sh
npm run build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/
set -a; source .env.example; set +a
export BETTER_AUTH_SECRET="$(openssl rand -base64 32)" NODE_ENV=production TZ=Europe/Amsterdam
node dist/migrate.mjs
node .next/standalone/server.js &
node dist/worker.mjs &
docker compose -f compose.dev.yaml exec postgres psql -U logbook -c "drop database if exists logbook_manual with (force)" -c "create database logbook_manual"
DATABASE_URL=postgres://logbook:logbook@localhost:55432/logbook_manual DIRECTORY=manual \
  INITIAL_ADMIN_EMAILS=adam@example.test LOGBOOK_BASE_URL=http://localhost:3001 PORT=3001 \
  sh -c 'node dist/migrate.mjs && node .next/standalone/server.js' &
DATABASE_URL=postgres://logbook:logbook@localhost:55432/logbook npm run test:e2e
```

The proposal tests move deadlines into the past in the database instead of
waiting for working days, and one test changes Keycloak group memberships
through the Admin API.

CI (`.github/workflows/ci.yaml`) scans the history for secrets, checks the
files for private artifacts and internal names, and runs lint, formatting,
typecheck, unit tests, a migration check, build, `npm audit`, integration
tests, end-to-end tests, and the Docker image with `compose.yaml`. Every
commit on `main` that passes CI is built and deployed
(`.github/workflows/deploy.yml`, `docs/deployment.md`, Builds and deploys).
No file holds the version: `package.json` stays at `0.0.0`. An app setting
(not a server setting in `docs/deployment.md`, Settings) needs a line in the
Deploy workflow's `SETTINGS`. Use only GitHub-owned actions, pinned by commit
SHA; use tools such as Docker through their command line instead. Dependabot
(`.github/dependabot.yml`) proposes updates weekly, npm packages daily.

## Content

UI text and messages are in US English; short and plain. Never commit
secrets, real personal data or data from a real organization: use
`example.org` addresses and invented content. Keep ProjectTogether's
internals (server names, addresses, internal domains, people, vault names)
out of this repository; they belong in its infrastructure repository.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
