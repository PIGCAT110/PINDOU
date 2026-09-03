/**
 * PIGCAT拼豆工坊 - 后端服务
 * 
 * 功能：
 * 1. 提供静态文件服务（HTML/CSS/JS/字体）
 * 2. 代理AI卡通化API调用（保护API密钥不暴露在前端）
 *    - 使用OpenAI兼容的 gpt-image-2 模型
 *    - 图生图：将照片转化为二维卡通像素风格
 * 
 * 启动方式：
 *   npm install
 *   node server.js
 * 
 * 然后访问 http://localhost:3000
 */

// 加载 .env 环境变量（开发/自部署用；部署平台可直接配置同名环境变量）
// 用 try/catch 包裹：即使部署时未执行 npm install 导致 dotenv 缺失，服务也能正常启动，
// 此时回退到环境变量或代码默认值，避免"服务起不来 → 前端误报密码错误"。
try { require('dotenv').config(); } catch (e) {
  console.warn('[ENV] 未加载 .env（dotenv 缺失或无 .env 文件），将使用环境变量或代码默认值');
}

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ============================================================
// 数据存储管理（JSON文件持久化）
// ============================================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadJson(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return [];
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); }
  catch (e) { console.error('[DATA] 读取失败:', filename, e.message); return []; }
}

function saveJson(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================
// 卡密生成与验证（服务端，与前端算法一致）
// ============================================================
const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KEY_PLAN_CREDITS = { A: 1, B: 3, C: 5, D: 10 };
const SKU_TO_PLAN = { '1': 'A', '3': 'B', '5': 'C', '10': 'D' };
// 读取密码/密钥时去除首尾空白与回车，避免 .env 文件因 CR/空格导致比对失败
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || 'PIGCAT110').trim();

function generateServerKey(plan) {
  function randomChar() { return KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)]; }
  function calcChecksum(chars11) {
    let sum = 0;
    for (let i = 0; i < chars11.length; i++) sum += KEY_CHARS.indexOf(chars11[i]);
    return KEY_CHARS[sum % KEY_CHARS.length];
  }
  let chars11 = plan;
  for (let i = 1; i < 11; i++) chars11 += randomChar();
  const all12 = chars11 + calcChecksum(chars11);
  return 'PC-' + all12.substring(0, 4) + '-' + all12.substring(4, 8) + '-' + all12.substring(8, 12);
}

function validateServerKey(key) {
  if (key.length !== 17) return false;
  if (key.substring(0, 3) !== 'PC-') return false;
  if (key.charAt(7) !== '-' || key.charAt(12) !== '-') return false;
  const chars = key.substring(3, 7) + key.substring(8, 12) + key.substring(13, 17);
  for (let i = 0; i < 12; i++) if (KEY_CHARS.indexOf(chars[i]) < 0) return false;
  const data11 = chars.substring(0, 11);
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += KEY_CHARS.indexOf(data11[i]);
  if (chars.charAt(11) !== KEY_CHARS[sum % KEY_CHARS.length]) return false;
  return !!KEY_PLAN_CREDITS[chars.charAt(0)];
}

function getKeyCredits(key) {
  const chars = key.substring(3, 7) + key.substring(8, 12) + key.substring(13, 17);
  return KEY_PLAN_CREDITS[chars.charAt(0)] || 0;
}

// 生成链接令牌（12位hex，用于直通链接）
function generateLinkToken() {
  return crypto.randomBytes(6).toString('hex');
}

// ============================================================
// 用户认证系统
// ============================================================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'pigcat_salt_2024').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

// 注册
app.post('/api/user/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '邮箱和密码必填，密码至少6位' });
  }
  const users = loadJson('users.json');
  if (users.find(u => u.email === email.toLowerCase())) {
    return res.status(409).json({ error: '该邮箱已注册' });
  }
  const user = {
    id: 'u_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    email: email.toLowerCase(),
    passwordHash: hashPassword(password),
    token: generateToken(),
    createdAt: Date.now()
  };
  users.push(user);
  saveJson('users.json', users);
  console.log(`[USER] 新用户注册: ${user.email}`);
  res.json({ token: user.token, userId: user.id, email: user.email });
});

// 登录
app.post('/api/user/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  const users = loadJson('users.json');
  const user = users.find(u => u.email === email.toLowerCase());
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  user.token = generateToken();
  saveJson('users.json', users);
  console.log(`[USER] 用户登录: ${user.email}`);
  res.json({ token: user.token, userId: user.id, email: user.email });
});

// 获取用户信息
app.get('/api/user/profile', (req, res) => {
  const token = req.query.token || req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const users = loadJson('users.json');
  const user = users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: '登录已过期' });
  res.json({ userId: user.id, email: user.email, createdAt: user.createdAt });
});

// ============================================================
// 生成历史记录
// ============================================================
app.post('/api/history/save', (req, res) => {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const users = loadJson('users.json');
  const user = users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: '登录已过期' });

  const { thumb, prompt, brandName, gridSize, colorCount } = req.body;
  const records = loadJson('history.json');
  const record = {
    id: 'h_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex'),
    userId: user.id,
    thumb: (thumb || '').substring(0, 50000),
    prompt: (prompt || '').substring(0, 200),
    brandName: brandName || '',
    gridSize: gridSize || '',
    colorCount: colorCount || 0,
    createdAt: Date.now()
  };
  records.unshift(record);
  if (records.length > 2000) records.length = 2000;
  saveJson('history.json', records);
  res.json({ id: record.id });
});

app.get('/api/history/list', (req, res) => {
  const token = req.query.token || req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const users = loadJson('users.json');
  const user = users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: '登录已过期' });
  const records = loadJson('history.json').filter(r => r.userId === user.id);
  res.json({ records });
});

app.delete('/api/history/:id', (req, res) => {
  const token = req.headers['x-user-token'];
  if (!token) return res.status(401).json({ error: '未登录' });
  const users = loadJson('users.json');
  const user = users.find(u => u.token === token);
  if (!user) return res.status(401).json({ error: '登录已过期' });
  let records = loadJson('history.json');
  const before = records.length;
  records = records.filter(r => !(r.id === req.params.id && r.userId === user.id));
  saveJson('history.json', records);
  res.json({ ok: true, deleted: before - records.length });
});

// ============================================================
// 管理员认证
// ============================================================
let adminToken = null;

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理员密码错误' });
  }
  adminToken = generateToken();
  res.json({ token: adminToken });
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: '管理员未登录' });
  }
  next();
}

// ============================================================
// 订单管理 + 卡密自动生成
// ============================================================
// 订单数据结构: { orderNo, sku, credits, cardKey, status: 'pending'|'redeemed', createdAt, redeemedAt }

// 批量导入订单（自动生成卡密）
app.post('/api/admin/orders/import', adminAuth, (req, res) => {
  const { orders, sku } = req.body;
  // orders: 字符串（每行一个订单号）或数组
  // sku: '1'|'3'|'5'|'10'
  if (!orders) return res.status(400).json({ error: '缺少订单数据' });
  
  const plan = SKU_TO_PLAN[sku];
  if (!plan) return res.status(400).json({ error: '无效的SKU，需为 1/3/5/10' });

  let orderList = [];
  if (typeof orders === 'string') {
    orderList = orders.split(/[\n,，\s]+/).map(s => s.trim()).filter(s => s.length > 0);
  } else if (Array.isArray(orders)) {
    orderList = orders.map(s => String(s).trim()).filter(s => s.length > 0);
  }

  if (orderList.length === 0) return res.status(400).json({ error: '没有有效的订单号' });

  const existing = loadJson('orders.json');
  const existingNos = new Set(existing.map(o => o.orderNo));
  const newOrders = [];
  const skipped = [];

  for (const orderNo of orderList) {
    if (existingNos.has(orderNo)) {
      skipped.push(orderNo);
      continue;
    }
    const cardKey = generateServerKey(plan);
    const linkToken = generateLinkToken();
    const order = {
      orderNo,
      sku,
      credits: KEY_PLAN_CREDITS[plan],
      remaining: KEY_PLAN_CREDITS[plan],
      cardKey,
      linkToken,
      status: 'pending',
      createdAt: Date.now(),
      redeemedAt: null
    };
    existing.push(order);
    newOrders.push(order);
  }

  saveJson('orders.json', existing);
  console.log(`[ADMIN] 导入订单: ${newOrders.length}个新, ${skipped.length}个重复`);
  res.json({
    imported: newOrders.length,
    skipped: skipped.length,
    skippedOrders: skipped,
    orders: newOrders
  });
});

// 查询所有订单
app.get('/api/admin/orders', adminAuth, (req, res) => {
  const orders = loadJson('orders.json');
  const { status, page } = req.query;
  let filtered = orders;
  if (status === 'pending') filtered = orders.filter(o => o.status === 'pending');
  if (status === 'redeemed') filtered = orders.filter(o => o.status === 'redeemed');
  if (status === 'exhausted') filtered = orders.filter(o => (o.remaining !== undefined ? o.remaining : o.credits) === 0);
  if (status === 'links') filtered = orders.filter(o => o.orderNo && o.orderNo.startsWith('POOL_'));
  
  const pageNum = parseInt(page) || 1;
  const pageSize = 50;
  const start = (pageNum - 1) * pageSize;
  const pageData = filtered.slice(start, start + pageSize);
  
  res.json({
    orders: pageData,
    total: filtered.length,
    page: pageNum,
    totalPages: Math.ceil(filtered.length / pageSize)
  });
});

// 管理员统计
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const orders = loadJson('orders.json');
  const users = loadJson('users.json');
  const history = loadJson('history.json');
  const getRem = (o) => o.remaining !== undefined ? o.remaining : o.credits;

  res.json({
    totalOrders: orders.length,
    pending: orders.filter(o => o.status === 'pending').length,
    redeemed: orders.filter(o => o.status === 'redeemed').length,
    exhausted: orders.filter(o => getRem(o) === 0).length,
    active: orders.filter(o => { var r = getRem(o); return r > 0 && r < o.credits; }).length,
    totalUsers: users.length,
    totalHistory: history.length,
    skuBreakdown: {
      '1': orders.filter(o => o.sku === '1').length,
      '3': orders.filter(o => o.sku === '3').length,
      '5': orders.filter(o => o.sku === '5').length,
      '10': orders.filter(o => o.sku === '10').length,
    }
  });
});

// 删除订单
app.delete('/api/admin/orders/:orderNo', adminAuth, (req, res) => {
  let orders = loadJson('orders.json');
  const before = orders.length;
  orders = orders.filter(o => o.orderNo !== req.params.orderNo);
  saveJson('orders.json', orders);
  res.json({ ok: true, deleted: before - orders.length });
});

// ============================================================
// 顾客自助卡密兑换
// ============================================================
app.post('/api/redeem', (req, res) => {
  const { orderNo } = req.body;
  if (!orderNo || !orderNo.trim()) {
    return res.status(400).json({ error: '请输入订单号' });
  }
  const orders = loadJson('orders.json');
  const order = orders.find(o => o.orderNo === orderNo.trim());
  if (!order) {
    return res.status(404).json({ error: '订单号不存在，请检查输入或联系客服' });
  }
  
  if (order.status === 'redeemed') {
    // 已兑换过，返回同一个卡密（允许顾客再次查看）
    return res.json({
      cardKey: order.cardKey,
      linkToken: order.linkToken || '',
      credits: order.credits,
      alreadyRedeemed: true,
      redeemedAt: order.redeemedAt
    });
  }
  
  // 首次兑换
  order.status = 'redeemed';
  order.redeemedAt = Date.now();
  saveJson('orders.json', orders);
  console.log(`[REDEEM] 订单 ${order.orderNo} 兑换卡密: ${order.cardKey}`);
  
  res.json({
    cardKey: order.cardKey,
    linkToken: order.linkToken || '',
    credits: order.credits,
    alreadyRedeemed: false
  });
});

// 兑换页验证卡密有效性（供前端调用）
app.post('/api/verify-key', (req, res) => {
  const { key } = req.body;
  if (!key) return res.json({ valid: false });
  const upper = key.trim().toUpperCase();
  res.json({ valid: validateServerKey(upper), credits: getKeyCredits(upper) });
});

// ============================================================
// 直通链接系统（令牌验证 / 消耗 / 批量生成）
// ============================================================
// 链接格式: https://域名/?token=xxxxxxxxxxxx
// 顾客点击链接即可直接使用，无需输入卡密

// 验证链接令牌
app.post('/api/link/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ valid: false });
  const orders = loadJson('orders.json');
  const order = orders.find(o => o.linkToken === token.trim());
  if (!order) return res.json({ valid: false });
  const remaining = order.remaining !== undefined ? order.remaining : order.credits;
  res.json({
    valid: true,
    remaining: remaining,
    credits: order.credits,
    orderNo: order.orderNo
  });
});

// 消耗一次链接令牌
app.post('/api/link/consume', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: '缺少token' });
  const orders = loadJson('orders.json');
  const order = orders.find(o => o.linkToken === token.trim());
  if (!order) return res.status(404).json({ error: '链接无效' });
  
  const remaining = order.remaining !== undefined ? order.remaining : order.credits;
  if (remaining <= 0) return res.status(403).json({ error: '使用次数已用完', remaining: 0 });
  
  order.remaining = remaining - 1;
  saveJson('orders.json', orders);
  console.log(`[LINK] 消耗1次: token=${token.substring(0, 8)}... 剩余${order.remaining}/${order.credits}`);
  res.json({ ok: true, remaining: order.remaining, credits: order.credits });
});

// 批量预生成直通链接（无需订单号，用于闲鱼/小红书自动发货）
app.post('/api/admin/links/batch', adminAuth, (req, res) => {
  const { sku, count } = req.body;
  const plan = SKU_TO_PLAN[sku];
  if (!plan) return res.status(400).json({ error: '无效的SKU，需为 1/3/5/10' });
  
  const num = Math.min(parseInt(count) || 1, 100);
  const orders = loadJson('orders.json');
  const newLinks = [];
  
  for (let i = 0; i < num; i++) {
    const linkToken = generateLinkToken();
    const orderNo = 'POOL_' + Date.now() + '_' + crypto.randomBytes(2).toString('hex') + '_' + i;
    const order = {
      orderNo,
      sku,
      credits: KEY_PLAN_CREDITS[plan],
      remaining: KEY_PLAN_CREDITS[plan],
      cardKey: generateServerKey(plan),
      linkToken,
      status: 'pending',
      createdAt: Date.now(),
      redeemedAt: null
    };
    orders.push(order);
    newLinks.push(order);
  }
  
  saveJson('orders.json', orders);
  console.log(`[ADMIN] 批量预生成${num}个直通链接 (SKU=${sku}次)`);
  res.json({ count: newLinks.length, links: newLinks });
});

// ============================================================
// 自动发货接口（供小红书/闲鱼自动发货软件调用）
// ============================================================
// 用途：当下单发生时，自动发货软件调用本接口，传入订单号 + SKU，
//      后台自动生成对应次数的卡密与直通链接。
// 幂等：同一订单号重复调用只生成一次，重复调用返回同一链接（安全重试）。
// 鉴权：通过 X-Fulfill-Secret 请求头 或 secret 字段/查询参数。
// 链接格式：https://域名/?token=xxxxxxxxxxxx
// 顾客点击该链接即可直接进入拼豆工坊，无需输入卡密，自动解锁对应次数。
const FULFILL_SECRET = (process.env.FULFILL_SECRET || 'pigcat_fulfill_2024').trim();

function fulfillOrder(orderNo, sku, origin) {
  const plan = SKU_TO_PLAN[sku];
  if (!plan) return { error: '无效的 sku，需为 1/3/5/10' };
  if (!orderNo || !String(orderNo).trim()) return { error: '缺少 orderNo（订单号）' };

  const orders = loadJson('orders.json');
  const orderNoTrim = String(orderNo).trim();

  // 幂等：订单已存在则直接返回原链接（避免重复生成）
  const existing = orders.find(o => o.orderNo === orderNoTrim);
  if (existing) {
    return {
      ok: true,
      orderNo: existing.orderNo,
      sku: existing.sku,
      credits: existing.credits,
      cardKey: existing.cardKey,
      linkToken: existing.linkToken,
      link: existing.linkToken ? (origin + '/?token=' + existing.linkToken) : '',
      remaining: existing.remaining !== undefined ? existing.remaining : existing.credits,
      reused: true
    };
  }

  // 首次：生成卡密 + 直通链接
  const cardKey = generateServerKey(plan);
  const linkToken = generateLinkToken();
  const order = {
    orderNo: orderNoTrim,
    sku,
    credits: KEY_PLAN_CREDITS[plan],
    remaining: KEY_PLAN_CREDITS[plan],
    cardKey,
    linkToken,
    status: 'pending',
    createdAt: Date.now(),
    redeemedAt: null
  };
  orders.push(order);
  saveJson('orders.json', orders);
  console.log(`[AUTO] 自动发货：订单 ${orderNoTrim} (sku=${sku}) → 生成链接 token=${linkToken.substring(0, 8)}...`);
  return {
    ok: true,
    orderNo: order.orderNo,
    sku: order.sku,
    credits: order.credits,
    cardKey: order.cardKey,
    linkToken: order.linkToken,
    link: origin + '/?token=' + order.linkToken,
    remaining: order.credits,
    reused: false
  };
}

// POST 方式（推荐，自动发货软件常用）
app.post('/api/auto/fulfill', (req, res) => {
  const secret = req.headers['x-fulfill-secret'] || req.body.secret;
  if (secret !== FULFILL_SECRET) {
    return res.status(401).json({ error: '鉴权失败：secret 不正确' });
  }
  const origin = req.protocol + '://' + req.get('host');
  const result = fulfillOrder(req.body.orderNo, req.body.sku, origin);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// GET 方式（部分发货软件只支持 GET，方便浏览器/手测）
app.get('/api/auto/fulfill', (req, res) => {
  const secret = req.headers['x-fulfill-secret'] || req.query.secret;
  if (secret !== FULFILL_SECRET) {
    return res.status(401).json({ error: '鉴权失败：secret 不正确' });
  }
  const origin = req.protocol + '://' + req.get('host');
  const result = fulfillOrder(req.query.orderNo, req.query.sku, origin);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// 管理员查看自动发货配置（便于接入发货软件）
app.get('/api/admin/fulfill-config', adminAuth, (req, res) => {
  const origin = req.protocol + '://' + req.get('host');
  res.json({
    secret: FULFILL_SECRET,
    endpoint: origin + '/api/auto/fulfill',
    method: 'POST 或 GET',
    linkTemplate: origin + '/?token={token}',
    skus: [{ sku: '1', credits: 1 }, { sku: '3', credits: 3 }, { sku: '5', credits: 5 }, { sku: '10', credits: 10 }]
  });
});

// 根路径重定向到主页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'beadloom-studio.html'));
});

// ============================================================
// AI卡通化API配置（OpenAI兼容格式 · gpt-image-2）
// ============================================================
const AI_API_CONFIG = {
  // API基础地址
  baseUrl: 'https://api.lk888.ai',
  // API密钥
  apiKey: 'sk-193274b7d589597688d4983f4cd8a6d0193c04558e43c2e6',
  // 模型名称
  model: 'gpt-image-2',
  // 卡通化提示词（由前端传入完整提示词，此处为后备默认值）
  prompt: '把参考图转换为适合制作拼豆的简化卡通像素图。目标尺寸为 104×104方格，每个方格严格对应一颗拼豆。保留主体的清晰轮廓、主要颜色和最具辨识度的特征，并将角色可爱卡通化，删除所有细小纹理和无意义细节。使用不超过18种纯色，大色块构成，颜色分布清晰，高对比度，主体居中。所有边缘必须是规则方格硬边，颜色块对齐网格，不允许半格或碎片化像素。无渐变、无抗锯齿、无模糊、无透明、无噪点、无抖动填色、无细密纹理、无复杂光影。最终效果应当像一张可以直接数格制作的拼豆图纸，而不是普通装饰性像素画，最终去除所有网格线。',
  // 图片尺寸：auto表示自适应
  size: 'auto',
  // 图片质量：auto表示自适应
  quality: 'auto',
  // 请求超时：设为0表示无超时限制，等待AI出图完毕
  timeout: 0,
};

// ============================================================
// 对话大模型API配置（用于提示词优化）
// ============================================================
const LLM_API_CONFIG = {
  baseUrl: 'https://api.lk888.ai',
  apiKey: 'sk-193274b7d589597688d4983f4cd8a6d0193c04558e43c2e6',
  model: 'gpt-5.4-mini',
};

// ============================================================
// 本地提示词优化函数（当LLM API不可用时的后备方案）
// ============================================================
// 对用户输入的简短描述进行结构化优化：
// 1. 去除冗余词汇（请、把、让、帮我、一下等）
// 2. 识别风格关键词并补充视觉描述
// 3. 保持原意，输出简洁的优化提示词
// ============================================================
function localOptimizePrompt(input) {
  let text = input.trim();

  // 去除常见冗余前缀/后缀词（长词优先，避免部分匹配残留）
  const fillerWords = ['请帮我', '请帮忙', '麻烦帮', '帮我', '请帮', '帮忙', '麻烦', '想要', '希望', '一下', '谢谢', '谢了', '那种', '这种', '吧', '呢', '啊', '哦', '了', '请'];
  for (const w of fillerWords) {
    text = text.replace(new RegExp(w, 'g'), '');
  }
  // 去除句首残留的"我"（来自"请帮我"被部分清理后）
  text = text.replace(/^我/g, '');

  // 去除"把图片"、"把照片"等冗余表述（长词优先，避免部分匹配）
  text = text.replace(/把(这张图片|这个图片|这张图|这个图|图片|照片|这张|这个|图)/g, '');
  text = text.replace(/让(它|这个|图片|照片|这张图)/g, '');
  // 去除口语化模糊表达
  text = text.replace(/那种/g, '');
  text = text.replace(/变成/g, '转换为');
  text = text.replace(/改(成|为)/g, '转换为');
  text = text.replace(/弄成/g, '转换为');
  text = text.replace(/做成/g, '转换为');

  // 清理多余空格和标点
  text = text.replace(/\s+/g, '').replace(/，{2,}/g, '，').replace(/^，|，$/g, '');

  // 风格关键词增强映射表
  const styleEnhancements = [
    { keywords: ['赛博朋克', 'cyberpunk'], enhance: '赛博朋克风格，霓虹灯光，未来科技感' },
    { keywords: ['水彩', '水粉'], enhance: '水彩画风格，柔和晕染，透明质感' },
    { keywords: ['水墨', '国画', '中国风'], enhance: '水墨画风格，写意笔触，留白意境' },
    { keywords: ['油画'], enhance: '油画风格，厚重笔触，丰富层次' },
    { keywords: ['动漫', '二次元', '日系'], enhance: '日系动漫风格，精致线条，明亮色彩' },
    { keywords: ['像素', '8bit', '8-bit'], enhance: '像素艺术风格，复古游戏感' },
    { keywords: ['扁平', 'flat'], enhance: '扁平化设计风格，简洁色块，几何构图' },
    { keywords: ['可爱', '萌', 'q版', 'Q版'], enhance: 'Q版可爱风格，圆润造型，柔和配色' },
    { keywords: ['复古', 'retro', '怀旧'], enhance: '复古风格，做旧质感，暖色调' },
    { keywords: ['极简', '简约', 'minimal'], enhance: '极简主义风格，留白构图，克制配色' },
    { keywords: ['哥特', 'gothic'], enhance: '哥特风格，暗色调，华丽装饰' },
    { keywords: ['蒸汽朋克', 'steampunk'], enhance: '蒸汽朋克风格，黄铜机械，维多利亚时代' },
    { keywords: ['梵高', '星空'], enhance: '梵高风格，旋涡笔触，鲜明色彩' },
    { keywords: ['毕加索', '立体'], enhance: '立体主义风格，几何分割，多视角' },
    { keywords: ['浮世绘', '和风'], enhance: '浮世绘风格，平面构图，传统日式美学' },
    { keywords: ['赛璐璐', 'cell'], enhance: '赛璐璐风格，锐利阴影，动画质感' },
    { keywords: ['低多边形', 'lowpoly', 'low poly'], enhance: '低多边形风格，几何面片，3D渲染感' },
    { keywords: ['霓虹', 'neon'], enhance: '霓虹灯光效果，发光轮廓，暗色背景' },
    { keywords: ['黑白', '素描', '线稿'], enhance: '黑白线稿风格，纯粹线条，无填色' },
    { keywords: ['水族', '海洋', '海底'], enhance: '海洋主题，水下光线，流动气泡' },
    { keywords: ['森林', '自然', '绿意'], enhance: '森林自然主题，葱郁绿意，斑驳光影' },
    { keywords: ['宇宙', '星空', '太空', '银河'], enhance: '宇宙星空主题，深邃星云，璀璨星河' },
    { keywords: ['圣诞', '节日', '雪花'], enhance: '圣诞节日主题，红绿配色，雪花元素' },
    { keywords: ['万圣节', '南瓜', '幽灵'], enhance: '万圣节主题，橙黑配色，神秘氛围' },
    { keywords: ['春', '樱花', '花'], enhance: '春季樱花主题，粉色调，花瓣飘落' },
    { keywords: ['夏', '海滩', '阳光'], enhance: '夏日海滩主题，明亮阳光，蓝色调' },
    { keywords: ['秋', '枫叶', '落叶'], enhance: '秋季枫叶主题，暖橙色调，落叶氛围' },
    { keywords: ['冬', '雪', '冰'], enhance: '冬季雪景主题，冷色调，冰雪质感' },
  ];

  // 检查是否匹配已知风格关键词
  for (const item of styleEnhancements) {
    for (const kw of item.keywords) {
      if (text.includes(kw)) {
        // 如果原文只是简单提到风格词，直接用增强版替换
        if (text.length <= kw.length + 4) {
          return item.enhance;
        }
        // 否则在原文后补充视觉描述
        return text + '，' + item.enhance.replace(/^[^，]+风格，/, '');
      }
    }
  }

  // 如果原文以"转换为"开头，清理后直接返回
  if (text.startsWith('转换为')) {
    text = text.replace(/^转换为/, '');
  }

  // 如果优化后为空，返回原文
  if (!text) {
    return input.trim();
  }

  // 限制在50字以内
  if (text.length > 50) {
    text = text.substring(0, 50);
  }

  return text;
}

// ============================================================
// /api/optimize-prompt 端点
// ============================================================
// 请求格式: POST { prompt: "用户输入的描述" }
// 响应格式: { optimized: "优化后的提示词", source: "llm" | "local" }
//
// 流程：
//   1. 前端发送用户输入的描述
//   2. 后端尝试调用对话大模型API优化提示词
//   3. 若LLM API不可用，使用本地优化算法作为后备
//   4. 返回优化后的提示词给前端
// ============================================================
app.post('/api/optimize-prompt', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: '缺少提示词' });
    }

    console.log(`[LLM] 开始优化提示词: "${prompt}"`);

    const systemPrompt = '你是一个专业的AI绘画提示词优化师。用户会给你一段简短的图片风格描述，你需要将其优化为更适合AI图像生成模型理解的提示词。要求：1.保持用户原意不变 2.语言简洁明确 3.去除多余修饰词 4.突出关键风格特征 5.输出不超过50个中文字符 6.只输出优化后的提示词本身，不要任何解释或前缀';

    try {
      const llmResponse = await fetch(`${LLM_API_CONFIG.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LLM_API_CONFIG.apiKey}`,
        },
        body: JSON.stringify({
          model: LLM_API_CONFIG.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt.trim() },
          ],
          temperature: 0.7,
          max_tokens: 100,
        }),
      });

      if (llmResponse.ok) {
        const llmData = await llmResponse.json();
        const optimized = llmData.choices && llmData.choices[0] && llmData.choices[0].message
          ? llmData.choices[0].message.content.trim()
          : null;

        if (optimized && optimized.length > 0) {
          console.log(`[LLM] 提示词优化完成(LLM): "${optimized}"`);
          return res.json({ optimized: optimized, source: 'llm' });
        }
      } else {
        const errText = await llmResponse.text();
        console.warn(`[LLM] API不可用(${llmResponse.status})，切换到本地优化`);
      }
    } catch (llmErr) {
      console.warn(`[LLM] API调用异常: ${llmErr.message}，切换到本地优化`);
    }

    // LLM API不可用时，使用本地优化
    const localOptimized = localOptimizePrompt(prompt);
    console.log(`[LLM] 提示词优化完成(本地): "${localOptimized}"`);
    res.json({ optimized: localOptimized, source: 'local' });

  } catch (err) {
    console.error('[LLM] 提示词优化失败:', err.message);
    // 完全失败时返回原始提示词
    res.json({ optimized: req.body.prompt ? req.body.prompt.trim() : '', source: 'fallback' });
  }
});
// ============================================================
// 
// 请求格式: POST { image: "data:image/png;base64,..." }
// 响应格式: { result: "data:image/png;base64,..." }
//
// 流程：
//   1. 前端发送裁切后的图片（data URL格式）
//   2. 后端将图片转为multipart/form-data，调用OpenAI兼容的images/edits API
//   3. AI模型将图片转化为二维卡通像素风格
//   4. 后端接收返回的卡通化图片，转成data URL返回给前端
//   5. 前端将卡通化图片通过代码进行拼豆像素化输出
//
// ============================================================
// 调用上游AI API（带重试机制）
// ============================================================
async function callAiApi(imageBuffer, mimeType, ext, retryCount, customPrompt) {
  retryCount = retryCount || 0;
  const maxRetries = 3;
  
  // 使用自定义提示词，否则使用默认提示词
  const usePrompt = customPrompt || AI_API_CONFIG.prompt;
  
  // 每次重试都创建新的FormData（Blob只能用一次）
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mimeType });
  formData.append('image', blob, `input.${ext}`);
  formData.append('prompt', usePrompt);
  formData.append('model', AI_API_CONFIG.model);
  formData.append('size', AI_API_CONFIG.size);
  formData.append('quality', AI_API_CONFIG.quality);

  const controller = new AbortController();
  const timeoutId = AI_API_CONFIG.timeout > 0
    ? setTimeout(() => controller.abort(), AI_API_CONFIG.timeout)
    : null;

  try {
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AI_API_CONFIG.apiKey}`,
      },
      body: formData,
    };
    if (timeoutId) fetchOptions.signal = controller.signal;
    const apiResponse = await fetch(`${AI_API_CONFIG.baseUrl}/v1/images/edits`, fetchOptions);

    if (timeoutId) clearTimeout(timeoutId);

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error(`[AI] API返回错误 (第${retryCount + 1}次尝试):`, apiResponse.status, errText.substring(0, 300));
      
      // 404/429/500/502/503 等错误自动重试
      if ((apiResponse.status === 404 || apiResponse.status === 429 || apiResponse.status >= 500) && retryCount < maxRetries) {
        const waitMs = 3000 * (retryCount + 1); // 递增等待：3s, 6s, 9s
        console.log(`[AI] 第${retryCount + 1}次重试将在${waitMs / 1000}秒后执行...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        return callAiApi(imageBuffer, mimeType, ext, retryCount + 1, customPrompt);
      }
      
      throw new Error(`AI API错误 ${apiResponse.status}: ${errText.substring(0, 200)}`);
    }

    // 解析API响应
    const apiData = await apiResponse.json();
    console.log('[AI] API响应结构:', Object.keys(apiData));
    
    // 处理不同的响应格式
    let resultImage = null;
    
    if (apiData.data && apiData.data[0]) {
      if (apiData.data[0].b64_json) {
        resultImage = 'data:image/png;base64,' + apiData.data[0].b64_json;
        console.log('[AI] 收到base64格式图片');
      } else if (apiData.data[0].url) {
        console.log('[AI] 收到URL格式图片，正在下载:', apiData.data[0].url);
        const imgResp = await fetch(apiData.data[0].url);
        if (!imgResp.ok) {
          throw new Error(`下载AI生成图片失败: ${imgResp.status}`);
        }
        const imgBuffer = Buffer.from(await imgResp.arrayBuffer());
        resultImage = 'data:image/png;base64,' + imgBuffer.toString('base64');
        console.log('[AI] 图片下载完成');
      }
    } else if (apiData.result) {
      resultImage = apiData.result;
    }

    if (!resultImage) {
      throw new Error('无法解析AI API响应: ' + JSON.stringify(apiData).substring(0, 300));
    }

    return resultImage;
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    
    // 网络错误也重试
    if (err.name !== 'AbortError' && retryCount < maxRetries && !err.message.includes('AI API错误')) {
      const waitMs = 3000 * (retryCount + 1);
      console.log(`[AI] 网络错误，第${retryCount + 1}次重试将在${waitMs / 1000}秒后执行...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      return callAiApi(imageBuffer, mimeType, ext, retryCount + 1, customPrompt);
    }
    
    throw err;
  }
}

// ============================================================
// /api/cartoonize 端点
// ============================================================
app.post('/api/cartoonize', async (req, res) => {
  try {
    const { image, prompt } = req.body;
    
    if (!image) {
      return res.status(400).json({ error: '缺少图片数据' });
    }

    // 解析data URL，提取base64数据和图片格式
    const match = image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: '无效的图片格式，需要data URL' });
    }
    
    const imageFormat = match[1];
    const base64Data = match[2];
    const imageBuffer = Buffer.from(base64Data, 'base64');
    const mimeType = `image/${imageFormat}`;
    const ext = imageFormat === 'jpeg' ? 'jpg' : imageFormat;

    console.log(`[AI] 开始调用卡通化API... (图片大小: ${(imageBuffer.length / 1024).toFixed(1)}KB, 格式: ${ext})`);
    if (prompt) {
      console.log(`[AI] 使用自定义提示词: "${prompt.substring(0, 80)}..."`);
    }

    const resultImage = await callAiApi(imageBuffer, mimeType, ext, 0, prompt);

    console.log('[AI] 卡通化完成，返回图片给前端');
    res.json({ result: resultImage });

  } catch (err) {
    console.error('[AI] 服务器错误:', err.message);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'AI API请求超时，请重试' });
    }
    res.status(500).json({ error: err.message });
  }
});

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    aiConfigured: !!(AI_API_CONFIG.baseUrl && AI_API_CONFIG.apiKey),
    model: AI_API_CONFIG.model
  });
});

// 诊断：无需登录，仅返回管理员密码的来源与长度（不输出明文），
// 用于排查"输入密码提示错误"时确认服务器当前实际生效的是哪个密码。
app.get('/api/debug/admin-pwd-info', (req, res) => {
  res.json({
    source: process.env.ADMIN_PASSWORD ? '环境变量/.env' : '代码默认',
    length: ADMIN_PASSWORD.length,
    hint: 'length=9 即当前密码是 PIGCAT110（可登录）；length!=9 表示生效的是其他密码，请检查 .env 或部署平台的 ADMIN_PASSWORD 环境变量'
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log('====================================');
  console.log('  PIGCAT拼豆工坊服务已启动');
  console.log(`  访问地址: http://localhost:${PORT}`);
  console.log(`  AI API: ${AI_API_CONFIG.baseUrl}`);
  console.log(`  AI模型: ${AI_API_CONFIG.model}`);
  console.log(`  AI状态: ${AI_API_CONFIG.baseUrl && AI_API_CONFIG.apiKey ? '已配置' : '未配置'}`);
  // 诊断：显示密码/密钥来源与长度（不输出明文，避免日志泄漏）
  console.log(`  管理员密码: 来源=${process.env.ADMIN_PASSWORD ? '环境变量/.env' : '代码默认'} 长度=${ADMIN_PASSWORD.length}`);
  console.log(`  发货密钥: 来源=${process.env.FULFILL_SECRET ? '环境变量/.env' : '代码默认'} 长度=${FULFILL_SECRET.length}`);
  console.log('====================================');
});
