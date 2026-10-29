import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where an ACH file goes once Totali has built it. An originator has to hand
 * its files to a bank (the ODFI), because the Federal Reserve ACH network is
 * only open to banks. How the file reaches the bank depends on the bank:
 * a secure file drop, an SFTP server, or an API. Totali does not guess:
 * implement `AchSubmitter` for the bank you sign with. Until then the
 * outbox submitter writes files to a directory and says plainly that they
 * are queued, not sent.
 *
 * `accepted` means the bank has acknowledged receiving the file. Nothing in
 * Totali treats a file as sent on any weaker evidence.
 */

export interface SubmitInput {
  fileId: string;
  fileName: string;
  content: string;
  kind: 'debit' | 'credit' | 'prenote';
  effectiveDate: string;
  entryCount: number;
  totalCents: number;
}

export interface SubmitResult {
  status: 'queued' | 'accepted' | 'rejected';
  reference?: string;
  message: string;
}

export interface AchSubmitter {
  readonly name: string;
  submit(f: SubmitInput): Promise<SubmitResult>;
}

/**
 * Writes each file to a directory for pickup by whatever carries files to the
 * bank (an SFTP sync, a person uploading to the bank's portal). Files are
 * written 0600 into a 0700 directory, because they contain full account
 * numbers; remove them once the bank has them. Re-submitting a file that is
 * already there changes nothing.
 */
export class OutboxSubmitter implements AchSubmitter {
  readonly name = 'outbox';
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async submit(f: SubmitInput): Promise<SubmitResult> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = join(this.dir, f.fileName);
    if (!existsSync(target)) {
      const tmp = `${target}.partial`;
      writeFileSync(tmp, f.content, { mode: 0o600 });
      renameSync(tmp, target);
    }
    return { status: 'queued', message: `Written to ${target}. It has NOT been sent to a bank. Once the bank acknowledges it, record that with POST /v1/ops/ach/files/${f.fileId}/accepted.` };
  }
}
