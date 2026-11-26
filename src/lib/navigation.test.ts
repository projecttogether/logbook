import { describe, expect, it } from "vitest";
import { breadcrumbsFor, navSections } from "./navigation";

describe("navSections", () => {
  it("shows the administration to admins only", () => {
    expect(navSections(false).flatMap((section) => section.items.map((item) => item.label))).toEqual([
      "Timeline",
      "My tasks",
      "Statistics",
    ]);
    expect(navSections(true).map((section) => section.label)).toEqual([undefined, "Administration"]);
  });

  it("gives the main pages a key each, with o for the timeline, and none to admin pages", () => {
    const items = navSections(true).flatMap((section) => section.items);
    expect(items.filter((item) => item.shortcut).map((item) => [item.shortcut, item.label])).toEqual([
      ["o", "Timeline"],
      ["m", "My tasks"],
      ["s", "Statistics"],
    ]);
  });

  it("keeps the main action out of the sidebar", () => {
    const hrefs = navSections(true).flatMap((section) => section.items.map((item) => item.href));
    expect(hrefs).not.toContain("/new");
  });

  it("lets entries and the new entry forms belong to the timeline", () => {
    expect(navSections(false)[0]!.items[0]).toMatchObject({ href: "/", match: ["/e", "/new"] });
  });
});

describe("breadcrumbsFor", () => {
  it.each([
    ["/", [{ label: "Timeline" }]],
    ["/tasks", [{ label: "My tasks" }]],
    ["/stats", [{ label: "Statistics" }]],
    ["/new", [{ label: "Timeline", href: "/" }, { label: "New entry" }]],
    [
      "/new/log",
      [{ label: "Timeline", href: "/" }, { label: "New entry", href: "/new" }, { label: "Log something" }],
    ],
    [
      "/new/proposal",
      [{ label: "Timeline", href: "/" }, { label: "New entry", href: "/new" }, { label: "New proposal" }],
    ],
    ["/new/update", [{ label: "Timeline", href: "/" }, { label: "New entry" }]],
    ["/admin", [{ label: "Admin" }]],
    ["/admin/tags", [{ label: "Admin", href: "/admin" }, { label: "Tags" }]],
    ["/admin/integrations", [{ label: "Admin", href: "/admin" }, { label: "Integrations" }]],
    ["/settings", [{ label: "Settings" }]],
    ["/e/lb-12", [{ label: "Timeline", href: "/" }, { label: "LB-12" }]],
    [
      "/e/LB-12/history",
      [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "History" }],
    ],
    [
      "/e/LB-12/decide",
      [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "Decide" }],
    ],
    [
      "/e/LB-12/edit",
      [{ label: "Timeline", href: "/" }, { label: "LB-12", href: "/e/LB-12" }, { label: "Edit" }],
    ],
    ["/e/%E0", [{ label: "Timeline", href: "/" }, { label: "%E0" }]],
    ["/unknown", []],
  ])("%s", (pathname, crumbs) => {
    expect(breadcrumbsFor(pathname)).toEqual(crumbs);
  });
});
