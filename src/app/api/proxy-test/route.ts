import { Socket } from "node:net";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ProxyInput = {
  host: string;
  port: number;
  username?: string;
  password?: string;
};

type AttemptResult = {
  protocol: "socks5" | "http";
  ok: boolean;
  latencyMs: number;
  message: string;
  publicIp?: string;
};

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 30_000;
const IPIFY_HOST = "api.ipify.org";

function parseProxyValue(value: string): ProxyInput | null {
  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const withoutScheme = raw.replace(/^(socks5h?|https?):\/\//i, "");
  const parts = withoutScheme.split(":").map((part) => part.trim());

  if (parts.length < 2) {
    return null;
  }

  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  const username = parts[2] || undefined;
  const password = parts[3] || undefined;

  return {
    host,
    port,
    username,
    password,
  };
}

function readLine(buffer: string): string {
  const idx = buffer.indexOf("\r\n");
  return idx >= 0 ? buffer.slice(0, idx) : buffer;
}

function connectSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const onError = (err: Error) => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs, () => {
      socket.destroy(new Error("Connection timed out"));
    });

    socket.once("error", onError);
    socket.connect(port, host, () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

function waitForData(socket: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while waiting for proxy response"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    function cleanup() {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function testSocks5Proxy(proxy: ProxyInput, timeoutMs: number): Promise<AttemptResult> {
  const startedAt = Date.now();
  let socket: Socket | undefined;

  try {
    socket = await connectSocket(proxy.host, proxy.port, timeoutMs);

    const methods = proxy.username || proxy.password ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await waitForData(socket, timeoutMs);
    if (greeting.length < 2 || greeting[0] !== 0x05) {
      throw new Error("Invalid SOCKS5 greeting response");
    }

    if (greeting[1] === 0xff) {
      throw new Error("SOCKS5 proxy rejected all authentication methods");
    }

    if (greeting[1] === 0x02) {
      const username = Buffer.from(proxy.username ?? "");
      const password = Buffer.from(proxy.password ?? "");

      if (username.length > 255 || password.length > 255) {
        throw new Error("Proxy username/password is too long for SOCKS5 auth");
      }

      socket.write(
        Buffer.concat([
          Buffer.from([0x01, username.length]),
          username,
          Buffer.from([password.length]),
          password,
        ])
      );

      const auth = await waitForData(socket, timeoutMs);
      if (auth.length < 2 || auth[1] !== 0x00) {
        throw new Error("SOCKS5 username/password authentication failed");
      }
    }

    const hostBuffer = Buffer.from(IPIFY_HOST);
    socket.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]),
        hostBuffer,
        Buffer.from([0x00, 0x50]),
      ])
    );

    const connectReply = await waitForData(socket, timeoutMs);
    if (connectReply.length < 2 || connectReply[1] !== 0x00) {
      const code = connectReply.length >= 2 ? connectReply[1] : -1;
      throw new Error(`SOCKS5 connect failed with reply code ${code}`);
    }

    const request = [
      "GET /?format=json HTTP/1.1",
      `Host: ${IPIFY_HOST}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n");

    socket.write(request);

    const httpBuffer = await waitForData(socket, timeoutMs);
    const responseText = httpBuffer.toString("utf8");
    const statusLine = readLine(responseText);
    const match = /\{\s*"ip"\s*:\s*"([^"]+)"\s*\}/.exec(responseText);

    return {
      protocol: "socks5",
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: statusLine || "SOCKS5 tunnel established",
      publicIp: match?.[1],
    };
  } catch (error) {
    return {
      protocol: "socks5",
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "SOCKS5 test failed",
    };
  } finally {
    socket?.destroy();
  }
}

async function testHttpProxy(proxy: ProxyInput, timeoutMs: number): Promise<AttemptResult> {
  const startedAt = Date.now();
  let socket: Socket | undefined;

  try {
    socket = await connectSocket(proxy.host, proxy.port, timeoutMs);

    const authHeader =
      proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username ?? ""}:${proxy.password ?? ""}`).toString("base64")}`
        : undefined;

    const requestLines = [
      "GET http://api.ipify.org?format=json HTTP/1.1",
      "Host: api.ipify.org",
      "User-Agent: Sheet2Social Proxy Tester",
      "Accept: application/json",
      "Connection: close",
    ];

    if (authHeader) {
      requestLines.push(authHeader);
    }

    socket.write(`${requestLines.join("\r\n")}\r\n\r\n`);

    const responseBuffer = await waitForData(socket, timeoutMs);
    const responseText = responseBuffer.toString("utf8");
    const statusLine = readLine(responseText);

    if (!/HTTP\/1\.[01] 200/i.test(statusLine)) {
      throw new Error(statusLine || "HTTP proxy returned non-200 response");
    }

    const match = /\{\s*"ip"\s*:\s*"([^"]+)"\s*\}/.exec(responseText);

    return {
      protocol: "http",
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: statusLine,
      publicIp: match?.[1],
    };
  } catch (error) {
    return {
      protocol: "http",
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "HTTP proxy test failed",
    };
  } finally {
    socket?.destroy();
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    value?: string;
    timeoutMs?: number;
  };

  const proxy = parseProxyValue(body.value ?? "");
  if (!proxy) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid proxy format. Use host:port or host:port:username:password",
      },
      { status: 400 }
    );
  }

  const timeoutMs = Math.max(2_000, Math.min(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

  const socksAttempt = await testSocks5Proxy(proxy, timeoutMs);
  const httpAttempt = socksAttempt.ok ? undefined : await testHttpProxy(proxy, timeoutMs);

  const attempts = httpAttempt ? [socksAttempt, httpAttempt] : [socksAttempt];
  const successAttempt = attempts.find((attempt) => attempt.ok);

  return NextResponse.json({
    success: Boolean(successAttempt),
    proxy: {
      host: proxy.host,
      port: proxy.port,
      hasAuth: Boolean(proxy.username || proxy.password),
    },
    bestProtocol: successAttempt?.protocol,
    publicIp: successAttempt?.publicIp,
    attempts,
    checkedAt: new Date().toISOString(),
  });
}