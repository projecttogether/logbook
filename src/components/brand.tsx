import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import organizationLogo from "@/assets/projecttogether-logo.png";
import { cn } from "@/components/ui/utils";
import { REPOSITORY_URL } from "@/lib/repository";

/*
 * The app's identity (ProjectTogether's app identity rules): its own icon,
 * Lucide's notebook-pen on PT Sky (src/app/icon.svg), in the browser tab, the
 * sidebar and on the sign-in page; ProjectTogether's unchanged logo as the
 * organization that makes the app, in the sidebar's footer, on the sign-in
 * page and in the About card. Server and client components both use these.
 */

/** The app's name. */
export const APP_NAME = "Logbook";

/** The organization that makes the app. */
export const ORGANIZATION = "ProjectTogether";

/** The paths of Lucide's notebook-pen icon (24 × 24), as in src/app/icon.svg. */
const NOTEBOOK_PEN_PATHS = [
  "M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4",
  "M2 6h4",
  "M2 10h4",
  "M2 14h4",
  "M2 18h4",
  "M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z",
];

/**
 * The app icon; 32 pixels unless `className` sets another size. The drawing
 * sits in a span, so that menus that size their own icons leave it alone.
 */
export function AppIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex size-8 shrink-0", className)}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" aria-hidden="true" className="size-full">
        <rect width="32" height="32" rx="8" fill="#008ce6" />
        <g
          transform="translate(4 4)"
          fill="none"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {NOTEBOOK_PEN_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      </svg>
    </span>
  );
}

/** ProjectTogether's logo; 20 pixels unless `className` sets another size. */
export function OrganizationLogo({ className }: { className?: string }) {
  return (
    <Image
      src={organizationLogo}
      alt=""
      width={20}
      height={20}
      unoptimized
      className={cn("size-5 shrink-0 rounded-sm", className)}
    />
  );
}

/** The sidebar's footer: the organization's logo and name. */
export function SidebarOrganization() {
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-2 text-xs">
      <OrganizationLogo />
      <span className="truncate">{ORGANIZATION}</span>
    </div>
  );
}

/** "Logbook is open source, made by ProjectTogether. Source code", with the logo (sign-in page). */
export function MadeBy() {
  return (
    <span className="inline-flex items-center gap-2">
      <OrganizationLogo className="size-6" />
      <span>
        {APP_NAME} is open source, made by {ORGANIZATION}.{" "}
        <a
          href={REPOSITORY_URL}
          target="_blank"
          rel="noreferrer"
          className="hover:text-foreground inline-flex items-center gap-0.5 underline underline-offset-4"
        >
          Source code
          <ArrowUpRight className="size-3" aria-hidden="true" />
          <span className="sr-only">(GitHub, opens in a new tab)</span>
        </a>
      </span>
    </span>
  );
}
