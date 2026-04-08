"use client";

import { FormEvent, useMemo, useState } from "react";

type Attempt = {
  protocol: "socks5" | "http";
  ok: boolean;
  latencyMs: number;
  message: string;
  publicIp?: string;
};

type TestResponse = {
  success: boolean;
  error?: string;
  bestProtocol?: "socks5" | "http";
  publicIp?: string;
  attempts?: Attempt[];
  checkedAt?: string;
};

const SAMPLE_VALUE = "31.59.20.176:6754:piddhvst:kb9xlcvrwmet";

function parsePreview(value: string) {
  const cleaned = value.trim().replace(/^(socks5h?|https?):\/\//i, "");
  const parts = cleaned.split(":");
  return {
    host: parts[0] ?? "",
    port: parts[1] ?? "",
    username: parts[2] ?? "",
    password: parts[3] ?? "",
  };
}

export default function ProxyTestPage() {
  const [value, setValue] = useState(SAMPLE_VALUE);
  const [timeoutMs, setTimeoutMs] = useState(12000);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TestResponse | null>(null);

  const preview = useMemo(() => parsePreview(value), [value]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/proxy-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value, timeoutMs }),
      });

      const data = (await response.json()) as TestResponse;
      setResult(data);
    } catch (error) {
      setResult({
        success: false,
        error: error instanceof Error ? error.message : "Network error while testing proxy",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_20%_20%,#183158_0%,#081326_45%,#040811_100%)] px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <section className="rounded-3xl border border-[#2f4f7f] bg-[#0b1a31cc] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
          <p className="text-xs uppercase tracking-[0.2em] text-[#7eb6ff]">Standalone Utility</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-[#ecf4ff]">Proxy Connectivity Tester</h1>
          <p className="mt-2 max-w-2xl text-sm text-[#abc4e7]">
            Test one proxy value in format <span className="font-semibold text-[#dceaff]">host:port:username:password</span> and get
            protocol-specific feedback.
          </p>

          <form onSubmit={handleSubmit} className="mt-6 grid gap-4">
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-[#d7e8ff]">Proxy Value</span>
              <input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="31.59.20.176:6754:user:pass"
                className="w-full rounded-xl border border-[#365b8f] bg-[#071326] px-4 py-3 text-[#ebf5ff] outline-none transition focus:border-[#5da2ff]"
              />
            </label>

            <label className="grid gap-2 sm:max-w-xs">
              <span className="text-sm font-semibold text-[#d7e8ff]">Timeout (ms)</span>
              <input
                type="number"
                min={2000}
                max={30000}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value) || 12000)}
                className="rounded-xl border border-[#365b8f] bg-[#071326] px-4 py-3 text-[#ebf5ff] outline-none transition focus:border-[#5da2ff]"
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={loading}
                className="rounded-xl bg-gradient-to-r from-[#1f76ff] to-[#29a4ff] px-6 py-3 font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? "Testing..." : "Run Test"}
              </button>
              <button
                type="button"
                onClick={() => setValue(SAMPLE_VALUE)}
                className="rounded-xl border border-[#446ca4] px-4 py-3 text-sm text-[#d1e4ff] transition hover:bg-[#10213f]"
              >
                Use Sample Value
              </button>
            </div>
          </form>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-2xl border border-[#26456f] bg-[#09162bcc] p-5">
            <p className="text-sm font-semibold text-[#cfe2ff]">Parsed Preview</p>
            <div className="mt-3 space-y-2 text-sm text-[#a9c4ea]">
              <p>Host: {preview.host || "-"}</p>
              <p>Port: {preview.port || "-"}</p>
              <p>User: {preview.username || "-"}</p>
              <p>Password: {preview.password ? "********" : "-"}</p>
            </div>
          </div>

          <div className="rounded-2xl border border-[#26456f] bg-[#09162bcc] p-5">
            <p className="text-sm font-semibold text-[#cfe2ff]">Result</p>
            {!result ? (
              <p className="mt-3 text-sm text-[#98b6df]">Run a test to see connectivity details.</p>
            ) : result.success ? (
              <div className="mt-3 space-y-2 text-sm text-[#bfe6cf]">
                <p>Status: Connected</p>
                <p>Best Protocol: {result.bestProtocol}</p>
                <p>Public IP: {result.publicIp ?? "Not detected"}</p>
                <p>Checked At: {result.checkedAt ? new Date(result.checkedAt).toLocaleString() : "-"}</p>
              </div>
            ) : (
              <div className="mt-3 space-y-2 text-sm text-[#ffc5c5]">
                <p>Status: Failed</p>
                <p>{result.error ?? "No successful protocol detected."}</p>
              </div>
            )}
          </div>
        </section>

        {result?.attempts?.length ? (
          <section className="overflow-hidden rounded-2xl border border-[#26456f] bg-[#09162bcc]">
            <table className="w-full text-left text-sm text-[#dbeaff]">
              <thead className="bg-[#0f223f] text-xs uppercase tracking-wide text-[#90b6e8]">
                <tr>
                  <th className="px-4 py-3">Protocol</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Latency</th>
                  <th className="px-4 py-3">Message</th>
                </tr>
              </thead>
              <tbody>
                {result.attempts.map((attempt) => (
                  <tr key={`${attempt.protocol}-${attempt.latencyMs}`} className="border-t border-[#1f3a61]">
                    <td className="px-4 py-3 font-semibold">{attempt.protocol.toUpperCase()}</td>
                    <td className={`px-4 py-3 ${attempt.ok ? "text-[#8df2b5]" : "text-[#ff9c9c]"}`}>
                      {attempt.ok ? "OK" : "Failed"}
                    </td>
                    <td className="px-4 py-3">{attempt.latencyMs} ms</td>
                    <td className="px-4 py-3 text-[#b4cae8]">{attempt.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </main>
  );
}