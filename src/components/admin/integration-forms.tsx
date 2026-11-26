"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { initialSecret, SecretField, secretPayload, type SecretValue } from "@/components/ui/secret-field";
import { CircleAlert } from "lucide-react";
import { useState, useTransition, type FormEvent, type ReactNode } from "react";
import {
  saveIntegrationAction,
  testIntegrationAction,
  type SaveIntegrationResult,
} from "@/app/(app)/admin/integrations/actions";
import {
  DEFAULT_FROM_NAME,
  type EmailProvider,
  type EmailView,
  type IntegrationName,
  type IntegrationState,
  type SlackView,
  type SmtpSecurity,
  type WebhookView,
} from "@/lib/integrations/schemas";

/*
 * The forms of Admin › Integrations. Each sends the JSON body that
 * `cli settings apply <name>` takes (src/lib/integrations/schemas.ts):
 * secrets are write-only, so a kept secret is left out of the body.
 */

interface Outcome {
  tone: "success" | "error";
  message: string;
}

const STATE_BADGES: Record<
  IntegrationState,
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  set: { label: "On", variant: "secondary" },
  "not set": { label: "Off", variant: "outline" },
  incomplete: { label: "Incomplete", variant: "destructive" },
};

export function StateBadge({ state }: { state: IntegrationState }) {
  const badge = STATE_BADGES[state];
  return <Badge variant={badge.variant}>{badge.label}</Badge>;
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertDescription>
        {warnings.map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </AlertDescription>
    </Alert>
  );
}

function Status({ outcome }: { outcome: Outcome | null }) {
  return (
    <p
      role="status"
      className={outcome?.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
    >
      {outcome?.message ?? ""}
    </p>
  );
}

/** Saves through the shared Server Action; field errors and the message come back as the command prints them. */
function useSave<V>(name: IntegrationName, onSaved: (view: V) => void) {
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  function save(body: unknown) {
    startTransition(async () => {
      const result: SaveIntegrationResult = await saveIntegrationAction(name, body);
      if (result.ok) {
        setErrors({});
        onSaved(result.view as V);
      } else {
        setErrors(result.fieldErrors);
      }
      setOutcome({ tone: result.ok ? "success" : "error", message: result.message });
    });
  }
  return { pending, errors, outcome, save };
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  description?: ReactNode;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const describedBy = [
    props.description ? `${props.id}-hint` : null,
    props.error ? `${props.id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Field data-invalid={props.error ? true : undefined} className="gap-1.5">
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <Input
        id={props.id}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete ?? "off"}
        onChange={(event) => props.onChange(event.target.value)}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy || undefined}
      />
      {props.description ? (
        <FieldDescription id={`${props.id}-hint`} className="text-xs">
          {props.description}
        </FieldDescription>
      ) : null}
      {props.error ? <FieldError id={`${props.id}-error`}>{props.error}</FieldError> : null}
    </Field>
  );
}

function TestOutcome({ outcome }: { outcome: Outcome | null }) {
  return (
    <p
      role="status"
      className={outcome?.tone === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
    >
      {outcome?.message ?? ""}
    </p>
  );
}

/** A test button: tests the saved settings, never the unsaved form. */
function useTest(name: "slack" | "email") {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | undefined>();
  function test(input: unknown = {}) {
    startTransition(async () => {
      const result = await testIntegrationAction(name, input);
      setError(result.fieldErrors?.to);
      setOutcome({ tone: result.ok ? "success" : "error", message: result.message });
    });
  }
  return { pending, outcome, error, test };
}

export function SlackForm({ initial }: { initial: SlackView }) {
  const [view, setView] = useState(initial);
  const [token, setToken] = useState<SecretValue>(initialSecret(initial.botTokenSaved));
  const [channelId, setChannelId] = useState(initial.channelId ?? "");
  const { pending, errors, outcome, save } = useSave<SlackView>("slack", (saved) => {
    setView(saved);
    setToken(initialSecret(saved.botTokenSaved));
    setChannelId(saved.channelId ?? "");
  });
  const testing = useTest("slack");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save({ botToken: secretPayload(token), channelId: channelId.trim() || null });
  }

  return (
    <div className="flex flex-col gap-4">
      <Warnings warnings={view.warnings} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <SecretField
            id="slack-bot-token"
            label="Bot token"
            stored={view.botTokenSaved}
            hint={view.botTokenHint}
            value={token}
            onChange={setToken}
            removable
            placeholder="xoxb-…"
            description="Of a Slack app with the scopes chat:write, users:read, and users:read.email."
            error={errors.botToken}
          />
          <TextField
            id="slack-channel-id"
            label="Channel ID"
            value={channelId}
            onChange={setChannelId}
            placeholder="C0123456789"
            description="Optional. One post per new entry goes here. Invite the app to the channel."
            error={errors.channelId}
          />
        </FieldGroup>
        <Status outcome={outcome} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save Slack"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testing.pending || !view.botTokenSaved}
            onClick={() => testing.test()}
          >
            {testing.pending ? "Testing…" : "Test Slack"}
          </Button>
        </div>
      </form>
      <TestOutcome outcome={testing.outcome} />
    </div>
  );
}

const SECURITY_LABELS: Record<SmtpSecurity, string> = {
  starttls: "STARTTLS (usually port 587)",
  tls: "TLS (usually port 465)",
  auto: "STARTTLS when the server offers it",
  none: "None",
};

export function EmailForm({ initial, adminEmail }: { initial: EmailView; adminEmail: string }) {
  const [view, setView] = useState(initial);
  const [provider, setProvider] = useState<EmailProvider>(initial.provider);
  const [fromAddress, setFromAddress] = useState(initial.fromAddress);
  const [fromName, setFromName] = useState(initial.fromName);
  const [host, setHost] = useState(initial.smtp.host);
  const [port, setPort] = useState(String(initial.smtp.port));
  const [security, setSecurity] = useState<SmtpSecurity>(initial.smtp.security);
  const [username, setUsername] = useState(initial.smtp.username);
  const [password, setPassword] = useState<SecretValue>(initialSecret(initial.smtp.passwordSaved));
  const [token, setToken] = useState<SecretValue>(initialSecret(initial.mailersend.tokenSaved));
  const [testTo, setTestTo] = useState(adminEmail);
  const { pending, errors, outcome, save } = useSave<EmailView>("email", (saved) => {
    setView(saved);
    setPassword(initialSecret(saved.smtp.passwordSaved));
    setToken(initialSecret(saved.mailersend.tokenSaved));
  });
  const testing = useTest("email");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save({
      provider,
      fromAddress,
      fromName,
      // The other provider's fields are kept, so switching back loses nothing.
      smtp: { host, port, security, username, password: secretPayload(password) },
      mailersend: { token: secretPayload(token) },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Warnings warnings={view.warnings} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="email-provider">Send email with</FieldLabel>
            <NativeSelect
              id="email-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value as EmailProvider)}
            >
              <NativeSelectOption value="none">Off</NativeSelectOption>
              <NativeSelectOption value="smtp">SMTP</NativeSelectOption>
              <NativeSelectOption value="mailersend">MailerSend</NativeSelectOption>
            </NativeSelect>
          </Field>
          <div aria-hidden="true" className="hidden sm:block" />
          <TextField
            id="email-from-address"
            label="Sender address"
            type="email"
            value={fromAddress}
            onChange={setFromAddress}
            placeholder="logbook@example.org"
            error={errors.fromAddress}
          />
          <TextField
            id="email-from-name"
            label="Sender name"
            value={fromName}
            onChange={setFromName}
            placeholder={DEFAULT_FROM_NAME}
            description={`Empty: ${DEFAULT_FROM_NAME}.`}
            error={errors.fromName}
          />
          {provider === "smtp" ? (
            <>
              <TextField
                id="email-smtp-host"
                label="Mail server"
                value={host}
                onChange={setHost}
                placeholder="mail.example.org"
                error={errors["smtp.host"]}
              />
              <TextField
                id="email-smtp-port"
                label="Port"
                type="number"
                value={port}
                onChange={setPort}
                error={errors["smtp.port"]}
              />
              <Field className="gap-1.5">
                <FieldLabel htmlFor="email-smtp-security">Encryption</FieldLabel>
                <NativeSelect
                  id="email-smtp-security"
                  value={security}
                  onChange={(event) => setSecurity(event.target.value as SmtpSecurity)}
                >
                  {(Object.keys(SECURITY_LABELS) as SmtpSecurity[]).map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {SECURITY_LABELS[value]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <TextField
                id="email-smtp-username"
                label="User name"
                value={username}
                onChange={setUsername}
                description="Empty for a server without login."
                error={errors["smtp.username"]}
              />
              <SecretField
                id="email-smtp-password"
                label="Password"
                stored={view.smtp.passwordSaved}
                hint={view.smtp.passwordHint}
                value={password}
                onChange={setPassword}
                removable
                error={errors["smtp.password"]}
              />
            </>
          ) : null}
          {provider === "mailersend" ? (
            <SecretField
              id="email-mailersend-token"
              label="MailerSend API token"
              stored={view.mailersend.tokenSaved}
              hint={view.mailersend.tokenHint}
              value={token}
              onChange={setToken}
              removable
              description="With email sending access."
              error={errors["mailersend.token"]}
            />
          ) : null}
        </FieldGroup>
        <Status outcome={outcome} />
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save email"}
          </Button>
        </div>
      </form>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          testing.test({ to: testTo });
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <TextField
              id="email-test-to"
              label="Send a test email to"
              type="email"
              value={testTo}
              onChange={setTestTo}
              error={testing.error}
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={testing.pending || view.state === "not set"}
          >
            {testing.pending ? "Sending…" : "Send test email"}
          </Button>
        </div>
        <TestOutcome outcome={testing.outcome} />
      </form>
    </div>
  );
}

export function WebhookForm({ initial }: { initial: WebhookView }) {
  const [view, setView] = useState(initial);
  const [url, setUrl] = useState<SecretValue>(initialSecret(initial.urlSaved));
  const [secret, setSecret] = useState<SecretValue>(initialSecret(initial.secretSaved));
  const { pending, errors, outcome, save } = useSave<WebhookView>("webhook", (saved) => {
    setView(saved);
    setUrl(initialSecret(saved.urlSaved));
    setSecret(initialSecret(saved.secretSaved));
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    save({ url: secretPayload(url), secret: secretPayload(secret) });
  }

  return (
    <div className="flex flex-col gap-4">
      <Warnings warnings={view.warnings} />
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          <SecretField
            id="webhook-url"
            label="URL"
            stored={view.urlSaved}
            hint={view.urlHint}
            value={url}
            onChange={setUrl}
            removable
            placeholder="https://hooks.example.org/logbook"
            description="Without a URL, the webhook is off."
            error={errors.url}
          />
          <SecretField
            id="webhook-secret"
            label="Signing secret"
            stored={view.secretSaved}
            hint={view.secretHint}
            value={secret}
            onChange={setSecret}
            removable
            description="At least 16 characters, from the receiver (such as a knowledge base). It signs every request."
            error={errors.secret}
          />
        </FieldGroup>
        <Status outcome={outcome} />
        <div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save webhook"}
          </Button>
        </div>
      </form>
    </div>
  );
}
