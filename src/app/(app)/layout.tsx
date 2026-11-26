import { Page } from "@/components/ui/page";
import { cookies } from "next/headers";
import { LogbookFrame } from "@/components/logbook-frame";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { getMyTasks } from "@/lib/process/queries";

/** Set by the frame's sidebar when it is opened or hidden. */
const SIDEBAR_COOKIE = "sidebar_state";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { person } = await requireUser();
  const [tasks, cookieStore] = await Promise.all([getMyTasks(getDb(), person.id), cookies()]);
  return (
    <LogbookFrame
      user={{ name: person.displayName, email: person.workEmail }}
      isAdmin={person.isAdmin}
      taskCount={tasks.length}
      defaultSidebarOpen={cookieStore.get(SIDEBAR_COOKIE)?.value !== "false"}
    >
      {/* Logbook's reading width: entries are mostly text. */}
      <Page className="max-w-5xl">{children}</Page>
    </LogbookFrame>
  );
}
