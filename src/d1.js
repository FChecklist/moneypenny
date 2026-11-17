// Cloudflare D1 adapter: SHAPE ONLY in Phase 0.
// D1 has no interactive transactions, and the money logic needs "all or nothing" per request.
// Until the Phase 1 design (one serialised writer per tenant, e.g. a Durable Object running
// these same functions over its own SQLite) is built and audited, tx() refuses to run so
// nothing can be deployed by accident.
export function d1Adapter() {
  return {
    async tx() {
      throw new Error('D1 atomic executor is not built yet (Phase 1). Use the local harness.');
    },
  };
}
