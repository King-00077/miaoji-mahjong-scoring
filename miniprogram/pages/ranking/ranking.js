// pages/ranking/ranking.js
const request = require('../../utils/request.js');

Page({
  data: {
    list: [],
    loading: true,
    sortBy: 'totalScore'
  },

  onLoad() {
    this.loadRanking();
  },

  onShow() {
    this.loadRanking();
  },

  onPullDownRefresh() {
    this.loadRanking();
    wx.stopPullDownRefresh();
  },

  switchSort(e) {
    const sortBy = e.currentTarget.dataset.sort;
    this.setData({ sortBy });
    this.loadRanking();
  },

  async loadRanking() {
    this.setData({ loading: true });
    try {
      const res = await request.getLeaderboard(this.data.sortBy);
      if (res.success) {
        this.setData({ list: res.list || [] });
      } else {
        this.setData({ list: [] });
      }
    } catch (e) {
      console.error('加载排行榜失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  goStats(e) {
    const userId = e.currentTarget.dataset.userid;
    wx.navigateTo({ url: '/pages/stats/stats?userId=' + userId });
  }
});
