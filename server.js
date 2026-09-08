const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');
const os = require('os');
const crypto = require('crypto');

// 尝试加载qrcode-terminal，如失败则跳过二维码生成
let QRCodeTerminal = null;
try {
    QRCodeTerminal = require('qrcode-terminal');
} catch (error) {
    console.warn('qrcode-terminal模块未安装，将跳过二维码生成');
}

// 获取本地局域网IP地址（优先192.168.x.x，其次10.x.x.x，最后其他）
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const lanAddresses = [];
    const otherAddresses = [];

    for (const interfaceName in interfaces) {
        for (const iface of interfaces[interfaceName]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                const ip = iface.address;
                if (ip.startsWith('192.168.')) {
                    lanAddresses.push(ip);
                } else {
                    otherAddresses.push(ip);
                }
            }
        }
    }

    // 优先返回192.168段的地址，如果没有则返回其他地址
    return lanAddresses.length > 0 ? lanAddresses : otherAddresses;
}

const localIPs = getLocalIP();
const primaryIP = localIPs[0] || '127.0.0.1';

// ===== 高光播报词库（支持联网学习扩展）=====
// 每条短语可含 {name}（玩家名）与 {score}（分数）占位符
// 词库可通过同目录 highlight_phrases.json 追加/覆盖，也可通过 HTTP API 动态学习
let HIGHLIGHT_PHRASES = {
    qiliang: [
        '{name}七梁惊四座',
        '{name}七梁震全场',
        '{name}七梁封神去',
        '{name}七梁通三家',
        '{name}一炸定乾坤',
        '{name}七梁笑四方',
        '{name}七梁压顶谁能敌',
        '{name}一把七梁定江山',
        '{name}七梁封王指天笑',
        '{name}七梁出鞘血溅三家',
        '{name}七梁在手天下我有',
        '{name}七梁乱杀无人挡',
        '{name}胡七梁如探囊取物',
        '{name}七梁砸下三家哭'
    ],
    combo: [
        '{name}七梁自摸双响炮',
        '{name}自摸且连坐{n}庄，气势如虹',
        '{name}连赢{n}局狂揽{score}',
        '{name}一炸进账{score}分',
        '{name}连坐{n}庄又收{score}',
        '{name}七梁在手再收{score}',
        '{name}自摸一炸{score}',
        '{name}单局封神{score}',
        '{name}七梁自摸财源滚滚',
        '{name}自摸{n}连庄再收{score}',
        '{name}开挂式碾压全场',
        '{name}七梁自摸收割机启动',
        '{name}赢麻了连庄{n}手'
    ],
    bigwin: [
        '{name}单局入账{score}',
        '{name}一局净收{score}',
        '{name}财神爷亲儿子',
        '{name}单局狂揽{score}',
        '{name}进账{score}赢麻了',
        '{name}一把吃回{score}血',
        '{name}单局暴富{score}分',
        '{name}印钞机没你赚得多',
        '{name}一局回本还倒赚',
        '{name}钞票往你兜里钻',
        '{name}通吃全场不客气'
    ],
    zimo: [
        '{name}自摸三家抖',
        '{name}自摸通吃全场',
        '{name}自摸一手胡三家',
        '{name}自摸三家连锅端',
        '{name}自摸开席全桌吃',
        '{name}自摸一响黄金万两',
        '{name}庄家自摸三杀',
        '{name}摸到就是赚到',
        '{name}自摸闷声发大财'
    ],
    streak: [
        '{name}连赢{n}局如虹',
        '{name}连胜{n}局问鼎',
        '{name}{n}连庄无敌手',
        '{name}连坐{n}庄杀出',
        '{name}连胜之势如虹',
        '{name}{n}连胜无人能挡',
        '{name}牌桌杀疯连坐{n}庄',
        '{name}连胜{n}局气势如虹',
        '{name}一庄坐穿{n}连'
    ],
    // 六梁（计分项4个 = 六梁）——六梁也值得播报
    liang6: [
        '{name}六梁压境神鬼惊',
        '{name}六梁一出牌桌炸',
        '{name}六梁轰鸣夺魁首',
        '{name}六梁镇场谁不服',
        '{name}六梁横扫没商量',
        '{name}六梁在手牌运开',
        '{name}六梁翻云覆雨间',
        '{name}六梁冲天一步登天'
    ],
    // 庄家被高梁炸下庄（赢家非庄家且梁数>=6）
    bankerHit: [
        '庄家{banker}被七梁导弹击中，{name}成功夺庄',
        '庄家{banker}惨遭{n}梁下庄，{name}一战封神',
        '{n}梁轰顶，庄家{banker}直接凉凉，{name}新王登基',
        '庄家{banker}的江山被{n}梁炸塌，{name}顺利接班',
        '{n}梁暴击，庄家{banker}下庄，{name}笑纳宝座'
    ]
};
// 加载外部词库};
// 加载外部词库（若存在 highlight_phrases.json 则合并覆盖内置词库）
try {
    if (fs.existsSync(path.join(__dirname, 'highlight_phrases.json'))) {
        const ext = JSON.parse(fs.readFileSync(path.join(__dirname, 'highlight_phrases.json'), 'utf8'));
        if (ext && typeof ext === 'object') {
            Object.keys(HIGHLIGHT_PHRASES).forEach(k => {
                if (Array.isArray(ext[k]) && ext[k].length > 0) HIGHLIGHT_PHRASES[k] = ext[k];
            });
            console.log('已加载外部高光词库 highlight_phrases.json');
        }
    }
} catch (e) { console.warn('加载外部词库失败:', e.message); }

// 从词库随机选取一条短语并填充占位符
// 全局高光短语去重集合（整场对局内同一短语不重复出现）
const usedHighlightPhrases = new Set();
function pickHighlightPhrase(type, name, score, n, skipNTemplate, bankerName, skipKeyword) {
    let pool = HIGHLIGHT_PHRASES[type] || HIGHLIGHT_PHRASES.qiliang;
    // 若要求跳过含{n}的模板（无连赢时），过滤掉
    if (skipNTemplate) {
        pool = pool.filter(function (t) { return !String(t).includes('{n}'); });
        if (pool.length === 0) pool = HIGHLIGHT_PHRASES[type] || HIGHLIGHT_PHRASES.qiliang;
    }
    // 若要求跳过含指定关键词的模板（如本局无七梁时跳过含"七梁"的模板），过滤掉
    if (skipKeyword) {
        pool = pool.filter(function (t) { return !String(t).includes(skipKeyword); });
        if (pool.length === 0) pool = HIGHLIGHT_PHRASES[type] || HIGHLIGHT_PHRASES.qiliang;
    }
    // 去重随机：避免同场重复，最多尝试 pool.length*2 次
    let tmpl = pool[Math.floor(Math.random() * pool.length)];
    let guard = 0;
    while (usedHighlightPhrases.has(type + '|' + tmpl) && guard < pool.length * 2) {
        tmpl = pool[Math.floor(Math.random() * pool.length)];
        guard++;
    }
    usedHighlightPhrases.add(type + '|' + tmpl);
    return String(tmpl)
        .replace(/\{name\}/g, name)
        .replace(/\{banker\}/g, bankerName !== undefined && bankerName !== null ? bankerName : '庄家')
        .replace(/\{score\}/g, score)
        .replace(/\{n\}/g, (n !== undefined && n !== null) ? n : score);
}

// 自定义JSON适配器：添加格式校验和默认内容（修复空文件报错）
class SafeJSONFile {
    constructor(filename) {
        this.source = filename;
    }
    
    async read() {
        try {
            // 先检查文件是否存在，不存在则创建
            if (!fs.existsSync(this.source)) {
                console.log(`文件 ${this.source} 不存在，创建空文件`);
                fs.writeFileSync(this.source, JSON.stringify({}), 'utf8');
                fs.chmodSync(this.source, 0o666); // 强制权限
                return {};
            }
            // 读取文件内容
            const data = fs.readFileSync(this.source, 'utf8').trim();
            // 空文件则写入空对象
            if (!data) {
                console.log(`文件 ${this.source} 为空，写入空对象`);
                fs.writeFileSync(this.source, JSON.stringify({}), 'utf8');
                return {};
            }
            // 解析JSON，失败则使用空对象
            return JSON.parse(data);
        } catch (error) {
            console.error(`解析 ${this.source} 失败，使用空对象`, error);
            fs.writeFileSync(this.source, JSON.stringify({}), 'utf8');
            fs.chmodSync(this.source, 0o666);
            return {};
        }
    }
    
    async write(data) {
        try {
            fs.writeFileSync(this.source, JSON.stringify(data, null, 2));
            fs.chmodSync(this.source, 0o666);
        } catch (error) {
            console.error(`写入 ${this.source} 失败:`, error);
        }
    }
}

// 初始化 lowdb 数据库（使用安全适配器）
const db = new Low(
    new SafeJSONFile('gameState.json'),
    {
        gameState: null,
        occupiedSeats: {},
        currentScoreItems: {},
        playerConnections: {}
    }
);
const logDb = new Low(
    new SafeJSONFile('gameLogs.json'),
    {
        logs: []
    }
);
// 历史结算数据库（持久化，不会被清除）
const settlementHistoryDb = new Low(
    new SafeJSONFile('settlementHistory.json'),
    {
        settlements: []
    }
);

// 注册用户数据库（持久化）：玩家账号 + 胜率统计的数据来源
const usersDb = new Low(
    new SafeJSONFile('users.json'),
    {
        users: []
    }
);

// 密码哈希（不设密码策略，但避免明文存储）
function hashPassword(pwd) {
    return crypto.createHash('sha256').update(String(pwd)).digest('hex');
}

// 自动生成用户ID：u0001、u0002 ...（基于当前最大序号递增）
function generateUserId(users) {
    let max = 0;
    users.forEach(u => {
        const m = /^u(\d+)$/.exec(u.userId || '');
        if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    });
    return 'u' + String(max + 1).padStart(4, '0');
}

// 校验用户身份（userId + password），返回用户对象或 null
async function verifyUser(userId, password) {
    if (!userId || !password) return null;
    await usersDb.read();
    const uid = String(userId).trim().toLowerCase();
    const u = (usersDb.data.users || []).find(x => x.userId === uid);
    if (!u) return null;
    if (u.password !== hashPassword(password)) return null;
    return u;
}

// 初始化数据库（添加权限设置）
(async () => {
    await db.read();
    await logDb.read();
    await settlementHistoryDb.read();
    await usersDb.read();
    if (!usersDb.data || !Array.isArray(usersDb.data.users)) {
        usersDb.data = { users: [] };
        await usersDb.write();
    }

    // 确保数据结构存在
    if (!db.data || Object.keys(db.data).length === 0) {
        db.data = {
            gameState: null,
            occupiedSeats: {},
            currentScoreItems: {},
            playerConnections: {}
        };
        await db.write();
    }
    
    // 服务器启动时恢复IP绑定的嘴子信息（仅在有实际游戏数据时保留）
    // 只有有历史记录或非零分数时才视为有游戏数据，playerOrder不算
    const hasHistory = db.data.gameState?.history?.length > 0;
    const hasNonZeroScore = db.data.gameState?.players?.some(p => p.score !== 0);
    const hasGameData = hasHistory || hasNonZeroScore;
    
    if (hasGameData && db.data.playerConnections && typeof db.data.playerConnections === 'object') {
        // 有游戏数据时，恢复IP绑定，玩家刷新页面可直接进入计分系统
        playerConnections = db.data.playerConnections;
        // 将所有玩家设为离线状态，等待重新连接
        for (let muzzle in playerConnections) {
            if (playerConnections[muzzle]) {
                playerConnections[muzzle].isOnline = false;
            }
        }
        console.log('🔄 已恢复IP绑定的嘴子信息，玩家可刷新页面恢复');
    } else {
        // 无游戏数据时，清除IP绑定和所有相关数据
        playerConnections = {};
        occupiedSeats = {};
        db.data.playerConnections = {};
        db.data.occupiedSeats = {};
        await db.write();
        console.log('🔄 无游戏数据，已清除IP绑定，玩家需重新选择嘴子');
    }
    
    // 加载 occupiedSeats 到内存
    if (db.data.occupiedSeats && typeof db.data.occupiedSeats === 'object') {
        occupiedSeats = db.data.occupiedSeats;
    }
    
    if (!logDb.data || !Array.isArray(logDb.data.logs)) {
        logDb.data = { logs: [] };
        await logDb.write();
    }

    // 初始化历史结算数据库
    if (!settlementHistoryDb.data || !Array.isArray(settlementHistoryDb.data.settlements)) {
        settlementHistoryDb.data = { settlements: [] };
        await settlementHistoryDb.write();
    }

    // 强制设置权限
    try {
        fs.chmodSync('gameState.json', 0o666);
        fs.chmodSync('gameLogs.json', 0o666);
        fs.chmodSync('settlementHistory.json', 0o666);
    } catch (error) {
        console.warn('设置文件权限时出错:', error);
    }
})();

// 嘴子名称映射
const MUZZLE_NAMES = {
    mozhang: '摸张',
    duying: '独赢', 
    dongfeng: '东风',
    erwu: '二五'
};

// 初始化玩家数据
function initializePlayers(playerOrder = ['mozhang', 'duying', 'erwu', 'dongfeng']) {
    return playerOrder.map((muzzle, index) => ({
        id: index + 1,
        name: MUZZLE_NAMES[muzzle],
        nickname: '',  // 自定义昵称，空字符串表示未设置
        score: 0,
        muzzleType: muzzle,
        isBanker: index === 0, // 第一个玩家为庄家
        continuousBankerCount: 0,
        isOnline: false,
        ipAddress: null,
        lastSeen: null,
        extraScore: 0,  // 庄家额外分：仅在自身为庄家时生效，非庄家时保留但不计算
        extraScoreRecord: null,  // 额外分设置记录 { playerName, score, time }
        extraScoreHistory: []  // 额外分设置历史记录 [{ playerName, score, time }]
    }));
}

// 存储玩家连接信息
let playerConnections = {};

// ==================== 计分服务器 (2525端口) ====================
const scoreServer = http.createServer((req, res) => {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ===== 管理端挂载：/admin 前缀转发到监控处理器（复用2525端口，免额外放行5252）=====
    if (req.url === '/admin' || req.url === '/admin/' || req.url.startsWith('/admin/')) {
        const sub = req.url.slice('/admin'.length);
        req.url = (sub === '' || sub === '/') ? '/' : sub;
        if (typeof monitorHandler === 'function') {
            monitorHandler(req, res);
        } else {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Monitor handler unavailable');
        }
        return;
    }

    // 处理API请求
    if (req.url === '/api/server-info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ips: localIPs,
            port: 2525
        }));
        return;
    }

    // ===== 用户注册/登录/胜率统计 API =====
    // 计算某用户的全部历史战绩（遍历结算历史，按 userId 关联）
    async function computeUserStats(userId) {
        await settlementHistoryDb.read();
        const settlements = settlementHistoryDb.data.settlements || [];
        let sessions = 0, winSessions = 0, totalRounds = 0, winRounds = 0, totalScore = 0;
        const details = [];
        for (const s of settlements) {
            const players = s.players || [];
            const myIndex = players.findIndex(p => p && p.userId === userId);
            if (myIndex === -1) continue;
            const me = players[myIndex];
            sessions++;
            const score = me.score || 0;
            totalScore += score;
            if (score > 0) winSessions++;
            // history 中的 winnerId 为 1-based 玩家编号，对应 players 中 id 字段（缺省用下标+1）
            const myId = (me.id != null) ? me.id : (myIndex + 1);
            const rounds = (s.history || []);
            const rTotal = rounds.length;
            const rWin = rounds.filter(r => r.winnerId === myId).length;
            totalRounds += rTotal;
            winRounds += rWin;
            details.push({
                id: s.id,
                timestamp: s.timestamp,
                duration: s.duration || '',
                muzzleType: me.muzzleType,
                score: score,
                totalRounds: rTotal,
                winRounds: rWin,
                remark: s.remark || ''
            });
        }
        return {
            userId,
            sessions, winSessions, totalRounds, winRounds, totalScore,
            // 场次维度：赢 = 该场结算分数>0；输 = 分数<=0
            loseSessions: sessions - winSessions,
            roundWinRate: totalRounds > 0 ? +(winRounds / totalRounds * 100).toFixed(1) : 0,
            sessionWinRate: sessions > 0 ? +(winSessions / sessions * 100).toFixed(1) : 0,
            details: details.reverse() // 最新的场次在前
        };
    }

    function readBody(req) {
        return new Promise((resolve, reject) => {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => resolve(body));
            req.on('error', reject);
        });
    }

    // 用户注册：昵称 + 密码，用户ID自动生成（注册成功即视为已登录）
    if (req.url === '/api/user/register' && req.method === 'POST') {
        (async () => {
            try {
                const body = await readBody(req);
                const data = JSON.parse(body || '{}');
                const nickname = String(data.nickname || '').trim();
                const password = String(data.password || '');
                if (!nickname || nickname.length > 20) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '昵称需为1-20个字符' }));
                    return;
                }
                if (!password) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '请设置密码' }));
                    return;
                }
                await usersDb.read();
                if (!Array.isArray(usersDb.data.users)) usersDb.data.users = [];
                // 昵称即账号，必须唯一
                if (usersDb.data.users.some(u => u.nickname === nickname)) {
                    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '该昵称已被注册' }));
                    return;
                }
                const userId = generateUserId(usersDb.data.users);
                const user = {
                    userId,
                    nickname,
                    password: hashPassword(password),
                    createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
                    lastLoginAt: new Date().toLocaleString('zh-CN', { hour12: false })
                };
                usersDb.data.users.push(user);
                await usersDb.write();
                console.log(`新用户注册: ${userId} (${nickname})`);
                const stats = await computeUserStats(userId);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                // 不含密码哈希返回前端
                res.end(JSON.stringify({
                    success: true,
                    user: { userId: user.userId, nickname: user.nickname, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt },
                    stats
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 用户登录：昵称 + 密码
    if (req.url === '/api/user/login' && req.method === 'POST') {
        (async () => {
            try {
                const body = await readBody(req);
                const data = JSON.parse(body || '{}');
                const nickname = String(data.nickname || '').trim();
                const password = String(data.password || '');
                await usersDb.read();
                const user = (usersDb.data.users || []).find(u => u.nickname === nickname);
                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '该昵称未注册' }));
                    return;
                }
                if (user.password !== hashPassword(password)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '密码错误' }));
                    return;
                }
                user.lastLoginAt = new Date().toLocaleString('zh-CN', { hour12: false });
                await usersDb.write();
                const stats = await computeUserStats(user.userId);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: true,
                    user: { userId: user.userId, nickname: user.nickname, createdAt: user.createdAt, lastLoginAt: user.lastLoginAt },
                    stats
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 修改用户名（昵称）：需校验密码
    if (req.url === '/api/user/update-nickname' && req.method === 'POST') {
        (async () => {
            try {
                const body = await readBody(req);
                const data = JSON.parse(body || '{}');
                const userId = String(data.userId || '').trim();
                const newNickname = String(data.nickname || '').trim();
                const password = String(data.password || '');
                if (!userId || !newNickname || newNickname.length > 20) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '参数不完整或昵称超长' }));
                    return;
                }
                await usersDb.read();
                const users = usersDb.data.users || [];
                const user = users.find(u => u.userId === userId);
                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '用户不存在' }));
                    return;
                }
                if (user.password !== hashPassword(password)) {
                    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '密码错误' }));
                    return;
                }
                if (users.some(u => u.nickname === newNickname && u.userId !== userId)) {
                    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '该昵称已被占用' }));
                    return;
                }
                user.nickname = newNickname;
                await usersDb.write();
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, user: { userId: user.userId, nickname: user.nickname } }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 通过用户ID重置昵称和密码（忘记账号功能）
    if (req.url === '/api/user/resetNickById' && req.method === 'POST') {
        (async () => {
            try {
                const body = await readBody(req);
                const data = JSON.parse(body || '{}');
                const userId = String(data.uid || data.userId || '').trim().toLowerCase();
                if (!userId) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '请输入用户ID' }));
                    return;
                }
                await usersDb.read();
                const users = usersDb.data.users || [];
                const user = users.find(u => u.userId === userId);
                if (!user) {
                    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '该用户ID不存在' }));
                    return;
                }
                // 重置：昵称=ID，密码=123456（sha256哈希）
                user.nickname = userId;
                user.password = hashPassword('123456');
                await usersDb.write();
                console.log(`用户重置: ${userId} 昵称已重置为ID，密码重置为123456`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, msg: '重置成功！昵称已改为' + userId + '，登录密码重置为123456' }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 用户战绩查询（支持任意 userId）
    if (req.url.startsWith('/api/user/stats')) {
        (async () => {
            try {
                const urlObj = new URL(req.url, 'http://localhost');
                const userId = (urlObj.searchParams.get('userId') || '').trim().toLowerCase();
                if (!userId) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: false, msg: '缺少 userId 参数' }));
                    return;
                }
                await usersDb.read();
                const user = (usersDb.data.users || []).find(u => u.userId === userId);
                const stats = await computeUserStats(userId);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: true,
                    user: user ? { userId: user.userId, nickname: user.nickname } : null,
                    stats
                }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 排行榜：所有注册用户的战绩汇总，可按 totalScore(总分) 或 winRate(胜率) 排序
    if (req.url.startsWith('/api/user/leaderboard')) {
        (async () => {
            try {
                const urlObj = new URL(req.url, 'http://localhost');
                const sortBy = urlObj.searchParams.get('sortBy') === 'winRate' ? 'winRate' : 'totalScore';
                await usersDb.read();
                const users = usersDb.data.users || [];
                const list = [];
                for (const u of users) {
                    const stats = await computeUserStats(u.userId);
                    list.push({
                        userId: u.userId,
                        nickname: u.nickname,
                        totalScore: stats.totalScore,
                        winRate: stats.roundWinRate,
                        winSessions: stats.winSessions,
                        loseSessions: stats.loseSessions,
                        totalRounds: stats.totalRounds,
                        winRounds: stats.winRounds,
                        sessions: stats.sessions
                    });
                }
                // 展示所有注册玩家（无对局记录者排在有记录者之后）
                const ranked = list;
                ranked.sort((a, b) => {
                    if (sortBy === 'winRate') {
                        const aHas = a.sessions > 0 ? 1 : 0, bHas = b.sessions > 0 ? 1 : 0;
                        if (aHas !== bHas) return bHas - aHas;
                        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
                        return b.totalScore - a.totalScore;
                    }
                    const aHas = a.sessions > 0 ? 1 : 0, bHas = b.sessions > 0 ? 1 : 0;
                    if (aHas !== bHas) return bHas - aHas;
                    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
                    return b.winRate - a.winRate;
                });
                // 附带两种维度的排名
                const byScore = [...ranked].sort((a, b) => b.totalScore - a.totalScore);
                const byRate = [...ranked].sort((a, b) => b.winRate - a.winRate);
                const scoreRankMap = {}, rateRankMap = {};
                byScore.forEach((x, i) => scoreRankMap[x.userId] = i + 1);
                byRate.forEach((x, i) => rateRankMap[x.userId] = i + 1);
                ranked.forEach(x => {
                    x.rankByScore = scoreRankMap[x.userId];
                    x.rankByWinRate = rateRankMap[x.userId];
                    x.rank = sortBy === 'winRate' ? x.rankByWinRate : x.rankByScore;
                });
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, sortBy, list: ranked }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        })();
        return;
    }

    // 更新结算备注（对已有结算记录）
    if (req.url === '/api/update-settlement-remark' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                await settlementHistoryDb.read();
                const settlements = settlementHistoryDb.data.settlements || [];
                const record = settlements.find(s => s.id === data.id);
                if (record) {
                    record.remark = (data.remark || '').trim().substring(0, 200);
                    await settlementHistoryDb.write();
                    // 向所有已连接的客户端同步更新后的历史结算数据
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'settlement_history_sync',
                                settlements: settlements
                            }));
                        }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, msg: '未找到结算记录' }));
                }
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        });
        return;
    }

    // 获取历史结算数据API（计分服务器）
    if (req.url === '/api/settlement-history') {
        (async () => {
            await settlementHistoryDb.read();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                settlements: settlementHistoryDb.data.settlements || []
            }));
        })();
        return;
    }

    // 删除结算记录API（监控端）
    if (req.url === '/api/delete-settlement' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                await settlementHistoryDb.read();
                const settlements = settlementHistoryDb.data.settlements || [];
                const index = settlements.findIndex(s => s.id === data.id);
                if (index !== -1) {
                    settlements.splice(index, 1);
                    settlementHistoryDb.data.settlements = settlements;
                    await settlementHistoryDb.write();
                    // 向所有已连接的客户端同步删除后的历史结算数据
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'settlement_history_sync',
                                settlements: settlements
                            }));
                        }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, msg: '未找到结算记录' }));
                }
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        });
        return;
    }

    // 获取当前分值模式
    if (req.url === '/api/scoring-mode') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: currentScoringMode, config: SCORING_CONFIG }));
        return;
    }

    // 切换分值模式
    if (req.url.startsWith('/api/set-scoring-mode')) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const mode = urlObj.searchParams.get('mode');
        if (mode === '13' || mode === '25') {
            currentScoringMode = mode;
            SCORING_CONFIG = SCORING_MODES[currentScoringMode];
            // 广播给所有已连接的WebSocket客户端
            wss.clients.forEach(function each(client) {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({ type: 'scoringModeChanged', mode: currentScoringMode, config: SCORING_CONFIG }));
                }
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, mode: currentScoringMode, config: SCORING_CONFIG }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '无效的模式' }));
        }
        return;
    }
    
    // 独立启动器页面（内置服务器地址，失败后可手动输入）
    if (req.url === '/launch.html' || req.url === '/launch') {
        fs.readFile(path.join(__dirname, 'launch.html'), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading launch.html');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(data);
        });
        return;
    }

    // 处理根路径请求 - 返回计分页面
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading index.html');
                return;
            }
            res.writeHead(200, { 
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            });
            res.end(data);
        });
    } else if (req.url === '/manifest.json') {
        // PWA 应用清单
        fs.readFile(path.join(__dirname, 'manifest.json'), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
            res.end(data);
        });
    } else if (req.url === '/sw.js') {
        // PWA Service Worker
        fs.readFile(path.join(__dirname, 'sw.js'), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            res.end(data);
        });
    } else if (req.url === '/icon.svg') {
        // PWA 应用图标
        fs.readFile(path.join(__dirname, 'icon.svg'), (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
            res.end(data);
        });
    } else if (req.url.startsWith('/api/highlight-phrases')) {
        // 高光播报词库查看/学习接口（支持联网学习扩展词库）
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ phrases: HIGHLIGHT_PHRASES, autoLearn: true }));
            return;
        }
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    let added = 0;
                    if (data && typeof data === 'object') {
                        Object.keys(data).forEach(k => {
                            if (Array.isArray(data[k]) && data[k].length > 0) {
                                if (!HIGHLIGHT_PHRASES[k]) HIGHLIGHT_PHRASES[k] = [];
                                data[k].forEach(p => {
                                    if (typeof p === 'string' && p.trim() && !HIGHLIGHT_PHRASES[k].includes(p)) {
                                        HIGHLIGHT_PHRASES[k].push(p);
                                        added++;
                                    }
                                });
                            }
                        });
                        // 持久化到 highlight_phrases.json（联网学习的记忆）
                        try {
                            fs.writeFileSync(path.join(__dirname, 'highlight_phrases.json'), JSON.stringify(HIGHLIGHT_PHRASES, null, 2));
                        } catch (e) {}
                        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ ok: true, added, total: Object.keys(HIGHLIGHT_PHRASES).reduce((s, k) => s + HIGHLIGHT_PHRASES[k].length, 0) }));
                    } else {
                        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                        res.end(JSON.stringify({ error: 'body需为对象，值为短语数组' }));
                    }
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'JSON解析失败' }));
                }
            });
            return;
        }
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method Not Allowed' }));
        return;
    } else if (req.url.startsWith('/api/tts')) {
        // TTS 语音合成端点 - 默认角色走缓存，非默认角色在线生成不缓存
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const text = urlObj.searchParams.get('text') || '';
        const voice = urlObj.searchParams.get('voice') || 'zh-CN-XiaoxiaoNeural';
        const rate = urlObj.searchParams.get('rate') || '1.0';
        if (!text) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing text parameter');
            return;
        }

        // 确保 tts_cache 目录存在
        const ttsCacheDir = path.join(__dirname, 'tts_cache');
        if (!fs.existsSync(ttsCacheDir)) {
            fs.mkdirSync(ttsCacheDir, { recursive: true });
        }

        const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
        const DEFAULT_RATE = '1.0';
        const isDefaultVoice = (voice === DEFAULT_VOICE && rate === DEFAULT_RATE);

        // 缓存文件名规范化（默认角色所有文本都缓存：收入/支出用固定名，其他如高光短语用文本hash名）
        let cacheFile = null;
        if (isDefaultVoice) {
            const incomeMatch = text.match(/^收入(\d+)$/);
            const expenseMatch = text.match(/^支出(\d+)$/);
            if (incomeMatch) {
                cacheFile = path.join(ttsCacheDir, `in-${incomeMatch[1]}.mp3`);
            } else if (expenseMatch) {
                cacheFile = path.join(ttsCacheDir, `out-${expenseMatch[1]}.mp3`);
            } else {
                // 高光短语等任意文本也缓存（hash 命名），确保多名玩家同时收到同一语音时快速复用
                cacheFile = path.join(ttsCacheDir, `t-${ttsHash(text)}.mp3`);
            }
        }

        // 默认角色 + 缓存命中：直接返回
        if (cacheFile && fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
            const stat = fs.statSync(cacheFile);
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
            fs.createReadStream(cacheFile).pipe(res);
            return;
        }

        // 并发去重：同一文本（voice+rate+text）并发请求只生成一次，其余等待复用
        const ttsKey = voice + '|' + rate + '|' + text;
        const ttsWaiters = [];
        if (pendingTTS[ttsKey]) {
            pendingTTS[ttsKey].waiters.push(res);
            return;
        }
        pendingTTS[ttsKey] = { waiters: ttsWaiters };

        // 在线生成
        const ratePercent = Math.round((parseFloat(rate) - 1) * 100);
        const rateArg = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;
        const { exec } = require('child_process');
        const safeText = text.replace(/"/g, '\\"');

        // 输出文件：默认角色写入缓存，非默认角色写临时文件（播报后自动清理）
        const outputFile = cacheFile || path.join(ttsCacheDir, `tmp_${Date.now()}.mp3`);
        const cmd = `python -m edge_tts --text "${safeText}" --voice "${voice}" --rate "${rateArg}" --write-media "${outputFile}" 2>/dev/null`;

        // 传递代理环境变量给 edge-tts
        const proxyEnv = {
            ...process.env,
            PATH: process.env.PATH
        };
        if (process.env.HTTP_PROXY) proxyEnv.HTTP_PROXY = process.env.HTTP_PROXY;
        if (process.env.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;
        if (process.env.http_proxy) proxyEnv.http_proxy = process.env.http_proxy;
        if (process.env.https_proxy) proxyEnv.https_proxy = process.env.https_proxy;

        let retryCount = 0;
        const maxRetries = 1;

        function respondFile(_res, _file) {
            if (_file && fs.existsSync(_file) && fs.statSync(_file).size > 0) {
                const stat = fs.statSync(_file);
                _res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': stat.size, 'Cache-Control': 'public, max-age=86400' });
                fs.createReadStream(_file).pipe(_res);
                return true;
            }
            return false;
        }

        function respondWaiters(ok) {
            // 通知同一文本的并发等待者（全部返回同一音频或失败）
            const p = pendingTTS[ttsKey];
            if (!p) return;
            delete pendingTTS[ttsKey];
            p.waiters.forEach(function (w) {
                if (ok && cacheFile) {
                    if (!respondFile(w, cacheFile)) {
                        w.writeHead(500, { 'Content-Type': 'text/plain' });
                        w.end('TTS generation failed');
                    }
                } else {
                    w.writeHead(500, { 'Content-Type': 'text/plain' });
                    w.end('TTS generation failed');
                }
            });
        }

        function tryGenerate() {
            exec(cmd, { timeout: 30000, env: proxyEnv }, (err) => {
                if (!err && outputFile && fs.existsSync(outputFile) && fs.statSync(outputFile).size > 0) {
                    // 当前请求者
                    respondFile(res, outputFile);
                    // 并发等待者复用
                    respondWaiters(true);
                    // 非默认角色：播报完后删除临时文件，不保留
                    if (!cacheFile) {
                        res.on('finish', () => {
                            fs.unlink(outputFile, () => {});
                        });
                    }
                    return;
                }
                if (retryCount < maxRetries) {
                    retryCount++;
                    setTimeout(tryGenerate, 2000);
                    return;
                }
                // 最终失败，静默返回 500
                respondWaiters(false);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('TTS generation failed');
            });
        }
        tryGenerate();

    } else if (req.url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// ==================== 监控处理器（同时挂载于 5252 端口与 2525 /admin 路径）====================
// 提取为具名函数（函数声明提升），使 2525 主服务可将 /admin 前缀请求转发至此
function monitorHandler(req, res) {
    // 设置CORS头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理预检请求
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // 根路由：返回监控页面
    if (req.url === '/' || req.url === '/monitor.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateMonitorPage());
        return;
    }
    
    // 监控API接口
    if (req.url === '/api/monitor/logs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            logs: logDb.data.logs || []
        }));
        return;
    }

    // 获取历史结算数据API
    if (req.url === '/api/settlement-history') {
        (async () => {
            await settlementHistoryDb.read();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                settlements: settlementHistoryDb.data.settlements || []
            }));
        })();
        return;
    }

    // 删除结算记录API（监控端）
    if (req.url === '/api/delete-settlement' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                await settlementHistoryDb.read();
                const settlements = settlementHistoryDb.data.settlements || [];
                const index = settlements.findIndex(s => s.id === data.id);
                if (index !== -1) {
                    settlements.splice(index, 1);
                    settlementHistoryDb.data.settlements = settlements;
                    await settlementHistoryDb.write();
                    // 向所有已连接的客户端同步删除后的历史结算数据
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'settlement_history_sync',
                                settlements: settlements
                            }));
                        }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, msg: '未找到结算记录' }));
                }
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        });
        return;
    }
    
    // 更新结算备注（监控端）
    if (req.url === '/api/update-settlement-remark' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                await settlementHistoryDb.read();
                const settlements = settlementHistoryDb.data.settlements || [];
                const record = settlements.find(s => s.id === data.id);
                if (record) {
                    record.remark = (data.remark || '').trim().substring(0, 200);
                    await settlementHistoryDb.write();
                    // 向所有已连接的客户端同步更新后的历史结算数据
                    wss.clients.forEach(client => {
                        if (client.readyState === 1) {
                            client.send(JSON.stringify({
                                type: 'settlement_history_sync',
                                settlements: settlements
                            }));
                        }
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, msg: '未找到结算记录' }));
                }
            } catch(e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, msg: e.message }));
            }
        });
        return;
    }
    
    if (req.url === '/api/monitor/players') {
        const players = db.data.gameState?.players || [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            players: players.map(p => ({
                ...p,
                connectionInfo: playerConnections[p.muzzleType] || null
            }))
        }));
        return;
    }
    
    if (req.url === '/api/monitor/game-state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            gameState: db.data.gameState,
            playerConnections,
            onlinePlayers: Object.keys(playerConnections).filter(muzzle => 
                playerConnections[muzzle]?.isOnline
            ),
            gameStartTime: gameStartTime
        }));
        return;
    }
    
    // 清除数据API
    if (req.url === '/api/monitor/clear-data' && req.method === 'POST') {
        (async () => {
            // 解析请求体
            let body = '';
            req.on('data', chunk => {
                body += chunk.toString();
            });
            
            req.on('end', async () => {
                try {
                    const clearData = JSON.parse(body) || {};
                    
                    // 重置游戏状态 - 保存干净的初始状态
                    const cleanGameState = {
                        players: initializePlayers(['mozhang', 'duying', 'dongfeng', 'erwu']),
                        history: [],
                        playerOrder: ['mozhang', 'duying', 'dongfeng', 'erwu'],
                        manualAdjustments: [],
                        guests: [],
                        currentScoreItems: {
                            mozhang: false,
                            duying: false,
                            dongfeng: false,
                            erwu: 0,
                            qiliang: false,
                            zimo: false
                        },
                        currentWinner: null
                    };
                    db.data.gameState = cleanGameState;
                    db.data.occupiedSeats = {};
                    db.data.currentScoreItems = cleanGameState.currentScoreItems;
                    db.data.playerConnections = {};
                    await db.write();
                    
                    // 更新全局引用（两个变量都更新，确保一致）
                    currentGameState = cleanGameState;
                    gameState = cleanGameState;
                    
                    // 重置日志数据库
                    logDb.data = { logs: [] };
                    await logDb.write();
                    
                    // 彻底删除所有数据文件和日志文件，然后重新创建
                    const filesToClean = ['gameLogs.log', 'gameState.json', 'gameLogs.json'];
                    for (const file of filesToClean) {
                        try {
                            if (fs.existsSync(file)) {
                                fs.unlinkSync(file);
                            }
                        } catch (e) {
                            console.error(`删除文件 ${file} 失败:`, e.message);
                        }
                    }
                    
                    // 重新写入干净的数据库文件
                    db.data = {
                        gameState: cleanGameState,
                        occupiedSeats: {},
                        currentScoreItems: cleanGameState.currentScoreItems,
                        playerConnections: {}
                    };
                    await db.write();
                    
                    logDb.data = { logs: [] };
                    await logDb.write();
                    
                    // 确保文件权限
                    try {
                        fs.chmodSync('gameState.json', 0o666);
                        fs.chmodSync('gameLogs.json', 0o666);
                    } catch (e) {
                        // 忽略权限错误
                    }
                    
                    // 设置数据清除标志，阻止新连接自动绑定
                    dataClearedFlag = true;
                    
                    // 重置内存中的数据
                    gameOrder = null;
                    playerCount = 0;
                    onlinePlayers = {};
                    occupiedSeats = {};
                    playerConnections = {};
                    recentScoreUpdates = [];
                    // 重置结算投票状态
                    settlementVoting.isActive = false;
                    settlementVoting.votes = {};
                    settlementVoting.initiator = null;
                    
                    // 清除服务器输出，只保留二维码和访问地址
                    console.log('\n'.repeat(100));
                    
                    // 重新输出启动信息和二维码
                    
                    console.log('🎉 欢迎使用嘴子计分器至尊版');
                    
                    const scoreUrl = `http://${primaryIP}:2525`;
                    console.log(`📱 计分系统访问地址: ${scoreUrl}`);
                    
                    // 生成二维码
                    if (QRCodeTerminal) {
                        
                        QRCodeTerminal.generate(scoreUrl, { small: true });
                    }
                    console.log('─'.repeat(50));
                    
                    // 通知所有客户端数据已清除，需要刷新并回到初始化界面
                    broadcast({
                        type: 'data_cleared',
                        msg: '游戏数据已被管理员清除，请刷新页面重新开始'
                    });
                    
                    // 关闭所有客户端WebSocket连接，强制客户端重新连接
                    clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client._dataCleared = true; // 标记为数据清除导致的关闭
                            client.close(1000, 'Data cleared by admin');
                        }
                    });
                    clients = [];
                    
                    // 重新读取数据库，确保状态正确
                    await db.read();
                    await logDb.read();
                    
                    // 发送空的游戏状态，确保客户端立即获取最新状态
                    broadcast({
                        type: 'full_state',
                        state: {
                            players: initializePlayers(['mozhang', 'duying', 'dongfeng', 'erwu']),
                            history: [],
                            playerOrder: ['mozhang', 'duying', 'dongfeng', 'erwu'],
                            manualAdjustments: [],
                            guests: [],
                            currentScoreItems: {
                                mozhang: false,
                                duying: false,
                                dongfeng: false,
                                erwu: 0,
                                qiliang: false,
                                zimo: false
                            },
                            currentWinner: null
                        },
                        onlinePlayers,
                        occupiedSeats,
                        currentScoreItems: {
                            mozhang: false,
                            duying: false,
                            dongfeng: false,
                            erwu: 0,
                            qiliang: false,
                            zimo: false
                        },
                        gameOrder: ['mozhang', 'duying', 'dongfeng', 'erwu']
                    });
                    
                    // 数据清除完成，但不立即重置标志
                    // 标志将在第一个客户端成功发送 join 消息后重置
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    
                    // 检查是否需要关闭或重启服务器
                    if (clearData.shutdown) {
                        console.log('收到关闭服务器请求，1秒后关闭');
                        setTimeout(() => {
                            process.exit(0);
                        }, 1000);
                    } else if (clearData.restart) {
                        console.log('收到重启服务器请求，1秒后重启');
                        setTimeout(() => {
                            process.exit(1); // 退出码1表示需要重启
                        }, 1000);
                    }
                } catch (error) {
                    console.error('处理清除数据请求失败:', error);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
            });
        })();
        return;
    }
    
    // 导出数据API
    if (req.url === '/api/monitor/export-data' && req.method === 'GET') {
        (async () => {
            await db.read();
            await logDb.read();
            
            // 生成CSV格式数据
            let csvContent = '';
            
            // 添加导出时间
            csvContent += `导出时间,${new Date().toLocaleString('zh-CN')}\n\n`;
            
            // 添加玩家数据
            csvContent += '=== 玩家数据 ===\n';
            csvContent += 'ID,名称,分数,嘴子类型,在线状态\n';
            
            if (db.data.gameState && db.data.gameState.players) {
                // 按总分从高到低排序
                const sortedPlayers = [...db.data.gameState.players].sort((a, b) => b.score - a.score);
                
                sortedPlayers.forEach(player => {
                    csvContent += `${player.id},${player.name},${player.score},${player.muzzleType},${player.isOnline ? '在线' : '离线'}\n`;
                });
            }
            
            csvContent += '\n=== 游戏统计 ===\n';
            csvContent += '项目,值\n';
            
            // 计算总局数
            const totalRounds = db.data.gameState?.history?.filter(record => !record.type).length || 0;
            csvContent += `总局数,${totalRounds}\n`;
            
            // 添加历史记录
            csvContent += '\n=== 历史记录 ===\n';
            csvContent += '局数,类型,赢家,庄家,时间,详情\n';
            
            if (db.data.gameState && db.data.gameState.history) {
                db.data.gameState.history.forEach(record => {
                    // 台费记录仅在历史记录/计分详情中区分展示，不导出到CSV
                    if (record.type === 'tableFee') return;
                    let round = record.round || '';
                    let type = record.type || '对局';
                    let winner = '';
                    let banker = '';
                    let time = record.timestamp || '';
                    let details = '';
                    
                    if (db.data.gameState.players) {
                        if (record.winnerId) {
                            const winnerPlayer = db.data.gameState.players.find(p => p.id === record.winnerId);
                            winner = winnerPlayer?.name || '未知';
                        }
                        if (record.bankerId) {
                            const bankerPlayer = db.data.gameState.players.find(p => p.id === record.bankerId);
                            banker = bankerPlayer?.name || '未知';
                        }
                    }
                    
                    if (record.playerPayments) {
                        details = record.playerPayments.map(payment => {
                            const player = db.data.gameState.players.find(p => p.id === payment.id);
                            return `${player?.name || '未知'}: ${-payment.amount}`;
                        }).join('; ');
                    }
                    
                    csvContent += `${round},${type},${winner},${banker},${time},${details}\n`;
                });
            }
            
            // 添加日志记录 - 仅输出对局详情
            csvContent += '\n=== 对局日志 ===\n';
            csvContent += '时间,消息\n';
            
            if (logDb.data.logs) {
                // 只输出对局详情（包含"第"字符的日志）
                const gameLogs = logDb.data.logs.filter(log => log.message.includes('第'));
                
                gameLogs.forEach(log => {
                    csvContent += `${log.timestamp},${log.message}\n`;
                });
            }
            
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename=game-data-export.csv'
            });
            res.end(csvContent);
        })();
        return;
    }
    
    // 控制页面
    if (req.url === '/control' || req.url === '/control.html') {
        fs.readFile(path.join(__dirname, 'control.html'), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Control page not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // 启动服务器脚本 API
    if (req.url === '/api/server/start' && req.method === 'GET') {
        try {
            if (runningProcesses['server'] && !runningProcesses['server'].killed) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: '服务器已在运行中' }));
                return;
            }
            const { spawn } = require('child_process');
            const child = spawn('node', ['server.js'], {
                cwd: __dirname,
                detached: true,
                stdio: 'ignore'
            });
            child.unref();
            runningProcesses['server'] = child;
            console.log('服务器已启动, PID:', child.pid);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: '服务器启动成功', pid: child.pid }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: '启动失败: ' + e.message }));
        }
        return;
    }

    // 查询服务器状态 API
    if (req.url === '/api/server/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            'server': runningProcesses['server'] && !runningProcesses['server'].killed
        }));
        return;
    }
    
    // 监控页面
    if (req.url === '/' || req.url === '/monitor.html') {
        fs.readFile(path.join(__dirname, 'monitor.html'), (err, data) => {
            if (err) {
                // 如果监控页面不存在，返回默认监控页面
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(generateMonitorPage());
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
}

// 监控服务器仍监听 5252（若安全组放行可直接访问）；2525 的 /admin 路径亦可访问
const monitorServer = http.createServer(monitorHandler);

// 生成监控页面
function generateMonitorPage() {
    var html = '';

    // ====== CSS ======
    html += '<!DOCTYPE html>\n';
    html += '<html lang="zh-CN">\n';
    html += '<head>\n';
    html += '<meta charset="UTF-8">\n';
    html += '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">\n';
    html += '<title>麻将计分监控系统</title>\n';
    html += '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">\n';
    html += '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>\n';
    html += '<style>\n';
    html += '* { margin:0; padding:0; box-sizing:border-box; font-family:"Segoe UI","Microsoft YaHei",sans-serif; -webkit-tap-highlight-color:transparent; }\n';
    html += '*:focus, *:active { outline:none !important; box-shadow:none !important; }\n';
    html += 'body { background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%); color:#fff; min-height:100vh; overflow-y:auto; padding:10px 15px; }\n';
    html += '.container { max-width:900px; margin:0 auto; }\n';
    html += '.header { display:flex; align-items:center; justify-content:space-between; padding:10px 18px; background:rgba(255,255,255,0.1); border-radius:12px; backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,0.2); margin-bottom:10px; cursor:pointer; }\n';
    html += '.header-left { display:flex; align-items:center; gap:10px; }\n';
    html += '.header h1 { font-size:1.4rem; background:linear-gradient(90deg,#4cc9f0,#4361ee); -webkit-background-clip:text; -webkit-text-fill-color:transparent; white-space:nowrap; }\n';
    html += '.header-actions { display:flex; align-items:center; gap:10px; }\n';
    html += '.icon-btn { background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#ff6363; width:34px; height:34px; border-radius:8px; display:flex; align-items:center; justify-content:center; cursor:pointer; font-size:0.9rem; transition:all 0.2s ease; }\n';
    html += '.icon-btn:hover { background:rgba(255,99,99,0.2); border-color:#ff6363; }\n';
    html += '.card { background:rgba(255,255,255,0.1); border-radius:12px; padding:12px 15px; backdrop-filter:blur(10px); border:1px solid rgba(255,255,255,0.2); margin-bottom:10px; }\n';
    html += '.card-title { display:flex; align-items:center; justify-content:space-between; padding-bottom:8px; border-bottom:1px solid rgba(255,255,255,0.1); cursor:pointer; user-select:none; }\n';
    html += '.card-title h2 { font-size:1rem; display:flex; align-items:center; gap:8px; color:#e0e0e0; }\n';
    html += '.card-title h2 i { color:#4cc9f0; font-size:0.85rem; }\n';
    html += '.card-title h2::after { content:"\\f078"; font-family:"Font Awesome 6 Free"; font-weight:900; font-size:0.6rem; margin-left:6px; transition:transform 0.3s ease; display:inline-block; color:#8a8aff; }\n';
    html += '.card-title.collapsed h2::after { transform:rotate(-90deg); }\n';
    html += '.card-title.no-heading h2::after { display:none; }\n';
    html += '.status-badge { padding:2px 10px; border-radius:12px; font-size:0.75rem; font-weight:600; background:rgba(76,201,240,0.2); color:#4cc9f0; border:1px solid #4cc9f0; }\n';
    html += '.card-body { display:none; padding-top:10px; }\n';
    html += '.card-body.expanded, .card-body.tabbed-body.expanded { display:block; }\n';
    html += '.card-body.tabbed-body { height:340px; }\n';
    html += '.card-body::-webkit-scrollbar { width:4px; }\n';
    html += '.card-body::-webkit-scrollbar-track { background:rgba(255,255,255,0.05); border-radius:10px; }\n';
    html += '.card-body::-webkit-scrollbar-thumb { background:rgba(76,201,240,0.4); border-radius:10px; }\n';
    html += '.tab-content { display:none; height:100%; }\n';
    html += '.tab-content.active { display:flex; flex-direction:column; height:100%; }\n';
    html += '.player-data-container { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; height:100%; width:100%; }\n';
    html += '.player-data { background:rgba(255,255,255,0.05); border-radius:10px; padding:10px 8px 6px; display:flex; flex-direction:column; justify-content:center; align-items:center; min-width:0; height:100%; }\n';
    html += '.player-avatar { width:40px; height:40px; border-radius:50%; margin-bottom:6px; display:flex; align-items:center; justify-content:center; font-size:1rem; color:white; position:relative; flex-shrink:0; }\n';
    html += '.player-avatar.banker { box-shadow:0 0 0 2px #ffd700, 0 0 10px rgba(255,215,0,0.4); }\n';
    html += '.banker-tag { position:absolute; bottom:-4px; left:50%; transform:translateX(-50%); background:#ffd700; color:#1a1a2e; font-size:0.45rem; font-weight:700; padding:0 3px; border-radius:3px; line-height:1.3; white-space:nowrap; }\n';
    html += '.player-avatar.mozhang { background:linear-gradient(135deg,#ffeb3b,#fbc02d); }\n';
    html += '.player-avatar.duying { background:linear-gradient(135deg,#e91e63,#c2185b); }\n';
    html += '.player-avatar.dongfeng { background:linear-gradient(135deg,#2196f3,#1976d2); }\n';
    html += '.player-avatar.erwu { background:linear-gradient(135deg,#4caf50,#388e3c); }\n';
    html += '.player-name { font-weight:700; font-size:0.85rem; margin-bottom:4px; text-align:center; }\n';
    html += '.player-stats { display:grid; grid-template-columns:1fr 1fr; gap:4px; width:100%; }\n';
    html += '.player-stat-item { text-align:center; padding:3px 2px; background:rgba(255,255,255,0.05); border-radius:4px; }\n';
    html += '.player-stat-value { font-size:0.85rem; font-weight:700; margin-bottom:1px; }\n';
    html += '.player-stat-label { font-size:0.65rem; color:#8a8aff; }\n';
    html += '.game-stats-container { display:grid; grid-template-columns:repeat(2,1fr); grid-template-rows:repeat(3,1fr); gap:10px; height:100%; width:100%; }\n';
    html += '.game-stat-item { text-align:center; background:rgba(255,255,255,0.05); border-radius:10px; display:flex; flex-direction:column; justify-content:center; align-items:center; height:100%; }\n';
    html += '.game-stat-value { font-size:1.1rem; font-weight:700; margin:3px 0; }\n';
    html += '.game-stat-label { font-size:0.7rem; color:#8a8aff; }\n';
    html += '.game-stat-player { font-size:0.7rem; color:#4cc9f0; margin-top:2px; }\n';
    html += '.log-item { padding:8px 10px; margin-bottom:6px; background:rgba(255,255,255,0.05); border-radius:6px; border-left:3px solid #4cc9f0; animation:fadeIn 0.3s ease; }\n';
    html += '.log-item.manual { border-left-color:#ffb300; }\n';
    html += '.log-item.undo { border-left-color:#ff6363; }\n';
    html += '.log-item.zimo { position:relative; overflow:hidden; border-left-color:#ff0000; }\n';
    html += '.log-item.zimo::after { content:"自摸"; position:absolute; right:-5px; top:50%; transform:translateY(-50%) rotate(-15deg); font-size:1.2rem; font-weight:900; color:rgba(255,0,0,0.2); pointer-events:none; white-space:nowrap; }\n';
    html += '.log-line { font-size:0.8rem; line-height:1.5; }\n';
    html += '.log-line1 { font-weight:600; color:#e0e0e0; }\n';
    html += '.log-line2 { color:#b0b0d0; margin-top:2px; }\n';
    html += '.log-line3 { color:#8a8aff; font-size:0.7rem; margin-top:2px; }\n';
    html += '.log-time { font-size:0.65rem; color:#666; margin-top:3px; }\n';

    html += '.tab-bar { display:flex; gap:6px; }\n';
    html += '.tab-btn { padding:6px 16px; border:none; border-radius:8px; background:rgba(255,255,255,0.08); color:#aaa; font-size:0.85rem; font-weight:600; cursor:pointer; outline:none; -webkit-tap-highlight-color:transparent; }\n';
    html += '.tab-btn:hover { background:rgba(255,255,255,0.15); color:#fff; }\n';
    html += '.tab-btn.active { background:linear-gradient(90deg,#4361ee,#4cc9f0); color:#fff; }\n';
    html += '.tab-btn:focus, .tab-btn:active { outline:none; box-shadow:none; }\n';
    html += '.tab-content { display:none; }\n';
    html += '@keyframes fadeIn { from{opacity:0;transform:translateY(5px);} to{opacity:1;transform:translateY(0);} }\n';
    html += '.settlement-list-item { background:rgba(255,255,255,0.06); border-radius:10px; padding:10px 12px; margin-bottom:8px; cursor:pointer; transition:all 0.2s ease; border:1px solid rgba(255,255,255,0.1); }\n';
    html += '.settlement-list-item:hover { background:rgba(255,255,255,0.1); transform:translateX(3px); border-color:rgba(76,201,240,0.4); }\n';
    html += '.settlement-delete-btn:hover { color:#ff6b6b !important; }\n';
    html += '.settlement-list-header { margin-bottom:4px; }\n';
    html += '.settlement-list-time { font-size:0.72rem; color:#aaa; }\n';
    html += '.settlement-list-duration { font-size:0.72rem; color:#aaa; }\n';
    html += '.settlement-list-rounds { background:rgba(76,201,240,0.15); color:#4cc9f0; padding:2px 8px; border-radius:10px; font-size:0.7rem; font-weight:600; display:inline-block; margin-top:3px; }\n';
    html += '.settlement-list-scores { display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:0.8rem; margin-bottom:4px; }\n';
    html += '.settlement-list-score-item { display:flex; justify-content:space-between; align-items:center; padding:3px 8px; background:rgba(255,255,255,0.04); border-radius:6px; }\n';
    html += '.settlement-list-score-name { color:#ccc; font-size:0.75rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:120px; }\n';
    html += '.settlement-list-score-val { font-weight:600; }\n';
    html += '.settlement-list-score-val.win { color:#ff6b6b; }\n';
    html += '.settlement-list-score-val.lose { color:#51cf66; }\n';
    html += '.settlement-list-extra { margin-top:4px; padding:4px 8px; background:rgba(255,212,59,0.08); border-radius:6px; }\n';
    html += '.settlement-list-extra-item { font-size:0.7rem; color:#ffd43b; padding:1px 0; }\n';
    html += '.settlement-list-remark { margin-top:6px; padding:5px 8px; background:rgba(76,201,240,0.08); border-radius:6px; font-size:0.72rem; color:#4cc9f0; }\n';
    html += '.no-settlement { text-align:center; padding:30px 10px; color:#666; font-size:0.9rem; }\n';
    html += '.no-settlement i { font-size:2.5rem; margin-bottom:10px; opacity:0.5; display:block; }\n';
    html += '.detail-modal { position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:9999; display:flex; align-items:center; justify-content:center; padding:15px; }\n';
    html += '.detail-modal-content { background:#1a1a2e; border-radius:14px; width:100%; max-width:520px; max-height:85vh; overflow:hidden; border:1px solid rgba(255,255,255,0.1); }\n';
    html += '.detail-modal-header { background:linear-gradient(90deg,#4361ee,#4cc9f0); padding:14px 18px; display:flex; justify-content:space-between; align-items:center; }\n';
    html += '.detail-modal-header h3 { font-size:1rem; margin:0; }\n';
    html += '.detail-modal-close { background:rgba(255,255,255,0.2); border:none; color:white; width:32px; height:32px; border-radius:50%; cursor:pointer; font-size:1.1rem; display:flex; align-items:center; justify-content:center; }\n';
    html += '.detail-modal-tabs { display:flex; background:rgba(255,255,255,0.05); padding:4px; gap:4px; }\n';
    html += '.detail-tab-btn { flex:1; padding:8px; border:none; border-radius:6px; background:transparent; color:#888; font-size:0.8rem; font-weight:500; cursor:pointer; }\n';
    html += '.detail-tab-btn.active { background:rgba(255,255,255,0.1); color:#4cc9f0; font-weight:600; }\n';
    html += '.detail-tab-panel { display:none; max-height:calc(85vh - 110px); overflow-y:auto; padding:12px 14px; }\n';
    html += '.detail-tab-panel.active { display:block; }\n';
    html += '.detail-stat-card { background:rgba(255,255,255,0.05); border-radius:10px; padding:10px 12px; margin-bottom:8px; border:1px solid rgba(255,255,255,0.08); }\n';
    html += '.detail-stat-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; }\n';
    html += '.detail-stat-name { font-weight:600; font-size:0.9rem; }\n';
    html += '.detail-stat-score { font-weight:700; font-size:0.95rem; }\n';
    html += '.detail-stat-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:6px; }\n';
    html += '.detail-stat-item { text-align:center; background:rgba(255,255,255,0.04); border-radius:6px; padding:6px 2px; }\n';
    html += '.detail-stat-item-val { font-size:0.85rem; font-weight:700; margin-bottom:2px; }\n';
    html += '.detail-stat-item-label { font-size:0.65rem; color:#888; }\n';
    html += '.detail-chart-container { position:relative; height:260px; background:rgba(255,255,255,0.03); border-radius:8px; padding:8px; margin-bottom:10px; }\n';
    html += '.detail-chart-picker { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:10px; }\n';
    html += '.chart-chip { padding:4px 10px; border-radius:15px; cursor:pointer; font-size:0.75rem; font-weight:600; border:2px solid; transition:all 0.2s; }\n';
    html += '.chart-chip.active { color:white !important; }\n';
    html += '.detail-chart-details { padding:10px; background:rgba(255,255,255,0.04); border-radius:8px; font-size:0.78rem; color:#aaa; }\n';
    html += '.detail-round-item { padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.06); cursor:pointer; transition:background 0.2s; }\n';
    html += '.detail-round-item:hover { background:rgba(255,255,255,0.03); }\n';
    html += '.detail-round-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }\n';
    html += '.detail-round-num { font-weight:600; font-size:0.88rem; }\n';
    html += '.detail-round-time { font-size:0.7rem; color:#666; }\n';
    html += '.detail-round-info { font-size:0.8rem; color:#ccc; margin-bottom:3px; }\n';
    html += '.detail-round-info .winner { color:#ff6b6b; font-weight:600; }\n';
    html += '.detail-round-info .banker { color:#4cc9f0; }\n';
    html += '.detail-round-details { font-size:0.75rem; color:#888; }\n';
    html += '.detail-round-expand { display:none; padding-top:8px; margin-top:8px; border-top:1px solid rgba(255,255,255,0.06); }\n';
    html += '.detail-round-item.expanded .detail-round-expand { display:block; }\n';
    html += '.detail-round-payment-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px; font-size:0.75rem; }\n';
    html += '.detail-round-payment-item { display:flex; justify-content:space-between; padding:3px 6px; background:rgba(255,255,255,0.04); border-radius:4px; }\n';
    html += '.detail-round-payment-name { color:#ccc; }\n';
    html += '.detail-round-payment-amt { font-weight:600; }\n';
    html += '.detail-round-payment-amt.win { color:#ff6b6b; }\n';
    html += '.detail-round-payment-amt.lose { color:#51cf66; }\n';
    html += '.detail-round-score-tags { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }\n';
    html += '.detail-round-score-tag { padding:2px 8px; background:rgba(76,201,240,0.15); color:#4cc9f0; border-radius:10px; font-size:0.7rem; }\n';
    html += '.detail-round-arrow { transition:transform 0.2s; font-size:0.7rem; color:#666; }\n';
    html += '.detail-round-item.expanded .detail-round-arrow { transform:rotate(180deg); }\n';
    html += '.detail-overview-meta { padding:10px 12px; background:rgba(255,255,255,0.04); border-radius:8px; margin-bottom:10px; font-size:0.8rem; color:#aaa; }\n';
    html += '.detail-awards { display:grid; grid-template-columns:repeat(2,1fr); gap:6px; margin-bottom:10px; }\n';
    html += '.detail-award-card { background:linear-gradient(135deg,rgba(255,215,0,0.08),rgba(255,152,0,0.08)); border:1px solid rgba(255,215,0,0.2); border-radius:8px; padding:8px 10px; display:flex; align-items:center; gap:8px; }\n';
    html += '.detail-award-icon { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:0.8rem; flex-shrink:0; }\n';
    html += '.detail-award-info { flex:1; min-width:0; }\n';
    html += '.detail-award-label { font-size:0.65rem; color:#888; margin-bottom:1px; }\n';
    html += '.detail-award-name { font-size:0.82rem; font-weight:600; color:#ffd700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n';
    html += '.detail-award-val { font-size:0.7rem; color:#aaa; }\n';
    html += '.detail-remark-section { margin-top:10px; padding:10px; background:rgba(76,201,240,0.05); border:1px solid rgba(76,201,240,0.15); border-radius:8px; }\n';
    html += '.detail-remark-label { font-size:0.8rem; font-weight:600; color:#4cc9f0; margin-bottom:6px; }\n';
    html += '.detail-remark-input { width:100%; min-height:50px; max-height:120px; padding:8px 10px; background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.15); border-radius:6px; color:#ddd; font-size:0.8rem; resize:vertical; box-sizing:border-box; font-family:inherit; }\n';
    html += '.detail-remark-input:focus { outline:none; border-color:#4cc9f0; background:rgba(76,201,240,0.08); }\n';
    html += '.detail-remark-save-btn { display:block; width:100%; margin-top:8px; padding:7px; background:#4cc9f0; color:#1a1a2e; border:none; border-radius:6px; cursor:pointer; font-size:0.8rem; font-weight:600; transition:opacity 0.2s; }\n';
    html += '.detail-remark-save-btn:hover { opacity:0.85; }\n';
    html += '.detail-remark-save-btn:disabled { opacity:0.5; cursor:not-allowed; }\n';
    html += '</style>\n';
    html += '</head>\n';

    // ====== BODY ======
    html += '<body>\n';
    html += '<div class="container">\n';

    // Header
    html += '<div class="header" id="headerBar">\n';
    html += '<div class="header-left">\n';
    html += '<h1><i class="fas fa-eye"></i> 麻将计分监控系统</h1>\n';
    html += '</div>\n';
    html += '<div class="header-actions">\n';
    html += '<button class="icon-btn" id="clearDataBtn" title="清除所有数据"><i class="fas fa-trash-alt"></i></button>\n';
    html += '</div>\n';
    html += '</div>\n';

    // Card 1: Player Data + Game Stats (merged with tabs, default expanded)
    html += '<div class="card">\n';
    html += '<div class="card-title no-heading" id="dataCardTitle">\n';
    html += '<div></div>\n';
    html += '<div class="tab-bar">\n';
    html += '<button class="tab-btn active" id="tabPlayerBtn" data-tab="player">玩家数据</button>\n';
    html += '<button class="tab-btn" id="tabStatsBtn" data-tab="stats">统计数据</button>\n';
    html += '<button class="tab-btn" id="tabHistoryBtn" data-tab="history">历史结算</button>\n';
    html += '</div>\n';
    html += '</div>\n';
    html += '<div class="card-body tabbed-body expanded" id="dataCardBody">\n';
    html += '<div class="tab-content active" id="tabPlayerContent">\n';
    html += '<div class="player-data-container" id="playerDataContainer"></div>\n';
    html += '</div>\n';
    html += '<div class="tab-content" id="tabStatsContent">\n';
    html += '<div class="game-stats-container" id="gameStatsContainer"></div>\n';
    html += '</div>\n';
    html += '<div class="tab-content" id="tabHistoryContent">\n';
    html += '<div id="settlementHistoryContainer" style="height:calc(100% - 10px); overflow-y:auto; padding:2px;"></div>\n';
    html += '</div>\n';
    html += '</div>\n';
    html += '</div>\n';

    // Card 2: Game Log (default expanded)
    html += '<div class="card">\n';
    html += '<div class="card-title" id="logCardTitle">\n';
    html += '<h2><i class="fas fa-history"></i> 对局日志</h2>\n';
    html += '<div class="status-badge" id="logCount">0 条记录</div>\n';
    html += '</div>\n';
    html += '<div class="card-body expanded" id="logCardBody" style="max-height:380px; overflow-y:auto;"></div>\n';
    html += '</div>\n';

    // Refresh Button


    html += '</div>\n';

    // ====== JavaScript ======
    html += '<script>\n';

    // API 基址：通过 2525 端口 /admin 访问时使用 /admin 前缀；5252 直连时无前缀
    html += 'var API_BASE = (window.location.port === "5252") ? "" : "/admin";\n';

    // iconMap
    html += 'var iconMap = {\n';
    html += '    mozhang: "fa-hand-paper",\n';
    html += '    duying: "fa-crown",\n';
    html += '    dongfeng: "fa-wind",\n';
    html += '    erwu: "fa-dice-two"\n';
    html += '};\n';
    html += 'var muzzleColorMap = {\n';
    html += '    mozhang: "#fbc02d",\n';
    html += '    duying: "#c2185b",\n';
    html += '    dongfeng: "#1976d2",\n';
    html += '    erwu: "#388e3c"\n';
    html += '};\n';

    // Global variables
    html += 'var ws = null;\n';
    html += 'var gameState = null;\n';

    // 历史结算相关函数
    html += generateSettlementHistoryJS() + '\n';

    // toggleCard function
    html += 'function toggleCard(titleEl) {\n';
    html += '    var body = titleEl.nextElementSibling;\n';
    html += '    var isCollapsed = titleEl.classList.contains("collapsed");\n';
    html += '    if (isCollapsed) {\n';
    html += '        titleEl.classList.remove("collapsed");\n';
    html += '        body.classList.add("expanded");\n';
    html += '    } else {\n';
    html += '        titleEl.classList.add("collapsed");\n';
    html += '        body.classList.remove("expanded");\n';
    html += '    }\n';
    html += '}\n';

    // initWebSocket function
    html += 'function initWebSocket() {\n';
    html += '    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";\n';
    html += '    var wsUrl = protocol + "//" + window.location.hostname + ":2525";\n';
    html += '    ws = new WebSocket(wsUrl);\n';
    html += '    ws.onopen = function() {\n';
    html += '        console.log("监控系统已连接到计分服务器");\n';
    html += '    };\n';
    html += '    ws.onmessage = function(event) {\n';
    html += '        try {\n';
    html += '            var data = JSON.parse(event.data);\n';
    html += '            if (data.type === "state_update" || data.type === "full_state") {\n';
    html += '                gameState = data.state;\n';
    html += '                updatePlayerData();\n';
    html += '                updateGameStats();\n';
    html += '                loadLogs();\n';
    html += '            } else if (data.type === "data_cleared") {\n';
    html += '                showMonitorAlert("提示", "游戏数据已被清除，即将跳转至计分系统重新选择嘴子！", function() { window.location.href = "http://" + window.location.hostname + ":2525"; });\n';
    html += '            } else if (data.type === "settlement_history_sync") {\n';
    html += '                // 历史结算数据有更新（如备注修改/新增结算），实时刷新历史结算\n';
    html += '                if (typeof loadSettlementHistory === "function") loadSettlementHistory();\n';
    html += '            }\n';
    html += '        } catch (e) {\n';
    html += '            console.error("解析WebSocket消息失败:", e);\n';
    html += '        }\n';
    html += '    };\n';
    html += '    ws.onclose = function() {\n';
    html += '        console.log("与计分服务器断开连接");\n';
    html += '        setTimeout(initWebSocket, 3000);\n';
    html += '    };\n';
    html += '    ws.onerror = function(error) {\n';
    html += '        console.error("WebSocket错误:", error);\n';
    html += '    };\n';
    html += '}\n';

    // calculatePlayerStats function
    html += 'function calculatePlayerStats(players, history) {\n';
    html += '    var result = [];\n';
    html += '    for (var i = 0; i < players.length; i++) {\n';
    html += '        var player = players[i];\n';
    html += '        var winCount = 0;\n';
    html += '        var bankerCount = 0;\n';
    html += '        var totalRounds = 0;\n';
    html += '        for (var j = 0; j < history.length; j++) {\n';
    html += '            var record = history[j];\n';
    html += '            if (record.type) continue;\n';
    html += '            totalRounds++;\n';
    html += '            if (record.winnerId === player.id) winCount++;\n';
    html += '            if (record.bankerId === player.id) bankerCount++;\n';
    html += '        }\n';
    html += '        var winRate = totalRounds > 0 ? (winCount / totalRounds * 100).toFixed(1) + "%" : "0%";\n';
    html += '        result.push({\n';
    html += '            id: player.id,\n';
    html += '            name: player.name,\n';
    html += '            score: player.score,\n';
    html += '            muzzleType: player.muzzleType,\n';
    html += '            isBanker: player.isBanker,\n';
    html += '            continuousBankerCount: player.continuousBankerCount,\n';
    html += '            winCount: winCount,\n';
    html += '            winRate: winRate,\n';
    html += '            bankerCount: bankerCount\n';
    html += '        });\n';
    html += '    }\n';
    html += '    return result;\n';
    html += '}\n';

    // updatePlayerData function
    html += 'function updatePlayerData() {\n';
    html += '    var playerDataContainer = document.getElementById("playerDataContainer");\n';
    html += '    if (!playerDataContainer) return;\n';
    html += '    var xhr1 = new XMLHttpRequest();\n';
    html += '    xhr1.open("GET", API_BASE + "/api/monitor/players", true);\n';
    html += '    xhr1.onreadystatechange = function() {\n';
    html += '        if (xhr1.readyState !== 4 || xhr1.status !== 200) return;\n';
    html += '        var data = JSON.parse(xhr1.responseText);\n';
    html += '        var players = data.players || [];\n';
    html += '        var xhr2 = new XMLHttpRequest();\n';
    html += '        xhr2.open("GET", API_BASE + "/api/monitor/game-state", true);\n';
    html += '        xhr2.onreadystatechange = function() {\n';
    html += '            if (xhr2.readyState !== 4 || xhr2.status !== 200) return;\n';
    html += '            var historyData = JSON.parse(xhr2.responseText);\n';
    html += '            var history = (historyData.gameState && historyData.gameState.history) ? historyData.gameState.history : [];\n';
    html += '            var playersWithStats = calculatePlayerStats(players, history);\n';
    html += '            var html = "";\n';
    html += '            for (var i = 0; i < playersWithStats.length; i++) {\n';
    html += '                var p = playersWithStats[i];\n';
    html += '                var icon = iconMap[p.muzzleType] || "fa-user";\n';
    html += '                var bankerClass = p.isBanker ? " banker" : "";\n';
    html += '                var bankerTag = p.isBanker ? \'<div class="banker-tag">(庄)</div>\' : "";\n';
    html += '                var scorePrefix = p.score >= 0 ? "+" : "";\n';
    html += '                html += \'<div class="player-data">\' +\n';
    html += '                    \'<div class="player-avatar \' + p.muzzleType + bankerClass + \'">\' +\n';
    html += '                    \'<i class="fas \' + icon + \'"></i>\' +\n';
    html += '                    bankerTag +\n';
    html += '                    \'</div>\' +\n';
    html += '                    \'<div class="player-name">\' + (p.nickname ? (p.name + " / " + p.nickname) : p.name) + \'</div>\' +\n';
    html += '                    \'<div class="player-stats">\' +\n';
    html += '                    \'<div class="player-stat-item"><div class="player-stat-value">\' + scorePrefix + p.score + \'</div><div class="player-stat-label">总分</div></div>\' +\n';
    html += '                    \'<div class="player-stat-item"><div class="player-stat-value">\' + p.winRate + \'</div><div class="player-stat-label">胜率</div></div>\' +\n';
    html += '                    \'<div class="player-stat-item"><div class="player-stat-value">\' + p.bankerCount + \'</div><div class="player-stat-label">庄家次数</div></div>\' +\n';
    html += '                    \'<div class="player-stat-item"><div class="player-stat-value">\' + p.winCount + \'</div><div class="player-stat-label">获胜次数</div></div>\' +\n';
    html += '                    \'</div>\' +\n';
    html += '                    \'</div>\';\n';
    html += '            }\n';
    html += '            playerDataContainer.innerHTML = html;\n';
    html += '        };\n';
    html += '        xhr2.send();\n';
    html += '    };\n';
    html += '    xhr1.send();\n';
    html += '}\n';

    // calculateGameStats function
    html += 'function calculateGameStats(players, history) {\n';
    html += '    var totalRounds = 0;\n';
    html += '    var bankerCounts = {};\n';
    html += '    var winCounts = {};\n';
    html += '    var maxBankerCount = 0;\n';
    html += '    var maxWinCount = 0;\n';
    html += '    var winStreak = {};\n';
    html += '    var maxStreak = {};\n';
    html += '    var currentStreak = {};\n';
    html += '    for (var j = 0; j < players.length; j++) {\n';
    html += '        winCounts[players[j].id] = 0;\n';
    html += '        maxStreak[players[j].id] = 0;\n';
    html += '        currentStreak[players[j].id] = 0;\n';
    html += '    }\n';
    html += '    for (var j = 0; j < history.length; j++) {\n';
    html += '        var record = history[j];\n';
    html += '        if (record.type) continue;\n';
    html += '        totalRounds++;\n';
    html += '        if (record.bankerId) {\n';
    html += '            if (!bankerCounts[record.bankerId]) bankerCounts[record.bankerId] = 0;\n';
    html += '            bankerCounts[record.bankerId]++;\n';
    html += '            if (bankerCounts[record.bankerId] > maxBankerCount) maxBankerCount = bankerCounts[record.bankerId];\n';
    html += '        }\n';
    html += '        if (record.winnerId) {\n';
    html += '            if (!winCounts[record.winnerId]) winCounts[record.winnerId] = 0;\n';
    html += '            winCounts[record.winnerId]++;\n';
    html += '            if (winCounts[record.winnerId] > maxWinCount) maxWinCount = winCounts[record.winnerId];\n';
    html += '            currentStreak[record.winnerId]++;\n';
    html += '            if (currentStreak[record.winnerId] > maxStreak[record.winnerId]) maxStreak[record.winnerId] = currentStreak[record.winnerId];\n';
    html += '            for (var pid in currentStreak) {\n';
    html += '                if (parseInt(pid) !== record.winnerId) currentStreak[pid] = 0;\n';
    html += '            }\n';
    html += '        }\n';
    html += '    }\n';
    html += '    var bankerKingId = null;\n';
    html += '    var bankerKing = null;\n';
    html += '    var keys = Object.keys(bankerCounts);\n';
    html += '    for (var k = 0; k < keys.length; k++) {\n';
    html += '        if (bankerCounts[keys[k]] === maxBankerCount) {\n';
    html += '            bankerKingId = parseInt(keys[k]);\n';
    html += '            break;\n';
    html += '        }\n';
    html += '    }\n';
    html += '    for (var i = 0; i < players.length; i++) {\n';
    html += '        if (players[i].id === bankerKingId) { bankerKing = players[i]; break; }\n';
    html += '    }\n';
    html += '    var winnerKingId = null;\n';
    html += '    var winnerKing = null;\n';
    html += '    var keys2 = Object.keys(winCounts);\n';
    html += '    for (var k = 0; k < keys2.length; k++) {\n';
    html += '        if (winCounts[keys2[k]] === maxWinCount) {\n';
    html += '            winnerKingId = parseInt(keys2[k]);\n';
    html += '            break;\n';
    html += '        }\n';
    html += '    }\n';
    html += '    for (var i = 0; i < players.length; i++) {\n';
    html += '        if (players[i].id === winnerKingId) { winnerKing = players[i]; break; }\n';
    html += '    }\n';
    html += '    var streakKingId = null;\n';
    html += '    var streakKing = null;\n';
    html += '    var maxStreakVal = 0;\n';
    html += '    for (var pid in maxStreak) {\n';
    html += '        if (maxStreak[pid] > maxStreakVal) {\n';
    html += '            maxStreakVal = maxStreak[pid];\n';
    html += '            streakKingId = parseInt(pid);\n';
    html += '        }\n';
    html += '    }\n';
    html += '    for (var i = 0; i < players.length; i++) {\n';
    html += '        if (players[i].id === streakKingId) { streakKing = players[i]; break; }\n';
    html += '    }\n';
    html += '    var highestScore = -999999;\n';
    html += '    var highestScorePlayer = null;\n';
    html += '    var lowestScore = 999999;\n';
    html += '    var lowestScorePlayer = null;\n';
    html += '    for (var i = 0; i < players.length; i++) {\n';
    html += '        if (players[i].score > highestScore) { highestScore = players[i].score; highestScorePlayer = players[i]; }\n';
    html += '        if (players[i].score < lowestScore) { lowestScore = players[i].score; lowestScorePlayer = players[i]; }\n';
    html += '    }\n';
    html += '    return {\n';
    html += '        totalRounds: totalRounds,\n';
    html += '        bankerKing: bankerKing,\n';
    html += '        maxBankerCount: maxBankerCount,\n';
    html += '        winnerKing: winnerKing,\n';
    html += '        maxWinCount: maxWinCount,\n';
    html += '        streakKing: streakKing,\n';
    html += '        maxStreakVal: maxStreakVal,\n';
    html += '        highestScore: highestScore,\n';
    html += '        highestScorePlayer: highestScorePlayer,\n';
    html += '        lowestScore: lowestScore,\n';
    html += '        lowestScorePlayer: lowestScorePlayer\n';
    html += '    };\n';
    html += '}\n';

    // updateGameStats function
    html += 'function updateGameStats() {\n';
    html += '    var gameStatsContainer = document.getElementById("gameStatsContainer");\n';
    html += '    if (!gameStatsContainer) return;\n';
    html += '    var xhr = new XMLHttpRequest();\n';
    html += '    xhr.open("GET", API_BASE + "/api/monitor/game-state", true);\n';
    html += '    xhr.onreadystatechange = function() {\n';
    html += '        if (xhr.readyState !== 4 || xhr.status !== 200) return;\n';
    html += '        var data = JSON.parse(xhr.responseText);\n';
    html += '        var players = (data.gameState && data.gameState.players) ? data.gameState.players : [];\n';
    html += '        var history = (data.gameState && data.gameState.history) ? data.gameState.history : [];\n';
    html += '        var stats = calculateGameStats(players, history);\n';
    html += '        var bankerKingName = stats.bankerKing ? stats.bankerKing.name : "无";\n';
    html += '        var winnerKingName = stats.winnerKing ? stats.winnerKing.name : "无";\n';
    html += '        var streakKingName = stats.streakKing ? stats.streakKing.name : "无";\n';
    html += '        var highPlayerName = stats.highestScorePlayer ? stats.highestScorePlayer.name : "无";\n';
    html += '        var lowPlayerName = stats.lowestScorePlayer ? stats.lowestScorePlayer.name : "无";\n';
    html += '        var highPrefix = stats.highestScore >= 0 ? "+" : "";\n';
    html += '        var lowPrefix = stats.lowestScore >= 0 ? "+" : "";\n';
    html += '        var h = "";\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">总局数</div><div class="game-stat-value">\' + stats.totalRounds + \'</div></div>\';\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">庄家王</div><div class="game-stat-value">\' + bankerKingName + \'</div><div class="game-stat-player">\' + (stats.maxBankerCount || 0) + \'次庄</div></div>\';\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">最高分</div><div class="game-stat-value">\' + highPrefix + stats.highestScore + \'</div><div class="game-stat-player">\' + highPlayerName + \'</div></div>\';\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">赢家王</div><div class="game-stat-value">\' + winnerKingName + \'</div><div class="game-stat-player">\' + (stats.maxWinCount || 0) + \'胜</div></div>\';\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">最低分</div><div class="game-stat-value">\' + lowPrefix + stats.lowestScore + \'</div><div class="game-stat-player">\' + lowPlayerName + \'</div></div>\';\n';
    html += '        h += \'<div class="game-stat-item"><div class="game-stat-label">连胜王</div><div class="game-stat-value">\' + streakKingName + \'</div><div class="game-stat-player">\' + (stats.maxStreakVal || 0) + \'连胜</div></div>\';\n';
    html += '        gameStatsContainer.innerHTML = h;\n';
    html += '    };\n';
    html += '    xhr.send();\n';
    html += '}\n';

    // loadLogs function
    html += 'function loadLogs() {\n';
    html += '    var logCardBody = document.getElementById("logCardBody");\n';
    html += '    var logCountEl = document.getElementById("logCount");\n';
    html += '    if (!logCardBody) return;\n';
    html += '    var xhr = new XMLHttpRequest();\n';
    html += '    xhr.open("GET", API_BASE + "/api/monitor/logs", true);\n';
    html += '    xhr.onreadystatechange = function() {\n';
    html += '        if (xhr.readyState !== 4 || xhr.status !== 200) return;\n';
    html += '        var data = JSON.parse(xhr.responseText);\n';
    html += '        var logs = data.logs || [];\n';
    html += '        var filtered = [];\n';
    html += '        for (var i = 0; i < logs.length; i++) {\n';
    html += '            var msg = logs[i].message || "";\n';
    html += '            if (msg.indexOf("第") >= 0 || msg.indexOf("撤销") >= 0 || msg.indexOf("手动") >= 0) {\n';
    html += '                filtered.push(logs[i]);\n';
    html += '            }\n';
    html += '        }\n';
    html += '        if (logCountEl) logCountEl.textContent = filtered.length + " 条记录";\n';
    html += '        var recent = filtered.slice(-50).reverse();\n';
    html += '        var html = "";\n';
    html += '        for (var i = 0; i < recent.length; i++) {\n';
    html += '            var log = recent[i];\n';
    html += '            var logType = "normal";\n';
    html += '            if (log.message.indexOf("手动") >= 0) logType = "manual";\n';
    html += '            if (log.message.indexOf("撤销") >= 0) logType = "undo";\n';
    html += '            var contentHtml = "";\n';
    html += '            if (logType === "normal" && log.message.indexOf("局") >= 0) {\n';
    html += '                var roundMatch = log.message.match(/第(\\d+)局/);\n';
    html += '                var winnerMatch = log.message.match(/赢家:([^\\s\\[]+)/);\n';
    html += '                var bankerMatch = log.message.match(/庄家:([^\\s\\[]+)/);\n';
    html += '                var scoresMatch = log.message.match(/\\[([^\\]]+)\\]\\s*\\[/);\n';
    html += '                var detailsMatch = log.message.match(/\\]\\s*\\[([^\\]]+)\\]/);\n';
    html += '                if (roundMatch) {\n';
    html += '                    contentHtml += \'<div class="log-line log-line1">第\' + roundMatch[1] + \'局\';\n';
    html += '                    if (winnerMatch) contentHtml += \' 赢家：\' + winnerMatch[1];\n';
    html += '                    if (bankerMatch) contentHtml += \' 庄家：\' + bankerMatch[1];\n';
    html += '                    contentHtml += \'</div>\';\n';
    html += '                }\n';
    html += '                if (scoresMatch) {\n';
    html += '                    contentHtml += \'<div class="log-line log-line2">\' + scoresMatch[1] + \'</div>\';\n';
    html += '                }\n';
    html += '                if (detailsMatch) {\n';
    html += '                    var details = detailsMatch[1].split(",");\n';
    html += '                    var filteredDetails = [];\n';
    html += '                    var hasZimo = false;\n';
    html += '                    for (var d = 0; d < details.length; d++) {\n';
    html += '                        var trimmed = details[d].trim();\n';
    html += '                        if (trimmed === "自摸") { hasZimo = true; continue; }\n';
    html += '                        if (trimmed !== "七梁") filteredDetails.push(trimmed);\n';
    html += '                    }\n';
    html += '                    if (filteredDetails.length > 0) {\n';
    html += '                        contentHtml += \'<div class="log-line log-line3">[\' + filteredDetails.join(", ") + \']</div>\';\n';
    html += '                    }\n';
    html += '                    if (hasZimo) logType = logType + " zimo";\n';
    html += '                }\n';
    html += '            } else {\n';
    html += '                contentHtml = \'<div class="log-line log-line1">\' + log.message + \'</div>\';\n';
    html += '            }\n';
    html += '            html += \'<div class="log-item \' + logType + \'">\' + contentHtml + \'<div class="log-time">\' + log.timestamp + \'</div></div>\';\n';
    html += '        }\n';
    html += '        logCardBody.innerHTML = html;\n';
    html += '        logCardBody.scrollTop = 0;\n';
    html += '    };\n';
    html += '    xhr.send();\n';
    html += '}\n';

// 历史结算数据函数
function generateSettlementHistoryJS() {
    var js = '';
    // 自定义弹窗函数
    js += '// 通用自定义弹窗\n';
    js += 'function showMonitorConfirm(title, msg, onOk) {\n';
    js += '    var m = document.createElement("div");\n';
    js += '    m.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;";\n';
    js += '    var d = document.createElement("div");\n';
    js += '    d.style.cssText = "background:#1a1a2e;border-radius:14px;width:80%;max-width:320px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);";\n';
    js += '    d.innerHTML = "<div style=\'padding:18px 16px 10px;font-size:1rem;font-weight:600;color:#fff;text-align:center;\'>" + title + "</div><div style=\'padding:0 16px 16px;font-size:0.85rem;color:#aaa;text-align:center;line-height:1.5;\'>" + msg + "</div>";\n';
    js += '    var br = document.createElement("div");\n';
    js += '    br.style.cssText = "display:flex;border-top:1px solid rgba(255,255,255,0.1);";\n';
    js += '    var bc = document.createElement("button");\n';
    js += '    bc.textContent = "取消";\n';
    js += '    bc.style.cssText = "flex:1;padding:13px;border:none;background:none;color:#888;font-size:0.9rem;cursor:pointer;";\n';
    js += '    bc.onclick = function() { m.remove(); };\n';
    js += '    var bo = document.createElement("button");\n';
    js += '    bo.textContent = "确认";\n';
    js += '    bo.style.cssText = "flex:1;padding:13px;border:none;background:linear-gradient(90deg,#4361ee,#4cc9f0);color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;";\n';
    js += '    bo.onclick = function() { m.remove(); if (onOk) onOk(); };\n';
    js += '    br.appendChild(bc); br.appendChild(bo); d.appendChild(br); m.appendChild(d); document.body.appendChild(m);\n';
    js += '}\n';
    js += 'function showMonitorAlert(title, msg, onClose) {\n';
    js += '    var m = document.createElement("div");\n';
    js += '    m.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;";\n';
    js += '    var d = document.createElement("div");\n';
    js += '    d.style.cssText = "background:#1a1a2e;border-radius:14px;width:80%;max-width:320px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);";\n';
    js += '    d.innerHTML = "<div style=\'padding:18px 16px 10px;font-size:1rem;font-weight:600;color:#e74c3c;text-align:center;\'>" + title + "</div><div style=\'padding:0 16px 16px;font-size:0.85rem;color:#aaa;text-align:center;line-height:1.5;\'>" + msg + "</div>";\n';
    js += '    var bo = document.createElement("button");\n';
    js += '    bo.textContent = "知道了";\n';
    js += '    bo.style.cssText = "width:100%;padding:13px;border:none;background:linear-gradient(90deg,#4361ee,#4cc9f0);color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;";\n';
    js += '    bo.onclick = function() { m.remove(); if (onClose) onClose(); };\n';
    js += '    d.appendChild(bo); m.appendChild(d); document.body.appendChild(m);\n';
    js += '}\n';
    js += 'function showMonitorPrompt(title, defVal, onOk) {\n';
    js += '    var m = document.createElement("div");\n';
    js += '    m.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;";\n';
    js += '    var d = document.createElement("div");\n';
    js += '    d.style.cssText = "background:#1a1a2e;border-radius:14px;width:82%;max-width:340px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.5);border:1px solid rgba(255,255,255,0.1);";\n';
    js += '    d.innerHTML = "<div style=\'padding:16px;font-size:1rem;font-weight:600;color:#fff;text-align:center;border-bottom:1px solid rgba(255,255,255,0.1);\'>" + title + "</div>";\n';
    js += '    var inp = document.createElement("input");\n';
    js += '    inp.type = "password"; inp.value = defVal || ""; inp.placeholder = "请输入";\n';
    js += '    inp.style.cssText = "width:80%;margin:16px 10%;padding:10px 12px;border:1.5px solid #333;border-radius:8px;background:#0f0f1a;color:#fff;font-size:0.9rem;outline:none;box-sizing:border-box;";\n';
    js += '    d.appendChild(inp);\n';
    js += '    var br = document.createElement("div");\n';
    js += '    br.style.cssText = "display:flex;border-top:1px solid rgba(255,255,255,0.1);";\n';
    js += '    var bc = document.createElement("button");\n';
    js += '    bc.textContent = "取消";\n';
    js += '    bc.style.cssText = "flex:1;padding:13px;border:none;background:none;color:#888;font-size:0.9rem;cursor:pointer;";\n';
    js += '    bc.onclick = function() { m.remove(); };\n';
    js += '    var bo = document.createElement("button");\n';
    js += '    bo.textContent = "确认";\n';
    js += '    bo.style.cssText = "flex:1;padding:13px;border:none;background:linear-gradient(90deg,#4361ee,#4cc9f0);color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;";\n';
    js += '    function doOk() { var v = inp.value; m.remove(); if (onOk) onOk(v); }\n';
    js += '    bo.onclick = doOk; inp.onkeydown = function(e) { if (e.key === "Enter") doOk(); };\n';
    js += '    br.appendChild(bc); br.appendChild(bo); d.appendChild(br); m.appendChild(d); document.body.appendChild(m);\n';
    js += '    setTimeout(function() { inp.focus(); }, 100);\n';
    js += '}\n';

    js += '// 格式化时间为24小时制\n';
    js += 'function formatRoundTime(timeStr) {\n';
    js += '    if (!timeStr) return "";\n';
    js += '    var str = String(timeStr).trim();\n';
    js += '    var m = str.match(/(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4}),?\\s*(\\d{1,2}):(\\d{2}):(\\d{2})\\s*(AM|PM)/i);\n';
    js += '    if (m) {\n';
    js += '        var month = m[1], day = m[2], year = m[3];\n';
    js += '        var hour = parseInt(m[4], 10);\n';
    js += '        var min = m[5], sec = m[6];\n';
    js += '        var ap = m[7].toUpperCase();\n';
    js += '        if (ap === "PM" && hour < 12) hour += 12;\n';
    js += '        if (ap === "AM" && hour === 12) hour = 0;\n';
    js += '        return year + "/" + month + "/" + day + " " + (hour < 10 ? "0" + hour : hour) + ":" + min + ":" + sec;\n';
    js += '    }\n';
    js += '    m = str.match(/(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})[\\sT](\\d{1,2}):(\\d{2}):(\\d{2})/);\n';
    js += '    if (m) { return m[1] + "/" + m[2] + "/" + m[3] + " " + (parseInt(m[4])<10?"0"+m[4]:m[4]) + ":" + m[5] + ":" + m[6]; }\n';
    js += '    return str;\n';
    js += '}\n';
    js += '// 计算结算统计\n';
    js += 'function calcSettlementStats(settlement) {\n';
    js += '    var players = settlement.players.map(function(p, i) { return { id: i + 1, name: p.name, nickname: p.nickname || "", muzzleType: p.muzzleType, score: p.score }; });\n';
    js += '    var history = settlement.history || [];\n';
    js += '    var scoreItemNames = ["摸张", "独赢", "东风", "二五"];\n';
    js += '    return players.map(function(player) {\n';
    js += '        var winCount = 0;\n';
    js += '        var selfDrawCount = 0;\n';
    js += '        var bankerCount = 0;\n';
    js += '        var maxStreak = 0;\n';
    js += '        var curStreak = 0;\n';
    js += '        var maxLoseStreak = 0;\n';
    js += '        var curLoseStreak = 0;\n';
    js += '        var cum = 0;\n';
    js += '        var maxRoundScore = 0;\n';
    js += '        var minRoundScore = 0;\n';
    js += '        var scoreItemCounts = {};\n';
    js += '        var liangCounts = { 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };\n';
    js += '        for (var si = 0; si < scoreItemNames.length; si++) scoreItemCounts[scoreItemNames[si]] = 0;\n';
    js += '        for (var i = 0; i < history.length; i++) {\n';
    js += '            var r = history[i];\n';
    js += '            if (r.type === "tableFee") continue;\n';
    js += '            if (r.winnerId === player.id) {\n';
    js += '                winCount++; curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; curLoseStreak = 0; if (r.isSelfDrawn) selfDrawCount++;\n';
    js += '                if (r.details && r.details.length > 0) {\n';
    js += '                    var filteredForLiang = [];\n';
    js += '                    for (var di = 0; di < r.details.length; di++) {\n';
    js += '                        var dItem = r.details[di];\n';
    js += '                        if (dItem !== "七梁" && dItem !== "自摸" && dItem.indexOf("庄家额外分") !== 0) filteredForLiang.push(dItem);\n';
    js += '                        if (scoreItemCounts.hasOwnProperty(dItem)) scoreItemCounts[dItem]++;\n';
    js += '                    }\n';
    js += '                    var itemCount = filteredForLiang.length;\n';
    js += '                    if (itemCount >= 1 && itemCount <= 5) {\n';
    js += '                        var liangNum = itemCount + 2;\n';
    js += '                        if (liangCounts[liangNum] !== undefined) liangCounts[liangNum]++;\n';
    js += '                    }\n';
    js += '                }\n';
    js += '            }\n';
    js += '            else { curStreak = 0; }\n';
    js += '            if (r.playerPayments) {\n';
    js += '                var pay = null;\n';
    js += '                for (var j = 0; j < r.playerPayments.length; j++) { if (r.playerPayments[j].id === player.id) { pay = r.playerPayments[j]; break; } }\n';
    js += '                if (pay) {\n';
    js += '                    var change = -pay.amount;\n';
    js += '                    cum += change;\n';
    js += '                    if (cum > maxRoundScore) maxRoundScore = cum;\n';
    js += '                    if (cum < minRoundScore) minRoundScore = cum;\n';
    js += '                    if (change < 0) { curLoseStreak++; if (curLoseStreak > maxLoseStreak) maxLoseStreak = curLoseStreak; } else { curLoseStreak = 0; }\n';
    js += '                }\n';
    js += '            }\n';
    js += '            if (r.bankerId === player.id) bankerCount++;\n';
    js += '        }\n';
    js += '        var validRounds = 0;\n';
    js += '        for (var vr = 0; vr < history.length; vr++) { if (history[vr].type !== "tableFee") validRounds++; }\n';
    js += '        var winRate = validRounds > 0 ? (winCount / validRounds * 100).toFixed(1) + "%" : "0%";\n';
    js += '        return { id: player.id, name: player.name, nickname: player.nickname || "", muzzleType: player.muzzleType, score: player.score, winCount: winCount, selfDrawCount: selfDrawCount, bankerCount: bankerCount, winRate: winRate, maxStreak: maxStreak, maxLoseStreak: maxLoseStreak, maxRoundScore: maxRoundScore, minRoundScore: minRoundScore, liangCounts: liangCounts, scoreItemCounts: scoreItemCounts };\n';
    js += '    });\n';
    js += '}\n';
    js += '\n';
    js += '// 构建分数数据点\n';
    js += 'function buildSettlementScoreData(settlement, playerId) {\n';
    js += '    var points = [{ round: 0, score: 0, isStart: true, winnerId: null, bankerId: null, playerId: playerId }];\n';
    js += '    var cum = 0;\n';
    js += '    var history = settlement.history || [];\n';
    js += '    for (var i = 0; i < history.length; i++) {\n';
    js += '        var r = history[i];\n';
    js += '        if (r.type === "tableFee") continue;\n';
    js += '        if (!r.playerPayments) continue;\n';
    js += '        var pay = null;\n';
    js += '        for (var j = 0; j < r.playerPayments.length; j++) { if (r.playerPayments[j].id === playerId) { pay = r.playerPayments[j]; break; } }\n';
    js += '        if (!pay) continue;\n';
    js += '        var change = -pay.amount;\n';
    js += '        cum += change;\n';
    js += '        points.push({ round: r.round, score: cum, change: change, winnerId: r.winnerId, bankerId: r.bankerId, playerId: playerId, isStart: false, timestamp: r.timestamp });\n';
    js += '    }\n';
    js += '    return points;\n';
    js += '}\n';
    js += '\n';
    js += 'var currentDetailChart = null;\n';
    js += 'function loadSettlementHistory() {\n';
    js += '    var container = document.getElementById("settlementHistoryContainer");\n';
    js += '    if (!container) return;\n';
    js += '    var xhr = new XMLHttpRequest();\n';
    js += '    xhr.open("GET", API_BASE + "/api/settlement-history", true);\n';
    js += '    xhr.onreadystatechange = function() {\n';
    js += '        if (xhr.readyState !== 4 || xhr.status !== 200) return;\n';
    js += '        try {\n';
    js += '            var data = JSON.parse(xhr.responseText);\n';
    js += '            var settlements = data.settlements || [];\n';
    js += '            if (settlements.length === 0) {\n';
    js += '                container.innerHTML = \'<div class="no-settlement"><i class="fas fa-archive"></i>暂无历史结算记录</div>\';\n';
    js += '                return;\n';
    js += '            }\n';
    js += '            var html = "";\n';
    js += '            var sorted = settlements.slice().reverse();\n';
    js += '            for (var i = 0; i < sorted.length; i++) {\n';
    js += '                var s = sorted[i];\n';
    js += '                var startTime = s.timestamp || s.startTime || "";\n';
    js += '                var duration = s.duration || "";\n';
    js += '                // 动态计算时长：第一局计分时间至结算时间\n';
    js += '                if (!duration && s.history && s.history.length > 0) {\n';
    js += '                    var fr = null;\n';
    js += '                    for (var hi0 = 0; hi0 < s.history.length; hi0++) { if (s.history[hi0].type !== "tableFee") { fr = s.history[hi0]; break; } }\n';
    js += '                    if (!fr) fr = s.history[0];\n';
    js += '                    var frMs = fr.timestampMs || (fr.timestamp ? new Date(fr.timestamp).getTime() : 0);\n';
    js += '                    var endMs = s.id || (s.timestamp ? new Date(s.timestamp).getTime() : 0);\n';
    js += '                    if (frMs && endMs && endMs > frMs) {\n';
    js += '                        var dMs = endMs - frMs;\n';
    js += '                        var dH = Math.floor(dMs / 3600000);\n';
    js += '                        var dM = Math.floor((dMs % 3600000) / 60000);\n';
    js += '                        duration = dH + "小时" + dM + "分钟";\n';
    js += '                    }\n';
    js += '                }\n';
    js += '                var remark = s.remark || "";\n';
    js += '                var sRounds = (s.history || []).filter(function(hr){ return hr.type !== "tableFee"; }).length || s.totalRounds || 0;\n';
    js += '                html += \'<div class="settlement-list-item" data-settle-id="\' + s.id + \'">\';\n';
    // 删除按钮（右上角）
    js += '                html += \'<div style="position:relative;">\';\n';
    js += '                html += \'<button class="settlement-delete-btn" data-del-id="\' + s.id + \'" style="position:absolute;top:-2px;right:-2px;background:transparent;border:none;width:24px;height:24px;color:rgba(255,255,255,0.6);cursor:pointer;font-size:0.9rem;z-index:5;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;transition:color 0.2s;" title="删除此结算记录"><i class="fas fa-trash-alt"></i></button>\';\n';
    // 第一层：对局基础信息（开始时间 + 时长 + 总局数同一行，浅灰色小字）
    js += '                html += \'<div class="settlement-list-header"><span class="settlement-list-time">\' + startTime + (duration ? \' ｜ \' + duration : \'\') + \' ｜ \' + sRounds + \'局</span></div>\';\n';
    // 第二层：玩家收支区域 2x2
    js += '                html += \'<div class="settlement-list-scores">\';\n';
    js += '                for (var j = 0; j < s.players.length; j++) {\n';
    js += '                    var p = s.players[j];\n';
    js += '                    var cls = p.score >= 0 ? "win" : "lose";\n';
    js += '                    var sign = p.score >= 0 ? "+" : "";\n';
    js += '                    var display = p.nickname ? (p.name + " / " + p.nickname) : p.name;\n';
    js += '                    html += \'<div class="settlement-list-score-item"><span class="settlement-list-score-name">\' + display + \'</span><span class="settlement-list-score-val \' + cls + \'">\' + sign + p.score + \'</span></div>\';\n';
    js += '                }\n';
    js += '                html += \'</div>\';\n';
    // 第三层：结算备注（仅有备注时显示）
    js += '                if (remark) {\n';
    js += '                    html += \'<div class="settlement-list-remark"><i class="fas fa-sticky-note"></i> \' + remark + \'</div>\';\n';
    js += '                }\n';
    js += '                html += \'</div>\';\n';
    js += '                html += \'</div>\';\n';
    js += '            }\n';
    js += '            container.innerHTML = html;\n';
    js += '            var items = container.querySelectorAll(".settlement-list-item");\n';
    js += '            for (var k = 0; k < items.length; k++) {\n';
    js += '                (function(item) {\n';
    js += '                    item.addEventListener("click", function(e) {\n';
    js += '                        // 检查是否点击了删除按钮\n';
    js += '                        var delBtn = e.target.closest(".settlement-delete-btn");\n';
    js += '                        if (delBtn) {\n';
    js += '                            e.stopPropagation();\n';
    js += '                            var delId = parseInt(delBtn.getAttribute("data-del-id"));\n';
        js += '                            showMonitorPrompt("管理员验证", "", function(pwd) {\n';
    js += '                                if (pwd === null || pwd === "") return;\n';
    js += '                                if (pwd !== "8") { showMonitorAlert("错误", "密码错误！"); return; }\n';
    js += '                                showMonitorConfirm("删除确认", "确定要删除此结算记录吗？此操作不可撤销！", function() {\n';
    js += '                            var xhr = new XMLHttpRequest();\n';
    js += '                            xhr.open("POST", API_BASE + "/api/delete-settlement", true);\n';
    js += '                            xhr.setRequestHeader("Content-Type", "application/json");\n';
    js += '                            xhr.onreadystatechange = function() {\n';
    js += '                                if (xhr.readyState === 4) {\n';
    js += '                                    if (xhr.status === 200) {\n';
    js += '                                        try { var data = JSON.parse(xhr.responseText); if (data.success) { showMonitorAlert("成功", "结算记录已删除！", function() { loadSettlementHistory(); }); } else { showMonitorAlert("失败", "删除失败：" + (data.msg || "未知错误")); } } catch(e) { showMonitorAlert("失败", "删除失败：响应解析错误"); }\n';
    js += '                                    } else { showMonitorAlert("失败", "删除失败（错误码：" + xhr.status + "）"); }\n';
    js += '                                }\n';
    js += '                            };\n';
    js += '                            xhr.send(JSON.stringify({ id: delId }));\n';
    js += '                                });\n';
    js += '                            });\n';
    js += '                            return;\n';
    js += '                        }\n';
    js += '                        var id = parseInt(item.getAttribute("data-settle-id"));\n';
    js += '                        var settlement = null;\n';
    js += '                        for (var m = 0; m < sorted.length; m++) { if (sorted[m].id === id) { settlement = sorted[m]; break; } }\n';
    js += '                        if (settlement) showSettlementDetailModal(settlement);\n';
    js += '                    });\n';
    js += '                })(items[k]);\n';
    js += '            }\n';
    js += '        } catch(e) { console.error("加载历史结算失败:", e); }\n';
    js += '    };\n';
    js += '    xhr.send();\n';
    js += '}\n';
    js += '\n';
    js += 'function showSettlementDetailModal(settlement) {\n';
    js += '    if (currentDetailChart) { currentDetailChart.destroy(); currentDetailChart = null; }\n';
    js += '    var stats = calcSettlementStats(settlement);\n';
    js += '    var colorMap = { mozhang: "#fbc02d", duying: "#c2185b", dongfeng: "#1976d2", erwu: "#388e3c" };\n';
    js += '    var detailChartState = { playerId: null };\n';
    js += '    var modal = document.createElement("div");\n';
    js += '    modal.className = "detail-modal";\n';
    js += '    var content = document.createElement("div");\n';
    js += '    content.className = "detail-modal-content";\n';
    js += '    content.innerHTML = \'<div style="padding:40px;text-align:center;color:#666;"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><div style="margin-top:10px;">加载中...</div></div>\';\n';
    js += '    modal.appendChild(content);\n';
    js += '    document.body.appendChild(modal);\n';
    js += '    setTimeout(function() {\n';
    js += '    try {\n';
    js += '\n';
    js += '    var sTotalRounds = (settlement.history || []).filter(function(hr){ return hr.type !== "tableFee"; }).length || settlement.totalRounds || 0;\n';
    js += '    var sDuration = settlement.duration || "";\n';
    js += '    if (!sDuration && settlement.history && settlement.history.length > 0) {\n';
    js += '        var fr = null;\n';
    js += '        for (var hi1 = 0; hi1 < settlement.history.length; hi1++) { if (settlement.history[hi1].type !== "tableFee") { fr = settlement.history[hi1]; break; } }\n';
    js += '        if (!fr) fr = settlement.history[0];\n';
    js += '        var frMs = fr.timestampMs || (fr.timestamp ? new Date(fr.timestamp).getTime() : 0);\n';
    js += '        var endMs = settlement.id || (settlement.timestamp ? new Date(settlement.timestamp).getTime() : 0);\n';
    js += '        if (frMs && endMs && endMs > frMs) {\n';
    js += '            var dMs = endMs - frMs;\n';
    js += '            var dH = Math.floor(dMs / 3600000);\n';
    js += '            var dM = Math.floor((dMs % 3600000) / 60000);\n';
    js += '            sDuration = dH + "小时" + dM + "分钟";\n';
    js += '        }\n';
    js += '    }\n';
    js += '    var overviewHtml = \'<div class="detail-overview-meta">结算时间: \' + (settlement.timestamp || settlement.startTime || "未知") + \'<br>对局时长: \' + (sDuration || "未知") + \' ｜ 总局数: \' + sTotalRounds + \'局</div>\';\n';
    js += '    // 先计算数据统计\n';
    js += '    var topScore = stats[0], lowScore = stats[0], bankerKing = stats[0], winnerKing = stats[0], streakKing = stats[0], loseStreakKing = stats[0];\n';
    js += '    for (var si = 1; si < stats.length; si++) {\n';
    js += '        if (stats[si].maxRoundScore > topScore.maxRoundScore) topScore = stats[si];\n';
    js += '        if (stats[si].minRoundScore < lowScore.minRoundScore) lowScore = stats[si];\n';
    js += '        if (stats[si].bankerCount > bankerKing.bankerCount) bankerKing = stats[si];\n';
    js += '        if (stats[si].winCount > winnerKing.winCount) winnerKing = stats[si];\n';
    js += '        if (stats[si].maxStreak > streakKing.maxStreak) streakKing = stats[si];\n';
    js += '        if (stats[si].maxLoseStreak > loseStreakKing.maxLoseStreak) loseStreakKing = stats[si];\n';
    js += '    }\n';
    js += '    // 玩家统计\n';
    js += '    for (var i = 0; i < stats.length; i++) {\n';
    js += '        var p = stats[i];\n';
    js += '        var scoreColor = p.score >= 0 ? "#ff6b6b" : "#51cf66";\n';
    js += '        var sign = p.score >= 0 ? "+" : "";\n';
    js += '        overviewHtml += \'<div class="detail-stat-card">\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-header"><span class="detail-stat-name">\' + (p.nickname ? (p.name + " / " + p.nickname) : p.name) + \'</span><span class="detail-stat-score" style="color:\' + scoreColor + \';">\' + sign + p.score + \'</span></div>\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-grid">\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#4cc9f0;">\' + p.winRate + \'</div><div class="detail-stat-item-label">胜率</div></div>\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#ff6b6b;">\' + p.winCount + \'</div><div class="detail-stat-item-label">获胜场次</div></div>\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#16a085;">\' + (p.selfDrawCount || 0) + \'</div><div class="detail-stat-item-label">自摸次数</div></div>\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#ffd43b;">\' + p.bankerCount + \'</div><div class="detail-stat-item-label">庄家次数</div></div>\';\n';
    js += '        overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#cc5de8;">\' + p.maxStreak + \'</div><div class="detail-stat-item-label">最高连胜</div></div>\';\n';
    js += '        overviewHtml += \'</div>\';\n';
    // 梁数统计（单独一行）
    js += '        if (p.liangCounts) {\n';
    js += '            var liangKeys = [3, 4, 5, 6, 7];\n';
    js += '            var liangLabels = { 3: "三梁", 4: "四梁", 5: "五梁", 6: "六梁", 7: "七梁" };\n';
    js += '            var hasLiang = false;\n';
    js += '            for (var li = 0; li < liangKeys.length; li++) { if ((p.liangCounts[liangKeys[li]] || 0) > 0) { hasLiang = true; break; } }\n';
    js += '            if (hasLiang) {\n';
    js += '                overviewHtml += \'<div class="detail-stat-grid" style="grid-template-columns:repeat(5,1fr);margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06);">\';\n';
    js += '                for (var li2 = 0; li2 < liangKeys.length; li2++) {\n';
    js += '                    var lk = liangKeys[li2];\n';
    js += '                    overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:#e67e22;">\' + (p.liangCounts[lk] || 0) + \'</div><div class="detail-stat-item-label">\' + liangLabels[lk] + \'</div></div>\';\n';
    js += '                }\n';
    js += '                overviewHtml += \'</div>\';\n';
    js += '            }\n';
    js += '        }\n';
    // 计分项胡牌次数（使用与上方统计一致的grid样式）\n';
    js += '        if (p.scoreItemCounts) {\n';
    js += '            var itemColors = { "摸张": "#e74c3c", "独赢": "#3498db", "东风": "#e67e22", "二五": "#2ecc71" };\n';
    js += '            var activeItems = [];\n';
    js += '            for (var itemName in p.scoreItemCounts) {\n';
    js += '                if (p.scoreItemCounts[itemName] > 0) activeItems.push(itemName);\n';
    js += '            }\n';
    js += '            if (activeItems.length > 0) {\n';
    js += '                var gridCols = activeItems.length;\n';
    js += '                overviewHtml += \'<div class="detail-stat-grid" style="grid-template-columns:repeat(\' + gridCols + \',1fr);margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.06);">\';\n';
    js += '                for (var ai = 0; ai < activeItems.length; ai++) {\n';
    js += '                    var itName = activeItems[ai];\n';
    js += '                    overviewHtml += \'<div class="detail-stat-item"><div class="detail-stat-item-val" style="color:\' + (itemColors[itName] || "#aaa") + \';">\' + p.scoreItemCounts[itName] + \'</div><div class="detail-stat-item-label">\' + itName + \'</div></div>\';\n';
    js += '                }\n';
    js += '                overviewHtml += \'</div>\';\n';
    js += '            }\n';
    js += '        }\n';
    js += '        overviewHtml += \'</div>\';\n';
    js += '    }\n';
    js += '    // 数据统计\n';
    js += '    overviewHtml += \'<div class="detail-awards">\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(255,99,99,0.2);color:#ff6363;"><i class="fas fa-arrow-up"></i></div><div class="detail-award-info"><div class="detail-award-label">最高分</div><div class="detail-award-name">\' + topScore.name + \'</div><div class="detail-award-val">\' + (topScore.maxRoundScore >= 0 ? "+" : "") + topScore.maxRoundScore + \'分</div></div></div>\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(81,207,102,0.2);color:#51cf66;"><i class="fas fa-arrow-down"></i></div><div class="detail-award-info"><div class="detail-award-label">最低分</div><div class="detail-award-name">\' + lowScore.name + \'</div><div class="detail-award-val">\' + (lowScore.minRoundScore >= 0 ? "+" : "") + lowScore.minRoundScore + \'分</div></div></div>\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(255,212,59,0.2);color:#ffd43b;"><i class="fas fa-crown"></i></div><div class="detail-award-info"><div class="detail-award-label">庄家王</div><div class="detail-award-name">\' + bankerKing.name + \'</div><div class="detail-award-val">\' + bankerKing.bankerCount + \'次庄</div></div></div>\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(255,107,107,0.2);color:#ff6b6b;"><i class="fas fa-trophy"></i></div><div class="detail-award-info"><div class="detail-award-label">赢家王</div><div class="detail-award-name">\' + winnerKing.name + \'</div><div class="detail-award-val">\' + winnerKing.winCount + \'胜</div></div></div>\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(204,93,232,0.2);color:#cc5de8;"><i class="fas fa-fire"></i></div><div class="detail-award-info"><div class="detail-award-label">连胜王</div><div class="detail-award-name">\' + streakKing.name + \'</div><div class="detail-award-val">\' + streakKing.maxStreak + \'连胜</div></div></div>\';\n';
    js += '    overviewHtml += \'<div class="detail-award-card"><div class="detail-award-icon" style="background:rgba(73,80,87,0.2);color:#adb5bd;"><i class="fas fa-skull"></i></div><div class="detail-award-info"><div class="detail-award-label">连败王</div><div class="detail-award-name">\' + loseStreakKing.name + \'</div><div class="detail-award-val">\' + loseStreakKing.maxLoseStreak + \'连败</div></div></div>\';\n';
    js += '    overviewHtml += \'</div>\';\n';
    js += '\n';
    // 额外分设置历史\n';
    js += '    var extraHistory = settlement.extraScoreHistory || settlement.extraScoreRecords || [];\n';
    js += '    if (extraHistory.length > 0) {\n';
    js += '        overviewHtml += \'<div style="margin-top:10px;padding:10px;background:rgba(255,212,59,0.05);border:1px solid rgba(255,212,59,0.15);border-radius:8px;">\';\n';
    js += '        overviewHtml += \'<div style="font-size:0.8rem;font-weight:600;color:#ffd43b;margin-bottom:6px;"><i class="fas fa-coins"></i> 庄家额外分设置记录</div>\';\n';
    js += '        for (var ei = 0; ei < extraHistory.length; ei++) {\n';
    js += '            var rec = extraHistory[ei];\n';
    js += '            overviewHtml += \'<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.75rem;color:#bbb;border-bottom:1px solid rgba(255,255,255,0.04);">\';\n';
    js += '            overviewHtml += \'<span>\' + rec.playerName + \' 设置额外分</span>\';\n';
    js += '            overviewHtml += \'<span><strong style="color:#ffd43b;">+\' + rec.score + \'</strong> <span style="color:#666;margin-left:8px;">\' + rec.time + \'</span></span>\';\n';
    js += '            overviewHtml += \'</div>\';\n';
    js += '        }\n';
    js += '        overviewHtml += \'</div>\';\n';
    js += '    }\n';
    js += '\n';
    // 台费收支汇总（结算详情总览）
    js += '    var tfRecords = settlement.tableFeeRecords || (settlement.history || []).filter(function(hr){ return hr.type === "tableFee"; });\n';
    js += '    if (tfRecords.length > 0) {\n';
    js += '        var totalFee = settlement.totalTableFee || 0;\n';
    js += '        if (!totalFee) { for (var tfi2 = 0; tfi2 < tfRecords.length; tfi2++) { totalFee += (tfRecords[tfi2].tableFee || 0); } }\n';
    js += '        overviewHtml += \'<div style="margin-top:10px;padding:10px;background:rgba(241,196,15,0.06);border:1px solid rgba(241,196,15,0.2);border-radius:8px;">\';\n';
    js += '        overviewHtml += \'<div style="font-size:0.8rem;font-weight:600;color:#f1c40f;margin-bottom:6px;"><i class="fas fa-money-bill-wave"></i> 台费收支（共 \' + tfRecords.length + \' 次，合计 \' + totalFee + \'）</div>\';\n';
    js += '        for (var tfi3 = 0; tfi3 < tfRecords.length; tfi3++) {\n';
    js += '            var tfRec = tfRecords[tfi3];\n';
    js += '            var tfTime = formatRoundTime(tfRec.timestamp);\n';
    js += '            overviewHtml += \'<div style="padding:4px 0;font-size:0.75rem;color:#ccc;border-bottom:1px solid rgba(255,255,255,0.05);">\';\n';
    js += '            overviewHtml += \'<div style="display:flex;justify-content:space-between;"><span><strong style="color:#f1c40f;">\' + (tfRec.initiatorName || "未知") + \'</strong> 发起台费 \' + (tfRec.tableFee || 0) + \'</span><span style="color:#666;">\' + tfTime + \'</span></div>\';\n';
    js += '            var tfPlist = tfRec.players || [];\n';
    js += '            for (var tfi4 = 0; tfi4 < tfPlist.length; tfi4++) {\n';
    js += '                var tfp2 = tfPlist[tfi4];\n';
    js += '                var tfName2 = tfp2.name || "未知";\n';
    js += '                var tfIs2 = (tfp2.isInitiator !== undefined) ? tfp2.isInitiator : (tfp2.muzzleType === tfRec.initiatorMuzzle);\n';
    js += '                var tfNet2 = (tfp2.netChange !== undefined) ? tfp2.netChange : (tfIs2 ? ((tfRec.tableFee||0) - (tfp2.deduction||0)) : -(tfp2.deduction||0));\n';
    js += '                var tfCol2 = tfNet2 > 0 ? "#ffd43b" : (tfNet2 < 0 ? "#ff6b6b" : "#888");\n';
    js += '                var tfSig2 = tfNet2 > 0 ? "+" : (tfNet2 < 0 ? "-" : "");\n';
    js += '                overviewHtml += \'<div style="display:flex;justify-content:space-between;padding:2px 0 2px 12px;font-size:0.7rem;color:#aaa;"><span>\' + (tfIs2 ? (tfName2 + "（发起人，收入）") : (tfName2 + "（支出）")) + \'</span><span style="color:\' + tfCol2 + \';font-weight:600;">\' + tfSig2 + Math.abs(tfNet2) + \'</span></div>\';\n';
    js += '            }\n';
    js += '            overviewHtml += \'</div>\';\n';
    js += '        }\n';
    js += '        overviewHtml += \'</div>\';\n';
    js += '    }\n';
    js += '\n';
    js += '    // 备注编辑区域\n';
    js += '    var currentRemark = settlement.remark || "";\n';
    js += '    overviewHtml += \'<div class="detail-remark-section"><div class="detail-remark-label"><i class="fas fa-sticky-note"></i> 备注</div>\';\n';
    js += '    overviewHtml += \'<textarea id="detailRemarkInput" class="detail-remark-input" placeholder="点击输入备注信息..." maxlength="200">\' + currentRemark.replace(/</g, "&lt;").replace(/>/g, "&gt;") + \'</textarea>\';\n';
    js += '    overviewHtml += \'<button id="detailRemarkSaveBtn" class="detail-remark-save-btn">保存备注</button></div>\';\n';
    js += '\n';
    js += '    var roundsTabRendered = false;\n';
    js += '    function renderRoundsTab() {\n';
    js += '        var panel = modal.querySelector("[data-dpanel=\\\'rounds\\\']");\n';
    js += '        if (!panel) return;\n';
    js += '        var hist = settlement.history || [];\n';
    js += '        panel.innerHTML = \'<div style="padding:10px 0;"><div style="padding:10px 16px;background:rgba(255,255,255,0.03);font-weight:600;font-size:0.9rem;color:#ccc;">对局详情（\' + sTotalRounds + \'局）</div><div id="roundsListContainer"></div></div>\';\n';
    js += '        var listContainer = panel.querySelector("#roundsListContainer");\n';
    js += '        if (!listContainer) return;\n';
    js += '        var batchHtml = "";\n';
    js += '        for (var r = 0; r < hist.length; r++) {\n';
    js += '            var rec = hist[r];\n';
    // 台费记录：单独渲染收支信息
    js += '            if (rec.type === "tableFee") {\n';
    js += '                var tfTime = formatRoundTime(rec.timestamp);\n';
    js += '                var tfHtml = \'<div class="detail-round-item detail-round-tablefee" data-round="\' + (rec.round || 0) + \'">\' +\n';
    js += '                    \'<div class="detail-round-header"><span class="detail-round-num"><i class="fas fa-money-bill-wave" style="color:#f1c40f;"></i> 台费划扣 <span class="detail-round-time">\' + tfTime + \'</span></span><span><span class="detail-round-arrow"><i class="fas fa-chevron-down"></i></span></span></div>\' +\n';
    js += '                    \'<div class="detail-round-info" style="color:#e6c33a;">发起人:<span style="color:#f1c40f;font-weight:600;">\' + (rec.initiatorName || "未知") + \'</span> ｜ 总台费:<span style="color:#f1c40f;font-weight:600;">\' + (rec.tableFee || 0) + \'</span> ｜ 每人扣除:<span style="color:#f1c40f;font-weight:600;">\' + (rec.feePerPlayer || 0) + \'</span></div>\' +\n';
    js += '                    \'<div class="detail-round-expand"><div style="font-size:0.72rem;color:#888;margin-bottom:5px;">各玩家台费收支</div><div class="detail-round-payment-grid">\';\n';
    js += '                var tfRecPlayers = rec.players || [];\n';
    js += '                if (tfRecPlayers.length === 0 && settlement.players) { tfRecPlayers = settlement.players; }\n';
    js += '                for (var tfi = 0; tfi < tfRecPlayers.length; tfi++) {\n';
    js += '                    var tfp = tfRecPlayers[tfi];\n';
    js += '                    var tfName = tfp.name || "未知";\n';
    js += '                    var tfDeduction = (tfp.deduction !== undefined) ? tfp.deduction : (rec.feePerPlayer || 0);\n';
    js += '                    var tfIsInit = (tfp.isInitiator !== undefined) ? tfp.isInitiator : (tfp.muzzleType === rec.initiatorMuzzle);\n';
    js += '                    var tfNet = (tfp.netChange !== undefined) ? tfp.netChange : (tfIsInit ? ((rec.tableFee || 0) - tfDeduction) : (-tfDeduction));\n';
    js += '                    var tfCls = tfNet > 0 ? "win" : (tfNet < 0 ? "lose" : "");\n';
    js += '                    var tfSign = tfNet > 0 ? "+" : (tfNet < 0 ? "-" : "");\n';
    js += '                    var tfLabel = tfIsInit ? (tfName + "（发起人）") : tfName;\n';
    js += '                    tfHtml += \'<div class="detail-round-payment-item"><span class="detail-round-payment-name">\' + tfLabel + \'</span><span class="detail-round-payment-amt \' + tfCls + \'">\' + tfSign + Math.abs(tfNet) + \'</span></div>\';\n';
    js += '                }\n';
    js += '                tfHtml += \'</div></div></div>\';\n';
    js += '                batchHtml += tfHtml;\n';
    js += '                continue;\n';
    js += '            }\n';
    js += '            var winnerName = rec.winnerId ? (settlement.players[rec.winnerId - 1] && settlement.players[rec.winnerId - 1].name || "未知") : "未知";\n';
    js += '            var bankerName = rec.bankerId ? (settlement.players[rec.bankerId - 1] && settlement.players[rec.bankerId - 1].name || "未知") : "未知";\n';
    js += '            var detailsStr = rec.details ? rec.details.join("、") : "无计分项";\n';
    js += '            var paymentHtml = "";\n';
    js += '            if (rec.playerPayments && rec.playerPayments.length > 0) {\n';
    js += '                paymentHtml = \'<div class="detail-round-payment-grid">\';\n';
    js += '                for (var pi = 0; pi < rec.playerPayments.length; pi++) {\n';
    js += '                    var pay = rec.playerPayments[pi];\n';
    js += '                    var payCls = pay.amount < 0 ? "win" : (pay.amount > 0 ? "lose" : "");\n';
    js += '                    var paySign = pay.amount < 0 ? "+" : (pay.amount > 0 ? "-" : "");\n';
    js += '                    var absAmt = Math.abs(pay.amount);\n';
    js += '                    paymentHtml += \'<div class="detail-round-payment-item"><span class="detail-round-payment-name">\' + pay.name + \'</span><span class="detail-round-payment-amt \' + payCls + \'">\' + paySign + absAmt + \'</span></div>\';\n';
    js += '                }\n';
    js += '                paymentHtml += \'</div>\';\n';
    js += '            }\n';
    js += '            var scoreTagsHtml = "";\n';
    js += '            if (rec.details && rec.details.length > 0) {\n';
    js += '                scoreTagsHtml = \'<div class="detail-round-score-tags">\';\n';
    js += '                for (var di = 0; di < rec.details.length; di++) {\n';
    js += '                    scoreTagsHtml += \'<span class="detail-round-score-tag">\' + rec.details[di] + \'</span>\';\n';
    js += '                }\n';
    js += '                scoreTagsHtml += \'</div>\';\n';
    js += '            }\n';
    js += '            var roundTime = formatRoundTime(rec.timestamp);\n';
    js += '            batchHtml += \'<div class="detail-round-item" data-round="\' + rec.round + \'">\' +\n';
    js += '                \'<div class="detail-round-header"><span class="detail-round-num">第\' + rec.round + \'局 <span class="detail-round-time">\' + roundTime + \'</span></span><span><span class="detail-round-arrow"><i class="fas fa-chevron-down"></i></span></span></div>\' +\n';
    js += '                \'<div class="detail-round-info">赢家:<span class="winner">\' + winnerName + \'</span> 庄家:<span class="banker">\' + bankerName + \'</span></div>\' +\n';
    js += '                \'<div class="detail-round-details">\' + detailsStr + \'</div>\' +\n';
    js += '                \'<div class="detail-round-expand">\' +\n';
    js += '                    \'<div style="font-size:0.72rem;color:#888;margin-bottom:5px;">各玩家收支</div>\' + paymentHtml +\n';
    js += '                    (scoreTagsHtml ? \'<div style="font-size:0.72rem;color:#888;margin:8px 0 5px 0;">计分项</div>\' + scoreTagsHtml : "") +\n';
    js += '                \'</div>\' +\n';
    js += '                \'</div>\';\n';
    js += '        }\n';
    js += '        listContainer.innerHTML = batchHtml;\n';
    js += '        bindRoundExpand();\n';
    js += '        roundsTabRendered = true;\n';
    js += '    }\n';
    js += '\n';
    js += '    content.innerHTML = \n';
    js += '        \'<div class="detail-modal-header"><h3>结算详情</h3><button class="detail-modal-close">×</button></div>\' +\n';
    js += '        \'<div class="detail-modal-tabs">\' +\n';
    js += '            \'<button class="detail-tab-btn active" data-dtab="overview">总览</button>\' +\n';
    js += '            \'<button class="detail-tab-btn" data-dtab="chart">分数变化图</button>\' +\n';
    js += '            \'<button class="detail-tab-btn" data-dtab="rounds">对局详情</button>\' +\n';
    js += '        \'</div>\' +\n';
    js += '        \'<div class="detail-tab-panel active" data-dpanel="overview">\' + overviewHtml + \'</div>\' +\n';
    js += '        \'<div class="detail-tab-panel" data-dpanel="chart">\' +\n';
    js += '            \'<div class="detail-chart-picker" id="detailChartPicker"></div>\' +\n';
    js += '            \'<div style="display:flex;justify-content:flex-end;margin-bottom:4px;"><button id="detailChartResetZoom" style="padding:4px 12px;background:#4cc9f0;color:#1a1a2e;border:none;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:600;">重置缩放</button></div>\' +\n';
    js += '            \'<div class="detail-chart-container"><canvas id="detailChartCanvas"></canvas></div>\' +\n';
    js += '            \'<div class="detail-chart-details" id="detailChartDetails">点击图中的数据点查看详细信息</div>\' +\n';
    js += '            \'<div style="text-align:center;padding:4px;font-size:0.7rem;color:#666;">双指缩放/拖拽平移 ｜ 鼠标滚轮缩放</div>\' +\n';
    js += '        \'</div>\' +\n';
    js += '        \'<div class="detail-tab-panel" data-dpanel="rounds"><div style="padding:40px;text-align:center;color:#666;"><i class="fas fa-spinner fa-spin" style="font-size:1.5rem;"></i><div style="margin-top:8px;">点击加载对局详情...</div></div></div>\';\n';
    js += '\n';
    js += '    function renderPicker() {\n';
    js += '        var picker = modal.querySelector("#detailChartPicker");\n';
    js += '        if (!picker) return;\n';
    js += '        picker.innerHTML = "";\n';
    js += '        var allChip = document.createElement("div");\n';
    js += '        allChip.className = "chart-chip" + (detailChartState.playerId === null ? " active" : "");\n';
    js += '        allChip.style.borderColor = "#4cc9f0";\n';
    js += '        allChip.style.color = "#4cc9f0";\n';
    js += '        if (detailChartState.playerId === null) allChip.style.background = "#4cc9f0";\n';
    js += '        allChip.textContent = "全部玩家";\n';
    js += '        allChip.addEventListener("click", function() {\n';
    js += '            detailChartState.playerId = null;\n';
    js += '            renderPicker();\n';
    js += '            renderDetailChart();\n';
    js += '        });\n';
    js += '        picker.appendChild(allChip);\n';
    js += '        for (var i = 0; i < stats.length; i++) {\n';
    js += '            var p = stats[i];\n';
    js += '            var color = colorMap[p.muzzleType] || "#888";\n';
    js += '            var chip = document.createElement("div");\n';
    js += '            chip.className = "chart-chip" + (detailChartState.playerId === p.id ? " active" : "");\n';
    js += '            chip.style.borderColor = color;\n';
    js += '            chip.style.color = color;\n';
    js += '            if (detailChartState.playerId === p.id) chip.style.background = color;\n';
    js += '            chip.textContent = p.name;\n';
    js += '            chip.addEventListener("click", (function(pid) { return function() {\n';
    js += '                detailChartState.playerId = pid;\n';
    js += '                renderPicker();\n';
    js += '                renderDetailChart();\n';
    js += '            }; })(p.id));\n';
    js += '            picker.appendChild(chip);\n';
    js += '        }\n';
    js += '    }\n';
    js += '\n';
    js += '    function renderDetailChart() {\n';
    js += '        var canvas = modal.querySelector("#detailChartCanvas");\n';
    js += '        if (!canvas || typeof Chart === "undefined") return;\n';
    js += '        if (currentDetailChart) { currentDetailChart.destroy(); currentDetailChart = null; }\n';
    js += '        var targets = detailChartState.playerId === null ? stats : stats.filter(function(p) { return p.id === detailChartState.playerId; });\n';
    js += '        if (targets.length === 0 || (settlement.history || []).length === 0) return;\n';
    js += '        var allRounds = {};\n';
    js += '        for (var i = 0; i < targets.length; i++) {\n';
    js += '            var pts = buildSettlementScoreData(settlement, targets[i].id);\n';
    js += '            for (var j = 0; j < pts.length; j++) allRounds[pts[j].round] = true;\n';
    js += '        }\n';
    js += '        var sortedRounds = Object.keys(allRounds).map(Number).sort(function(a,b) { return a - b; });\n';
    js += '        var labels = sortedRounds.map(function(r) { return r === 0 ? "开始" : "第" + r + "局"; });\n';
    js += '        var datasets = [];\n';
    js += '        for (var k = 0; k < targets.length; k++) {\n';
    js += '            var player = targets[k];\n';
    js += '            var points = buildSettlementScoreData(settlement, player.id);\n';
    js += '            var color = colorMap[player.muzzleType] || "#888";\n';
    js += '            var bgColor = color + "29";\n';
    js += '            var dataByRound = {};\n';
    js += '            for (var p = 0; p < points.length; p++) dataByRound[points[p].round] = points[p];\n';
    js += '            var data = [];\n';
    js += '            var lastVal = 0;\n';
    js += '            for (var r = 0; r < sortedRounds.length; r++) {\n';
    js += '                var pt = dataByRound[sortedRounds[r]];\n';
    js += '                if (pt) { lastVal = pt.score; data.push(pt.score); } else { data.push(lastVal); }\n';
    js += '            }\n';
    js += '            datasets.push({\n';
    js += '                label: player.name,\n';
    js += '                data: data,\n';
    js += '                borderColor: color,\n';
    js += '                backgroundColor: bgColor,\n';
    js += '                borderWidth: 2,\n';
    js += '                fill: targets.length === 1,\n';
    js += '                tension: 0.25,\n';
    js += '                pointRadius: 4,\n';
    js += '                pointHoverRadius: 7,\n';
    js += '                pointBackgroundColor: color,\n';
    js += '                pointBorderColor: "#fff",\n';
    js += '                pointBorderWidth: 1.5,\n';
    js += '                _rawPoints: points,\n';
    js += '                _rounds: sortedRounds\n';
    js += '            });\n';
    js += '        }\n';
    js += '        var ctx = canvas.getContext("2d");\n';
    js += '        currentDetailChart = new Chart(ctx, {\n';
    js += '            type: "line",\n';
    js += '            data: { labels: labels, datasets: datasets },\n';
    js += '            options: {\n';
    js += '                responsive: true,\n';
    js += '                maintainAspectRatio: false,\n';
    js += '                plugins: {\n';
    js += '                    legend: { display: targets.length > 1, position: "top", labels: { boxWidth: 12, font: { size: 11 }, color: "#ccc" } },\n';
    js += '                    tooltip: {\n';
    js += '                        callbacks: {\n';
    js += '                            title: function(items) { var r = sortedRounds[items[0].dataIndex]; return r === 0 ? "游戏开始" : "第" + r + "局"; },\n';
    js += '                            label: function(item) { return item.dataset.label + ": " + item.parsed.y; }\n';
    js += '                        }\n';
    js += '                    }\n';
    js += '                },\n';
    js += '                scales: {\n';
    js += '                    x: { ticks: { color: "#888", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } },\n';
    js += '                    y: { ticks: { color: "#888", font: { size: 10 } }, grid: { color: "rgba(255,255,255,0.05)" } }\n';
    js += '                },\n';
    js += '                onClick: function(evt, elements, chartInst) {\n';
    js += '                    if (!elements || elements.length === 0) return;\n';
    js += '                    var el = elements[0];\n';
    js += '                    var ds = chartInst.data.datasets[el.datasetIndex];\n';
    js += '                    var round = sortedRounds[el.index];\n';
    js += '                    var pt = null;\n';
    js += '                    for (var i = 0; i < (ds._rawPoints || []).length; i++) { if (ds._rawPoints[i].round === round) { pt = ds._rawPoints[i]; break; } }\n';
    js += '                    if (pt) showChartPointDetails(pt);\n';
    js += '                }\n';
    js += '            }\n';
    js += '        });\n';
    js += '        // 绑定缩放/平移\n';
    js += '        bindDetailChartZoom(canvas, labels);\n';
    js += '    }\n';
    js += '\n';
    js += '    var detailZoomView = { start: 0, end: 0, ready: false };\n';
    js += '    function bindDetailChartZoom(canvas, labels) {\n';
    js += '        if (!canvas || !currentDetailChart) return;\n';
    js += '        var n = labels.length;\n';
    js += '        detailZoomView = { start: 0, end: Math.max(0, n - 1), ready: false };\n';
    js += '        function clampView() {\n';
    js += '            if (detailZoomView.end > n - 1) detailZoomView.end = n - 1;\n';
    js += '            if (detailZoomView.start < 0) detailZoomView.start = 0;\n';
    js += '            if (detailZoomView.start > detailZoomView.end) detailZoomView.start = detailZoomView.end;\n';
    js += '        }\n';
    js += '        function span() { return Math.max(1, detailZoomView.end - detailZoomView.start); }\n';
    js += '        function applyZoom() {\n';
    js += '            if (!currentDetailChart) return;\n';
    js += '            clampView();\n';
    js += '            try {\n';
    js += '                if (detailZoomView.ready && detailZoomView.end > detailZoomView.start) {\n';
    js += '                    currentDetailChart.options.scales.x.min = labels[detailZoomView.start];\n';
    js += '                    currentDetailChart.options.scales.x.max = labels[detailZoomView.end];\n';
    js += '                } else {\n';
    js += '                    currentDetailChart.options.scales.x.min = undefined;\n';
    js += '                    currentDetailChart.options.scales.x.max = undefined;\n';
    js += '                }\n';
    js += '                currentDetailChart.update("none");\n';
    js += '            } catch(e) {}\n';
    js += '        }\n';
    js += '        // 双指缩放+平移\n';
    js += '        var pinch = null;\n';
    js += '        var singleDrag = null;\n';
    js += '        canvas.addEventListener("touchstart", function(e) {\n';
    js += '            if (e.touches.length === 2) {\n';
    js += '                singleDrag = null;\n';
    js += '                var t0 = e.touches[0], t1 = e.touches[1];\n';
    js += '                pinch = { startDist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) || 1, startMid: (t0.clientX + t1.clientX) / 2, startSpan: span(), startViewStart: detailZoomView.start, rect: canvas.getBoundingClientRect(), lastMid: (t0.clientX + t1.clientX) / 2 };\n';
    js += '            } else if (e.touches.length === 1 && detailZoomView.ready) {\n';
    js += '                singleDrag = { startX: e.touches[0].clientX, rect: canvas.getBoundingClientRect(), lastX: e.touches[0].clientX };\n';
    js += '            }\n';
    js += '        }, { passive: true });\n';
    js += '        canvas.addEventListener("touchmove", function(e) {\n';
    js += '            if (e.touches.length === 2 && pinch) {\n';
    js += '                singleDrag = null;\n';
    js += '                e.preventDefault();\n';
    js += '                var t0 = e.touches[0], t1 = e.touches[1];\n';
    js += '                var dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY) || 1;\n';
    js += '                var mid = (t0.clientX + t1.clientX) / 2;\n';
    js += '                if (n === 0) return;\n';
    js += '                var zRatio = pinch.startDist / dist;\n';
    js += '                var newSpan = Math.round(pinch.startSpan * zRatio);\n';
    js += '                newSpan = Math.max(2, Math.min(n - 1, newSpan));\n';
    js += '                var centerRatio = (pinch.startMid - pinch.rect.left) / pinch.rect.width;\n';
    js += '                var centerIdx = pinch.startViewStart + centerRatio * pinch.startSpan;\n';
    js += '                detailZoomView.start = Math.round(centerIdx - newSpan / 2);\n';
    js += '                detailZoomView.end = detailZoomView.start + newSpan;\n';
    js += '                detailZoomView.ready = true;\n';
    js += '                clampView();\n';
    js += '                var midDelta = mid - pinch.lastMid;\n';
    js += '                var pixPerItem = pinch.rect.width / Math.max(1, span());\n';
    js += '                var panShift = Math.round(midDelta / pixPerItem);\n';
    js += '                detailZoomView.start -= panShift; detailZoomView.end -= panShift;\n';
    js += '                clampView(); applyZoom();\n';
    js += '                pinch.lastMid = mid;\n';
    js += '            } else if (e.touches.length === 1 && singleDrag && detailZoomView.ready) {\n';
    js += '                e.preventDefault();\n';
    js += '                var dx = e.touches[0].clientX - singleDrag.lastX;\n';
    js += '                var pixPerItem = singleDrag.rect.width / Math.max(1, span());\n';
    js += '                var shift = Math.round(dx / pixPerItem);\n';
    js += '                if (shift !== 0) {\n';
    js += '                    detailZoomView.start -= shift;\n';
    js += '                    detailZoomView.end -= shift;\n';
    js += '                    clampView(); applyZoom();\n';
    js += '                    singleDrag.lastX = e.touches[0].clientX;\n';
    js += '                }\n';
    js += '            }\n';
    js += '        }, { passive: false });\n';
    js += '        function endTouch(e) {\n';
    js += '            if (!e.touches || e.touches.length < 2) pinch = null;\n';
    js += '            if (!e.touches || e.touches.length === 0) singleDrag = null;\n';
    js += '        }\n';
    js += '        canvas.addEventListener("touchend", endTouch, { passive: true });\n';
    js += '        canvas.addEventListener("touchcancel", endTouch, { passive: true });\n';
    js += '        // 滚轮缩放（桌面）\n';
    js += '        canvas.addEventListener("wheel", function(e) {\n';
    js += '            if (!currentDetailChart || !labels.length) return;\n';
    js += '            e.preventDefault();\n';
    js += '            var rect = canvas.getBoundingClientRect();\n';
    js += '            var centerRatio = (e.clientX - rect.left) / rect.width;\n';
    js += '            var centerIdx = detailZoomView.start + centerRatio * span();\n';
    js += '            var factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;\n';
    js += '            var newSpan = Math.round(span() * factor);\n';
    js += '            newSpan = Math.max(2, Math.min(n - 1, newSpan));\n';
    js += '            detailZoomView.start = Math.round(centerIdx - newSpan / 2);\n';
    js += '            detailZoomView.end = detailZoomView.start + newSpan;\n';
    js += '            detailZoomView.ready = true;\n';
    js += '            clampView(); applyZoom();\n';
    js += '        }, { passive: false });\n';
    js += '        // 重置按钮\n';
    js += '        var resetBtn = modal.querySelector("#detailChartResetZoom");\n';
    js += '        if (resetBtn) {\n';
    js += '            resetBtn.onclick = function() {\n';
    js += '                detailZoomView = { start: 0, end: Math.max(0, n - 1), ready: false };\n';
    js += '                applyZoom();\n';
    js += '            };\n';
    js += '        }\n';
    js += '    }\n';
    js += '\n';
    js += '    function showChartPointDetails(point) {\n';
    js += '        var detailsEl = modal.querySelector("#detailChartDetails");\n';
    js += '        if (!detailsEl) return;\n';
    js += '        var player = settlement.players[point.playerId - 1];\n';
    js += '        var playerName = player ? player.name : "未知";\n';
    js += '        if (point.isStart) {\n';
    js += '            detailsEl.innerHTML = \'<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;"><div>玩家: <strong>\' + playerName + \'</strong></div><div>时间: 游戏开始</div><div>累计: <strong>0</strong></div></div>\';\n';
    js += '            return;\n';
    js += '        }\n';
    js += '        var winner = settlement.players[point.winnerId - 1];\n';
    js += '        var banker = settlement.players[point.bankerId - 1];\n';
    js += '        var changeStr = (point.change > 0 ? "+" : "") + point.change;\n';
    js += '        var changeColor = point.change > 0 ? "#ff6b6b" : "#51cf66";\n';
    js += '        var roundRecord = null;\n';
    js += '        for (var ri = 0; ri < (settlement.history || []).length; ri++) {\n';
    js += '            if (settlement.history[ri].round === point.round) { roundRecord = settlement.history[ri]; break; }\n';
    js += '        }\n';
    js += '        var roundTime = roundRecord ? formatRoundTime(roundRecord.timestamp) : "";\n';
    js += '        var detailsStr = \'<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:0.78rem;margin-bottom:8px;">\' +\n';
    js += '            \'<div>玩家: <strong>\' + playerName + \'</strong></div>\' +\n';
    js += '            \'<div>局数: 第\' + point.round + \'局</div>\' +\n';
    js += '            \'<div>时间: \' + roundTime + \'</div>\' +\n';
    js += '            \'<div>本局变化: <strong style="color:\' + changeColor + \';">\' + changeStr + \'</strong></div>\' +\n';
    js += '            \'<div>累计: <strong>\' + point.score + \'</strong></div>\' +\n';
    js += '            \'<div>赢家: \' + (winner ? winner.name : "-") + \'</div>\' +\n';
    js += '            \'<div>庄家: \' + (banker ? banker.name : "-") + \'</div>\' +\n';
    js += '            \'</div>\';\n';
    js += '        if (roundRecord) {\n';
    js += '            detailsStr += \'<div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:8px;margin-bottom:8px;">\';\n';
    js += '            detailsStr += \'<div style="font-size:0.75rem;color:#888;margin-bottom:5px;">计分项</div>\';\n';
    js += '            if (roundRecord.details && roundRecord.details.length > 0) {\n';
    js += '                detailsStr += \'<div style="display:flex;flex-wrap:wrap;gap:4px;">\';\n';
    js += '                for (var di = 0; di < roundRecord.details.length; di++) {\n';
    js += '                    detailsStr += \'<span style="padding:2px 8px;background:rgba(76,201,240,0.15);color:#4cc9f0;border-radius:10px;font-size:0.72rem;">\' + roundRecord.details[di] + \'</span>\';\n';
    js += '                }\n';
    js += '                detailsStr += \'</div>\';\n';
    js += '            } else { detailsStr += \'<div style="font-size:0.75rem;color:#666;">无计分项</div>\'; }\n';
    js += '            detailsStr += \'</div>\';\n';
    js += '            if (roundRecord.playerPayments && roundRecord.playerPayments.length > 0) {\n';
    js += '                detailsStr += \'<div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:8px;">\';\n';
    js += '                detailsStr += \'<div style="font-size:0.75rem;color:#888;margin-bottom:5px;">各玩家收支</div>\';\n';
    js += '                detailsStr += \'<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:0.75rem;">\';\n';
    js += '                for (var pi = 0; pi < roundRecord.playerPayments.length; pi++) {\n';
    js += '                    var pay = roundRecord.playerPayments[pi];\n';
    js += '                    var payColor = pay.amount < 0 ? "#ff6b6b" : (pay.amount > 0 ? "#51cf66" : "#888");\n';
    js += '                    var paySign = pay.amount < 0 ? "+" : (pay.amount > 0 ? "-" : "");\n';
    js += '                    var absAmt = Math.abs(pay.amount);\n';
    js += '                    detailsStr += \'<div style="display:flex;justify-content:space-between;padding:3px 6px;background:rgba(255,255,255,0.04);border-radius:4px;"><span style="color:#ccc;">\' + pay.name + \'</span><span style="color:\' + payColor + \';font-weight:600;">\' + paySign + absAmt + \'</span></div>\';\n';
    js += '                }\n';
    js += '                detailsStr += \'</div></div>\';\n';
    js += '            }\n';
    js += '        }\n';
    js += '        detailsEl.innerHTML = detailsStr;\n';
    js += '    }\n';
    js += '\n';
    js += '    var dTabs = modal.querySelectorAll(".detail-tab-btn");\n';
    js += '    for (var t = 0; t < dTabs.length; t++) {\n';
    js += '        (function(btn) {\n';
    js += '            btn.addEventListener("click", function() {\n';
    js += '                var dtab = btn.getAttribute("data-dtab");\n';
    js += '                var allBtns = modal.querySelectorAll(".detail-tab-btn");\n';
    js += '                for (var i = 0; i < allBtns.length; i++) { allBtns[i].classList.remove("active"); }\n';
    js += '                btn.classList.add("active");\n';
    js += '                var allPanels = modal.querySelectorAll(".detail-tab-panel");\n';
    js += '                for (var j = 0; j < allPanels.length; j++) { allPanels[j].classList.remove("active"); }\n';
    js += '                var target = modal.querySelector("[data-dpanel=\'" + dtab + "\']");\n';
    js += '                if (target) target.classList.add("active");\n';
    js += '                if (dtab === "chart") {\n';
    js += '                    setTimeout(function() { renderPicker(); renderDetailChart(); }, 50);\n';
    js += '                } else if (dtab === "rounds") {\n';
    js += '                    setTimeout(function() { if (!roundsTabRendered) renderRoundsTab(); }, 50);\n';
    js += '                }\n';
    js += '            });\n';
    js += '        })(dTabs[t]);\n';
    js += '    }\n';
    js += '\n';
    js += '    function bindRoundExpand() {\n';
    js += '        var items = modal.querySelectorAll(".detail-round-item");\n';
    js += '        for (var i = 0; i < items.length; i++) {\n';
    js += '            (function(item) {\n';
    js += '                if (item._bound) return;\n';
    js += '                item._bound = true;\n';
    js += '                item.addEventListener("click", function() {\n';
    js += '                    item.classList.toggle("expanded");\n';
    js += '                });\n';
    js += '            })(items[i]);\n';
    js += '        }\n';
    js += '    }\n';
    js += '\n';
    js += '    modal.querySelector(".detail-modal-close").addEventListener("click", closeModal);\n';
    js += '    modal.addEventListener("click", function(e) { if (e.target === modal) closeModal(); });\n';
    js += '    // 备注保存按钮\n';
    js += '    var remarkSaveBtn = modal.querySelector("#detailRemarkSaveBtn");\n';
    js += '    if (remarkSaveBtn) {\n';
    js += '        remarkSaveBtn.addEventListener("click", function() {\n';
    js += '            var input = modal.querySelector("#detailRemarkInput");\n';
    js += '            if (!input) return;\n';
    js += '            var remarkVal = input.value.trim();\n';
    js += '            remarkSaveBtn.disabled = true;\n';
    js += '            remarkSaveBtn.textContent = "保存中...";\n';
    js += '            var xhr = new XMLHttpRequest();\n';
    js += '            xhr.open("POST", API_BASE + "/api/update-settlement-remark", true);\n';
    js += '            xhr.setRequestHeader("Content-Type", "application/json");\n';
    js += '            xhr.onreadystatechange = function() {\n';
    js += '                if (xhr.readyState === 4) {\n';
    js += '                    remarkSaveBtn.disabled = false;\n';
    js += '                    remarkSaveBtn.textContent = "保存备注";\n';
    js += '                    if (xhr.status === 200) {\n';
    js += '                        try { var resp = JSON.parse(xhr.responseText); if (resp.success) { remarkSaveBtn.textContent = "已保存 ✓"; setTimeout(function() { remarkSaveBtn.textContent = "保存备注"; }, 2000); currentRemark = remarkVal; settlement.remark = remarkVal; } } catch(e) {}\n';
    js += '                    } else { remarkSaveBtn.textContent = "保存失败，重试"; }\n';
    js += '                }\n';
    js += '            };\n';
    js += '            xhr.send(JSON.stringify({ id: settlement.id, remark: remarkVal }));\n';
    js += '        });\n';
    js += '    }\n';
    js += '    function closeModal() {\n';
    js += '        if (currentDetailChart) { currentDetailChart.destroy(); currentDetailChart = null; }\n';
    js += '        document.body.removeChild(modal);\n';
    js += '    }\n';
    js += '    } catch(e) { content.innerHTML = \'<div style="padding:30px;text-align:center;color:#e74c3c;"><i class="fas fa-exclamation-triangle"></i> 渲染失败</div>\'; var closeBtn = document.createElement("button"); closeBtn.textContent = "关闭"; closeBtn.style.cssText = "display:block;margin:10px auto;padding:8px 24px;background:#4cc9f0;border:none;border-radius:8px;cursor:pointer;"; closeBtn.onclick = function() { document.body.removeChild(modal); }; content.appendChild(closeBtn); }\n';
    js += '    }, 50);\n';
    js += '}\n';
    return js;
}

    // ====== DOMContentLoaded ======
    html += 'document.addEventListener("DOMContentLoaded", function() {\n';

    // Card collapse/expand - only bind to logCardTitle (data card is always expanded)
    html += '    var cardTitleIds = ["logCardTitle"];\n';
    html += '    for (var i = 0; i < cardTitleIds.length; i++) {\n';
    html += '        (function(tid) {\n';
    html += '            var el = document.getElementById(tid);\n';
    html += '            if (el) {\n';
    html += '                el.addEventListener("click", function(e) {\n';
    html += '                    if (e.target.closest(".tab-btn")) return;\n';
    html += '                    toggleCard(el);\n';
    html += '                });\n';
    html += '            }\n';
    html += '        })(cardTitleIds[i]);\n';
    html += '    }\n';

    // Tab switching
    html += '    var tabBtns = document.querySelectorAll(".tab-btn");\n';
    html += '    for (var i = 0; i < tabBtns.length; i++) {\n';
    html += '        (function(btn) {\n';
    html += '            btn.addEventListener("click", function(e) {\n';
    html += '                e.stopPropagation();\n';
    html += '                var tab = btn.getAttribute("data-tab");\n';
    html += '                var allBtns = document.querySelectorAll(".tab-btn");\n';
    html += '                for (var j = 0; j < allBtns.length; j++) allBtns[j].classList.remove("active");\n';
    html += '                btn.classList.add("active");\n';
    html += '                var allContent = document.querySelectorAll(".tab-content");\n';
    html += '                for (var j = 0; j < allContent.length; j++) allContent[j].classList.remove("active");\n';
    html += '                var targetContent = document.getElementById("tab" + tab.charAt(0).toUpperCase() + tab.slice(1) + "Content");\n';
    html += '                if (targetContent) targetContent.classList.add("active");\n';
    html += '            });\n';
    html += '        })(tabBtns[i]);\n';
    html += '    }\n';

    // Clear data button
    html += '    var clearDataBtn = document.getElementById("clearDataBtn");\n';
    html += '    if (clearDataBtn) {\n';
    html += '        clearDataBtn.addEventListener("click", function() {\n';
    html += '            showMonitorPrompt("管理员验证", "", function(pwd) {\n';
    html += '                if (pwd === null || pwd === "") return;\n';
    html += '                if (pwd !== "8") { showMonitorAlert("错误", "密码错误！"); return; }\n';
    html += '                showMonitorConfirm("清除确认", "确定要清除所有游戏数据吗？此操作将强制所有在线玩家退出并返回初始化页面！", function() {\n';
    html += '                    var xhr = new XMLHttpRequest();\n';
    html += '                    xhr.open("POST", API_BASE + "/api/monitor/clear-data", true);\n';
    html += '                    xhr.setRequestHeader("Content-Type", "application/json");\n';
    html += '                    xhr.onreadystatechange = function() {\n';
    html += '                        if (xhr.readyState === 4) {\n';
    html += '                            if (xhr.status === 200) {\n';
    html += '                                showMonitorAlert("成功", "数据清除成功！即将进入计分系统...", function() { window.location.href = "http://" + window.location.hostname + ":2525"; });\n';
    html += '                            } else {\n';
    html += '                                showMonitorAlert("失败", "数据清除失败！");\n';
    html += '                            }\n';
    html += '                        }\n';
    html += '                    };\n';
    html += '                    xhr.send("{}");\n';
    html += '                });\n';
    html += '            });\n';
    html += '        });\n';
    html += '    }\n';

    // Header double-click to redirect
    html += '    var headerBar = document.getElementById("headerBar");\n';
    html += '    if (headerBar) {\n';
    html += '        headerBar.addEventListener("dblclick", function(e) {\n';
    html += '            if (e.target && e.target.closest) {\n';
    html += '                var btn = e.target.closest(".icon-btn");\n';
    html += '                if (btn) return;\n';
    html += '            }\n';
    html += '            window.location.href = "http://" + window.location.hostname + ":2525";\n';
    html += '        });\n';
    html += '    }\n';

    // Initial data load
    html += '    loadLogs();\n';
    html += '    updatePlayerData();\n';
    html += '    updateGameStats();\n';
    html += '    loadSettlementHistory();\n';

    // Init WebSocket
    html += '    initWebSocket();\n';

    // Periodic refresh
    html += '    setInterval(function() {\n';
    html += '        updatePlayerData();\n';
    html += '        updateGameStats();\n';
    html += '    }, 5000);\n';

    html += '    setInterval(function() {\n';
    html += '        loadLogs();\n';
    html += '    }, 10000);\n';

    html += '    setInterval(function() {\n';
    html += '        loadSettlementHistory();\n';
    html += '    }, 30000);\n';

    // End DOMContentLoaded
    html += '});\n';

    html += '</script>\n';
    html += '</body>\n';
    html += '</html>';

    return html;
}


// 创建WebSocket服务器（绑定到2525端口）
const wss = new WebSocket.Server({ server: scoreServer });
// 存储所有客户端连接
let clients = [];
// 存储玩家在线状态
let onlinePlayers = {};
// TTS 并发去重：同一文本并发请求只生成一次，其余等待复用（保证多名玩家同时收到同一高光语音）
const pendingTTS = {};
// TTS 缓存目录
const TTS_CACHE_DIR = path.join(__dirname, 'tts_cache');
// 简单文本 hash（用于 TTS 缓存文件名）
function ttsHash(s) {
    let h = 0;
    if (s) { for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; } }
    return h.toString(36);
}
// 存储服务器脚本子进程
const runningProcesses = {};
// 存储座位占用状态
let occupiedSeats = {};
// 存储游戏顺序（由第一名玩家确定）
let gameOrder = null;
// 存储玩家数量
let playerCount = 0;
// 对局去重相关变量
let recentScoreUpdates = [];
const DUPLICATE_CHECK_WINDOW = 120000; // 2分钟时间窗口
// 全局游戏状态 - 所有连接共享同一份数据，避免各连接状态不同步
let gameState = null;
let currentGameState = null;
// 分值配置（前端根据此配置渲染支付详情，实现不同分值服务器无感切换）
const SCORING_MODES = {
    '13': { baseScore: 2, muzzleScore: 1, muzzlePayment: 3 },
    '25': { baseScore: 4, muzzleScore: 2, muzzlePayment: 5 }
};
let currentScoringMode = '13'; // 默认13块
let SCORING_CONFIG = SCORING_MODES[currentScoringMode];
// 结算投票状态
let settlementVoting = {
    isActive: false,
    votes: {},  // 玩家muzzle -> true表示同意
    initiator: null
};

// 数据清除标志 - 用于阻止数据清除后的自动绑定和重连逻辑
let dataClearedFlag = false;

// 对局开始时间戳（第一个玩家加入时记录）
let gameStartTime = null;

// 结算备注（结算页面填写，结算时一并保存）
let pendingSettlementRemark = '';

// 游客下注窗口截止时间（每局计分后刷新 20 秒）；模块级避免对局重建丢失
let guestBettingWindowUntil = Date.now() + 20000;

// 台费（结算页面填写，结算时从每人扣除平均分摊，汇总给发起者）
let pendingTableFee = 0;
let settlementInitiatorMuzzle = null;



// 生成计分更新的哈希值
function generateUpdateHash(playerPayments) {
    if (!playerPayments || !Array.isArray(playerPayments)) return null;
    return playerPayments.map(payment => `${payment.id}:${payment.amount}`).sort().join('|');
}

// 清理过期的计分更新
function cleanupExpiredUpdates() {
    const now = Date.now();
    recentScoreUpdates = recentScoreUpdates.filter(update => now - update.timestamp < DUPLICATE_CHECK_WINDOW);
}

// 检查是否为重复计分
// 条件：时间相差在2分钟内 且 计分项名称和数量完全一致 且 赢家相同
function checkDuplicateScore(newRecord) {
    cleanupExpiredUpdates();
    
    if (recentScoreUpdates.length === 0) {
        return { isDuplicate: false };
    }
    
    const lastRecord = recentScoreUpdates[recentScoreUpdates.length - 1];
    const timeDiff = Date.now() - lastRecord.timestamp;
    
    // 检查三个条件
    const isWithinTimeWindow = timeDiff < DUPLICATE_CHECK_WINDOW;
    const isSameWinner = lastRecord.winnerId === newRecord.winnerId;
    const isSameScoreItems = JSON.stringify(lastRecord.details) === JSON.stringify(newRecord.details);
    
    // 只有三个条件都满足时才视为重复
    if (isWithinTimeWindow && isSameWinner && isSameScoreItems) {
        return {
            isDuplicate: true,
            reason: `重复计分检测：与第${lastRecord.round}局时间相差${Math.floor(timeDiff/1000)}秒，赢家相同：${lastRecord.winnerName}，计分项完全相同`
        };
    }

    return { isDuplicate: false };
}

// 服务器端计分计算函数
function calculatePayments(scoreItems, winnerId, players) {
    const winner = players.find(p => p.id === winnerId);
    if (!winner) return null;

    const banker = players.find(p => p.isBanker);

    const historyDetails = [];
    const playerPayments = [];

    let baseScore = SCORING_CONFIG.baseScore;
    let muzzleBase = 0;

    if (scoreItems.qiliang) {
        muzzleBase += SCORING_CONFIG.muzzleScore;
        historyDetails.push('摸张');
        muzzleBase += SCORING_CONFIG.muzzleScore;
        historyDetails.push('独赢');
        muzzleBase += SCORING_CONFIG.muzzleScore;
        historyDetails.push('东风');
        muzzleBase += SCORING_CONFIG.muzzleScore * 2;
        historyDetails.push('二五');
        historyDetails.push('二五');
        historyDetails.push('七梁');
    } else {
        if (scoreItems.mozhang) { muzzleBase += SCORING_CONFIG.muzzleScore; historyDetails.push('摸张'); }
        if (scoreItems.duying) { muzzleBase += SCORING_CONFIG.muzzleScore; historyDetails.push('独赢'); }
        if (scoreItems.dongfeng) { muzzleBase += SCORING_CONFIG.muzzleScore; historyDetails.push('东风'); }
        if (scoreItems.erwu > 0) { muzzleBase += scoreItems.erwu * SCORING_CONFIG.muzzleScore; for (let i = 0; i < scoreItems.erwu; i++) historyDetails.push('二五'); }
    }

    let basePayment = baseScore + muzzleBase;
    if (scoreItems.zimo) { historyDetails.push('自摸'); }

    // ===== 庄家额外分计算 =====
    // 庄家嘴子是否亮起（七梁或庄家绑定的嘴子被选中）
    const bankerMuzzleLit = banker && (scoreItems.qiliang ||
                                   scoreItems[banker.muzzleType] ||
                                   (banker.muzzleType === 'erwu' && scoreItems.erwu > 0));
    // 庄家额外分仅在庄家嘴子亮起且额外分>0时生效
    const bankerExtraActive = banker && bankerMuzzleLit && (banker.extraScore || 0) > 0;
    let bankerExtraAmount = 0;
    if (bankerExtraActive) {
        bankerExtraAmount = banker.extraScore || 0;
        if (scoreItems.zimo) {
            bankerExtraAmount *= 2;  // 自摸翻倍
        }
        historyDetails.push(`庄家额外分 +${bankerExtraAmount}`);
    }

    let winnerPaymentTotal = 0;

    players.forEach(player => {
        if (player.id !== winner.id) {
            let playerBasePayment = basePayment;
            let playerMuzzlePayment = 0;

            if (scoreItems.qiliang || scoreItems[winner.muzzleType] ||
                (winner.muzzleType === 'erwu' && scoreItems.erwu > 0)) {
                playerMuzzlePayment += SCORING_CONFIG.muzzlePayment;
            }
            if (scoreItems.qiliang || scoreItems[player.muzzleType] ||
                (player.muzzleType === 'erwu' && scoreItems.erwu > 0)) {
                playerMuzzlePayment += SCORING_CONFIG.muzzlePayment;
            }
            if (scoreItems.zimo) {
                playerBasePayment *= 2;
                playerMuzzlePayment *= 2;
            }

            let bankerMultiplier = 1;
            const bankerMuzzleLitForMult = scoreItems.qiliang ||
                                   scoreItems[banker.muzzleType] ||
                                   (banker.muzzleType === 'erwu' && scoreItems.erwu > 0);
            if (winner.isBanker && bankerMuzzleLitForMult) { bankerMultiplier = 2; }
            else if (player.isBanker && bankerMuzzleLitForMult) { bankerMultiplier = 2; }

            playerBasePayment *= bankerMultiplier;

            // ===== 额外分支付方向 =====
            let extraPayment = 0;
            if (bankerExtraActive) {
                if (winner.isBanker) {
                    // 庄家赢：所有其他玩家各自向庄家支付额外分
                    extraPayment = bankerExtraAmount;
                } else if (player.isBanker) {
                    // 非庄家赢：仅庄家向赢家支付额外分
                    extraPayment = bankerExtraAmount;
                }
            }

            let totalPayment = playerBasePayment + playerMuzzlePayment + extraPayment;
            winnerPaymentTotal += totalPayment;

            playerPayments.push({ id: player.id, name: player.name, amount: totalPayment });
        }
    });

    playerPayments.push({ id: winner.id, name: winner.name, amount: -winnerPaymentTotal });

    return {
        playerPayments,
        details: historyDetails,
        isBanker: winner.isBanker,
        bankerId: banker ? banker.id : null,
        bankerState: {
            currentBankerId: banker ? banker.id : null,
            continuousBankerCounts: players.reduce((acc, p) => { acc[p.id] = p.continuousBankerCount; return acc; }, {})
        },
        scoringConfig: SCORING_CONFIG
    };
}

// 添加新的计分记录到全局数组
function addScoreUpdate(record) {
    cleanupExpiredUpdates();
    recentScoreUpdates.push({
        timestamp: Date.now(),
        winnerId: record.winnerId,
        winnerName: record.winnerName,
        details: record.details,
        round: record.round
    });
}

// 撤销对局时从全局数组中移除对应记录
function removeScoreUpdateByRound(round) {
    recentScoreUpdates = recentScoreUpdates.filter(update => update.round !== round);
}

// 加载保存的游戏状态
async function loadGameState() {
    await db.read();
    
    if (db.data && db.data.gameState) {
        const savedState = db.data.gameState;
        savedState.players.forEach(player => {
            player.isOnline = false;
            player.ipAddress = playerConnections[player.muzzleType]?.ipAddress || null;
            // 确保新字段存在
            if (player.nickname === undefined) player.nickname = '';
            if (player.extraScoreRecord === undefined) player.extraScoreRecord = null;
            if (!player.extraScoreHistory) player.extraScoreHistory = [];
        });
        // 确保游客字段存在（游客持久化，重启后保留有下注/分数/明细的游客以便同设备重连恢复；无任何数据的空游客清理掉）
        if (!savedState.guests) savedState.guests = [];
        savedState.guests = savedState.guests.filter(function(g) {
            const hasBets = g.bets && Object.keys(g.bets).length > 0;
            const hasScore = g.score && g.score !== 0;
            const hasDetails = g.details && g.details.length > 0;
            return hasBets || hasScore || hasDetails;
        });
        savedState.guests.forEach(function(g) {
            g.online = false;   // 重启后游客默认离线，重连时通过 guestId 恢复
        });
        // 恢复对局开始时间
        if (savedState.gameStartTime) {
            gameStartTime = savedState.gameStartTime;
        }
        return savedState;
    }
    
    // 当没有保存的游戏状态时，使用默认顺序初始化，第一个玩家为庄家
    const defaultOrder = ['mozhang', 'duying', 'dongfeng', 'erwu'];
    return {
        players: initializePlayers(defaultOrder),
        history: [],
        playerOrder: defaultOrder,
        manualAdjustments: [],
        guests: [],
        currentScoreItems: {
            mozhang: false,
            duying: false,
            dongfeng: false,
            erwu: 0,
            qiliang: false,
            zimo: false
        },
        currentWinner: null
    };
}

// 保存游戏状态
async function saveGameState(gameState) {
    db.data.gameState = gameState;
    db.data.occupiedSeats = occupiedSeats;
    db.data.currentScoreItems = gameState.currentScoreItems;
    db.data.playerConnections = playerConnections;
    await db.write();
    // 更新全局引用，确保定时器等能访问到最新状态
    currentGameState = gameState;
}

// 记录日志 - 修改为严格格式
async function logGameEvent(message, type = 'info') {
    const timestamp = new Date().toLocaleString('zh-CN', { 
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    
    const logEntry = {
        timestamp,
        message,
        type
    };
    
    console.log(`${timestamp}: ${message}`);
    
    // 确保 logDb 写入时文件权限为 666
    logDb.data.logs.push(logEntry);
    if (logDb.data.logs.length > 1000) {
        logDb.data.logs = logDb.data.logs.slice(-1000);
    }
    await logDb.write();
    
    // 写入 TXT 日志 - 格式化为控制脚本可解析的格式
    const logLine = `${timestamp}: ${message}`;
    fs.appendFile('gameLogs.log', `${logLine}\n`, (err) => {
        if (err) console.error('写入日志文件失败:', err);
    });
}

// 获取客户端IP
function getClientIP(req) {
    return req.headers['x-forwarded-for'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress || 
           req.connection.socket?.remoteAddress || 
           '未知IP';
}

// 处理WebSocket连接
wss.on('connection', async function connection(ws, req) {
    const clientIP = getClientIP(req);

    ws.clientIP = clientIP;
    clients.push(ws);

    // 使用全局gameState（服务器启动时加载，所有连接共享）
    if (!gameState) {
        gameState = await loadGameState();
        currentGameState = gameState;
        
        // 如果有已保存的玩家顺序，同时恢复gameOrder（保持顺序锁定）
        if (gameState.playerOrder && gameState.playerOrder.length > 0) {
            const hasHistory = gameState.history && gameState.history.length > 0;
            const hasNonZeroScore = gameState.players && gameState.players.some(p => p.score !== 0);
            if (hasHistory || hasNonZeroScore) {
                gameOrder = gameState.playerOrder;
                playerCount = gameOrder.length;
                console.log(`服务启动时恢复游戏顺序（已锁定）: ${gameOrder.join(' → ')}`);
            }
        }
    }

    // 检查该IP是否已绑定嘴子（数据清除后不进行自动绑定）
    let boundMuzzle = null;
    if (!dataClearedFlag) {
        for (let muzzle in playerConnections) {
            if (playerConnections[muzzle] && playerConnections[muzzle].ipAddress === clientIP && playerConnections[muzzle].isBound) {
                boundMuzzle = muzzle;
                break;
            }
        }
    }

    // 如果IP已绑定嘴子，自动恢复在线状态（断线重连）
    // 强制注册：只有该座位此前由「已注册用户」入座时才允许自动恢复，
    // 未注册的座位不做恢复，玩家必须注册登录后重新进入系统
    if (boundMuzzle && !(playerConnections[boundMuzzle] && playerConnections[boundMuzzle].userId)) {
        console.log(`座位 ${boundMuzzle} 未绑定注册用户，跳过IP自动恢复（${clientIP}）`);
        boundMuzzle = null;
    }
    if (boundMuzzle) {
        // 先清除同IP的旧连接，防止竞态条件
        // 使用特殊的close code 4001，客户端识别后不触发重连
        clients.forEach(client => {
            if (client !== ws && client.muzzle === boundMuzzle && client.readyState === WebSocket.OPEN) {
                client.muzzle = null;  // 清除旧连接的muzzle，防止close事件干扰
                client.hasJoinedGame = false; // 清除旧连接的已加入标记，防止close事件触发掉线逻辑
                client.close(4001, 'Replaced by new connection');
            }
        });
        clients = clients.filter(client => client.readyState === WebSocket.OPEN);

        ws.muzzle = boundMuzzle;
        ws.playerName = MUZZLE_NAMES[boundMuzzle] || boundMuzzle;
        ws.hasJoinedGame = true; // 断线重连也标记为已进入系统
        onlinePlayers[boundMuzzle] = true;
        if (playerConnections[boundMuzzle]) {
            playerConnections[boundMuzzle].isOnline = true;
            playerConnections[boundMuzzle].lastSeen = new Date().toISOString();
            // 恢复注册用户身份（若该座位此前由已注册用户入座）
            if (playerConnections[boundMuzzle].userId) {
                ws.userId = playerConnections[boundMuzzle].userId;
                ws.userNickname = playerConnections[boundMuzzle].userNickname || '';
            }
        }
        const player = gameState.players.find(p => p.muzzleType === boundMuzzle);
        if (player) {
            player.isOnline = true;
            player.ipAddress = clientIP;
            // 确保玩家身上的 userId 不因重连丢失（结算统计依赖）
            if (ws.userId && !player.userId) {
                player.userId = ws.userId;
                if (ws.userNickname && !player.userNickname) player.userNickname = ws.userNickname;
            }
        }
        console.log(`玩家重新连接: ${MUZZLE_NAMES[boundMuzzle] || boundMuzzle} (${clientIP})`);

        // 广播在线状态更新给其他客户端
        broadcast({
            type: 'state_update',
            state: {
                players: gameState.players,
                history: gameState.history,
                playerOrder: gameState.playerOrder,
                manualAdjustments: gameState.manualAdjustments,
                guests: gameState.guests,
                currentWinner: gameState.currentWinner
            },
            onlinePlayers,
            currentScoreItems: gameState.currentScoreItems
        });
    }

    // 发送当前游戏状态给新连接的客户端
    ws.send(JSON.stringify({
        type: 'full_state',
        state: gameState,
        onlinePlayers,
        occupiedSeats,
        currentScoreItems: gameState.currentScoreItems,
        boundMuzzle: boundMuzzle,  // 如果已绑定，告诉客户端
        gameOrder: gameOrder || gameState.playerOrder,  // 全局游戏顺序
        settlementVoting: {
            isActive: settlementVoting.isActive,
            agreeCount: Object.keys(settlementVoting.votes).length,
            agreedPlayers: Object.keys(settlementVoting.votes),
            initiator: settlementVoting.initiator,
            requiredCount: 2
        },
        scoringConfig: SCORING_CONFIG,
        scoringMode: currentScoringMode
    }));
    
    // 自动下发历史结算数据给新连接的客户端（保存到前端localStorage，离线时可查看）
    try {
        await settlementHistoryDb.read();
        const settlements = settlementHistoryDb.data.settlements || [];
        if (settlements.length > 0) {
            ws.send(JSON.stringify({
                type: 'settlement_history_sync',
                settlements: settlements
            }));
            console.log(`已下发历史结算数据给新连接的客户端，共 ${settlements.length} 条记录`);
        }
    } catch(e) {
        console.error('下发历史结算数据失败:', e);
    }
    
    // 处理来自客户端的消息
    ws.on('message', async function incoming(message) {
        try {
            const data = JSON.parse(message);

            if (!data.type) {
                console.warn('收到无类型消息');
                return;
            }

            // 心跳检测服务器端响应
            if (data.type === 'heartbeat') {
                ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
                return;
            }

            if (data.type === 'player_joined' || data.type === 'join') {
                const muzzle = data.muzzle;

                // 强制注册登录：进入系统前必须校验账号（userId + 密码）
                const authUser = await verifyUser(data.user && data.user.userId, data.user && data.user.password);
                if (!authUser) {
                    ws.send(JSON.stringify({ type: 'error', msg: '请先注册并登录账号后再进入系统' }));
                    return;
                }

                // 特殊情况：如果当前连接已经绑定了该嘴子（重连场景），直接返回成功状态
                // 避免因客户端重复发送join消息导致冲突和死循环
                if (ws.muzzle === muzzle && ws.hasJoinedGame) {
                    console.log(`当前连接已绑定${MUZZLE_NAMES[muzzle] || muzzle}，重复join请求，直接返回状态`);
                    ws.send(JSON.stringify({
                        type: 'full_state',
                        state: {
                            players: gameState.players,
                            history: gameState.history,
                            playerOrder: gameState.playerOrder,
                            manualAdjustments: gameState.manualAdjustments,
                            guests: gameState.guests,
                            currentWinner: gameState.currentWinner
                        },
                        onlinePlayers,
                        playerConnections,
                        currentScoreItems: gameState.currentScoreItems,
                        boundMuzzle: muzzle,
                        gameOrder: gameOrder
                    }));
                    return;
                }
                
                // 检查是否有玩家使用了相同的嘴子且在线
                const existingPlayer = clients.find(client => client.muzzle === muzzle && client !== ws && client.readyState === WebSocket.OPEN);
                if (existingPlayer) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '该嘴子已被其他在线玩家选择，请重新选择'
                    }));
                    return;
                }
                
                // 冲突拦截：若选择的"嘴子"已被在线玩家占用，禁止该玩家进入计分系统
                if (onlinePlayers[muzzle]) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '该嘴子已被在线玩家占用，请重新选择'
                    }));
                    return;
                }
                
                // 检查是否有其他在线玩家
                const hasOnlinePlayers = Object.values(onlinePlayers).some(isOnline => isOnline);

                // 检查是否已有分数记录（有历史记录或非零分数）
                // 只有有分数记录时，顺序才锁定；仅保存了顺序但无分数记录时，玩家仍可调整
                const hasHistory = gameState.history && gameState.history.length > 0;
                const hasNonZeroScore = gameState.players && gameState.players.some(p => p.score !== 0);
                const hasScoreRecords = hasHistory || hasNonZeroScore;
                const hasSavedOrder = gameState.playerOrder && gameState.playerOrder.length > 0;

                if (hasOnlinePlayers) {
                    // 已有在线玩家，必须使用当前游戏顺序，忽略玩家发送的顺序
                    // 如果gameOrder尚未初始化，使用数据库保存的顺序，最后才用默认顺序
                    if (!gameOrder) {
                        if (hasSavedOrder) {
                            gameOrder = gameState.playerOrder;
                        } else {
                            gameOrder = ['mozhang', 'duying', 'dongfeng', 'erwu'];
                            gameState.playerOrder = gameOrder;
                        }
                        console.log(`游戏顺序已确定: ${gameOrder.join(' → ')}`);
                    }
                    // 发送当前游戏顺序给新加入的玩家，确保顺序一致
                    console.log(`新玩家加入，使用现有游戏顺序: ${gameOrder.join(' → ')}`);
                } else if (hasScoreRecords && hasSavedOrder) {
                    // 没有在线玩家，但有分数记录
                    // 嘴子顺序已锁定：未结算/未清除数据前，禁止客户端覆盖顺序
                    gameOrder = gameState.playerOrder;
                    console.log(`有分数记录，游戏顺序锁定: ${gameOrder.join(' → ')}`);

                    // 确保玩家数据与顺序一致，完整保留原有分数和庄家状态
                    const existingPlayersMap = new Map(gameState.players.map(p => [p.muzzleType, p]));
                    gameState.players = gameOrder.map((muzzle, index) => {
                        const existingPlayer = existingPlayersMap.get(muzzle);
                        if (existingPlayer) {
                            return existingPlayer;
                        }
                        // 如果有新的嘴子（理论上不应该发生），初始化新玩家
                        const newPlayer = initializePlayers([muzzle])[0];
                        newPlayer.isBanker = (index === 0);
                        newPlayer.continuousBankerCount = (index === 0) ? 1 : 0;
                        return newPlayer;
                    });
                } else {
                    // 没有在线玩家，也没有分数记录，当前玩家可以确定游戏顺序
                    // 优先使用玩家发送的顺序，其次使用服务器已保存的顺序，最后使用默认顺序
                    let newOrder = null;
                    
                    // 如果客户端发送了有效的顺序，使用客户端的顺序
                    if (data.playerOrder && data.playerOrder.length === 4) {
                        newOrder = data.playerOrder;
                    } 
                    // 如果服务器已保存了顺序，使用服务器的顺序
                    else if (hasSavedOrder) {
                        newOrder = gameState.playerOrder;
                    }
                    // 否则使用默认顺序
                    else {
                        newOrder = ['mozhang', 'duying', 'dongfeng', 'erwu'];
                    }
                    
                    gameOrder = newOrder;
                    gameState.playerOrder = gameOrder;
                    
                    // 重新初始化玩家数组，确保第一个玩家为庄家
                    gameState.players = initializePlayers(gameOrder);
                    
                    console.log(`游戏顺序已确定: ${gameOrder.join(' → ')}，庄家: ${gameState.players[0].name}`);
                    // 记录对局开始时间（首次确定顺序时）
                    if (!gameStartTime) {
                        gameStartTime = Date.now();
                        gameState.gameStartTime = gameStartTime;
                    }
                }
                
                // 检查游戏是否已满
                if (Object.keys(onlinePlayers).filter(key => onlinePlayers[key]).length >= 4) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '游戏已开始，无法继续加入玩家！'
                    }));
                    return;
                }
                
                // 清除该IP可能存在的其他嘴子绑定，防止同一IP绑定多个嘴子
                for (let existingMuzzle in playerConnections) {
                    if (playerConnections[existingMuzzle] && playerConnections[existingMuzzle].ipAddress === clientIP) {
                        delete playerConnections[existingMuzzle];
                        delete occupiedSeats[existingMuzzle];
                        onlinePlayers[existingMuzzle] = false;
                    }
                }

                // 标记座位为已占用
                occupiedSeats[muzzle] = true;
                ws.muzzle = muzzle;
                ws.playerName = MUZZLE_NAMES[muzzle] || muzzle;
                ws.hasJoinedGame = true; // 标记该连接已进入游戏系统

                // 记录玩家连接信息 - 绑定IP到嘴子
                // 同时记录注册用户身份（userId），用于结算归属与胜率统计
                const joinUser = { userId: authUser.userId, nickname: authUser.nickname };
                playerConnections[muzzle] = {
                    ipAddress: clientIP,
                    isOnline: true,
                    lastSeen: new Date().toISOString(),
                    playerName: ws.playerName,
                    isBound: true,  // 标记为已绑定
                    userId: joinUser ? joinUser.userId : null,
                    userNickname: joinUser ? joinUser.nickname : ''
                };

                onlinePlayers[muzzle] = true;
                ws.userId = joinUser ? joinUser.userId : null;
                ws.userNickname = joinUser ? joinUser.nickname : '';

                // 更新玩家信息
                const player = gameState.players.find(p => p.muzzleType === muzzle);
                if (player) {
                    player.isOnline = true;
                    player.ipAddress = clientIP;
                    player.lastSeen = new Date().toISOString();
                    if (joinUser) {
                        player.userId = joinUser.userId;
                        if (joinUser.nickname) player.userNickname = joinUser.nickname;
                    }
                }
                
                await saveGameState(gameState);
                
                // 如果数据清除标志为true，说明是数据清除后的第一个join，重置标志
                if (dataClearedFlag) {
                    dataClearedFlag = false;
                    console.log('数据清除后的第一个客户端已加入，重置dataClearedFlag');
                }
                
                // 不再广播玩家加入消息，只更新状态
                // 发送完整状态给请求者，包含boundMuzzle和gameOrder
                ws.send(JSON.stringify({
                    type: 'full_state',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner,
                        gameStartTime: gameStartTime
                    },
                    onlinePlayers,
                    playerConnections,
                    currentScoreItems: gameState.currentScoreItems,
                    boundMuzzle: muzzle,
                    gameOrder: gameOrder
                }));
                
                // 广播给其他玩家
                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    playerConnections,
                    currentScoreItems: gameState.currentScoreItems
                }, ws);
                
                return;
            }
            
            if (data.type === 'guest_join') {
                // 游客进入：支持重连恢复（传入guestId则恢复已有游客）
                // 游客同样需要注册登录（凭 userId + 密码校验）
                (async () => {
                    try {
                        if (ws.muzzle || ws.guestId) {
                            ws.send(JSON.stringify({ type: 'error', msg: '你已进入系统' }));
                            return;
                        }
                        const guestAuth = await verifyUser(data.user && data.user.userId, data.user && data.user.password);
                        if (!guestAuth) {
                            ws.send(JSON.stringify({ type: 'error', msg: '请先注册并登录账号后再以游客身份进入' }));
                            return;
                        }
                        // 游客可随时进入（无需4人满）：仅观战+对玩家下注
                        const guestName = (data.name || '').trim().substring(0, 20);
                        let guest = null;
                        let guestId = data.guestId;
                        // 如果传入了guestId且存在离线游客，则恢复
                        if (guestId) {
                            guest = gameState.guests.find(g => g.id === guestId);
                        }
                        if (guest) {
                            // 恢复已有游客：保留下注/分数/明细，更新在线状态和名称
                            guest.online = true;
                            if (guestName) guest.name = guestName;
                            guestId = guest.id;
                            console.log(`游客重连恢复: ${guest.name}, 下注: ${JSON.stringify(guest.bets)}`);
                        } else {
                            // 新游客
                            guestId = 'guest_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
                            guest = {
                                id: guestId,
                                name: guestName || ('游客' + (gameState.guests.length + 1)),
                                bets: {},      // { muzzle: amount } 对各玩家下注
                                score: 0,      // 累计净应收（正=应收）
                                details: [],   // 每局结算明细
                                online: true
                            };
                            gameState.guests.push(guest);
                        }
                        ws.guestId = guestId;
                        ws.guestName = guest.name;

                        await saveGameState(gameState);
                        broadcastGuestUpdate();
                        broadcastStateUpdate();

                        ws.send(JSON.stringify({
                            type: 'guest_joined',
                            success: true,
                            guestId: guestId,
                            name: guestName,
                            bettingOpen: Date.now() <= guestBettingWindowUntil,
                            bettingOpenUntil: guestBettingWindowUntil,
                            guests: gameState.guests.map(g => ({ id: g.id, name: g.name, bets: g.bets, score: g.score }))
                        }));
                        console.log(`游客进入: ${guestName} (${guestId})`);
                    } catch (err) {
                        console.error('游客进入失败:', err);
                        ws.send(JSON.stringify({ type: 'error', msg: '游客进入失败: ' + err.message }));
                    }
                })();
                return;
            }

            if (data.type === 'guest_bet') {
                // 游客下注/改注/取消（amount=0 取消）
                (async () => {
                    try {
                        const guestId = data.guestId || ws.guestId;
                        const targetMuzzle = data.targetMuzzle;
                        const amount = Math.max(0, Math.floor(Number(data.amount) || 0));
                        const guest = gameState.guests.find(g => g.id === guestId);
                        if (!guest) {
                            ws.send(JSON.stringify({ type: 'error', msg: '游客不存在或已退出' }));
                            return;
                        }
                        const validMuzzles = ['mozhang', 'duying', 'dongfeng', 'erwu'];
                        if (validMuzzles.indexOf(targetMuzzle) === -1) {
                            ws.send(JSON.stringify({ type: 'error', msg: '无效的下注目标' }));
                            return;
                        }
                        if (amount > 10000) {
                            ws.send(JSON.stringify({ type: 'error', msg: '下注金额过大' }));
                            return;
                        }
                        if (amount === 0) {
                            delete guest.bets[targetMuzzle];
                        } else {
                            // 已取消20秒下注时间限制，随时可下注/改注
                            guest.bets[targetMuzzle] = amount;
                        }
                        // 写入历史操作记录
                        if (!gameState.history) gameState.history = [];
                        const muzzleNames = {mozhang:'摸张',duying:'独赢',dongfeng:'东风',erwu:'二五'};
                        gameState.history.push({
                            type: 'guest_bet_set',
                            guestId: guestId,
                            guestName: guest.name || '游客',
                            targetMuzzle: targetMuzzle,
                            targetName: muzzleNames[targetMuzzle] || targetMuzzle,
                            amount: amount,
                            timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
                            timestampMs: Date.now()
                        });
                        await saveGameState(gameState);
                        broadcastGuestUpdate();
                        broadcastStateUpdate();
                        // 向全体在线玩家广播下注通知（含游客名、目标玩家、金额）
                        try {
                            const muzzleName = (muzzleNames[targetMuzzle] || targetMuzzle);
                            broadcast({
                                type: 'guest_bet_notify',
                                guestName: guest.name || '游客',
                                targetMuzzle: targetMuzzle,
                                targetName: muzzleName,
                                amount: amount
                            });
                        } catch (e) {}
                        ws.send(JSON.stringify({
                            type: 'guest_bet_set',
                            success: true,
                            guestId: guestId,
                            bettingOpen: Date.now() <= guestBettingWindowUntil,
                            bettingOpenUntil: guestBettingWindowUntil,
                            targetMuzzle: targetMuzzle,
                            amount: amount,
                            bets: guest.bets
                        }));
                        console.log(`游客 ${guest.name} 对 ${targetMuzzle} 下注 ${amount} 分`);
                    } catch (err) {
                        console.error('游客下注失败:', err);
                        ws.send(JSON.stringify({ type: 'error', msg: '下注失败: ' + err.message }));
                    }
                })();
                return;
            }

            if (data.type === 'guest_leave') {
                // 游客退出：标记离线但保留下注数据（bets持久化）
                const guestId = data.guestId || ws.guestId;
                const guest = gameState.guests.find(g => g.id === guestId);
                if (guest) {
                    guest.online = false;
                    if (ws.guestId === guestId) ws.guestId = null;
                    saveGameState(gameState).then(() => {
                        broadcastGuestUpdate();
                        broadcastStateUpdate();
                    });
                    console.log(`游客离线（保留下注）: ${guest.name}`);
                }
                return;
            }

            if (data.type === 'guest_set_name') {
                // 游客改名（同步右上角设置的名称）
                const guestId = data.guestId || ws.guestId;
                const guest = gameState.guests.find(g => g.id === guestId);
                const newName = (data.name || '').trim().substring(0, 20);
                if (guest && newName) {
                    guest.name = newName;
                    if (ws.guestId === guestId) ws.guestName = newName;
                    saveGameState(gameState).then(() => {
                        broadcastGuestUpdate();
                        broadcastStateUpdate();
                    });
                    ws.send(JSON.stringify({ type: 'guest_name_set', success: true, name: newName, guestId: guestId }));
                    console.log(`游客改名: ${newName}`);
                }
                return;
            }

            if (data.type === 'settlement_request') {
                // 发起结算请求（支持玩家与游客）
                const isGuestInit = !!ws.guestId;
                const requestMuzzle = ws.muzzle;
                if (!requestMuzzle && !isGuestInit) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '请先选择嘴子再发起结算'
                    }));
                    return;
                }
                
                // 记录发起者（用于台费汇总，游客发起不参与台费）
                settlementInitiatorMuzzle = requestMuzzle || 'guest';
                
                const playerName = isGuestInit ? (gameState.guests.find(g => g.id === ws.guestId)?.name || '游客') : (MUZZLE_NAMES[requestMuzzle] || requestMuzzle);
                
                // 双击发起 → 自动结算（无需其他玩家同意）
                if (data.auto === true) {
                    console.log(`${playerName}双击发起自动结算`);
                    await logGameEvent(`${playerName}双击发起自动结算`, 'info');
                    // 重置投票状态后直接执行结算
                    settlementVoting.isActive = false;
                    settlementVoting.votes = {};
                    settlementVoting.initiator = null;
                    await executeSettlement();
                    return;
                }
                
                // 初始化投票
                settlementVoting.isActive = true;
                settlementVoting.votes = {};
                const initVoteKey = isGuestInit ? ('guest:' + ws.guestId) : requestMuzzle;
                settlementVoting.votes[initVoteKey] = true;
                settlementVoting.initiator = initVoteKey;
                
                console.log(`${playerName}发起结算投票`);
                
                // 广播结算投票状态
                broadcastSettlementVoting();
                
                // 记录日志
                await logGameEvent(`${playerName}发起结算投票`, 'info');
                
                return;
            }
            
            if (data.type === 'settlement_vote') {
                // 处理结算投票（支持玩家与游客）
                const isGuestVote = !!ws.guestId;
                const voteMuzzle = ws.muzzle;
                const agreed = data.agreed;
                // 游客用 guestId 作为投票标识
                const voteKey = isGuestVote ? ('guest:' + ws.guestId) : voteMuzzle;
                
                if (!voteKey) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '请先选择嘴子再投票'
                    }));
                    return;
                }
                
                if (!settlementVoting.isActive) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '当前没有进行中的结算投票'
                    }));
                    return;
                }
                
                const playerName = isGuestVote ? (gameState.guests.find(g => g.id === ws.guestId)?.name || '游客') : (MUZZLE_NAMES[voteMuzzle] || voteMuzzle);
                if (agreed) {
                    settlementVoting.votes[voteKey] = true;
                    console.log(`${playerName}同意结算`);
                    await logGameEvent(`${playerName}同意结算`, 'info');
                } else {
                    // 取消投票
                    delete settlementVoting.votes[voteKey];
                    console.log(`${playerName}取消结算同意`);
                }
                
                // 统计同意人数（去重：同key只计一次）
                const agreeCount = Object.keys(settlementVoting.votes).length;
                
                // 检查是否达到2人以上同意
                if (agreeCount >= 2) {
                    console.log(`结算投票通过（${agreeCount}人同意），执行结算`);
                    await logGameEvent(`结算投票通过（${agreeCount}人同意），开始结算`, 'info');
                    
                    // 先广播投票通过
                    broadcastSettlementVoting();
                    
                    // 延迟一小段时间后执行结算，让客户端看到投票结果
                    setTimeout(async () => {
                        // 执行结算逻辑
                        await executeSettlement();
                    }, 1500);
                } else {
                    // 广播当前投票状态
                    broadcastSettlementVoting();
                }
                
                return;
            }
            
            if (data.type === 'settlement_cancel') {
                // 取消结算投票
                const cancelMuzzle = ws.muzzle;
                if (!cancelMuzzle) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        msg: '请先选择嘴子再操作'
                    }));
                    return;
                }
                
                if (!settlementVoting.isActive) {
                    return;
                }
                
                // 只有发起者可以取消投票
                if (settlementVoting.initiator === cancelMuzzle) {
                    settlementVoting.isActive = false;
                    settlementVoting.votes = {};
                    settlementVoting.initiator = null;
                    
                    const playerName = MUZZLE_NAMES[cancelMuzzle] || cancelMuzzle;
                    console.log(`${playerName}取消结算投票`);
                    await logGameEvent(`${playerName}取消结算投票`, 'info');
                    
                    broadcastSettlementVoting();
                }
                
                return;
            }
            
            if (data.type === 'settlement_remark') {
                // 设置结算备注（结算页面前填写）
                pendingSettlementRemark = (data.remark || '').trim().substring(0, 200);
                ws.send(JSON.stringify({
                    type: 'remark_set',
                    success: true,
                    remark: pendingSettlementRemark
                }));
                return;
            }

            if (data.type === 'settlement_table_fee') {
                // 设置台费（结算页面前填写）- 保留兼容但不再使用
                pendingTableFee = Math.max(0, Math.floor(Number(data.tableFee) || 0));
                ws.send(JSON.stringify({
                    type: 'table_fee_set',
                    success: true,
                    tableFee: pendingTableFee
                }));
                return;
            }

            if (data.type === 'deduct_table_fee') {
                // 台费自动扣除：立即从所有玩家扣除并汇总给发起者
                (async () => {
                    try {
                        const requestMuzzle = ws.muzzle;
                        if (!requestMuzzle) {
                            ws.send(JSON.stringify({ type: 'error', msg: '请先选择嘴子' }));
                            return;
                        }
                        if (!gameState || !gameState.players) {
                            ws.send(JSON.stringify({ type: 'error', msg: '游戏尚未开始' }));
                            return;
                        }
                        const tableFee = Math.max(0, Math.floor(Number(data.tableFee) || 0));
                        if (tableFee <= 0) {
                            ws.send(JSON.stringify({ type: 'error', msg: '请输入有效的台费金额' }));
                            return;
                        }

                        const playerCount = gameState.players.length;
                        if (playerCount === 0) {
                            ws.send(JSON.stringify({ type: 'error', msg: '没有玩家' }));
                            return;
                        }

                        const feePerPlayer = Math.floor(tableFee / playerCount);
                        const remainder = tableFee - feePerPlayer * playerCount;
                        const initiatorName = MUZZLE_NAMES[requestMuzzle] || requestMuzzle;

                        // 扣除每位玩家的台费，汇总给发起者
                        const tableFeeDetails = [];
                        gameState.players.forEach((player, idx) => {
                            let deduction = feePerPlayer;
                            if (idx < remainder) deduction += 1;
                            if (player.muzzleType === requestMuzzle) {
                                // 发起者：扣除自己那份后获得全部台费
                                player.score = player.score - deduction + tableFee;
                            } else {
                                player.score = player.score - deduction;
                            }
                            tableFeeDetails.push({
                                id: player.id,
                                name: player.name,
                                nickname: player.nickname || '',
                                muzzleType: player.muzzleType,
                                deduction: deduction,             // 本次扣除
                                isInitiator: player.muzzleType === requestMuzzle,
                                netChange: player.muzzleType === requestMuzzle ? (tableFee - deduction) : (-deduction) // 净收支（发起者净收入）
                            });
                        });

                        // 记录台费划扣到历史（type='tableFee'，不参与局数与胜率统计，图表/统计均会跳过）
                        gameState.history.push({
                            type: 'tableFee',
                            round: 0,
                            tableFee: tableFee,
                            initiatorMuzzle: requestMuzzle,
                            initiatorName: initiatorName,
                            feePerPlayer: feePerPlayer,
                            remainder: remainder,
                            playerCount: playerCount,
                            players: tableFeeDetails,
                            timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
                            timestampMs: Date.now()
                        });

                        await saveGameState(gameState);

                        // 记录日志
                        await logGameEvent(`${initiatorName}发起台费扣除，总金额${tableFee}，每人扣除${feePerPlayer}（余数${remainder}分给前${remainder}位）`, 'info');

                        // 发送通知：非发起者看到扣除信息，发起者看到收入信息
                        const netIncome = tableFee - feePerPlayer - (gameState.players.findIndex(p => p.muzzleType === requestMuzzle) < remainder ? 1 : 0);
                        clients.forEach(client => {
                            if (client.readyState !== WebSocket.OPEN) return;
                            const clientMuzzle = client.muzzle;
                            if (clientMuzzle === requestMuzzle) {
                                // 发起者：仅显示台费收入
                                client.send(JSON.stringify({
                                    type: 'info',
                                    msg: `台费收入 ${tableFee} 元`,
                                    duration: 8000
                                }));
                            } else if (clientMuzzle) {
                                // 其他玩家：显示谁发起的、总金额、本次扣除
                                let myDeduction = feePerPlayer;
                                const myIdx = gameState.players.findIndex(p => p.muzzleType === clientMuzzle);
                                if (myIdx >= 0 && myIdx < remainder) myDeduction += 1;
                                client.send(JSON.stringify({
                                    type: 'info',
                                    msg: `${initiatorName}发起台费扣除，总金额 ${tableFee} 元，本次扣除 ${myDeduction} 元`,
                                    duration: 8000
                                }));
                            }
                        });

                        // 广播状态更新（实际扣除不产生额外通知，仅更新分数）
                        broadcast({
                            type: 'state_update',
                            state: {
                                players: gameState.players,
                                history: gameState.history,
                                playerOrder: gameState.playerOrder,
                                manualAdjustments: gameState.manualAdjustments,
                                guests: gameState.guests,
                                currentWinner: gameState.currentWinner
                            },
                            onlinePlayers,
                            currentScoreItems: gameState.currentScoreItems
                        });
                    } catch (err) {
                        console.error('台费扣除出错:', err);
                        ws.send(JSON.stringify({ type: 'error', msg: '台费扣除失败: ' + err.message }));
                    }
                })();
                return;
            }
            
            if (data.type === 'settlement_confirm') {
                // 处理结算确认，完全清除所有数据，包括IP绑定
                (async () => {
                    try {
                        // 重置游戏状态，清除所有数据包括IP绑定
                        db.data = {
                            gameState: null,
                            occupiedSeats: {},
                            currentScoreItems: {},
                            playerConnections: {}
                        };
                        await db.write();
                        
                        // 重置日志
                        logDb.data = { logs: [] };
                        await logDb.write();
                        
                        // 删除日志文件
                        if (fs.existsSync('gameLogs.log')) {
                            fs.unlinkSync('gameLogs.log');
                        }
                        
                        // 重置内存中的数据
                        gameOrder = null;
                        playerCount = 0;
                        onlinePlayers = {};
                        occupiedSeats = {};
                        playerConnections = {};
                        // 重置连接闭包中的 gameState 变量，但保留 playerOrder（用户自定义顺序）
                        gameState.history = [];
                        if (gameState.players) {
                            gameState.players.forEach(p => {
                                p.score = 0;
                                p.isBanker = false;
                                p.continuousBankerCount = 0;
                            });
                        }
                        gameState.currentScoreItems = {
                            mozhang: false,
                            duying: false,
                            dongfeng: false,
                            erwu: 0,
                            qiliang: false,
                            zimo: false
                        };
                        recentScoreUpdates = [];
                        gameStartTime = null;
                        pendingSettlementRemark = '';
                        
                        // 清除服务器输出，只保留二维码和访问地址
                        console.log('\n'.repeat(100));
                        
                        // 重新输出启动信息和二维码
                        
                        console.log('🎉 欢迎使用嘴子计分器至尊版');
                        
                        const scoreUrl = `http://${primaryIP}:2525`;
                        console.log(`📱 计分系统访问地址: ${scoreUrl}`);
                        
                        // 生成二维码
                        if (QRCodeTerminal) {
                            QRCodeTerminal.generate(scoreUrl, { small: true });
                        }
                        console.log('─'.repeat(50));
                        
                        // 发送空的游戏状态给所有客户端 - 确保完全清空，不残留任何历史数据
                        // 使用当前 gameState 的 playerOrder，保留用户的自定义顺序
                        const preservedOrder = gameState.playerOrder || ['mozhang', 'duying', 'dongfeng', 'erwu'];
                        const cleanPlayers = initializePlayers(preservedOrder).map(p => ({
                            ...p,
                            score: 0,
                            isBanker: false,
                            continuousBankerCount: 0
                        }));
                        gameState.players = cleanPlayers;
                        gameState.currentWinner = null;
                        currentGameState = gameState;
                        
                        // 保存干净状态到数据库
                        db.data.gameState = gameState;
                        db.data.occupiedSeats = occupiedSeats;
                        db.data.currentScoreItems = gameState.currentScoreItems;
                        db.data.playerConnections = playerConnections;
                        await db.write();
                        
                        broadcast({
                            type: 'full_state',
                            state: {
                                players: cleanPlayers,
                                history: [],
                                playerOrder: preservedOrder,
                                manualAdjustments: [],
                                guests: [],
                                currentScoreItems: {
                                    mozhang: false,
                                    duying: false,
                                    dongfeng: false,
                                    erwu: 0,
                                    qiliang: false,
                                    zimo: false
                                },
                                currentWinner: null
                            },
                            onlinePlayers: {},
                            occupiedSeats: {},
                            playerConnections: {},
                            currentScoreItems: {
                                mozhang: false,
                                duying: false,
                                dongfeng: false,
                                erwu: 0,
                                qiliang: false,
                                zimo: false
                            },
                            gameOrder: preservedOrder
                        });
                        
                        // 发送结算清除通知，客户端清除所有数据并返回首页
                        broadcast({
                            type: 'data_cleared',
                            msg: '结算完成，所有数据已清除，请重新选择嘴子',
                            clearType: 'settlement'
                        });
                    } catch (error) {
                        console.error('处理结算确认失败:', error);
                    }
                })();
                return;
            }
            
            if (data.type === 'score_item_update') {
                // 客户端发送计分项变化，服务器统一处理
                const { item, scoreItems } = data;

                if (scoreItems) {
                    // 直接设置完整的计分项
                    gameState.currentScoreItems = scoreItems;
                } else if (item) {
                    // 切换单个计分项
                    if (item === 'erwu') {
                        gameState.currentScoreItems.erwu = (gameState.currentScoreItems.erwu + 1) % 3;
                    } else if (item === 'qiliang') {
                        const isAllSelected = gameState.currentScoreItems.mozhang &&
                                               gameState.currentScoreItems.duying &&
                                               gameState.currentScoreItems.dongfeng &&
                                               gameState.currentScoreItems.erwu === 2;
                        const newState = !isAllSelected;
                        gameState.currentScoreItems.mozhang = newState;
                        gameState.currentScoreItems.duying = newState;
                        gameState.currentScoreItems.dongfeng = newState;
                        gameState.currentScoreItems.erwu = newState ? 2 : 0;
                        gameState.currentScoreItems.qiliang = newState;
                    } else {
                        gameState.currentScoreItems[item] = !gameState.currentScoreItems[item];
                    }

                    // 点击单个嘴子/二五时，同步更新七梁状态：全亮则七梁开，否则七梁关
                    if (item !== 'zimo' && item !== 'qiliang') {
                        const allSelected = gameState.currentScoreItems.mozhang &&
                                            gameState.currentScoreItems.duying &&
                                            gameState.currentScoreItems.dongfeng &&
                                            gameState.currentScoreItems.erwu === 2;
                        gameState.currentScoreItems.qiliang = allSelected;
                    }

                    // 如果取消选中所有嘴子（包括通过七梁取消），自摸也取消
                    const hasMuzzleSelected = gameState.currentScoreItems.mozhang ||
                                              gameState.currentScoreItems.duying ||
                                              gameState.currentScoreItems.dongfeng ||
                                              gameState.currentScoreItems.erwu > 0 ||
                                              gameState.currentScoreItems.qiliang;
                    if (!hasMuzzleSelected && gameState.currentScoreItems.zimo) {
                        gameState.currentScoreItems.zimo = false;
                    }
                }

                await saveGameState(gameState);

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                }, ws);
                return;
            }

            if (data.type === 'winner_select') {
                gameState.currentWinner = data.winnerId;
                await saveGameState(gameState);

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                }, ws);
                return;
            }

            if (data.type === 'undo_round') {
                const round = data.round;
                const recordIndex = gameState.history.findIndex(r => r.round === round && !r.isUndo);

                if (recordIndex === -1) {
                    ws.send(JSON.stringify({ type: 'error', msg: '找不到对应的对局记录' }));
                    return;
                }

                const record = gameState.history[recordIndex];

                if (record.type && (record.type === 'manual' || record.type === 'settlement' || record.type === 'tableFee')) {
                    ws.send(JSON.stringify({ type: 'error', msg: '该记录不支持撤销' }));
                    return;
                }

                // 1分钟时间限制
                const recordTime = new Date(record.timestamp);
                const now = new Date();
                const timeDiffSeconds = (now - recordTime) / 1000;
                if (timeDiffSeconds >= 60) {
                    ws.send(JSON.stringify({ type: 'error', msg: '该对局计分已超过1分钟，无法撤销' }));
                    return;
                }

                // 恢复玩家分数
                if (record.playerPayments) {
                    record.playerPayments.forEach(payment => {
                        const player = gameState.players.find(p => p.id === payment.id);
                        if (player) {
                            player.score += payment.amount;
                        }
                    });
                }

                // 恢复庄家状态
                if (record.bankerState) {
                    gameState.players.forEach(player => {
                        const savedState = record.bankerState.continuousBankerCounts[player.id];
                        if (savedState !== undefined) {
                            player.continuousBankerCount = savedState;
                        }
                        player.isBanker = (player.id === record.bankerState.currentBankerId);
                    });
                }

                // 标记为撤销
                record.isUndo = true;

                // 移除重复检测记录
                removeScoreUpdateByRound(round);

                // 回滚游客押注结算：恢复该局游客所有下注的收付（押中退回、押输退还）
                if (gameState.guests && gameState.guests.length > 0) {
                    gameState.guests.forEach(guest => {
                        const details = guest.details || [];
                        // 收集该局所有游客下注明细
                        const roundDetails = details.filter(d => d.round === round);
                        roundDetails.forEach(d => {
                            if (d.direction === 'win') {
                                // 押中：输家加回，游客减回
                                (d.losers || []).forEach(loserRec => {
                                    const loser = gameState.players.find(p => p.muzzleType === loserRec.muzzle);
                                    if (loser) loser.score += loserRec.amount;
                                    guest.score -= loserRec.amount;
                                });
                            } else {
                                // 押输：赢家减回，游客加回
                                if (d.winner) {
                                    const winP = gameState.players.find(p => p.muzzleType === d.winner.muzzle);
                                    if (winP) winP.score -= d.winner.amount;
                                    guest.score += d.winner.amount;
                                }
                            }
                        });
                        // 移除该局所有明细
                        for (let ri = details.length - 1; ri >= 0; ri--) {
                            if (details[ri].round === round) details.splice(ri, 1);
                        }
                    });
                    // 撤销后刷新游客端（分数回滚/明细移除）
                    broadcastGuestUpdate();
                }

                await saveGameState(gameState);

                // 广播撤销通知
                const undoPlayer = gameState.players.find(p => p.muzzleType === ws.muzzle);
                broadcast({
                    type: 'info',
                    msg: `${undoPlayer ? undoPlayer.name : '玩家'}撤销第${round}局计分`,
                    isUndo: true,
                    duration: 5000
                });

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                }, ws);

                await logGameEvent(`${undoPlayer ? undoPlayer.name : '玩家'}撤销第${round}局计分`, 'undo');
                return;
            }

            if (data.type === 'manual_adjust') {
                const { targetPlayerId, amount } = data;

                const targetPlayer = gameState.players.find(p => p.id === targetPlayerId);
                // 游客身份：优先取消息中的 guestId，其次取连接绑定的 ws.guestId
                const opGuestId = data.guestId || ws.guestId || null;
                const isGuestOp = !!opGuestId;
                const currentPlayer = isGuestOp ? null : gameState.players.find(p => p.muzzleType === ws.muzzle);
                const currentGuest = isGuestOp ? gameState.guests.find(g => g.id === opGuestId) : null;

                if (!targetPlayer || amount <= 0) {
                    ws.send(JSON.stringify({ type: 'error', msg: '手动调整参数无效' }));
                    return;
                }
                if (!isGuestOp && !currentPlayer) {
                    ws.send(JSON.stringify({ type: 'error', msg: '手动调整参数无效' }));
                    return;
                }

                targetPlayer.score += amount;
                if (isGuestOp) {
                    if (currentGuest) currentGuest.score -= amount;
                } else {
                    currentPlayer.score -= amount;
                }

                const fromPlayerId = isGuestOp ? (currentGuest ? currentGuest.id : opGuestId) : currentPlayer.id;
                const fromPlayerName = isGuestOp ? (currentGuest ? currentGuest.name : '游客') : currentPlayer.name;
                const fromPlayerMuzzle = isGuestOp ? 'guest' : currentPlayer.muzzleType;
                const adjustmentRecord = {
                    type: 'manual',
                    fromPlayerId: fromPlayerId,
                    fromPlayerName: fromPlayerName,
                    fromPlayerMuzzle: fromPlayerMuzzle,
                    toPlayerId: targetPlayer.id,
                    toPlayerName: targetPlayer.name,
                    toPlayerMuzzle: targetPlayer.muzzleType,
                    adjustment: amount,
                    timestamp: new Date().toLocaleString('zh-CN', { hour12: false })
                };

                gameState.manualAdjustments.push(adjustmentRecord);
                gameState.history.push(adjustmentRecord);

                await saveGameState(gameState);

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                }, ws);

                // 只通知相关双方玩家（游客模式下 currentPlayer 为 null，用 fromPlayerName 代替）
                broadcast({
                    type: 'info',
                    msg: `${fromPlayerName}向${targetPlayer.name}支付${amount}分`,
                    isManualAdjustment: true,
                    duration: 10000
                }, ws);

                await logGameEvent(`${fromPlayerName}向${targetPlayer.name}手动调整${amount}分`, 'manual');
                return;
            }

            // 设置庄家额外分（仅当前庄家可调整自己的额外分）
            if (data.type === 'set_extra_score') {
                const currentPlayer = gameState.players.find(p => p.muzzleType === ws.muzzle);
                if (!currentPlayer) {
                    ws.send(JSON.stringify({ type: 'error', msg: '未找到玩家信息' }));
                    return;
                }
                const extraScore = Math.max(0, Math.floor(Number(data.extraScore) || 0));
                currentPlayer.extraScore = extraScore;

                // 记录额外分设置信息（用于历史记录展示）
                if (extraScore > 0) {
                    const now = new Date();
                    const displayName = currentPlayer.nickname || currentPlayer.name;
                    const record = {
                        playerName: displayName,
                        score: extraScore,
                        time: now.toLocaleString('zh-CN', { hour12: false })
                    };
                    currentPlayer.extraScoreRecord = record;
                    // 记录到历史数组（保留所有更新记录）
                    if (!currentPlayer.extraScoreHistory) currentPlayer.extraScoreHistory = [];
                    currentPlayer.extraScoreHistory.push(record);
                } else {
                    currentPlayer.extraScoreRecord = null;
                }

                // 写入历史操作记录
                if (!gameState.history) gameState.history = [];
                gameState.history.push({
                    type: 'extra_score_set',
                    playerMuzzle: ws.muzzle,
                    playerName: currentPlayer.nickname || currentPlayer.name,
                    extraScore: extraScore,
                    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
                    timestampMs: Date.now()
                });

                await saveGameState(gameState);

                // 先给发送方发送确认
                ws.send(JSON.stringify({
                    type: 'extra_score_set',
                    success: true,
                    extraScore: extraScore
                }));

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner,
                        gameStartTime: gameStartTime
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                });

                const displayName = currentPlayer.nickname || currentPlayer.name;
                broadcast({
                    type: 'info',
                    msg: extraScore > 0
                        ? `${displayName} 设置额外分 +${extraScore}`
                        : `${displayName} 取消额外分`,
                    duration: 3000
                });

                await logGameEvent(`${displayName} ${extraScore > 0 ? '设置' : '取消'}额外分 ${extraScore}`, 'extra_score');
                return;
            }

            if (data.type === 'set_nickname') {
                const currentPlayer = gameState.players.find(p => p.muzzleType === ws.muzzle);
                if (!currentPlayer) {
                    ws.send(JSON.stringify({ type: 'error', msg: '未找到玩家信息' }));
                    return;
                }
                const nickname = (data.nickname || '').trim().substring(0, 20);
                currentPlayer.nickname = nickname;
                await saveGameState(gameState);

                ws.send(JSON.stringify({
                    type: 'nickname_set',
                    success: true,
                    nickname: nickname
                }));

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner,
                        gameStartTime: gameStartTime
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                });

                await logGameEvent(`${currentPlayer.name} 设置昵称: ${nickname || '(空)'}`, 'nickname');
                return;
            }

            if (data.type === 'state_update') {
                // 前后端分离后，不再接受客户端推送完整状态
                // 仅保留用于同步 isUndo 标记（向后兼容）
                if (data.state && data.state.history && Array.isArray(data.state.history)) {
                    for (let i = 0; i < Math.min(data.state.history.length, gameState.history.length); i++) {
                        if (data.state.history[i].isUndo && !gameState.history[i].isUndo) {
                            gameState.history[i].isUndo = true;
                            removeScoreUpdateByRound(gameState.history[i].round);
                        }
                    }
                    await saveGameState(gameState);
                    broadcast({
                        type: 'state_update',
                        state: {
                            players: gameState.players,
                            history: gameState.history,
                            playerOrder: gameState.playerOrder,
                            manualAdjustments: gameState.manualAdjustments,
                            guests: gameState.guests,
                            currentWinner: gameState.currentWinner
                        },
                        onlinePlayers,
                        currentScoreItems: gameState.currentScoreItems
                    }, ws);
                }
                return;
            }
            
            if (data.type === 'confirm_score') {
                const { scoreItems, winnerId } = data;

                if (!scoreItems || !winnerId) {
                    ws.send(JSON.stringify({ type: 'error', msg: '计分数据不完整' }));
                    return;
                }

                // 服务器端计算支付
                const calcResult = calculatePayments(scoreItems, winnerId, gameState.players);
                if (!calcResult) {
                    ws.send(JSON.stringify({ type: 'error', msg: '无法计算计分结果' }));
                    return;
                }

                const { playerPayments, details, isBanker, bankerId, bankerState, scoringConfig } = calcResult;
                const winnerPlayer = gameState.players.find(p => p.id === winnerId);
                const winnerName = winnerPlayer ? winnerPlayer.name : '';

                // 重复计分检测
                const validRoundCount = gameState.history.filter(r => !r.isUndo && r.type !== 'manual' && r.type !== 'settlement' && r.type !== 'tableFee' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set').length;
                const duplicateCheck = checkDuplicateScore({
                    winnerId: winnerId,
                    winnerName: winnerName,
                    details: details,
                    round: validRoundCount + 1
                });

                if (duplicateCheck.isDuplicate) {
                    ws.send(JSON.stringify({ type: 'error', msg: duplicateCheck.reason }));
                    broadcast({ type: 'info', message: duplicateCheck.reason }, ws);
                    return;
                }

                // 更新玩家分数
                playerPayments.forEach(payment => {
                    const player = gameState.players.find(p => p.id === payment.id);
                    if (player) {
                        player.score -= payment.amount;
                    }
                });

                // 确定新庄家
                let newBankerId = null;
                if (isBanker) {
                    newBankerId = winnerId;
                    const winnerP = gameState.players.find(p => p.id === winnerId);
                    if (winnerP) { winnerP.continuousBankerCount++; }
                } else {
                    const currentBanker = gameState.players.find(p => p.id === bankerId);
                    if (currentBanker && gameState.playerOrder) {
                        const currentIndex = gameState.playerOrder.indexOf(currentBanker.muzzleType);
                        if (currentIndex !== -1) {
                            const nextIndex = (currentIndex + 1) % gameState.playerOrder.length;
                            const nextMuzzle = gameState.playerOrder[nextIndex];
                            const nextBanker = gameState.players.find(p => p.muzzleType === nextMuzzle);
                            if (nextBanker) {
                                newBankerId = nextBanker.id;
                                nextBanker.continuousBankerCount = 1;
                            }
                        }
                    }
                }

                // 更新庄家状态
                gameState.players.forEach(p => {
                    if (p.id === newBankerId) { p.isBanker = true; }
                    else { p.isBanker = false; if (p.id !== winnerId) { p.continuousBankerCount = 0; } }
                });

                // 添加历史记录（局数基于有效对局数，撤销后下一局延续被撤销局的序号）
                // 本局庄家额外分
                const bankerPlayer = gameState.players.find(p => p.id === bankerId);
                const bankerExtraScore = (bankerPlayer && bankerPlayer.extraScore) ? bankerPlayer.extraScore : 0;

                const newRecord = {
                    round: validRoundCount + 1,
                    winnerId: winnerId,
                    bankerId: bankerId,
                    details: details,
                    playerPayments: playerPayments,
                    timestamp: new Date().toLocaleString('zh-CN', { hour12: false }),
                    timestampMs: Date.now(),
                    bankerState: bankerState,
                    isSelfDrawn: details.includes('自摸'),
                    bankerExtraScore: bankerExtraScore,
                    guestDetails: []
                };
                gameState.history.push(newRecord);

                addScoreUpdate({ winnerId, winnerName, details, round: newRecord.round });

                // 游客押注结算：押中赢家输家各付（自摸×2）、押输游客付×2给赢家，不影响赢家自身结算；
                // 仅被下注玩家为本局庄家时结算（与庄家额外分逻辑一致）
                newRecord.guestDetails = settleGuestBets(winnerId, newRecord.round, newRecord.isSelfDrawn, newRecord.bankerId);

                // 已取消20秒下注窗口，计分后直接广播游客更新
                broadcastGuestUpdate();

                // 重置计分项
                gameState.currentScoreItems = { mozhang: false, duying: false, dongfeng: false, erwu: 0, qiliang: false, zimo: false };
                gameState.currentWinner = null;

                await saveGameState(gameState);
                
                // 计算分数变化
                const scoreChanges = playerPayments.map(payment => ({
                    id: payment.id,
                    score: gameState.players.find(p => p.id === payment.id)?.score || 0,
                    change: -payment.amount,
                    name: payment.name
                }));
                
                // 广播更新
                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: null
                    },
                    onlinePlayers,
                    playerConnections,
                    scoreChanges,
                    currentScoreItems: {
                        mozhang: false,
                        duying: false,
                        dongfeng: false,
                        erwu: 0,
                        qiliang: false,
                        zimo: false
                    },
                    isNewRound: true,
                    roundInfo: newRecord,
                    scoringConfig,
                    details: newRecord.details || [],
                    isSelfDrawn: newRecord.isSelfDrawn || false
                }, ws);
                
                // 新局通知
                const winner = gameState.players.find(p => p.id === winnerId);
                let banker = gameState.players.find(p => p.id === bankerId);
                
                if (!banker) {
                    banker = gameState.players.find(p => p.isBanker);
                }
                
                if (winner && banker) {
                    const muzzleNameMap = {
                        'mozhang': '摸张',
                        'duying': '独赢', 
                        'dongfeng': '东风',
                        'erwu': '二五'
                    };
                    const scoreDetails = [];
                    newRecord.playerPayments.forEach(payment => {
                        const player = gameState.players.find(p => p.id === payment.id);
                        if (player) {
                            const amount = -payment.amount;
                            scoreDetails.push(`${player.name}${amount > 0 ? '+' : ''}${amount}`);
                        }
                    });
                    const detailsText = newRecord.details && newRecord.details.length > 0 ? 
                        `[${newRecord.details.join(', ')}]` : '[无计分项]';
                    const logMessage = `第${newRecord.round}局 赢家:${winner.name} 庄家:${banker.name} [${scoreDetails.join(' ')}] ${detailsText}`;
                    await logGameEvent(logMessage, 'round');
                    
                    let message = `<div style="text-align: left;"><strong style="font-size: 18px;">第${newRecord.round}局</strong></div>`;
                    message += `<div style="text-align: center; font-size: 16px; margin: 10px 0;">`;
                    message += `赢家 <span style="color: #e74c3c; font-weight: bold;">${winner.name}</span>     `;
                    const bankerColor = (winner.id === banker.id) ? '#e74c3c' : '#3498db';
                    message += `庄家 <span style="color: ${bankerColor}; font-weight: bold;">${banker.name}</span>`;
                    message += `</div>`;
                    
                    const muzzleOrder = ['mozhang', 'duying', 'erwu', 'dongfeng'];
                    const muzzleMap = {};
                    muzzleOrder.forEach(muzzle => {
                        muzzleMap[muzzle] = 0;
                    });
                    newRecord.playerPayments.forEach(payment => {
                        const player = gameState.players.find(p => p.id === payment.id);
                        if (player) {
                            const amount = -payment.amount;
                            muzzleMap[player.muzzleType] = amount;
                        }
                    });
                    // 合并游客下注收支到玩家分数显示（与 settleGuestBets 一致）
                    (newRecord.guestDetails || []).forEach(gd => {
                        if (gd.direction === 'win') {
                            // 押中：每个输家多付 amount 给游客
                            (gd.losers || []).forEach(lr => {
                                const lp = gameState.players.find(p => p.muzzleType === lr.muzzle);
                                if (lp && muzzleMap[lp.muzzleType] !== undefined) {
                                    muzzleMap[lp.muzzleType] -= (lr.amount || 0);
                                }
                            });
                        } else if (gd.direction === 'lose') {
                            // 押输：游客付给赢家，赢家多收
                            const wp = gameState.players.find(p => p.id === newRecord.winnerId);
                            if (wp && muzzleMap[wp.muzzleType] !== undefined) {
                                muzzleMap[wp.muzzleType] += (gd.amount || 0);
                            }
                        }
                    });
                    
                    message += `<div style="display: flex; justify-content: space-around; font-size: 14px; text-align: center; margin-top: 10px;">`;
                    muzzleOrder.forEach((muzzle) => {
                        const amount = muzzleMap[muzzle];
                        const formattedAmount = amount > 0 ? `+${amount}` : amount;
                        const color = amount > 0 ? '#e74c3c' : '#27ae60';
                        message += `<div style="flex: 1; color: ${color};">${muzzleNameMap[muzzle]}: ${formattedAmount}</div>`;
                    });
                    message += `</div>`;

                    // 详细计分项：摸张、独赢、二五×2、东风
                    if (newRecord.details && newRecord.details.length > 0) {
                        const detailCounts = {};
                        newRecord.details.forEach(d => {
                            detailCounts[d] = (detailCounts[d] || 0) + 1;
                        });
                        const detailParts = [];
                        ['摸张', '独赢', '东风'].forEach(name => {
                            if (detailCounts[name]) detailParts.push(name);
                        });
                        if (detailCounts['二五']) {
                            for (let i = 0; i < detailCounts['二五']; i++) detailParts.push('二五');
                        }
                        const selfDrawnStyle = newRecord.isSelfDrawn ? 'color: #e74c3c; font-weight: bold;' : '';
                        message += `<div style="text-align: center; font-size: 13px; margin-top: 8px; color: #aaa;">`;
                        message += `计分项: <span style="${selfDrawnStyle}">${detailParts.join('、')}</span>`;
                        message += `</div>`;
                    }
                    
                    // 游客分数行（有游客下注结算时显示）
                    if (newRecord.guestDetails && newRecord.guestDetails.length > 0) {
                        const guestSummaries = {};
                        newRecord.guestDetails.forEach(gd => {
                            const key = gd.guestId || gd.guestName || '游客';
                            if (!guestSummaries[key]) guestSummaries[key] = { name: gd.guestName || '游客', total: 0 };
                            if (gd.direction === 'win') {
                                const total = (gd.losers || []).reduce((s, l) => s + (l.amount || 0), 0);
                                guestSummaries[key].total += total;
                            } else {
                                guestSummaries[key].total -= (gd.amount || 0);
                            }
                        });
                        message += `<div style="display: flex; justify-content: space-around; font-size: 13px; text-align: center; margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,0.2);">`;
                        Object.keys(guestSummaries).forEach(key => {
                            const gs = guestSummaries[key];
                            const gSign = gs.total > 0 ? '+' : '';
                            const gColor = gs.total > 0 ? '#2ecc71' : gs.total < 0 ? '#e74c3c' : '#aaa';
                            message += `<div style="flex: 1; color: ${gColor};"><span style="color:#aaa;">🗣️ ${gs.name}:</span> ${gSign}${gs.total}</div>`;
                        });
                        message += `</div>`;
                    }
                    
                    broadcast({
                        type: 'info',
                        msg: message,
                        isNewRound: true,
                        round: newRecord.round,
                        isSelfDrawn: newRecord.isSelfDrawn || false,
                        duration: null
                    }, ws);
                    
                    // ===== 高光时刻检测与播报（七梁 / 收入大额 / 庄家自摸 / 连赢）=====
                    const recentRecords = gameState.history.filter(r => !r.isUndo && r.type !== 'manual' && r.type !== 'settlement' && r.type !== 'tableFee' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set');
                    const highlightMsgs = [];
                    
                    // 0. 计算本局赢家收入（供七梁/大额高光使用）
                    const detailArr = newRecord.details || [];
                    const winnerPayment = (newRecord.playerPayments || []).find(pp => pp.id === winner.id);
                    const winnerIncome = winnerPayment ? -winnerPayment.amount : 0;
                    const bigWinThreshold = (SCORING_CONFIG && SCORING_CONFIG.muzzleScore >= 2) ? 60 : 30;
                    
                    // 0.5 计算本局梁数（底分2，每个激活计分项+1：1项=三梁，2=四梁，3=五梁，4=六梁，5=七梁）
                    // 计分项 = 激活的嘴子项（七梁视为满5项）；自摸不计入梁数
                    let liangCount = 0;
                    if (scoreItems.qiliang) {
                        liangCount = 7;
                    } else {
                        let itemCount = 0;
                        if (scoreItems.mozhang) itemCount++;
                        if (scoreItems.duying) itemCount++;
                        if (scoreItems.dongfeng) itemCount++;
                        if (scoreItems.erwu > 0) itemCount += Math.min(2, scoreItems.erwu);
                        liangCount = itemCount + 2;   // 底分2起算
                    }
                    const bankerName = banker ? banker.name : '庄家';
                    const winnerIsBanker = winner.id === bankerId;
                    
                    // 1. 七梁/六梁牌型 + 庄家被炸（非庄家赢）播报
                    if (detailArr.includes('七梁')) {
                        if (!winnerIsBanker) {
                            // 庄家被七梁炸下庄：专属词库（带庄家名+赢家名）
                            highlightMsgs.push({
                                type: 'highlight_bankerHit',
                                text: pickHighlightPhrase('bankerHit', winner.name, winnerIncome, 7, false, bankerName),
                                winnerName: winner.name
                            });
                        } else {
                            highlightMsgs.push({
                                type: 'highlight_qiliang',
                                text: pickHighlightPhrase('qiliang', winner.name, winnerIncome),
                                winnerName: winner.name
                            });
                        }
                    } else if (liangCount === 6) {
                        // 六梁：同样值得播报（庄家被炸则用下庄词库）
                        if (!winnerIsBanker) {
                            highlightMsgs.push({
                                type: 'highlight_bankerHit',
                                text: pickHighlightPhrase('bankerHit', winner.name, winnerIncome, 6, false, bankerName),
                                winnerName: winner.name
                            });
                        } else {
                            highlightMsgs.push({
                                type: 'highlight_liang6',
                                text: pickHighlightPhrase('liang6', winner.name, winnerIncome),
                                winnerName: winner.name
                            });
                        }
                    }
                    
                    // 2. 收入大额：本局赢家净收入超过阈值（13块模式30分，25块模式60分）
                    if (winnerIncome >= bigWinThreshold) {
                        highlightMsgs.push({
                            type: 'highlight_bigwin',
                            text: pickHighlightPhrase('bigwin', winner.name, winnerIncome),
                            winnerName: winner.name
                        });
                    }
                    
                    // 3. 庄家自摸
                    if (winner.isBanker && newRecord.isSelfDrawn) {
                        highlightMsgs.push({
                            type: 'highlight_banker_zimo',
                            text: pickHighlightPhrase('zimo', winner.name, 0),
                            winnerName: winner.name
                        });
                    }
                    
                    // 4. 连赢状态（连续 2+ 局同一赢家）
                    if (recentRecords.length >= 2) {
                        const lastTwo = recentRecords.slice(-2);
                        if (lastTwo.length === 2 && lastTwo.every(r => r.winnerId === winnerId)) {
                            const winStreakCount = (() => {
                                let cnt = 0;
                                for (let k = recentRecords.length - 1; k >= 0; k--) {
                                    if (recentRecords[k].winnerId === winnerId) cnt++;
                                    else break;
                                }
                                return cnt;
                            })();
                            // 5连胜由 Penta kill 播报（不重复触发普通连胜词库）
                            if (winStreakCount >= 3 && winStreakCount !== 5) {
                                highlightMsgs.push({
                                    type: 'highlight_streak',
                                    text: pickHighlightPhrase('streak', winner.name, winStreakCount),
                                    winnerName: winner.name
                                });
                            }
                        }
                    }
                    
                    // ===== 广播高光：多条自动合二为一精简 =====
                    // 收集触发类型
                    const firedTypes = highlightMsgs.map(h => h.type);
                    const hasQiliang = firedTypes.includes('highlight_qiliang');
                    const hasZimo = firedTypes.includes('highlight_banker_zimo');
                    const hasBigwin = firedTypes.includes('highlight_bigwin');
                    const hasStreak = firedTypes.includes('highlight_streak');
                    const streakNum = (() => {
                        if (!hasStreak) return 0;
                        let cnt = 0;
                        for (let k = recentRecords.length - 1; k >= 0; k--) {
                            if (recentRecords[k].winnerId === winnerId) cnt++;
                            else break;
                        }
                        return cnt;
                    })();
                    
                    // 庄家被炸（非庄家赢六梁/七梁）优先级最高：即使同时触发大额/自摸也独占播报下庄信息
                    // 高光文本统一兜底携带收入金额：若文本中不含收入金额数值（{score}未替换），追加"净收{score}"保证金额不丢失
                    const ensureScore = (t) => {
                        const s = String(t || '');
                        if (winnerIncome > 0 && !s.includes(String(winnerIncome))) {
                            return s + '，净收' + winnerIncome;
                        }
                        return s;
                    };
                    const bankerHitMsg = highlightMsgs.find(h => h.type === 'highlight_bankerHit');
                    if (bankerHitMsg) {
                        const finalText = ensureScore(bankerHitMsg.text);
                        console.log(`高光播报(下庄): ${finalText}`);
                        broadcast({ type: 'highlight', htype: 'highlight_bankerHit', text: finalText, winnerName: winner.name });
                    } else if (highlightMsgs.length >= 2) {
                        // 合并成一条精简播报（七言/五言词库随机，不重复；无连赢时跳过含{n}模板；本局无七梁时跳过含"七梁"模板）
                        let comboText = pickHighlightPhrase('combo', winner.name, winnerIncome, streakNum, !hasStreak, undefined, hasQiliang ? undefined : '七梁');
                        comboText = ensureScore(comboText);
                        console.log(`高光播报(合并): ${comboText}`);
                        broadcast({ type: 'highlight', htype: 'highlight_combo', text: comboText, winnerName: winner.name });
                    } else if (highlightMsgs.length === 1) {
                        const h = highlightMsgs[0];
                        const finalText = ensureScore(h.text);
                        console.log(`高光播报: [${h.type}] ${finalText}`);
                        broadcast({ type: 'highlight', htype: h.type, text: finalText, winnerName: h.winnerName });
                    }
                    
                    // 三连胜检测：检测最近三局是否为同一个赢家（向后兼容保留）
                    if (recentRecords.length >= 3) {
                        const lastThree = recentRecords.slice(-3);
                        const isTripleWin = lastThree.every(r => r.winnerId === winnerId);
                        if (isTripleWin) {
                            broadcast({
                                type: 'triple_win',
                                winnerName: winner.name
                            });
                        }
                    }
                    
                    // 五连胜 Penta kill 播报：达到5连胜单独语音播报（带收入金额）
                    if (recentRecords.length >= 5) {
                        let pentaStreak = 0;
                        for (let k = recentRecords.length - 1; k >= 0; k--) {
                            if (recentRecords[k].winnerId === winnerId) pentaStreak++;
                            else break;
                        }
                        if (pentaStreak === 5) {
                            const pentaText = `恭喜${winner.name}，Penta kill，收入${winnerIncome}`;
                            console.log(`高光播报(五杀): ${pentaText}`);
                            broadcast({ type: 'highlight', htype: 'highlight_penta', text: pentaText, winnerName: winner.name });
                        }
                    }
                }
                
                return;
            }
            
        } catch (error) {
            console.error('处理客户端消息失败:', error);
            ws.send(JSON.stringify({
                type: 'error',
                msg: '服务器处理消息时发生错误'
            }));
        }
    });
    
    // 连接关闭
    ws.on('close', async () => {
        clients = clients.filter(client => client !== ws);

        // 游客断线：标记离线但保留下注数据（bets/score/details持久化）
        if (ws.guestId) {
            const guest = gameState.guests.find(g => g.id === ws.guestId);
            if (guest) {
                guest.online = false;
                try {
                    await saveGameState(gameState);
                    broadcastGuestUpdate();
                    broadcastStateUpdate();
                } catch (e) {}
                console.log(`游客断线（保留下注）: ${guest.name}`);
            }
            ws.guestId = null;
        }

        // 如果连接是因数据清除而关闭，不再处理掉线逻辑
        if (ws._dataCleared) {
            return;
        }

        // 只有当ws.muzzle存在且该连接确实选择了嘴子并进入了系统时，才处理掉线逻辑
        // 留在初始化页面的玩家刷新不会影响已进入系统的玩家
        if (ws.muzzle && ws.hasJoinedGame) {
            // 检查是否有其他连接使用同一个muzzle（防止刷新页面时竞态条件）
            const hasOtherConnection = clients.some(client =>
                client.muzzle === ws.muzzle && client.readyState === WebSocket.OPEN
            );

            if (!hasOtherConnection) {
                onlinePlayers[ws.muzzle] = false;

                // 减少玩家计数
                if (gameOrder && gameOrder.indexOf(ws.muzzle) < playerCount) {
                    playerCount--;
                }

                // 如果所有玩家都离开了，检查是否有游戏数据
                // 只有在没有游戏数据时才重置游戏顺序（未结算时有分数记录则保持锁定）
                const currentPlayerCount = Object.keys(onlinePlayers).filter(key => onlinePlayers[key]).length;
                if (currentPlayerCount === 0) {
                    const hasHistory = gameState.history && gameState.history.length > 0;
                    const hasNonZeroScore = gameState.players && gameState.players.some(p => p.score !== 0);
                    const hasGameData = hasHistory || hasNonZeroScore;

                    if (!hasGameData) {
                        // 没有游戏数据时才重置顺序
                        gameOrder = null;
                        playerCount = 0;
                    }
                    // 有游戏数据时保持gameOrder不变，保持嘴子顺序锁定

                    if (settlementVoting.isActive) {
                        settlementVoting.isActive = false;
                        settlementVoting.votes = {};
                        settlementVoting.initiator = null;
                    }
                } else if (settlementVoting.isActive && settlementVoting.votes[ws.muzzle]) {
                    delete settlementVoting.votes[ws.muzzle];

                    if (settlementVoting.initiator === ws.muzzle) {
                        const remainingVoters = Object.keys(settlementVoting.votes);
                        if (remainingVoters.length > 0) {
                            settlementVoting.initiator = remainingVoters[0];
                        } else {
                            settlementVoting.isActive = false;
                            settlementVoting.initiator = null;
                        }
                    }

                    broadcastSettlementVoting();
                }

                if (playerConnections[ws.muzzle]) {
                    playerConnections[ws.muzzle].isOnline = false;
                    playerConnections[ws.muzzle].lastSeen = new Date().toISOString();
                }

                const player = gameState.players.find(p => p.muzzleType === ws.muzzle);
                if (player) {
                    player.isOnline = false;
                }

                broadcast({
                    type: 'state_update',
                    state: {
                        players: gameState.players,
                        history: gameState.history,
                        playerOrder: gameState.playerOrder,
                        manualAdjustments: gameState.manualAdjustments,
                        guests: gameState.guests,
                        currentWinner: gameState.currentWinner
                    },
                    onlinePlayers,
                    currentScoreItems: gameState.currentScoreItems
                });

                db.data.playerConnections = playerConnections;
                db.data.occupiedSeats = occupiedSeats;
                await db.write();
            }
        }
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
    });
});

// 广播消息给所有客户端
function broadcast(data, sender) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// 广播游客列表更新（完整游客信息：下注、累计应收、明细）
function broadcastGuestUpdate() {
    broadcast({
        type: 'guest_update',
        bettingOpen: Date.now() <= guestBettingWindowUntil,
        bettingOpenUntil: guestBettingWindowUntil,
        guests: (gameState.guests || []).map(g => ({
            id: g.id,
            name: g.name,
            bets: g.bets || {},
            score: g.score || 0,
            details: g.details || []
        }))
    });
}

// 广播通用状态更新（含游客，供玩家端/游客端刷新）
function broadcastStateUpdate() {
    broadcast({
        type: 'state_update',
        state: {
            players: gameState.players,
            history: gameState.history,
            playerOrder: gameState.playerOrder,
            manualAdjustments: gameState.manualAdjustments,
            currentWinner: gameState.currentWinner,
            guests: gameState.guests || []
        },
        onlinePlayers,
        currentScoreItems: gameState.currentScoreItems
    });
}

// 游客下注结算：赢家被游客押注时，每个输家独立支付额外分给游客（自摸×2）
// 与赢家自身结算互不影响
function settleGuestBets(winnerId, round, isSelfDrawn, roundBankerId) {
    const winner = gameState.players.find(p => p.id === winnerId);
    const roundGuestDetails = [];
    if (!winner || !gameState.guests || gameState.guests.length === 0) return roundGuestDetails;
    const multiplier = isSelfDrawn ? 2 : 1;
    // 本局庄家：游客下注只对被下注玩家为本局庄家时才结算（与庄家额外分逻辑一致，只是被积分对象改为游客）
    const roundBanker = gameState.players.find(p => p.id === roundBankerId) || gameState.players.find(p => p.isBanker);
    const bankerMuzzle = roundBanker ? roundBanker.muzzleType : null;
    gameState.guests.forEach(guest => {
        // 对每个有效下注结算：押中收钱（输家各付、自摸×2）、押输赔钱（自摸×2，与押中对称）
        const bets = guest.bets || {};
        Object.keys(bets).forEach(targetMuzzle => {
            const bet = bets[targetMuzzle];
            if (!bet || bet <= 0) return;
            // 只有下注目标是本局庄家时才结算该注（非庄家的注保留，等其坐庄时再结算）
            if (bankerMuzzle && targetMuzzle !== bankerMuzzle) return;
            if (targetMuzzle === winner.muzzleType) {
                // 押中：每个输家支付 bet×自摸倍率 给游客
                const amount = bet * multiplier;
                const losers = [];
                gameState.players.forEach(loser => {
                    if (loser.id !== winnerId) {
                        loser.score -= amount;      // 输家支付给游客
                        guest.score += amount;      // 游客应收
                        losers.push({ muzzle: loser.muzzleType, name: loser.nickname || loser.name, amount: amount });
                    }
                });
                const winDetail = {
                    round: round,
                    guestId: guest.id,
                    guestName: guest.name,
                    direction: 'win',
                    targetMuzzle: targetMuzzle,
                    winnerMuzzle: winner.muzzleType,
                    winnerName: winner.nickname || winner.name,
                    bet: bet,
                    multiplier: multiplier,
                    isSelfDrawn: !!isSelfDrawn,
                    perLoser: amount,
                    losers: losers
                };
                guest.details.push(winDetail);
                roundGuestDetails.push(winDetail);
            } else {
                // 押输：游客赔给赢家，自摸同样 ×2（与押中对称）
                const amount = bet * multiplier;
                guest.score -= amount;              // 游客应付
                winner.score += amount;             // 赢家收下注者的钱
                const loseDetail = {
                    round: round,
                    guestId: guest.id,
                    guestName: guest.name,
                    direction: 'lose',
                    targetMuzzle: targetMuzzle,
                    winnerMuzzle: winner.muzzleType,
                    winnerName: winner.nickname || winner.name,
                    bet: bet,
                    multiplier: multiplier,
                    isSelfDrawn: !!isSelfDrawn,
                    amount: amount,
                    winner: { muzzle: winner.muzzleType, name: winner.nickname || winner.name, amount: amount }
                };
                guest.details.push(loseDetail);
                roundGuestDetails.push(loseDetail);
            }
        });
    });
    return roundGuestDetails;
}

// 广播结算投票状态
function broadcastSettlementVoting() {
    const agreeCount = Object.keys(settlementVoting.votes).length;
    const agreedPlayers = Object.keys(settlementVoting.votes);
    
    broadcast({
        type: 'settlement_voting_update',
        voting: {
            isActive: settlementVoting.isActive,
            agreeCount: agreeCount,
            agreedPlayers: agreedPlayers,
            initiator: settlementVoting.initiator,
            requiredCount: 2
        }
    });
}

// 执行结算逻辑
async function executeSettlement() {
    try {
        // 设置数据清除标志，阻止 ws.on('close') 保存旧数据
        dataClearedFlag = true;
        
        // 重置投票状态
        settlementVoting.isActive = false;
        settlementVoting.votes = {};
        settlementVoting.initiator = null;
        
        // 获取当前游戏状态用于保存玩家顺序
        const prevGameState = currentGameState || await loadGameState();
        const preservedOrder = prevGameState?.playerOrder || ['mozhang', 'duying', 'dongfeng', 'erwu'];

        // ===== 保存结算数据到历史结算数据库 =====
        if (prevGameState && prevGameState.history && prevGameState.history.length > 0) {
            await settlementHistoryDb.read();
            
            // 计算对局时长：第一局计分时间至结算时间
            const validHistory = prevGameState.history.filter(r => !r.isUndo && r.type !== 'manual' && r.type !== 'settlement' && r.type !== 'tableFee' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set');
            const firstRound = validHistory.length > 0 ? validHistory[0] : null;
            const settleTimeMs = Date.now(); // 结算时间
            let startTs = 0;
            if (firstRound) {
                startTs = firstRound.timestampMs || 0;
                // 如果没有timestampMs，尝试解析timestamp字符串
                if (!startTs && firstRound.timestamp) {
                    startTs = new Date(firstRound.timestamp).getTime() || 0;
                }
            }
            let durationStr = '';
            if (startTs && settleTimeMs > startTs) {
                const durationMs = settleTimeMs - startTs;
                const durationHours = Math.floor(durationMs / 3600000);
                const durationMinutes = Math.floor((durationMs % 3600000) / 60000);
                durationStr = `${durationHours}小时${durationMinutes}分钟`;
            }
            const settleTimeStr = new Date(settleTimeMs).toLocaleString('zh-CN', { hour12: false });
            
            // 收集额外分设置记录（含完整更新历史）
            const extraScoreRecords = [];
            const extraScoreHistory = [];
            if (prevGameState.players) {
                prevGameState.players.forEach(p => {
                    if (p.extraScoreRecord && p.extraScore > 0) {
                        extraScoreRecords.push(p.extraScoreRecord);
                    }
                    if (p.extraScoreHistory && p.extraScoreHistory.length > 0) {
                        extraScoreHistory.push(...p.extraScoreHistory);
                    }
                });
            }
            
            // 台费已在游戏过程中通过"自动扣除"按钮处理，结算时不再重复扣除
            // 汇总台费记录，便于结算详情展示台费收支
            const tableFeeRecords = prevGameState.history.filter(r => r.type === 'tableFee' && !r.isUndo);
            const totalTableFee = tableFeeRecords.reduce((sum, r) => sum + (r.tableFee || 0), 0);
            
            const finalRemark = pendingSettlementRemark || '';
            const settlementRecord = {
                id: settleTimeMs,
                timestamp: settleTimeStr,
                startTime: settleTimeStr,
                gameStartTime: startTs,
                duration: durationStr,
                remark: finalRemark || '',
                playerOrder: preservedOrder,
                players: prevGameState.players.map(p => ({
                    id: p.id != null ? p.id : undefined,
                    name: p.name,
                    nickname: p.nickname || '',
                    muzzleType: p.muzzleType,
                    score: p.score,
                    // 注册用户身份：结算归属与胜率统计的关键字段
                    userId: p.userId || null,
                    userNickname: p.userNickname || p.nickname || ''
                })),
                extraScoreRecords: extraScoreRecords,
                extraScoreHistory: extraScoreHistory,
                history: prevGameState.history.filter(r => !r.isUndo && r.type !== 'manual' && r.type !== 'settlement' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set'),
                totalRounds: prevGameState.history.filter(r => !r.isUndo && r.type !== 'manual' && r.type !== 'settlement' && r.type !== 'tableFee' && r.type !== 'extra_score_set' && r.type !== 'guest_bet_set').length,
                tableFeeRecords: tableFeeRecords,
                totalTableFee: totalTableFee,
                guests: (prevGameState.guests || []).filter(g => {
                    // 仅保存活跃游客（有分数/有下注/有明细），避免残留游客0分记录进入历史结算
                    const _gs = g.score || 0;
                    const _hasBets = g.bets && Object.keys(g.bets).length > 0;
                    const _hasDetails = g.details && g.details.length > 0;
                    return _gs !== 0 || _hasBets || _hasDetails;
                }).map(g => ({
                    name: g.name,
                    bets: g.bets || {},
                    score: g.score || 0,
                    details: g.details || []
                }))
            };
            settlementHistoryDb.data.settlements.push(settlementRecord);
            await settlementHistoryDb.write();
            console.log(`结算数据已保存到历史记录，对局数: ${settlementRecord.totalRounds}，时长: ${durationStr}`);
            
            // 向所有已连接的客户端同步最新的历史结算数据
            const allSettlements = settlementHistoryDb.data.settlements || [];
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: 'settlement_history_sync',
                        settlements: allSettlements
                    }));
                }
            });
        }
        
        // 清空结算备注
        pendingSettlementRemark = '';
        // 清空台费
        pendingTableFee = 0;
        settlementInitiatorMuzzle = null;
        // 清空对局开始时间
        gameStartTime = null;
        
        // 创建干净的初始游戏状态（保留昵称，清空额外分）
        const prevNicknames = {};
        if (prevGameState && prevGameState.players) {
            prevGameState.players.forEach(p => {
                if (p.nickname) prevNicknames[p.muzzleType] = p.nickname;
            });
        }
        const cleanGameState = {
            players: initializePlayers(preservedOrder).map(p => ({
                ...p,
                nickname: prevNicknames[p.muzzleType] || '',  // 保留昵称
                score: 0,
                isBanker: false,
                continuousBankerCount: 0,
                extraScore: 0,  // 清空额外分
                extraScoreRecord: null,  // 清空额外分记录
                extraScoreHistory: []  // 清空额外分历史
            })),
            history: [],
            playerOrder: [],  // 结算后清空顺序，允许玩家重新选择顺序
            manualAdjustments: [],
            // 游客下注长存：结算后保留游客身份与下注，净额/明细已并入结算记录并归零
            guests: (prevGameState.guests || []).map(g => ({
                id: g.id,
                name: g.name,
                bets: g.bets || {},
                score: 0,
                details: []
            })),
            currentScoreItems: {
                mozhang: false,
                duying: false,
                dongfeng: false,
                erwu: 0,
                qiliang: false,
                zimo: false
            },
            currentWinner: null,
            gameStartTime: null
        };
        
        // 保存干净状态到数据库
        db.data.gameState = cleanGameState;
        db.data.occupiedSeats = {};
        db.data.currentScoreItems = cleanGameState.currentScoreItems;
        db.data.playerConnections = {};
        await db.write();
        
        // 更新全局引用（两个变量都更新，确保一致）
        currentGameState = cleanGameState;
        gameState = cleanGameState;

        // 广播游客清空（结算完成，游客数据已并入结算记录）
        broadcastGuestUpdate();
        
        // 重置日志数据库
        logDb.data = { logs: [] };
        await logDb.write();
        
        // 彻底删除所有数据文件和日志文件，然后重新创建空文件
        const filesToClean = ['gameLogs.log', 'gameState.json', 'gameLogs.json'];
        for (const file of filesToClean) {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                }
            } catch (e) {
                console.error(`删除文件 ${file} 失败:`, e.message);
            }
        }
        
        // 重新写入干净的数据库文件
        db.data = {
            gameState: cleanGameState,
            occupiedSeats: {},
            currentScoreItems: cleanGameState.currentScoreItems,
            playerConnections: {}
        };
        await db.write();
        
        logDb.data = { logs: [] };
        await logDb.write();
        
        // 确保文件权限
        try {
            fs.chmodSync('gameState.json', 0o666);
            fs.chmodSync('gameLogs.json', 0o666);
        } catch (e) {
            // 忽略权限错误
        }
        
        // 重置内存中的数据
        gameOrder = null;
        playerCount = 0;
        onlinePlayers = {};
        occupiedSeats = {};
        playerConnections = {};
        recentScoreUpdates = [];
        
        // 清除服务器输出，只保留二维码和访问地址
        console.log('\n'.repeat(100));
        
        // 重新输出启动信息和二维码
        
        console.log('🎉 欢迎使用嘴子计分器至尊版');
        
        const scoreUrl = `http://${primaryIP}:2525`;
        console.log(`📱 计分系统访问地址: ${scoreUrl}`);
        
        // 生成二维码
        if (QRCodeTerminal) {
            QRCodeTerminal.generate(scoreUrl, { small: true });
        }
        console.log('─'.repeat(50));
        
        // 发送结算完成通知
        broadcast({
            type: 'settlement_completed',
            msg: '结算完成，所有数据已清除，请重新选择嘴子'
        });
        
        // 发送空的游戏状态给所有客户端
        broadcast({
            type: 'full_state',
            state: {
                players: cleanGameState.players,
                history: [],
                playerOrder: preservedOrder,
                manualAdjustments: [],
                guests: cleanGameState.guests,
                currentScoreItems: {
                    mozhang: false,
                    duying: false,
                    dongfeng: false,
                    erwu: 0,
                    qiliang: false,
                    zimo: false
                },
                currentWinner: null
            },
            onlinePlayers: {},
            occupiedSeats: {},
            playerConnections: {},
            currentScoreItems: {
                mozhang: false,
                duying: false,
                dongfeng: false,
                erwu: 0,
                qiliang: false,
                zimo: false
            },
            gameOrder: preservedOrder
        });
        
        // 发送数据清除通知
        broadcast({
            type: 'data_cleared',
            msg: '结算完成，所有数据已清除，请重新选择嘴子',
            clearType: 'settlement'
        });
        
        // 关闭所有客户端WebSocket连接
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client._dataCleared = true; // 标记为数据清除导致的关闭
                client.close(1000, 'Data cleared by admin');
            }
        });
        clients = [];
        
        console.log('结算完成，数据已清除');
    } catch (error) {
        console.error('执行结算失败:', error);
    }
}

// ==================== 后台 TTS 预缓存 ====================
function startTTSBackgroundCache() {
    const ttsCacheDir = path.join(__dirname, 'tts_cache');
    if (!fs.existsSync(ttsCacheDir)) {
        fs.mkdirSync(ttsCacheDir, { recursive: true });
    }
    const { exec } = require('child_process');

    // 预缓存范围：收入12-150，支出3-50（规范化文件名 in-X.mp3 / out-X.mp3）
    const texts = [];
    for (let i = 12; i <= 150; i++) texts.push({ text: `收入${i}`, file: `in-${i}.mp3` });
    for (let i = 3; i <= 50; i++) texts.push({ text: `支出${i}`, file: `out-${i}.mp3` });

    // 统计已缓存数量
    let alreadyCached = 0;
    const toGenerate = [];
    texts.forEach(item => {
        const mp3 = path.join(ttsCacheDir, item.file);
        if (fs.existsSync(mp3) && fs.statSync(mp3).size > 0) {
            alreadyCached++;
        } else {
            toGenerate.push(item);
        }
    });

    console.log(`[TTS] 预缓存: ${alreadyCached}/${texts.length} 已存在, ${toGenerate.length} 待生成`);

    if (toGenerate.length === 0) {
        console.log('[TTS] 所有语音缓存已就绪');
        return;
    }

    // 传递代理环境变量
    const proxyEnv = {
        ...process.env,
        PATH: process.env.PATH
    };
    if (process.env.HTTP_PROXY) proxyEnv.HTTP_PROXY = process.env.HTTP_PROXY;
    if (process.env.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;
    if (process.env.http_proxy) proxyEnv.http_proxy = process.env.http_proxy;
    if (process.env.https_proxy) proxyEnv.https_proxy = process.env.https_proxy;

    // 串行生成，避免 CPU/IO 争抢（每次间隔500ms）
    let idx = 0;
    let genOk = 0;
    let genFail = 0;

    function next() {
        if (idx >= toGenerate.length) {
            console.log(`[TTS] 预缓存完成: ${genOk} 成功, ${genFail} 失败, ${alreadyCached + genOk}/${texts.length} 总计`);
            return;
        }
        const item = toGenerate[idx++];
        const mp3Path = path.join(ttsCacheDir, item.file);
        const safeText = item.text.replace(/"/g, '\\"');

        const cmd = `python -m edge_tts --text "${safeText}" --voice "zh-CN-XiaoxiaoNeural" --rate "+0%" --write-media "${mp3Path}" 2>/dev/null`;
        exec(cmd, { timeout: 30000, env: proxyEnv }, (err) => {
            if (!err && fs.existsSync(mp3Path) && fs.statSync(mp3Path).size > 0) {
                genOk++;
            } else {
                genFail++;
            }
            setTimeout(next, 500);
        });
    }
    setTimeout(next, 1000); // 启动后1秒开始，避免与服务器初始化争抢
}

// 启动服务器
scoreServer.listen(2525, () => {
    
    console.log('🎉 欢迎使用嘴子计分器至尊版');
    
    const scoreUrl = `http://${primaryIP}:2525`;
    console.log(`📱 计分系统访问地址: ${scoreUrl}`);
    
    // 生成二维码
    if (QRCodeTerminal) {
        QRCodeTerminal.generate(scoreUrl, { small: true });
    }
    console.log('─'.repeat(50));

    // 后台检测并补全语音缓存
    startTTSBackgroundCache();
});

monitorServer.listen(5252, () => {
    // 不输出监控系统的信息
});

// 每分钟进行一次数据交换，用于保活但不发送通知
setInterval(() => {
    // 只更新玩家最后活跃时间，不标记为离线
    Object.keys(playerConnections).forEach(muzzle => {
        const connection = playerConnections[muzzle];
        if (connection) {
            playerConnections[muzzle].lastSeen = new Date().toISOString();
        }
    });
    
    // 发送保活消息，但不触发客户端通知
    broadcast({
        type: 'keep_alive',
        timestamp: new Date().toISOString()
    });
}, 60000); // 每分钟