"use client";

import { FormEvent, useEffect, useState } from "react";
import { EyeIcon, EyeSlashIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";

import { ModalShell } from "@/components/ui/modal-shell";

type Account = {
  id: string;
  name: string;
  alias?: string;
  username: string;
  password: string;
  twoFactorSecret?: string;
  proxyId?: string;
  socks5ProxyHost?: string;
  socks5ProxyPort?: number;
  socks5ProxyUsername?: string;
  socks5ProxyPassword?: string;
  postFilter?: string;
  postingMethod?: string;
  isActive: boolean;
  disabledAt?: string;
  disabledUntil?: string;
  disabledReason?: string;
  disabledType?: "manual" | "automatic";
  createdAt?: string;
  updatedAt?: string;
};

type ProxyItem = {
  id: string;
  ipAddress: string;
  port: number;
  username?: string;
  password?: string;
};

type SessionStatus = {
  hasSession: boolean;
  reason?: "no-cookies" | "cookies-only" | "auth-cookies-present";
  cookieCount?: number;
};

type ManualLoginState = {
  accountId: string;
  accountName: string;
  manualLoginId: string;
  message: string;
  proxyPublicIp?: string;
};

type LoginActivityState = {
  proxyPublicIp?: string;
  message?: string;
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
  const [proxies, setProxies] = useState<ProxyItem[]>([]);
  const [open, setOpen] = useState(false);
  const [sessionState, setSessionState] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sessionFilter, setSessionFilter] = useState<"all" | "logged-in" | "logged-out">("all");
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [cookieLoginOpen, setCookieLoginOpen] = useState(false);
  const [cookieLoginLoading, setCookieLoginLoading] = useState(false);
  const [showAccountPassword, setShowAccountPassword] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [cookieText, setCookieText] = useState("");
  const [cookieLoading, setCookieLoading] = useState(false);
  const [proxyFallbackAccount, setProxyFallbackAccount] = useState<Account | null>(null);
  const [loginMessage, setLoginMessage] = useState("");
  const [manualLoginState, setManualLoginState] = useState<ManualLoginState | null>(null);
  const [manualLoginChecking, setManualLoginChecking] = useState(false);
  const [loginActivityState, setLoginActivityState] = useState<Record<string, LoginActivityState>>({});

  function normalizeCookiePayload(raw: unknown): unknown[] {
    if (Array.isArray(raw)) {
      return raw;
    }

    if (raw && typeof raw === "object") {
      const value = raw as Record<string, unknown>;
      if (Array.isArray(value.cookies)) {
        return value.cookies;
      }
    }

    return [];
  }

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

  async function safeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(input, init);
    } catch {
      throw new Error("Network request failed. Please verify the server is running and try again.");
    }
  }

  async function loadItems() {
    let accountsRes: Response;
    let proxiesRes: Response;

    try {
      [accountsRes, proxiesRes] = await Promise.all([
        safeFetch("/api/admin/fb-accounts"),
        safeFetch("/api/admin/proxies"),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load accounts data.";
      alert(message);
      return;
    }

    if (!accountsRes.ok) {
      const message = await readResponseMessage(accountsRes);
      alert(message || "Failed to load accounts");
      return;
    }

    if (!proxiesRes.ok) {
      const message = await readResponseMessage(proxiesRes);
      alert(message || "Failed to load proxies");
      return;
    }

    let data: Account[];
    let proxyData: { items: ProxyItem[] };
    try {
      data = (await accountsRes.json()) as Account[];
      proxyData = (await proxiesRes.json()) as { items: ProxyItem[] };
    } catch {
      alert("Received an unexpected response while loading data.");
      return;
    }

    setItems(data);
    setProxies(proxyData.items);

    const statuses = await Promise.all(
      data.map(async (item) => {
        try {
          const response = await safeFetch(`/api/admin/accounts/session?accountId=${item.id}`);
          if (!response.ok) {
            return [item.id, false] as const;
          }

          const json = (await response.json()) as SessionStatus;
          return [item.id, json.hasSession] as const;
        } catch {
          return [item.id, false] as const;
        }
      })
    );

    setSessionState(Object.fromEntries(statuses));
  }

  useEffect(() => {
    void loadItems();
  }, []);

  async function addAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formElement = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent | undefined)?.submitter as HTMLButtonElement | null;
    const autoLogin = submitter?.value !== "manual";
    const form = new FormData(formElement);
    const proxyHost = String(form.get("socks5ProxyHost") ?? "").trim();
    const proxyPortRaw = String(form.get("socks5ProxyPort") ?? "").trim();
    const proxyUsername = String(form.get("socks5ProxyUsername") ?? "").trim();
    const proxyPassword = String(form.get("socks5ProxyPassword") ?? "").trim();
    const twoFactorSecret = String(form.get("twoFactorSecret") ?? "").trim();
    const proxyId = String(form.get("proxyId") ?? "").trim();
    const proxyPort = proxyPortRaw ? Number(proxyPortRaw) : undefined;

    let response: Response;
    try {
      response = await safeFetch("/api/admin/fb-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          alias: String(form.get("alias") ?? ""),
          username: String(form.get("username") ?? ""),
          password: String(form.get("password") ?? ""),
          twoFactorSecret: twoFactorSecret || undefined,
          proxyId: proxyId || undefined,
          socks5ProxyHost: proxyHost || undefined,
          socks5ProxyPort: Number.isFinite(proxyPort) ? proxyPort : undefined,
          socks5ProxyUsername: proxyUsername || undefined,
          socks5ProxyPassword: proxyPassword || undefined,
          autoLogin,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save account";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to save account");
      return;
    }

    const result = (await response.json()) as Account & {
      loginSucceeded?: boolean;
      loginProxyIp?: string;
      loginMessage?: string;
      loginAttempted?: boolean;
    };

    if (result.id && (result.loginMessage || result.loginProxyIp)) {
      setLoginActivityState((prev) => ({
        ...prev,
        [result.id]: {
          message: result.loginMessage,
          proxyPublicIp: result.loginProxyIp,
        },
      }));
    }

    formElement?.reset();
    setShowAccountPassword(false);
    setOpen(false);
    await loadItems();

    if (autoLogin) {
      alert(
        result.loginMessage ||
          (result.loginSucceeded
            ? "Account saved and automatic login completed."
            : "Account saved, but automatic login did not complete.")
      );
      return;
    }

    if (!result.id) {
      alert("Account saved manually. Use Manual Login from the account card to continue.");
      return;
    }

    await startManualLogin({
      id: result.id,
      name: result.name || String(form.get("name") ?? "Facebook Account"),
    });
  }

  async function updateAccount(
    id: string,
    patch: Partial<Account>
  ) {
    let response: Response;
    try {
      response = await safeFetch("/api/admin/fb-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to update account");
      return;
    }

    await loadItems();
  }

  async function deleteAccount(id: string) {
    let response: Response;
    try {
      response = await safeFetch("/api/admin/fb-accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete account";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to delete account");
      return;
    }

    await loadItems();
  }

  function openAccountEditor(account: Account) {
    setEditingAccount(account);
    setCookieText("");
    setCookieLoading(false);
  }

  function formatDateTime(value?: string) {
    if (!value) {
      return "Unknown";
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
  }

  async function loadAccountCookies(accountId: string) {
    setCookieLoading(true);
    try {
      const response = await safeFetch(`/api/admin/accounts/session?accountId=${accountId}&includeCookies=true`);
      if (!response.ok) {
          const message = await readResponseMessage(response);
          alert(message || "Failed to load cookies");
        return;
      }

      const result = (await response.json()) as SessionStatus & { cookies?: unknown[] };
      if (!result.hasSession) {
        if (result.reason === "cookies-only") {
          setCookieText("Cookies are saved, but Facebook authentication was not confirmed. Missing c_user/xs session cookies.");
          return;
        }

        setCookieText("No saved session cookies found for this account.");
        return;
      }

      setCookieText(JSON.stringify(result.cookies ?? [], null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load cookies";
      alert(message);
    } finally {
      setCookieLoading(false);
    }
  }

  async function saveAccountDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!editingAccount) {
      return;
    }

    const form = new FormData(event.currentTarget);
    let response: Response;
    try {
      response = await safeFetch("/api/admin/fb-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingAccount.id,
          name: String(form.get("name") ?? ""),
          alias: String(form.get("alias") ?? ""),
          username: String(form.get("username") ?? ""),
          password: String(form.get("password") ?? ""),
          twoFactorSecret: String(form.get("twoFactorSecret") ?? ""),
          proxyId: String(form.get("proxyId") ?? ""),
          socks5ProxyHost: String(form.get("socks5ProxyHost") ?? ""),
          socks5ProxyPort: String(form.get("socks5ProxyPort") ?? ""),
          socks5ProxyUsername: String(form.get("socks5ProxyUsername") ?? ""),
          socks5ProxyPassword: String(form.get("socks5ProxyPassword") ?? ""),
          postFilter: String(form.get("postFilter") ?? "all"),
          postingMethod: String(form.get("postingMethod") ?? "post-all-sequential"),
          isActive: form.get("isActive") === "on",
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update account";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to update account");
      return;
    }

    setEditingAccount(null);
    setCookieText("");
    await loadItems();
  }

  async function startManualLogin(account: Pick<Account, "id" | "name">) {
    let response: Response;
    try {
      response = await safeFetch("/api/admin/accounts/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual-start",
          accountId: account.id,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to open manual login popup";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Unable to open manual login popup");
      return;
    }

    const result = (await response.json()) as {
      manualLoginId?: string;
      message?: string;
      proxyPublicIp?: string;
    };

    if (!result.manualLoginId) {
      alert("Manual login popup could not be started.");
      return;
    }

    setManualLoginState({
      accountId: account.id,
      accountName: account.name,
      manualLoginId: result.manualLoginId,
      proxyPublicIp: result.proxyPublicIp,
      message:
        result.message ||
        "Manual login popup is ready. Complete login there, then click Logged In.",
    });

    setLoginActivityState((prev) => ({
      ...prev,
      [account.id]: {
        message: result.message,
        proxyPublicIp: result.proxyPublicIp,
      },
    }));
  }

  async function confirmManualLogin() {
    if (!manualLoginState || manualLoginChecking) {
      return;
    }

    setManualLoginChecking(true);

    try {
      const response = await safeFetch("/api/admin/accounts/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "manual-confirm",
          manualLoginId: manualLoginState.manualLoginId,
        }),
      });

      if (!response.ok) {
        const message = await readResponseMessage(response);
        alert(message || "Failed to verify manual login");
        return;
      }

      const result = (await response.json()) as { hasSession?: boolean; message?: string; proxyPublicIp?: string };

      setLoginActivityState((prev) => ({
        ...prev,
        [manualLoginState.accountId]: {
          message: result.message,
          proxyPublicIp: result.proxyPublicIp ?? prev[manualLoginState.accountId]?.proxyPublicIp,
        },
      }));

      if (result.hasSession) {
        alert(result.message || "Manual login completed.");
        setManualLoginState(null);
        await loadItems();
        return;
      }

      setManualLoginState((prev) =>
        prev
          ? {
              ...prev,
              message:
                result.message ||
                "Login is not complete yet. Finish it in the browser popup and click Logged In again.",
            }
          : prev
      );

      await loadItems();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to verify manual login";
      alert(message);
    } finally {
      setManualLoginChecking(false);
    }
  }

  async function cancelManualLogin() {
    if (!manualLoginState) {
      return;
    }

    const manualLoginId = manualLoginState.manualLoginId;
    setManualLoginState(null);
    setManualLoginChecking(false);

    await fetch("/api/admin/accounts/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "manual-cancel",
        manualLoginId,
      }),
    }).catch(() => undefined);
  }

  async function retryLogin(accountId: string) {
    let response: Response;
    try {
      response = await safeFetch("/api/admin/accounts/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auto-login", accountId }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login attempt failed";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Login attempt failed");
      return;
    }

    const result = (await response.json()) as {
      hasSession?: boolean;
      message?: string;
      proxyPublicIp?: string;
    };
    setLoginActivityState((prev) => ({
      ...prev,
      [accountId]: {
        message: result.message,
        proxyPublicIp: result.proxyPublicIp,
      },
    }));

    if (result.message) {
      const msg = result.message.toLowerCase();
      if (msg.includes("unreachable") || msg.includes("offline") || msg.includes("proxy")) {
        const item = items.find(i => i.id === accountId);
        if (item) {
          setLoginMessage(result.message);
          setProxyFallbackAccount(item);
          await loadItems();
          return;
        }
      }
      alert(result.message);
    }

    await loadItems();
  }

  async function submitProxyFallback(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proxyFallbackAccount) return;

    const form = new FormData(event.currentTarget);
    const proxyId = String(form.get("proxyId") ?? "");
    const keepWithoutProxy = form.get("withoutProxy") === "on";

    try {
      if (keepWithoutProxy) {
        const response = await safeFetch("/api/admin/fb-accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
             id: proxyFallbackAccount.id,
             proxyId: "", 
             socks5ProxyHost: "", 
             socks5ProxyPort: null, 
             socks5ProxyUsername: "", 
             socks5ProxyPassword: "" 
          }),
        });

        if (!response.ok) {
          const message = await readResponseMessage(response);
          alert(message || "Failed to update proxy configuration");
          return;
        }
      } else if (proxyId) {
        const response = await safeFetch("/api/admin/fb-accounts", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: proxyFallbackAccount.id, proxyId }),
        });

        if (!response.ok) {
          const message = await readResponseMessage(response);
          alert(message || "Failed to update proxy configuration");
          return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update proxy configuration";
      alert(message);
      return;
    }

    const accountIdToRetry = proxyFallbackAccount.id;
    setProxyFallbackAccount(null);
    setLoginMessage("");
    await retryLogin(accountIdToRetry);
  }

  async function uploadBulkAccounts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!bulkFile) {
      return;
    }

    const form = new FormData();
    form.set("action", "bulk");
    form.set("file", bulkFile);

    let response: Response;
    try {
      response = await safeFetch("/api/admin/fb-accounts", {
        method: "POST",
        body: form,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import CSV";
      alert(message);
      return;
    }

    if (!response.ok) {
      const message = await readResponseMessage(response);
      alert(message || "Failed to import CSV");
      return;
    }

    setBulkOpen(false);
    setBulkFile(null);
    await loadItems();
  }

  async function loginWithCookies(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (cookieLoginLoading) {
      return;
    }

    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const alias = String(form.get("alias") ?? "").trim();
    const proxyId = String(form.get("proxyId") ?? "").trim();
    const cookieFile = form.get("cookieFile");
    const cookiesJson = String(form.get("cookiesJson") ?? "").trim();

    if (!name) {
      alert("Account name is required.");
      return;
    }

    let rawText = cookiesJson;
    if (cookieFile instanceof File && cookieFile.size > 0) {
      rawText = await cookieFile.text();
    }

    if (!rawText.trim()) {
      alert("Provide cookies JSON by upload or paste.");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      alert("Invalid JSON format in cookies input.");
      return;
    }

    const cookies = normalizeCookiePayload(parsed);
    if (cookies.length === 0) {
      alert("No cookies found. Use either a cookies array or { cookies: [...] } format.");
      return;
    }

    setCookieLoginLoading(true);
    try {
      const response = await safeFetch("/api/admin/accounts/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cookie-login",
          name,
          alias: alias || undefined,
          proxyId: proxyId || undefined,
          cookies,
        }),
      });

      if (!response.ok) {
        const message = await readResponseMessage(response);
        alert(message || "Cookie login failed");
        return;
      }

      const result = (await response.json()) as {
        accountId?: string;
        message?: string;
      };

      setCookieLoginOpen(false);
      await loadItems();
      alert(result.message || "Cookie login imported successfully.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cookie login failed";
      alert(message);
    } finally {
      setCookieLoginLoading(false);
    }
  }

  function downloadTemplate() {
    const content = [
      "name,alias,username,password,two_factor_secret,socks5_proxy_host,socks5_proxy_port,socks5_proxy_username,socks5_proxy_password,post_filter,posting_method,is_active",
      "Main Account,Alias One,user@example.com,secret123,,127.0.0.1,1080,proxyuser,proxypass,all,post-all-sequential,true",
    ].join("\n");

    const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "accounts-template.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
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
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={downloadTemplate} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Download Template
          </button>
          <button onClick={() => setBulkOpen(true)} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Upload CSV
          </button>
          <button onClick={() => setCookieLoginOpen(true)} className="btn-subtle rounded-xl px-4 py-3 text-sm font-semibold">
            Login with Cookies
          </button>
          <button onClick={() => setOpen(true)} className="luxury-btn inline-flex items-center gap-2 rounded-xl px-5 py-3 font-semibold">
            <PlusIcon className="h-4 w-4" />
            Add Account
          </button>
        </div>
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
              <div className="mt-2 grid gap-1 text-xs text-[#9fb4d5]">
                <p>Username: {item.username}</p>
                <p>Proxy: {item.proxyId ? "Saved proxy linked" : item.socks5ProxyHost ? `${item.socks5ProxyHost}:${item.socks5ProxyPort ?? ""}` : "No proxy"}</p>
                <p>Post filter: {item.postFilter || "all"}</p>
                <p>Posting method: {item.postingMethod || "post-all-sequential"}</p>
              </div>
              <div className="mt-2">
                <span
                  className={`status-chip ${sessionState[item.id] ? "status-running" : "status-stopped"}`}
                >
                  {sessionState[item.id] ? "Logged In" : "Not Logged In"}
                </span>
                {!item.isActive && (
                  <span className={`status-chip ml-2 ${item.disabledType === "automatic" ? "bg-amber-900 text-amber-100" : "bg-red-900 text-red-100"}`}>
                    {item.disabledType === "automatic" && item.disabledUntil
                      ? `Paused until ${formatDateTime(item.disabledUntil)}`
                      : "Disabled"}
                  </span>
                )}
              </div>

              {!item.isActive && item.disabledAt && (
                <div className="mt-3 rounded-lg border border-red-800 bg-red-950 p-3 text-xs text-red-100">
                  <p className="font-semibold">
                    {item.disabledType === "automatic" ? "Paused automatically" : "Disabled manually"}
                  </p>
                  <p className="mt-1">
                    <strong>Reason:</strong> {item.disabledReason || "No reason recorded"}
                  </p>
                  <p className="mt-1">
                    <strong>Disabled at:</strong> {formatDateTime(item.disabledAt)}
                  </p>
                  {item.disabledUntil ? (
                    <p className="mt-1">
                      <strong>Re-enable at:</strong> {formatDateTime(item.disabledUntil)}
                    </p>
                  ) : null}
                  {item.disabledType === "automatic" && item.disabledUntil ? (
                    <p className="mt-1 text-amber-200">
                      The worker will return this account to the active pool automatically when the pause ends.
                    </p>
                  ) : null}
                </div>
              )}

              {loginActivityState[item.id]?.proxyPublicIp ? (
                <p className="mt-2 text-xs text-[#8fd6ff]">
                  Active Proxy IP: {loginActivityState[item.id]?.proxyPublicIp}
                </p>
              ) : null}

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
                  onClick={() => openAccountEditor(item)}
                  className="btn-subtle text-xs"
                >
                  Edit / Details
                </button>
                <button
                  onClick={() => retryLogin(item.id)}
                  className="btn-subtle text-xs"
                >
                  {sessionState[item.id] ? "Refresh Auto Login" : "Try Auto Login"}
                </button>
                <button
                  onClick={() => {
                    void startManualLogin(item);
                  }}
                  className="btn-subtle text-xs"
                >
                  Manual Popup Login
                </button>
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
            <div className="grid gap-1">
              <span className="app-label text-sm">Password</span>
              <div className="flex items-center gap-2">
                <input
                  name="password"
                  type={showAccountPassword ? "text" : "password"}
                  required
                  placeholder="Password"
                  className="modal-input"
                />
                <button
                  type="button"
                  onClick={() => setShowAccountPassword((value) => !value)}
                  className="btn-subtle inline-flex h-11 w-11 items-center justify-center"
                  aria-label={showAccountPassword ? "Hide password" : "Show password"}
                >
                  {showAccountPassword ? (
                    <EyeSlashIcon className="h-4 w-4" />
                  ) : (
                    <EyeIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <input name="twoFactorSecret" placeholder="2FA code or secret (optional)" className="modal-input" />
            <p className="text-xs text-[#9fb4d5]">
              Accepts either a 6-digit authentication code or a Base32 2FA secret. If you provide a secret, it is converted to a live code automatically.
            </p>
            <label className="grid gap-1 text-sm">
              <span className="app-label">Saved Proxy (recommended)</span>
              <select name="proxyId" className="modal-input">
                <option value="">No saved proxy</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.ipAddress}:{proxy.port} {proxy.username ? `(${proxy.username})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs text-[#9fb4d5]">If you select a saved proxy, its username and password from the Proxies page will be used automatically.</p>
            <div className="grid gap-3 md:grid-cols-2">
              <input name="socks5ProxyHost" placeholder="Manual SOCKS5 IP override (optional)" className="modal-input" />
              <input name="socks5ProxyPort" type="number" placeholder="Manual SOCKS5 port override (optional)" className="modal-input" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input name="socks5ProxyUsername" placeholder="Manual proxy username (optional)" className="modal-input" />
              <input name="socks5ProxyPassword" placeholder="Manual proxy password (optional)" className="modal-input" />
            </div>
            <p className="text-xs text-[#9fb4d5]">
              Automatic save uses a mobile Facebook login flow so 2FA prompts can be approved more reliably.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="btn-subtle">Cancel</button>
              <button type="submit" value="manual" className="btn-subtle rounded-lg px-4 py-2 font-semibold">
                Save Manually
              </button>
              <button type="submit" value="automatic" className="luxury-btn rounded-lg px-4 py-2 font-semibold">
                Save &amp; Auto Login
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {manualLoginState ? (
        <Modal
          title={`Manual Login: ${manualLoginState.accountName}`}
          onClose={() => {
            void cancelManualLogin();
          }}
        >
          <div className="grid gap-3 text-sm text-[#cfe0f7]">
            <p>{manualLoginState.message}</p>
            {manualLoginState.proxyPublicIp ? (
              <p className="text-xs text-[#8fd6ff]">Active Proxy IP: {manualLoginState.proxyPublicIp}</p>
            ) : null}
            <p className="text-xs text-[#9fb4d5]">
              Step 1: The system already submitted login. In the popup, complete any Facebook checkpoint or 2FA challenge.
            </p>
            <p className="text-xs text-[#9fb4d5]">
              Step 2: Return here and click Logged In. We will capture and save cookies for the account.
            </p>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                void cancelManualLogin();
              }}
              className="btn-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                void confirmManualLogin();
              }}
              disabled={manualLoginChecking}
              className="luxury-btn rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {manualLoginChecking ? "Checking..." : "Logged In"}
            </button>
          </div>
        </Modal>
      ) : null}

      {proxyFallbackAccount ? (
        <Modal title="Proxy Validation Failed" onClose={() => setProxyFallbackAccount(null)}>
          <form onSubmit={submitProxyFallback} className="grid gap-3">
            <div className="rounded-lg bg-red-900/40 border border-red-500/50 p-4 mb-2">
              <p className="text-red-200 text-sm">{loginMessage || "The configured Proxy is unreachable or offline."}</p>
            </div>
            
            <p className="text-sm text-[#cfe0f7]">
              You can select a different saved proxy to try again, or continue without proxies for this attempt (you can add it later via edit).
            </p>

            <label className="grid gap-1 text-sm mt-3">
              <span className="app-label">Select a different Proxy</span>
              <select name="proxyId" className="modal-input" defaultValue="">
                <option value="">Do not change proxy</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.ipAddress}:{proxy.port} {proxy.username ? `(${proxy.username})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-sm text-[#d8e6fb] mt-2 mb-2 p-2 bg-white/5 rounded-lg border border-white/10">
              <input name="withoutProxy" type="checkbox" />
              Continue without proxies for this account (Remove proxy configuration)
            </label>

            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setProxyFallbackAccount(null)} className="btn-subtle">Cancel (I&apos;ll edit it later)</button>
              <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Update and Try Again</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {bulkOpen ? (
        <Modal title="Bulk Upload Accounts" onClose={() => setBulkOpen(false)}>
          <form onSubmit={uploadBulkAccounts} className="grid gap-3">
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

            <p className="text-xs text-[#9fb4d5]">Required schema: name,alias,username,password,two_factor_secret,socks5_proxy_host,socks5_proxy_port,socks5_proxy_username,socks5_proxy_password,post_filter,posting_method,is_active</p>

            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setBulkOpen(false)} className="btn-subtle">Cancel</button>
              <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Import CSV</button>
            </div>
          </form>
        </Modal>
      ) : null}

      {cookieLoginOpen ? (
        <Modal title="Login with Cookies" onClose={() => setCookieLoginOpen(false)}>
          <form onSubmit={loginWithCookies} className="grid gap-3">
            <input name="name" required placeholder="Account name" className="modal-input" />
            <input name="alias" placeholder="Alias (optional)" className="modal-input" />

            <label className="grid gap-1 text-sm">
              <span className="app-label">Saved Proxy (optional)</span>
              <select name="proxyId" className="modal-input" defaultValue="">
                <option value="">No saved proxy</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.ipAddress}:{proxy.port} {proxy.username ? `(${proxy.username})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-1 text-sm">
              <span className="app-label">Cookie JSON File (optional)</span>
              <input name="cookieFile" type="file" accept="application/json,.json,text/plain" className="modal-input" />
            </label>

            <label className="grid gap-1 text-sm">
              <span className="app-label">Or Paste Cookies JSON</span>
              <textarea
                name="cookiesJson"
                placeholder='Paste cookies array or {"cookies": [...]} JSON'
                className="modal-input min-h-40 font-mono text-xs"
              />
            </label>

            <p className="text-xs text-[#9fb4d5]">
              Required Facebook auth cookies: c_user and xs. The imported account will be available in automation like any other account profile.
            </p>

            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setCookieLoginOpen(false)} className="btn-subtle">Cancel</button>
              <button
                type="submit"
                disabled={cookieLoginLoading}
                className="luxury-btn rounded-lg px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
              >
                {cookieLoginLoading ? "Importing..." : "Login with Cookies"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {editingAccount ? (
        <Modal title={`Edit Account: ${editingAccount.name}`} onClose={() => setEditingAccount(null)}>
          <form onSubmit={saveAccountDetails} className="grid gap-3">
            <input name="name" defaultValue={editingAccount.name} required placeholder="Name" className="modal-input" />
            <input name="alias" defaultValue={editingAccount.alias || ""} placeholder="Alias (optional)" className="modal-input" />
            <input name="username" defaultValue={editingAccount.username} required placeholder="Facebook username" className="modal-input" />
            <div className="grid gap-1">
              <span className="app-label text-sm">Password</span>
              <div className="flex items-center gap-2">
                <input
                  name="password"
                  defaultValue={editingAccount.password}
                  type={showAccountPassword ? "text" : "password"}
                  required
                  placeholder="Password"
                  className="modal-input"
                />
                <button
                  type="button"
                  onClick={() => setShowAccountPassword((value) => !value)}
                  className="btn-subtle inline-flex h-11 w-11 items-center justify-center"
                  aria-label={showAccountPassword ? "Hide password" : "Show password"}
                >
                  {showAccountPassword ? (
                    <EyeSlashIcon className="h-4 w-4" />
                  ) : (
                    <EyeIcon className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            <input name="twoFactorSecret" defaultValue={editingAccount.twoFactorSecret || ""} placeholder="2FA code or secret (optional)" className="modal-input" />
            <p className="text-xs text-[#9fb4d5]">
              Accepts either a 6-digit authentication code or a Base32 2FA secret. Secret values are converted automatically when Facebook requests 2FA.
            </p>
            <label className="grid gap-1 text-sm">
              <span className="app-label">Saved Proxy (recommended)</span>
              <select name="proxyId" defaultValue={editingAccount.proxyId || ""} className="modal-input">
                <option value="">No saved proxy</option>
                {proxies.map((proxy) => (
                  <option key={proxy.id} value={proxy.id}>
                    {proxy.ipAddress}:{proxy.port} {proxy.username ? `(${proxy.username})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <input name="socks5ProxyHost" defaultValue={editingAccount.socks5ProxyHost || ""} placeholder="Manual SOCKS5 IP override (optional)" className="modal-input" />
              <input name="socks5ProxyPort" defaultValue={editingAccount.socks5ProxyPort?.toString() || ""} type="number" placeholder="Manual SOCKS5 port override (optional)" className="modal-input" />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <input name="socks5ProxyUsername" defaultValue={editingAccount.socks5ProxyUsername || ""} placeholder="Manual proxy username (optional)" className="modal-input" />
              <input name="socks5ProxyPassword" defaultValue={editingAccount.socks5ProxyPassword || ""} placeholder="Manual proxy password (optional)" className="modal-input" />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm">
                <span className="app-label">Post Filter</span>
                <select name="postFilter" defaultValue={editingAccount.postFilter || "all"} className="modal-input">
                  {postFilters.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1 text-sm">
                <span className="app-label">Posting Method</span>
                <select name="postingMethod" defaultValue={editingAccount.postingMethod || "post-all-sequential"} className="modal-input">
                  {postingMethods.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-sm text-[#d8e6fb]">
              <input name="isActive" type="checkbox" defaultChecked={editingAccount.isActive} />
              Account is active
            </label>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-[#cfe0f7]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">Session data</p>
                  <p className="text-xs text-[#9fb4d5]">
                    {sessionState[editingAccount.id] ? "Cookies are available for this account." : "No session cookies saved yet."}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={!sessionState[editingAccount.id] || cookieLoading}
                  onClick={() => loadAccountCookies(editingAccount.id)}
                  className="btn-subtle text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {cookieLoading ? "Loading Cookies..." : "View Cookie"}
                </button>
              </div>

              {cookieText ? (
                <textarea
                  readOnly
                  value={cookieText}
                  className="modal-input mt-3 min-h-40 font-mono text-xs"
                />
              ) : null}
            </div>

            <div className="grid gap-1 text-xs text-[#9fb4d5]">
              <p>Created at: {editingAccount.createdAt || "Unknown"}</p>
              <p>Updated at: {editingAccount.updatedAt || "Unknown"}</p>
            </div>

            <div className="mt-2 flex justify-end gap-2">
              <button type="button" onClick={() => setEditingAccount(null)} className="btn-subtle">Cancel</button>
              <button type="submit" className="luxury-btn rounded-lg px-4 py-2 font-semibold">Save Changes</button>
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
    <ModalShell>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-2xl font-semibold">{title}</h2>
          <button onClick={onClose} className="btn-subtle inline-flex items-center justify-center">
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        {children}
    </ModalShell>
  );
}
