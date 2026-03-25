import type { EntityName } from "@/lib/db/entities";

export type ParquetPrimitiveType = "UTF8" | "BOOLEAN" | "INT64" | "INT32";

export interface ParquetField {
  type: ParquetPrimitiveType;
  optional?: boolean;
}

export type ParquetSchemaDefinition = Record<string, ParquetField>;

export const entitySchemas: Record<EntityName, ParquetSchemaDefinition> = {
  fbAccounts: {
    id: { type: "UTF8" },
    name: { type: "UTF8" },
    alias: { type: "UTF8", optional: true },
    username: { type: "UTF8" },
    password: { type: "UTF8" },
    socks5ProxyHost: { type: "UTF8", optional: true },
    socks5ProxyPort: { type: "INT32", optional: true },
    postFilter: { type: "UTF8", optional: true },
    postingMethod: { type: "UTF8", optional: true },
    isActive: { type: "BOOLEAN" },
    createdAt: { type: "UTF8" },
    updatedAt: { type: "UTF8" },
  },
  fbGroups: {
    id: { type: "UTF8" },
    groupId: { type: "UTF8" },
    name: { type: "UTF8", optional: true },
    csvPath: { type: "UTF8" },
    fbAccountId: { type: "UTF8", optional: true },
    isActive: { type: "BOOLEAN" },
    createdAt: { type: "UTF8" },
    updatedAt: { type: "UTF8" },
  },
  proxies: {
    id: { type: "UTF8" },
    ipAddress: { type: "UTF8" },
    port: { type: "INT32" },
    username: { type: "UTF8", optional: true },
    password: { type: "UTF8", optional: true },
    enabled: { type: "BOOLEAN" },
    createdAt: { type: "UTF8" },
    updatedAt: { type: "UTF8" },
  },
  logs: {
    id: { type: "UTF8" },
    level: { type: "UTF8" },
    message: { type: "UTF8" },
    accountId: { type: "UTF8", optional: true },
    groupId: { type: "UTF8", optional: true },
    sheetRow: { type: "INT32", optional: true },
    details: { type: "UTF8", optional: true },
    createdAt: { type: "UTF8" },
  },
};
