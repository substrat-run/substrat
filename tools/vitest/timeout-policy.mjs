// Shared defaults for workspace suites. A test that needs longer keeps an explicit timeout
// beside the reason it needs it.
export const nodeTestTimeout = {
  testTimeout: 10_000,
};

export const workerdTestTimeout = {
  testTimeout: 30_000,
};
