import type { EntityName } from "@/lib/db/entities";
import { createParquetFile } from "@/lib/db/parquet";

const CORE_ENTITIES: EntityName[] = ["fbAccounts", "fbGroups", "proxies", "logs"];

export async function initializeDbStorage(): Promise<void> {
  for (const entity of CORE_ENTITIES) {
    await createParquetFile(entity, []);
  }
}
