(function() {
  'use strict';

  var token = localStorage.getItem('exercise-token');
  if (token) {
    window.location.href = '/main.html';
    return;
  }

  var tabBtns = document.querySelectorAll('.tab-btn');
  var loginForm = document.getElementById('loginForm');
  var registerForm = document.getElementById('registerForm');

  tabBtns.forEach(function(btn) {
    btn.onclick = function() {
      tabBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      if (btn.dataset.tab === 'login') {
        loginForm.style.display = '';
        registerForm.style.display = 'none';
      } else {
        loginForm.style.display = 'none';
        registerForm.style.display = '';
      }
    };
  });

  loginForm.onsubmit = function(e) {
    e.preventDefault();
    var username = document.getElementById('loginUsername').value.trim();
    var password = document.getElementById('loginPassword').value;
    var errorEl = document.getElementById('loginError');
    errorEl.textContent = '';

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { errorEl.textContent = data.error; return; }
      localStorage.setItem('exercise-token', data.token);
      localStorage.setItem('exercise-user', JSON.stringify(data.user));
      window.location.href = '/main.html';
    })
    .catch(function() { errorEl.textContent = '网络错误，请重试'; });
  };

  registerForm.onsubmit = function(e) {
    e.preventDefault();
    var username = document.getElementById('regUsername').value.trim();
    var password = document.getElementById('regPassword').value;
    var password2 = document.getElementById('regPassword2').value;
    var errorEl = document.getElementById('regError');
    errorEl.textContent = '';

    if (password !== password2) { errorEl.textContent = '两次密码不一致'; return; }

    fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.error) { errorEl.textContent = data.error; return; }
      localStorage.setItem('exercise-token', data.token);
      localStorage.setItem('exercise-user', JSON.stringify(data.user));
      window.location.href = '/main.html';
    })
    .catch(function() { errorEl.textContent = '网络错误，请重试'; });
  };
})();
