// pages/index/index.js
const app = getApp();
const socket = require('../../utils/socket.js');
const storage = require('../../utils/storage.js');
const request = require('../../utils/request.js');

Page({
  data: {
    userInfo: null,
    socketConnected: false,
    players: [],
    gameState: {
      round: 0,
      banker: ''
    },
    // 结算弹窗
    showSettlement: false,
    settlementRemark: '',
    settlementLoading: false,
    // 收款码弹窗
    showPayQrcode: false,
    payQrcode: ''
  },

  onLoad() {
    const user = storage.getUser();
    if (!user || !user.userId) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.setData({ userInfo: user });
    this.connectSocket();
    this.loadPayQrcode();
  },

  onShow() {
    const user = storage.getUser();
    if (user && user.userId) {
      this.setData({ userInfo: user });
      if (!socket.isConnected) {
        this.connectSocket();
      }
    }
  },

  onUnload() {
    // 不主动断开，保持全局连接
  },

  onPullDownRefresh() {
    this.loadGameState();
    wx.stopPullDownRefresh();
  },

  // 连接WebSocket
  connectSocket() {
    const user = this.data.userInfo;
    if (!user) return;

    socket.connect(user);
    this.setData({ socketConnected: socket.isConnected });

    // 注册消息处理器
    socket.on('game_state', (data) => {
      this.handleGameState(data);
    });

    socket.on('players_update', (data) => {
      this.setData({ players: data.players || [] });
    });

    socket.on('score_update', (data) => {
      if (data.players) {
        this.setData({ players: data.players });
      }
    });

    socket.on('settlement_complete', (data) => {
      this.handleSettlementComplete(data);
    });

    socket.on('settlement_history_sync', (data) => {
      console.log('收到历史同步:', data.settlements ? data.settlements.length : 0, '条');
    });

    // 定时检查连接状态
    this.connectionCheckTimer = setInterval(() => {
      this.setData({ socketConnected: socket.isConnected });
    }, 2000);
  },

  // 处理游戏状态
  handleGameState(data) {
    if (data.players) {
      this.setData({ players: data.players });
    }
    if (data.gameState) {
      this.setData({ gameState: data.gameState });
    }
  },

  // 加载游戏状态
  async loadGameState() {
    try {
      // 可以通过HTTP接口获取当前状态
      console.log('刷新游戏状态');
    } catch (e) {
      console.error('加载游戏状态失败:', e);
    }
  },

  // 加载收款码
  loadPayQrcode() {
    const qrcode = storage.getPayQrcode();
    this.setData({ payQrcode: qrcode });
  },

  // 加分
  onAddScore(e) {
    const id = e.currentTarget.dataset.id;
    socket.send({
      type: 'score_change',
      playerId: id,
      delta: 1
    });
    wx.vibrateShort({ type: 'light' });
  },

  // 减分
  onSubScore(e) {
    const id = e.currentTarget.dataset.id;
    socket.send({
      type: 'score_change',
      playerId: id,
      delta: -1
    });
    wx.vibrateShort({ type: 'light' });
  },

  // 显示结算弹窗
  onSettlement() {
    if (this.data.players.length === 0) {
      wx.showToast({ title: '暂无玩家', icon: 'none' });
      return;
    }
    this.setData({
      showSettlement: true,
      settlementRemark: ''
    });
  },

  hideSettlementModal() {
    this.setData({ showSettlement: false });
  },

  onRemarkInput(e) {
    this.setData({ settlementRemark: e.detail.value });
  },

  // 确认结算
  async onConfirmSettlement() {
    this.setData({ settlementLoading: true });
    try {
      // 发送结算请求
      socket.send({
        type: 'settlement',
        remark: this.data.settlementRemark
      });
      this.setData({ showSettlement: false });
      wx.showToast({ title: '结算成功', icon: 'success' });
      // 显示收款码
      setTimeout(() => {
        this.showPayQrcodeModal();
      }, 500);
    } catch (e) {
      wx.showToast({ title: '结算失败', icon: 'none' });
    } finally {
      this.setData({ settlementLoading: false });
    }
  },

  // 结算完成处理
  handleSettlementComplete(data) {
    wx.showToast({ title: '结算完成', icon: 'success' });
    if (data.players) {
      this.setData({ players: data.players });
    }
    // 显示收款码
    this.showPayQrcodeModal();
  },

  // 新的一局
  onNewGame() {
    wx.showModal({
      title: '确认',
      content: '确定要开始新的一局吗？',
      success: (res) => {
        if (res.confirm) {
          socket.send({ type: 'new_game' });
          wx.showToast({ title: '新一局已开始', icon: 'success' });
        }
      }
    });
  },

  // 显示收款码
  showPayQrcodeModal() {
    this.loadPayQrcode();
    this.setData({ showPayQrcode: true });
  },

  hidePayQrcode() {
    this.setData({ showPayQrcode: false });
  },

  // 唤起微信扫一扫
  onOpenWechatScan() {
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: (res) => {
        console.log('扫码结果:', res.result);
      },
      fail: (err) => {
        console.error('扫码失败:', err);
        wx.showToast({ title: '扫码取消', icon: 'none' });
      }
    });
  },

  // 跳转到我的页面
  goStats() {
    wx.switchTab({ url: '/pages/stats/stats' });
  }
});
