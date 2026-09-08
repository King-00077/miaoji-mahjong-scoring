// 纯旁观监控脚本 - 不选嘴子，仅监听所有数据变化
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

const SERVER_URL = 'ws://localhost:2525';
const HTTP_URL = 'http://localhost:2525';

let msgCount = 0;
let lastState = null;

console.log('='.repeat(70));
console.log('  纯旁观监控 - 监听所有数据变化');
console.log('='.repeat(70));
console.log('');

const ws = new WebSocket(SERVER_URL);

ws.on('open', () => {
    console.log(`[${ts()}] [WS] 旁观监控已连接（不选嘴子）`);
    console.log(`[${ts()}] 等待数据...\n`);
});

ws.on('message', (data) => {
    msgCount++;
    let msg;
    try { msg = JSON.parse(data); } catch(e) { return; }

    const type = msg.type || 'unknown';
    const summary = getMessageSummary(msg);
    console.log(`[${ts()}] [#${msgCount}] ${type}: ${summary}`);

    if (type === 'full_state' || type === 'state_update') {
        const currentState = extractState(msg);
        if (lastState) {
            const diff = compareStates(lastState, currentState);
            if (diff.length > 0) {
                console.log(`  ┌─ 状态变化:`);
                diff.forEach(d => console.log(`  │ ${d}`));
                console.log(`  └─`);
            }
        }
        lastState = currentState;
    }

    if (type === 'info' && msg.isNewRound) console.log(`  ★ 新对局: 第${msg.round}局`);
    if (type === 'info' && msg.isUndo) console.log(`  ↩ 撤销: ${msg.msg}`);
    if (type === 'error') console.log(`  ✖ 错误: ${msg.msg}`);
    if (type === 'triple_win') console.log(`  🎉 三连胜: ${msg.winnerName}`);
    if (type === 'info' && msg.isManualAdjustment) console.log(`  💰 手动调整: ${msg.msg}`);
});

ws.on('close', () => console.log(`[${ts()}] [WS] 连接关闭`));
ws.on('error', (err) => console.log(`[${ts()}] [WS] 错误: ${err.message}`));

// 每10秒HTTP快照
setInterval(() => {
    http.get(`${HTTP_URL}/api/monitor/game-state`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.success && data.gameState) {
                    const gs = data.gameState;
                    console.log(`\n[${ts()}] ──── 服务器状态快照 ────`);
                    (gs.players || []).forEach(p => {
                        const online = p.isOnline ? '在线' : '离线';
                        const banker = p.isBanker ? '庄' : '  ';
                        console.log(`  ${p.name} [${p.muzzleType}]: 分数=${p.score} ${banker} ${online} 连庄=${p.continuousBankerCount}`);
                    });
                    if (gs.history && gs.history.length > 0) {
                        console.log(`  历史(最近3条):`);
                        gs.history.slice(-3).forEach(h => {
                            if (h.type === 'manual') {
                                console.log(`    [手动] ${h.fromPlayerName}→${h.toPlayerName}: ${h.adjustment}`);
                            } else {
                                console.log(`    第${h.round}局 赢家ID:${h.winnerId} 庄家ID:${h.bankerId}${h.isUndo ? ' [已撤销]' : ''}`);
                            }
                        });
                    }
                    console.log(`  计分项: ${JSON.stringify(gs.currentScoreItems)}`);
                    console.log(`  赢家ID: ${gs.currentWinner}`);
                    console.log('');
                }
            } catch(e) {}
        });
    }).on('error', () => {});
}, 10000);

function ts() { return new Date().toLocaleTimeString('zh-CN', { hour12: false }); }

function getMessageSummary(msg) {
    switch(msg.type) {
        case 'full_state':
            return `boundMuzzle=${msg.boundMuzzle}, players=${msg.state?.players?.length||0}, history=${msg.state?.history?.length||0}`;
        case 'state_update':
            const scores = msg.state?.players?.map(p => `${p.name}:${p.score}`).join(', ') || '';
            const items = msg.currentScoreItems ? Object.entries(msg.currentScoreItems).filter(([k,v])=>v).map(([k,v])=>`${k}=${v}`).join(',') : '';
            return `scores=[${scores}] items={${items}} winner=${msg.state?.currentWinner} newRound=${msg.isNewRound||false}`;
        case 'info':
            return msg.msg ? msg.msg.replace(/<[^>]+>/g, '').substring(0, 80) : '';
        case 'heartbeat_ack': case 'keep_alive':
            return '';
        default:
            return JSON.stringify(msg).substring(0, 120);
    }
}

function extractState(msg) {
    const state = msg.state || msg;
    return {
        players: state.players ? state.players.map(p => ({
            muzzle: p.muzzleType, score: p.score, isBanker: p.isBanker, isOnline: p.isOnline, cbc: p.continuousBankerCount
        })) : [],
        historyLen: state.history ? state.history.length : 0,
        currentWinner: state.currentWinner,
        scoreItems: msg.currentScoreItems || state.currentScoreItems,
        onlinePlayers: msg.onlinePlayers
    };
}

function compareStates(old, cur) {
    const diffs = [];
    if (old.players.length === cur.players.length) {
        for (let i = 0; i < cur.players.length; i++) {
            const op = old.players[i], cp = cur.players[i];
            if (!op || !cp) continue;
            if (op.score !== cp.score) diffs.push(`分数: ${cp.muzzle} ${op.score}→${cp.score}`);
            if (op.isBanker !== cp.isBanker) diffs.push(`庄家: ${cp.muzzle} ${op.isBanker}→${cp.isBanker}`);
            if (op.isOnline !== cp.isOnline) diffs.push(`在线: ${cp.muzzle} ${op.isOnline}→${cp.isOnline}`);
            if (op.cbc !== cp.cbc) diffs.push(`连庄: ${cp.muzzle} ${op.cbc}→${cp.cbc}`);
        }
    }
    if (old.historyLen !== cur.historyLen) diffs.push(`历史: ${old.historyLen}→${cur.historyLen}`);
    if (JSON.stringify(old.scoreItems) !== JSON.stringify(cur.scoreItems)) diffs.push(`计分项变化`);
    if (old.currentWinner !== cur.currentWinner) diffs.push(`赢家: ${old.currentWinner}→${cur.currentWinner}`);
    if (JSON.stringify(old.onlinePlayers) !== JSON.stringify(cur.onlinePlayers)) diffs.push(`在线状态变化`);
    return diffs;
}
