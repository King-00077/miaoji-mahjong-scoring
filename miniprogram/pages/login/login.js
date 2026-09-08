// pages/login/login.js
const app = getApp();
const request = require('../../utils/request.js');
const storage = require('../../utils/storage.js');

Page({
  data: {
    nickname: '',
    password: '',
    loading: false,
    statusMsg: '',
    statusType: '',
    currentUser: null,
    // 重置弹窗
    showReset: false,
    resetUid: '',
    resetLoading: false,
    resetStatusMsg: '',
    resetStatusType: '',
    // 微信登录
    showWxConfirm: false,
    wxAvatar: '',
    wxNickname: '',
    wxLoading: false,
    wxStatusMsg: '',
    wxStatusType: ''
  },

  onLoad() {
    const user = storage.getUser();
    if (user && user.userId) {
      this.setData({
        currentUser: user,
        nickname: user.nickname || '',
        password: user.password || ''
      });
    }
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  showStatus(msg, type) {
    this.setData({ statusMsg: msg, statusType: 'status-' + type });
  },

  hideStatus() {
    this.setData({ statusMsg: '', statusType: '' });
  },

  // ===== 微信登录 =====
  // 选择微信头像
  onChooseAvatar(e) {
    const avatarUrl = e.detail.avatarUrl;
    this.setData({
      wxAvatar: avatarUrl,
      showWxConfirm: true,
      wxStatusMsg: '',
      wxStatusType: ''
    });
  },

  hideWxConfirm() {
    this.setData({ showWxConfirm: false });
  },

  onWxNicknameInput(e) {
    this.setData({ wxNickname: e.detail.value });
  },

  showWxStatus(msg, type) {
    this.setData({ wxStatusMsg: msg, wxStatusType: 'status-' + type });
  },

  // 确认微信登录
  async onWxLoginConfirm() {
    const { wxNickname, wxAvatar } = this.data;

    if (!wxNickname || !wxNickname.trim()) {
      this.showWxStatus('请输入昵称', 'error');
      return;
    }

    this.setData({ wxLoading: true });
    this.showWxStatus('登录中...', 'info');

    try {
      // 1. 获取微信登录 code
      const loginRes = await new Promise((resolve, reject) => {
        wx.login({
          success: resolve,
          fail: reject
        });
      });

      if (!loginRes.code) {
        throw new Error('获取微信登录凭证失败');
      }

      // 2. 调用后端微信登录接口
      const res = await request.wxLogin(
        loginRes.code,
        wxNickname.trim(),
        wxAvatar || ''
      );

      if (res.success) {
        // 保存用户信息（微信登录无需密码，保存空密码标记）
        const user = {
          userId: res.user.userId,
          nickname: res.user.nickname,
          avatar: res.user.avatar || wxAvatar || '',
          wxOpenid: res.user.wxOpenid || '',
          password: '',
          isWxLogin: true
        };
        storage.setUser(user);
        app.globalData.userInfo = user;

        // 保存头像到本地（临时路径，后续可上传服务器）
        if (wxAvatar) {
          wx.setStorageSync('wx_avatar_' + res.user.userId, wxAvatar);
        }

        const welcomeMsg = res.isNew ? '注册成功！' : '登录成功！';
        this.showWxStatus(`${welcomeMsg}欢迎 ${res.user.nickname}`, 'success');

        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' });
        }, 800);
      } else {
        this.showWxStatus(res.msg || '登录失败', 'error');
      }
    } catch (e) {
      console.error('微信登录失败:', e);
      this.showWxStatus('登录失败：' + (e.message || '未知错误'), 'error');
    } finally {
      this.setData({ wxLoading: false });
    }
  },

  // ===== 账号密码登录 =====
  // 注册
  async onRegister() {
    const { nickname, password } = this.data;
    if (!nickname || !nickname.trim()) {
      this.showStatus('请填写昵称', 'error');
      return;
    }
    if (!password) {
      this.showStatus('请设置密码', 'error');
      return;
    }

    this.setData({ loading: true });
    this.showStatus('注册中...', 'info');

    try {
      const res = await request.register(nickname.trim(), password);
      if (res.success) {
        const user = {
          userId: res.user.userId,
          nickname: res.user.nickname,
          password: password,
          isWxLogin: false
        };
        storage.setUser(user);
        app.globalData.userInfo = user;
        this.showStatus(`注册成功！您的ID：${res.user.userId}`, 'success');
        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' });
        }, 800);
      } else {
        this.showStatus(res.msg || '注册失败', 'error');
      }
    } catch (e) {
      this.showStatus('网络错误：' + e.message, 'error');
    } finally {
      this.setData({ loading: false });
    }
  },

  // 登录
  async onLogin() {
    const { nickname, password } = this.data;
    if (!nickname || !nickname.trim()) {
      this.showStatus('请输入昵称', 'error');
      return;
    }
    if (!password) {
      this.showStatus('请输入密码', 'error');
      return;
    }

    this.setData({ loading: true });
    this.showStatus('登录中...', 'info');

    try {
      const res = await request.login(nickname.trim(), password);
      if (res.success) {
        const user = {
          userId: res.user.userId,
          nickname: res.user.nickname,
          password: password,
          isWxLogin: false
        };
        storage.setUser(user);
        app.globalData.userInfo = user;
        this.showStatus('登录成功！欢迎回来 ' + res.user.nickname, 'success');
        setTimeout(() => {
          wx.switchTab({ url: '/pages/index/index' });
        }, 600);
      } else {
        this.showStatus(res.msg || '登录失败', 'error');
      }
    } catch (e) {
      this.showStatus('网络错误：' + e.message, 'error');
    } finally {
      this.setData({ loading: false });
    }
  },

  // ===== 忘记账号/重置 =====
  showResetModal() {
    this.setData({
      showReset: true,
      resetUid: '',
      resetStatusMsg: '',
      resetStatusType: ''
    });
  },

  hideResetModal() {
    this.setData({ showReset: false });
  },

  onResetUidInput(e) {
    this.setData({ resetUid: e.detail.value });
  },

  showResetStatus(msg, type) {
    this.setData({ resetStatusMsg: msg, resetStatusType: 'status-' + type });
  },

  // 确认重置
  async onConfirmReset() {
    const { resetUid } = this.data;
    if (!resetUid || !resetUid.trim()) {
      this.showResetStatus('请输入用户ID', 'error');
      return;
    }

    this.setData({ resetLoading: true });
    this.showResetStatus('重置中...', 'info');

    try {
      const res = await request.resetNickById(resetUid.trim().toLowerCase());
      if (res.success) {
        this.showResetStatus(res.msg, 'success');
        setTimeout(() => {
          this.setData({
            showReset: false,
            nickname: resetUid.trim().toLowerCase(),
            password: '123456'
          });
          this.showStatus('账号已重置，请使用新密码登录', 'success');
        }, 1500);
      } else {
        this.showResetStatus(res.msg || '重置失败', 'error');
      }
    } catch (e) {
      this.showResetStatus('网络错误：' + e.message, 'error');
    } finally {
      this.setData({ resetLoading: false });
    }
  }
});
