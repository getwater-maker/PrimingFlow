// rebuild/auth-manager.js — 단독 사용 모드 (인증 비활성화)
class AuthError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}

const DUMMY_RESULT = {
  user: { id: 'local', email: 'local@flow.app', name: 'Local User' },
  access: {
    app_status: 'active',
    name: 'Local User',
    email: 'local@flow.app',
    start_date: null,
    end_date: null,
    devices: [],
  },
};

class AuthManager {
  async authenticate() { return DUMMY_RESULT; }
  async fullLogin() { return DUMMY_RESULT; }
  async loginWithGoogle() { return DUMMY_RESULT; }
  async checkAccess() { return DUMMY_RESULT.access; }
  async registerHardware() { return { success: true }; }
  async verifyToken() { return DUMMY_RESULT; }
  getStatusMessage() { return null; }
  getHardwareId() { return 'local-device'; }
  logout() { /* no-op */ }
}

module.exports = { AuthManager, AuthError, ERROR_MESSAGES: {} };
