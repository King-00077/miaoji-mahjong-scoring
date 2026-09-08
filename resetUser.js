const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const userId = process.argv[2];
if (!userId) {
    console.error("用法：node resetUser.js <用户ID>");
    console.error("示例：node resetUser.js u0001");
    process.exit(1);
}

const userFile = path.join(__dirname, "users.json");
if (!fs.existsSync(userFile)) {
    console.error("错误：users.json 不存在");
    process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(userFile, "utf8"));
const users = Array.isArray(raw.users) ? raw.users : [];
const uid = String(userId).trim().toLowerCase();
const user = users.find(u => u.userId === uid);

if (!user) {
    console.error("错误：ID " + uid + " 用户不存在");
    process.exit(1);
}

const DEFAULT_PASSWORD = "123456";
user.nickname = uid;
user.password = crypto.createHash("sha256").update(DEFAULT_PASSWORD).digest("hex");

fs.writeFileSync(userFile, JSON.stringify(raw, null, 2), "utf8");
console.log("✅ 已重置用户 ID: " + uid);
console.log("   新昵称: " + uid);
console.log("   新密码: " + DEFAULT_PASSWORD);
