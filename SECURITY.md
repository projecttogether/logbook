# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them
privately through GitHub: on the repository's **Security** tab, choose
**Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect.
ProjectTogether will confirm receipt, keep you informed while it works on a
fix, and credit you in the pull request of the fix unless you prefer
otherwise.

## Supported versions

Security fixes go into the `main` branch; every commit on it is built as a
new image (`ghcr.io/projecttogether/logbook:latest`). There are no older
versions to patch.

## Deployment notes

- Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`. Logbook
  refuses to start in production with the example value from `.env.example`.
  It also seals the secrets of Admin › Integrations (Slack, email, the
  webhook) in the database, so keep it apart from copies of the database.
- Serve Logbook over HTTPS only, and set `LOGBOOK_BASE_URL` to that HTTPS URL.
- The Keycloak service account needs only the `view-users` role of
  `realm-management`.
- Set `OIDC_TRUST_EMAIL=true` only if people cannot choose their own email
  address at your identity provider.
- Use a long, random signing secret for the webhook, and verify the signature
  on every request your receiver gets (see [docs/webhooks.md](docs/webhooks.md)).
