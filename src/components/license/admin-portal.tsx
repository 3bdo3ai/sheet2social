"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CalendarClock,
  ClockArrowUp,
  Database,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  Power,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";

import { ModalShell } from "@/components/ui/modal-shell";
import { LogoutButton } from "@/components/license/logout-button";

type LicenseStatus = "active" | "paused" | "expired" | "revoked";

type LicenseKeyRow = {
  id: string;
  key_string: string;
  is_admin?: boolean;
  status: LicenseStatus;
  device_id: string | null;
  valid_until: string;
  user_name: string | null;
  user_phone: string | null;
  user_email: string | null;
  admin_notes: string | null;
  created_at: string;
};

type LicenseSummary = {
  totalActive: number;
  expiringSoon: number;
  totalPaused: number;
  totalDevicesConnected: number;
};

type CreateFormState = {
  mode: "duration" | "exact";
  durationDays: number;
  validUntil: string;
  userName: string;
  userPhone: string;
  userEmail: string;
  adminNotes: string;
};

type ExtendState = {
  id: string;
  keyString: string;
  mode: "days" | "exact";
  addDays: number;
  validUntil: string;
};

function formatStatusChip(status: LicenseStatus): string {
  if (status === "active") {
    return "status-chip status-running";
  }

  if (status === "paused") {
    return "status-chip border-[#f2bc54]/40 bg-[#f2bc54]/15 text-[#ffe4aa]";
  }

  if (status === "revoked") {
    return "status-chip border-[#f07087]/45 bg-[#f07087]/18 text-[#ffd4dc]";
  }

  return "status-chip status-stopped";
}

function toDatetimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  const local = new Date(date.getTime() - offsetMs);
  return local.toISOString().slice(0, 16);
}

function toIsoFromLocal(input: string): string {
  const value = new Date(input);
  return value.toISOString();
}

const defaultCreateState: CreateFormState = {
  mode: "duration",
  durationDays: 30,
  validUntil: "",
  userName: "",
  userPhone: "",
  userEmail: "",
  adminNotes: "",
};

export function LicenseAdminPortal() {
  const [summary, setSummary] = useState<LicenseSummary | null>(null);
  const [rows, setRows] = useState<LicenseKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LicenseStatus | "all">("all");
  const [sortBy, setSortBy] = useState<"created_at" | "valid_until" | "status" | "key_string">("created_at");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateFormState>(defaultCreateState);

  const [extendState, setExtendState] = useState<ExtendState | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("status", status);
    params.set("sortBy", sortBy);
    params.set("sortOrder", sortOrder);
    if (search.trim()) {
      params.set("search", search.trim());
    }
    return params.toString();
  }, [search, sortBy, sortOrder, status]);

  async function loadSummary() {
    const response = await fetch("/api/license/admin/summary", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Unable to fetch summary.");
    }

    const payload = (await response.json()) as LicenseSummary;
    setSummary(payload);
  }

  async function loadKeys() {
    const response = await fetch(`/api/license/admin/keys?${queryString}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Unable to fetch keys.");
    }

    const payload = (await response.json()) as LicenseKeyRow[];
    setRows(payload);
  }

  async function refreshAll() {
    setLoading(true);
    try {
      await Promise.all([loadSummary(), loadKeys()]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshAll();
  }, [queryString]);

  async function runRowAction(id: string, payload: Record<string, unknown>, successMessage: string) {
    setBusyAction(id);
    setNotice(null);

    try {
      const response = await fetch(`/api/license/admin/keys/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Operation failed.");
      }

      setNotice(successMessage);
      await refreshAll();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Operation failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this key permanently?")) {
      return;
    }

    setBusyAction(id);
    setNotice(null);

    try {
      const response = await fetch(`/api/license/admin/keys/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Delete failed.");
      }

      setNotice("License key deleted.");
      await refreshAll();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Delete failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusyAction("create");
    setNotice(null);

    try {
      const body: Record<string, unknown> = {
        userName: createForm.userName,
        userPhone: createForm.userPhone,
        userEmail: createForm.userEmail,
        adminNotes: createForm.adminNotes,
      };

      if (createForm.mode === "duration") {
        body.durationDays = createForm.durationDays;
      } else {
        body.validUntil = toIsoFromLocal(createForm.validUntil);
      }

      const response = await fetch("/api/license/admin/keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Failed to generate key.");
      }

      setCreateOpen(false);
      setCreateForm(defaultCreateState);
      setNotice("New license key generated successfully.");
      await refreshAll();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Failed to generate key.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleExtend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!extendState) {
      return;
    }

    const payload: Record<string, unknown> = {
      action: "extend",
    };

    if (extendState.mode === "days") {
      payload.addDays = extendState.addDays;
    } else {
      payload.validUntil = toIsoFromLocal(extendState.validUntil);
    }

    await runRowAction(extendState.id, payload, "License validity updated.");
    setExtendState(null);
  }

  const summaryCards = [
    {
      label: "Total Active Keys",
      value: summary?.totalActive ?? 0,
      icon: ShieldCheck,
    },
    {
      label: "Expiring Soon",
      value: summary?.expiringSoon ?? 0,
      icon: CalendarClock,
    },
    {
      label: "Total Paused",
      value: summary?.totalPaused ?? 0,
      icon: PauseCircle,
    },
    {
      label: "Devices Connected",
      value: summary?.totalDevicesConnected ?? 0,
      icon: Users,
    },
  ];

  return (
    <section className="space-y-5">
      <header className="app-card p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#97bde9]">Protected Admin Route</p>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[#edf7ff]">License & Subscription Management</h1>
            <p className="mt-1 text-sm text-[#a3bfdf]">Generate keys, manage device binding, and control subscription lifecycle</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/dashboard" className="btn-subtle inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
              User Panel
            </Link>
            <LogoutButton className="btn-subtle inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold" />
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="luxury-btn inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
            >
              <Plus className="h-4 w-4" />
              Generate Key
            </button>
          </div>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {summaryCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="app-card px-4 py-4">
              <div className="flex items-center justify-between text-[#9bc1eb]">
                <p className="text-xs uppercase tracking-[0.14em]">{card.label}</p>
                <Icon className="h-4 w-4" />
              </div>
              <p className="mt-3 text-3xl font-semibold tracking-tight text-[#edf6ff]">{card.value}</p>
            </div>
          );
        })}
      </div>

      <div className="app-card p-4">
        <div className="grid gap-3 md:grid-cols-[1.4fr_repeat(3,minmax(0,1fr))_auto]">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by key, name, email, phone"
            className="modal-input"
          />

          <select className="modal-input" value={status} onChange={(event) => setStatus(event.target.value as LicenseStatus | "all")}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="expired">Expired</option>
            <option value="revoked">Revoked</option>
          </select>

          <select
            className="modal-input"
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as "created_at" | "valid_until" | "status" | "key_string")}
          >
            <option value="created_at">Sort: Created</option>
            <option value="valid_until">Sort: Expiry</option>
            <option value="status">Sort: Status</option>
            <option value="key_string">Sort: Key</option>
          </select>

          <select className="modal-input" value={sortOrder} onChange={(event) => setSortOrder(event.target.value as "asc" | "desc")}>
            <option value="desc">Order: Desc</option>
            <option value="asc">Order: Asc</option>
          </select>

          <button type="button" className="btn-subtle inline-flex items-center justify-center gap-2 px-3" onClick={() => void refreshAll()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {notice ? (
        <p className="rounded-xl border border-[var(--border)] bg-[#10213d] px-4 py-3 text-sm text-[#c5d9f4]">{notice}</p>
      ) : null}

      <div className="app-table-wrap">
        <table className="app-table min-w-[1180px]">
          <thead>
            <tr>
              <th>Key</th>
              <th>Status</th>
              <th>Device</th>
              <th>Valid Until</th>
              <th>User</th>
              <th>Notes</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-sm text-[#9ab5da]">
                  {loading ? "Loading keys..." : "No keys found for this filter."}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const rowBusy = busyAction === row.id;
                const isPaused = row.status === "paused";
                const isAdminKey = row.is_admin === true;

                return (
                  <tr key={row.id}>
                    <td className="font-mono text-xs tracking-[0.08em] text-[#d8e8ff]">{row.key_string}</td>
                    <td>
                      <span className={formatStatusChip(row.status)}>{row.status}</span>
                    </td>
                    <td className="max-w-[220px] truncate text-xs text-[#a7bfdf]">{row.device_id ?? "-"}</td>
                    <td className="text-sm text-[#d6e8ff]">{new Date(row.valid_until).toLocaleString()}</td>
                    <td className="text-sm text-[#d6e8ff]">
                      <p>{row.user_name ?? "-"}</p>
                      <p className="text-xs text-[#9bb7dc]">{row.user_email ?? row.user_phone ?? ""}</p>
                    </td>
                    <td className="max-w-[220px] truncate text-sm text-[#b8cde9]">{row.admin_notes ?? "-"}</td>
                    <td>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          disabled={rowBusy || isAdminKey}
                          onClick={() =>
                            setExtendState({
                              id: row.id,
                              keyString: row.key_string,
                              mode: "days",
                              addDays: 7,
                              validUntil: toDatetimeLocalValue(row.valid_until),
                            })
                          }
                          className="btn-subtle inline-flex items-center gap-1 px-2.5 py-1.5 text-xs"
                        >
                          <ClockArrowUp className="h-3.5 w-3.5" />
                          {isAdminKey ? "No Expiry" : "Extend"}
                        </button>

                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            void runRowAction(
                              row.id,
                              { action: "set-status", status: isPaused ? "active" : "paused" },
                              isPaused ? "Key unpaused." : "Key paused.",
                            )
                          }
                          className="btn-subtle inline-flex items-center gap-1 px-2.5 py-1.5 text-xs"
                        >
                          {isPaused ? <PlayCircle className="h-3.5 w-3.5" /> : <PauseCircle className="h-3.5 w-3.5" />}
                          {isPaused ? "Unpause" : "Pause"}
                        </button>

                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() =>
                            void runRowAction(row.id, { action: "set-status", status: "revoked" }, "Key revoked.")
                          }
                          className="btn-subtle inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-[#ffc4cf]"
                        >
                          <ShieldAlert className="h-3.5 w-3.5" />
                          Revoke
                        </button>

                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() => void runRowAction(row.id, { action: "force-logout" }, "Device binding cleared.")}
                          className="btn-subtle inline-flex items-center gap-1 px-2.5 py-1.5 text-xs"
                        >
                          <Power className="h-3.5 w-3.5" />
                          Force Logout
                        </button>

                        <button
                          type="button"
                          disabled={rowBusy}
                          onClick={() => void handleDelete(row.id)}
                          className="btn-subtle inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-[#ffc4cf]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {createOpen ? (
        <ModalShell className="max-w-2xl">
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#98bfe9]">Key Generator</p>
                <h2 className="mt-1 text-xl font-semibold tracking-tight text-[#e9f4ff]">Create New License Key</h2>
              </div>
              <button type="button" onClick={() => setCreateOpen(false)} className="btn-subtle text-xs">
                Close
              </button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-2 text-sm text-[#c8daf4]">
                <span>Duration Mode</span>
                <select
                  className="modal-input"
                  value={createForm.mode}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, mode: event.target.value as "duration" | "exact" }))}
                >
                  <option value="duration">Add by days</option>
                  <option value="exact">Set exact date/time</option>
                </select>
              </label>

              {createForm.mode === "duration" ? (
                <label className="space-y-2 text-sm text-[#c8daf4]">
                  <span>Days</span>
                  <input
                    type="number"
                    min={1}
                    className="modal-input"
                    value={createForm.durationDays}
                    onChange={(event) =>
                      setCreateForm((prev) => ({
                        ...prev,
                        durationDays: Number(event.target.value) || 1,
                      }))
                    }
                  />
                </label>
              ) : (
                <label className="space-y-2 text-sm text-[#c8daf4]">
                  <span>Exact Valid Until</span>
                  <input
                    type="datetime-local"
                    required
                    className="modal-input"
                    value={createForm.validUntil}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, validUntil: event.target.value }))}
                  />
                </label>
              )}

              <label className="space-y-2 text-sm text-[#c8daf4]">
                <span>Name (optional)</span>
                <input
                  className="modal-input"
                  value={createForm.userName}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, userName: event.target.value }))}
                />
              </label>

              <label className="space-y-2 text-sm text-[#c8daf4]">
                <span>Phone (optional)</span>
                <input
                  className="modal-input"
                  value={createForm.userPhone}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, userPhone: event.target.value }))}
                />
              </label>

              <label className="space-y-2 text-sm text-[#c8daf4] sm:col-span-2">
                <span>Email (optional)</span>
                <input
                  className="modal-input"
                  type="email"
                  value={createForm.userEmail}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, userEmail: event.target.value }))}
                />
              </label>

              <label className="space-y-2 text-sm text-[#c8daf4] sm:col-span-2">
                <span>Admin notes (optional)</span>
                <textarea
                  rows={3}
                  className="modal-input resize-none"
                  value={createForm.adminNotes}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, adminNotes: event.target.value }))}
                />
              </label>
            </div>

            <button
              type="submit"
              disabled={busyAction === "create"}
              className="luxury-btn inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold"
            >
              {busyAction === "create" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              {busyAction === "create" ? "Creating..." : "Generate and Save Key"}
            </button>
          </form>
        </ModalShell>
      ) : null}

      {extendState ? (
        <ModalShell className="max-w-lg">
          <form onSubmit={handleExtend} className="space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#98bfe9]">Extend Subscription</p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight text-[#e9f4ff]">{extendState.keyString}</h2>
              </div>
              <button type="button" onClick={() => setExtendState(null)} className="btn-subtle text-xs">
                Close
              </button>
            </div>

            <label className="space-y-2 text-sm text-[#c8daf4]">
              <span>Extend Method</span>
              <select
                className="modal-input"
                value={extendState.mode}
                onChange={(event) =>
                  setExtendState((prev) =>
                    prev
                      ? {
                          ...prev,
                          mode: event.target.value as "days" | "exact",
                        }
                      : prev,
                  )
                }
              >
                <option value="days">Add days</option>
                <option value="exact">Set exact date/time</option>
              </select>
            </label>

            {extendState.mode === "days" ? (
              <label className="space-y-2 text-sm text-[#c8daf4]">
                <span>Days to add</span>
                <input
                  type="number"
                  min={1}
                  className="modal-input"
                  value={extendState.addDays}
                  onChange={(event) =>
                    setExtendState((prev) =>
                      prev
                        ? {
                            ...prev,
                            addDays: Number(event.target.value) || 1,
                          }
                        : prev,
                    )
                  }
                />
              </label>
            ) : (
              <label className="space-y-2 text-sm text-[#c8daf4]">
                <span>New Valid Until</span>
                <input
                  type="datetime-local"
                  required
                  className="modal-input"
                  value={extendState.validUntil}
                  onChange={(event) =>
                    setExtendState((prev) =>
                      prev
                        ? {
                            ...prev,
                            validUntil: event.target.value,
                          }
                        : prev,
                    )
                  }
                />
              </label>
            )}

            <button type="submit" className="luxury-btn inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold">
              <ClockArrowUp className="h-4 w-4" />
              Apply Extension
            </button>
          </form>
        </ModalShell>
      ) : null}
    </section>
  );
}
