import { decryptField, encryptField, needsRotation } from '../lib/crypto.ts';
import type { Store } from '../store/store.ts';

/**
 * Re-encrypt everything under the current data key: SSNs, bank account
 * numbers, stored ACH file contents, and CashPro notification bodies.
 * Idempotent, all-or-nothing, and it touches only values not already under
 * the current key. The old key must stay in TOTALI_DATA_KEY_PREVIOUS until
 * this has run.
 */
export function rotateDataKey(store: Store): { employees: number; bankAccounts: number; achFiles: number; bofaNotifications: number } {
  return store.tx(() => {
    let employees = 0;
    let bankAccounts = 0;
    let achFiles = 0;
    let bofaNotifications = 0;
    for (const e of store.employees.all()) {
      if (e.ssnEncrypted && needsRotation(e.ssnEncrypted)) {
        store.employees.put({ ...e, ssnEncrypted: encryptField(decryptField(e.ssnEncrypted)) });
        employees += 1;
      }
    }
    for (const a of store.bankAccounts.all()) {
      if (needsRotation(a.accountNumberEncrypted)) {
        store.bankAccounts.put({ ...a, accountNumberEncrypted: encryptField(decryptField(a.accountNumberEncrypted)) });
        bankAccounts += 1;
      }
    }
    for (const f of store.achFiles.all()) {
      if (needsRotation(f.contentEncrypted)) {
        store.achFiles.put({ ...f, contentEncrypted: encryptField(decryptField(f.contentEncrypted)) });
        achFiles += 1;
      }
    }
    for (const n of store.bofaNotifications.all()) {
      if (needsRotation(n.payloadEncrypted)) {
        store.bofaNotifications.put({ ...n, payloadEncrypted: encryptField(decryptField(n.payloadEncrypted)) });
        bofaNotifications += 1;
      }
    }
    return { employees, bankAccounts, achFiles, bofaNotifications };
  });
}
