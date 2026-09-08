// pages/history/history.js
const request = require('../../utils/request.js');
const storage = require('../../utils/storage.js');
const socket = require('../../utils/socket.js');

Page({
  data: {
    settlements: [],
    loading: true,
    // 备注编辑
    showRemarkModal: false,
    editRemark: '',
    editId: null,
    remarkLoading: false
  },

  onLoad() {
    this.loadHistory();
    // 监听历史同步
    socket.on('settlement_history_sync', () => {
      this.loadHistory();
    });
  },

  onShow() {
    this.loadHistory();
  },

  onPullDownRefresh() {
    this.loadHistory();
    wx.stopPullDownRefresh();
  },

  // 加载历史记录
  async loadHistory() {
    this.setData({ loading: true });
    try {
      const res = await request.getSettlementHistory();
      let settlements = res.settlements || [];
      // 按时间倒序
      settlements = settlements.sort((a, b) => b.id - a.id);
      // 合并本地待同步备注
      const pending = storage.getPendingRemarks();
      settlements.forEach(s => {
        const p = pending.find(x => x.id === s.id);
        if (p) s.remark = p.remark;
      });
      this.setData({ settlements });
      // 同步到本地
      storage.setLocalSettlements(res.settlements || []);
    } catch (e) {
      console.error('加载历史失败:', e);
      // 离线时使用本地数据
      const local = storage.getLocalSettlements();
      this.setData({ settlements: local.sort((a, b) => b.id - a.id) });
      wx.showToast({ title: '离线模式，显示本地数据', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  // 跳转到详情
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
  },

  // 编辑备注
  onEditRemark(e) {
    e.stopPropagation && e.stopPropagation();
    const { id, remark } = e.currentTarget.dataset;
    this.setData({
      showRemarkModal: true,
      editId: id,
      editRemark: remark || ''
    });
  },

  hideRemarkModal() {
    this.setData({ showRemarkModal: false });
  },

  onEditRemarkInput(e) {
    this.setData({ editRemark: e.detail.value });
  },

  // 保存备注
  async onSaveRemark() {
    const { editId, editRemark } = this.data;
    if (!editId) return;

    this.setData({ remarkLoading: true });
    try {
      await request.saveRemarkWithSync(editId, editRemark.trim());
      wx.showToast({ title: '备注已保存', icon: 'success' });
      this.setData({ showRemarkModal: false });
      this.loadHistory();
    } catch (e) {
      wx.showToast({ title: '保存失败，已存本地', icon: 'none' });
      this.setData({ showRemarkModal: false });
      this.loadHistory();
    } finally {
      this.setData({ remarkLoading: false });
    }
  }
});
