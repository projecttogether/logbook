# Webhook

With a URL and a signing secret set under **Admin › Integrations** (or with
`cli settings apply webhook`, see
[deployment](deployment.md#settings-from-the-command-line)), the worker posts
entries to that URL as JSON, for example to keep a search index, a knowledge
base, or an AI assistant up to date. The URL can carry a token, so Logbook
stores it encrypted, like the signing secret, and shows only its server.

## What is sent

- Published updates, learnings, and logged decisions.
- Proposals once they are decided or rejected.
- Never drafts, open proposals, or withdrawn proposals.

An entry is sent when it is published, and again whenever it changes: an
edit, a new impact, an addendum, or when a newer decision replaces it. Every
request carries the whole entry as it is now, so a receiver stores it by
`entry.id` and replaces what it had. Changes go out within a minute. Every
night at 02:30 (server time), and right after the webhook is turned on or
its URL changes, the worker re-sends any entry whose content differs from
what was last delivered; the first run after the webhook is turned on sends
every entry. A new URL gets the entries that change from then on, not the
ones an earlier URL already received.

```json
{
  "event": "entry.changed",
  "entry": {
    "id": "0196f1e2-…",
    "ref": "LB-12",
    "url": "https://logbook.example.org/e/LB-12",
    "type": "decision",
    "status": "decided",
    "title": "Four-day week trial",
    "summary": "The engineering team tries a four-day week.",
    "details": "Markdown: the context of the decision",
    "rationale": "Markdown",
    "impact": "medium",
    "team": "Engineering",
    "affected_teams": ["Operations"],
    "tags": ["Ways of working"],
    "author": "Ada Author",
    "published_at": "2026-11-04T09:00:00.000Z",
    "in_force": true,
    "supersedes": null,
    "superseded_by": null,
    "decision": {
      "result": "adopted",
      "text": "Markdown: the decision",
      "reversibility": "two_way",
      "how_decided": "integrative_process",
      "decider": "Dan Decider",
      "decided_on": "2026-11-06",
      "decided_at": "2026-11-06T09:00:00.000Z",
      "objection_handling": "Markdown, or null",
      "open_objections": [],
      "consent_givers": [],
      "involved": [],
      "proposal_version": 1
    },
    "addenda": [{ "text": "Markdown", "author": "Dan Decider", "created_at": "2026-11-20T10:00:00.000Z" }]
  }
}
```

- `type`: `update`, `learning`, or `decision`. `decision` is null for updates
  and learnings.
- `decision.result`: `recorded` for a decision logged directly, `adopted` or
  `rejected` for a proposal. A rejected proposal has an empty `text`.
- `in_force` is false once a newer decision replaced this one
  (`superseded_by`), and for rejected proposals.
- `impact` and `decision.reversibility` can be null for imported entries.

## Signature

Every request has these headers:

| Header              | Value                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `Logbook-Timestamp` | Unix time in seconds when the request was sent                                               |
| `Logbook-Signature` | `sha256=` and the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with the signing secret |
| `Logbook-Delivery`  | A random ID of this request                                                                  |

Existing receivers can still read `Logbuch-Timestamp`, `Logbuch-Signature`,
and `Logbuch-Delivery`. Both sets of headers carry the same values.

Check the signature against the raw body before parsing it, compare in
constant time, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function isFromLogbook(rawBody, headers, secret) {
  const timestamp = headers["logbook-timestamp"];
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
  const received = headers["logbook-signature"] ?? "";
  return expected.length === received.length && timingSafeEqual(Buffer.from(expected), Buffer.from(received));
}
```

## Delivery

Any 2xx answer counts as delivered. Anything else, or no answer within 30
seconds, is retried after 1, 5, 15, and then every 60 minutes. Redirects are
not followed. The admin page shows how many entries were delivered, which are
waiting, and which keep failing, with the last error.
