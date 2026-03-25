"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AdjustmentsHorizontalIcon,
  ChartBarSquareIcon,
  Cog6ToothIcon,
  FolderOpenIcon,
  PlayCircleIcon,
  ServerStackIcon,
  UserGroupIcon,
} from "@heroicons/react/24/outline";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: ChartBarSquareIcon },
  { href: "/posts", label: "Posts", icon: FolderOpenIcon },
  { href: "/groups", label: "Groups", icon: UserGroupIcon },
  { href: "/accounts", label: "Accounts", icon: ServerStackIcon },
  { href: "/automation", label: "Automation", icon: PlayCircleIcon },
  { href: "/settings", label: "Settings", icon: Cog6ToothIcon },
  { href: "/proxies", label: "Proxies", icon: AdjustmentsHorizontalIcon },
];

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  function isItemActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="space-y-2.5">
      {navItems.map((item) => {
        const isActive = isItemActive(item.href);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={`group flex items-center gap-3 rounded-2xl border px-3.5 py-3 text-[0.95rem] font-semibold tracking-[0.01em] transition-all duration-200 ${
              isActive
                ? "border-[#3f6798] bg-[linear-gradient(140deg,#1a335e,#13284b_68%)] text-[#e7f3ff] shadow-[0_10px_24px_rgba(5,17,37,0.45)]"
                : "border-[var(--border)] bg-[#111f3a] text-[#b8c8e2] hover:border-[#4f7cb4] hover:bg-[#13274a] hover:text-[#edf6ff]"
            }`}
          >
            <span
              className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border transition-colors ${
                isActive
                  ? "border-[#5f8bc0] bg-[#1e3a69] text-[#dff0ff]"
                  : "border-[#2f4a73] bg-[#142947] text-[#98b3d9] group-hover:text-[#d7e9ff]"
              }`}
            >
              <Icon className="h-5 w-5" />
            </span>
            <span className="flex-1 leading-none">{item.label}</span>
            <span
              className={`h-2 w-2 rounded-full transition-colors ${
                isActive ? "bg-[#66c7ff]" : "bg-[#2d4366] group-hover:bg-[#4f7cb4]"
              }`}
              aria-hidden="true"
            />
          </Link>
        );
      })}
    </nav>
  );
}
