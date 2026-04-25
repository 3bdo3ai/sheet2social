"use client";

import { FormEvent, useEffect, useState } from "react";
import { PlusIcon } from "@heroicons/react/24/outline";

type ProxyItem = {
  id: string;
  ipAddress: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export default function ProxiesPage() {
  const [items, setItems] = useState<ProxyItem[]>([]);
  const [proxyRotationEnabled, setProxyRotationEnabled] = useState(false);
  const [search, setSearch] = useState("");
  const [showSecrets, setShowSecrets] = useState(false);

  async function readResponseMessage(response: Response): Promise<string | undefined> {
    const text = await response.text();
    if (!text.trim()) {
      return undefined;
    }

    try {
      const payload = JSON.parse(text) as { error?: string; message?: string };
      return payload.error || payload.message;
    } catch {
      return text;
    }
  }

  async function loadData() {
    const res = await fetch("/api/admin/proxies");
    if (!res.ok) {
      const message = await readResponseMessage(res);
      throw new Error(message || "Failed to load proxies");
    }

    const data = (await res.json()) as {
      proxyRotationEnabled: boolean;
      items: ProxyItem[];
    };

    setProxyRotationEnabled(data.proxyRotationEnabled);
    setItems(data.items);
  }

  useEffect(() => {
    loadData().catch((error) => {
      const message = error instanceof Error ? error.message : "Failed to load proxies";
      alert(message);
    });
  }, []);

  async function saveAll(nextItems: ProxyItem[], nextEnabled = proxyRotationEnabled) {
    const response = await fetch("/api/admin/proxies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: nextItems, proxyRotationEnabled: nextEnabled }),
    });

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to save proxies");
      return;
    }

    await loadData();
  }

  async function addProxy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const port = Number(form.get("port") ?? 0);

    if (!Number.isFinite(port) || port <= 0) {
      alert("Please enter a valid proxy port.");
      return;
    }

    const response = await fetch("/api/admin/proxies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ipAddress: String(form.get("ipAddress") ?? ""),
        port,
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
      }),
    });

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to add proxy");
      return;
    }

    formElement.reset();
    await loadData();
  }

  async function deleteProxy(id: string) {
    const response = await fetch("/api/admin/proxies", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to remove proxy");
      return;
    }

    await loadData();
  }

  const filteredItems = items.filter((item) => {
    const haystack = `${item.ipAddress}:${item.port} ${item.username || ""}`.toLowerCase();
    return search.trim() ? haystack.includes(search.trim().toLowerCase()) : true;
  });

  const uniqueEndpoints = new Set(items.map((item) => `${item.ipAddress}:${item.port}`)).size;
  const authenticated = items.filter((item) => Boolean(item.username && item.password)).length;
  const duplicates = Math.max(0, items.length - uniqueEndpoints);

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Proxy Management</h1>
          <p className="app-subtitle">Configure SOCKS5 proxies</p>
        </div>
        <button onClick={() => saveAll(items)} className="luxury-btn rounded-xl px-5 py-3 font-semibold">Save Proxies</button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <MiniStat label="Total Proxies" value={items.length} />
        <MiniStat label="Unique Endpoints" value={uniqueEndpoints} />
        <MiniStat label="Auth Configured" value={authenticated} />
        <MiniStat label="Duplicate Endpoints" value={duplicates} />
      </div>

      <div className="app-card flex flex-wrap items-center gap-3 p-4">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by IP, port, or username"
          className="modal-input max-w-md"
        />
        <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[#0f1f3a] px-3 py-2 text-sm">
          <input type="checkbox" checked={showSecrets} onChange={(event) => setShowSecrets(event.target.checked)} />
          Show Credentials
        </label>
      </div>

      <label className="app-card flex items-start gap-3 p-4">
        <input
          type="checkbox"
          checked={proxyRotationEnabled}
          onChange={(event) => {
            const next = event.target.checked;
            setProxyRotationEnabled(next);
            saveAll(items, next);
          }}
          className="mt-1"
        />
        <span>
          <span className="block text-lg font-semibold">Enable SOCKS5 Proxy Rotation</span>
          <span className="block text-sm text-[#a0b6d6]">When enabled, each account will be assigned a sticky SOCKS5 proxy.</span>
        </span>
      </label>

      <form onSubmit={addProxy} className="app-card grid gap-3 p-4 md:grid-cols-[1.2fr_120px_1fr_1fr_auto]">
        <input name="ipAddress" required placeholder="IP Address" className="modal-input" />
        <input name="port" required type="number" placeholder="Port" className="modal-input" />
        <input name="username" placeholder="Username" className="modal-input" />
        <input name="password" placeholder="Password" className="modal-input" />
        <button type="submit" className="luxury-btn inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold">
          <PlusIcon className="h-4 w-4" />
          Add
        </button>
      </form>

      <div className="app-table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th className="px-4 py-3">IP Address</th>
              <th className="px-4 py-3">Port</th>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Password</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[#9fb4d5]">No proxies added yet.</td>
              </tr>
            ) : (
              filteredItems.map((item) => (
                <tr key={item.id}>
                  <td className="px-4 py-3">{item.ipAddress}</td>
                  <td className="px-4 py-3">{item.port}</td>
                  <td className="px-4 py-3">{showSecrets ? item.username || "-" : item.username ? "********" : "-"}</td>
                  <td className="px-4 py-3">{showSecrets ? item.password || "-" : item.password ? "********" : "-"}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => deleteProxy(item.id)}
                      className="btn-subtle text-xs"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))
            )}
            {items.length > 0 && filteredItems.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-[#9fb4d5]">No proxies match current search.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="app-card p-4">
      <p className="text-sm text-[#acc0de]">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
