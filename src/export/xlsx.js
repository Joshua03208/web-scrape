import ExcelJS from 'exceljs';

export async function rowsToXlsxBuffer(rows, columns) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Prices');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 24 }));
  for (const row of rows) ws.addRow(row);
  return wb.xlsx.writeBuffer();
}
