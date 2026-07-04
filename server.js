const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'exercise-secret-key-change-in-production';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: '请先登录' });
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = payload.id;
    req.username = payload.username;
    req.role = payload.role || 'user';
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

function adminOnly(req, res, next) {
  if (req.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
  const user = db.createUser(username, password);
  if (!user) return res.status(400).json({ error: '用户名已存在' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const user = db.verifyUser(username, password);
  if (!user) return res.status(400).json({ error: '用户名或密码错误' });
  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, username: user.username, created_at: user.created_at, role: user.role });
});

app.get('/api/users', auth, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  res.json(db.getAllUsers());
});

app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.userId) return res.status(400).json({ error: '不能删除自己' });
  db.deleteUser(id);
  res.json({ ok: true });
});

app.put('/api/users/:id/reset-password', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
  const ok = db.resetUserPassword(id, password);
  if (!ok) return res.status(404).json({ error: '用户不存在' });
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-progress', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  db.resetProgress(id);
  res.json({ ok: true });
});

app.get('/api/users/:id/questions', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  res.json(db.getQuestions(id));
});

app.delete('/api/users/:id/questions', auth, adminOnly, (req, res) => {
  const id = parseInt(req.params.id);
  const { qids } = req.body;
  if (!Array.isArray(qids)) return res.status(400).json({ error: '请发送题目ID数组' });
  db.deleteQuestions(id, qids);
  res.json({ count: qids.length });
});

app.put('/api/users/:userId/questions/:qid', auth, adminOnly, (req, res) => {
  const userId = parseInt(req.params.userId);
  db.updateQuestion(userId, req.params.qid, req.body);
  res.json({ ok: true });
});

app.get('/api/questions', auth, (req, res) => {
  res.json(db.getQuestions(req.userId));
});

app.post('/api/questions', auth, (req, res) => {
  const questions = req.body;
  if (!Array.isArray(questions)) return res.status(400).json({ error: '请发送题目数组' });
  db.addQuestions(req.userId, questions);
  res.json({ count: questions.length });
});

app.post('/api/question', auth, (req, res) => {
  const q = req.body;
  if (!q || !q.id) return res.status(400).json({ error: '题目数据无效' });
  db.addQuestions(req.userId, [q]);
  res.json({ ok: true });
});

app.put('/api/questions/:qid', auth, (req, res) => {
  db.updateQuestion(req.userId, req.params.qid, req.body);
  res.json({ ok: true });
});

app.delete('/api/questions', auth, (req, res) => {
  const { qids } = req.body;
  if (!Array.isArray(qids)) return res.status(400).json({ error: '请发送题目ID数组' });
  db.deleteQuestions(req.userId, qids);
  res.json({ count: qids.length });
});

app.get('/api/progress', auth, (req, res) => {
  res.json(db.getProgress(req.userId));
});

app.put('/api/progress/:qid/:status', auth, (req, res) => {
  const { qid, status } = req.params;
  if (!['known', 'wrong', 'starred'].includes(status)) return res.status(400).json({ error: '无效状态' });
  db.setProgress(req.userId, qid, status);
  res.json({ ok: true });
});

app.delete('/api/progress/:qid/:status', auth, (req, res) => {
  const { qid, status } = req.params;
  db.removeProgress(req.userId, qid, status);
  res.json({ ok: true });
});

app.post('/api/progress/reset', auth, (req, res) => {
  db.resetProgress(req.userId);
  res.json({ ok: true });
});

// ==================== 公共题库 ====================
app.get('/api/public', auth, (req, res) => {
  res.json(db.getPublicQuestions());
});

app.get('/api/public/:id', auth, (req, res) => {
  const detail = db.getPublicQuestionDetail(req.params.id);
  if (!detail) return res.status(404).json({ error: '题库不存在' });
  res.json(detail);
});

app.post('/api/public', auth, adminOnly, (req, res) => {
  const { questions, title } = req.body;
  if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: '请发送题目数组' });
  const entry = db.publishPublicQuestions(req.userId, questions, title);
  res.json(entry);
});

app.delete('/api/public/:id', auth, adminOnly, (req, res) => {
  db.deletePublicQuestion(req.userId, req.params.id);
  res.json({ ok: true });
});

// ==================== 分享题目 ====================
app.post('/api/share', auth, (req, res) => {
  const { toUserId, questions, message } = req.body;
  if (!toUserId) return res.status(400).json({ error: '请选择接收用户' });
  if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: '请选择题目' });
  const entry = db.shareQuestions(req.userId, toUserId, questions, message);
  if (!entry) return res.status(400).json({ error: '分享失败' });
  res.json(entry);
});

app.get('/api/shared', auth, (req, res) => {
  res.json(db.getSharedWithMe(req.userId));
});

app.get('/api/shared/:id', auth, (req, res) => {
  const detail = db.getSharedDetail(req.userId, req.params.id);
  if (!detail) return res.status(404).json({ error: '分享不存在' });
  res.json(detail);
});

app.post('/api/shared/:id/accept', auth, (req, res) => {
  const ok = db.acceptShare(req.userId, req.params.id);
  if (!ok) return res.status(400).json({ error: '操作失败' });
  res.json({ ok: true });
});

// ==================== 消息 ====================
app.get('/api/messages', auth, (req, res) => {
  res.json(db.getMessages(req.userId));
});

app.post('/api/messages', auth, (req, res) => {
  const { toUserId, content } = req.body;
  if (!toUserId || !content || !content.trim()) return res.status(400).json({ error: '请输入内容' });
  const entry = db.sendMessage(req.userId, toUserId, content.trim());
  if (!entry) return res.status(400).json({ error: '发送失败' });
  res.json(entry);
});

app.get('/api/messages/unread', auth, (req, res) => {
  res.json({ count: db.getUnreadCount(req.userId) });
});

app.post('/api/messages/read', auth, (req, res) => {
  db.markMessagesRead(req.userId);
  res.json({ ok: true });
});

// ==================== 好友系统 ====================
app.get('/api/friends', auth, (req, res) => {
  res.json(db.getFriends(req.userId));
});

app.get('/api/friends/requests', auth, (req, res) => {
  res.json(db.getFriendRequests(req.userId));
});

app.get('/api/friends/discover', auth, (req, res) => {
  res.json(db.getNonFriendUsers(req.userId));
});

app.post('/api/friends/request', auth, (req, res) => {
  const { toUserId } = req.body;
  if (!toUserId) return res.status(400).json({ error: '请选择用户' });
  const result = db.sendFriendRequest(req.userId, toUserId);
  if (!result) return res.status(400).json({ error: '已发送过请求或无效用户' });
  res.json(result);
});

app.post('/api/friends/accept/:id', auth, (req, res) => {
  const ok = db.acceptFriendRequest(req.params.id, req.userId);
  if (!ok) return res.status(400).json({ error: '操作失败' });
  res.json({ ok: true });
});

app.post('/api/friends/reject/:id', auth, (req, res) => {
  const ok = db.rejectFriendRequest(req.params.id, req.userId);
  if (!ok) return res.status(400).json({ error: '操作失败' });
  res.json({ ok: true });
});

app.delete('/api/friends/:id', auth, (req, res) => {
  db.removeFriend(req.userId, parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('刷题网站已启动！');
  console.log('本机访问：http://localhost:' + PORT);
  for (const ip of ips) {
    console.log('局域网访问：http://' + ip + ':' + PORT);
  }

  const cfPath = 'D:\\新建文件夹\\cloudflared.exe';
  const { exec } = require('child_process');
  const cf = exec('"' + cfPath + '" tunnel --url http://localhost:' + PORT, function(err) {
    if (err) console.log('cloudflared 启动失败，仅局域网可用');
  });
  var publicUrl = '';
  cf.stderr.on('data', function(data) {
    var text = data.toString();
    var match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      console.log('\n========== 公网访问 ==========');
      console.log(publicUrl);
      console.log('==============================\n');
      console.log('任何设备均可通过上方地址访问，无需同一局域网');
    }
  });
});
