// utils/storage.js
const CONFIG = require('./config.js');

const storage = {
  // 用户相关
  getUser() {
    try {
      return wx.getStorageSync(CONFIG.STORAGE_KEYS.USER) || null;
    } catch (e) {
      return null;
    }
  },

  setUser(user) {
    try {
      wx.setStorageSync(CONFIG.STORAGE_KEYS.USER, user);
    } catch (e) {
      console.error('保存用户失败:', e);
    }
  },

  clearUser() {
    try {
      wx.removeStorageSync(CONFIG.STORAGE_KEYS.USER);
    } catch (e) {}
  },

  // 本地结算记录
  getLocalSettlements() {
    try {
      return wx.getStorageSync(CONFIG.STORAGE_KEYS.LOCAL_SETTLEMENTS) || [];
    } catch (e) {
      return [];
    }
  },

  setLocalSettlements(list) {
    try {
      wx.setStorageSync(CONFIG.STORAGE_KEYS.LOCAL_SETTLEMENTS, list.slice(-100));
    } catch (e) {
      console.error('保存本地结算记录失败:', e);
    }
  },

  updateLocalSettlementRemark(id, remark) {
    try {
      const list = this.getLocalSettlements();
      const record = list.find(s => s.id === id);
      if (record) {
        record.remark = remark;
        this.setLocalSettlements(list);
      }
    } catch (e) {
      console.error('更新本地备注失败:', e);
    }
  },

  // 待同步备注队列
  getPendingRemarks() {
    try {
      return wx.getStorageSync(CONFIG.STORAGE_KEYS.PENDING_REMARKS) || [];
    } catch (e) {
      return [];
    }
  },

  addPendingRemark(id, remark) {
    try {
      let queue = this.getPendingRemarks().filter(x => x.id !== id);
      queue.push({ id, remark, time: Date.now() });
      wx.setStorageSync(CONFIG.STORAGE_KEYS.PENDING_REMARKS, queue);
    } catch (e) {
      console.error('添加待同步备注失败:', e);
    }
  },

  removePendingRemark(id) {
    try {
      const queue = this.getPendingRemarks().filter(x => x.id !== id);
      wx.setStorageSync(CONFIG.STORAGE_KEYS.PENDING_REMARKS, queue);
    } catch (e) {}
  },

  // 收款码
  getPayQrcode() {
    try {
      return wx.getStorageSync(CONFIG.STORAGE_KEYS.PAY_QRCODE) || '';
    } catch (e) {
      return '';
    }
  },

  setPayQrcode(base64) {
    try {
      wx.setStorageSync(CONFIG.STORAGE_KEYS.PAY_QRCODE, base64);
    } catch (e) {
      console.error('保存收款码失败:', e);
    }
  },

  clearPayQrcode() {
    try {
      wx.removeStorageSync(CONFIG.STORAGE_KEYS.PAY_QRCODE);
    } catch (e) {}
  }
};

module.exports = storage;
