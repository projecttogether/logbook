"use client";

import { AppFrame, type NavGroup } from "@/components/ui/app-frame";
import { useThemePreference } from "@/components/ui/theme";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { APP_NAME, AppIcon, SidebarOrganization } from "@/components/brand";
import { findEntries } from "@/lib/entries/search";
import { timelineHref } from "@/lib/entries/timeline-filters";
import { breadcrumbsFor, navSections } from "@/lib/navigation";

interface LogbookFrameProps {
  user: { name: string; email: string | null };
  /** Admins see the administration. */
  isAdmin: boolean;
  /** What waits for the person, as a count at "My tasks". */
  taskCount: number;
  /** The cookie `sidebar_state`, read on the server. */
  defaultSidebarOpen: boolean;
  children: React.ReactNode;
}

const search = { find: findEntries, allResultsHref: (q: string) => timelineHref({ q }) };

/**
 * The app frame (`src/components/ui/app-frame.tsx`) with Logbook's
 * navigation: a client component, because the frame takes the router's link
 * and functions, which cannot come from the server layout.
 */
export function LogbookFrame({ user, isAdmin, taskCount, defaultSidebarOpen, children }: LogbookFrameProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [theme, setTheme] = useThemePreference();
  const badge =
    taskCount > 0 ? (
      <>
        {taskCount}
        <span className="sr-only"> waiting</span>
      </>
    ) : undefined;
  const nav: NavGroup[] = navSections(isAdmin).map((section) => ({
    label: section.label,
    items: section.items.map(({ href, label, shortcut, match, key }) => ({
      href,
      label,
      shortcut,
      match,
      badge: key === "tasks" ? badge : undefined,
    })),
  }));

  return (
    <AppFrame
      app={{ name: APP_NAME, icon: <AppIcon />, description: "Decisions and updates" }}
      nav={nav}
      sidebarFooter={<SidebarOrganization />}
      pathname={pathname}
      link={Link}
      navigate={(href) => router.push(href)}
      user={user}
      theme={theme}
      onThemeChange={setTheme}
      settingsHref="/settings"
      onSignOut={() => void signOutAction()}
      breadcrumbs={breadcrumbsFor(pathname)}
      search={search}
      defaultSidebarOpen={defaultSidebarOpen}
    >
      {children}
    </AppFrame>
  );
}
