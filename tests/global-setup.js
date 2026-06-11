// @ts-check
/**
 * Global setup: Lightweight setup that doesn't block tests.
 */
async function globalSetup() {
  console.log('[Setup] Test environment ready.');
  console.log('[Setup] Server: http://127.0.0.1:88');
  console.log('[Setup] Note: Auth-dependent tests will manage their own sessions.');
}

module.exports = globalSetup;
