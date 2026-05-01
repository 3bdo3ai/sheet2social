"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowPathIcon, PlayIcon, StopIcon } from "@heroicons/react/24/outline";

type LogLevel = "info" | "success" | "error";

type LogItem = {
  id: string;
  level: LogLevel;
  message: string;
  accountId?: string;
  groupId?: string;
  sheetRow?: number;
  details?: string;
  createdAt: string;
};

type AutomationStatePayload = {
  state: "running" | "stopped";
  updatedAt?: string;
  settings?: {
    parallelAccounts?: number;
    waitIntervalMinutes?: number;
    maxPostsPerAccountPerCycle?: number;
    postsPerSession?: number;
    visibleBrowser?: boolean;
  };
};

type AccountSummary = {
  id: string;
  name: string;
  isActive: boolean;
  disabledAt?: string;
  disabledUntil?: string;
  disabledReason?: string;
  disabledType?: "manual" | "automatic";
};

type FlowStageId =
  | "worker"
  | "startup"
  | "selection"
  | "session"
  | "publish"
  | "cycle";

type FlowStageStatus = "idle" | "active" | "success" | "error";

type FlowStage = {
  id: FlowStageId;
  title: string;
  description: string;
};

type FlowStageSnapshot = FlowStage & {
  status: FlowStageStatus;
  lastEvent?: LogItem;
};

const FLOW_STAGES: FlowStage[] = [
  {
    id: "worker",
    title: "Worker Heartbeat",
    description: "Boot and runtime stability",
  },
  {
    id: "startup",
    title: "Automation Start",
    description: "State switched and cycle initialized",
  },
  {
    id: "selection",
    title: "Selection Check",
    description: "Active accounts/groups validation",
  },
  {
    id: "session",
    title: "Session Preflight",
    description: "Login, cookies, and proxy readiness",
  },
  {
    id: "publish",
    title: "Publishing",
    description: "Per-group posting execution",
  },
  {
    id: "cycle",
    title: "Cycle Control",
    description: "Loop continuation and crash handling",
  },
];

const FLOW_STAGE_INDEX: Record<FlowStageId, number> = {
  worker: 0,
  startup: 1,
  selection: 2,
  session: 3,
  publish: 4,
  cycle: 5,
};

function classifyLogStage(message: string): FlowStageId {
  const text = message.toLowerCase();

  if (
    text.includes("worker cycle") ||
    text.includes("controller loop") ||
    text.includes("one-shot")
  ) {
    return "cycle";
  }

  if (
    text.includes("worker started") ||
    text.includes("worker failed during startup") ||
    text.includes("unhandled promise") ||
    text.includes("uncaught exception")
  ) {
    return "worker";
  }

  if (text.includes("automation started") || text.includes("automation is stopped")) {
    return "startup";
  }

  if (
    text.includes("selection ready") ||
    text.includes("no active accounts or groups") ||
    text.includes("selected account")
  ) {
    return "selection";
  }

  if (
    text.includes("preflight") ||
    text.includes("session") ||
    text.includes("authenticated") ||
    text.includes("requires login") ||
    text.includes("logged in successfully")
  ) {
    return "session";
  }

  if (
    text.includes("[publish]") ||
    text.includes("starting post publish") ||
    text.includes("post failed") ||
    text.includes("post published") ||
    text.includes("[posted]") ||
    text.includes("[failed]") ||
    text.includes("csv processing") ||
    text.includes("no pending posts") ||
    text.includes("posted successfully")
  ) {
    return "publish";
  }

  return "cycle";
}

function buildFlowStageSnapshots(logs: LogItem[]): FlowStageSnapshot[] {
  const snapshots = FLOW_STAGES.map((stage) => ({
    ...stage,
    status: "idle" as FlowStageStatus,
    lastEvent: undefined as LogItem | undefined,
  }));

  for (const entry of logs) {
    const stage = snapshots[FLOW_STAGE_INDEX[classifyLogStage(entry.message)]];
    stage.lastEvent = entry;

    if (entry.level === "error") {
      stage.status = "error";
      continue;
    }

    if (entry.level === "success") {
      stage.status = "success";
      continue;
    }

    stage.status = "active";
  }

  return snapshots;
}

function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();

  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function trimMessage(message: string, maxLength = 120): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 1)}...`;
}

function stageToneClass(status: FlowStageStatus): string {
  if (status === "error") return "border-[#884152] bg-[#2a1720]";
  if (status === "success") return "border-[#2f735c] bg-[#102b22]";
  if (status === "active") return "border-[#426798] bg-[#152a49]";
  return "border-[var(--border)] bg-[#0f1f3a]";
}

function stageBadgeClass(status: FlowStageStatus): string {
  if (status === "error") return "border-[#ab5568] bg-[#4a1f2a] text-[#ffc9d3]";
  if (status === "success") return "border-[#3d9878] bg-[#153e31] text-[#bff6df]";
  if (status === "active") return "border-[#4f79ad] bg-[#1a3358] text-[#cde4ff]";
  return "border-[var(--border)] bg-[#172947] text-[#acc4e6]";
}

function logLevelClass(level: LogLevel): string {
  if (level === "error") return "border-[#a84a60] bg-[#3b1b26] text-[#ffc9d5]";
  if (level === "success") return "border-[#2f8d6b] bg-[#12392c] text-[#bcf5dd]";
  return "border-[#42669a] bg-[#152d4f] text-[#cae3ff]";
}

function extractScreenshotUrl(details?: string): string | undefined {
  if (!details) {
    return undefined;
  }

  const match = details.match(/Screenshot:\s*(\/automation-trace\/[^\s|]+)/i);
  return match?.[1];
}

function stripScreenshotReference(details?: string): string | undefined {
  if (!details) {
    return undefined;
  }

  const cleaned = details
    .replace(/(?:\s*\|\s*)?Screenshot:\s*\/automation-trace\/[^\s|]+/gi, "")
    .trim();

  return cleaned || undefined;
}

function inferIssueHint(message: string): string {
  const text = message.toLowerCase();

  if (text.includes("preflight") || text.includes("session") || text.includes("login")) {
    return "Likely account session/login issue. Recheck credentials, 2FA secret, and session freshness.";
  }

  if (text.includes("proxy")) {
    return "Likely proxy connectivity issue. Verify host, port, username/password, and outbound IP reachability.";
  }

  if (text.includes("csv")) {
    return "Likely CSV input or file-path issue. Verify group CSV path exists and still has pending rows.";
  }

  if (text.includes("publish") || text.includes("post")) {
    return "Likely UI publish-step issue. Check publish timeline events below to isolate the exact failed step.";
  }

  if (text.includes("worker")) {
    return "Worker loop instability. Restart worker and inspect stack trace details in the error payload.";
  }

  return "Use the latest trace entries to locate the first failure and investigate details payload for root cause.";
}

function toPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

export default function AutomationPage() {
  const [rawLogs, setRawLogs] = useState<LogItem[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [runtimeSettings, setRuntimeSettings] = useState<{
    parallelAccounts: number;
    waitIntervalMinutes: number;
    maxPostsPerAccountPerCycle: number;
    postsPerSession: number;
    visibleBrowser: boolean;
  } | null>(null);
  const [state, setState] = useState<"running" | "stopped">("stopped");
  const [pendingState, setPendingState] = useState<"running" | "stopped" | null>(null);
  const [isStateMutating, setIsStateMutating] = useState(false);
  const [levelFilter, setLevelFilter] = useState<"all" | "info" | "success" | "error">("all");
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [liveRefresh, setLiveRefresh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  const transitionStartedAtRef = useRef<number>(0);
  const visibleBrowserEnabled = runtimeSettings?.visibleBrowser ?? false;

  const displayState = pendingState ?? state;

  const loadData = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;

    if (!silent) {
      setLoading(true);
    }

    setIsRefreshing(true);

    try {
      const [stateRes, logsRes, accountsRes] = await Promise.all([
        fetch("/api/admin/automation/state", { cache: "no-store" }),
        fetch("/api/admin/logs?limit=280", { cache: "no-store" }),
        fetch("/api/admin/fb-accounts", { cache: "no-store" }),
      ]);

      if (!stateRes.ok || !logsRes.ok) {
        throw new Error("Failed to load automation state/logs");
      }

      const stateData = (await stateRes.json()) as Partial<AutomationStatePayload>;
      const logsData = (await logsRes.json()) as LogItem[];
      const accountsData = (await accountsRes.json()) as AccountSummary[];

      const remoteState = stateData.state === "running" ? "running" : "stopped";
      setState(remoteState);
      setPendingState((current) => (current && current === remoteState ? null : current));
      setRawLogs(Array.isArray(logsData) ? logsData : []);
      setAccounts(Array.isArray(accountsData) ? accountsData : []);

      const incomingSettings = stateData.settings;
      if (incomingSettings && typeof incomingSettings === "object") {
        const parallelAccounts = toPositiveInt(incomingSettings.parallelAccounts, 1);
        const maxPostsPerAccountPerCycle = toPositiveInt(
          incomingSettings.maxPostsPerAccountPerCycle,
          1
        );
        const visibleBrowser = Boolean(incomingSettings.visibleBrowser);

        setRuntimeSettings({
          parallelAccounts,
          waitIntervalMinutes: toPositiveInt(incomingSettings.waitIntervalMinutes, 1),
          maxPostsPerAccountPerCycle,
          postsPerSession: toPositiveInt(
            incomingSettings.postsPerSession,
            parallelAccounts * maxPostsPerAccountPerCycle
          ),
          visibleBrowser,
        });
      } else {
        setRuntimeSettings(null);
      }

      setRequestError(null);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unknown fetch error");
    } finally {
      setIsRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!liveRefresh) {
      return;
    }

    const isTransitionWindow = Date.now() - transitionStartedAtRef.current < 10_000;
    const intervalMs = isTransitionWindow ? 750 : displayState === "running" ? 2000 : 2500;
    const timer = setInterval(() => {
      void loadData({ silent: true });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [liveRefresh, loadData, displayState]);

  const chronologicalLogs = useMemo(() => rawLogs.slice().reverse(), [rawLogs]);

  const logs = useMemo(
    () =>
      chronologicalLogs.filter((entry) => {
        const byLevel = levelFilter === "all" ? true : entry.level === levelFilter;
        const bySearch = search.trim()
          ? entry.message.toLowerCase().includes(search.trim().toLowerCase())
          : true;
        return byLevel && bySearch;
      }),
    [chronologicalLogs, levelFilter, search]
  );

  const stageSnapshots = useMemo(
    () => buildFlowStageSnapshots(chronologicalLogs),
    [chronologicalLogs]
  );

  const latestError = useMemo(
    () => rawLogs.find((entry) => entry.level === "error"),
    [rawLogs]
  );
  const latestErrorScreenshot = latestError ? extractScreenshotUrl(latestError.details) : undefined;
  const latestErrorTextDetails = latestError
    ? stripScreenshotReference(latestError.details)
    : undefined;

  const latestLogEntry = rawLogs[0];
  const staleWhileRunning =
    displayState === "running" &&
    latestLogEntry !== undefined &&
    Date.now() - new Date(latestLogEntry.createdAt).getTime() > 120_000;

  const runLogs = useMemo(() => {
    let latestStartIndex = -1;

    for (let index = 0; index < chronologicalLogs.length; index += 1) {
      if (chronologicalLogs[index].message.startsWith("Automation started.")) {
        latestStartIndex = index;
      }
    }

    if (latestStartIndex < 0) {
      return chronologicalLogs;
    }

    return chronologicalLogs.slice(latestStartIndex);
  }, [chronologicalLogs]);

  const infoCount = rawLogs.filter((entry) => entry.level === "info").length;
  const successCount = rawLogs.filter((entry) => entry.level === "success").length;
  const errorCount = rawLogs.filter((entry) => entry.level === "error").length;

  const runInfoCount = runLogs.filter((entry) => entry.level === "info").length;
  const runSuccessCount = runLogs.filter((entry) => entry.level === "success").length;
  const runErrorCount = runLogs.filter((entry) => entry.level === "error").length;

  const pausedAccounts = useMemo(
    () =>
      accounts
        .filter(
          (account) => !account.isActive && account.disabledType === "automatic" && account.disabledUntil
        )
        .sort(
          (left, right) =>
            new Date(left.disabledUntil!).getTime() - new Date(right.disabledUntil!).getTime()
        ),
    [accounts]
  );

  const nextResumeAccount = pausedAccounts[0];
  const nextResumeLabel = nextResumeAccount
    ? new Date(nextResumeAccount.disabledUntil!).getTime() > Date.now()
      ? new Date(nextResumeAccount.disabledUntil!).toLocaleString()
      : "resume due now"
    : undefined;

  const terminalText = useMemo(
    () =>
      logs.length === 0
        ? "Waiting for automation to start..."
        : logs
            .map(
              (entry) =>
                `[${new Date(entry.createdAt).toLocaleTimeString()}] [${classifyLogStage(
                  entry.message
                ).toUpperCase()}] ${entry.message}`
            )
            .join("\n"),
    [logs]
  );

  useEffect(() => {
    if (!autoScroll || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [terminalText, autoScroll]);

  async function clearLogs() {
    try {
      const response = await fetch("/api/admin/logs", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ olderThan: new Date(Date.now() + 60_000).toISOString() }),
      });

      if (!response.ok) {
        throw new Error("Unable to clear logs");
      }

      await loadData({ silent: true });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Unknown clear-logs error");
    }
  }

  async function setAutomation(next: "running" | "stopped") {
    if (isStateMutating || displayState === next) {
      return;
    }

    const previousState = state;
    transitionStartedAtRef.current = Date.now();
    setIsStateMutating(true);
    setPendingState(next);
    setState(next);
    setRequestError(null);

    try {
      const response = await fetch("/api/admin/automation/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: next }),
      });

      if (!response.ok) {
        throw new Error("Unable to update automation state");
      }

      const payload = (await response.json()) as Partial<AutomationStatePayload>;
      const confirmedState = payload.state === "running" ? "running" : "stopped";
      setState(confirmedState);
      setPendingState(null);
      await loadData({ silent: true });
    } catch (error) {
      setState(previousState);
      setPendingState(null);
      setRequestError(error instanceof Error ? error.message : "Unknown automation-state error");
      await loadData({ silent: true });
    } finally {
      setIsStateMutating(false);
    }
  }

  async function restartAutomation() {
    if (isStateMutating || isRestarting) {
      return;
    }

    setIsRestarting(true);
    transitionStartedAtRef.current = Date.now();
    setPendingState("running");
    setRequestError(null);

    try {
      const response = await fetch("/api/admin/automation/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        throw new Error("Unable to restart automation");
      }

      await loadData({ silent: true });
    } catch (error) {
      setPendingState(null);
      setRequestError(error instanceof Error ? error.message : "Unknown automation-restart error");
      await loadData({ silent: true });
    } finally {
      setIsRestarting(false);
    }
  }

  async function toggleVisibleBrowser() {
    if (!runtimeSettings) {
      return;
    }

    const previousValue = runtimeSettings.visibleBrowser;
    const nextValue = !previousValue;
    setRuntimeSettings({ ...runtimeSettings, visibleBrowser: nextValue });
    setRequestError(null);

    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibleBrowser: nextValue }),
      });

      if (!response.ok) {
        throw new Error("Unable to update browser visibility");
      }

      const payload = (await response.json()) as Partial<AutomationStatePayload["settings"]>;
      setRuntimeSettings((current) =>
        current
          ? {
              ...current,
              visibleBrowser: Boolean(payload?.visibleBrowser ?? nextValue),
            }
          : current
      );
    } catch (error) {
      setRuntimeSettings((current) =>
        current ? { ...current, visibleBrowser: previousValue } : current
      );
      setRequestError(error instanceof Error ? error.message : "Unknown browser-visibility error");
    }
  }

  return (
    <section className="space-y-5 animate-reveal-up">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Automation</h1>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`status-chip ${displayState === "running" ? "status-running" : "status-stopped"}`}>
            {isStateMutating
              ? displayState === "running"
                ? "Starting..."
                : "Stopping..."
              : displayState === "running"
              ? "Running"
              : "Stopped"}
          </span>
          <button
            onClick={() => void toggleVisibleBrowser()}
            disabled={!runtimeSettings}
            className={`btn-subtle inline-flex items-center gap-1.5 text-xs disabled:opacity-60 ${
              visibleBrowserEnabled ? "border-[#3e7d5d] text-[#c6f0dd]" : "text-[#f0c7cf]"
            }`}
          >
            {visibleBrowserEnabled ? "Browser Visible" : "Browser Headless"}
          </button>
          <button
            onClick={() => setAutomation("running")}
            disabled={isStateMutating || displayState === "running"}
            className="btn-success inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <PlayIcon className="h-4 w-4" />
            Start
          </button>
          <button
            onClick={() => setAutomation("stopped")}
            disabled={isStateMutating || displayState === "stopped"}
            className="btn-danger inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <StopIcon className="h-4 w-4" />
            Stop
          </button>
          <button
            onClick={() => void restartAutomation()}
            disabled={isStateMutating || isRestarting}
            className="btn-subtle inline-flex items-center gap-1.5 text-xs disabled:opacity-60"
          >
            <ArrowPathIcon className={`h-4 w-4 ${isRefreshing || isRestarting ? "animate-spin" : ""}`} />
            {isRestarting ? "Restarting..." : "Refresh / Restart"}
          </button>
        </div>
      </div>

      {requestError ? (
        <div className="rounded-xl border border-[#8f4a59] bg-[#321d27] px-3 py-2 text-sm text-[#ffd2dc]">
          Data loading warning: {requestError}
        </div>
      ) : null}

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
            <p className="text-[#a9c2e6]">Current Run Errors</p>
            <p className="mt-1 text-xl font-semibold">{runErrorCount}</p>
          </div>
        </div>

        <div className="mb-3 rounded-xl border border-[var(--border)] bg-[#0f1f3a] p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#9ec4ef]">Paused Accounts</p>
              <p className="mt-1 text-sm text-[#cde1ff]">
                {pausedAccounts.length === 0
                  ? "No accounts are currently paused for a timed resume."
                  : `${pausedAccounts.length} account(s) will return to the active pool automatically.`}
              </p>
            </div>
            {nextResumeAccount ? (
              <span className="status-chip status-stopped">
                Next resume: {nextResumeLabel}
              </span>
            ) : null}
          </div>

          {pausedAccounts.length > 0 ? (
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {pausedAccounts.slice(0, 6).map((account) => (
                <div key={account.id} className="rounded-lg border border-[#33557f] bg-[#0a1528] p-3 text-xs text-[#d7e7ff]">
                  <p className="font-semibold text-[#f0f7ff]">{account.name}</p>
                  <p className="mt-1 text-[#a9c2e6]">
                    {new Date(account.disabledUntil!).getTime() > Date.now()
                      ? `Paused until ${new Date(account.disabledUntil!).toLocaleString()}`
                      : `Resume due now (scheduled for ${new Date(account.disabledUntil!).toLocaleString()})`}
                  </p>
                  <p className="mt-1 text-[#a9c2e6]">
                    Reason: {account.disabledReason || "Facebook temporary posting limit reached"}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
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
          <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={liveRefresh}
              onChange={(event) => setLiveRefresh(event.target.checked)}
            />
            Live refresh
          </label>
          <button onClick={clearLogs} className="btn-subtle text-xs text-[#ffc2cc]">
            Clear Logs
          </button>
        </div>

        <p className="mb-2 text-sm font-semibold text-[#b3c9ea]">RAW TERMINAL VIEW</p>
        <pre
          ref={logRef}
          className="h-[36vh] overflow-auto rounded-xl border border-[var(--border)] bg-[#0a1528] p-4 text-sm leading-7 text-[#83ceff]"
          style={autoScroll ? { scrollBehavior: "smooth" } : undefined}
        >
          {loading ? "Loading automation feed..." : terminalText}
        </pre>
      </div>
    </section>
  );
}
