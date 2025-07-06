const express = require('express');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const morgan = require('morgan');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'hitokoto.txt');

//全局请求计数器 
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

//ip速率限制器
const apiLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 100,                // 每个IP最多100次请求
  standardHeaders: true,   // 返回标准速率限制头
  legacyHeaders: false,    // 禁用旧版头
  handler: (req, res) => {
    // 获取操作类型（如果有）
    const operation = req.query.operation || 'random';
    
    // 记录警告日志（包含触发IP和操作类型）
    console.warn(`[${new Date().toISOString()}] IP速率限制触发: IP=${req.ip}, 操作=${operation}`);
    
    // 返回JSON格式的错误响应
    res.status(429).json({
      error: '单个IP请求过多，请15分钟后再试',
      timestamp: new Date().toISOString(),
      retryAfter: Math.ceil(req.rateLimit.resetTime - Date.now()) // 添加重试等待时间(毫秒)
    });
  }
});

//全局速率限制中间件
const globalRateLimiter = (req, res, next) => {
  globalRequestCount++;
  
  if (globalRequestCount > GLOBAL_LIMIT) {
    // 获取操作类型（如果有）
    const operation = req.query.operation || 'unknown';
    const clientIP = req.headers['x-forwarded-for'] || req.ip;
    
    // 记录全局限制警告
    console.warn(`[${new Date().toISOString()}] 全局速率限制触发: IP=${clientIP}, 操作=${operation}, 当前请求数=${globalRequestCount}`);
    
    return res.status(429).json({
      error: '服务繁忙，请15分钟后再试',
      timestamp: new Date().toISOString(),
      retryAfter: WINDOW_MS
    });
  }
  
  next();
};

// 自定义流解析器：将文本按 | 分割为句子
class HitokotoParser extends Transform {
  constructor() {
    super({ readableObjectMode: true });
    this.buffer = '';
  }

  _transform(chunk, encoding, callback) {
    this.buffer += chunk.toString();
    const segments = this.buffer.split('|');
    this.buffer = segments.pop() || '';
    
    segments.forEach(segment => {
      if (segment.trim()) {
        this.push(segment.trim());
      }
    });
    
    callback();
  }

  _flush(callback) {
    if (this.buffer.trim()) {
      this.push(this.buffer.trim());
    }
    callback();
  }
}

// 流式统计句子总数
function countSentences() {
  return new Promise((resolve, reject) => {
    let count = 0;
    
    fs.createReadStream(DATA_FILE)
      .pipe(new HitokotoParser())
      .on('data', () => count++)
      .on('end', () => resolve(count))
      .on('error', reject);
  });
}

// 流式获取特定位置的句子
function getSentenceAtPosition(position) {
  return new Promise((resolve, reject) => {
    let current = 0;
    
    const stream = fs.createReadStream(DATA_FILE)
      .pipe(new HitokotoParser())
      .on('data', (sentence) => {
        current++;
        if (current === position) {
          resolve(sentence);
          stream.destroy();
        }
      })
      .on('end', () => {
        if (current < position) {
          reject(new Error('超出句子范围'));
        }
      })
      .on('error', reject);
  });
}

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

// 主服务逻辑
async function startServer() {
  try {
    // 预热：统计总句子数
    const totalSentences = await countSentences();
    console.log(`一言库已加载，共 ${totalSentences} 条句子`);
    
    // 设置静态文件服务（用于前端HTML）
    app.use(express.static('public'));
  
    // API路由：返回JSON格式的一言
    //添加全局限制中间件
    app.get('/api/hitokoto', globalRateLimiter, apiLimiter, async (req, res) => {
      try {
        const operation = req.query.operation || 'random';
        const clientIP = req.headers['x-forwarded-for'] || req.ip;
        const userAgent = req.get('User-Agent') || 'unknown';
        
        const randomPos = Math.floor(Math.random() * totalSentences) + 1;
        const sentence = await getSentenceAtPosition(randomPos);
        
        // 记录详细日志
        const logEntry = {
          timestamp: new Date().toISOString(),
          ip: clientIP,
          operation: operation,
          userAgent: userAgent,
          sentence: sentence,
          position: randomPos
        };
        
        console.log(JSON.stringify(logEntry));
        
        res.json({
          hitokoto: sentence,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('获取一言失败:', err);
        res.status(500).json({ error: '获取一言失败' });
      }
    });

    // 启动服务器
    app.listen(PORT, () => {
      console.log(`服务已启动: http://localhost:${PORT}`);
      console.log(`API地址: http://localhost:${PORT}/api/hitokoto`);
      console.log(`访问日志将保存到: ${path.join(__dirname, 'access.log')}`);
      console.log(`全局请求限制: ${GLOBAL_LIMIT} 次/${WINDOW_MS/60000}分钟`);
    });
  } catch (err) {
    console.error('初始化失败:', err);
    process.exit(1);
  }
}

// 添加文件变化监听
fs.watch(DATA_FILE, (eventType) => {
  if (eventType === 'change') {
    console.log('检测到一言库更新，将在下次请求时重新统计...');
  }
});

// 启动服务
startServer();