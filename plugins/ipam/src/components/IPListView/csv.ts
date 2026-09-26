/** RFC 4180 CSV: quote fields containing commas, quotes or line breaks */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map(r => r.map(v => cell(v ?? '')).join(',')).join('\r\n');
}

/** Save text as a file in the browser */
export function downloadText(
  filename: string,
  text: string,
  type = 'text/csv',
) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
