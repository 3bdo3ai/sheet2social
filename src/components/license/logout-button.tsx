"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";

export function LogoutButton({ className }: { className?: string }) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/license/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ releaseDevice: true }),
    });

    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={handleLogout}
      className={className ?? "btn-subtle inline-flex items-center gap-2 px-3 py-2 text-sm"}
    >
      <LogOut className="h-4 w-4" />
      Log out
    </button>
  );
}
