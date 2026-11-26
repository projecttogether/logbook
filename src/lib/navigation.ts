/*
 * The app's navigation: the sidebar items and the breadcrumb of each page.
 * Pure data and functions of the path; `LogbookFrame` hands them to the
 * app frame (`src/components/ui/app-frame.tsx`), which marks the current item.
 */

export type NavKey = "timeline" | "tasks" | "stats" | "admin" | "people" | "teams" | "tags" | "integrations";

export interface NavLink {
  key: NavKey;
  href: string;
  label: string;
  /** "G then this letter" opens the page: main pages only, each letter once; "o" is the start page. */
  shortcut?: string;
  /** More paths whose pages belong to this item, with their sub-pages. */
  match?: string[];
}

export interface NavSection {
  label?: string;
  items: NavLink[];
}

/**
 * The main pages. Entries (/e/…) and the new entry forms (/new…) belong to the
 * timeline; "New entry" itself is a button in the timeline's header.
 */
export const MAIN_NAV: NavLink[] = [
  { key: "timeline", href: "/", label: "Timeline", shortcut: "o", match: ["/e", "/new"] },
  { key: "tasks", href: "/tasks", label: "My tasks", shortcut: "m" },
  { key: "stats", href: "/stats", label: "Statistics", shortcut: "s" },
];

export const ADMIN_NAV: NavLink[] = [
  { key: "admin", href: "/admin", label: "Admin" },
  { key: "people", href: "/admin/people", label: "People" },
  { key: "teams", href: "/admin/teams", label: "Teams" },
  { key: "tags", href: "/admin/tags", label: "Tags" },
  { key: "integrations", href: "/admin/integrations", label: "Integrations" },
];

/** The sidebar of a person: the main pages, and the administration for admins. */
export function navSections(isAdmin: boolean): NavSection[] {
  return isAdmin
    ? [{ items: MAIN_NAV }, { label: "Administration", items: ADMIN_NAV }]
    : [{ items: MAIN_NAV }];
}

export interface Crumb {
  label: string;
  /** Missing on the current page. */
  href?: string;
}

const TIMELINE: Crumb = { label: "Timeline", href: "/" };
const NEW_ENTRY = "New entry";
const NEW_PAGES: Record<string, string> = { log: "Log something", proposal: "New proposal" };
const ENTRY_PAGES: Record<string, string> = { edit: "Edit", history: "History", decide: "Decide" };
const ADMIN_PAGES: Record<string, string> = {
  people: "People",
  teams: "Teams",
  tags: "Tags",
  integrations: "Integrations",
};

function entryRef(segment: string): string {
  try {
    return decodeURIComponent(segment).toUpperCase();
  } catch {
    return segment.toUpperCase();
  }
}

/** The breadcrumb shown in the header, from the sidebar section to the current page (at most three steps). */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const [section, child, grandchild] = segments;
  switch (section) {
    case undefined:
      return [{ label: "Timeline" }];
    case "tasks":
      return [{ label: "My tasks" }];
    case "stats":
      return [{ label: "Statistics" }];
    case "new": {
      const page = child ? NEW_PAGES[child] : undefined;
      return page
        ? [TIMELINE, { label: NEW_ENTRY, href: "/new" }, { label: page }]
        : [TIMELINE, { label: NEW_ENTRY }];
    }
    case "admin": {
      const page = child ? ADMIN_PAGES[child] : undefined;
      return page ? [{ label: "Admin", href: "/admin" }, { label: page }] : [{ label: "Admin" }];
    }
    case "settings":
      return [{ label: "Settings" }];
    case "e": {
      if (!child) return [TIMELINE];
      const ref = entryRef(child);
      const page = grandchild ? ENTRY_PAGES[grandchild] : undefined;
      return page
        ? [TIMELINE, { label: ref, href: `/e/${child}` }, { label: page }]
        : [TIMELINE, { label: ref }];
    }
    default:
      return [];
  }
}
