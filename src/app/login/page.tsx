import { redirect } from "next/navigation";

import { LoginForm } from "@/components/license/login-form";
import { validateSessionFromCookies } from "@/lib/license/auth";

type PageProps = {
  searchParams: Promise<{ reason?: string }>;
};

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const validation = await validateSessionFromCookies();

  if (validation.ok) {
    redirect(validation.session.isAdmin ? "/admin/licenses" : "/dashboard");
  }

  return (
    <main className="luxury-grid flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-xl">
        <LoginForm initialReason={params.reason} />
      </div>
    </main>
  );
}
