const request = require('supertest');
const fs = require('fs');
const path = require('path');

// Mock the server module
jest.mock('fs');
const app = require('../server');

describe('ISO Share Server', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock uploads directory
    fs.existsSync.mockReturnValue(true);
    fs.readdirSync.mockReturnValue(['test.iso', 'another.iso']);
    fs.statSync.mockReturnValue({ size: 1024 });
  });

  describe('GET /', () => {
    it('should render index page with files', async () => {
      const response = await request(app)
        .get('/')
        .expect(200);
      
      expect(response.text).toContain('test.iso');
    });

    it('should handle empty uploads directory', async () => {
      fs.readdirSync.mockReturnValue([]);
      
      const response = await request(app)
        .get('/')
        .expect(200);
    });
  });

  describe('GET /login', () => {
    it('should render login page', async () => {
      const response = await request(app)
        .get('/login')
        .expect(200);
      
      expect(response.text).toContain('login');
    });
  });

  describe('POST /login', () => {
    it('should redirect to admin on correct password', async () => {
      const response = await request(app)
        .post('/login')
        .send({ password: 'PASSWORD' })
        .expect(302);
      
      expect(response.headers.location).toBe('/admin-upload');
    });

    it('should show error on incorrect password', async () => {
      const response = await request(app)
        .post('/login')
        .send({ password: 'wrong' })
        .expect(200);
      
      expect(response.text).toContain('Falsches Passwort');
    });
  });

  describe('GET /admin-upload', () => {
    it('should redirect to login when not authenticated', async () => {
      const response = await request(app)
        .get('/admin-upload')
        .expect(302);
      
      expect(response.headers.location).toBe('/login');
    });
  });

  describe('GET /download/:filename', () => {
    it('should reject files with path traversal', async () => {
      const response = await request(app)
        .get('/download/../etc/passwd')
        .expect(400);
      
      expect(response.text).toContain('Invalid filename');
    });

    it('should reject non-iso files', async () => {
      fs.existsSync.mockReturnValue(true);
      
      const response = await request(app)
        .get('/download/test.txt')
        .expect(404);
    });
  });

  describe('GET /search', () => {
    it('should filter files by query', async () => {
      fs.readdirSync.mockReturnValue(['ubuntu.iso', 'windows.iso', 'test.iso']);
      
      const response = await request(app)
        .get('/search?q=ubuntu')
        .expect(200);
    });
  });

  describe('GET /privacy', () => {
    it('should render privacy page', async () => {
      const response = await request(app)
        .get('/privacy')
        .expect(200);
    });
  });

  describe('GET /imprint', () => {
    it('should render imprint page', async () => {
      const response = await request(app)
        .get('/imprint')
        .expect(200);
    });
  });
});