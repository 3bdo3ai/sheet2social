import type { ReactNode } from "react";
import Link from "next/link";
import { Crown, KeyRound, LayoutDashboard, ShieldCheck } from "lucide-react";

import { LogoutButton } from "@/components/license/logout-button";
import { LICENSE_ADMIN_PATH } from "@/lib/license/constants";
import { requireActiveLicenseSession } from "@/lib/license/auth";

export default async function ClientLayout({ children }: { children: ReactNode }) {
  const session = await requireActiveLicenseSession();
  const statusClass =
    session.status === "active"
      ? "status-chip status-running"
      : session.status === "paused"
        ? "status-chip border-[#f2bc54]/40 bg-[#f2bc54]/15 text-[#ffe4aa]"
        : "status-chip status-stopped";

  return (
    <div className="luxury-grid min-h-screen">
      <div className="mx-auto grid w-full max-w-[1500px] grid-cols-1 gap-4 px-3 py-3 sm:px-4 sm:py-4 md:px-6 md:py-6 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="luxury-panel rounded-2xl p-4 sm:p-5">
          <div className="border-b border-[var(--border)] pb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8eb8eb]">License Portal</p>
            <p className="mt-2 text-xl font-semibold tracking-tight text-[#e8f3ff]">Sheet2Social Access</p>
            <p className="mt-1 text-sm text-[#9db4d4]">Device-bound subscription control</p>
          </div>

          <div className="mt-4 rounded-xl border border-[var(--border)] bg-[#10213d] p-3">
            <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-[#92b9e7]">
              <ShieldCheck className="h-4 w-4" />
              Subscription status
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className={statusClass}>{session.status}</span>
              <span className="text-xs text-[#99b5d9]">{new Date(session.validUntil).toLocaleDateString()}</span>
            </div>
            <p className="mt-2 text-xs text-[#a9c2e4]">Key: {session.keyString}</p>
          </div>

          <nav className="mt-4 space-y-2">
            <Link
              href="/dashboard"
              className="group flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[#122646] px-3 py-2.5 text-sm font-semibold text-[#d7e7ff] transition hover:border-[#4d78ab]"
            >
              <LayoutDashboard className="h-4 w-4" />
              System Dashboard
            </Link>

            {session.isAdmin ? (
              <Link
                href={LICENSE_ADMIN_PATH}
                className="group flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[#122646] px-3 py-2.5 text-sm font-semibold text-[#d7e7ff] transition hover:border-[#4d78ab]"
              >
                <Crown className="h-4 w-4" />
                Admin License Manager
              </Link>
            ) : null}
          </nav>

          <div className="mt-4">
            <LogoutButton className="btn-subtle inline-flex w-full items-center justify-center gap-2 px-3 py-2.5 text-sm" />
          </div>
        </aside>

        <main className="luxury-panel rounded-2xl p-4 sm:p-5 md:p-6">{children}</main>
      </div>
    </div>
  );
}
