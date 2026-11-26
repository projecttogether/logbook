import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import type { Metadata } from "next";
import Link from "next/link";
import { EmailForm, SlackForm, StateBadge, WebhookForm } from "@/components/admin/integration-forms";
import { requireAdmin } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { integrationViews } from "@/lib/integrations/service";

export const metadata: Metadata = { title: "Integrations" };

const DOCS =
  "https://github.com/projecttogether/logbook/blob/main/docs/deployment.md#settings-from-the-command-line";

/**
 * Admin › Integrations: Slack, email, and the webhook. The worker reads the
 * settings before each round of sending, so a change needs no restart.
 * Operators set the same on the server with `cli settings`.
 */
export default async function IntegrationsPage() {
  const user = await requireAdmin();
  const views = await integrationViews(getDb());

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Integrations"
        description={
          <>
            Slack, email, and the webhook. Changes reach the worker within seconds. Secrets are stored
            encrypted and never shown again. On the server, <code>cli settings</code> sets the same (
            <Link className="underline underline-offset-2" href={DOCS}>
              deployment guide
            </Link>
            ).
          </>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Slack</h2>
          </CardTitle>
          <CardDescription>
            Events go to people as direct messages, and each new entry is posted to the channel. People
            without a Slack account get emails instead.
          </CardDescription>
          <CardAction>
            <StateBadge state={views.slack.state} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <SlackForm initial={views.slack} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Email</h2>
          </CardTitle>
          <CardDescription>
            Reminders go out by email, and messages for people Slack cannot reach.
          </CardDescription>
          <CardAction>
            <StateBadge state={views.email.state} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <EmailForm initial={views.email} adminEmail={user.person.workEmail ?? ""} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Webhook</h2>
          </CardTitle>
          <CardDescription>
            Published entries are posted to this URL as signed JSON, for example to a knowledge base or a
            search index (
            <Link
              className="underline underline-offset-2"
              href="https://github.com/projecttogether/logbook/blob/main/docs/webhooks.md"
            >
              webhook guide
            </Link>
            ).
          </CardDescription>
          <CardAction>
            <StateBadge state={views.webhook.state} />
          </CardAction>
        </CardHeader>
        <CardContent>
          <WebhookForm initial={views.webhook} />
        </CardContent>
      </Card>
    </div>
  );
}
