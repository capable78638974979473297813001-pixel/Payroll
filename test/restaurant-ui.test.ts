import { test } from 'node:test';
import assert from 'node:assert/strict';

const client = await import(new URL('../web/js/app/payroll.js', import.meta.url).href);

test('payroll CSV preserves quoted names, separate tip columns and spreadsheet safety', () => {
  const rows = [['Employee', 'Regular hrs', 'Overtime hrs', 'Paycheck tips', 'Cash tips'], ['Lee, "Alex"', '40', '2', '125.50', '32.75']];
  const csv = rows.map(row => row.map(client.csvCell).join(',')).join('\r\n');
  assert.deepEqual(client.parseCsv(csv), rows);
  assert.equal(client.csvCell('=1+1'), '"\'=1+1"');
  assert.equal(client.csvCell('normal'), '"normal"');
  assert.throws(() => client.parseCsv('Employee,Hours\n"bad quote,40'), /unclosed quote/);
});

test('payroll input converts hours to integer minutes and tip dollars to cents', () => {
  assert.equal(client.hoursToMinutes('32:30'), 1950);
  assert.equal(client.hoursToMinutes('32.5'), 1950);
  assert.equal(client.hoursToMinutes('32:90'), null);
  assert.equal(client.hoursToMinutes('-1'), null);
  assert.equal(client.dollarsToCents('$1,234.56'), 123456);
  assert.equal(client.dollarsToCents('10.999'), null);
  assert.equal(client.dollarsToCents('-1.00'), null);
});
