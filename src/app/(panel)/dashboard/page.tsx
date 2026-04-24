"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Stats = {
  totalPosts: number;
  totalGroups: number;
  totalAccounts: number;
  status: "running" | "stopped";
};

type LogItem = {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  createdAt: string;
};

type LicenseSessionView = {
  keyString: string;
  status: "active" | "paused" | "expired" | "revoked";
  validUntil: string;
  remainingMs: number;
  isAdmin: boolean;
  userName: string | null;
};

function formatRemaining(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats>({
    totalPosts: 0,
    totalGroups: 0,
    totalAccounts: 0,
    status: "stopped",
  });
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [session, setSession] = useState<LicenseSessionView | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    const [statsRes, logsRes, sessionRes] = await Promise.all([
      fetch("/api/admin/dashboard/stats"),
      fetch("/api/admin/logs?limit=25"),
      fetch("/api/license/session", { cache: "no-store" }),
    ]);

    const statsData = (await statsRes.json()) as Stats;
    const logsData = (await logsRes.json()) as LogItem[];

    let sessionData: LicenseSessionView | null = null;
    if (sessionRes.ok) {
      const payload = (await sessionRes.json()) as { session: LicenseSessionView };
      sessionData = payload.session;
    }

    setStats(statsData);
    setLogs(logsData);
    setSession(sessionData);
    setLoading(false);
  }

  useEffect(() => {
    loadData();
    const timer = setInterval(loadData, 4000);
    return () => clearInterval(timer);
  }, []);

  const errorCount = logs.filter((entry) => entry.level === "error").length;
  const successCount = logs.filter((entry) => entry.level === "success").length;
  const activeDensity = stats.totalGroups > 0 ? stats.totalPosts / stats.totalGroups : 0;
  const healthScore = Math.max(
    0,
    Math.min(
      100,
      (stats.status === "running" ? 35 : 20) +
        Math.min(35, stats.totalAccounts * 7) +
        Math.min(20, Math.round(activeDensity * 4)) +
        Math.max(0, 10 - errorCount)
    )
  );
  const lastEvent = logs[0]?.createdAt ? new Date(logs[0].createdAt).toLocaleString() : "No activity yet";
  const healthTone = healthScore >= 75 ? "healthy" : healthScore >= 50 ? "watch" : "critical";

  const licenseSummary = session
    ? session.isAdmin
      ? "Admin session (non-expiring)"
      : formatRemaining(session.remainingMs)
    : "Loading";

  const insights: string[] = [];
  if (stats.totalAccounts === 0) insights.push("No accounts configured. Add at least one account to start automation.");
  if (stats.totalGroups === 0) insights.push("No groups available. Add groups to create posting targets.");
  if (stats.totalPosts === 0) insights.push("Post library is empty. Add posts so automation has content to publish.");
  if (errorCount >= 3) insights.push("Recent error volume is high. Review automation logs before scaling.");
  if (insights.length === 0) insights.push("System looks healthy. Consider increasing parallel accounts for higher throughput.");

  return (
    <section className="space-y-6 animate-reveal-up">
      <header className="app-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="app-title">Automation Command Center</h1>
          </div>
          <div className="space-y-2 text-right text-xs text-[#a4bee1]">
            <p>Last event: {lastEvent}</p>
            <span className={stats.status === "running" ? "status-chip status-running" : "status-chip status-stopped"}>
              {stats.status === "running" ? "Running" : "Stopped"}
            </span>
          </div>
        </div>
      </header>

      <div className="app-card p-4 md:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#9fc4ef]">License Session</p>
            <p className="mt-1 text-sm text-[#d8e9ff]">
              {session?.isAdmin ? "Admin" : "User"} access · Status {session?.status ?? "..."}
            </p>
          </div>
          <span className={session?.status === "active" ? "status-chip status-running" : "status-chip status-stopped"}>
            {session?.status ?? "loading"}
          </span>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <SmallStat label="Role" valueText={session?.isAdmin ? "Admin" : "User"} />
          <SmallStat label="Remaining" valueText={licenseSummary} />
          <SmallStat label="Key" valueText={session?.keyString ?? "--"} mono />
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr]">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Card title="Total Posts" value={stats.totalPosts} caption="Content units ready" />
            <Card title="Total Groups" value={stats.totalGroups} caption="Delivery targets" />
            <Card title="Total Accounts" value={stats.totalAccounts} caption="Active identities" />
            <Card title="Avg Posts / Group" value={activeDensity.toFixed(1)} caption="Distribution density" />
          </div>

          <div className="app-card p-4 md:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#9fc4ef]">Core Actions</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Action href="/posts" label="Add Post" />
              <Action href="/groups" label="Add Group" />
              <Action href="/accounts" label="Add Account" />
              <Action href="/automation" label="Open Automation" primary />
            </div>
          </div>

          <div className="app-card p-4 md:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#9fc4ef]">Operational Insights</p>
            <ul className="mt-3 space-y-2 text-sm text-[#c5d8f3]">
              {insights.map((item) => (
                <li key={item} className="rounded-lg border border-[var(--border)] bg-[#10223f] px-3 py-2">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="space-y-4">
          <div className="app-card p-4 md:p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#9fc4ef]">System Health</p>
              <span className="text-sm font-semibold text-[#d8e9ff]">{healthScore}%</span>
            </div>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#0f213e]">
              <div
                className={`h-full rounded-full ${
                  healthTone === "healthy"
                    ? "bg-gradient-to-r from-[#26c58a] to-[#42dca4]"
                    : healthTone === "watch"
                      ? "bg-gradient-to-r from-[#f7b043] to-[#f9cb6e]"
                      : "bg-gradient-to-r from-[#df627b] to-[#f3889b]"
                }`}
                style={{ width: `${healthScore}%` }}
              />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <SmallStat label="Success" value={successCount} />
              <SmallStat label="Errors" value={errorCount} />
            </div>
          </div>

          <div className="app-card p-4 md:p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#9fc4ef]">Recent Activity</p>
              {loading ? <span className="text-xs text-[#9bb2d5]">Refreshing...</span> : null}
            </div>
            <div className="mt-3 max-h-[22rem] space-y-2 overflow-auto">
              {logs.length === 0 ? (
                <p className="text-sm text-[#9bb2d5]">No logs yet.</p>
              ) : (
                logs.slice(0, 12).map((entry) => (
                  <div key={entry.id} className="rounded-lg border border-[var(--border)] bg-[#10223f] px-3 py-2">
                    <p className="text-xs text-[#a9c2e6]">{new Date(entry.createdAt).toLocaleString()}</p>
                    <p className="mt-1 text-sm text-[#dce9ff]">{entry.message}</p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Card({
  title,
  value,
  caption,
}: {
  title: string;
  value: string | number;
  caption?: string;
}) {
  const stateClass =
    typeof value === "string"
      ? value.toLowerCase() === "running"
        ? "status-chip status-running"
        : value.toLowerCase() === "stopped"
          ? "status-chip status-stopped"
          : ""
      : "";

  return (
    <div className="app-card px-4 py-5">
      <p className="text-sm text-[#acc0de]">{title}</p>
      {stateClass ? (
        <div className="mt-3">
          <span className={stateClass}>{String(value)}</span>
        </div>
      ) : (
        <p className="mt-2 text-3xl font-semibold">{value}</p>
      )}
      {caption ? <p className="mt-2 text-xs text-[#8eaad0]">{caption}</p> : null}
    </div>
  );
}

function SmallStat({
  label,
  value,
  valueText,
  mono,
}: {
  label: string;
  value?: number;
  valueText?: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[#10223f] px-3 py-2">
      <p className="text-xs text-[#9eb8dc]">{label}</p>
      <p className={`mt-1 text-lg font-semibold text-[#e4f0ff] ${mono ? "font-mono text-sm break-all" : ""}`}>
        {valueText ?? value ?? "--"}
      </p>
    </div>
  );
}

function Action({ href, label, primary }: { href: string; label: string; primary?: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-xl border px-4 py-4 text-center text-sm font-semibold transition ${
        primary
          ? "luxury-btn"
          : "border-[var(--border)] bg-[#132646] text-[#d0e2fa] hover:border-[#4a72a6]"
      }`}
    >
      {label}
    </Link>
  );
}
