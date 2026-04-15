"use client";

const DEVICE_STORAGE_KEY = "s2s_device_fingerprint";

function createBrowserFingerprint(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";
  const platform = typeof navigator !== "undefined" ? navigator.platform : "unknown";

  return `${random}:${platform}:${userAgent.slice(0, 48)}`;
}

export function getOrCreateDeviceFingerprint(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const existing = window.localStorage.getItem(DEVICE_STORAGE_KEY);

  if (existing && existing.length >= 16) {
    return existing;
  }

  const next = createBrowserFingerprint();
  window.localStorage.setItem(DEVICE_STORAGE_KEY, next);

  return next;
}
