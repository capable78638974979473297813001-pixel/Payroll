/** One deployment-controlled URL for preflight, cookies, OAuth callbacks and email links. Never infer it from request headers. */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // A configured custom domain always wins, including an invalid value that preflight must reject.
  const explicit = (env.PUBLIC_BASE_URL ?? '').trim();
  const render = env.RENDER === 'true' ? (env.RENDER_EXTERNAL_URL ?? '').trim() : '';
  return (explicit || render).replace(/\/+$/, '') || undefined;
}
