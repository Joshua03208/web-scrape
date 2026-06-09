import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { rowsToCsv } from '../src/export/csv.js';
import { rowsToXlsxBuffer } from '../src/export/xlsx.js';

const columns = [
  { key: 'part_number', header: 'Part Number' },
  { key: 'name', header: 'Name' },
  { key: 'price', header: 'Price' },
];
const rows = [
  { part_number: '133.0440.351', name: 'Valve, "COLD" 20mm', price: 20.81 },
  { part_number: '133.0049.669', name: null, price: 17.63 },
];

describe('rowsToCsv', () => {
  it('emits header row and escapes quotes/commas', () => {
    const csv = rowsToCsv(rows, columns);
    expect(csv.split('\r\n')[0]).toBe('Part Number,Name,Price');
    expect(csv).toContain('"Valve, ""COLD"" 20mm"');
    expect(csv.split('\r\n')[2]).toBe('133.0049.669,,17.63');
  });
  it('neutralises formula-injection in cells', () => {
    const csv = rowsToCsv([{ part_number: '=SUM(A1:A9)', name: '@cmd', price: 1 }], columns);
    expect(csv).toContain("'=SUM(A1:A9)");
    expect(csv).toContain("'@cmd");
  });
});

describe('rowsToXlsxBuffer', () => {
  it('produces a workbook with header and data rows', async () => {
    const buf = await rowsToXlsxBuffer(rows, columns);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Part Number');
    expect(ws.getCell('A2').value).toBe('133.0440.351');
    expect(ws.getCell('C3').value).toBe(17.63);
  });
  // Fix 8: formula-injection guard
  it('neutralises formula-injection in xlsx cells', async () => {
    const buf = await rowsToXlsxBuffer([{ part_number: '=SUM(A1:A9)', name: 'ok', price: 1 }], columns);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    expect(wb.worksheets[0].getCell('A2').value).toBe("'=SUM(A1:A9)");
  });
});
