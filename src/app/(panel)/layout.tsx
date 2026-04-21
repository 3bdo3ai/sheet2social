"use client";

import { useState, type ReactNode } from "react";
import { Bars3Icon, XMarkIcon } from "@heroicons/react/24/outline";

import { SidebarNav } from "@/components/dashboard/sidebar-nav";

export default function PanelLayout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="luxury-grid min-h-screen">
      <header className="luxury-panel mx-3 mb-4 mt-3 flex items-center justify-between rounded-2xl px-4 py-3 sm:mx-4 sm:mt-4 md:mx-6 md:mt-6 xl:hidden">
        <div>
          <p className="text-lg font-semibold tracking-tight">Sheet2Social</p>
          <p className="text-xs text-[#9ecbff]">Automation Control Center</p>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((prev) => !prev)}
          className="btn-subtle inline-flex items-center justify-center"
          aria-label="Toggle navigation menu"
        >
          {menuOpen ? <XMarkIcon className="h-5 w-5" /> : <Bars3Icon className="h-5 w-5" />}
        </button>
      </header>

      {menuOpen ? (
        <button
          type="button"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-[#020711]/70 xl:hidden"
          aria-label="Close menu overlay"
        />
      ) : null}

      <div className="grid min-h-screen w-full grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside
          className={`luxury-panel fixed left-3 top-3 z-50 h-[calc(100vh-1.5rem)] w-[min(88vw,320px)] overflow-auto rounded-2xl p-4 transition-transform duration-200 xl:sticky xl:left-auto xl:top-0 xl:z-20 xl:h-screen xl:w-full xl:translate-x-0 xl:overflow-y-auto xl:rounded-none xl:border-r xl:border-[var(--border)] xl:p-5 ${
            menuOpen
              ? "translate-x-0 pointer-events-auto"
              : "-translate-x-[120%] pointer-events-none xl:pointer-events-auto"
          }`}
        >
          <div className="mb-5 flex items-start justify-between border-b border-[var(--border)] pb-4">
            <div>
              <p className="text-xl font-semibold tracking-tight">Sheet2Social</p>
              <p className="mt-1 text-xs text-[#9ecbff]">Automation Control Center</p>
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen(false)}
              className="btn-subtle inline-flex items-center justify-center xl:hidden"
              aria-label="Close sidebar"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <SidebarNav onNavigate={() => setMenuOpen(false)} />
        </aside>

        <main className="min-w-0 px-3 pb-3 sm:px-4 sm:pb-4 md:px-6 md:pb-6 xl:px-8 xl:py-8">
          <section className="luxury-panel min-h-[calc(100vh-1.5rem)] rounded-2xl p-4 sm:p-5 md:p-7 xl:min-h-[calc(100vh-4rem)]">
            <div className="app-content-shell min-h-full">{children}</div>
          </section>
        </main>
      </div>
    </div>
  );
}
