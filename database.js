const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data.json');

let db = { users: [], questions: [], progress: [], nextUserId: 1 };

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data && data.users) db = data;
    }
  } catch (e) { console.error('DB load error:', e.message); }
}

function save() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) { console.error('DB save error:', e.message); }
}

load();

function createUser(username, password) {
  if (db.users.find(u => u.username === username)) return null;
  const hash = bcrypt.hashSync(password, 10);
  const user = { id: db.nextUserId++, username, password: hash, created_at: new Date().toLocaleString() };
  db.users.push(user);
  save();
  return { id: user.id, username: user.username };
}

function verifyUser(username, password) {
  const user = db.users.find(u => u.username === username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  return { id: user.id, username: user.username };
}

function getUserById(id) {
  const user = db.users.find(u => u.id === id);
  if (!user) return null;
  return { id: user.id, username: user.username, created_at: user.created_at };
}

function addQuestions(userId, questions) {
  for (const q of questions) {
    const existing = db.questions.find(x => x.user_id === userId && x.qid === q.id);
    if (existing) {
      existing.type = q.type;
      existing.question = q.question;
      existing.options = q.options || [];
      existing.answer = q.answer;
      existing.subject = q.subject || '';
      existing.category = q.category || '';
      existing.difficulty = q.difficulty || 1;
      existing.explanation = q.explanation || '';
    } else {
      db.questions.push({
        user_id: userId, qid: q.id, type: q.type, question: q.question,
        options: q.options || [], answer: q.answer, subject: q.subject || '',
        category: q.category || '', difficulty: q.difficulty || 1, explanation: q.explanation || ''
      });
    }
  }
  save();
}

function getQuestions(userId) {
  return db.questions.filter(q => q.user_id === userId).map(q => ({
    id: q.qid, type: q.type, question: q.question, options: q.options || [],
    answer: q.answer, subject: q.subject || '', category: q.category || '',
    difficulty: q.difficulty || 1, explanation: q.explanation || ''
  }));
}

function updateQuestion(userId, qid, fields) {
  const q = db.questions.find(x => x.user_id === userId && x.qid === qid);
  if (!q) return;
  const allowed = ['type', 'question', 'options', 'answer', 'subject', 'category', 'difficulty', 'explanation'];
  for (const k of allowed) {
    if (fields[k] !== undefined) q[k] = fields[k];
  }
  save();
}

function deleteQuestions(userId, qids) {
  const set = new Set(qids);
  db.questions = db.questions.filter(q => !(q.user_id === userId && set.has(q.qid)));
  db.progress = db.progress.filter(p => !(p.user_id === userId && set.has(p.qid)));
  save();
}

function setProgress(userId, qid, status) {
  const existing = db.progress.find(p => p.user_id === userId && p.qid === qid && p.status === status);
  if (!existing) {
    db.progress.push({ user_id: userId, qid, status });
    save();
  }
}

function removeProgress(userId, qid, status) {
  db.progress = db.progress.filter(p => !(p.user_id === userId && p.qid === qid && p.status === status));
  save();
}

function getProgress(userId) {
  const result = { known: {}, wrong: {}, starred: {} };
  for (const p of db.progress) {
    if (p.user_id === userId && result[p.status]) {
      result[p.status][p.qid] = true;
    }
  }
  return result;
}

function resetProgress(userId) {
  db.progress = db.progress.filter(p => p.user_id !== userId);
  save();
}

module.exports = {
  createUser, verifyUser, getUserById,
  addQuestions, getQuestions, updateQuestion, deleteQuestions,
  setProgress, removeProgress, getProgress, resetProgress
};
