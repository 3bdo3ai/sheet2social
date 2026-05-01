"use client";

import { FormEvent, useEffect, useState } from "react";

type Settings = {
  parallelAccounts: number;
  waitIntervalMinutes: number;
  delayBetweenAccountsMinutes: number;
  postsPerGroup: number;
  maxPostsPerAccountPerCycle: number;
  postsPerSession: number;
  commentWithPostImage: boolean;
  proxyRotationEnabled: boolean;
  visibleBrowser: boolean;
};

type DashboardStats = {
  totalPosts: number;
  totalGroups: number;
  totalAccounts: number;
  status: "running" | "stopped";
};

const defaultSettings: Settings = {
  parallelAccounts: 3,
  waitIntervalMinutes: 60,
  delayBetweenAccountsMinutes: 1,
  postsPerGroup: 15,
  maxPostsPerAccountPerCycle: 15,
  postsPerSession: 20,
  commentWithPostImage: false,
  proxyRotationEnabled: false,
  visibleBrowser: false,
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadSettings() {
    const res = await fetch("/api/admin/settings");
    const data = (await res.json()) as Partial<Settings>;
    const parallelAccounts = Number(data.parallelAccounts ?? defaultSettings.parallelAccounts);
    const maxPostsPerAccountPerCycle = Number(
      data.maxPostsPerAccountPerCycle ?? defaultSettings.maxPostsPerAccountPerCycle
    );
    const fallbackPostsPerSession = Math.max(1, parallelAccounts * maxPostsPerAccountPerCycle);
    const visibleBrowser =
      typeof data.visibleBrowser === "boolean"
        ? data.visibleBrowser
        : defaultSettings.visibleBrowser;

    setSettings({
      ...defaultSettings,
      ...data,
      visibleBrowser,
      postsPerSession: Math.max(1, Math.floor(Number(data.postsPerSession ?? fallbackPostsPerSession))),
    });
  }

  useEffect(() => {
    loadSettings();
    fetch("/api/admin/dashboard/stats")
      .then((response) => response.json())
      .then((data: DashboardStats) => setStats(data))
      .catch(() => {
        setStats(null);
      });
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);

    await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });

    setSaving(false);
    await loadSettings();
  }

  const cycleMinutes = Math.max(1, settings.waitIntervalMinutes);
  const cyclesPerDay = Math.floor((24 * 60) / cycleMinutes);
  const maxPostsByAccountWindow =
    settings.parallelAccounts * Math.min(settings.postsPerGroup, settings.maxPostsPerAccountPerCycle);
  const estimatedPostsPerCycle =
    Math.min(settings.postsPerSession, maxPostsByAccountWindow);
  const estimatedDailyCapacity = estimatedPostsPerCycle * cyclesPerDay;
  const queueCoverage = stats?.totalPosts
    ? Math.max(0, Math.round((estimatedDailyCapacity / stats.totalPosts) * 100))
    : 0;

  function resetDefaults() {
    setSettings(defaultSettings);
  }

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="app-title">Settings</h1>
        </div>
        <button form="settings-form" type="submit" className="luxury-btn rounded-xl px-5 py-3 font-semibold">
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <InsightCard label="Cycles / Day" value={cyclesPerDay} />
        <InsightCard label="Posts / Cycle" value={estimatedPostsPerCycle} />
        <InsightCard label="Estimated Daily Capacity" value={estimatedDailyCapacity} />
        <InsightCard label="Queue Coverage" value={`${queueCoverage}%`} />
      </div>

      <div className="app-card p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9ec5ef]">Configuration Analysis</p>
        <div className="mt-3 grid gap-2 text-sm text-[#ccdcf3]">
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Parallelization: {settings.parallelAccounts} account(s) running together.
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Delay between accounts: {settings.delayBetweenAccountsMinutes} minute(s).
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Session post cap: {settings.postsPerSession} post(s) before waiting.
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Max posts per account each cycle: {settings.maxPostsPerAccountPerCycle}.
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Session cooldown: {settings.waitIntervalMinutes} minute(s) between cycles.
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Comment image mode: {settings.commentWithPostImage ? "enabled" : "disabled"}.
          </p>
          <p className="rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2">
            Browser visibility: {settings.visibleBrowser ? "visible" : "headless"}.
          </p>
        </div>
        <button type="button" onClick={resetDefaults} className="btn-subtle mt-4 text-xs">
          Reset To Defaults
        </button>
      </div>

      <form id="settings-form" onSubmit={onSubmit} className="grid max-w-2xl gap-4">
        <Field label="Parallel Accounts" hint="Number of accounts to run simultaneously (1-10)">
          <input type="number" min={1} value={settings.parallelAccounts} onChange={(event) => setSettings((prev) => ({ ...prev, parallelAccounts: Number(event.target.value || 1) }))} className="modal-input" />
        </Field>

        <Field
          label="Session Cooldown (minutes)"
          hint="Minutes to wait after each posting session before resuming (example: 120 = every 2 hours)"
        >
          <input type="number" min={1} value={settings.waitIntervalMinutes} onChange={(event) => setSettings((prev) => ({ ...prev, waitIntervalMinutes: Number(event.target.value || 1) }))} className="modal-input" />
        </Field>

        <Field label="Delay Between Accounts (minutes)" hint="Minutes to wait between switching accounts">
          <input type="number" min={0} value={settings.delayBetweenAccountsMinutes} onChange={(event) => setSettings((prev) => ({ ...prev, delayBetweenAccountsMinutes: Number(event.target.value || 0) }))} className="modal-input" />
        </Field>

        <Field label="Posts Per Group" hint="Number of posts to make in each group">
          <input type="number" min={1} value={settings.postsPerGroup} onChange={(event) => setSettings((prev) => ({ ...prev, postsPerGroup: Number(event.target.value || 1) }))} className="modal-input" />
        </Field>

        <Field
          label="Max Posts Per Account (per cycle)"
          hint="Maximum posts one account can publish in a single automation cycle before switching to another account"
        >
          <input
            type="number"
            min={1}
            value={settings.maxPostsPerAccountPerCycle}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                maxPostsPerAccountPerCycle: Number(event.target.value || 1),
              }))
            }
            className="modal-input"
          />
        </Field>

        <Field
          label="Posts Per Session"
          hint="Total posts to publish across all active accounts in one session before cooldown starts"
        >
          <input
            type="number"
            min={1}
            value={settings.postsPerSession}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                postsPerSession: Number(event.target.value || 1),
              }))
            }
            className="modal-input"
          />
        </Field>

        <label className="app-card flex items-center gap-2 px-4 py-4">
          <input type="checkbox" checked={settings.commentWithPostImage} onChange={(event) => setSettings((prev) => ({ ...prev, commentWithPostImage: event.target.checked }))} />
          <span>
            <span className="block font-semibold">Comment with Post Image</span>
            <span className="block text-sm text-[#a2b7d7]">Attach post image in comments when a comment exists.</span>
          </span>
        </label>

        <label className="app-card flex items-center gap-2 px-4 py-4">
          <input
            type="checkbox"
            checked={settings.visibleBrowser}
            onChange={(event) =>
              setSettings((prev) => ({
                ...prev,
                visibleBrowser: event.target.checked,
              }))
            }
          />
          <span>
            <span className="block font-semibold">Visible Browser Mode</span>
            <span className="block text-sm text-[#a2b7d7]">
              Show the automation browser window for debugging. Keep off for normal headless runs.
            </span>
          </span>
        </label>
      </form>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="app-card grid gap-2 p-4">
      <span className="text-lg font-semibold">{label}</span>
      {children}
      <span className="text-sm text-[#a2b7d7]">{hint}</span>
    </label>
  );
}

function InsightCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="app-card p-4">
      <p className="text-sm text-[#acc0de]">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
