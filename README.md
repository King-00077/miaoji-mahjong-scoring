# 嘴子麻将计分器 (Miaoji Mahjong Scoring)

WebToApp 版麻将计分系统，基于 Node.js + WebSocket 实现实时计分。

## 功能特性

- 实时麻将计分（WebSocket 同步）
- 用户注册/登录，自动生成用户 ID
- 历史结算记录管理（增删改、备注、CSV 导出）
- 排行榜与个人战绩统计
- 高光播报词库（可动态扩展）
- TTS 语音合成
- 忘记账号：通过用户 ID 重置昵称和密码
- PWA 支持（可安装到桌面）
- 监控面板

## 快速开始

```bash
npm install
node server.js
```

- 计分服务：http://localhost:2525
- 监控面板：http://localhost:5252

## 忘记账号/重置密码

### 前端方式
登录页点击「忘记账号？通过ID重置」，输入用户 ID 即可重置：
- 重置后昵称 = 用户 ID
- 重置后密码 = `123456`

### 服务器命令行方式
```bash
cd /opt/miaoji
node resetUser.js <用户ID>
# 示例：node resetUser.js u0001
```

## 技术栈

- Node.js
- WebSocket (ws)
- lowdb（JSON 文件数据库）
- 原生 HTTP 服务
- 前端单页应用（原生 JS）

## 目录结构

```
├── server.js          # 主服务（HTTP + WebSocket）
├── index.html         # 前端单页应用
├── launch.html        # 启动页
├── monitor.js         # 监控脚本
├── sw.js              # Service Worker
├── manifest.json      # PWA 清单
├── resetUser.js       # 命令行重置用户工具
├── package.json       # 项目配置
└── .gitignore         # 忽略运行时数据
```

## 注意

`settlementHistory.json`、`users.json`、`gameState.json` 等运行时数据不纳入版本控制。
