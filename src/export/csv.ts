export const esc = (v: string | number | bigint): string => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const row = (cells: (string | number | bigint)[]): string => cells.map(esc).join(',');
export const table = (header: string[], rows: (string | number | bigint)[][]): string =>
  [row(header), ...rows.map(row)].join('\n') + '\n';
