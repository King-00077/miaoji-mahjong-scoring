// pages/detail/detail.js
const request = require('../../utils/request.js');
const storage = require('../../utils/storage.js');

Page({
  data: {
    settlement: null,
    remark: '',
    remarkLoading: false,
    settlementId: null
  },

  onLoad(options) {
    const id = parseInt(options.id);
    this.setData({ settlementId: id });
    this.loadDetail(id);
  },

  // 加载详情
  async loadDetail(id) {
    try {
      const res = await request.getSettlementHistory();
      const settlements = res.settlements || [];
      const settlement = settlements.find(s => s.id === id);
      if (settlement) {
        // 合并本地待同步备注
        const pending = storage.getPendingRemarks();
        const p = pending.find(x => x.id === id);
        if (p) settlement.remark = p.remark;
        this.setData({
          settlement,
          remark: settlement.remark || ''
        });
      } else {
        wx.showToast({ title: '记录不存在', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1000);
      }
    } catch (e) {
      console.error('加载详情失败:', e);
      // 尝试从本地加载
      const local = storage.getLocalSettlements();
      const settlement = local.find(s => s.id === id);
      if (settlement) {
        this.setData({ settlement, remark: settlement.remark || '' });
      } else {
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    }
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  // 保存备注
  async onSaveRemark() {
    const { settlementId, remark } = this.data;
    if (!settlementId) return;

    this.setData({ remarkLoading: true });
    try {
      await request.saveRemarkWithSync(settlementId, remark.trim());
      wx.showToast({ title: '备注已保存', icon: 'success' });
      // 更新本地数据
      if (this.data.settlement) {
        this.setData({ 'settlement.remark': remark.trim() });
      }
    } catch (e) {
      wx.showToast({ title: '已保存到本地', icon: 'none' });
    } finally {
      this.setData({ remarkLoading: false });
    }
  },

  // 删除记录
  onDelete() {
    wx.showModal({
      title: '确认删除',
      content: '确定要删除这条结算记录吗？删除后不可恢复。',
      confirmColor: '#c62828',
      success: async (res) => {
        if (res.confirm) {
          try {
            await request.deleteSettlement(this.data.settlementId);
            wx.showToast({ title: '已删除', icon: 'success' });
            setTimeout(() => wx.navigateBack(), 800);
          } catch (e) {
            wx.showToast({ title: '删除失败', icon: 'none' });
          }
        }
      }
    });
  }
});
