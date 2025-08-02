
const express = require('express');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.db');

let globalRequestCount = 0;
const GLOBAL_LIMIT = 500;
const WINDOW_MS = 15 * 60 * 1000;

setInterval(() => {
  globalRequestCount = 0;
  console.log(`[${new Date().toISOString()}] 全局请求计数器已重置`);
}, WINDOW_MS);

app.set('trust proxy', true);

const IP_BLACKLIST = new Map();
const IP_REQUEST_COUNTERS = new Map();
const BAN_DURATION = 48 * 60 * 60 * 1000;
const MALICIOUS_THRESHOLD = 600;

setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of IP_REQUEST_COUNTERS.entries()) {
    if (data.expiry <= now) {
      IP_REQUEST_COUNTERS.delete(ip);
    }
  }
}, 60 * 1000);

setInterval(() => {
  const now = Date.now();
  for (const [ip, expiry] of IP_BLACKLIST.entries()) {
    if (expiry <= now) {
      IP_BLACKLIST.delete(ip);
      console.log(`[${new Date(now).toISOString()}] IP ${ip} 已从黑名单移除`);
    }
  }
}, 30 * 60 * 1000);

const ipBlacklistMiddleware = (req, res, next) => {
  const clientIP = req.headers['x-forwarded-for'] || req.ip;
  const banExpiry = IP_BLACKLIST.get(clientIP);
  if (banExpiry) {
    if (banExpiry > Date.now()) {
      const remainingHours = ((banExpiry - Date.now()) / (60 * 60 * 1000)).toFixed(1);
      console.warn(`[${new Date().toISOString()}] 拒绝黑名单IP: ${clientIP}, 剩余封禁时间: ${remainingHours}小时`);
      return res.status(403).json({
        error: '您的IP已被封禁',
        message: `检测到恶意行为，该IP已被封禁48小时。剩余时间: ${remainingHours}小时`,
        timestamp: new Date().toISOString(),
        expiry: banExpiry
      });
    } else {
      IP_BLACKLIST.delete(clientIP);
    }
  }
  let ipData = IP_REQUEST_COUNTERS.get(clientIP);
  const now = Date.now();
  if (!ipData || ipData.expiry <= now) {
    ipData = { count: 1, expiry: now + WINDOW_MS };
    IP_REQUEST_COUNTERS.set(clientIP, ipData);
  } else {
    ipData.count++;
    if (ipData.count >= MALICIOUS_THRESHOLD) {
      const banExpiry = now + BAN_DURATION;
      IP_BLACKLIST.set(clientIP, banExpiry);
      console.error(`[${new Date().toISOString()}] 检测到恶意IP: ${clientIP}, 请求次数: ${ipData.count}, 已封禁至 ${new Date(banExpiry).toISOString()}`);
      return res.status(403).json({
        error: '您的IP已被封禁',
        message: '检测到异常高频请求，该IP已被封禁48小时',
        timestamp: new Date().toISOString(),
        expiry: banExpiry
      });
    }
  }
  next();
};

const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    return IP_BLACKLIST.has(clientIP);
  },
  handler: (req, res) => {
    const operation = req.query.operation || 'random';
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    console.warn(`[${new Date().toISOString()}] IP速率限制触发: IP=${clientIP}, 操作=${operation}`);
    res.status(429).json({
      error: '单个IP请求过多，请15分钟后再试',
      timestamp: new Date().toISOString(),
      retryAfter: Math.ceil(req.rateLimit.resetTime - Date.now())
    });
  }
});

const globalRateLimiter = (req, res, next) => {
  globalRequestCount++;
  if (globalRequestCount > GLOBAL_LIMIT) {
    const operation = req.query.operation || 'unknown';
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    console.warn(`[${new Date().toISOString()}] 全局速率限制触发: IP=${clientIP}, 操作=${operation}, 当前请求数=${globalRequestCount}`);
    return res.status(429).json({
      error: '全局暂停，15分钟后再试吧',
      timestamp: new Date().toISOString(),
      retryAfter: WINDOW_MS
    });
  }
  next();
};

const accessLogStream = fs.createWriteStream(
  path.join(__dirname, 'access.log'),
  { flags: 'a' }
);

morgan.token('real-ip', (req) => req.headers['x-forwarded-for'] || req.ip);
morgan.token('operation', (req) => req.query.operation || 'unknown');

app.use(morgan(
  '[:date[iso]] :real-ip - :operation - ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms',
  { stream: accessLogStream }
));

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('数据库连接错误:', err.message);
    process.exit(1);
  }
  console.log('成功连接到SQLite数据库');
});

const appState = {
  totalSentences: 0,
  maxCount: 0,
  minCount: 0
};

async function startServer() {
  try {
    const stats = await new Promise((resolve, reject) => {
      db.get(`
        SELECT 
          COUNT(*) AS total,
          SUM(CASE WHEN level = 'max' THEN 1 ELSE 0 END) AS maxCount,
          SUM(CASE WHEN level = 'min' THEN 1 ELSE 0 END) AS minCount
        FROM main
      `, (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });
    appState.totalSentences = stats.total;
    appState.maxCount = stats.maxCount;
    appState.minCount = stats.minCount;
    console.log(`一言库统计: 总计 ${appState.totalSentences} 条句子`);
    console.log(`  - max级别: ${appState.maxCount} 条 (人文类)`);
    console.log(`  - min级别: ${appState.minCount} 条 (天气/时间类)`);
    app.use(express.static('public'));
    app.get('/api/hitokoto',
      ipBlacklistMiddleware,
      globalRateLimiter,
      apiLimiter,
      async (req, res) => {
        try {
          const operation = req.query.operation || 'random';
          const clientIP = req.headers['x-forwarded-for'] || req.ip;
          const userAgent = req.get('User-Agent') || 'unknown';
          const levelParam = req.query.level;
          const idParam = parseInt(req.query.id, 10);
          let query = "SELECT * FROM main";
          let params = [];
          if (!isNaN(idParam)) {
            query += " WHERE id = ?";
            params.push(idParam);
          } else {
            let conditions = [];
            if (levelParam === 'max' || levelParam === 'min') {
              conditions.push("level = ?");
              params.push(levelParam);
            }
            if (conditions.length > 0) {
              query += " WHERE " + conditions.join(" AND ");
            }
            query += " ORDER BY RANDOM() LIMIT 1";
          }
          const row = await new Promise((resolve, reject) => {
            db.get(query, params, (err, row) => {
              if (err) return reject(err);
              resolve(row);
            });
          });
          if (!row) {
            return res.status(404).json({
              error: '未找到匹配的句子',
              timestamp: new Date().toISOString()
            });
          }
          console.log(JSON.stringify({
            timestamp: new Date().toISOString(),
            ip: clientIP,
            operation,
            userAgent,
            sentence: row.text,
            id: row.id,
            level: row.level
          }));
          res.json({
            hitokoto: row.text,
            id: row.id,
            level: row.level,
            timestamp: new Date().toISOString()
          });
        } catch (err) {
          console.error('获取一言失败:', err);
          res.status(500).json({
            error: '获取一言失败',
            details: err.message
          });
        }
      });
    app.listen(PORT, () => {
      console.log(`服务已启动: http://localhost:${PORT}`);
      console.log(`API地址: http://localhost:${PORT}/api/hitokoto`);
      console.log(`访问日志将保存到: ${path.join(__dirname, 'access.log')}`);
      console.log(`全局请求限制: ${GLOBAL_LIMIT} 次/${WINDOW_MS / 60000}分钟`);
      console.log(`恶意IP检测阈值: ${MALICIOUS_THRESHOLD} 次/${WINDOW_MS / 60000}分钟请求将被封禁48小时`);
      console.log(`级别查询示例: /api/hitokoto?level=max`);
      console.log(`级别查询示例: /api/hitokoto?level=min`);
      console.log(`ID查询示例: /api/hitokoto?id=1`);
      console.log(`当前黑名单IP数量: ${IP_BLACKLIST.size}`);
    });
  } catch (err) {
    console.error('初始化失败:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error('关闭数据库连接时出错:', err.message);
    } else {
      console.log('数据库连接已关闭');
    }
    process.exit(0);
  });
});

startServer();
