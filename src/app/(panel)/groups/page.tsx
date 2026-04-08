"use client";

import { FormEvent, useEffect, useState } from "react";
import { PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

type Group = {
  id: string;
  groupId: string;
  name?: string;
  fbAccountId?: string;
  csvPath: string;
  isActive?: boolean;
};

type Account = { id: string; name: string };

export default function GroupsPage() {
  const [items, setItems] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [assignmentFilter, setAssignmentFilter] = useState<"all" | "assigned" | "unassigned">("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFile, setBulkFile] = useState<File | null>(null);

  async function loadItems() {
    const [groupsRes, accountsRes] = await Promise.all([
      fetch("/api/admin/fb-groups"),
      fetch("/api/admin/fb-accounts"),
    ]);

    setItems((await groupsRes.json()) as Group[]);
    setAccounts((await accountsRes.json()) as Account[]);
  }

  useEffect(() => {
    loadItems();
  }, []);

  async function addGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const formData = new FormData(formElement);
    await fetch("/api/admin/fb-groups", {
      method: "POST",
      body: formData,
    });

    formElement.reset();
    setOpen(false);
    await loadItems();
  }

  async function assignAccount(groupId: string, fbAccountId: string) {
    await fetch("/api/admin/fb-groups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId, fbAccountId: fbAccountId || undefined }),
    });

    await loadItems();
  }

  async function toggleActive(groupId: string, isActive: boolean) {
    await fetch("/api/admin/fb-groups", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: groupId, isActive: !isActive }),
    });

    await loadItems();
  }

  async function deleteGroup(id: string) {
    await fetch("/api/admin/fb-groups", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    await loadItems();
  }

  async function uploadBulkGroups(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!bulkFile) {
      return;
    }

    const form = new FormData();
    form.set("action", "bulk");
    form.set("file", bulkFile);

    const response = await fetch("/api/admin/fb-groups", {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      alert(payload.error || "Failed to import CSV");
      return;
    }

    setBulkOpen(false);
    setBulkFile(null);
    await loadItems();
  }

  function downloadTemplate() {
    const content = [
      "group_id,name,fb_account_id,is_active",
      "1234567890,My Group,,true",
    ].join("\n");

    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "groups-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const filteredItems = items.filter((item) => {
    const byText = search.trim()
      ? [item.name, item.groupId].filter(Boolean).join(" ").toLowerCase().includes(search.trim().toLowerCase())
      : true;
    const byAssignment =
      assignmentFilter === "all"
        ? true
        : assignmentFilter === "assigned"
          ? Boolean(item.fbAccountId)
          : !item.fbAccountId;
    return byText && byAssignment;
  });

  const assignedCount = items.filter((item) => Boolean(item.fbAccountId)).length;
  const unassignedCount = items.length - assignedCount;
  const coverage = items.length > 0 ? Math.round((assignedCount / items.length) * 100) : 0;

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="app-title">Groups Management</h1>
          <p className="app-subtitle">Manage your Facebook groups</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={downloadTemplate} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Download Template
          </button>
          <button onClick={() => setBulkOpen(true)} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Upload CSV
          </button>
          <button onClick={() => setOpen(true)} className="luxury-btn inline-flex items-center gap-2 rounded-xl px-5 py-3 font-semibold">
            <PlusIcon className="h-4 w-4" />
            Add Group
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard title="Total Groups" value={items.length} />
        <StatCard title="Assigned Groups" value={assignedCount} />
        <StatCard title="Unassigned Groups" value={unassignedCount} />
        <StatCard title="Coverage" value={`${coverage}%`} />
      </div>

      <div className="app-card grid gap-3 p-4 md:grid-cols-[1.3fr_220px]">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by group name or group ID"
          className="modal-input"
        />
        <select
          value={assignmentFilter}
          onChange={(event) => setAssignmentFilter(event.target.value as "all" | "assigned" | "unassigned")}
          className="modal-input"
        >
          <option value="all">All Assignments</option>
          <option value="assigned">Assigned</option>
          <option value="unassigned">Unassigned</option>
        </select>
      </div>

      {items.length === 0 ? (
        <div className="app-empty">
          <p className="text-xl">No groups yet</p>
          <button onClick={() => setOpen(true)} className="app-empty-action inline-flex items-center gap-2">
            <PlusIcon className="h-4 w-4" />
            Add Group
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredItems.map((item) => (
            <div key={item.id} className="app-card p-4">
              <p className="text-lg font-semibold">{item.name || item.groupId}</p>
              <p className="text-sm text-[#b2c5e3]">Group ID: {item.groupId}</p>
              <p className="text-sm text-[#8ea8cd]">CSV: {item.csvPath}</p>
              <div className="mt-2">
                <span className={`status-chip ${item.fbAccountId ? "status-running" : "status-stopped"}`}>
                  {item.fbAccountId ? "Assigned" : "Unassigned"}
                </span>
              </div>

              <label className="mt-3 grid max-w-md gap-1 text-sm">
                <span className="app-label">Assigned Account</span>
                <select
                  value={item.fbAccountId || ""}
                  onChange={(event) => assignAccount(item.id, event.target.value)}
                  className="modal-input"
                >
                  <option value="">No groups assigned</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>

              <div className="mt-3">
                <button
                  onClick={() => toggleActive(item.id, item.isActive ?? true)}
                  className="btn-subtle mr-2 text-xs"
                >
                  Toggle Active
                </button>
                <button
                  onClick={() => deleteGroup(item.id)}
                  className="btn-subtle text-xs text-[#ffc2cc]"
                >
                  Delete Group
                </button>
              </div>
            </div>
          ))}

          {filteredItems.length === 0 ? (
            <div className="app-empty">
              <p className="text-lg">No groups match current filters.</p>
            </div>
          ) : null}
        </div>
      )}

      {open ? (
        <div className="app-modal-shell">
          <div className="app-modal max-w-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Add New Group</h2>
              <button onClick={() => setOpen(false)} className="btn-subtle inline-flex items-center justify-center">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={addGroup} className="grid gap-3">
              <input name="groupId" required placeholder="Group ID" className="modal-input" />
              <input name="name" placeholder="Group Name" className="modal-input" />
              <select name="fbAccountId" className="modal-input">
                <option value="">Select account (optional)</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>{account.name}</option>
                ))}
              </select>
              <input name="csv" type="file" accept=".csv" className="modal-input" />
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="btn-subtle">Cancel</button>
                <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Save Group</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {bulkOpen ? (
        <div className="app-modal-shell">
          <div className="app-modal max-w-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-2xl font-semibold">Bulk Upload Groups</h2>
              <button onClick={() => setBulkOpen(false)} className="btn-subtle inline-flex items-center justify-center">
                <XMarkIcon className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={uploadBulkGroups} className="grid gap-3">
              <label className="grid gap-1 text-sm">
                <span className="app-label">CSV File</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  required
                  onChange={(event) => setBulkFile(event.target.files?.[0] ?? null)}
                  className="modal-input"
                />
              </label>

              <p className="text-xs text-[#9fb4d5]">Required schema: group_id,name,fb_account_id,is_active</p>

              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => setBulkOpen(false)} className="btn-subtle">Cancel</button>
                <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Import CSV</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function StatCard({ title, value }: { title: string; value: number | string }) {
  return (
    <div className="app-card p-4">
      <p className="text-sm text-[#acc0de]">{title}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
