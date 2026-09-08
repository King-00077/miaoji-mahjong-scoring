// pages/stats/stats.js
const app = getApp();
const request = require('../../utils/request.js');
const storage = require('../../utils/storage.js');

Page({
  data: {
    userInfo: null,
    queryUserId: '',
    stats: null,
    loading: false,
    payQrcode: ''
  },

  onLoad(options) {
    const user = storage.getUser();
    this.setData({ userInfo: user });
    this.loadPayQrcode();

    // 如果传入了userId，直接查询
    if (options.userId) {
      this.setData({ queryUserId: options.userId });
      this.queryStats(options.userId);
    } else if (user && user.userId) {
      this.queryStats(user.userId);
    }
  },

  onShow() {
    const user = storage.getUser();
    this.setData({ userInfo: user });
    this.loadPayQrcode();
  },

  onQueryInput(e) {
    this.setData({ queryUserId: e.detail.value });
  },

  onQuery() {
    const uid = this.data.queryUserId.trim();
    if (!uid) {
      wx.showToast({ title: '请输入用户ID', icon: 'none' });
      return;
    }
    this.queryStats(uid);
  },

  // 查询战绩
  async queryStats(userId) {
    this.setData({ loading: true, stats: null });
    try {
      const res = await request.getUserStats(userId);
      if (res.success) {
        this.setData({ stats: res.stats });
      } else {
        wx.showToast({ title: res.msg || '查询失败', icon: 'none' });
      }
    } catch (e) {
      console.error('查询战绩失败:', e);
      wx.showToast({ title: '网络错误', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 加载收款码
  loadPayQrcode() {
    const qrcode = storage.getPayQrcode();
    this.setData({ payQrcode: qrcode });
  },

  // 选择收款码
  onChooseQrcode() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath;
        // 转base64保存
        wx.getFileSystemManager().readFile({
          filePath: tempFilePath,
          encoding: 'base64',
          success: (data) => {
            const base64 = 'data:image/png;base64,' + data.data;
            storage.setPayQrcode(base64);
            this.setData({ payQrcode: base64 });
            wx.showToast({ title: '收款码已保存', icon: 'success' });
          },
          fail: () => {
            wx.showToast({ title: '保存失败', icon: 'none' });
          }
        });
      },
      fail: () => {
        console.log('取消选择');
      }
    });
  },

  // 清除收款码
  onClearQrcode() {
    wx.showModal({
      title: '确认清除',
      content: '确定要清除收款码吗？',
      success: (res) => {
        if (res.confirm) {
          storage.clearPayQrcode();
          this.setData({ payQrcode: '' });
          wx.showToast({ title: '已清除', icon: 'success' });
        }
      }
    });
  },

  // 退出登录
  onLogout() {
    wx.showModal({
      title: '确认退出',
      content: '确定要退出登录吗？',
      success: (res) => {
        if (res.confirm) {
          storage.clearUser();
          app.globalData.userInfo = null;
          app.disconnectSocket();
          wx.reLaunch({ url: '/pages/login/login' });
        }
      }
    });
  }
});
