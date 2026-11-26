import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SignInPage } from "@/components/ui/sign-in-page";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { signInAction } from "@/app/actions";
import { APP_NAME, AppIcon, MadeBy } from "@/components/brand";
import { NO_ACCESS_ERROR_CODE } from "@/lib/auth/access";
import { sessionStatus } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;
  if (error === NO_ACCESS_ERROR_CODE) redirect("/no-access");
  const status = await sessionStatus();
  if (status === "active") redirect("/");
  // Access ended after login; reading the session ended it.
  if (status === "ended") redirect("/no-access");

  return (
    <SignInPage
      app={{ name: APP_NAME, icon: <AppIcon className="size-9" /> }}
      tagline="Decisions, updates, and learnings in one place."
      footer={<MadeBy />}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription>
            Please try again. If it keeps failing, contact your administrator.
          </AlertDescription>
        </Alert>
      ) : null}
      <form action={signInAction}>
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </SignInPage>
  );
}
