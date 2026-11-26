# Deployment

For the person who runs Logbook on a Linux server, such as a VPS with Debian
or Ubuntu: [what runs](#what-runs), [setup](#setup),
[settings from the command line](#settings-from-the-command-line),
[health checks](#health-checks), [operations](#operations),
[restarts and deploys](#restarts-and-deploys), [upgrades](#upgrades),
[builds and deploys](#builds-and-deploys), and the
[CSV import of old entries](#importing-old-entries-from-a-csv-file). Every
environment variable is described in [Configuration](configuration.md).

## What runs

The [Deploy workflow](#builds-and-deploys) builds the image
`ghcr.io/projecttogether/logbook` (linux/amd64) from every commit on `main`
that passes CI, tagged `sha-<commit>` and `latest`. There are no numbered
releases: the commit is the version. `LOGBOOK_IMAGE_TAG` in `.env` picks the
image: `latest` (the default) or `sha-<commit>` for one build. The image's
command selects the process:

| Command          | What it does                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrate`        | Applies the SQL migrations in `drizzle/`, then exits. Run it before `web` and `worker` start, on every deployment                                                     |
| `web`            | The Next.js server on port 3000                                                                                                                                       |
| `worker`         | Background jobs: notifications, reminders, the webhook, and the Keycloak directory sync. One is enough; more can run, since jobs are coordinated through the database |
| `directory-sync` | Runs one Keycloak directory sync, then exits                                                                                                                          |
| `cli`            | The operator command: sets Slack, email, and the webhook without a browser ([settings from the command line](#settings-from-the-command-line))                        |

The CSV import runs with `node dist/import-entries.mjs`
([below](#importing-old-entries-from-a-csv-file)).

| File                    | Contains                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command picks the process                                    |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`) and the `worker`                   |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own |
| `compose.dev.yaml`      | Development only: PostgreSQL and Keycloak                                   |

Logbook needs PostgreSQL 18. Background jobs (pg-boss) keep their tables in
the `pgboss` schema of the same database. The image runs as an unprivileged
user (uid 1000). `compose.postgres.yaml` keeps the database in the volume
`postgres-data`.

Put a reverse proxy that terminates TLS in front of `web` (Caddy, see
[setup](#setup)) and use its public URL as `LOGBOOK_BASE_URL`. Use exactly
that URL: sign-in redirects and links in messages are built from it. `web`
answers on `127.0.0.1:3000` of the host, on the server only. When another
service holds that port (Docker reports `port is already allocated`), set
`LOGBOOK_PORT` to a free one, and give each app its own site in the
Caddyfile.

Set `TZ` to your organization's time zone (default UTC): deadlines end at
23:59, and reminders go out at 09:00, in that zone.

### Building the image yourself

To run your own build, for example of a change that is not on `main` yet,
build the image from a clone of the repository and give it a tag of its own:

```sh
docker build -t ghcr.io/projecttogether/logbook:local .
# In .env: LOGBOOK_IMAGE_TAG=local
docker compose up -d
```

## Setup

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files:**

   ```sh
   git clone https://github.com/projecttogether/logbook.git /srv/logbook
   cd /srv/logbook
   ```

3. **Register Logbook at your provider** with the redirect URI
   `<LOGBOOK_BASE_URL>/api/auth/callback/oidc`
   ([identity and access](identity-and-access.md#openid-connect-login)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set the production values
   ([configuration](configuration.md)): `LOGBOOK_BASE_URL`, `DATABASE_URL`, a
   new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), the `OIDC_*`
   variables, and `DIRECTORY` with its settings. Remove
   `NOTIFICATION_TRANSPORT` (production sends for real). Slack, email, and the
   webhook are not set here: see step 7. Keep a copy of `.env` apart from the
   server: `BETTER_AUTH_SECRET` opens the secrets the database stores.

   Without a PostgreSQL of your own, set these values for the database.
   `COMPOSE_FILE` makes every `docker compose` command also use
   [`compose.postgres.yaml`](../compose.postgres.yaml), which runs PostgreSQL
   18 next to Logbook and keeps its data in the volume `postgres-data`:

   ```sh
   COMPOSE_FILE=compose.yaml:compose.postgres.yaml
   # openssl rand -hex 32: no characters that would need escaping in the URL
   POSTGRES_PASSWORD=<password>
   DATABASE_URL=postgres://logbook:<password>@postgres:5432/logbook
   ```

   PostgreSQL uses `POSTGRES_USER`, `POSTGRES_DB` (both default to
   `logbook`), and `POSTGRES_PASSWORD` when it initializes the volume. For an
   existing volume, set them to the role, database, and password already in
   use.

5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and put this site into `/etc/caddy/Caddyfile`, in
   place of the package's example site `:80` and next to the sites of other
   apps:

   ```text
   logbook.example.org {
       reverse_proxy 127.0.0.1:3000
   }
   ```

   With another `LOGBOOK_PORT`, use that port. Then `systemctl reload caddy`.
   Caddy gets the certificate itself.

7. Open `LOGBOOK_BASE_URL`, sign in, and set up people and teams
   ([manual directory](identity-and-access.md#manual-directory) or
   [Keycloak directory](identity-and-access.md#keycloak-directory)). Set up
   Slack, email, and the webhook under **Admin › Integrations**, or on the
   server with [`cli settings`](#settings-from-the-command-line).

## Settings from the command line

Everything under **Admin › Integrations** can also be set on the server,
without a browser, with the operator command `cli`. It runs the page's own
code: the same checks, the same encryption, and the same audit log, which
names the actor `operator` and the command. It starts no server, and exits.

```sh
cd /srv/logbook
docker compose run --rm -T migrate cli settings list
```

In a running container, the command is just `cli …`
(`docker compose exec web cli settings list`).

| Command                                  | What it does                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `cli settings list [--json]`             | Each setting: `set`, `not set`, or `incomplete`, with hints such as `token …a1b2`. Never a secret |
| `cli settings show <name>`               | The setting as JSON, as the page shows it: secrets only as hints                                  |
| `cli settings apply <name>`              | Saves the JSON body on stdin, as the page's **Save** does; prints what `show` prints              |
| `cli settings test slack`                | Checks the bot token with Slack and posts a test message to the channel                           |
| `cli settings test email --to <address>` | Sends a test email to the address                                                                 |
| `cli help`                               | The commands and the setting names                                                                |

- Settings: `slack`, `email`, and `webhook`.
- Secrets go only in the body on stdin, never in an argument (arguments show
  in `ps` and the shell history). Nothing prints a saved secret. A body
  pasted into a terminal is not shown: paste it, then press Ctrl-D.
- `apply` replaces the whole setting, as the page does: start from what
  `show` prints, which `apply` takes back. As on the page, a missing or
  empty secret (the webhook's URL is one) keeps the saved one; `null`
  removes it. An `email` body without `smtp` keeps the saved SMTP settings.
- Exit codes: `0` done; `1` refused, with the page's message and the field
  on stderr; `2` a wrong command or a body that is not JSON.
- Logbook has no lists of settings and issues no tokens, so there is no
  `cli settings remove` and no `cli tokens`.
- The command needs `BETTER_AUTH_SECRET` to store a secret. `compose.yaml`
  passes it to every service.

The bodies, as the Integrations page sends them:

`slack`: the bot token (`xoxb-…`) of a Slack app with the scopes
`chat:write`, `users:read`, and `users:read.email`, and the ID of the channel
for one post per new entry (optional; invite the app to it).

```json
{ "botToken": "<bot token>", "channelId": "C0123456789" }
```

`email` over SMTP (`security`: `tls` on port 465, `starttls` on 587,
`auto` for STARTTLS only when the server offers it, or `none`). Leave out
`username` and `password` for a server without login. A changed `host`, or
weaker `security`, needs the password again. `fromName` defaults to
`Logbook`. `{"provider": "none"}` turns email off.

```json
{
  "provider": "smtp",
  "fromAddress": "logbook@example.org",
  "fromName": "Logbook",
  "smtp": {
    "host": "mail.example.org",
    "port": 587,
    "security": "starttls",
    "username": "logbook@example.org",
    "password": "<password>"
  }
}
```

`email` over MailerSend (an API token with email sending access):

```json
{
  "provider": "mailersend",
  "fromAddress": "logbook@example.org",
  "fromName": "Logbook",
  "mailersend": { "token": "<API token>" }
}
```

`webhook`: the URL that receives published entries, and the secret that
signs each request ([webhook](webhooks.md)), at least 16 characters, such as
the one the receiver shows. Both are secrets; of the URL, Logbook shows
only the server. `{"url": null}` turns the webhook off. The webhook has no
test.

```json
{ "url": "https://hooks.example.org/logbook", "secret": "<signing secret>" }
```

AI with access to the server sets a key this way: it receives the secret as
a file, pipes the body into `cli settings apply`, runs `cli settings test`,
and deletes the file. With `jq`, the secret never appears in an argument:

```sh
jq -n --rawfile token slack-token '{botToken: ($token | rtrimstr("\n")), channelId: "C0123456789"}' \
  | docker compose run --rm -T migrate cli settings apply slack
docker compose run --rm -T migrate cli settings test slack
rm slack-token
```

## Health checks

| Endpoint         | Meaning                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /-/healthz` | Liveness: the process answers, with the version (`version`: the commit, `null` for images built from source). No dependency checks |
| `GET /-/readyz`  | Readiness: the database answers and every migration of this build is applied. 503 otherwise                                        |

The worker writes a heartbeat file every 30 seconds;
`node dist/worker-healthcheck.mjs` fails when it is older than 90 seconds. The
admin page shows the worker's last heartbeat.

## Operations

- **Logs** are JSON lines on stdout. The `service` field names the process.
- **Admin page** (`/admin`): directory sync status, notification channels and
  failures, webhook deliveries, the default periods of the decision
  process, and the version. **Admin › Integrations** (`/admin/integrations`)
  sets up Slack, email, and the webhook; the worker picks up a change within
  seconds, without a restart.
- **Backups:** Logbook never deletes entries, people, or the audit log, so
  the database backup is the safety net. Back up the whole database,
  including the `pgboss` schema. Keep `BETTER_AUTH_SECRET` apart from the
  backups: a restore needs it, and the backups do not hold it. Stored sign-in
  tokens and the secrets of Admin › Integrations (Slack's bot token, the SMTP
  password or MailerSend's token, the webhook's URL and signing secret) are
  encrypted with it. Without it, people sign in again, and an admin enters
  those secrets again.

## Restarts and deploys

Every deploy restarts `web` and `worker`, at any time. Nothing a restart cuts
short is lost or done twice:

- **Writes happen in transactions**, together with what they cause: a
  command records its notifications (`notification_delivery`) and its
  webhook requests (`webhook_state`) in the same transaction as its change.
- **Only the worker sends.** It claims one item at a time (a message, an
  entry for the webhook) and records the result when it is done. An item
  that was not finished stays due and is sent by the next worker.
- **On SIGTERM**, the worker tells every loop at once: each finishes the
  item at hand, records it, and takes no new one. Then pg-boss stops its
  jobs, and the worker exits (`src/workers/main.ts`). `compose.yaml` gives
  it one minute (`stop_grace_period`); a message or a webhook request takes
  30 seconds at most.
- **A worker that is killed anyway** leaves its item claimed: a message
  whose transaction was not committed is due again at once, and an entry
  for the webhook after its lease of 5 minutes. Only a message that was
  handed to Slack, the mail server or the receiver in the moment of the kill
  can go out twice; receivers of the webhook store entries by ID, so a
  repeat changes nothing.
- **Schedules catch up:** reminders and the nightly webhook comparison run
  once at each start, and the directory sync too.

## Upgrades

An upgrade pulls a newer image. In `/srv/logbook`:

1. Read the pull requests merged since the running commit (**Admin →
   Version** and **Settings → About** show it). A pull request labeled
   `breaking` says what to do; take those steps.
2. Run `git pull` for the newest `compose.yaml`, then
   `docker compose up -d --pull always`. With `LOGBOOK_IMAGE_TAG` pinned to
   `sha-<commit>`, set the new commit first.

`migrate` applies new migrations before `web` and `worker` start; migrations
only move forward and keep the previous image working. Back up the database
first. An upgrade can happen at any time
([restarts and deploys](#restarts-and-deploys)). Pages show an error for the
seconds `web` restarts.

Slack, email, and the webhook live in the database only. Variables that once
held them (`SLACK_BOT_TOKEN`, `SMTP_URL`, `MAILERSEND_API_TOKEN`,
`WEBHOOK_URL`, …) are not read; delete them from `.env`. A webhook URL that
an earlier version saved in plain text is encrypted when a process starts.

## Builds and deploys

Every commit on `main` that passes CI is built and, at ProjectTogether,
deployed. There are no numbered releases: the commit is the version.

- **CI** (`.github/workflows/ci.yaml`, on every pull request and on `main`):
  the history for secrets (Gitleaks), the files for private artifacts,
  internal names and credential formats (`scripts/check-public-repository.mjs`),
  lint, formatting, types, unit tests, migration drift, the build, `npm audit`,
  the integration tests (PostgreSQL), the end-to-end tests (Keycloak,
  PostgreSQL, Playwright), and the image (started with `compose.yaml`, the
  operator command, a clean stop of the worker).
- **Deploy** (`.github/workflows/deploy.yml`), when CI passes on `main`, or
  by hand (Actions → Deploy → Run workflow), for example after a setting
  changed:
  1. It builds `ghcr.io/projecttogether/logbook` with `APP_VERSION` set to
     the first 12 characters of the commit and pushes it as `sha-<commit>`
     and `latest`.
  2. It sends the image and the app's settings to the server of the GitHub
     environment `production` over SSH. The server's deploy script pulls the
     image, writes the settings, runs the migrations, starts `web` and
     `worker`, waits until both are healthy, and puts the previous image and
     settings back when they do not become healthy. One deploy runs at a
     time; a newer one waits.

Without the variable `DEPLOY_HOST` in the environment `production`, step 2
deploys nothing. Label a pull request `breaking` when the people who run the
app must act on it, and write the steps into its description; merging
deploys it, so take steps that must come first before merging.

The package `logbook` in GitHub's container registry must be public, so that
servers can pull it without a token: an owner of the organization sets that
once, after the first build.

### Settings

The settings come from two places:

- **Server settings**, written on the server by its own configuration
  (ProjectTogether's infrastructure repository): `LOGBOOK_BASE_URL`,
  `DATABASE_URL`, `POSTGRES_PASSWORD` with `compose.postgres.yaml`, `TZ`,
  `BETTER_AUTH_SECRET` (signs sessions and encrypts the stored secrets) and
  `LOGBOOK_PORT`. They win over the app settings.
- **App settings**, sent by the Deploy workflow at each deploy from the
  environment `production`, as the workflow's `SETTINGS` list names them.
  Empty values are left out, so the app's default applies. A new setting
  needs a line in `SETTINGS` and its own line below it.
  `NOTIFICATION_TRANSPORT` is for development and tests only, and not in the
  list.

| Kind      | Names                                                                                                                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets   | `DEPLOY_SSH_KEY`, `OIDC_CLIENT_SECRET`, `SENTRY_DSN`                                                                                                                                                                      |
| Variables | `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS`, `APP_URL` (the environment's link only), `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `DIRECTORY`, `KEYCLOAK_ACCESS_GROUP`, `KEYCLOAK_ADMIN_GROUP`, `KEYCLOAK_TEAMS_GROUP`, `SENTRY_ENVIRONMENT` |

Logbook reads more optional settings that the workflow does not send yet
([configuration](configuration.md)): `OIDC_SCOPES`, `OIDC_TRUST_EMAIL`,
`INITIAL_ADMIN_EMAILS` (needed with `DIRECTORY=manual`), `KEYCLOAK_CLIENT_ID`,
`KEYCLOAK_CLIENT_SECRET` and `LOG_LEVEL`. To use one, add it to `SETTINGS`
first. Elsewhere, `compose.yaml` with a plain `.env` holds both kinds of
settings ([setup](#setup)).

### Rollbacks

A deploy that does not become healthy puts the previous image back by
itself. To go back by hand, revert the change on `main`, or run the server's
rollback. Neither undoes database migrations, so a migration keeps the
previous version working: add columns with a database default, or leave
them empty.

## Importing old entries from a CSV file

`import-entries` logs updates, learnings, and decisions from before Logbook,
for example from an old decision log or a chat channel. Fill the columns of
[`entry-import-template.csv`](entry-import-template.csv) (comma or semicolon
separated, UTF-8). Unknown columns are ignored.

| Column           | Required | Content                                                                                              |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `id`             | yes      | Unique per row, e.g. the ID in the old log. A row is imported once; running again only adds new rows |
| `type`           | no       | `update`, `learning`, or `decision` (default)                                                        |
| `title`          | yes      | Up to 120 characters (longer titles are shortened)                                                   |
| `date`           | yes      | When it was published or decided: `YYYY-MM-DD` or `DD.MM.YYYY`                                       |
| `summary`        | no       | Up to 280 characters; defaults to the first paragraph of the decision text, or of the details        |
| `details`        | no       | Markdown. Shown as **Context** for a decision                                                        |
| `rationale`      | no       | Markdown. For a decision it defaults to "Imported from an earlier decision log."                     |
| `impact`         | no       | `small`, `medium`, or `large`; empty shows as "not set"                                              |
| `team`           | no       | Team name; defaults to `--team`                                                                      |
| `affected_teams` | no       | Names of active teams, separated by commas or semicolons                                             |
| `tags`           | no       | Names of active tags, separated by commas or semicolons. Create missing tags on the admin page first |
| `related`        | no       | Ids of rows above in the same file, or of entries imported before                                    |
| `links`          | no       | Up to 10 http(s) URLs, separated by spaces                                                           |

Decisions only:

| Column            | Required                         | Content                                                                             |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `decider_email`   | yes, unless `--fallback-decider` | Email address of a person with access                                               |
| `decision_text`   | no                               | The decision (Markdown); defaults to the title                                      |
| `how_decided`     | no                               | `integrative_process`, `role_decision`, `management_decision`, or `other` (default) |
| `involved_emails` | no                               | Email addresses, separated by commas, semicolons, or spaces                         |
| `reversibility`   | no                               | `two_way` or `one_way`; empty counts as two-way when the decision is replaced       |
| `why_one_way`     | no                               | Why a one-way decision is hard to reverse                                           |
| `effective_date`  | no                               | `YYYY-MM-DD` or `DD.MM.YYYY`                                                        |

Run it in the `worker` container:

1. Copy the file in, or pipe it with `--file -`:
   `docker compose exec -T worker node dist/import-entries.mjs --file - … < entries.csv`.
2. Dry run: nothing is written; every record is printed in full, followed by
   a review fingerprint.

   ```sh
   node dist/import-entries.mjs --file /tmp/entries.csv --team "<team name>" --as <your email>
   ```

   `--as` must be an admin, who becomes the author of the records. If a
   decider has no access, add `--fallback-decider <email>`.

3. Read every record. Entries are visible to everyone with access, so leave
   out rows with personal data (`--skip <id>`, repeatable) or fix the file.
4. Run again with the same file and options and
   `--confirm-no-personal-data <fingerprint>`. It writes only if the file
   still yields exactly the records you reviewed. Imported entries keep their
   original date (noon in the server's time zone), are not posted to Slack,
   and are left out of the statistics.
