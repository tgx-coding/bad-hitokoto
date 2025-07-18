const express = require('express');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs'); // 添加fs模块引入
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.db');

// 全局请求计数器 
let globalRequestCount = 0;
const GLOBAL_LIMIT = 500; // 15分钟内全局最大请求数
const WINDOW_MS = 15 * 60 * 1000; // 15分钟窗口

// 每15分钟重置计数器
setInterval(() => {
  globalRequestCount = 0;
  console.log(`[${new Date().toISOString()}] 全局请求计数器已重置`);
}, WINDOW_MS);

// 添加代理支持以获取真实IP
app.set('trust proxy', true);

// ======================== 恶意IP检测与黑名单系统 ========================
const IP_BLACKLIST = new Map(); // { ip: banExpiryTimestamp }
const IP_REQUEST_COUNTERS = new Map(); // { ip: { count: number, expiry: timestamp } }
const BAN_DURATION = 48 * 60 * 60 * 1000; // 48小时封禁
const MALICIOUS_THRESHOLD = 600; // 15分钟内600次请求视为恶意IP

// 定期清理过期计数器
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of IP_REQUEST_COUNTERS.entries()) {
    if (data.expiry <= now) {
      IP_REQUEST_COUNTERS.delete(ip);
    }
  }
}, 60 * 1000); // 每分钟清理一次

// 定期清理过期黑名单
setInterval(() => {
  const now = Date.now();
  for (const [ip, expiry] of IP_BLACKLIST.entries()) {
    if (expiry <= now) {
      IP_BLACKLIST.delete(ip);
      console.log(`[${new Date(now).toISOString()}] IP ${ip} 已从黑名单移除`);
    }
  }
}, 30 * 60 * 1000); // 每30分钟清理一次

// 恶意IP检测中间件
const ipBlacklistMiddleware = (req, res, next) => {
  const clientIP = req.headers['x-forwarded-for'] || req.ip;
  
  // 检查IP是否在黑名单中
  const banExpiry = IP_BLACKLIST.get(clientIP);
  if (banExpiry) {
    if (banExpiry > Date.now()) {
      // 仍在封禁期内
      const remainingHours = ((banExpiry - Date.now()) / (60 * 60 * 1000)).toFixed(1);
      
      // 记录封禁日志
      console.warn(`[${new Date().toISOString()}] 拒绝黑名单IP: ${clientIP}, 剩余封禁时间: ${remainingHours}小时`);
      
      return res.status(403).json({
        error: '您的IP已被封禁',
        message: `检测到恶意行为，该IP已被封禁48小时。剩余时间: ${remainingHours}小时`,
        timestamp: new Date().toISOString(),
        expiry: banExpiry
      });
    } else {
      // 封禁已过期，移除黑名单
      IP_BLACKLIST.delete(clientIP);
    }
  }
  
  // 更新IP请求计数器
  let ipData = IP_REQUEST_COUNTERS.get(clientIP);
  const now = Date.now();
  
  if (!ipData || ipData.expiry <= now) {
    // 新计数器或计数器已过期
    ipData = { count: 1, expiry: now + WINDOW_MS };
    IP_REQUEST_COUNTERS.set(clientIP, ipData);
  } else {
    // 增加计数器
    ipData.count++;
    
    // 检查是否达到恶意阈值
    if (ipData.count >= MALICIOUS_THRESHOLD) {
      // 添加到黑名单
      const banExpiry = now + BAN_DURATION;
      IP_BLACKLIST.set(clientIP, banExpiry);
      
      // 记录安全事件
      console.error(`[${new Date().toISOString()}] 检测到恶意IP: ${clientIP}, 请求次数: ${ipData.count}, 已封禁至 ${new Date(banExpiry).toISOString()}`);
      
      // 返回封禁响应
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

// ip速率限制器
const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 100,                // 每个IP最多100次请求
  standardHeaders: true,   // 返回标准速率限制头
  legacyHeaders: false,    // 禁用旧版头
  skip: (req) => {
    // 黑名单IP直接跳过正常限流（已在前置中间件处理）
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    return IP_BLACKLIST.has(clientIP);
  },
  handler: (req, res) => {
    // 获取操作类型（如果有）
    const operation = req.query.operation || 'random';
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    
    // 记录警告日志（包含触发IP和操作类型）
    console.warn(`[${new Date().toISOString()}] IP速率限制触发: IP=${clientIP}, 操作=${operation}`);
    
    // 返回JSON格式的错误响应
    res.status(429).json({
      error: '单个IP请求过多，请15分钟后再试',
      timestamp: new Date().toISOString(),
      retryAfter: Math.ceil(req.rateLimit.resetTime - Date.now()) // 添加重试等待时间(毫秒)
    });
  }
});

// 全局速率限制中间件
const globalRateLimiter = (req, res, next) => {
  globalRequestCount++;
  
  if (globalRequestCount > GLOBAL_LIMIT) {
    // 获取操作类型（如果有）
    const operation = req.query.operation || 'unknown';
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    
    // 记录全局限制警告
    console.warn(`[${new Date().toISOString()}] 全局速率限制触发: IP=${clientIP}, 操作=${operation}, 当前请求数=${globalRequestCount}`);
    
    return res.status(429).json({
      error: '全局暂停，15分钟后再试吧',
      timestamp: new Date().toISOString(),
      retryAfter: WINDOW_MS
    });
  }
  
  next();
};

// 自定义日志格式
const accessLogStream = fs.createWriteStream(
  path.join(__dirname, 'access.log'), 
  { flags: 'a' } // 追加模式
);

// 自定义日志格式
morgan.token('real-ip', (req) => {
  return req.headers['x-forwarded-for'] || req.ip;
});

morgan.token('operation', (req) => {
  return req.query.operation || 'unknown';
});

// 使用自定义日志格式
app.use(morgan(
  '[:date[iso]] :real-ip - :operation - ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms',
  { stream: accessLogStream }
));

// 创建数据库连接
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
  if (err) {
    console.error('数据库连接错误:', err.message);
    process.exit(1);
  }
  console.log('成功连接到SQLite数据库');
});

// 主服务逻辑
// 使用全局状态对象，存储数据库统计信息
const appState = {
  totalSentences: 0,
  maxCount: 0,
  minCount: 0
};

async function startServer() {
  try {
    // 获取数据库统计信息
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
    
    // 设置静态文件服务（用于前端HTML）
    app.use(express.static('public'));
  
    // 应用中间件顺序：黑名单检测 -> 全局限制 -> IP限流
    app.get('/api/hitokoto', 
      ipBlacklistMiddleware,  // 恶意IP检测
      globalRateLimiter,     // 全局速率限制
      apiLimiter,            // IP速率限制
      async (req, res) => {
      try {
        const operation = req.query.operation || 'random';
        const clientIP = req.headers['x-forwarded-for'] || req.ip;
        const userAgent = req.get('User-Agent') || 'unknown';
        const levelParam = req.query.level; // level参数
        
        // 构建SQL查询
        let query = "SELECT * FROM main";
        let params = [];
        let conditions = [];
        
        // level过滤
        if (levelParam === 'max' || levelParam === 'min') {
          conditions.push("level = ?");
          params.push(levelParam);
        }
        
        // 组合查询条件
        if (conditions.length > 0) {
          query += " WHERE " + conditions.join(" AND ");
        }
        
        // 添加随机排序和限制
        query += " ORDER BY RANDOM() LIMIT 1";
        
        // 执行数据库查询
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
        
        // 记录详细日志
        const logEntry = {
          timestamp: new Date().toISOString(),
          ip: clientIP,
          operation: operation,
          userAgent: userAgent,
          sentence: row.text,
          id: row.id,
          level: row.level
        };
        
        console.log(JSON.stringify(logEntry));
        
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

    // 启动服务器
    app.listen(PORT, () => {
      console.log(`服务已启动: http://localhost:${PORT}`);
      console.log(`API地址: http://localhost:${PORT}/api/hitokoto`);
      console.log(`访问日志将保存到: ${path.join(__dirname, 'access.log')}`);
      console.log(`全局请求限制: ${GLOBAL_LIMIT} 次/${WINDOW_MS/60000}分钟`);
      console.log(`恶意IP检测阈值: ${MALICIOUS_THRESHOLD} 次/${WINDOW_MS/60000}分钟请求将被封禁48小时`);
      console.log(`级别查询示例: /api/hitokoto?level=max`);
      console.log(`级别查询示例: /api/hitokoto?level=min`);
      
      // 显示当前黑名单状态
      console.log(`当前黑名单IP数量: ${IP_BLACKLIST.size}`);
    });
  } catch (err) {
    console.error('初始化失败:', err);
    process.exit(1);
  }
}

// 添加数据库连接关闭处理
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

// 启动服务
startServer();