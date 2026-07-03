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
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
  const user = db.createUser(username, password);
  if (!user) return res.status(400).json({ error: '用户名已存在' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const user = db.verifyUser(username, password);
  if (!user) return res.status(400).json({ error: '用户名或密码错误' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.get('/api/me', auth, (req, res) => {
  const user = db.getUserById(req.userId);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: user.id, username: user.username, created_at: user.created_at });
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
});
