// @ts-check
/**
 * Global teardown: Clean up test data, close connections.
 */
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '.auth', 'test-user-state.json');

async function globalTeardown() {
  console.log('[Teardown] Cleaning up test artifacts...');

  // Remove auth state file
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
    console.log('[Teardown] Removed auth state file');
  }

  // Note: We don't delete the test user or test files here
  // because they may be useful for debugging failed tests.
  console.log('[Teardown] Done.');
}

module.exports = globalTeardown;
