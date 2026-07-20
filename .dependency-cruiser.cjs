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
      from: { path: '^engine/' },
      to: { path: '^(server|web|engine2|workbench)/|node_modules' },
    },
    {
      name: 'engine2-stays-pure',
      comment: '@fm/engine2 is the GROUND-UP V2 core (ENGINE-V2-BEHAVIORAL-SPEC §2): zero runtime deps, and no imports from v1 engine/server/web — concepts port, code does not',
      severity: 'error',
      from: { path: '^engine2/' },
      to: { path: '^(server|web|workbench)/|^engine/|node_modules' },
    },
    {
      name: 'workbench-reads-engine2-only',
      comment: 'the workbench is the V2 instrument (spec §4): it renders @fm/engine2 and nothing else in the repo',
      severity: 'error',
      from: { path: '^workbench/' },
      to: { path: '^(server|web)/|^engine/' },
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
