/**
 * RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF/LF, embedded
 * newlines. Returns header-keyed records; a row whose field count differs
 * from the header is reported, not silently padded. Input size is bounded by
 * the caller (the import route's body limit); rows and columns are capped here.
 */
export interface CsvParseResult {
  header: string[];
  rows: Record<string, string>[];
  errors: { line: number; message: string }[];
}

export function parseCsv(text: string, maxRows = 2_000_000, maxColumns = 512): CsvParseResult {
  const records: string[][] = [];
  const lineOf: number[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
      if (record.length >= maxColumns) throw new Error(`CSV exceeds ${maxColumns} columns`);
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      if (!(record.length === 1 && record[0] === '')) {
        records.push(record);
        lineOf.push(recordLine);
      }
      record = [];
      line++;
      recordLine = line;
      if (records.length > maxRows) throw new Error(`CSV exceeds ${maxRows} rows`);
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) {
    record.push(field);
    records.push(record);
    lineOf.push(recordLine);
  }

  const errors: CsvParseResult['errors'] = [];
  if (inQuotes) errors.push({ line, message: 'unterminated quoted field' });
  const [header = [], ...body] = records;
  const rows: Record<string, string>[] = [];
  body.forEach((r, k) => {
    if (r.length !== header.length) {
      errors.push({ line: lineOf[k + 1], message: `expected ${header.length} fields, got ${r.length}` });
      return;
    }
    // No prototype: a header named __proto__ or constructor is just a column.
    const obj: Record<string, string> = Object.create(null);
    header.forEach((h, idx) => {
      obj[h.trim()] = r[idx];
    });
    rows.push(obj);
  });
  return { header: header.map(h => h.trim()), rows, errors };
}

/** Quotes a value for CSV output (formula-injection safe for spreadsheet tools). */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return `${[header.map(csvCell).join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n')}\n`;
}
