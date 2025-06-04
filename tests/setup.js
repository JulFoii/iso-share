// Test setup and helpers
const fs = require('fs');
const path = require('path');

// Create test uploads directory if it doesn't exist
const testUploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(testUploadsDir)) {
  fs.mkdirSync(testUploadsDir, { recursive: true });
}

// Global test configuration
process.env.NODE_ENV = 'test';
process.env.ADMIN_PASSWORD = 'PASSWORD';
process.env.SESSION_SECRET = 'test-secret';

// Cleanup after tests
afterAll(() => {
  // Clean up test files if needed
  if (process.env.NODE_ENV === 'test') {
    // Remove test files created during testing
  }
});