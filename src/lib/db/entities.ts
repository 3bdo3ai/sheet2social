export interface FbAccount {
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
  postFilter?: "all" | "with-comments" | "without-comments";
  postingMethod?:
    | "post-all-sequential"
    | "one-post-per-account"
    | "random"
    | "random-no-repeat"
    | "progressive";
  isActive: boolean;
  disabledAt?: string;
  disabledUntil?: string;
  disabledReason?: string;
  disabledType?: "manual" | "automatic";
  createdAt: string;
  updatedAt: string;
}

export interface FbGroup {
  id: string;
  groupId: string;
  name?: string;
  csvPath: string;
  fbAccountId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyRecord {
  id: string;
  ipAddress: string;
  port: number;
  username?: string;
  password?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationLog {
  id: string;
  level: "info" | "success" | "error";
  message: string;
  accountId?: string;
  groupId?: string;
  sheetRow?: number;
  details?: string;
  createdAt: string;
}

export interface EntityMap {
  fbAccounts: FbAccount;
  fbGroups: FbGroup;
  proxies: ProxyRecord;
  logs: AutomationLog;
}

export type EntityName = keyof EntityMap;
