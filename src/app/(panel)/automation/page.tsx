"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PlayIcon, StopIcon } from "@heroicons/react/24/outline";

type LogItem = {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  createdAt: string;
};

export default function AutomationPage() {
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [rawLogs, setRawLogs] = useState<LogItem[]>([]);
  const [state, setState] = useState<"running" | "stopped">("stopped");
  const [levelFilter, setLevelFilter] = useState<"all" | "info" | "success" | "error">("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

  async function loadState() {
    const res = await fetch("/api/admin/automation/state");
    const data = (await res.json()) as { state: "running" | "stopped" };
    setState(data.state);
  }

  async function loadLogs() {
    const res = await fetch("/api/admin/logs?limit=200");
    const data = (await res.json()) as LogItem[];
    setRawLogs(data);
  }

  useEffect(() => {
    loadState();
    loadLogs();
    const timer = setInterval(() => {
      loadState();
      loadLogs();
    }, 2000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const next = rawLogs.filter((entry) => {
      const byLevel = levelFilter === "all" ? true : entry.level === levelFilter;
      const bySearch = search.trim()
        ? entry.message.toLowerCase().includes(search.trim().toLowerCase())
        : true;
      return byLevel && bySearch;
    });

    setLogs(next);
  }, [rawLogs, levelFilter, search]);

  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs, autoScroll]);

  const terminalText = useMemo(
    () =>
      logs.length === 0
        ? "Waiting for automation to start..."
        : logs
            .slice()
            .reverse()
            .map(
              (entry) =>
                `[${new Date(entry.createdAt).toLocaleTimeString()}] ${entry.message}`
            )
            .join("\n"),
    [logs]
  );

  const infoCount = rawLogs.filter((entry) => entry.level === "info").length;
  const successCount = rawLogs.filter((entry) => entry.level === "success").length;
  const errorCount = rawLogs.filter((entry) => entry.level === "error").length;

  async function clearLogs() {
    await fetch("/api/admin/logs", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ olderThan: new Date(Date.now() + 60_000).toISOString() }),
    });
    await loadLogs();
  }

  async function setAutomation(next: "running" | "stopped") {
    await fetch("/api/admin/automation/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: next }),
    });
    await loadState();
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Automation Control</h1>
          <p className="app-subtitle">Start and monitor automation</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`status-chip ${state === "running" ? "status-running" : "status-stopped"}`}>
            {state === "running" ? "Running" : "Stopped"}
          </span>
          <button
            onClick={() => setAutomation("running")}
            disabled={state === "running"}
            className="btn-success inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <PlayIcon className="h-4 w-4" />
            Start
          </button>
          <button
            onClick={() => setAutomation("stopped")}
            disabled={state === "stopped"}
            className="btn-danger inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <StopIcon className="h-4 w-4" />
            Stop
          </button>
        </div>
      </div>

      <div className="app-card p-3">
        <div className="mb-3 grid gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-[var(--border)] bg-[#0f1f3a] p-3 text-sm">
            <p className="text-[#a9c2e6]">Info Logs</p>
            <p className="mt-1 text-xl font-semibold">{infoCount}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[#0f1f3a] p-3 text-sm">
            <p className="text-[#a9c2e6]">Success Logs</p>
            <p className="mt-1 text-xl font-semibold">{successCount}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[#0f1f3a] p-3 text-sm">
            <p className="text-[#a9c2e6]">Error Logs</p>
            <p className="mt-1 text-xl font-semibold">{errorCount}</p>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[#0f1f3a] p-3 text-sm">
            <p className="text-[#a9c2e6]">Filtered View</p>
            <p className="mt-1 text-xl font-semibold">{logs.length}</p>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select
            value={levelFilter}
            onChange={(event) => setLevelFilter(event.target.value as "all" | "info" | "success" | "error")}
            className="modal-input max-w-[180px]"
          >
            <option value="all">All Levels</option>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search logs..."
            className="modal-input max-w-[260px]"
          />
          <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(event) => setAutoScroll(event.target.checked)}
            />
            Auto-scroll
          </label>
          <button onClick={clearLogs} className="btn-subtle text-xs text-[#ffc2cc]">
            Clear Logs
          </button>
        </div>

        <p className="mb-2 text-sm font-semibold text-[#b3c9ea]">LIVE LOGS</p>
        <pre
          ref={logRef}
          className="h-[58vh] overflow-auto rounded-xl border border-[var(--border)] bg-[#0a1528] p-4 text-sm leading-7 text-[#83ceff]"
          style={autoScroll ? { scrollBehavior: "smooth" } : undefined}
        >
          {terminalText}
        </pre>
      </div>
    </section>
  );
}
