import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Chrome/Chromium binary for the browser-driven tests, or null when none is
 * installed. The tests used to spawn `google-chrome` by name, so on any machine
 * without that exact binary they failed with ENOENT, which reads as a product
 * bug. Order: CHROME_BIN, then the usual names on PATH, then Playwright's own
 * download (PLAYWRIGHT_BROWSERS_PATH, or /opt/pw-browsers).
 */
export function findChrome(): string | null {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0) return name;
  }

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter((r): r is string => Boolean(r) && existsSync(r!));
  for (const root of roots) {
    for (const dir of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
      const bin = join(root, dir, 'chrome-linux64', 'chrome');
      if (existsSync(bin)) return bin;
    }
  }
  return null;
}
