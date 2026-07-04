(function() {
  'use strict';

  var token = localStorage.getItem('exercise-token');
  if (!token) { window.location.href = '/'; return; }

  var userStr = localStorage.getItem('exercise-user');
  var currentUser = userStr ? JSON.parse(userStr) : null;
  var isAdminUser = currentUser && currentUser.role === 'admin';

  var state = {
    questions: [],
    indices: [],
    current: 0,
    revealed: false,
    selected: null,
    fillValue: '',
    progress: { known: {}, wrong: {}, starred: {} },
    pendingImport: null
  };

  var typeNames = { single:'单选题', multiple:'多选题', fill:'填空题', judge:'判断题', qa:'问答题' };

  function api(method, path, body) {
    var opts = {
      method: method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    return fetch('/api' + path, opts).then(function(r) {
      if (r.status === 401) { localStorage.removeItem('exercise-token'); window.location.href = '/'; throw new Error('auth'); }
      return r.json();
    });
  }

  function escapeHtml(s) {
    return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/'/g,'&#39;'); }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // ==================== FILE READING ====================

  function readFile(file) {
    var name = file.name.toLowerCase();
    var status = document.getElementById('fileStatus');
    status.className = 'file-status';
    status.textContent = '正在读取：' + file.name + ' ...';

    if (name.endsWith('.txt')) {
      var reader = new FileReader();
      reader.onload = function(e) {
        var text = e.target.result;
        if (text.indexOf('\ufffd') !== -1) {
          var reader2 = new FileReader();
          reader2.onload = function(e2) { onFileParsed(e2.target.result); };
          reader2.onerror = function() { onFileParsed(text); };
          reader2.readAsText(file, 'GBK');
        } else { onFileParsed(text); }
      };
      reader.onerror = function() { onFileError('读取文件失败'); };
      reader.readAsText(file, 'UTF-8');
    } else if (name.endsWith('.docx')) {
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', function() {
        var reader = new FileReader();
        reader.onload = function(e) {
          window.mammoth.extractRawText({ arrayBuffer: e.target.result })
            .then(function(r) { onFileParsed(r.value); })
            .catch(function(err) { onFileError('解析DOCX失败：' + err.message); });
        };
        reader.readAsArrayBuffer(file);
      }, function() { onFileError('无法加载DOCX解析库，请检查网络'); });
    } else if (name.endsWith('.pdf')) {
      loadPdf(file);
    } else if (name.endsWith('.doc')) {
      onFileError('旧版 .doc 格式不支持，请另存为 .docx/.txt 或使用粘贴文本方式');
    } else {
      onFileError('不支持的文件格式：' + file.name);
    }
  }

  function loadPdf(file) {
    var status = document.getElementById('fileStatus');
    status.className = 'file-status';
    status.textContent = '正在加载PDF解析库...';
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', function() {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      var reader = new FileReader();
      reader.onload = function(e) {
        window.pdfjsLib.getDocument({ data: e.target.result }).promise.then(function(pdf) {
          var allText = [], pageNum = 0, total = pdf.numPages;
          function next() {
            if (pageNum >= total) { onFileParsed(allText.join('\n\n')); return; }
            pageNum++;
            status.textContent = '读取PDF：' + pageNum + '/' + total + ' ...';
            pdf.getPage(pageNum).then(function(p) { return p.getTextContent(); }).then(function(c) {
              allText.push(c.items.map(function(item){ return item.str; }).join(' '));
              next();
            }).catch(function() { onFileError('读取PDF第' + pageNum + '页失败'); });
          }
          next();
        }).catch(function() { onFileError('解析PDF失败'); });
      };
      reader.readAsArrayBuffer(file);
    }, function() { onFileError('无法加载PDF解析库，请检查网络'); });
  }

  function loadScript(src, onload, onerror) {
    if (document.querySelector('script[src="' + src + '"]')) { onload(); return; }
    var s = document.createElement('script');
    s.src = src; s.onload = onload; s.onerror = onerror || function(){};
    document.head.appendChild(s);
  }

  function onFileParsed(text) {
    var status = document.getElementById('fileStatus');
    status.className = 'file-status success';
    status.textContent = '文件读取成功，正在解析...';
    var questions = parseQuestions(text);
    showPreview(questions);
  }

  function onFileError(msg) {
    var status = document.getElementById('fileStatus');
    status.className = 'file-status error';
    status.textContent = msg;
  }

  // ==================== TEXT PARSER ====================

  function parseQuestions(text) {
    if (!text || !text.trim()) return [];
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    var sections = [];
    var allBreaks = [];
    var re1 = /(?:^|\n)\s*[Uu](?:nit)?\s*(\d+)\s*[\n\r]/g;
    var re2 = /(?:^|\n)\s*(视听说|听力|阅读|写作|翻译|口语)\s*[\n\r]/g;
    var m;
    while ((m = re1.exec(text)) !== null) allBreaks.push({ idx: m.index, cat: 'Unit ' + m[1] });
    while ((m = re2.exec(text)) !== null) allBreaks.push({ idx: m.index, cat: m[1] });
    allBreaks.sort(function(a, b) { return a.idx - b.idx; });

    if (allBreaks.length === 0) {
      sections.push({ cat: '', text: text });
    } else {
      if (allBreaks[0].idx > 0) sections.push({ cat: '', text: text.substring(0, allBreaks[0].idx) });
      for (var i = 0; i < allBreaks.length; i++) {
        var start = allBreaks[i].idx;
        var end = (i + 1 < allBreaks.length) ? allBreaks[i + 1].idx : text.length;
        sections.push({ cat: allBreaks[i].cat, text: text.substring(start, end) });
      }
    }

    var allQuestions = [];
    for (var s = 0; s < sections.length; s++) {
      var secText = sections[s].text.replace(/^\s*[Uu](?:nit)?\s*\d+\s*\n/, '').replace(/^\s*(视听说|听力|阅读|写作|翻译|口语)\s*\n/, '');
      var qs = parseSection(secText, sections[s].cat);
      for (var i = 0; i < qs.length; i++) allQuestions.push(qs[i]);
    }
    return allQuestions;
  }

  function parseSection(text, defaultCat) {
    text = text.replace(/\n{3,}/g, '\n\n');
    var lines = text.split('\n');
    var cleanLines = [];
    for (var i = 0; i < lines.length; i++) { var t = lines[i].trim(); if (t) cleanLines.push(t); }

    var merged = [];
    for (var i = 0; i < cleanLines.length; i++) {
      var lt = cleanLines[i];
      if (/^[A-Da-d]$/.test(lt) && i + 1 < cleanLines.length) {
        var nxt = cleanLines[i + 1];
        if (!/^[A-Da-d]$/.test(nxt) && !/^[Uu](?:nit)?\s*\d+$/.test(nxt) && !/^\d{1,3}$/.test(nxt)) {
          merged.push(lt + '. ' + nxt); i++; continue;
        }
      }
      var stuck = lt.match(/^([A-Da-d])(True|False|正确|错误|对|错|Yes|No)$/i);
      if (stuck) { merged.push(stuck[1] + '. ' + stuck[2]); continue; }
      merged.push(lt);
    }

    var blocks = [], current = [];
    for (var i = 0; i < merged.length; i++) {
      var t = merged[i];
      var isQ = /^\d{1,3}\s*[.、)）.．\]:：]/.test(t) || /^\d{1,3}\.\s*\S/.test(t) || /^\d{1,3}$/.test(t);
      if (isQ && current.length) { blocks.push(current.join('\n')); current = []; }
      current.push(t);
    }
    if (current.length) blocks.push(current.join('\n'));

    var questions = [];
    for (var b = 0; b < blocks.length; b++) {
      var q = parseBlock(blocks[b], questions.length, defaultCat);
      if (q) questions.push(q);
    }
    return questions;
  }

  function parseBlock(block, idx, defaultCat) {
    var lines = block.split('\n');
    var filtered = [];
    for (var i = 0; i < lines.length; i++) { if (lines[i].trim()) filtered.push(lines[i].trim()); }
    if (!filtered.length) return null;

    var q = { id:'imp_'+Date.now()+'_'+idx, type:'qa', category: defaultCat||'', difficulty:1, question:'', options:[], answer:'', explanation:'', subject:'' };
    var qLines = [], optLines = [], ansBuf = [], expLines = [];
    var inAns = false, inExp = false, category = defaultCat || '';

    for (var i = 0; i < filtered.length; i++) {
      var line = filtered[i];
      var cm = line.match(/^(?:分类|章节|知识点)[：:]\s*(.+)/);
      if (cm) { category = cm[1].trim(); continue; }
      if (/^难度[：:]\s*/.test(line)) { var d = line.replace(/^难度[：:]\s*/, '').trim(); q.difficulty = /难|3/i.test(d)?3:/中|2/i.test(d)?2:1; continue; }
      if (/^(?:解析|说明|分析)[：:]/.test(line)) { inExp=true; inAns=false; expLines.push(line.replace(/^[^：:]+[：:]\s*/, '')); continue; }
      if (inExp) { expLines.push(line); continue; }
      if (/^(?:答案|参考答案|标准答案|正确答案|Answer)[：:]\s*/i.test(line)) { inAns=true; inExp=false; var ac=line.replace(/^(?:答案|参考答案|标准答案|正确答案|Answer)[：:]\s*/i,'').trim(); if(ac)ansBuf.push(ac); continue; }
      if (inAns) { if(/^(?:解析|说明|分析)[：:]/.test(line)||/^[A-Da-d]\s*[.、)）.．]/.test(line)){inAns=false;}else{ansBuf.push(line);continue;} }

      if (/^[A-Da-d]\s*[.、)）.．]\s*/.test(line)) {
        var optContent = line.replace(/^[A-Da-d]\s*[.、)）.．]\s*/, '').trim();
        if (optContent.length > 200 && !/^(True|False|正确|错误)/i.test(optContent)) { qLines.push(line); }
        else { optLines.push(line); }
        continue;
      }

      if (!inAns && !inExp && optLines.length > 0) {
        var cleanAns = line.replace(/[.、)）.．\s]+$/, '').trim();
        if (/^[A-Da-d]{1,4}$/.test(cleanAns)) { ansBuf.push(cleanAns); continue; }
        if (/^(对|正确|√|错|错误|×)$/.test(cleanAns)) { ansBuf.push(cleanAns); continue; }
      }

      qLines.push(line);
    }

    var answerText = ansBuf.join(' ').trim();
    var first = qLines[0] || '';
    q.question = first.replace(/^\d{1,3}\s*[.、)）.．\]:：]\s*/, '').trim();
    if (qLines.length > 1) { for (var i = 1; i < qLines.length; i++) q.question += '\n' + qLines[i]; }
    q.question = q.question.trim();
    if (category) q.category = category;

    if (optLines.length) {
      q.options = optLines.map(function(l) { return l.replace(/^[A-Da-d]\s*[.、)）.．]\s*/, '').trim(); });
    }
    q.explanation = expLines.join('\n').trim();
    q.answer = answerText;

    if (optLines.length > 0) {
      var ans = answerText.toUpperCase().replace(/[^A-Z]/g, '');
      var optJoined = q.options.join(' ').toLowerCase();
      if (q.options.length === 2 && /true/.test(optJoined) && /false/.test(optJoined)) {
        q.type = 'judge'; q.answer = /true/i.test(answerText) ? true : (/false/i.test(answerText) ? false : '');
      } else if (ans.length > 1) {
        q.type = 'multiple'; q.answer = ans.split('').map(function(c){return c.charCodeAt(0)-65;});
      } else if (ans.length === 1) {
        q.type = 'single'; q.answer = ans.charCodeAt(0) - 65;
      } else {
        q.type = 'single'; q.answer = '';
      }
    } else if (/^(对|正确|√|是|T|True|✔|✓)$/i.test(answerText.trim()) || /^(错|错误|×|否|F|False|✘|✗)$/i.test(answerText.trim())) {
      q.type = 'judge'; q.answer = /^(对|正确|√|是|T|True|✔|✓)$/i.test(answerText.trim());
    } else if (/_{2,}|【\s*】|（\s*）|\(\s*\)/.test(q.question)) {
      q.type = 'fill'; q.answer = answerText;
    } else {
      q.type = 'qa'; q.answer = answerText;
    }

    if (!q.question.trim()) {
      var numMatch = (qLines[0]||'').match(/^(\d{1,3})/);
      q.question = numMatch ? '第' + numMatch[1] + '题' : '（题目文本缺失）';
    }

    q._valid = true;
    if ((q.type === 'single' || q.type === 'multiple') && (!q.options || q.options.length < 2)) q._valid = false;

    return q;
  }

  // ==================== PREVIEW ====================

  function showPreview(questions) {
    state.pendingImport = questions;
    var area = document.getElementById('previewArea');
    var list = document.getElementById('previewList');
    var count = document.getElementById('previewCount');

    if (!questions.length) {
      document.getElementById('fileStatus').className = 'file-status error';
      document.getElementById('fileStatus').textContent = '未能解析出题目，请检查格式或使用粘贴文本';
      area.style.display = 'none';
      return;
    }

    var valid = 0;
    for (var i = 0; i < questions.length; i++) if (questions[i]._valid) valid++;
    document.getElementById('fileStatus').className = 'file-status success';
    document.getElementById('fileStatus').textContent = '解析完成：共 ' + questions.length + ' 题，' + valid + ' 题有效';

    count.textContent = questions.length + ' 题';
    list.innerHTML = '';

    for (var i = 0; i < questions.length; i++) {
      var q = questions[i];
      var ansStr = '';
      if (q.type === 'single' && typeof q.answer === 'number') ansStr = String.fromCharCode(65+q.answer);
      else if (q.type === 'multiple' && Array.isArray(q.answer)) ansStr = q.answer.map(function(a){return String.fromCharCode(65+a);}).join('');
      else if (q.type === 'judge') ansStr = q.answer ? '正确' : '错误';
      else ansStr = String(q.answer).substring(0,100);

      var html = '<span class="preview-item-type">' + (typeNames[q.type]||q.type) + '</span>';
      html += '<div class="preview-item-q">' + (i+1) + '. ' + escapeHtml(q.question.substring(0,120)) + '</div>';
      if (q.options && q.options.length) {
        html += '<div class="preview-item-opts">';
        for (var j = 0; j < q.options.length; j++) html += String.fromCharCode(65+j) + '. ' + escapeHtml(q.options[j]) + '  ';
        html += '</div>';
      }
      html += '<div class="preview-item-ans">' + (ansStr ? '答案：' + escapeHtml(ansStr) : '<span style="color:var(--red)">⚠ 无答案</span>') + '</div>';
      var div = document.createElement('div');
      div.className = 'preview-item';
      div.innerHTML = html;
      list.appendChild(div);
    }

    area.style.display = 'block';
  }

  function doConfirmImport() {
    if (!state.pendingImport || !state.pendingImport.length) return;
    var valid = [];
    for (var i = 0; i < state.pendingImport.length; i++) {
      if (state.pendingImport[i]._valid) valid.push(state.pendingImport[i]);
    }
    if (!valid.length) { alert('没有有效题目'); return; }

    api('POST', '/questions', valid).then(function() {
      state.pendingImport = null;
      document.getElementById('previewArea').style.display = 'none';
      document.getElementById('fileStatus').className = 'file-status hidden';
      document.getElementById('fileInput').value = '';
      document.getElementById('pasteArea').value = '';
      loadAllData().then(function() {
        showToast('成功导入 ' + valid.length + ' 道题目！', 'success');
      });
    }).catch(function() { showToast('导入失败，请重试', 'error'); });
  }

  // ==================== INDEX / FILTER ====================

  function buildIndex() {
    var search = document.getElementById('searchInput').value.toLowerCase().trim();
    var mode = document.getElementById('filterMode').value;
    var cat = document.getElementById('categoryFilter').value;
    state.indices = [];
    for (var i = 0; i < state.questions.length; i++) {
      var q = state.questions[i];
      if (mode === 'known' && !state.progress.known[q.id]) continue;
      if (mode === 'wrong' && !state.progress.wrong[q.id]) continue;
      if (mode === 'starred' && !state.progress.starred[q.id]) continue;
      if (mode === 'unknown' && state.progress.known[q.id]) continue;
      if (cat && q.category !== cat) continue;
      if (search) {
        var hay = (q.question + ' ' + (q.options?q.options.join(' '):'') + ' ' + (q.answer||'')).toLowerCase();
        if (hay.indexOf(search) === -1) continue;
      }
      state.indices.push(i);
    }
  }

  function buildCategoryFilter() {
    var sel = document.getElementById('categoryFilter');
    var cats = {};
    for (var i = 0; i < state.questions.length; i++) {
      if (state.questions[i].category) cats[state.questions[i].category] = true;
    }
    sel.innerHTML = '<option value="">全部分类</option>';
    var keys = Object.keys(cats).sort();
    for (var i = 0; i < keys.length; i++) {
      var o = document.createElement('option');
      o.value = keys[i]; o.textContent = keys[i]; sel.appendChild(o);
    }
  }

  function updateStats() {
    var total = state.questions.length, known = 0, wrong = 0, starred = 0;
    for (var k in state.progress.known) if (state.progress.known[k]) known++;
    for (var k in state.progress.wrong) if (state.progress.wrong[k]) wrong++;
    for (var k in state.progress.starred) if (state.progress.starred[k]) starred++;
    var pct = total ? Math.round(known/total*100) : 0;
    document.getElementById('stats').innerHTML =
      '<span class="green">✓ 掌握 ' + known + '/' + total + '</span>' +
      '<span class="red">✗ 错题 ' + wrong + '</span>' +
      '<span>⭐ ' + starred + '</span>' +
      '<span>进度 ' + pct + '%</span>' +
      '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
  }

  // ==================== RENDER ====================

  function renderList() {
    var ul = document.getElementById('questionList');
    ul.innerHTML = '';
    document.getElementById('listCount').textContent = state.indices.length + ' 题';
    if (!state.indices.length) {
      ul.innerHTML = '<li style="cursor:default;color:var(--text2);text-align:center">无匹配题目</li>';
      return;
    }

    var subjectGroups = {};
    var subjectOrder = [];
    for (var i = 0; i < state.indices.length; i++) {
      var q = state.questions[state.indices[i]];
      var subj = q.subject || '未分科目';
      var cat = q.category || '未分类';
      if (!subjectGroups[subj]) { subjectGroups[subj] = {}; subjectOrder.push(subj); }
      if (!subjectGroups[subj][cat]) subjectGroups[subj][cat] = [];
      subjectGroups[subj][cat].push({ idx: i, q: q });
    }

    var collapsed = {};
    try { var cs = localStorage.getItem('exercise-collapsed'); if (cs) collapsed = JSON.parse(cs); } catch(e) {}

    var globalIdx = 0;
    for (var s = 0; s < subjectOrder.length; s++) {
      var subj = subjectOrder[s];
      var catGroups = subjectGroups[subj];
      var catKeys = Object.keys(catGroups);

      var subjHeader = document.createElement('div');
      var isSubjCollapsed = !!collapsed['subj_' + subj];
      subjHeader.className = 'subj-group-header' + (isSubjCollapsed ? ' subj-collapsed' : '');
      subjHeader.setAttribute('data-subj', subj);
      var subjTotal = 0;
      for (var ci = 0; ci < catKeys.length; ci++) subjTotal += catGroups[catKeys[ci]].length;
      subjHeader.innerHTML = '<span>' + escapeHtml(subj) + ' <span class="cat-count">(' + subjTotal + '题)</span></span><span class="cat-arrow">' + (isSubjCollapsed ? '▶' : '▼') + '</span>';
      subjHeader.onclick = function() {
        var sj = this.getAttribute('data-subj');
        this.classList.toggle('subj-collapsed');
        var arrow = this.querySelector('.cat-arrow');
        arrow.textContent = this.classList.contains('subj-collapsed') ? '▶' : '▼';
        var sibling = this.nextElementSibling;
        while (sibling && !sibling.classList.contains('subj-group-header')) {
          sibling.style.display = this.classList.contains('subj-collapsed') ? 'none' : '';
          sibling = sibling.nextElementSibling;
        }
        saveCollapsed();
      };
      ul.appendChild(subjHeader);

      for (var g = 0; g < catKeys.length; g++) {
        var cat = catKeys[g];
        var items = catGroups[cat];
        var isCollapsed = !!collapsed[cat];
        if (isSubjCollapsed) isCollapsed = true;

        var header = document.createElement('div');
        header.className = 'cat-group-header' + (isCollapsed ? ' cat-collapsed' : '');
        if (isSubjCollapsed) header.style.display = 'none';
        header.setAttribute('data-cat', cat);
        header.innerHTML = '<span>' + escapeHtml(cat) + ' <span class="cat-count">(' + items.length + '题)</span></span><span class="cat-arrow">' + (isCollapsed ? '▶' : '▼') + '</span>';
        header.onclick = function() {
          var c = this.getAttribute('data-cat');
          this.classList.toggle('cat-collapsed');
          var arrow = this.querySelector('.cat-arrow');
          arrow.textContent = this.classList.contains('cat-collapsed') ? '▶' : '▼';
          var sibling = this.nextElementSibling;
          while (sibling && sibling.classList.contains('cat-item') && !sibling.classList.contains('cat-group-header') && !sibling.classList.contains('subj-group-header')) {
            sibling.style.display = this.classList.contains('cat-collapsed') ? 'none' : '';
            sibling = sibling.nextElementSibling;
          }
          saveCollapsed();
        };
        ul.appendChild(header);

        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          var li = document.createElement('div');
          li.className = 'cat-item q-item';
          if (isCollapsed || isSubjCollapsed) li.style.display = 'none';
          if (item.idx === state.current) li.className += ' active';
          if (state.progress.known[item.q.id]) li.className += ' known';
          if (state.progress.wrong[item.q.id]) li.className += ' wrong';
          li.innerHTML = '<span class="idx">' + (item.idx+1) + '</span><span class="q-text' + (!hasAnswer(item.q) ? ' q-text-no-answer' : '') + '">' + (!hasAnswer(item.q) ? '⚠ ' : '') + escapeHtml(item.q.question.substring(0, 60)) + '</span>';
          li.setAttribute('data-idx', item.idx);
          li.onclick = function() {
            state.current = parseInt(this.getAttribute('data-idx'));
            state.revealed = false; state.selected = null; state.fillValue = '';
            render();
          };
          ul.appendChild(li);
          globalIdx++;
        }
      }
    }

    setTimeout(function() {
      var active = ul.querySelector('.q-item.active');
      if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
  }

  function saveCollapsed() {
    try {
      var col = {};
      var allSubj = document.querySelectorAll('.subj-group-header.subj-collapsed');
      for (var i = 0; i < allSubj.length; i++) col['subj_' + allSubj[i].getAttribute('data-subj')] = true;
      var allCat = document.querySelectorAll('.cat-group-header.cat-collapsed');
      for (var i = 0; i < allCat.length; i++) col[allCat[i].getAttribute('data-cat')] = true;
      localStorage.setItem('exercise-collapsed', JSON.stringify(col));
    } catch(e) {}
  }

  function hasAnswer(q) {
    if (q.type === 'single' || q.type === 'multiple') return typeof q.answer === 'number' || (Array.isArray(q.answer) && q.answer.length > 0);
    if (q.type === 'judge') return typeof q.answer === 'boolean';
    return !!q.answer && String(q.answer).trim().length > 0;
  }

  function renderQuiz() {
    var area = document.getElementById('quizArea');

    if (!state.questions.length) {
      area.innerHTML = '<div class="empty-state"><div class="icon">📭</div><h2>暂无题目</h2><p>请使用下方的导入功能上传题目文件、粘贴文本或手动添加题目</p></div>';
      return;
    }

    if (!state.indices.length) {
      area.innerHTML = '<div class="empty-state"><div class="icon">🔍</div><h2>没有匹配的题目</h2></div>';
      return;
    }

    if (state.current >= state.indices.length) state.current = state.indices.length - 1;
    if (state.current < 0) state.current = 0;
    var q = state.questions[state.indices[state.current]];

    var h = '<div class="q-card">';
    h += '<div class="q-meta">';
    h += '<span class="q-tag type">' + (typeNames[q.type]||q.type) + '</span>';
    if (q.subject) h += '<span class="q-tag subj">' + escapeHtml(q.subject) + '</span>';
    if (q.category) h += '<span class="q-tag cat">' + escapeHtml(q.category) + '</span>';
    if (q.difficulty) { var dl = q.difficulty===1?'简单':q.difficulty===2?'中等':'困难'; h += '<span class="q-tag diff-'+q.difficulty+'">'+dl+'</span>'; }
    if (!hasAnswer(q)) h += '<span class="q-tag no-answer">⚠ 无答案</span>';
    h += '</div>';
    h += '<div class="q-number">第 ' + (state.current+1) + ' / ' + state.indices.length + ' 题</div>';
    var qHtml = q.question && (q.question.indexOf('<p>') !== -1 || q.question.indexOf('<img') !== -1) ? q.question : escapeHtml(q.question);
    h += '<div class="q-question">' + qHtml + '</div>';

    if (q.type === 'single' || q.type === 'multiple' || q.type === 'judge') {
      var opts = q.type === 'judge' ? ['正确','错误'] : q.options;
      var multi = q.type === 'multiple';
      h += '<ul class="q-options">';
      for (var i = 0; i < opts.length; i++) {
        var cls = '';
        var sel = multi ? (state.selected||[]) : (state.selected!==null ? [state.selected] : []);
        if (sel.indexOf(i) !== -1) cls = 'selected';
        if (state.revealed && hasAnswer(q)) {
          var correct = q.type==='judge' ? (q.answer?[0]:[1]) : (multi?q.answer:[q.answer]);
          if (correct.indexOf(i) !== -1) cls += ' correct';
          else if (sel.indexOf(i) !== -1) cls += ' wrong-answer';
        }
        var optHtml = opts[i] && (opts[i].indexOf('<p>') !== -1 || opts[i].indexOf('<img') !== -1) ? opts[i] : escapeHtml(opts[i]);
        h += '<li class="'+cls.trim()+'" data-opt="'+i+'"><span class="opt-label">'+String.fromCharCode(65+i)+'</span><span>'+optHtml+'</span></li>';
      }
      h += '</ul>';
    } else if (q.type === 'fill') {
      h += '<input type="text" class="q-fill" id="fillInput" placeholder="输入答案..." value="'+escapeAttr(state.fillValue)+'">';
    }

    h += '<div class="q-actions">';
    if (!hasAnswer(q)) {
      h += '<button class="btn btn-warn" id="addAnswerBtn">✏️ 添加答案</button>';
    } else if (!state.revealed && (q.type==='single'||q.type==='multiple'||q.type==='judge'||q.type==='fill')) {
      h += '<button class="btn btn-primary" id="submitBtn">提交答案</button>';
    } else {
      h += '<button class="btn" id="revealBtn">'+(state.revealed?'隐藏答案':'显示答案')+'</button>';
    }
    h += '<button class="btn'+(state.progress.known[q.id]?' btn-primary':'')+'" id="knownBtn">'+(state.progress.known[q.id]?'✓ 已掌握':'标记掌握')+'</button>';
    h += '<button class="btn'+(state.progress.wrong[q.id]?' btn-danger':'')+'" id="wrongBtn">'+(state.progress.wrong[q.id]?'✗ 错题':'加入错题')+'</button>';
    h += '<button class="btn" id="starBtn">'+(state.progress.starred[q.id]?'⭐ 已收藏':'☆ 收藏')+'</button>';
    h += '<button class="btn" id="editAnswerBtn">✏️ 编辑答案</button>';
    h += '<button class="btn" id="editCatBtn">🏷️ 编辑分类</button>';
    h += '<button class="btn" id="editSubjBtn">📚 编辑科目</button>';
    h += '<button class="btn btn-danger" id="deleteBtn">🗑️ 删除此题</button>';
    h += '<button class="btn btn-danger" id="batchDeleteBtn">🗑️ 批量删除</button>';
    h += '<button class="btn" id="shareBtn">📤 分享</button>';
    h += '</div>';

    if (state.revealed && hasAnswer(q)) {
      h += '<div class="answer-area"><div class="answer-label">参考答案</div><div class="answer-text">';
      if (q.type==='single'||q.type==='multiple'||q.type==='judge') {
        var ansOpts = q.type==='judge'?['正确','错误']:q.options;
        var ansArr = q.type==='judge'?(q.answer?[0]:[1]):(q.type==='multiple'?q.answer:[q.answer]);
        for (var i = 0; i < ansArr.length; i++) h += String.fromCharCode(65+ansArr[i])+'. '+escapeHtml(ansOpts[ansArr[i]])+'<br>';
      } else { h += escapeHtml(String(q.answer)); }
      h += '</div>';
      if (q.explanation) h += '<div class="answer-explanation">💡 '+escapeHtml(q.explanation)+'</div>';
      h += '</div>';
    }
    h += '</div>';

    area.innerHTML = h;
    bindQuizEvents(q);
    updatePosition();
  }

  function bindQuizEvents(q) {
    var optLis = document.querySelectorAll('.q-options li');
    for (var i = 0; i < optLis.length; i++) {
      (function(li) {
        li.onclick = function() {
          if (state.revealed) return;
          var idx = parseInt(li.getAttribute('data-opt'));
          if (q.type === 'multiple') {
            if (!state.selected) state.selected = [];
            var pos = state.selected.indexOf(idx);
            if (pos === -1) state.selected.push(idx); else state.selected.splice(pos, 1);
          } else { state.selected = idx; }
          renderQuiz();
        };
      })(optLis[i]);
    }

    var fillInput = document.getElementById('fillInput');
    if (fillInput) {
      fillInput.oninput = function() { state.fillValue = fillInput.value; };
      fillInput.onkeydown = function(e) { if (e.key==='Enter') { e.preventDefault(); submitAnswer(); } };
      if (!state.revealed) fillInput.focus();
    }

    var submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.onclick = submitAnswer;
    var revealBtn = document.getElementById('revealBtn');
    if (revealBtn) revealBtn.onclick = function() { state.revealed = !state.revealed; renderQuiz(); };

    var knownBtn = document.getElementById('knownBtn');
    if (knownBtn) knownBtn.onclick = function() {
      if (state.progress.known[q.id]) {
        delete state.progress.known[q.id];
        api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known');
      } else {
        state.progress.known[q.id] = true; delete state.progress.wrong[q.id];
        api('PUT', '/progress/' + encodeURIComponent(q.id) + '/known');
        api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong');
      }
      updateStats(); renderList(); renderQuiz();
    };

    var wrongBtn = document.getElementById('wrongBtn');
    if (wrongBtn) wrongBtn.onclick = function() {
      if (state.progress.wrong[q.id]) {
        delete state.progress.wrong[q.id];
        api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong');
      } else {
        state.progress.wrong[q.id] = true; delete state.progress.known[q.id];
        api('PUT', '/progress/' + encodeURIComponent(q.id) + '/wrong');
        api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known');
      }
      updateStats(); renderList(); renderQuiz();
    };

    var starBtn = document.getElementById('starBtn');
    if (starBtn) starBtn.onclick = function() {
      if (state.progress.starred[q.id]) {
        delete state.progress.starred[q.id];
        api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/starred');
      } else {
        state.progress.starred[q.id] = true;
        api('PUT', '/progress/' + encodeURIComponent(q.id) + '/starred');
      }
      updateStats(); renderList(); renderQuiz();
    };

    var addAnswerBtn = document.getElementById('addAnswerBtn');
    if (addAnswerBtn) addAnswerBtn.onclick = function() { openAnswerEditor(q); };
    var editAnswerBtn = document.getElementById('editAnswerBtn');
    if (editAnswerBtn) editAnswerBtn.onclick = function() { openAnswerEditor(q); };
    var editCatBtn = document.getElementById('editCatBtn');
    if (editCatBtn) editCatBtn.onclick = function() { openCategoryEditor(q); };
    var editSubjBtn = document.getElementById('editSubjBtn');
    if (editSubjBtn) editSubjBtn.onclick = function() { openSubjectEditor(q); };
    var deleteBtn = document.getElementById('deleteBtn');
    if (deleteBtn) deleteBtn.onclick = function() {
      if (!confirm('确定删除此题吗？此操作不可撤销！')) return;
      api('DELETE', '/questions', [q.id]).then(function() {
        loadAllData().then(function() { showToast('已删除', 'success'); });
      });
    };
    var batchDeleteBtn = document.getElementById('batchDeleteBtn');
    if (batchDeleteBtn) batchDeleteBtn.onclick = function() { openDeleteEditor(q.id); };
    var shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.onclick = function() { openShareEditor(q.id); };
  }

  function openCategoryEditor(q) {
    var card = document.querySelector('.q-card');
    if (!card) return;
    var existing = document.getElementById('catEditor');
    if (existing) existing.remove();

    var cats = {};
    for (var i = 0; i < state.questions.length; i++) {
      var c = state.questions[i].category || '';
      if (c) cats[c] = true;
    }
    var catList = Object.keys(cats).sort();

    var div = document.createElement('div');
    div.id = 'catEditor'; div.className = 'cat-editor';
    var html = '<h4>🏷️ 编辑分类</h4>';
    html += '<div class="cat-editor-row"><span>当前分类：</span><select id="catSelect"><option value="">-- 选择已有分类 --</option>';
    for (var i = 0; i < catList.length; i++) { var sel = (catList[i] === q.category) ? ' selected' : ''; html += '<option value="' + escapeAttr(catList[i]) + '"' + sel + '>' + escapeHtml(catList[i]) + '</option>'; }
    html += '</select></div>';
    html += '<div class="cat-editor-row"><span>或新建：</span><input type="text" id="catInput" placeholder="输入新分类名..."></div>';
    html += '<div class="editor-actions"><button class="btn btn-primary" id="saveCatBtn">💾 保存</button><button class="btn" id="cancelCatBtn">取消</button></div>';
    div.innerHTML = html;
    card.appendChild(div);

    var catSelect = document.getElementById('catSelect');
    var catInput = document.getElementById('catInput');
    catInput.oninput = function() { if (catInput.value.trim()) catSelect.value = ''; };
    catSelect.onchange = function() { if (catSelect.value) catInput.value = ''; };

    document.getElementById('saveCatBtn').onclick = function() {
      var newCat = catInput.value.trim() || catSelect.value;
      if (!newCat) { alert('请选择或输入分类名'); return; }
      q.category = newCat;
      api('PUT', '/questions/' + encodeURIComponent(q.id), { category: newCat }).then(function() {
        buildCategoryFilter(); buildIndex(); render();
      });
    };
    document.getElementById('cancelCatBtn').onclick = function() { div.remove(); };
  }

  function openSubjectEditor(q) {
    var existing = document.getElementById('subjEditor');
    if (existing) existing.remove();

    var subjs = {};
    for (var i = 0; i < state.questions.length; i++) { var s = state.questions[i].subject || ''; if (s) subjs[s] = true; }
    var subjList = Object.keys(subjs).sort();

    var div = document.createElement('div');
    div.id = 'subjEditor'; div.className = 'cat-editor';
    var html = '<h4>📚 批量编辑科目</h4>';
    html += '<div class="cat-editor-row" style="margin-bottom:8px"><label style="cursor:pointer"><input type="checkbox" id="subjSelectAll" checked> 全选</label></div>';
    html += '<div class="subj-batch-list">';
    for (var i = 0; i < state.questions.length; i++) {
      var q2 = state.questions[i]; var subj2 = q2.subject || '未分科目';
      html += '<label class="subj-batch-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;cursor:pointer;border-radius:4px">';
      html += '<input type="checkbox" class="subj-check" data-qid="' + escapeAttr(q2.id) + '" checked>';
      html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml((i+1) + '. ' + (q2.question||'').substring(0,40)) + '</span>';
      html += '<span style="font-size:11px;color:var(--text2);flex-shrink:0">[' + escapeHtml(subj2) + ']</span>';
      html += '</label>';
    }
    html += '</div>';
    html += '<div class="cat-editor-row" style="margin-top:10px"><span>设为科目：</span><select id="subjSelect"><option value="">-- 选择已有科目 --</option>';
    for (var i = 0; i < subjList.length; i++) html += '<option value="' + escapeAttr(subjList[i]) + '">' + escapeHtml(subjList[i]) + '</option>';
    html += '</select></div>';
    html += '<div class="cat-editor-row"><span>或新建：</span><input type="text" id="subjInput" placeholder="输入新科目名..."></div>';
    html += '<div class="editor-actions"><button class="btn btn-primary" id="saveSubjBtn">💾 保存</button><button class="btn" id="cancelSubjBtn">取消</button></div>';

    div.innerHTML = html;
    document.querySelector('.content').insertBefore(div, document.querySelector('.quiz-area').nextSibling);

    var checks = div.querySelectorAll('.subj-check');
    document.getElementById('subjSelectAll').onchange = function() { var checked = this.checked; for (var i = 0; i < checks.length; i++) checks[i].checked = checked; };

    var subjSelect = document.getElementById('subjSelect');
    var subjInput = document.getElementById('subjInput');
    subjInput.oninput = function() { if (subjInput.value.trim()) subjSelect.value = ''; };
    subjSelect.onchange = function() { if (subjSelect.value) subjInput.value = ''; };

    document.getElementById('saveSubjBtn').onclick = function() {
      var newSubj = subjInput.value.trim() || subjSelect.value;
      if (!newSubj) { alert('请选择或输入科目名'); return; }
      var selectedIds = {};
      for (var i = 0; i < checks.length; i++) { if (checks[i].checked) selectedIds[checks[i].getAttribute('data-qid')] = true; }
      var count = 0;
      var updates = [];
      for (var i = 0; i < state.questions.length; i++) {
        if (selectedIds[state.questions[i].id]) {
          state.questions[i].subject = newSubj;
          updates.push(api('PUT', '/questions/' + encodeURIComponent(state.questions[i].id), { subject: newSubj }));
          count++;
        }
      }
      Promise.all(updates).then(function() {
        buildIndex(); render();
        showToast('已修改 ' + count + ' 道题的科目', 'success');
      });
    };
    document.getElementById('cancelSubjBtn').onclick = function() { div.remove(); };
  }

  function openDeleteEditor(currentQid) {
    var existing = document.getElementById('deleteEditor');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'deleteEditor';
    div.className = 'cat-editor';

    var subjectGroups = {};
    var subjectOrder = [];
    for (var i = 0; i < state.questions.length; i++) {
      var q2 = state.questions[i];
      var subj = q2.subject || '未分科目';
      var cat = q2.category || '未分类';
      if (!subjectGroups[subj]) { subjectGroups[subj] = {}; subjectOrder.push(subj); }
      if (!subjectGroups[subj][cat]) subjectGroups[subj][cat] = [];
      subjectGroups[subj][cat].push(q2);
    }

    var html = '<h4>🗑️ 删除题目</h4>';
    html += '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">';
    html += '<label style="cursor:pointer;font-size:13px"><input type="checkbox" id="delSelectAll"> 全选</label>';
    html += '<label style="cursor:pointer;font-size:13px"><input type="checkbox" id="delSelectKnown"> 已掌握</label>';
    html += '<label style="cursor:pointer;font-size:13px"><input type="checkbox" id="delSelectWrong"> 错题</label>';
    html += '<label style="cursor:pointer;font-size:13px"><input type="checkbox" id="delSelectNoAns"> 无答案</label>';
    html += '</div>';
    html += '<div class="subj-batch-list" id="delList" style="max-height:360px">';

    for (var s = 0; s < subjectOrder.length; s++) {
      var subj = subjectOrder[s];
      var catGroups = subjectGroups[subj];
      var catKeys = Object.keys(catGroups);
      html += '<div style="padding:8px 10px;font-weight:700;font-size:13px;color:#fff;background:var(--accent);border-radius:4px;margin:4px 0;cursor:pointer" data-del-subj="' + escapeAttr(subj) + '">' + escapeHtml(subj) + ' <span style="font-weight:400;font-size:11px">点击全选/取消</span></div>';
      for (var g = 0; g < catKeys.length; g++) {
        var cat = catKeys[g];
        var items = catGroups[cat];
        html += '<div style="padding:4px 10px;font-weight:600;font-size:12px;color:var(--accent);background:var(--accent-light);cursor:pointer" data-del-cat="' + escapeAttr(subj + '|' + cat) + '">' + escapeHtml(cat) + ' <span style="font-weight:400;font-size:10px">点击全选/取消</span></div>';
        for (var j = 0; j < items.length; j++) {
          var q2 = items[j];
          var isCurrent = (q2.id === currentQid);
          var noAns = !hasAnswer(q2);
          var tags = [];
          if (state.progress.known[q2.id]) tags.push('<span style="color:var(--green);font-size:10px">✓掌握</span>');
          if (state.progress.wrong[q2.id]) tags.push('<span style="color:var(--red);font-size:10px">✗错题</span>');
          if (noAns) tags.push('<span style="color:var(--red);font-size:10px">⚠无答案</span>');

          html += '<label class="subj-batch-item del-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;cursor:pointer;border-radius:4px;' + (isCurrent ? 'background:var(--yellow-light)' : '') + '" data-del-qid="' + escapeAttr(q2.id) + '" data-del-noans="' + (noAns ? '1' : '0') + '" data-del-known="' + (state.progress.known[q2.id] ? '1' : '0') + '" data-del-wrong="' + (state.progress.wrong[q2.id] ? '1' : '0') + '" data-del-cat-key="' + escapeAttr(subj + '|' + cat) + '">';
          html += '<input type="checkbox" class="del-check" data-qid="' + escapeAttr(q2.id) + '"' + (isCurrent ? ' checked' : '') + '>';
          html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(q2.question.substring(0, 50)) + '</span>';
          if (tags.length) html += '<span>' + tags.join(' ') + '</span>';
          html += '</label>';
        }
      }
    }

    html += '</div>';
    html += '<div style="margin-top:8px;font-size:13px;color:var(--text2)">已选 <span id="delSelectedCount" style="color:var(--red);font-weight:600">0</span> 道题</div>';
    html += '<div class="editor-actions">';
    html += '<button class="btn btn-danger" id="confirmDelBtn">🗑️ 删除选中</button>';
    html += '<button class="btn" id="cancelDelBtn">取消</button>';
    html += '</div>';

    div.innerHTML = html;
    document.querySelector('.content').insertBefore(div, document.querySelector('.quiz-area').nextSibling);

    var checks = div.querySelectorAll('.del-check');
    var countEl = document.getElementById('delSelectedCount');

    function updateCount() {
      var c = 0;
      for (var i = 0; i < checks.length; i++) if (checks[i].checked) c++;
      countEl.textContent = c;
    }

    for (var i = 0; i < checks.length; i++) {
      checks[i].onchange = updateCount;
    }
    updateCount();

    document.getElementById('delSelectAll').onchange = function() {
      var checked = this.checked;
      for (var i = 0; i < checks.length; i++) checks[i].checked = checked;
      updateCount();
    };

    document.getElementById('delSelectKnown').onchange = function() {
      var checked = this.checked;
      var items = div.querySelectorAll('.del-item[data-del-known="1"]');
      for (var i = 0; i < items.length; i++) {
        var cb = items[i].querySelector('.del-check');
        cb.checked = checked;
      }
      updateCount();
    };

    document.getElementById('delSelectWrong').onchange = function() {
      var checked = this.checked;
      var items = div.querySelectorAll('.del-item[data-del-wrong="1"]');
      for (var i = 0; i < items.length; i++) {
        var cb = items[i].querySelector('.del-check');
        cb.checked = checked;
      }
      updateCount();
    };

    document.getElementById('delSelectNoAns').onchange = function() {
      var checked = this.checked;
      var items = div.querySelectorAll('.del-item[data-del-noans="1"]');
      for (var i = 0; i < items.length; i++) {
        var cb = items[i].querySelector('.del-check');
        cb.checked = checked;
      }
      updateCount();
    };

    var subjHeaders = div.querySelectorAll('[data-del-subj]');
    for (var i = 0; i < subjHeaders.length; i++) {
      subjHeaders[i].onclick = function() {
        var subjName = this.getAttribute('data-del-subj');
        var items = div.querySelectorAll('.del-item');
        var allChecked = true;
        for (var j = 0; j < items.length; j++) {
          var qid = items[j].getAttribute('data-del-qid');
          var q = state.questions.find(function(x) { return x.id === qid; });
          if (q && (q.subject || '未分科目') === subjName) {
            if (!items[j].querySelector('.del-check').checked) { allChecked = false; break; }
          }
        }
        for (var j = 0; j < items.length; j++) {
          var qid = items[j].getAttribute('data-del-qid');
          var q = state.questions.find(function(x) { return x.id === qid; });
          if (q && (q.subject || '未分科目') === subjName) {
            items[j].querySelector('.del-check').checked = !allChecked;
          }
        }
        updateCount();
      };
    }

    var catHeaders = div.querySelectorAll('[data-del-cat]');
    for (var i = 0; i < catHeaders.length; i++) {
      catHeaders[i].onclick = function() {
        var catKey = this.getAttribute('data-del-cat');
        var items = div.querySelectorAll('.del-item[data-del-cat-key="' + catKey + '"]');
        var allChecked = true;
        for (var j = 0; j < items.length; j++) {
          if (!items[j].querySelector('.del-check').checked) { allChecked = false; break; }
        }
        for (var j = 0; j < items.length; j++) {
          items[j].querySelector('.del-check').checked = !allChecked;
        }
        updateCount();
      };
    }

    document.getElementById('confirmDelBtn').onclick = function() {
      var selectedIds = [];
      var count = 0;
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) { selectedIds.push(checks[i].getAttribute('data-qid')); count++; }
      }
      if (!count) { alert('请选择要删除的题目'); return; }
      if (!confirm('确定删除 ' + count + ' 道题吗？此操作不可撤销！')) return;
      api('DELETE', '/questions', selectedIds).then(function() {
        div.remove();
        loadAllData().then(function() { showToast('已删除 ' + count + ' 道题', 'success'); });
      });
    };
    document.getElementById('cancelDelBtn').onclick = function() { div.remove(); };
  }

  function openAnswerEditor(q) {
    var card = document.querySelector('.q-card');
    if (!card) return;
    var existing = document.getElementById('answerEditor');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'answerEditor'; div.className = 'answer-editor';
    var html = '<h4>✏️ 设置答案</h4>';

    if (q.type === 'single') {
      html += '<p class="editor-hint">选择正确选项：</p><div class="editor-options">';
      for (var i = 0; i < q.options.length; i++) { var checked = (typeof q.answer === 'number' && q.answer === i) ? ' checked' : ''; html += '<label class="editor-opt"><input type="radio" name="ansRadio" value="' + i + '"' + checked + '> ' + String.fromCharCode(65+i) + '. ' + escapeHtml(q.options[i]) + '</label>'; }
      html += '</div>';
    } else if (q.type === 'multiple') {
      html += '<p class="editor-hint">选择所有正确选项（可多选）：</p><div class="editor-options">';
      for (var i = 0; i < q.options.length; i++) { var checked = (Array.isArray(q.answer) && q.answer.indexOf(i) !== -1) ? ' checked' : ''; html += '<label class="editor-opt"><input type="checkbox" name="ansCheck" value="' + i + '"' + checked + '> ' + String.fromCharCode(65+i) + '. ' + escapeHtml(q.options[i]) + '</label>'; }
      html += '</div>';
    } else if (q.type === 'judge') {
      var chkT = (q.answer === true) ? ' checked' : '';
      var chkF = (q.answer === false) ? ' checked' : '';
      html += '<p class="editor-hint">选择答案：</p>';
      html += '<label class="editor-opt"><input type="radio" name="ansJudge" value="true"' + chkT + '> 正确</label>';
      html += '<label class="editor-opt"><input type="radio" name="ansJudge" value="false"' + chkF + '> 错误</label>';
    } else {
      html += '<p class="editor-hint">输入答案：</p>';
      html += '<input type="text" class="q-fill" id="ansTextInput" value="' + escapeAttr(String(q.answer || '')) + '" placeholder="输入正确答案...">';
    }

    html += '<p class="editor-hint" style="margin-top:12px">解析（可选）：</p>';
    html += '<textarea class="paste-area" id="ansExplanation" style="min-height:60px" placeholder="输入解析说明...">' + escapeHtml(q.explanation || '') + '</textarea>';
    html += '<div class="editor-actions"><button class="btn btn-primary" id="saveAnswerBtn">💾 保存</button><button class="btn" id="cancelAnswerBtn">取消</button></div>';

    div.innerHTML = html;
    card.appendChild(div);

    document.getElementById('saveAnswerBtn').onclick = function() {
      if (q.type === 'single') {
        var radios = document.getElementsByName('ansRadio');
        for (var i = 0; i < radios.length; i++) { if (radios[i].checked) { q.answer = parseInt(radios[i].value); break; } }
      } else if (q.type === 'multiple') {
        var checks = document.getElementsByName('ansCheck');
        q.answer = [];
        for (var i = 0; i < checks.length; i++) { if (checks[i].checked) q.answer.push(parseInt(checks[i].value)); }
      } else if (q.type === 'judge') {
        var judges = document.getElementsByName('ansJudge');
        for (var i = 0; i < judges.length; i++) { if (judges[i].checked) { q.answer = judges[i].value === 'true'; break; } }
      } else {
        var inp = document.getElementById('ansTextInput');
        if (inp && inp.value.trim()) q.answer = inp.value.trim();
      }
      var exp = document.getElementById('ansExplanation');
      if (exp) q.explanation = exp.value.trim();

      state.revealed = false;
      api('PUT', '/questions/' + encodeURIComponent(q.id), { answer: q.answer, explanation: q.explanation }).then(function() {
        renderQuiz();
      });
    };
    document.getElementById('cancelAnswerBtn').onclick = function() { div.remove(); };
  }

  function submitAnswer() {
    var q = state.questions[state.indices[state.current]];
    if (q.type === 'fill') {
      if (!state.fillValue.trim()) { state.revealed = true; }
      else {
        var correct = String(q.answer).trim().toLowerCase().split(/[|｜/／,，]/);
        var userVal = state.fillValue.trim().toLowerCase();
        var ok = false;
        for (var i = 0; i < correct.length; i++) { if (correct[i].trim() === userVal) { ok = true; break; } }
        if (ok) { state.progress.known[q.id]=true; delete state.progress.wrong[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/known'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong'); }
        else { state.progress.wrong[q.id]=true; delete state.progress.known[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/wrong'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known'); }
      }
    } else if (q.type === 'single' || q.type === 'judge') {
      if (state.selected === null) { alert('请先选择选项'); return; }
      var correctIdx = q.type === 'judge' ? (q.answer ? 0 : 1) : q.answer;
      if (state.selected === correctIdx) { state.progress.known[q.id]=true; delete state.progress.wrong[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/known'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong'); }
      else { state.progress.wrong[q.id]=true; delete state.progress.known[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/wrong'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known'); }
    } else if (q.type === 'multiple') {
      if (!state.selected || !state.selected.length) { alert('请至少选择一个选项'); return; }
      var ca = q.answer.slice().sort(), ua = state.selected.slice().sort();
      var ok = ca.length === ua.length;
      if (ok) { for (var i = 0; i < ca.length; i++) { if (ca[i] !== ua[i]) { ok = false; break; } } }
      if (ok) { state.progress.known[q.id]=true; delete state.progress.wrong[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/known'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong'); }
      else { state.progress.wrong[q.id]=true; delete state.progress.known[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/wrong'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known'); }
    }
    state.revealed = true;
    updateStats(); renderList(); renderQuiz();
  }

  function updatePosition() {
    document.getElementById('position').textContent = state.indices.length ? ((state.current+1)+' / '+state.indices.length) : '- / -';
  }

  function render() { renderList(); renderQuiz(); updateStats(); }

  function next() { if (state.current < state.indices.length-1) { state.current++; state.revealed=false; state.selected=null; state.fillValue=''; render(); } }
  function prev() { if (state.current > 0) { state.current--; state.revealed=false; state.selected=null; state.fillValue=''; render(); } }

  function showToast(msg, type) {
    var t = document.createElement('div');
    t.className = 'toast toast-' + (type || 'info');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function() { t.classList.add('toast-show'); }, 10);
    setTimeout(function() { t.classList.remove('toast-show'); setTimeout(function() { t.remove(); }, 300); }, 2500);
  }

  function loadAllData() {
    return Promise.all([
      api('GET', '/questions'),
      api('GET', '/progress')
    ]).then(function(results) {
      state.questions = results[0] || [];
      state.progress = results[1] || { known: {}, wrong: {}, starred: {} };
      state.current = 0; state.revealed = false; state.selected = null; state.fillValue = '';
      buildCategoryFilter(); buildIndex(); render();
    }).catch(function(err) {
      if (err.message !== 'auth') showToast('加载数据失败', 'error');
    });
  }

  // ==================== MANUAL ADD ====================

  function openUsersPanel() {
    var existing = document.getElementById('usersPanel');
    if (existing) { existing.remove(); return; }

    if (!isAdminUser) { showToast('需要管理员权限', 'error'); return; }

    api('GET', '/users').then(function(users) {
      var div = document.createElement('div');
      div.id = 'usersPanel';
      div.className = 'import-section';
      div.style.maxWidth = '800px';
      div.style.width = '100%';
      div.style.marginTop = '12px';

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
      html += '<h3 style="margin:0;font-size:16px">👑 管理员面板</h3>';
      html += '<button class="btn" id="closeUsersBtn">关闭</button>';
      html += '</div>';
      html += '<div style="font-size:13px;color:var(--text2);margin-bottom:10px">共 ' + users.length + ' 位注册用户</div>';

      html += '<table style="width:100%;border-collapse:collapse;font-size:14px">';
      html += '<thead><tr style="border-bottom:2px solid var(--border)">';
      html += '<th style="text-align:left;padding:8px">用户名</th>';
      html += '<th style="text-align:center;padding:8px">身份</th>';
      html += '<th style="text-align:center;padding:8px">题目数</th>';
      html += '<th style="text-align:center;padding:8px">已掌握</th>';
      html += '<th style="text-align:center;padding:8px">错题</th>';
      html += '<th style="text-align:left;padding:8px">注册时间</th>';
      html += '<th style="text-align:center;padding:8px">操作</th>';
      html += '</tr></thead><tbody>';

      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        var isMe = (u.id === currentUser.id);
        html += '<tr style="border-bottom:1px solid var(--border)' + (isMe ? ';background:var(--accent-light)' : '') + '">';
        html += '<td style="padding:8px">' + escapeHtml(u.username) + (isMe ? ' <span style="color:var(--accent);font-size:11px">(当前)</span>' : '') + '</td>';
        html += '<td style="text-align:center;padding:8px">' + (u.role === 'admin' ? '<span style="color:var(--accent);font-weight:600">管理员</span>' : '用户') + '</td>';
        html += '<td style="text-align:center;padding:8px">' + u.questionCount + '</td>';
        html += '<td style="text-align:center;padding:8px;color:var(--green)">' + u.knownCount + '</td>';
        html += '<td style="text-align:center;padding:8px;color:var(--red)">' + u.wrongCount + '</td>';
        html += '<td style="padding:8px;font-size:12px;color:var(--text2)">' + escapeHtml(u.created_at || '-') + '</td>';
        html += '<td style="text-align:center;padding:8px;white-space:nowrap">';
        if (u.questionCount > 0) {
          html += '<button class="btn view-user-q-btn" data-uid="' + u.id + '" data-uname="' + escapeAttr(u.username) + '" style="padding:4px 8px;font-size:12px;margin-right:4px">📋题库</button>';
        }
        if (u.role !== 'admin') {
          html += '<button class="btn reset-pwd-btn" data-uid="' + u.id + '" data-uname="' + escapeAttr(u.username) + '" style="padding:4px 8px;font-size:12px;margin-right:4px">🔑重置密码</button>';
          html += '<button class="btn reset-prog-btn" data-uid="' + u.id + '" data-uname="' + escapeAttr(u.username) + '" style="padding:4px 8px;font-size:12px;margin-right:4px">🔄重置进度</button>';
          html += '<button class="btn btn-danger del-user-btn" data-uid="' + u.id + '" data-uname="' + escapeAttr(u.username) + '" style="padding:4px 8px;font-size:12px">🗑️删除</button>';
        }
        html += '</td></tr>';
      }

      html += '</tbody></table>';
      div.innerHTML = html;
      document.querySelector('.content').appendChild(div);

      document.getElementById('closeUsersBtn').onclick = function() { div.remove(); };

      var viewBtns = div.querySelectorAll('.view-user-q-btn');
      for (var i = 0; i < viewBtns.length; i++) {
        viewBtns[i].onclick = function() {
          var uid = parseInt(this.getAttribute('data-uid'));
          var uname = this.getAttribute('data-uname');
          openUserQuestions(uid, uname);
        };
      }

      var resetPwdBtns = div.querySelectorAll('.reset-pwd-btn');
      for (var i = 0; i < resetPwdBtns.length; i++) {
        resetPwdBtns[i].onclick = function() {
          var uid = parseInt(this.getAttribute('data-uid'));
          var uname = this.getAttribute('data-uname');
          var newPwd = prompt('为用户「' + uname + '」设置新密码（至少4位）：');
          if (!newPwd || newPwd.length < 4) { if (newPwd !== null) alert('密码至少4个字符'); return; }
          api('PUT', '/users/' + uid + '/reset-password', { password: newPwd }).then(function() {
            showToast('已重置「' + uname + '」的密码', 'success');
          });
        };
      }

      var resetProgBtns = div.querySelectorAll('.reset-prog-btn');
      for (var i = 0; i < resetProgBtns.length; i++) {
        resetProgBtns[i].onclick = function() {
          var uid = parseInt(this.getAttribute('data-uid'));
          var uname = this.getAttribute('data-uname');
          if (!confirm('确定重置用户「' + uname + '」的所有学习进度？')) return;
          api('POST', '/users/' + uid + '/reset-progress').then(function() {
            showToast('已重置「' + uname + '」的进度', 'success');
          });
        };
      }

      var delBtns = div.querySelectorAll('.del-user-btn');
      for (var i = 0; i < delBtns.length; i++) {
        delBtns[i].onclick = function() {
          var uid = parseInt(this.getAttribute('data-uid'));
          var uname = this.getAttribute('data-uname');
          if (!confirm('确定删除用户「' + uname + '」及其所有数据？此操作不可撤销！')) return;
          api('DELETE', '/users/' + uid).then(function() {
            showToast('已删除用户「' + uname + '」', 'success');
            div.remove();
          });
        };
      }
    });
  }

  function openUserQuestions(userId, username) {
    var existing = document.getElementById('userQPanel');
    if (existing) existing.remove();

    api('GET', '/users/' + userId + '/questions').then(function(questions) {
      var div = document.createElement('div');
      div.id = 'userQPanel';
      div.className = 'cat-editor';
      div.style.marginTop = '12px';

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
      html += '<h4 style="margin:0">📋 用户「' + escapeHtml(username) + '」的题库（共 ' + questions.length + ' 题）</h4>';
      html += '<button class="btn" id="closeUserQBtn">关闭</button>';
      html += '</div>';

      if (!questions.length) {
        html += '<div style="text-align:center;padding:20px;color:var(--text2)">该用户暂无题目</div>';
      } else {
        html += '<div style="margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap">';
        html += '<label style="cursor:pointer;font-size:13px"><input type="checkbox" id="uqSelectAll"> 全选</label>';
        html += '<button class="btn btn-danger" id="uqDeleteSelected" style="padding:4px 12px;font-size:12px">🗑️ 删除选中</button>';
        html += '</div>';
        html += '<div class="subj-batch-list" style="max-height:400px">';

        var subjectGroups = {};
        var subjectOrder = [];
        for (var i = 0; i < questions.length; i++) {
          var q = questions[i];
          var subj = q.subject || '未分科目';
          var cat = q.category || '未分类';
          var key = subj + ' / ' + cat;
          if (!subjectGroups[key]) { subjectGroups[key] = []; subjectOrder.push(key); }
          subjectGroups[key].push(q);
        }

        for (var s = 0; s < subjectOrder.length; s++) {
          var key = subjectOrder[s];
          var items = subjectGroups[key];
          html += '<div style="padding:6px 10px;font-weight:600;font-size:12px;color:var(--accent);background:var(--accent-light)">' + escapeHtml(key) + '（' + items.length + '题）</div>';
          for (var j = 0; j < items.length; j++) {
            var q = items[j];
            html += '<label class="subj-batch-item" style="display:flex;align-items:flex-start;gap:6px;padding:6px 8px;font-size:13px;cursor:pointer;border-radius:4px">';
            html += '<input type="checkbox" class="uq-check" data-qid="' + escapeAttr(q.id) + '" style="margin-top:3px">';
            html += '<div style="flex:1">';
            html += '<div style="font-weight:600">' + escapeHtml(q.question.substring(0, 80)) + '</div>';
            html += '<div style="font-size:11px;color:var(--text2);margin-top:2px">';
            html += '<span style="background:var(--accent-light);color:var(--accent);padding:1px 6px;border-radius:4px">' + (typeNames[q.type] || q.type) + '</span>';
            if (q.difficulty) html += ' <span>难度' + q.difficulty + '</span>';
            if (!hasAnswer(q)) html += ' <span style="color:var(--red)">⚠无答案</span>';
            html += '</div></div>';
            html += '<button class="btn uq-del-one" data-qid="' + escapeAttr(q.id) + '" style="padding:2px 8px;font-size:11px;flex-shrink:0">🗑️</button>';
            html += '</label>';
          }
        }
        html += '</div>';
      }

      div.innerHTML = html;
      document.querySelector('.content').appendChild(div);

      document.getElementById('closeUserQBtn').onclick = function() { div.remove(); };

      if (questions.length) {
        var checks = div.querySelectorAll('.uq-check');
        document.getElementById('uqSelectAll').onchange = function() {
          var checked = this.checked;
          for (var i = 0; i < checks.length; i++) checks[i].checked = checked;
        };

        document.getElementById('uqDeleteSelected').onclick = function() {
          var qids = [];
          for (var i = 0; i < checks.length; i++) {
            if (checks[i].checked) qids.push(checks[i].getAttribute('data-qid'));
          }
          if (!qids.length) { alert('请选择要删除的题目'); return; }
          if (!confirm('确定删除 ' + qids.length + ' 道题？此操作不可撤销！')) return;
          api('DELETE', '/users/' + userId + '/questions', qids).then(function() {
            showToast('已删除 ' + qids.length + ' 道题', 'success');
            div.remove();
            openUsersPanel();
          });
        };

        var delOneBtns = div.querySelectorAll('.uq-del-one');
        for (var i = 0; i < delOneBtns.length; i++) {
          delOneBtns[i].onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();
            var qid = this.getAttribute('data-qid');
            if (!confirm('确定删除此题？')) return;
            api('DELETE', '/users/' + userId + '/questions', [qid]).then(function() {
              showToast('已删除', 'success');
              div.remove();
              openUsersPanel();
            });
          };
        }
      }
    });
  }

  function setupAddForm() {
    var addToggle = document.getElementById('addToggle');
    var addBody = document.getElementById('addBody');
    addToggle.onclick = function() {
      if (addBody.style.display === 'none') { addBody.style.display = 'block'; addToggle.textContent = '➕ 手动添加题目 ▼'; }
      else { addBody.style.display = 'none'; addToggle.textContent = '➕ 手动添加题目 ▶'; }
    };

    var addType = document.getElementById('addType');
    addType.onchange = function() {
      var optArea = document.getElementById('addOptionsArea');
      if (addType.value === 'qa' || addType.value === 'fill') { optArea.style.display = 'none'; }
      else { optArea.style.display = ''; }
    };

    document.getElementById('addSubmitBtn').onclick = function() {
      var type = document.getElementById('addType').value;
      var subject = document.getElementById('addSubject').value.trim();
      var category = document.getElementById('addCategory').value.trim();
      var question = document.getElementById('addQuestion').value.trim();
      var answerStr = document.getElementById('addAnswer').value.trim();
      var explanation = document.getElementById('addExplanation').value.trim();

      if (!question) { alert('请输入题目内容'); return; }
      if (!answerStr) { alert('请输入答案'); return; }

      var q = {
        id: 'add_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        type: type,
        question: question,
        options: [],
        answer: '',
        subject: subject || '',
        category: category || '',
        difficulty: 1,
        explanation: explanation || ''
      };

      if (type === 'single' || type === 'multiple') {
        var optText = document.getElementById('addOptions').value.trim();
        if (!optText) { alert('请输入选项'); return; }
        var optLines = optText.split('\n');
        q.options = [];
        for (var i = 0; i < optLines.length; i++) {
          var line = optLines[i].trim().replace(/^[A-Da-d]\s*[.、)）.．]\s*/, '').trim();
          if (line) q.options.push(line);
        }
        if (q.options.length < 2) { alert('至少需要2个选项'); return; }

        var ans = answerStr.toUpperCase().replace(/[^A-Z]/g, '');
        if (type === 'single') {
          if (ans.length !== 1) { alert('单选题答案请输入一个字母，如 A'); return; }
          q.answer = ans.charCodeAt(0) - 65;
        } else {
          if (ans.length < 2) { alert('多选题答案请输入多个字母，如 AB'); return; }
          q.answer = ans.split('').map(function(c) { return c.charCodeAt(0) - 65; });
        }
      } else if (type === 'judge') {
        q.options = ['对', '错'];
        if (/^(对|正确|√|T|True|是)$/i.test(answerStr)) q.answer = true;
        else if (/^(错|错误|×|F|False|否)$/i.test(answerStr)) q.answer = false;
        else { alert('判断题答案请输入"对"或"错"'); return; }
      } else if (type === 'fill') {
        q.answer = answerStr;
      } else {
        q.answer = answerStr;
      }

      api('POST', '/questions', [q]).then(function() {
        document.getElementById('addQuestion').value = '';
        document.getElementById('addOptions').value = '';
        document.getElementById('addAnswer').value = '';
        document.getElementById('addExplanation').value = '';
        loadAllData().then(function() { showToast('添加题目成功！', 'success'); });
      }).catch(function() { showToast('添加失败', 'error'); });
    };
  }

  // ==================== INIT ====================

  function init() {
    var theme = localStorage.getItem('exercise-theme') || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    document.getElementById('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';

    if (currentUser) {
      document.getElementById('userInfo').textContent = (isAdminUser ? '👑 ' : '👤 ') + currentUser.username;
    }
    var usersBtn = document.getElementById('usersBtn');
    if (isAdminUser && usersBtn) usersBtn.style.display = '';

    document.getElementById('logoutBtn').onclick = function() {
      if (confirm('确定退出登录？')) {
        localStorage.removeItem('exercise-token');
        localStorage.removeItem('exercise-user');
        window.location.href = '/';
      }
    };

    document.getElementById('usersBtn').onclick = function() { openUsersPanel(); };
    document.getElementById('publicBtn').onclick = function() { openPublicSquare(); };
    document.getElementById('messagesBtn').onclick = function() { openMessagesPanel(); };
    document.getElementById('socialBtn').onclick = function() { openSocialPanel(); };

    loadAllData();
    updateMsgBadge();

    document.getElementById('searchInput').oninput = function() { state.current=0; state.revealed=false; buildIndex(); render(); };
    document.getElementById('filterMode').onchange = function() { state.current=0; state.revealed=false; buildIndex(); render(); };
    document.getElementById('categoryFilter').onchange = function() { state.current=0; state.revealed=false; buildIndex(); render(); };
    document.getElementById('shuffleBtn').onclick = function() {
      buildIndex();
      shuffle(state.indices);
      for (var i = 0; i < state.questions.length; i++) {
        var q = state.questions[i];
        if ((q.type === 'single' || q.type === 'multiple') && q.options && q.options.length > 1) {
          var ans = q.type === 'multiple' ? q.answer.slice() : q.answer;
          var indices = [];
          for (var k = 0; k < q.options.length; k++) indices.push(k);
          shuffle(indices);
          var newOpts = [];
          for (var k = 0; k < indices.length; k++) newOpts.push(q.options[indices[k]]);
          q.options = newOpts;
          if (q.type === 'multiple') {
            q.answer = [];
            for (var k = 0; k < indices.length; k++) { if (ans.indexOf(indices[k]) !== -1) q.answer.push(k); }
          } else {
            q.answer = indices.indexOf(ans);
          }
          api('PUT', '/questions/' + encodeURIComponent(q.id), { options: q.options, answer: q.answer });
        }
      }
      state.current=0; state.revealed=false; state.selected=null; render();
    };
    document.getElementById('prevBtn').onclick = prev;
    document.getElementById('nextBtn').onclick = next;
    document.getElementById('themeBtn').onclick = function() {
      var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', t);
      localStorage.setItem('exercise-theme', t);
      document.getElementById('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
    };
    document.getElementById('exportBtn').onclick = function() {
      var data = state.questions;
      var blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'questions.json'; a.click();
    };
    document.getElementById('resetProgressBtn').onclick = function() {
      if (confirm('确定重置所有学习进度？')) {
        api('POST', '/progress/reset').then(function() {
          state.progress = { known: {}, wrong: {}, starred: {} };
          render();
          showToast('进度已重置', 'success');
        });
      }
    };

    var fileInput = document.getElementById('fileInput');
    if (fileInput) { fileInput.onchange = function(e) { if (e.target.files && e.target.files[0]) readFile(e.target.files[0]); }; }
    var parseBtn = document.getElementById('parseBtn');
    if (parseBtn) { parseBtn.onclick = function() { var text = document.getElementById('pasteArea').value; if (!text.trim()) { alert('请先粘贴题目文本'); return; } var questions = parseQuestions(text); showPreview(questions); if (!questions.length) alert('未能解析出题目，请检查格式'); }; }
    var confirmImportBtn = document.getElementById('confirmImport');
    if (confirmImportBtn) { confirmImportBtn.onclick = doConfirmImport; }
    var importToggle = document.getElementById('importToggle');
    if (importToggle) {
      importToggle.onclick = function() {
        var body = document.getElementById('importBody');
        if (body.style.display === 'none') { body.style.display = 'block'; importToggle.textContent = '📥 导入题目 ▼'; }
        else { body.style.display = 'none'; importToggle.textContent = '📥 导入题目 ▶'; }
      };
    }

    setupAddForm();

    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
      else if (e.key === ' ') { e.preventDefault(); if (state.indices.length) { state.revealed = !state.revealed; renderQuiz(); } }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); if (state.indices.length) { var q = state.questions[state.indices[state.current]]; if (state.progress.starred[q.id]) { delete state.progress.starred[q.id]; api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/starred'); } else { state.progress.starred[q.id] = true; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/starred'); } updateStats(); renderList(); renderQuiz(); } }
      else if (e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.indices.length) { var q = state.questions[state.indices[state.current]]; if (state.progress.known[q.id]) { delete state.progress.known[q.id]; api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/known'); } else { state.progress.known[q.id]=true; delete state.progress.wrong[q.id]; api('PUT', '/progress/' + encodeURIComponent(q.id) + '/known'); api('DELETE', '/progress/' + encodeURIComponent(q.id) + '/wrong'); } updateStats(); renderList(); renderQuiz(); } }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // ==================== 消息角标 ====================
  function updateMsgBadge() {
    api('GET', '/messages/unread').then(function(data) {
      var btn = document.getElementById('messagesBtn');
      var existing = btn.querySelector('.msg-badge');
      if (existing) existing.remove();
      if (data.count > 0) {
        var badge = document.createElement('span');
        badge.className = 'msg-badge';
        badge.textContent = data.count;
        badge.style.cssText = 'position:absolute;top:-4px;right:-4px;background:var(--red);color:#fff;font-size:10px;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-weight:700';
        btn.style.position = 'relative';
        btn.appendChild(badge);
      }
    }).catch(function(){});
    setTimeout(updateMsgBadge, 30000);
  }

  // ==================== 公共题库广场 ====================
  function openPublicSquare() {
    closePanel('publicPanel');
    var div = document.createElement('div');
    div.id = 'publicPanel';
    div.className = 'import-section';
    div.style.maxWidth = '800px';
    div.style.marginTop = '12px';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '<h3 style="margin:0;font-size:16px">🌐 公共题库广场</h3>';
    html += '<div><button class="btn" id="closePublicBtn">关闭</button></div>';
    html += '</div>';

    if (isAdminUser) {
      html += '<div class="cat-editor" style="margin-bottom:12px">';
      html += '<h4 style="font-size:14px;margin-bottom:8px">📢 发布公共题库</h4>';
      html += '<div class="cat-editor-row"><span>标题：</span><input type="text" id="pubTitle" placeholder="如：期末复习题集"></div>';
      html += '<div style="margin-bottom:8px;font-size:13px;color:var(--text2)">选择题库中的题目发布到广场：</div>';
      html += '<div style="margin-bottom:6px"><label style="cursor:pointer;font-size:13px"><input type="checkbox" id="pubSelectAll"> 全选</label></div>';
      html += '<div class="subj-batch-list" id="pubQList" style="max-height:200px">';
      for (var i = 0; i < state.questions.length; i++) {
        var q = state.questions[i];
        html += '<label class="subj-batch-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;cursor:pointer">';
        html += '<input type="checkbox" class="pub-check" data-idx="' + i + '">';
        html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(q.question.substring(0, 50)) + '</span>';
        html += '<span style="font-size:11px;color:var(--text2)">[' + escapeHtml(q.subject || '未分') + ']</span>';
        html += '</label>';
      }
      html += '</div>';
      html += '<button class="btn btn-primary" id="pubSubmitBtn" style="margin-top:8px">📢 发布到广场</button>';
      html += '</div>';
    }

    html += '<div id="pubListArea"><div style="text-align:center;color:var(--text2);padding:20px">加载中...</div></div>';
    div.innerHTML = html;
    document.querySelector('.content').appendChild(div);

    document.getElementById('closePublicBtn').onclick = function() { div.remove(); };

    if (isAdminUser) {
      document.getElementById('pubSelectAll').onchange = function() {
        var checks = div.querySelectorAll('.pub-check');
        for (var i = 0; i < checks.length; i++) checks[i].checked = this.checked;
      };
      document.getElementById('pubSubmitBtn').onclick = function() {
        var title = document.getElementById('pubTitle').value.trim();
        var checks = div.querySelectorAll('.pub-check');
        var qs = [];
        for (var i = 0; i < checks.length; i++) {
          if (checks[i].checked) {
            var idx = parseInt(checks[i].getAttribute('data-idx'));
            var q = state.questions[idx];
            qs.push({ id: 'pub_' + q.id + '_' + Date.now(), type: q.type, question: q.question, options: q.options, answer: q.answer, subject: q.subject, category: q.category, difficulty: q.difficulty, explanation: q.explanation });
          }
        }
        if (!qs.length) { alert('请选择题目'); return; }
        api('POST', '/public', { questions: qs, title: title }).then(function() {
          showToast('已发布 ' + qs.length + ' 道题到公共广场', 'success');
          loadPublicList();
        });
      };
    }

    loadPublicList();
  }

  function loadPublicList() {
    api('GET', '/public').then(function(list) {
      var area = document.getElementById('pubListArea');
      if (!area) return;
      if (!list.length) {
        area.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">暂无公共题库</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        html += '<div class="q-card" style="margin-bottom:10px;padding:16px;cursor:pointer" data-pubid="' + escapeAttr(p.id) + '">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center">';
        html += '<div>';
        html += '<div style="font-weight:600;font-size:15px">📚 ' + escapeHtml(p.title) + '</div>';
        html += '<div style="font-size:12px;color:var(--text2);margin-top:4px">发布者：' + escapeHtml(p.publisher) + ' · ' + p.questionCount + ' 题 · ' + escapeHtml(p.created_at) + '</div>';
        html += '</div>';
        html += '<button class="btn btn-primary view-pub-btn" data-pubid="' + escapeAttr(p.id) + '">查看题库</button>';
        html += '</div>';
        html += '</div>';
      }
      if (isAdminUser) {
        for (var i = 0; i < list.length; i++) {
          html = html.replace('data-pubid="' + escapeAttr(list[i].id) + '">', 'data-pubid="' + escapeAttr(list[i].id) + '" data-candelete="1" ');
        }
      }
      area.innerHTML = html;

      var viewBtns = area.querySelectorAll('.view-pub-btn');
      for (var i = 0; i < viewBtns.length; i++) {
        viewBtns[i].onclick = function(e) { e.stopPropagation(); viewPublicDetail(this.getAttribute('data-pubid')); };
      }
    });
  }

  function viewPublicDetail(pubId) {
    api('GET', '/public/' + pubId).then(function(detail) {
      var existing = document.getElementById('pubDetail');
      if (existing) existing.remove();
      var div = document.createElement('div');
      div.id = 'pubDetail';
      div.className = 'cat-editor';

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
      html += '<h4 style="margin:0">📚 ' + escapeHtml(detail.title) + '（' + detail.questions.length + ' 题）</h4>';
      html += '<div><button class="btn btn-primary" id="importPubBtn">📥 导入到我的题库</button>';
      if (isAdminUser) html += ' <button class="btn btn-danger" id="delPubBtn">🗑️ 删除</button>';
      html += ' <button class="btn" id="closePubDetailBtn">关闭</button></div></div>';

      html += '<div class="subj-batch-list" style="max-height:400px">';
      for (var i = 0; i < detail.questions.length; i++) {
        var q = detail.questions[i];
        html += '<div style="padding:8px;border-bottom:1px solid var(--border);font-size:13px">';
        html += '<div style="font-weight:600">' + (i+1) + '. ' + escapeHtml(q.question.substring(0, 80)) + '</div>';
        html += '<div style="font-size:11px;color:var(--text2);margin-top:2px"><span style="background:var(--accent-light);color:var(--accent);padding:1px 6px;border-radius:4px">' + (typeNames[q.type]||q.type) + '</span> ' + escapeHtml(q.subject||'') + ' / ' + escapeHtml(q.category||'') + '</div>';
        html += '</div>';
      }
      html += '</div>';

      div.innerHTML = html;
      document.querySelector('.content').appendChild(div);

      document.getElementById('closePubDetailBtn').onclick = function() { div.remove(); };
      document.getElementById('importPubBtn').onclick = function() {
        var qs = detail.questions.map(function(q) {
          return { id: 'pubimp_' + Date.now() + '_' + Math.random().toString(36).substr(2,6), type: q.type, question: q.question, options: q.options || [], answer: q.answer, subject: q.subject || '', category: q.category || '', difficulty: q.difficulty || 1, explanation: q.explanation || '' };
        });
        api('POST', '/questions', qs).then(function() {
          loadAllData().then(function() { showToast('已导入 ' + qs.length + ' 道题', 'success'); div.remove(); });
        });
      };
      if (isAdminUser) {
        document.getElementById('delPubBtn').onclick = function() {
          if (!confirm('确定删除此公共题库？')) return;
          api('DELETE', '/public/' + pubId).then(function() {
            showToast('已删除', 'success'); div.remove(); loadPublicList();
          });
        };
      }
    });
  }

  // ==================== 消息面板 ====================
  function openMessagesPanel() {
    closePanel('msgPanel');
    var div = document.createElement('div');
    div.id = 'msgPanel';
    div.className = 'import-section';
    div.style.maxWidth = '800px';
    div.style.marginTop = '12px';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '<h3 style="margin:0;font-size:16px">💬 消息中心</h3>';
    html += '<button class="btn" id="closeMsgBtn">关闭</button></div>';

    html += '<div style="display:flex;gap:8px;margin-bottom:12px">';
    html += '<select id="msgToUser" class="select" style="flex:1"></select>';
    html += '<input type="text" id="msgContent" class="search" placeholder="输入消息..." style="flex:2">';
    html += '<button class="btn btn-primary" id="sendMsgBtn">发送</button>';
    html += '</div>';

    html += '<div id="msgListArea" style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:8px"></div>';

    div.innerHTML = html;
    document.querySelector('.content').appendChild(div);

    document.getElementById('closeMsgBtn').onclick = function() { div.remove(); };

    api('GET', '/users').then(function(users) {
      var sel = document.getElementById('msgToUser');
      for (var i = 0; i < users.length; i++) {
        if (users[i].id === currentUser.id) continue;
        var o = document.createElement('option');
        o.value = users[i].id; o.textContent = users[i].username;
        sel.appendChild(o);
      }
    });

    document.getElementById('sendMsgBtn').onclick = function() {
      var toId = parseInt(document.getElementById('msgToUser').value);
      var content = document.getElementById('msgContent').value.trim();
      if (!toId) { alert('请选择接收用户'); return; }
      if (!content) { alert('请输入消息'); return; }
      api('POST', '/messages', { toUserId: toId, content: content }).then(function() {
        document.getElementById('msgContent').value = '';
        loadMsgList();
        showToast('已发送', 'success');
      });
    };

    api('POST', '/messages/read').then(function() {
      var btn = document.getElementById('messagesBtn');
      var badge = btn.querySelector('.msg-badge');
      if (badge) badge.remove();
    });

    loadMsgList();
  }

  function loadMsgList() {
    api('GET', '/messages').then(function(messages) {
      var area = document.getElementById('msgListArea');
      if (!area) return;
      if (!messages.length) {
        area.innerHTML = '<div style="text-align:center;color:var(--text2);padding:30px">暂无消息</div>';
        return;
      }
      messages.reverse();
      var html = '';
      for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        var bg = m.isMine ? 'background:var(--accent-light)' : 'background:var(--card)';
        var align = m.isMine ? 'margin-left:40px' : 'margin-right:40px';
        var nameColor = m.isMine ? 'var(--accent)' : 'var(--green)';
        html += '<div style="padding:10px 14px;border-bottom:1px solid var(--border);' + align + ';' + bg + ';border-radius:8px;margin-bottom:4px">';
        html += '<div style="font-size:11px;color:' + nameColor + ';font-weight:600">' + (m.isMine ? '我' : escapeHtml(m.from_username)) + ' · ' + escapeHtml(m.created_at) + '</div>';
        html += '<div style="font-size:14px;margin-top:4px;line-height:1.5">' + escapeHtml(m.content) + '</div>';
        if (m.type === 'share') {
          html += '<button class="btn view-share-btn" data-ref="' + escapeAttr(m.ref_id) + '" style="padding:2px 10px;font-size:12px;margin-top:6px">📋 查看分享</button>';
        }
        html += '</div>';
      }
      area.innerHTML = html;

      var shareBtns = area.querySelectorAll('.view-share-btn');
      for (var i = 0; i < shareBtns.length; i++) {
        shareBtns[i].onclick = function() { viewShareDetail(this.getAttribute('data-ref')); };
      }
    });
  }

  // ==================== 分享题目 ====================
  function openShareEditor(qid) {
    var existing = document.getElementById('shareEditor');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'shareEditor';
    div.className = 'cat-editor';

    var html = '<h4 style="font-size:14px;margin-bottom:8px">📤 分享题目</h4>';
    html += '<div style="margin-bottom:8px"><label style="cursor:pointer;font-size:13px"><input type="checkbox" id="shareSelectAll"> 全选当前题库</label></div>';
    html += '<div class="subj-batch-list" id="shareQList" style="max-height:200px">';
    for (var i = 0; i < state.questions.length; i++) {
      var q = state.questions[i];
      var isCurrent = (q.id === qid);
      html += '<label class="subj-batch-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;cursor:pointer">';
      html += '<input type="checkbox" class="share-check" data-idx="' + i + '"' + (isCurrent ? ' checked' : '') + '>';
      html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(q.question.substring(0, 50)) + '</span>';
      html += '</label>';
    }
    html += '</div>';
    html += '<div class="cat-editor-row" style="margin-top:8px"><span>分享给：</span><select id="shareToUser" class="select"></select></div>';
    html += '<div class="form-group" style="margin-top:6px"><label>附言（可选）：</label><input type="text" id="shareMsg" class="q-fill" placeholder="说点什么..."></div>';
    html += '<div class="editor-actions"><button class="btn btn-primary" id="sendShareBtn">📤 分享</button><button class="btn" id="cancelShareBtn">取消</button></div>';

    div.innerHTML = html;
    document.querySelector('.q-card').appendChild(div);

    document.getElementById('shareSelectAll').onchange = function() {
      var checks = div.querySelectorAll('.share-check');
      for (var i = 0; i < checks.length; i++) checks[i].checked = this.checked;
    };

    api('GET', '/users').then(function(users) {
      var sel = document.getElementById('shareToUser');
      for (var i = 0; i < users.length; i++) {
        if (users[i].id === currentUser.id) continue;
        var o = document.createElement('option');
        o.value = users[i].id; o.textContent = users[i].username;
        sel.appendChild(o);
      }
    });

    document.getElementById('sendShareBtn').onclick = function() {
      var toId = parseInt(document.getElementById('shareToUser').value);
      if (!toId) { alert('请选择接收用户'); return; }
      var checks = div.querySelectorAll('.share-check');
      var qs = [];
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) {
          var idx = parseInt(checks[i].getAttribute('data-idx'));
          var q = state.questions[idx];
          qs.push({ id: 'shr_' + q.id + '_' + Date.now(), type: q.type, question: q.question, options: q.options, answer: q.answer, subject: q.subject, category: q.category, difficulty: q.difficulty, explanation: q.explanation });
        }
      }
      if (!qs.length) { alert('请选择题目'); return; }
      var msg = document.getElementById('shareMsg').value.trim();
      api('POST', '/share', { toUserId: toId, questions: qs, message: msg }).then(function() {
        showToast('已分享 ' + qs.length + ' 道题', 'success');
        div.remove();
      });
    };
    document.getElementById('cancelShareBtn').onclick = function() { div.remove(); };
  }

  function viewShareDetail(shareId) {
    api('GET', '/shared/' + shareId).then(function(detail) {
      var existing = document.getElementById('shareDetail');
      if (existing) existing.remove();
      var div = document.createElement('div');
      div.id = 'shareDetail';
      div.className = 'cat-editor';

      var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
      html += '<h4 style="margin:0">📋 来自「' + escapeHtml(detail.from_username) + '」的分享（' + detail.questions.length + ' 题）</h4>';
      html += '<div><button class="btn btn-primary" id="acceptShareBtn">📥 导入到我的题库</button>';
      html += ' <button class="btn" id="closeShareDetailBtn">关闭</button></div></div>';

      if (detail.message) html += '<div style="padding:8px 12px;background:var(--accent-light);border-radius:6px;font-size:13px;margin-bottom:10px">💬 ' + escapeHtml(detail.message) + '</div>';

      html += '<div class="subj-batch-list" style="max-height:300px">';
      for (var i = 0; i < detail.questions.length; i++) {
        var q = detail.questions[i];
        html += '<div style="padding:8px;border-bottom:1px solid var(--border);font-size:13px">';
        html += '<div style="font-weight:600">' + (i+1) + '. ' + escapeHtml(q.question.substring(0, 80)) + '</div>';
        html += '<div style="font-size:11px;color:var(--text2);margin-top:2px"><span style="background:var(--accent-light);color:var(--accent);padding:1px 6px;border-radius:4px">' + (typeNames[q.type]||q.type) + '</span> ' + escapeHtml(q.subject||'') + '</div>';
        html += '</div>';
      }
      html += '</div>';

      div.innerHTML = html;
      document.querySelector('.content').appendChild(div);

      document.getElementById('closeShareDetailBtn').onclick = function() { div.remove(); };
      document.getElementById('acceptShareBtn').onclick = function() {
        api('POST', '/shared/' + shareId + '/accept').then(function() {
          loadAllData().then(function() { showToast('已导入到题库', 'success'); div.remove(); });
        });
      };
    });
  }

  // ==================== 交友中心 ====================
  function openSocialPanel() {
    closePanel('socialPanel');
    var div = document.createElement('div');
    div.id = 'socialPanel';
    div.className = 'import-section';
    div.style.maxWidth = '800px';
    div.style.marginTop = '12px';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '<h3 style="margin:0;font-size:16px">🤝 交友中心</h3>';
    html += '<button class="btn" id="closeSocialBtn">关闭</button></div>';

    html += '<div style="display:flex;gap:8px;margin-bottom:16px">';
    html += '<button class="btn btn-primary" id="socialFriendsTab">我的好友</button>';
    html += '<button class="btn" id="socialRequestsTab">好友请求</button>';
    html += '<button class="btn" id="socialDiscoverTab">发现用户</button>';
    html += '</div>';

    html += '<div id="socialContent"></div>';
    div.innerHTML = html;
    document.querySelector('.content').appendChild(div);

    document.getElementById('closeSocialBtn').onclick = function() { div.remove(); };

    document.getElementById('socialFriendsTab').onclick = function() {
      setActiveTab('socialFriendsTab');
      loadFriendsList();
    };
    document.getElementById('socialRequestsTab').onclick = function() {
      setActiveTab('socialRequestsTab');
      loadFriendRequests();
    };
    document.getElementById('socialDiscoverTab').onclick = function() {
      setActiveTab('socialDiscoverTab');
      loadDiscoverUsers();
    };

    function setActiveTab(activeId) {
      ['socialFriendsTab', 'socialRequestsTab', 'socialDiscoverTab'].forEach(function(id) {
        var btn = document.getElementById(id);
        if (id === activeId) btn.className = 'btn btn-primary';
        else btn.className = 'btn';
      });
    }

    loadFriendsList();

    function loadFriendsList() {
      api('GET', '/friends').then(function(friends) {
        var content = document.getElementById('socialContent');
        if (!friends.length) {
          content.innerHTML = '<div style="text-align:center;color:var(--text2);padding:30px">暂无好友，去"发现用户"添加好友吧！</div>';
          return;
        }
        var html = '<div style="font-size:13px;color:var(--text2);margin-bottom:8px">共 ' + friends.length + ' 位好友</div>';
        for (var i = 0; i < friends.length; i++) {
          var f = friends[i];
          html += '<div class="q-card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">';
          html += '<div>';
          html += '<div style="font-weight:600;font-size:15px">👤 ' + escapeHtml(f.username) + '</div>';
          html += '<div style="font-size:12px;color:var(--text2)">成为好友时间：' + escapeHtml(f.created_at) + '</div>';
          html += '</div>';
          html += '<div style="display:flex;gap:6px">';
          html += '<button class="btn chat-friend-btn" data-uid="' + f.id + '" data-uname="' + escapeAttr(f.username) + '">💬 聊天</button>';
          html += '<button class="btn share-friend-btn" data-uid="' + f.id + '" data-uname="' + escapeAttr(f.username) + '">📤 分享题目</button>';
          html += '<button class="btn btn-danger remove-friend-btn" data-uid="' + f.id + '" data-uname="' + escapeAttr(f.username) + '">删除好友</button>';
          html += '</div></div>';
        }
        content.innerHTML = html;

        content.querySelectorAll('.chat-friend-btn').forEach(function(btn) {
          btn.onclick = function() { openChatWith(this.getAttribute('data-uid'), this.getAttribute('data-uname')); };
        });
        content.querySelectorAll('.share-friend-btn').forEach(function(btn) {
          btn.onclick = function() { openShareToFriend(this.getAttribute('data-uid'), this.getAttribute('data-uname')); };
        });
        content.querySelectorAll('.remove-friend-btn').forEach(function(btn) {
          btn.onclick = function() {
            var uid = parseInt(this.getAttribute('data-uid'));
            var uname = this.getAttribute('data-uname');
            if (!confirm('确定删除好友「' + uname + '」？')) return;
            api('DELETE', '/friends/' + uid).then(function() { loadFriendsList(); showToast('已删除好友', 'success'); });
          };
        });
      });
    }

    function loadFriendRequests() {
      api('GET', '/friends/requests').then(function(requests) {
        var content = document.getElementById('socialContent');
        if (!requests.length) {
          content.innerHTML = '<div style="text-align:center;color:var(--text2);padding:30px">暂无好友请求</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < requests.length; i++) {
          var r = requests[i];
          html += '<div class="q-card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">';
          html += '<div>';
          html += '<div style="font-weight:600;font-size:15px">👤 ' + escapeHtml(r.from_username) + '</div>';
          html += '<div style="font-size:12px;color:var(--text2)">请求时间：' + escapeHtml(r.created_at) + '</div>';
          html += '</div>';
          html += '<div style="display:flex;gap:6px">';
          html += '<button class="btn btn-primary accept-fr-btn" data-frid="' + escapeAttr(r.id) + '">✅ 接受</button>';
          html += '<button class="btn btn-danger reject-fr-btn" data-frid="' + escapeAttr(r.id) + '">❌ 拒绝</button>';
          html += '</div></div>';
        }
        content.innerHTML = html;

        content.querySelectorAll('.accept-fr-btn').forEach(function(btn) {
          btn.onclick = function() {
            api('POST', '/friends/accept/' + this.getAttribute('data-frid')).then(function() {
              showToast('已接受好友请求', 'success'); loadFriendRequests();
            });
          };
        });
        content.querySelectorAll('.reject-fr-btn').forEach(function(btn) {
          btn.onclick = function() {
            api('POST', '/friends/reject/' + this.getAttribute('data-frid')).then(function() { loadFriendRequests(); });
          };
        });
      });
    }

    function loadDiscoverUsers() {
      api('GET', '/friends/discover').then(function(users) {
        var content = document.getElementById('socialContent');
        if (!users.length) {
          content.innerHTML = '<div style="text-align:center;color:var(--text2);padding:30px">没有更多用户可以添加了</div>';
          return;
        }
        var html = '<div style="font-size:13px;color:var(--text2);margin-bottom:8px">以下用户可以添加为好友</div>';
        for (var i = 0; i < users.length; i++) {
          var u = users[i];
          html += '<div class="q-card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">';
          html += '<div>';
          html += '<div style="font-weight:600;font-size:15px">👤 ' + escapeHtml(u.username) + '</div>';
          html += '<div style="font-size:12px;color:var(--text2)">注册时间：' + escapeHtml(u.created_at || '-') + '</div>';
          html += '</div>';
          html += '<button class="btn btn-primary add-friend-btn" data-uid="' + u.id + '">➕ 加好友</button>';
          html += '</div>';
        }
        content.innerHTML = html;

        content.querySelectorAll('.add-friend-btn').forEach(function(btn) {
          btn.onclick = function() {
            var uid = parseInt(this.getAttribute('data-uid'));
            api('POST', '/friends/request', { toUserId: uid }).then(function() {
              showToast('好友请求已发送', 'success'); loadDiscoverUsers();
            }).catch(function(e) { showToast('发送失败，可能已请求过', 'error'); });
          };
        });
      });
    }
  }

  function openChatWith(userId, username) {
    closePanel('chatPanel');
    var div = document.createElement('div');
    div.id = 'chatPanel';
    div.className = 'import-section';
    div.style.maxWidth = '800px';
    div.style.marginTop = '12px';

    var html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '<h3 style="margin:0;font-size:16px">💬 与 ' + escapeHtml(username) + ' 的对话</h3>';
    html += '<button class="btn" id="closeChatBtn">关闭</button></div>';
    html += '<div id="chatMessages" style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px"></div>';
    html += '<div style="display:flex;gap:8px"><input type="text" id="chatInput" class="search" placeholder="输入消息..." style="flex:1"><button class="btn btn-primary" id="chatSendBtn">发送</button></div>';

    div.innerHTML = html;
    document.querySelector('.content').appendChild(div);

    document.getElementById('closeChatBtn').onclick = function() { div.remove(); };

    function loadChat() {
      api('GET', '/messages').then(function(msgs) {
        var chatMsgs = msgs.filter(function(m) {
          return (m.from_user_id === currentUser.id && m.to_user_id === parseInt(userId)) ||
                 (m.from_user_id === parseInt(userId) && m.to_user_id === currentUser.id);
        });
        chatMsgs.reverse();
        var area = document.getElementById('chatMessages');
        var h = '';
        for (var i = 0; i < chatMsgs.length; i++) {
          var m = chatMsgs[i];
          if (m.isMine) {
            h += '<div style="margin-left:40px;background:var(--accent-light);padding:8px 12px;border-radius:8px;margin-bottom:4px">';
            h += '<div style="font-size:11px;color:var(--accent)">我 · ' + escapeHtml(m.created_at) + '</div>';
          } else {
            h += '<div style="margin-right:40px;background:var(--card);border:1px solid var(--border);padding:8px 12px;border-radius:8px;margin-bottom:4px">';
            h += '<div style="font-size:11px;color:var(--green)">' + escapeHtml(username) + ' · ' + escapeHtml(m.created_at) + '</div>';
          }
          h += '<div style="font-size:14px;margin-top:4px">' + escapeHtml(m.content) + '</div>';
          h += '</div>';
        }
        area.innerHTML = h || '<div style="text-align:center;color:var(--text2);padding:20px">暂无消息</div>';
        area.scrollTop = area.scrollHeight;
      });
    }

    loadChat();

    document.getElementById('chatSendBtn').onclick = function() { sendChatMsg(); };
    document.getElementById('chatInput').onkeydown = function(e) { if (e.key === 'Enter') { e.preventDefault(); sendChatMsg(); } };

    function sendChatMsg() {
      var input = document.getElementById('chatInput');
      var content = input.value.trim();
      if (!content) return;
      api('POST', '/messages', { toUserId: parseInt(userId), content: content }).then(function() {
        input.value = '';
        loadChat();
      });
    }
  }

  function openShareToFriend(userId, username) {
    var existing = document.getElementById('shareFriendEditor');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.id = 'shareFriendEditor';
    div.className = 'cat-editor';

    var html = '<h4 style="font-size:14px;margin-bottom:8px">📤 分享题目给 ' + escapeHtml(username) + '</h4>';
    html += '<div style="margin-bottom:8px"><label style="cursor:pointer;font-size:13px"><input type="checkbox" id="sfSelectAll"> 全选</label></div>';
    html += '<div class="subj-batch-list" style="max-height:200px">';
    for (var i = 0; i < state.questions.length; i++) {
      var q = state.questions[i];
      html += '<label class="subj-batch-item" style="display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;cursor:pointer">';
      html += '<input type="checkbox" class="sf-check" data-idx="' + i + '">';
      html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(q.question.substring(0, 50)) + '</span>';
      html += '</label>';
    }
    html += '</div>';
    html += '<div class="form-group" style="margin-top:6px"><label>附言（可选）：</label><input type="text" id="sfMsg" class="q-fill" placeholder="说点什么..."></div>';
    html += '<div class="editor-actions"><button class="btn btn-primary" id="sfSubmitBtn">📤 分享</button><button class="btn" id="sfCancelBtn">取消</button></div>';

    div.innerHTML = html;
    document.querySelector('.content').appendChild(div);

    document.getElementById('sfSelectAll').onchange = function() {
      var checks = div.querySelectorAll('.sf-check');
      for (var i = 0; i < checks.length; i++) checks[i].checked = this.checked;
    };

    document.getElementById('sfSubmitBtn').onclick = function() {
      var checks = div.querySelectorAll('.sf-check');
      var qs = [];
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) {
          var idx = parseInt(checks[i].getAttribute('data-idx'));
          var q = state.questions[idx];
          qs.push({ id: 'shr_' + q.id + '_' + Date.now(), type: q.type, question: q.question, options: q.options, answer: q.answer, subject: q.subject, category: q.category, difficulty: q.difficulty, explanation: q.explanation });
        }
      }
      if (!qs.length) { alert('请选择题目'); return; }
      var msg = document.getElementById('sfMsg').value.trim();
      api('POST', '/share', { toUserId: parseInt(userId), questions: qs, message: msg }).then(function() {
        showToast('已分享 ' + qs.length + ' 道题给 ' + username, 'success');
        div.remove();
      });
    };
    document.getElementById('sfCancelBtn').onclick = function() { div.remove(); };
  }

  function closePanel(id) {
    var existing = document.getElementById(id);
    if (existing) existing.remove();
  }
})();
