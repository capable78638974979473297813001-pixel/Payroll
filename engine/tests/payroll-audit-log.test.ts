import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { auditLogEntry } from '../payroll/auditLog.ts';

describe('audit log entries (payroll/auditLog.ts)', () => {
  test('captures actor, action, entity and a timestamp, with a unique id per entry', () => {
    const entry = auditLogEntry('admin', 'pay_run.approved', 'PayRun', 'run-1', { employeeCount: 2 });
    assert.equal(entry.actor, 'admin');
    assert.equal(entry.action, 'pay_run.approved');
    assert.equal(entry.entityType, 'PayRun');
    assert.equal(entry.entityId, 'run-1');
    assert.deepEqual(entry.details, { employeeCount: 2 });
    assert.ok(entry.timestamp);
    assert.ok(entry.id);
  });

  test('two entries never share an id, even created back to back', () => {
    const a = auditLogEntry('admin', 'x', 'Y', 'z');
    const b = auditLogEntry('admin', 'x', 'Y', 'z');
    assert.notEqual(a.id, b.id);
  });

  test('details are optional', () => {
    const entry = auditLogEntry('admin', 'employee.terminated', 'Employee', 'e1');
    assert.equal(entry.details, undefined);
  });
});
