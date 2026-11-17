// D1 is NOT used for money. D1 has no interactive transactions (see do.js for the design that is used).
// This stub exists only so nobody wires D1 up by accident.
export function d1Adapter() {
  return {
    async tx() {
      throw new Error('Do not run the money code on plain D1: it has no interactive transactions. Use the Durable Object adapter (do.js).');
    },
  };
}
