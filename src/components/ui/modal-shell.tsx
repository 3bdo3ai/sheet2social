"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type ModalShellProps = {
  children: ReactNode;
  className?: string;
};

export function ModalShell({ children, className = "max-w-xl" }: ModalShellProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div className="app-modal-shell">
      <div className={`app-modal ${className}`}>{children}</div>
    </div>,
    document.body
  );
}