import { crc32 } from "node:zlib";

/** Small pure helpers for the archive: CSV text and an uncompressed ZIP container. No dependencies. */

/** Quote a CSV cell. JSON values are written as JSON text; cells that a spreadsheet could run as a formula get a leading apostrophe. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?![\d.]+$)/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const y = Math.max(d.getUTCFullYear(), 1980);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** A ZIP archive with stored (uncompressed) entries and UTF-8 names. */
export function buildZip(files: readonly ArchiveFile[], stamp: Date): Uint8Array {
  const { time, date } = dosDateTime(stamp);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.path, "utf8");
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

/** Read the entries of a ZIP built by `buildZip` (stored only). Used by tests and by archive verification. */
export function readZip(zip: Uint8Array): ArchiveFile[] {
  const b = Buffer.from(zip);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip archive");
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: ArchiveFile[] = [];
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("corrupt zip directory");
    if (b.readUInt16LE(p + 10) !== 0) throw new Error("unsupported zip method");
    const crc = b.readUInt32LE(p + 16);
    const size = b.readUInt32LE(p + 20);
    const nameLen = b.readUInt16LE(p + 28);
    const extraLen = b.readUInt16LE(p + 30);
    const commentLen = b.readUInt16LE(p + 32);
    const localAt = b.readUInt32LE(p + 42);
    const path = b.toString("utf8", p + 46, p + 46 + nameLen);
    const dataAt = localAt + 30 + b.readUInt16LE(localAt + 26) + b.readUInt16LE(localAt + 28);
    const data = b.subarray(dataAt, dataAt + size);
    if (crc32(data) !== crc) throw new Error(`corrupt zip entry: ${path}`);
    out.push({ path, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
