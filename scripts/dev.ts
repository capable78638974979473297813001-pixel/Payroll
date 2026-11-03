/** Isolated development server. Preview tools pass --port; production always runs src/main.ts directly. */
import { randomBytes } from 'node:crypto';
if (process.env.NODE_ENV === 'production') throw new Error('Use npm start for production.');
const portArg = process.argv.indexOf('--port');
if (portArg !== -1) {
  const port = Number(process.argv[portArg + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid preview port.');
  process.env.PORT = String(port);
}
process.env.TOTALI_DEV = '1';
// A temporary key lives only in this process. Never use this server for real payroll data.
process.env.TOTALI_DATA_KEY ??= randomBytes(32).toString('base64');
await import('../src/main.ts');
