// utils/socket.js
const CONFIG = require('./config.js');
const storage = require('./storage.js');

let socketTask = null;
let reconnectTimer = null;
let reconnectCount = 0;
let messageHandlers = {};

const socket = {
  isConnected: false,

  // 连接WebSocket
  connect(user) {
    if (this.isConnected) {
      console.log('WebSocket已连接');
      return;
    }

    const url = CONFIG.SOCKET_URL;
    console.log('正在连接WebSocket:', url);

    socketTask = wx.connectSocket({
      url: url,
      protocols: [],
      timeout: 10000
    });

    socketTask.onOpen(() => {
      this.isConnected = true;
      reconnectCount = 0;
      console.log('WebSocket连接成功');

      // 发送用户身份
      if (user && user.userId) {
        this.send({
          type: 'auth',
          userId: user.userId,
          nickname: user.nickname
        });
      }
    });

    socketTask.onMessage((res) => {
      try {
        const data = JSON.parse(res.data);
        this.handleMessage(data);
      } catch (e) {
        console.error('解析WebSocket消息失败:', e);
      }
    });

    socketTask.onError((err) => {
      console.error('WebSocket错误:', err);
      this.isConnected = false;
    });

    socketTask.onClose(() => {
      this.isConnected = false;
      console.log('WebSocket连接关闭');
      // 自动重连
      this.autoReconnect(user);
    });
  },

  // 自动重连
  autoReconnect(user) {
    if (reconnectCount >= 5) {
      console.log('重连次数超过上限，停止重连');
      return;
    }
    reconnectCount++;
    const delay = Math.min(1000 * reconnectCount, 5000);
    console.log(`将在${delay}ms后重连（第${reconnectCount}次）`);

    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      this.connect(user);
    }, delay);
  },

  // 断开连接
  disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectCount = 0;
    if (socketTask) {
      socketTask.close();
      socketTask = null;
    }
    this.isConnected = false;
  },

  // 发送消息
  send(data) {
    if (!this.isConnected || !socketTask) {
      console.warn('WebSocket未连接，无法发送消息');
      return false;
    }
    try {
      socketTask.send({
        data: JSON.stringify(data),
        success() { return true; },
        fail(err) {
          console.error('发送消息失败:', err);
          return false;
        }
      });
      return true;
    } catch (e) {
      console.error('发送消息异常:', e);
      return false;
    }
  },

  // 注册消息处理器
  on(type, handler) {
    if (!messageHandlers[type]) {
      messageHandlers[type] = [];
    }
    messageHandlers[type].push(handler);
  },

  // 移除消息处理器
  off(type, handler) {
    if (messageHandlers[type]) {
      messageHandlers[type] = messageHandlers[type].filter(h => h !== handler);
    }
  },

  // 处理消息
  handleMessage(data) {
    const type = data.type;
    const handlers = messageHandlers[type] || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (e) {
        console.error(`消息处理器[${type}]异常:`, e);
      }
    });

    // 特殊处理：历史结算数据同步
    if (type === 'settlement_history_sync' && data.settlements) {
      this.syncSettlementHistory(data.settlements);
    }
  },

  // 同步结算历史到本地
  syncSettlementHistory(serverSettlements) {
    try {
      const serverIds = new Set(serverSettlements.map(s => s.id));
      const localSettlements = storage.getLocalSettlements();
      // 只保留本地独有的离线记录
      const localOnly = (localSettlements || []).filter(s => {
        if (!s._localOnly) return false;
        if (serverIds.has(s.id)) return false;
        return true;
      });
      const merged = [...serverSettlements, ...localOnly].sort((a, b) => a.id - b.id);
      storage.setLocalSettlements(merged);
      console.log(`历史结算数据已同步，共${merged.length}条`);
    } catch (e) {
      console.error('同步结算历史失败:', e);
    }
  }
};

module.exports = socket;
