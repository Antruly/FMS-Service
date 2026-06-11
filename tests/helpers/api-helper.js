// @ts-check
/**
 * API Helper for FileService E2E tests.
 * Provides authenticated API access for test setup and verification.
 */
const axios = require('axios');

const BASE_URL = 'http://127.0.0.1:88';

class ApiHelper {
  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      withCredentials: true,
      validateStatus: () => true, // Don't throw on non-2xx
    });
    this.csrfToken = null;
    this.cookies = '';
    this.authToken = '';
  }

  /**
   * Login and store credentials for subsequent requests.
   */
  async login(email, password) {
    const res = await this.client.post('/api/auth/login', {
      email,
      password,
    });

    if (res.headers['set-cookie']) {
      this.cookies = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie'].join('; ')
        : res.headers['set-cookie'];
    }

    if (res.data && res.data.data) {
      this.csrfToken = res.data.data.csrfToken;
      this.authToken = res.data.data.token;
    }

    return res.data;
  }

  /**
   * Make an authenticated GET request.
   */
  async get(path, params = {}) {
    const headers = this._getHeaders();
    const res = await this.client.get(path, {
      params,
      headers,
      ...(this.cookies && { headers: { ...headers, Cookie: this.cookies } }),
    });
    return res.data;
  }

  /**
   * Make an authenticated POST request.
   */
  async post(path, data = {}) {
    const headers = this._getHeaders();
    const res = await this.client.post(path, data, {
      headers: {
        ...headers,
        ...(this.cookies && { Cookie: this.cookies }),
      },
    });
    this._updateState(res);
    return res.data;
  }

  /**
   * Make an authenticated PUT request.
   */
  async put(path, data = {}) {
    const headers = this._getHeaders();
    const res = await this.client.put(path, data, {
      headers: {
        ...headers,
        ...(this.cookies && { Cookie: this.cookies }),
      },
    });
    return res.data;
  }

  /**
   * Make an authenticated DELETE request.
   */
  async delete(path) {
    const headers = this._getHeaders();
    const res = await this.client.delete(path, {
      headers: {
        ...headers,
        ...(this.cookies && { Cookie: this.cookies }),
      },
    });
    return res.data;
  }

  _getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'X-Device-Id': 'test_device_e2e',
    };
    if (this.csrfToken) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }
    if (this.authToken) {
      headers['Authorization'] = 'Bearer ' + this.authToken;
    }
    return headers;
  }

  _updateState(res) {
    if (res.headers['set-cookie']) {
      this.cookies = Array.isArray(res.headers['set-cookie'])
        ? res.headers['set-cookie'].join('; ')
        : res.headers['set-cookie'];
    }
    if (res.headers['x-csrf-token']) {
      this.csrfToken = res.headers['x-csrf-token'];
    }
  }

  /**
   * Create a directory via API.
   */
  async createDir(name, parentId = null) {
    return this.post('/api/files/dirs', { name, parentId });
  }

  /**
   * Upload a file (via API with multipart/form-data not supported here; use direct).
   */
  async getFiles(parentId = null) {
    return this.get('/api/files/dirs', { parentId });
  }

  /**
   * Delete a file by id.
   */
  async deleteFile(fileId) {
    return this.delete('/api/files/' + fileId);
  }

  /**
   * Get share list.
   */
  async getShares() {
    return this.get('/api/share');
  }

  /**
   * Get recycle bin.
   */
  async getRecycle() {
    return this.get('/api/files/recycle');
  }
}

module.exports = { ApiHelper, BASE_URL };
