"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";

import { getOrCreateDeviceFingerprint } from "@/lib/license/device";

type LoginFormProps = {
  initialReason?: string;
};

function reasonToMessage(reason?: string): string | null {
  if (!reason) {
    return null;
  }

  if (reason === "expired") {
    return "Your subscription has expired. Please renew your key or contact support.";
  }

  if (reason === "revoked") {
    return "This key was revoked and can no longer be used.";
  }

  if (reason === "paused") {
    return "This key is currently paused by an administrator.";
  }

  if (reason === "device_mismatch") {
    return "Key is in use on another device. Please log out there first.";
  }

  if (reason === "missing_session" || reason === "invalid_session") {
    return "Please authenticate using your license key.";
  }

  return null;
}

export function LoginForm({ initialReason }: LoginFormProps) {
  const router = useRouter();
  const [keyString, setKeyString] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(reasonToMessage(initialReason));

  const canSubmit = useMemo(() => keyString.trim().length === 24 && !submitting, [keyString, submitting]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedKey = keyString.trim();
    if (normalizedKey.length !== 24) {
      setError("Please enter a valid 24-character key.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const deviceId = getOrCreateDeviceFingerprint();
      const response = await fetch("/api/license/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          keyString: normalizedKey,
          deviceId,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? "Unable to sign in with this key.");
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        session?: { isAdmin?: boolean };
      };

      if (payload.session?.isAdmin) {
        router.replace("/admin/licenses");
      } else {
        router.replace("/dashboard");
      }

      router.refresh();
    } catch {
      setError("Network error while validating your key. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="app-card w-full max-w-lg p-6 sm:p-8">
      <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[#122545] px-3 py-1 text-xs uppercase tracking-[0.15em] text-[#9cc0eb]">
        <ShieldCheck className="h-3.5 w-3.5" />
        Key-Based Access
      </div>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-[#eef7ff]">Software License Login</h1>
      <p className="mt-2 text-sm text-[#a6c0e3]">Enter your 24-character license key to activate this device session.</p>

      <label className="mt-5 block text-xs font-semibold uppercase tracking-[0.14em] text-[#9cc0eb]" htmlFor="license-key">
        License key
      </label>
      <div className="relative mt-2">
        <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#89afd8]" />
        <input
          id="license-key"
          type="text"
          inputMode="text"
          autoComplete="off"
          maxLength={24}
          value={keyString}
          onChange={(event) => setKeyString(event.target.value)}
          placeholder="e.g. Ab3$9X..."
          className="modal-input pl-10 font-mono tracking-[0.08em]"
        />
      </div>

      {error ? (
        <p className="mt-3 rounded-lg border border-[#d2687a]/45 bg-[#d2687a]/15 px-3 py-2 text-sm text-[#ffd5de]">{error}</p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className="luxury-btn mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
        {submitting ? "Verifying Key..." : "Unlock Dashboard"}
      </button>
    </form>
  );
}
