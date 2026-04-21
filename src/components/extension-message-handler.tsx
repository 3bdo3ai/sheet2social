"use client";

import { useEffect } from "react";

/**
 * Handles extension messages to prevent "listener indicated an asynchronous response"
 * errors when browser extensions try to communicate with the page.
 */
export function ExtensionMessageHandler() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const chromeRuntime = (window as unknown as Record<string, unknown>).chrome as any;
      if (chromeRuntime?.runtime?.onMessage) {
        chromeRuntime.runtime.onMessage.addListener(() => {
          // Don't return true (which indicates async response).
          // Return false or undefined to indicate we're not handling this message.
          // This prevents the "message channel closed before response" error.
          return false;
        });
      }
    } catch {
      // chrome.runtime not available in this context
    }
  }, []);

  return null;
}
