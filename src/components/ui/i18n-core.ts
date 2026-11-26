// Texts and translation without React, so that server code can import them.

/**
 * The components' texts, in US English like the rest of the app.
 *
 * Catalogs: `{ members: "{count} members", members_one: "1 member" }`, where
 * `<key>_one` wins when `count` is 1.
 */
export type Locale = "en";
export const LOCALES: readonly Locale[] = ["en"];

export type Catalog = Record<string, string>;
export type Messages<T extends Catalog> = { en: T };
export type Params = Record<string, string | number>;
export type Translate<T extends Catalog> = (key: keyof T & string, params?: Params) => string;

export function defineMessages<T extends Catalog>(messages: Messages<T>): Messages<T> {
  return messages;
}

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  );
}

export function translate<T extends Catalog>(messages: Messages<T>, locale: Locale): Translate<T> {
  const catalog = messages[locale] as Catalog;
  const english = messages.en as Catalog;
  return (key, params) => {
    const one = params !== undefined && Number(params.count) === 1 ? `${key}_one` : null;
    const template =
      (one ? (catalog[one] ?? english[one]) : undefined) ?? catalog[key] ?? english[key] ?? key;
    return interpolate(template, params);
  };
}

/** Words the components share. */
export const common = defineMessages({
  en: {
    cancel: "Cancel",
    confirm: "Confirm",
    back: "Back",
    next: "Next",
    loading: "Loading…",
    retry: "Retry",
    copy: "Copy",
    copied: "Copied",
    error: "Something went wrong",
    page: "Page {page} of {pages}",
    total: "{count} entries",
    total_one: "1 entry",
    close: "Close",
    sidebar: "Sidebar",
    sidebarDescription: "The app's navigation.",
    toggleSidebar: "Show or hide the sidebar",
  },
});

/** The message of an error of any kind; English fallback for values without one. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error !== "") return error;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === "string" && message !== "") return message;
  return "Something went wrong";
}
