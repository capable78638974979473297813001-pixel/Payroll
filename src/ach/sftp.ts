import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { badRequest } from '../lib/errors.ts';

/**
 * Deliver a payment file to a bank's SFTP server, with the system `sftp`
 * client (OpenSSH). Delivery is NOT approval: the file waits at the bank until
 * the employer releases it there. This only saves them the upload.
 *
 * The connection is as strict as OpenSSH allows:
 *  - the server must present the host key the employer gave us (pinned in a
 *    one-line known_hosts); an unknown or changed key is refused
 *  - key authentication only: no password, no agent, no other identity
 *  - the private key is written to a 0600 file in a 0700 temporary directory
 *    for the length of the transfer and removed afterwards, success or failure
 *  - every value that reaches the command line or the batch script has been
 *    checked against a strict pattern, so no host, user, path or file name can
 *    smuggle an option or a command in
 *
 * Not supported: PGP encryption of the file (some banks require it), password
 * login, and servers that ask for a specific post-upload rename.
 * Not tested against a real server in this repository's test suite.
 */

export interface SftpTarget {
  host: string;
  port: number;
  username: string;
  remoteDir: string;
  /** One known_hosts line: `host keytype base64key`. */
  knownHostsLine: string;
  /** OpenSSH or PEM private key text. */
  privateKey: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts: { input: string; timeoutMs: number }) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, stdout, stderr: `${stderr}\ntimed out after ${opts.timeoutMs / 1000}s` });
    }, opts.timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${e.message}. OpenSSH's sftp client must be installed on the server.` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(opts.input);
  });

const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REMOTE_DIR = /^[A-Za-z0-9_./-]{0,200}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const KNOWN_HOSTS = /^\S+ (ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;

/** Throws a 400 for anything unsafe or malformed. Also used when the employer saves their SFTP settings. */
export function validateSftp(t: Omit<SftpTarget, 'privateKey'> & { privateKey?: string }): void {
  if (!HOST.test(t.host)) throw badRequest('sftp.host must be a hostname or IP address');
  if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw badRequest('sftp.port must be 1 to 65535');
  if (!USER.test(t.username)) throw badRequest('sftp.username has characters that are not allowed');
  if (!REMOTE_DIR.test(t.remoteDir) || t.remoteDir.includes('..')) throw badRequest('sftp.remoteDir may contain only letters, digits and _ . / - and no ..');
  if (!KNOWN_HOSTS.test(t.knownHostsLine.trim())) throw badRequest("sftp.knownHostsLine must be one line from the bank's known_hosts: `host ssh-ed25519 AAAA...` (ed25519, ECDSA or RSA)");
  if (t.privateKey !== undefined && !/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/.test(t.privateKey)) throw badRequest('sftp.privateKey must be a private key in OpenSSH or PEM text form');
}

export function validateFileName(name: string): void {
  if (!FILE_NAME.test(name)) throw badRequest(`'${name}' is not a safe file name (letters, digits, . _ - only)`);
}

/** Fill a file-name template. Unknown tokens are refused when the template is saved. */
export const TEMPLATE_TOKENS = ['date', 'time', 'seq', 'routing', 'companyId'] as const;

export function validateTemplate(template: string): void {
  const tokens = [...template.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1]);
  for (const t of tokens) if (!(TEMPLATE_TOKENS as readonly string[]).includes(t)) throw badRequest(`fileNameTemplate uses an unknown token {${t}}. Allowed: ${TEMPLATE_TOKENS.map((x) => `{${x}}`).join(' ')}`);
  validateFileName(fillTemplate(template, { date: '20260101', time: '1200', seq: '1', routing: '021000021', companyId: '1123456789' }));
}

export function fillTemplate(template: string, v: Record<(typeof TEMPLATE_TOKENS)[number], string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (_, k: string) => (v as Record<string, string>)[k] ?? '');
}

export class SftpDelivery {
  private readonly run: Runner;
  private readonly binary: string;
  private readonly timeoutMs: number;
  constructor(opts: { runner?: Runner; binary?: string; timeoutMs?: number } = {}) {
    this.run = opts.runner ?? spawnRunner;
    this.binary = opts.binary ?? 'sftp';
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async deliver(target: SftpTarget, fileName: string, content: string): Promise<{ remotePath: string }> {
    validateSftp(target);
    validateFileName(fileName);
    const dir = mkdtempSync(join(tmpdir(), 'totali-sftp-'));
    try {
      chmodSync(dir, 0o700);
      const keyPath = join(dir, 'id');
      const hostsPath = join(dir, 'known_hosts');
      const filePath = join(dir, fileName);
      writeFileSync(keyPath, target.privateKey.endsWith('\n') ? target.privateKey : `${target.privateKey}\n`, { mode: 0o600 });
      writeFileSync(hostsPath, `${target.knownHostsLine.trim()}\n`, { mode: 0o600 });
      writeFileSync(filePath, content, { mode: 0o600 });
      const args = [
        '-b', '-',
        '-i', keyPath,
        '-P', String(target.port),
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'PasswordAuthentication=no',
        '-o', 'KbdInteractiveAuthentication=no',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${hostsPath}`,
        '-o', 'GlobalKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=20',
        `${target.username}@${target.host}`,
      ];
      const batch = `${target.remoteDir ? `cd ${target.remoteDir}\n` : ''}put ${filePath} ${fileName}\nbye\n`;
      const r = await this.run(this.binary, args, { input: batch, timeoutMs: this.timeoutMs });
      if (r.code !== 0) throw new Error(`sftp exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      return { remotePath: `${target.remoteDir ? `${target.remoteDir.replace(/\/$/, '')}/` : ''}${fileName}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
