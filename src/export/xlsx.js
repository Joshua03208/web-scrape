import ExcelJS from 'exceljs';

function sanitizeCell(value) {
  if (value == null) return value;
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

export async function rowsToXlsxBuffer(rows, columns) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prices');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 24 }));
  for (const row of rows) {
    const sanitized = {};
    for (const col of columns) {
      sanitized[col.key] = sanitizeCell(row[col.key]);
    }
    ws.addRow(sanitized);
  }
  return wb.xlsx.writeBuffer();
}
