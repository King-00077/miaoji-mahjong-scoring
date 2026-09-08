// app.js
const storage = require('./utils/storage.js');
const socket = require('./utils/socket.js');

App({
  globalData: {
    userInfo: null,
    serverBase: 'http://47.109.52.139:2525',
    socketConnected: false
  },

  onLaunch() {
    // 检查登录状态
    const user = storage.getUser();
    if (user && user.userId) {
      this.globalData.userInfo = user;
      console.log('已登录用户:', user.nickname, user.userId);
    } else {
      console.log('未登录，将跳转登录页');
    }
  },

  onShow() {
    // 恢复网络时同步待备注
    const pending = storage.getPendingRemarks();
    if (pending && pending.length > 0) {
      console.log('有待同步备注，开始同步...');
      this.syncPendingRemarks();
    }
  },

  // 同步所有待同步备注
  async syncPendingRemarks() {
    const request = require('./utils/request.js');
    const pending = storage.getPendingRemarks();
    if (!pending || pending.length === 0) return;

    for (const item of pending) {
      try {
        await request.post('/api/update-settlement-remark', {
          id: item.id,
          remark: item.remark
        });
        storage.removePendingRemark(item.id);
      } catch (e) {
        console.log('备注同步失败，保留待同步:', item.id);
      }
    }
  },

  // 连接WebSocket
  connectSocket() {
    const user = this.globalData.userInfo;
    if (!user) return;
    socket.connect(this.globalData.serverBase, user);
  },

  // 断开WebSocket
  disconnectSocket() {
    socket.disconnect();
  }
});
