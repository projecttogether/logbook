import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page";
import { AboutCard, KeyboardShortcutsCard } from "@/components/ui/settings-cards";
import type { Metadata } from "next";
import { OrganizationLogo } from "@/components/brand";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { PreferencesForm } from "@/components/settings/preferences-form";
import { getFormatter, requireUser } from "@/lib/auth/session";
import { getVersionConfig } from "@/lib/config";
import { DATE_FORMAT_LABELS, DATE_FORMATS, SERVER_TIME_ZONE, timeZoneOptions } from "@/lib/preferences";
import { commitUrl, REPOSITORY_URL } from "@/lib/repository";
import { savePreferencesAction } from "./actions";

export const metadata: Metadata = { title: "Settings" };

/**
 * The signed-in person's own settings: dates and times are saved with the
 * person; appearance and keyboard shortcuts in this browser.
 */
export default async function SettingsPage() {
  const { person } = await requireUser();
  const fmt = await getFormatter();
  const version = getVersionConfig().APP_VERSION ?? null;
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Settings" description="How Logbook looks and shows dates and times to you." />
      <Card>
        <CardHeader>
          <CardTitle>Dates and times</CardTitle>
          <CardDescription>
            Deadlines always end at 23:59 in {SERVER_TIME_ZONE}, the time zone of this Logbook.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PreferencesForm
            action={savePreferencesAction}
            timeZone={person.timeZone}
            dateFormat={fmt.dateFormat}
            serverTimeZone={SERVER_TIME_ZONE}
            timeZones={timeZoneOptions()}
            dateFormats={DATE_FORMATS.map((value) => ({ value, label: DATE_FORMAT_LABELS[value] }))}
            example={fmt.dateTime(new Date())}
          />
        </CardContent>
      </Card>
      <AppearanceSettings />
      <KeyboardShortcutsCard />
      <AboutCard
        logo={<OrganizationLogo className="size-10 rounded-md" />}
        text="Logbook is ProjectTogether's open-source log of decisions, updates, and learnings."
        version={version}
        versionHref={version ? commitUrl(version) : undefined}
        repositoryUrl={REPOSITORY_URL}
      />
    </div>
  );
}
