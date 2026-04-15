import { redirect } from "next/navigation";

import { validateSessionFromCookies } from "@/lib/license/auth";

export default async function Home() {
  const validation = await validateSessionFromCookies();

  if (validation.ok) {
    redirect(validation.session.isAdmin ? "/admin/licenses" : "/dashboard");
  }

  redirect("/login");
}
