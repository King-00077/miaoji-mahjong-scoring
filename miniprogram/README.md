# 嘴子麻将计分器 - 微信小程序版

基于微信小程序原生框架开发的麻将计分系统，与 Web 版共用后端服务。

## 功能特性

- ✅ 用户注册/登录（昵称+密码，自动生成用户ID）
- ✅ 忘记账号：通过用户ID重置昵称和密码
- ✅ 实时计分（WebSocket 同步）
- ✅ 结算管理（备注、删除、历史记录）
- ✅ 备注多端同步（离线待同步队列，联网自动上传）
- ✅ 排行榜（按总分/胜率）
- ✅ 个人战绩统计
- ✅ 结算后自动弹出收款码
- ✅ 唤起微信扫一扫
- ✅ 收款码本地存储（不上传服务器）

## 技术栈

- 微信小程序原生框架（WXML/WXSS/JS）
- WebSocket 实时通信
- 本地存储（wx.setStorageSync）
- 后端：Node.js + lowdb（复用 Web 版服务端）

## 项目结构

```
miaoji-miniprogram/
├── app.js                  # 小程序入口
├── app.json                # 全局配置（页面路由、tabBar）
├── app.wxss                # 全局样式
├── project.config.json     # 项目配置
├── sitemap.json            # 站点地图
├── pages/
│   ├── login/              # 登录注册页（含忘记账号）
│   ├── index/              # 计分主页
│   ├── history/            # 历史记录
│   ├── detail/             # 结算详情
│   ├── ranking/            # 排行榜
│   └── stats/              # 我的（战绩+收款码设置）
├── utils/
│   ├── config.js           # 配置（服务器地址等）
│   ├── request.js          # 网络请求封装
│   ├── socket.js           # WebSocket 封装
│   └── storage.js          # 本地存储封装
└── images/                 # 图片资源（tabBar图标等）
```

## 快速开始

### 1. 配置服务器地址

修改 `utils/config.js`：

```javascript
const CONFIG = {
  BASE_URL: 'https://your-domain.com',      // 改为你的HTTPS域名
  SOCKET_URL: 'wss://your-domain.com',      // WebSocket地址
  // ...
};
```

> ⚠️ 小程序要求所有网络请求必须使用 HTTPS，且域名需在小程序后台配置「request 合法域名」和「socket 合法域名」。
> 开发阶段可在微信开发者工具中勾选「不校验合法域名」进行测试。

### 2. 导入项目

1. 打开微信开发者工具
2. 选择「导入项目」
3. 选择本项目目录
4. 填入你的小程序 AppID（或使用测试号）
5. 点击导入

### 3. 配置 tabBar 图标

`images/` 目录下需要放置以下图标（建议尺寸 81x81px）：
- `tab_score.png` / `tab_score_active.png`
- `tab_history.png` / `tab_history_active.png`
- `tab_rank.png` / `tab_rank_active.png`
- `tab_me.png` / `tab_me_active.png`

## 后端服务

后端复用 Web 版的 Node.js 服务，部署在服务器上。主要接口：

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/user/register` | POST | 用户注册 |
| `/api/user/login` | POST | 用户登录 |
| `/api/user/resetNickById` | POST | 通过ID重置昵称密码 |
| `/api/user/stats` | GET | 用户战绩 |
| `/api/user/leaderboard` | GET | 排行榜 |
| `/api/settlement-history` | GET | 结算历史 |
| `/api/update-settlement-remark` | POST | 更新结算备注 |
| `/api/delete-settlement` | POST | 删除结算记录 |

WebSocket 消息类型：`game_state`、`players_update`、`score_update`、`settlement_complete`、`settlement_history_sync` 等。

## 注意事项

1. **HTTPS 要求**：正式发布前必须配置 HTTPS 域名
2. **域名备案**：request 和 socket 合法域名需要 ICP 备案
3. **包大小**：小程序主包限制 2MB，总包 20MB
4. **收款码**：保存在本地 storage，卸载小程序会丢失
5. **离线备注**：断网时修改的备注会保存在本地，联网后自动同步

## 与 Web 版的区别

| 功能 | Web 版 | 小程序版 |
|---|---|---|
| 实时计分 | ✅ WebSocket | ✅ WebSocket |
| 用户系统 | ✅ | ✅ |
| 忘记账号 | ✅ | ✅ |
| 备注同步 | ✅ | ✅ |
| TTS 语音 | ✅ | 🔄 开发中 |
| 高光播报 | ✅ | 🔄 开发中 |
| PWA 安装 | ✅ | ❌（小程序本身即安装形态） |
| 唤起微信扫一扫 | ⚠️ 需URL Scheme | ✅ 原生 wx.scanCode |
| 收款码长按保存 | ✅ | ✅ |

## 开发进度

- [x] 项目框架搭建
- [x] 登录注册（含忘记账号）
- [x] 计分主页框架（WebSocket连接）
- [x] 历史记录（含备注编辑）
- [x] 结算详情（含备注编辑、删除）
- [x] 排行榜
- [x] 战绩统计
- [x] 收款码设置与弹窗
- [x] 备注离线同步
- [ ] 计分细节完善（与后端协议对齐）
- [ ] TTS 语音播报
- [ ] 高光播报词库
- [ ] 游客模式
