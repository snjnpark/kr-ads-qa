export function csvText(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = (value: unknown) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (/^[\s\uFEFF]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `\uFEFF${[columns.map(cell).join(","), ...rows.map(row => columns.map(column => cell(Object.hasOwn(row, column) ? row[column] : "")).join(","))].join("\r\n")}`;
}
