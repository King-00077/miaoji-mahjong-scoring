// utils/request.js
const CONFIG = require('./config.js');
const storage = require('./storage.js');

const request = {
  // 通用请求
  request(method, url, data = {}) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: CONFIG.BASE_URL + url,
        method: method,
        data: data,
        header: {
          'Content-Type': 'application/json'
        },
        timeout: CONFIG.REQUEST_TIMEOUT,
        success(res) {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(res.data);
          } else {
            reject(new Error(res.data.msg || '请求失败'));
          }
        },
        fail(err) {
          reject(new Error(err.errMsg || '网络错误'));
        }
      });
    });
  },

  get(url, data) {
    return this.request('GET', url, data);
  },

  post(url, data) {
    return this.request('POST', url, data);
  },

  // 用户相关
  async register(nickname, password) {
    return this.post('/api/user/register', { nickname, password });
  },

  async login(nickname, password) {
    return this.post('/api/user/login', { nickname, password });
  },

  async resetNickById(uid) {
    return this.post('/api/user/resetNickById', { uid });
  },

  // 微信一键登录
  async wxLogin(code, nickname, avatar) {
    return this.post('/api/user/wx-login', { code, nickname, avatar });
  },

  async updateNickname(userId, nickname, password) {
    return this.post('/api/user/update-nickname', { userId, nickname, password });
  },

  async getUserStats(userId) {
    return this.get('/api/user/stats?userId=' + encodeURIComponent(userId));
  },

  async getLeaderboard(sortBy = 'totalScore') {
    return this.get('/api/user/leaderboard?sortBy=' + sortBy);
  },

  // 结算历史
  async getSettlementHistory() {
    return this.get('/api/settlement-history');
  },

  async updateSettlementRemark(id, remark) {
    return this.post('/api/update-settlement-remark', { id, remark });
  },

  async deleteSettlement(id) {
    return this.post('/api/delete-settlement', { id });
  },

  // 保存备注（带离线同步）
  async saveRemarkWithSync(id, remark) {
    // 先写本地
    storage.updateLocalSettlementRemark(id, remark);
    storage.addPendingRemark(id, remark);

    try {
      const res = await this.updateSettlementRemark(id, remark);
      if (res.success) {
        storage.removePendingRemark(id);
        return true;
      }
      return false;
    } catch (e) {
      console.log('备注离线保存，联网后自动同步:', e.message);
      return false;
    }
  }
};

module.exports = request;
