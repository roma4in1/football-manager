/**
 * Import-boundary enforcement (DECISIONS.md):
 *  - pnpm's isolated node_modules already blocks UNDECLARED package imports
 *    (engine cannot resolve pg/fastify/@fm/server because it declares no deps);
 *  - dependency-cruiser closes the remaining hole: relative-path escapes
 *    across package directories.
 * Run: pnpm boundaries (part of `pnpm test` and the CI typecheck job).
 */

module.exports = {
  forbidden: [
    {
      name: 'engine-stays-pure',
      comment: '@fm/engine has zero runtime deps and never imports server/web code',
      severity: 'error',
      from: { path: '^engine' },
      to: { path: '^(server|web)|node_modules' },
    },
    {
      name: 'web-never-touches-server',
      comment: 'the client talks to the server over HTTP only',
      severity: 'error',
      from: { path: '^web' },
      to: { path: '^server' },
    },
    {
      name: 'no-orphaned-circulars',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '\\.test\\.(ts|tsx)$|node_modules' },
    tsPreCompilationDeps: true,
  },
};
