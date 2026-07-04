const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data.json');

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'admin123';

let db = { users: [], questions: [], progress: [], public_questions: [], shares: [], messages: [], friends: [], nextUserId: 1 };

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

if (!db.users.find(u => u.username === ADMIN_USERNAME)) {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.users.push({ id: db.nextUserId++, username: ADMIN_USERNAME, password: hash, created_at: new Date().toLocaleString(), role: 'admin' });
  save();
}

function isAdmin(userId) {
  const user = db.users.find(u => u.id === userId);
  return user && user.role === 'admin';
}

function createUser(username, password) {
  if (db.users.find(u => u.username === username)) return null;
  const hash = bcrypt.hashSync(password, 10);
  const user = { id: db.nextUserId++, username, password: hash, created_at: new Date().toLocaleString(), role: 'user' };
  db.users.push(user);
  save();
  return { id: user.id, username: user.username, role: user.role };
}

function verifyUser(username, password) {
  const user = db.users.find(u => u.username === username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  return { id: user.id, username: user.username, role: user.role || 'user' };
}

function getUserById(id) {
  const user = db.users.find(u => u.id === id);
  if (!user) return null;
  return { id: user.id, username: user.username, created_at: user.created_at, role: user.role || 'user' };
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

function getAllUsers() {
  return db.users.map(u => ({
    id: u.id, username: u.username, created_at: u.created_at, role: u.role || 'user',
    questionCount: db.questions.filter(q => q.user_id === u.id).length,
    knownCount: db.progress.filter(p => p.user_id === u.id && p.status === 'known').length,
    wrongCount: db.progress.filter(p => p.user_id === u.id && p.status === 'wrong').length
  }));
}

function deleteUser(userId) {
  db.users = db.users.filter(u => u.id !== userId);
  db.questions = db.questions.filter(q => q.user_id !== userId);
  db.progress = db.progress.filter(p => p.user_id !== userId);
  save();
}

function resetUserPassword(userId, newPassword) {
  const user = db.users.find(u => u.id === userId);
  if (!user) return false;
  user.password = bcrypt.hashSync(newPassword, 10);
  save();
  return true;
}

function publishPublicQuestions(userId, questions, title) {
  if (!isAdmin(userId)) return null;
  const entry = {
    id: 'pub_' + Date.now(),
    user_id: userId,
    title: title || '公共题库',
    questions: questions,
    created_at: new Date().toLocaleString()
  };
  db.public_questions.push(entry);
  save();
  return entry;
}

function getPublicQuestions() {
  return db.public_questions.map(p => ({
    id: p.id, title: p.title, questionCount: p.questions.length,
    created_at: p.created_at,
    publisher: (db.users.find(u => u.id === p.user_id) || {}).username || 'admin'
  }));
}

function getPublicQuestionDetail(id) {
  const p = db.public_questions.find(x => x.id === id);
  if (!p) return null;
  return { id: p.id, title: p.title, questions: p.questions, created_at: p.created_at,
    publisher: (db.users.find(u => u.id === p.user_id) || {}).username || 'admin' };
}

function deletePublicQuestion(userId, id) {
  if (!isAdmin(userId)) return false;
  db.public_questions = db.public_questions.filter(p => p.id !== id);
  save();
  return true;
}

function shareQuestions(fromUserId, toUserId, questions, message) {
  const fromUser = db.users.find(u => u.id === fromUserId);
  if (!fromUser) return null;
  const toUser = db.users.find(u => u.id === toUserId);
  if (!toUser) return null;
  const entry = {
    id: 'share_' + Date.now(),
    from_user_id: fromUserId,
    from_username: fromUser.username,
    to_user_id: toUserId,
    questions: questions,
    message: message || '',
    created_at: new Date().toLocaleString(),
    read: false
  };
  db.shares.push(entry);
  db.messages.push({
    id: 'msg_' + Date.now(),
    from_user_id: fromUserId,
    from_username: fromUser.username,
    to_user_id: toUserId,
    type: 'share',
    content: fromUser.username + ' 向你分享了 ' + questions.length + ' 道题目',
    ref_id: entry.id,
    created_at: new Date().toLocaleString(),
    read: false
  });
  save();
  return entry;
}

function getSharedWithMe(userId) {
  return db.shares.filter(s => s.to_user_id === userId).map(s => ({
    id: s.id, from_username: s.from_username, questionCount: s.questions.length,
    message: s.message, created_at: s.created_at, read: s.read
  }));
}

function getSharedDetail(userId, shareId) {
  const s = db.shares.find(x => x.id === shareId && x.to_user_id === userId);
  if (!s) return null;
  s.read = true;
  save();
  return { id: s.id, from_username: s.from_username, questions: s.questions,
    message: s.message, created_at: s.created_at };
}

function acceptShare(userId, shareId) {
  const s = db.shares.find(x => x.id === shareId && x.to_user_id === userId);
  if (!s) return false;
  addQuestions(userId, s.questions);
  return true;
}

function sendMessage(fromUserId, toUserId, content) {
  const fromUser = db.users.find(u => u.id === fromUserId);
  if (!fromUser) return null;
  const entry = {
    id: 'msg_' + Date.now(),
    from_user_id: fromUserId,
    from_username: fromUser.username,
    to_user_id: toUserId,
    type: 'text',
    content: content,
    ref_id: null,
    created_at: new Date().toLocaleString(),
    read: false
  };
  db.messages.push(entry);
  save();
  return entry;
}

function getMessages(userId) {
  return db.messages.filter(m => m.to_user_id === userId || m.from_user_id === userId)
    .map(m => ({
      id: m.id, from_user_id: m.from_user_id, from_username: m.from_username,
      to_user_id: m.to_user_id, type: m.type, content: m.content,
      ref_id: m.ref_id, created_at: m.created_at, read: m.read,
      isMine: m.from_user_id === userId
    }));
}

function getUnreadCount(userId) {
  return db.messages.filter(m => m.to_user_id === userId && !m.read).length;
}

function markMessagesRead(userId) {
  for (const m of db.messages) {
    if (m.to_user_id === userId) m.read = true;
  }
  save();
}

function sendFriendRequest(fromUserId, toUserId) {
  if (fromUserId === toUserId) return null;
  const existing = db.friends.find(f =>
    (f.from_user_id === fromUserId && f.to_user_id === toUserId) ||
    (f.from_user_id === toUserId && f.to_user_id === fromUserId)
  );
  if (existing) return null;
  const fromUser = db.users.find(u => u.id === fromUserId);
  if (!fromUser) return null;
  const entry = {
    id: 'fr_' + Date.now(),
    from_user_id: fromUserId,
    from_username: fromUser.username,
    to_user_id: toUserId,
    status: 'pending',
    created_at: new Date().toLocaleString()
  };
  db.friends.push(entry);
  db.messages.push({
    id: 'msg_' + Date.now(),
    from_user_id: fromUserId,
    from_username: fromUser.username,
    to_user_id: toUserId,
    type: 'friend_request',
    content: fromUser.username + ' 请求添加你为好友',
    ref_id: entry.id,
    created_at: new Date().toLocaleString(),
    read: false
  });
  save();
  return entry;
}

function acceptFriendRequest(requestId, userId) {
  const fr = db.friends.find(f => f.id === requestId && f.to_user_id === userId && f.status === 'pending');
  if (!fr) return false;
  fr.status = 'accepted';
  const fromUser = db.users.find(u => u.id === fr.from_user_id);
  db.messages.push({
    id: 'msg_' + Date.now(),
    from_user_id: userId,
    from_username: (db.users.find(u => u.id === userId) || {}).username,
    to_user_id: fr.from_user_id,
    type: 'friend_accepted',
    content: (db.users.find(u => u.id === userId) || {}).username + ' 接受了你的好友请求',
    ref_id: null,
    created_at: new Date().toLocaleString(),
    read: false
  });
  save();
  return true;
}

function rejectFriendRequest(requestId, userId) {
  const fr = db.friends.find(f => f.id === requestId && f.to_user_id === userId);
  if (!fr) return false;
  fr.status = 'rejected';
  save();
  return true;
}

function getFriends(userId) {
  return db.friends.filter(f =>
    (f.from_user_id === userId || f.to_user_id === userId) && f.status === 'accepted'
  ).map(f => {
    var friendId = f.from_user_id === userId ? f.to_user_id : f.from_user_id;
    var friend = db.users.find(u => u.id === friendId);
    return { id: friend.id, username: friend.username, created_at: f.created_at };
  });
}

function getFriendRequests(userId) {
  return db.friends.filter(f => f.to_user_id === userId && f.status === 'pending').map(f => ({
    id: f.id, from_user_id: f.from_user_id, from_username: f.from_username, created_at: f.created_at
  }));
}

function areFriends(userId1, userId2) {
  return db.friends.some(f =>
    ((f.from_user_id === userId1 && f.to_user_id === userId2) ||
     (f.from_user_id === userId2 && f.to_user_id === userId1)) && f.status === 'accepted'
  );
}

function removeFriend(userId, friendId) {
  db.friends = db.friends.filter(f =>
    !((f.from_user_id === userId && f.to_user_id === friendId) ||
      (f.from_user_id === friendId && f.to_user_id === userId))
  );
  save();
}

function getNonFriendUsers(userId) {
  var friendIds = new Set();
  friendIds.add(userId);
  for (var f of db.friends) {
    if (f.from_user_id === userId || f.to_user_id === userId) {
      if (f.status === 'accepted' || f.status === 'pending') {
        friendIds.add(f.from_user_id);
        friendIds.add(f.to_user_id);
      }
    }
  }
  return db.users.filter(u => !friendIds.has(u.id)).map(u => ({
    id: u.id, username: u.username, created_at: u.created_at
  }));
}

module.exports = {
  createUser, verifyUser, getUserById, isAdmin, getAllUsers, deleteUser, resetUserPassword,
  addQuestions, getQuestions, updateQuestion, deleteQuestions,
  setProgress, removeProgress, getProgress, resetProgress,
  publishPublicQuestions, getPublicQuestions, getPublicQuestionDetail, deletePublicQuestion,
  shareQuestions, getSharedWithMe, getSharedDetail, acceptShare,
  sendMessage, getMessages, getUnreadCount, markMessagesRead,
  sendFriendRequest, acceptFriendRequest, rejectFriendRequest, getFriends,
  getFriendRequests, areFriends, removeFriend, getNonFriendUsers
};
