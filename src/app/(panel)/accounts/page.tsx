"use client";

import { FormEvent, useEffect, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

type Account = {
  id: string;
  name: string;
  alias?: string;
  username: string;
  postFilter?: string;
  postingMethod?: string;
  isActive: boolean;
};

const postingMethods = [
  { value: "post-all-sequential", label: "Post to All Groups (One Post at a Time)" },
  { value: "one-post-per-account", label: "One Post Per Account (Unique, All Groups)" },
  { value: "random", label: "Random (Shuffle)" },
  { value: "random-no-repeat", label: "Random (No Repeat Across Accounts)" },
  { value: "progressive", label: "Progressive (Sequential)" },
];

const postFilters = [
  { value: "all", label: "All Posts" },
  { value: "with-comments", label: "Only with Comments" },
  { value: "without-comments", label: "Only without Comments" },
];

export default function AccountsPage() {
  const [items, setItems] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [sessionState, setSessionState] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sessionFilter, setSessionFilter] = useState<"all" | "logged-in" | "logged-out">("all");

  async function loadItems() {
    const res = await fetch("/api/admin/fb-accounts");
    const data = (await res.json()) as Account[];
    setItems(data);

    const statuses = await Promise.all(
      data.map(async (item) => {
        const response = await fetch(`/api/admin/accounts/session?accountId=${item.id}`);
        const json = (await response.json()) as { hasSession: boolean };
        return [item.id, json.hasSession] as const;
      })
    );

    setSessionState(Object.fromEntries(statuses));
  }

  useEffect(() => {
    loadItems();
  }, []);

  async function addAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const proxyHost = String(form.get("socks5ProxyHost") ?? "").trim();
    const proxyPortRaw = String(form.get("socks5ProxyPort") ?? "").trim();
    const proxyPort = proxyPortRaw ? Number(proxyPortRaw) : undefined;

    await fetch("/api/admin/fb-accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(form.get("name") ?? ""),
        alias: String(form.get("alias") ?? ""),
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
        socks5ProxyHost: proxyHost || undefined,
        socks5ProxyPort: Number.isFinite(proxyPort) ? proxyPort : undefined,
      }),
    });

    formElement?.reset();
    setOpen(false);
    await loadItems();
  }

  async function updateAccount(
    id: string,
    patch: Partial<Pick<Account, "postFilter" | "postingMethod" | "isActive">>
  ) {
    await fetch("/api/admin/fb-accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...patch }),
    });

    await loadItems();
  }

  async function deleteAccount(id: string) {
    await fetch("/api/admin/fb-accounts", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    await loadItems();
  }

  const filteredItems = items.filter((item) => {
    const byText = search.trim()
      ? [item.name, item.alias, item.username].filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase())
      : true;
    const byStatus =
      statusFilter === "all"
        ? true
        : statusFilter === "active"
          ? item.isActive
          : !item.isActive;
    const bySession =
      sessionFilter === "all"
        ? true
        : sessionFilter === "logged-in"
          ? Boolean(sessionState[item.id])
          : !sessionState[item.id];

    return byText && byStatus && bySession;
  });

  const activeCount = items.filter((item) => item.isActive).length;
  const loggedInCount = items.filter((item) => sessionState[item.id]).length;
  const proxyReadyCount = items.filter((item) => Boolean(item.postingMethod)).length;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Accounts Management</h1>
          <p className="app-subtitle">Manage your Facebook accounts</p>
        </div>
        <button onClick={() => setOpen(true)} className="luxury-btn inline-flex items-center gap-2 rounded-xl px-5 py-3 font-semibold">
          <PlusIcon className="h-4 w-4" />
          Add Account
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <InfoCard label="Total Accounts" value={items.length} />
        <InfoCard label="Active Accounts" value={activeCount} />
        <InfoCard label="Logged In Sessions" value={loggedInCount} />
        <InfoCard label="Configured Posting Mode" value={proxyReadyCount} />
      </div>

      <div className="app-card grid gap-3 p-4 md:grid-cols-[1.4fr_220px_220px]">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, alias, or username"
          className="modal-input"
        />
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "inactive")}
          className="modal-input"
        >
          <option value="all">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <select
          value={sessionFilter}
          onChange={(event) => setSessionFilter(event.target.value as "all" | "logged-in" | "logged-out")}
          className="modal-input"
        >
          <option value="all">All Sessions</option>
          <option value="logged-in">Logged In</option>
          <option value="logged-out">Logged Out</option>
        </select>
      </div>

      {items.length === 0 ? (
        <EmptyState text="No accounts yet" actionText="Add Account" onClick={() => setOpen(true)} />
      ) : (
        <div className="grid gap-4">
          {filteredItems.map((item) => (
            <div key={item.id} className="app-card p-4">
              <p className="text-lg font-semibold">{item.name}</p>
              <p className="text-sm text-[#afc2e0]">{item.alias || item.username}</p>
              <div className="mt-2">
                <span
                  className={`status-chip ${sessionState[item.id] ? "status-running" : "status-stopped"}`}
                >
                  {sessionState[item.id] ? "Logged In" : "Not Logged In"}
                </span>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-sm">
                  <span className="app-label">Post Filter</span>
                  <select
                    className="modal-input"
                    value={item.postFilter || "all"}
                    onChange={(event) =>
                      updateAccount(item.id, { postFilter: event.target.value })
                    }
                  >
                    {postFilters.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="grid gap-1 text-sm">
                  <span className="app-label">Posting Method</span>
                  <select
                    className="modal-input"
                    value={item.postingMethod || "post-all-sequential"}
                    onChange={(event) =>
                      updateAccount(item.id, { postingMethod: event.target.value })
                    }
                  >
                    {postingMethods.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => updateAccount(item.id, { isActive: !item.isActive })}
                  className="btn-subtle text-xs"
                >
                  {item.isActive ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => deleteAccount(item.id)}
                  className="btn-subtle text-xs text-[#ffc2cc]"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}

          {filteredItems.length === 0 ? (
            <div className="app-empty">
              <p className="text-lg">No accounts match current filters.</p>
            </div>
          ) : null}
        </div>
      )}

      {open ? (
        <Modal title="Add New Account" onClose={() => setOpen(false)}>
          <form onSubmit={addAccount} className="grid gap-3">
            <input name="name" required placeholder="Name" className="modal-input" />
            <input name="alias" placeholder="Alias (optional)" className="modal-input" />
            <input name="username" required placeholder="Facebook username" className="modal-input" />
            <input name="password" type="password" required placeholder="Password" className="modal-input" />
            <div className="grid gap-3 md:grid-cols-2">
              <input name="socks5ProxyHost" placeholder="SOCKS5 proxy IP (optional)" className="modal-input" />
              <input name="socks5ProxyPort" type="number" placeholder="SOCKS5 proxy port (optional)" className="modal-input" />
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-subtle">Cancel</button>
              <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Save Account</button>
            </div>
          </form>
        </Modal>
      ) : null}
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="app-card p-4">
      <p className="text-sm text-[#acc0de]">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function EmptyState({ text, actionText, onClick }: { text: string; actionText: string; onClick: () => void }) {
  return (
    <div className="app-empty">
      <p className="text-xl">{text}</p>
      <button onClick={onClick} className="app-empty-action inline-flex items-center gap-2">
        <PlusIcon className="h-4 w-4" />
        {actionText}
      </button>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="app-modal-shell">
      <div className="app-modal max-w-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-subtle inline-flex items-center justify-center">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
