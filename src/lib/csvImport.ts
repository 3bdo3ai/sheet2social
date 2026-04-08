import "server-only";

export interface ParsedCsv {
  headers: string[];
  rows: Array<Record<string, string>>;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function parseCsvMatrix(content: string): string[][] {
  const rows: string[][] = [];
  let currentLine = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];

    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        currentLine += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        currentLine += char;
      }
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && content[i + 1] === "\n") {
        i += 1;
      }
      if (currentLine.length > 0) {
        rows.push(parseCsvLine(currentLine));
      }
      currentLine = "";
      continue;
    }

    currentLine += char;
  }

  if (currentLine.length > 0) {
    rows.push(parseCsvLine(currentLine));
  }

  return rows;
}

export function normalizeCsvHeader(header: string): string {
  return header.replace(/^\uFEFF/, "").trim().toLowerCase();
}

export function parseCsv(content: string): ParsedCsv {
  const matrix = parseCsvMatrix(content);
  if (matrix.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = matrix[0].map((header) => normalizeCsvHeader(String(header ?? "")));
  const rows = matrix.slice(1)
    .filter((cells) => cells.some((cell) => String(cell ?? "").trim().length > 0))
    .map((cells) => {
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = String(cells[index] ?? "").trim();
      });
      return row;
    });

  return { headers, rows };
}

export function validateCsvHeaders(headers: string[], expectedHeaders: string[]): string | null {
  const normalizedExpected = expectedHeaders.map((header) => normalizeCsvHeader(header));
  if (headers.length !== normalizedExpected.length) {
    return `Invalid header count. Expected: ${normalizedExpected.join(",")}`;
  }

  for (let index = 0; index < normalizedExpected.length; index += 1) {
    if (headers[index] !== normalizedExpected[index]) {
      return `Invalid CSV schema. Expected: ${normalizedExpected.join(",")}`;
    }
  }

  return null;
}

export function parseBooleanCsvValue(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallback;
}
