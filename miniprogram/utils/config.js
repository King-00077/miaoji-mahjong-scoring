// utils/config.js
const CONFIG = {
  // 服务器地址（部署时改为HTTPS域名）
  BASE_URL: 'http://47.109.52.139:2525',

  // WebSocket地址
  SOCKET_URL: 'ws://47.109.52.139:2525',

  // 重置密码
  DEFAULT_RESET_PASSWORD: '123456',

  // 本地存储Key
  STORAGE_KEYS: {
    USER: 'sc_user',
    LOCAL_SETTLEMENTS: 'local_settlements',
    PENDING_REMARKS: 'pending_remark_sync',
    PAY_QRCODE: 'pay_qrcode_base64'
  },

  // 请求超时
  REQUEST_TIMEOUT: 10000,

  // 分页大小
  PAGE_SIZE: 20
};

module.exports = CONFIG;
