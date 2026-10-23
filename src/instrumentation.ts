// Refuse to boot in production with missing settings (P-009 K1). Names only, never values.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { configProblems, graphVersion } = await import('./lib/config');
  const { bucketConfig } = await import('./lib/bucket');
  if (process.env.INBOX_SOURCE === 'local' && !bucketConfig(process.env)) console.warn('[media] MEDIA_BUCKET_* not set: media tiering disabled, all media stays on local disk');
  graphVersion(process.env); // warns once at startup if META_GRAPH_VERSION is malformed, falls back to v26.0
  if (process.env.NODE_ENV !== 'production') return;
  const problems = configProblems(process.env);
  if (problems.length) {
    console.error(`[config] refusing to start: ${problems.join(', ')}`);
    throw new Error('Invalid configuration');
  }
}
