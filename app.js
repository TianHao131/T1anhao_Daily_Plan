(function() {
  'use strict';

  // Cloud cache is isolated by account in daily-sync.js.

  var state = {
    tasks: [],
    records: {},
    monthlyTasks: [],
    plannedTasks: [],
    monthlyRecords: {},
    tags: [{name:"作业",color:"#1E8449"},{name:"补课",color:"#2980B9"},{name:"考试",color:"#C0392B"}]
  };

  var editingState = null;
  var moveMenuState = null; // { taskId, monthOffset }
  var assignMenuState = null; // { taskId, monthOffset } 布置作业菜单
  var currentDate = ''; // YYYY-MM-DD，当前选中的日期
  var viewMonth = new Date(); // 月历当前查看的月份（保留，移动任务菜单用）
  var needScrollToToday = true; // 进入每月页时是否自动滚到今天
  var pendingScrollDate = null; // 复制/跳转后需要滚到的日期（YYYY-MM-DD）
  var statsMonth = new Date();
  statsMonth.setDate(1);
  var selectedHistoryDate = getTodayKey();

  var WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
  var TEMPORARY_TAG = '临时任务';

  // System label is supplied to old data in memory; it is saved with the next user edit.
  function ensureTemporaryTag() {
    var index = state.tags.findIndex(function(tag) { return tag.name === TEMPORARY_TAG; });
    if (index < 0) state.tags.unshift({ name: TEMPORARY_TAG, color: '#8E44AD' });
    else if (index > 0) state.tags.unshift(state.tags.splice(index, 1)[0]);
  }

  // ===== 数据层 =====
  function loadState(source) {
    state = {tasks: [], records: {}, monthlyTasks: [], monthlyRecords: {}, plannedTasks: [], tags: [{name:"作业",color:"#1E8449"},{name:"补课",color:"#2980B9"},{name:"考试",color:"#C0392B"}]};
    try {
      var raw = source ? JSON.stringify(source) : null;
      if (raw) {
        var data = JSON.parse(raw);
        state.tasks = data.tasks || [];
        state.records = data.records || {};
        state.monthlyTasks = data.monthlyTasks || [];
        state.monthlyRecords = data.monthlyRecords || {};
        state.plannedTasks = validPlannedTasks(data.plannedTasks) ? (data.plannedTasks || []) : [];
        // 兼容旧 weekly 数据：迁移到 monthly
        if (data.weeklyTasks && data.weeklyTasks.length > 0 && state.monthlyTasks.length === 0) {
          var today = new Date();
          var todayNum = today.getDay() || 7;
          var monday = new Date(today);
          monday.setDate(today.getDate() - (todayNum - 1));
          data.weeklyTasks.forEach(function(t) {
            var dayOffset = (t.day || 1) - 1;
            var d = new Date(monday);
            d.setDate(monday.getDate() + dayOffset);
            state.monthlyTasks.push({
              id: t.id,
              name: t.name,
              monthKey: formatMonthKey(d),
              date: formatDateKey(d),
              createdAt: t.createdAt || getTodayKey()
            });
          });
          if (data.weeklyRecords) {
            Object.keys(data.weeklyRecords).forEach(function(wk) {
              state.monthlyRecords[wk] = data.weeklyRecords[wk];
            });
          }
        }
        // 标签列表初始化
        if (!data.tags || !Array.isArray(data.tags) || data.tags.length === 0) {
          state.tags = [{name:'作业',color:'#1E8449'},{name:'补课',color:'#2980B9'}];
        } else {
          state.tags = data.tags;
        }
        // 兼容旧数据：迁移 category 枚举为标签名
        state.monthlyTasks.forEach(function(t) {
          if (t.category === 'homework') t.category = '作业';
          else if (t.category === 'makeup') t.category = '补课';
          else if (t.category === 'normal' || !t.category) t.category = '';
        });
        // 强制作业绿、补课蓝、确保考试标签存在（红）
        var hwTag = state.tags.find(function(x) { return x.name === '作业'; });
        if (hwTag) hwTag.color = '#1E8449';
        var makeupTag = state.tags.find(function(x) { return x.name === '补课'; });
        if (makeupTag) makeupTag.color = '#2980B9';
        var examTag = state.tags.find(function(x) { return x.name === '考试'; });
        if (!examTag) state.tags.push({name:'考试', color:'#C0392B'});
        else examTag.color = '#C0392B';
        // 确保"写作业"系统标签存在（银灰无色，优先级次于补课）
        var writeTag = state.tags.find(function(x) { return x.name === '写作业'; });
        if (!writeTag) {
          var _mkIdx = state.tags.findIndex(function(x) { return x.name === '补课'; });
          var _newW = {name:'写作业', color:'#95A5A6'};
          if (_mkIdx >= 0) state.tags.splice(_mkIdx + 1, 0, _newW);
          else state.tags.push(_newW);
        } else {
          writeTag.color = '#95A5A6';
          var _mkIdx2 = state.tags.findIndex(function(x) { return x.name === '补课'; });
          var _wIdx = state.tags.indexOf(writeTag);
          if (_mkIdx2 >= 0 && _wIdx < _mkIdx2) {
            state.tags.splice(_wIdx, 1);
            state.tags.splice(_mkIdx2, 0, writeTag);
          }
        }
        // 兼容旧数据：早期版本把月任务完成记录按“具体日期”存（如 2026-09-07），
        // 现在按月份键读取，这些记录会读不到，看起来就是“以前完成的任务消失了”。
        var taskMonthById = {};
        state.monthlyTasks.forEach(function(t) { if (t && t.id) taskMonthById[t.id] = t.monthKey; });
        var normalizedRecords = {};
        var recordsChanged = false;
        Object.keys(state.monthlyRecords).forEach(function(key) {
          var bucket = state.monthlyRecords[key] || {};
          if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
            recordsChanged = true;
            Object.keys(bucket).forEach(function(taskId) {
              if (!bucket[taskId]) return;
              var target = taskMonthById[taskId] || key.slice(0, 7);
              if (!normalizedRecords[target]) normalizedRecords[target] = {};
              normalizedRecords[target][taskId] = true;
            });
            return;
          }
          if (!normalizedRecords[key]) normalizedRecords[key] = {};
          Object.keys(bucket).forEach(function(taskId) {
            if (bucket[taskId]) normalizedRecords[key][taskId] = true;
          });
        });
        state.monthlyRecords = normalizedRecords;
        // Migration is saved only after validation and explicit import.
      }
    } catch (e) { console.error('加载数据失败', e); throw e; }
    ensureTemporaryTag();
  }

  function saveState() {
    if (!window.DailyCloud) { showStatus('同步组件未加载，请保留备份并重新打开网页', true); return false; }
    ensureTemporaryTag();
    var saved = window.DailyCloud.commit(state);
    if (!saved) { showStatus('本机保存未完成，请导出备份后重试', true); return false; }
    state = saved;
    showStatus('已保存在本机'); return true;
  }

  function showStatus(message, failed) {
    var el = document.getElementById('save-status');
    if (el) { el.textContent = message; el.classList.toggle('save-failed', !!failed); }
  }
  var undoSnapshot = null;
  function rememberUndo() {
    undoSnapshot = JSON.stringify(state);
    document.getElementById('undo-btn').hidden = false;
  }
  function generateId() {
    return 'task_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  }

  function getTodayKey() { return formatDateKey(new Date()); }

  function formatDateKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function formatMonthKey(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  function parseDateKey(key) {
    var parts = key.split('-');
    return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  }

  // 日期所在周的周一（周一为一周开端）
  function startOfWeekMonday(date) {
    var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    var weekday = d.getDay();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  }

  function getDaysInMonth(year, month) {
    return new Date(year, month + 1, 0).getDate();
  }

  // 计划待办独立保存，不绑定日期，也不参与每日进度与月历统计。
  function validPlannedTasks(tasks) {
    return tasks === undefined || (Array.isArray(tasks) && tasks.every(function(t) {
      return t && typeof t.id === 'string' && typeof t.name === 'string' &&
        t.name.trim().length > 0 && t.name.length <= 50 &&
        (t.completed === undefined || typeof t.completed === 'boolean');
    }));
  }

  function changePlannedTasks(change) {
    var before = JSON.stringify(state.plannedTasks);
    change();
    if (saveState()) return true;
    state.plannedTasks = JSON.parse(before);
    return false;
  }

  function addPlannedTask(name) {
    name = name.trim();
    if (!name || name.length > 50) return false;
    return changePlannedTasks(function() {
      state.plannedTasks.push({id: generateId(), name: name, completed: false});
    });
  }

  function updatePlannedTask(id, name) {
    var task = state.plannedTasks.find(function(t) { return t.id === id; });
    if (!task) return false;
    if (name !== undefined && (!name.trim() || name.trim().length > 50)) return false;
    return changePlannedTasks(function() {
      if (name === undefined) task.completed = !task.completed;
      else task.name = name.trim();
    });
  }

  function movePlannedTask(id, direction) {
    var index = state.plannedTasks.findIndex(function(t) { return t.id === id; });
    var target = index + (direction === 'up' ? -1 : 1);
    if (index < 0 || target < 0 || target >= state.plannedTasks.length) return false;
    return changePlannedTasks(function() {
      var other = state.plannedTasks[target];
      state.plannedTasks[target] = state.plannedTasks[index];
      state.plannedTasks[index] = other;
    });
  }

  function deletePlannedTask(id) {
    if (!state.plannedTasks.some(function(t) { return t.id === id; })) return false;
    var previousUndo = undoSnapshot;
    rememberUndo();
    if (changePlannedTasks(function() {
      state.plannedTasks = state.plannedTasks.filter(function(t) { return t.id !== id; });
    })) return true;
    undoSnapshot = previousUndo;
    document.getElementById('undo-btn').hidden = !undoSnapshot;
    return false;
  }

  function renderPlannedTasks() {
    var list = document.getElementById('planned-task-list');
    list.innerHTML = '';
    var remaining = state.plannedTasks.filter(function(t) { return !t.completed; }).length;
    document.getElementById('planned-task-count').textContent = remaining + ' 项待办';
    if (!state.plannedTasks.length) {
      var empty = document.createElement('li'); empty.className = 'quiet-empty';
      empty.textContent = '想做但不着急的事，先记在这里。'; list.appendChild(empty);
    }
    state.plannedTasks.forEach(function(task, index) {
      var row = document.createElement('li');
      row.className = 'task-item' + (task.completed ? ' completed' : '');
      row.dataset.taskId = task.id;
      var check = document.createElement('button'); check.type = 'button';
      check.className = 'task-checkbox';
      check.setAttribute('aria-label', (task.completed ? '取消完成：' : '完成计划：') + task.name);
      check.setAttribute('aria-pressed', String(!!task.completed));
      check.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';
      check.addEventListener('click', function() { updatePlannedTask(task.id); renderPlannedTasks(); });
      row.appendChild(check);
      var content = document.createElement('div'); content.className = 'task-content';
      row.appendChild(content);
      if (editingState && editingState.type === 'planned' && editingState.id === task.id) {
        var form = document.createElement('form'); form.className = 'planned-edit-form';
        var input = document.createElement('input'); input.className = 'task-name-input';
        input.type = 'text'; input.value = task.name; input.maxLength = 50; input.required = true;
        input.setAttribute('aria-label', '编辑计划名称');
        var save = document.createElement('button'); save.type = 'submit';
        save.className = 'history-today-btn'; save.textContent = '保存';
        var cancel = document.createElement('button'); cancel.type = 'button';
        cancel.className = 'history-today-btn'; cancel.textContent = '取消';
        function cancelEdit() { editingState = null; renderPlannedTasks(); }
        form.addEventListener('submit', function(e) {
          e.preventDefault();
          if (updatePlannedTask(task.id, input.value)) { editingState = null; renderPlannedTasks(); }
        });
        input.addEventListener('keydown', function(e) { if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } });
        cancel.addEventListener('click', cancelEdit);
        form.appendChild(input); form.appendChild(save); form.appendChild(cancel); content.appendChild(form);
        setTimeout(function() { if (input.isConnected) { input.focus(); input.select(); } }, 0);
      } else {
        var name = document.createElement('span'); name.className = 'task-name'; name.textContent = task.name;
        content.appendChild(name);
        var actions = document.createElement('div'); actions.className = 'task-actions';
        function button(label, text, callback, disabled) {
          var btn = document.createElement('button'); btn.type = 'button';
          btn.className = 'task-action-btn planned-action-btn'; btn.title = label;
          btn.setAttribute('aria-label', label); btn.textContent = text; btn.disabled = !!disabled;
          btn.addEventListener('click', callback); actions.appendChild(btn);
        }
        button('计划上移', '↑', function() { movePlannedTask(task.id, 'up'); renderPlannedTasks(); }, index === 0);
        button('计划下移', '↓', function() { movePlannedTask(task.id, 'down'); renderPlannedTasks(); }, index === state.plannedTasks.length - 1);
        button('编辑计划', '编辑', function() { editingState = {type: 'planned', id: task.id}; renderPlannedTasks(); });
        button('删除计划', '删除', function() {
          if (confirm('删除计划「' + task.name + '」？')) { deletePlannedTask(task.id); renderPlannedTasks(); }
        });
        row.appendChild(actions);
      }
      list.appendChild(row);
    });
  }

  // ===== 每日任务 =====
  function isTaskCompleted(taskId, dateKey) {
    if (!state.records[dateKey]) return false;
    return state.records[dateKey][taskId] === true;
  }

  function getHabitsForDate(dateKey) {
    return state.tasks.filter(function(task) {
      return (!task.createdAt || task.createdAt <= dateKey) && (!task.archivedAt || dateKey <= task.archivedAt);
    });
  }

  function toggleTask(taskId, dateKey) {
    if (!state.records[dateKey]) state.records[dateKey] = {};
    if (state.records[dateKey][taskId]) {
      delete state.records[dateKey][taskId];
      if (Object.keys(state.records[dateKey]).length === 0) delete state.records[dateKey];
    } else {
      state.records[dateKey][taskId] = true;
    }
    saveState();
  }

  function addTask(name) {
    var before = DailySync.clone(state);
    state.tasks.push({ id: generateId(), name: name, createdAt: getTodayKey() });
    if (!saveState()) { state = before; return false; }
    return true;
  }

  function deleteTask(taskId) {
    rememberUndo();
    var task = state.tasks.find(function(t) { return t.id === taskId; });
    if (task) task.archivedAt = getTodayKey();
    saveState();
  }

  function renameTask(taskId, newName) {
    var task = state.tasks.find(function(t) { return t.id === taskId; });
    if (task) { task.name = newName; saveState(); }
  }

  function moveTask(taskId, direction) {
    var activeTasks = state.tasks.filter(function(t) { return !t.archivedAt; });
    var idx = activeTasks.findIndex(function(t) { return t.id === taskId; });
    if (idx === -1) return;
    var targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= activeTasks.length) return;
    var sourceIndex = state.tasks.indexOf(activeTasks[idx]);
    var targetIndex = state.tasks.indexOf(activeTasks[targetIdx]);
    var tmp = state.tasks[sourceIndex];
    state.tasks[sourceIndex] = state.tasks[targetIndex];
    state.tasks[targetIndex] = tmp;
    saveState();
  }

  // ===== 每月任务 =====
  function isMonthlyTaskCompleted(taskId, monthKey) {
    if (!state.monthlyRecords[monthKey]) return false;
    return state.monthlyRecords[monthKey][taskId] === true;
  }

  function toggleMonthlyTask(taskId, monthKey) {
    if (!state.monthlyRecords[monthKey]) state.monthlyRecords[monthKey] = {};
    if (state.monthlyRecords[monthKey][taskId]) {
      delete state.monthlyRecords[monthKey][taskId];
      if (Object.keys(state.monthlyRecords[monthKey]).length === 0) delete state.monthlyRecords[monthKey];
    } else {
      state.monthlyRecords[monthKey][taskId] = true;
    }
    saveState();
  }

  function addMonthlyTask(name, dateKey, category) {
    var before = DailySync.clone(state);
    var d = parseDateKey(dateKey);
    var cat = category || '';
    var taskId = generateId();
    state.monthlyTasks.push({
      id: taskId,
      name: name,
      monthKey: formatMonthKey(d),
      date: dateKey,
      category: cat,
      createdAt: getTodayKey()
    });
    if (!saveState()) { state = before; return false; }
    return true;
  }

  // 布置作业：在目标日期创建同名"写作业"任务，截止日为原作业日期
  function assignHomework(homeworkTask, targetDateKey) {
    var exists = state.monthlyTasks.some(function(t) {
      return t.date === targetDateKey && t.category === '写作业' && t.name === homeworkTask.name;
    });
    if (exists) return false;
    var d = parseDateKey(targetDateKey);
    state.monthlyTasks.push({
      id: generateId(),
      name: homeworkTask.name,
      monthKey: formatMonthKey(d),
      date: targetDateKey,
      category: '写作业',
      deadline: homeworkTask.date,
      createdAt: getTodayKey()
    });
    saveState();
    return true;
  }

  function deleteMonthlyTask(taskId) {
    rememberUndo();
    state.monthlyTasks = state.monthlyTasks.filter(function(t) { return t.id !== taskId; });
    Object.keys(state.monthlyRecords).forEach(function(mk) {
      if (state.monthlyRecords[mk][taskId]) {
        delete state.monthlyRecords[mk][taskId];
        if (Object.keys(state.monthlyRecords[mk]).length === 0) delete state.monthlyRecords[mk];
      }
    });
    saveState();
  }

  function renameMonthlyTask(taskId, newName) {
    var task = state.monthlyTasks.find(function(t) { return t.id === taskId; });
    if (task) { task.name = newName; saveState(); }
  }

  function moveMonthlyTask(taskId, direction) {
    var task = state.monthlyTasks.find(function(t) { return t.id === taskId; });
    if (!task) return;
    var completed = isMonthlyTaskCompleted(task.id, task.monthKey);
    var list = getTasksByDate(task.date).filter(function(item) {
      return item.category === task.category && isMonthlyTaskCompleted(item.id, item.monthKey) === completed;
    });
    var idx = list.findIndex(function(t) { return t.id === taskId; });
    if (idx === -1) return;
    var targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    var allIdx1 = state.monthlyTasks.indexOf(list[idx]);
    var allIdx2 = state.monthlyTasks.indexOf(list[targetIdx]);
    var tmp = state.monthlyTasks[allIdx1];
    state.monthlyTasks[allIdx1] = state.monthlyTasks[allIdx2];
    state.monthlyTasks[allIdx2] = tmp;
    saveState();
  }

  function moveMonthlyTaskToDate(taskId, dateKey) {
    var task = state.monthlyTasks.find(function(t) { return t.id === taskId; });
    if (task) {
      var d = parseDateKey(dateKey);
      var completed = isMonthlyTaskCompleted(task.id, task.monthKey);
      if (state.monthlyRecords[task.monthKey]) delete state.monthlyRecords[task.monthKey][task.id];
      task.date = dateKey;
      task.monthKey = formatMonthKey(d);
      if (completed) {
        if (!state.monthlyRecords[task.monthKey]) state.monthlyRecords[task.monthKey] = {};
        state.monthlyRecords[task.monthKey][task.id] = true;
      }
      saveState();
    }
  }

  // 复制生成独立的单次任务，不携带完成记录。
  function copyTaskToDate(taskId, type, dateKey) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || formatDateKey(parseDateKey(dateKey)) !== dateKey) return false;
    var source = (type === 'daily' ? state.tasks : state.monthlyTasks).find(function(t) { return t.id === taskId; });
    if (!source) return false;
    var copy = {
      id: generateId(), name: source.name, date: dateKey,
      monthKey: dateKey.slice(0, 7), category: source.category || '', createdAt: getTodayKey()
    };
    state.monthlyTasks.push(copy);
    if (!saveState()) {
      state.monthlyTasks = state.monthlyTasks.filter(function(t) { return t.id !== copy.id; });
      return false;
    }
    return copy;
  }

  var copySource = null;
  function openCopyDialog(task, type) {
    copySource = {id: task.id, type: type};
    var tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('copy-task-name').textContent = task.name;
    document.getElementById('copy-date').value = formatDateKey(tomorrow);
    document.getElementById('copy-note').textContent = type === 'daily'
      ? '将此习惯复制为所选日期的单次任务，副本为未完成。'
      : '保留名称和标签，副本为未完成，原任务保持不变。';
    document.getElementById('copy-error').textContent = '';
    document.getElementById('copy-dialog').showModal();
    document.getElementById('copy-date').focus();
  }

  function getTasksByDate(dateKey) {
    return state.monthlyTasks.filter(function(t) { return t.date === dateKey; });
  }

  function getTaskCountByDate(dateKey) {
    return getTasksByDate(dateKey).length;
  }

  // 获取从今日起往后7天（含今天）的月任务，自动跨月查询
  function getUpcomingWeekTasks() {
    var todayKey = getTodayKey();
    var today = parseDateKey(todayKey);
    var endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6);
    var endKey = formatDateKey(endDate);
    var result = [];

    // 纳入：未来7天内的所有任务 + 已过期且未完成的任务
    state.monthlyTasks.forEach(function(t) {
      var completed = isMonthlyTaskCompleted(t.id, t.monthKey);
      var inWindow = t.date >= todayKey && t.date <= endKey;
      var overdue = t.date < todayKey && !completed;
      if (inWindow || overdue) {
        result.push({
          source: 'monthly',
          task: t,
          dateKey: t.date,
          completed: completed
        });
      }
    });

    // 排序：未完成置顶、已完成沉底；未完成区内过期优先；其次按标签列表顺序；同类按日期升序
    function categoryRank(cat) { return getTagRank(cat); }
    result.sort(function(a, b) {
      var aDone = a.completed ? 1 : 0;
      var bDone = b.completed ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      var aTemporary = a.task.category === TEMPORARY_TAG ? 0 : 1;
      var bTemporary = b.task.category === TEMPORARY_TAG ? 0 : 1;
      if (aTemporary !== bTemporary) return aTemporary - bTemporary;
      var aOverdue = (!a.completed && a.dateKey < todayKey) ? 0 : 1;
      var bOverdue = (!b.completed && b.dateKey < todayKey) ? 0 : 1;
      if (aOverdue !== bOverdue) return aOverdue - bOverdue;
      var aCat = categoryRank(a.task.category);
      var bCat = categoryRank(b.task.category);
      if (aCat !== bCat) return aCat - bCat;
      return a.dateKey < b.dateKey ? -1 : (a.dateKey > b.dateKey ? 1 : 0);
    });

    return result;
  }

  // ===== 路由 =====
  var currentRoute = 'today';

  function navigate(route) {
    currentRoute = route;
    location.hash = route;
    if (route === 'monthly') needScrollToToday = true;
    render();
  }

  function handleHashChange() {
    var hash = location.hash.replace('#', '') || 'today';
    if (hash === 'today' || hash === 'monthly' || hash === 'stats') {
      currentRoute = hash;
      render();
    }
  }

  // ===== 创建任务项 DOM =====
  // ===== 标签管理 =====
  var TAG_PALETTE = ['#C0392B','#27AE60','#2980B9','#8E44AD','#D35400','#16A085','#F39C12','#7F8C8D'];
  var selectedTag = '';
  function getTagColor(name) {
    if (!name) return null;
    var t = state.tags.find(function(x) { return x.name === name; });
    return t ? t.color : null;
  }
  function getTagRank(name) {
    if (name === TEMPORARY_TAG) return -1;
    if (!name) return 999;
    var idx = state.tags.findIndex(function(x) { return x.name === name; });
    return idx >= 0 ? idx : 998;
  }
  function addTag(name) {
    name = (name || '').trim();
    if (!name) return false;
    if (state.tags.some(function(t) { return t.name === name; })) return false;
    state.tags.push({name: name, color: TAG_PALETTE[state.tags.length % TAG_PALETTE.length]});
    saveState();
    return true;
  }
  function removeTag(name) {
    if (name === TEMPORARY_TAG) return;
    state.tags = state.tags.filter(function(t) { return t.name !== name; });
    state.monthlyTasks.forEach(function(t) { if (t.category === name) t.category = ''; });
    saveState();
  }
  function moveTag(name, dir) {
    if (name === TEMPORARY_TAG) return;
    var idx = state.tags.findIndex(function(t) { return t.name === name; });
    if (idx < 0) return;
    var ni = idx + dir;
    if (ni < 0 || ni >= state.tags.length) return;
    if (state.tags[ni].name === TEMPORARY_TAG) return;
    var tmp = state.tags[idx]; state.tags[idx] = state.tags[ni]; state.tags[ni] = tmp;
    saveState();
  }
  function updateTagSelectorBtn() {
    var btn = document.getElementById('tag-selector-btn');
    if (!btn) return;
    var label = btn.querySelector('.tag-selector-label');
    if (selectedTag) {
      label.textContent = selectedTag;
      label.style.color = getTagColor(selectedTag) || '';
    } else {
      label.textContent = '无标签';
      label.style.color = '';
    }
  }
  function renderTagDropdown() {
    var dd = document.getElementById('tag-dropdown');
    if (!dd) return;
    dd.innerHTML = '';
    var noneOpt = document.createElement('div');
    noneOpt.className = 'tag-dropdown-item' + (selectedTag === '' ? ' active' : '');
    noneOpt.textContent = '无标签';
    noneOpt.addEventListener('click', function() { selectedTag = ''; updateTagSelectorBtn(); dd.style.display = 'none'; });
    dd.appendChild(noneOpt);
    state.tags.forEach(function(t) {
      if (t.name === '写作业') return;
      var opt = document.createElement('div');
      opt.className = 'tag-dropdown-item' + (selectedTag === t.name ? ' active' : '');
      var dot = document.createElement('span'); dot.className = 'tag-dot'; dot.style.backgroundColor = t.color;
      var txt = document.createElement('span'); txt.textContent = t.name;
      opt.appendChild(dot); opt.appendChild(txt);
      opt.addEventListener('click', function() { selectedTag = t.name; updateTagSelectorBtn(); dd.style.display = 'none'; });
      dd.appendChild(opt);
    });
  }
  function renderTagManagePanel() {
    var p = document.getElementById('tag-manage-panel');
    if (!p) return;
    p.innerHTML = '';
    state.tags.forEach(function(t, i) {
      if (t.name === '写作业') return;
      var row = document.createElement('div'); row.className = 'tag-manage-row';
      var dot = document.createElement('span'); dot.className = 'tag-dot'; dot.style.backgroundColor = t.color;
      var nm = document.createElement('span'); nm.className = 'tag-manage-name'; nm.textContent = t.name;
      var up = document.createElement('button'); up.type='button'; up.className='tag-manage-btn-sm'; up.textContent='↑'; up.title='上移'; up.disabled = i <= 1;
      up.addEventListener('click', function() { moveTag(t.name,-1); renderTagManagePanel(); renderMonthly(); });
      var dn = document.createElement('button'); dn.type='button'; dn.className='tag-manage-btn-sm'; dn.textContent='↓'; dn.title='下移'; dn.disabled = t.name === TEMPORARY_TAG || i===state.tags.length-1;
      dn.addEventListener('click', function() { moveTag(t.name,1); renderTagManagePanel(); renderMonthly(); });
      var del = document.createElement('button'); del.type='button'; del.className='tag-manage-btn-sm tag-delete'; del.textContent='×'; del.title='删除标签';
      if (t.name === TEMPORARY_TAG) { del.disabled = true; up.title = dn.title = del.title = '临时任务为固定置顶标签'; }
      del.addEventListener('click', function() {
        if (confirm('删除标签「' + t.name + '」？使用该标签的任务将变为无标签。')) {
          removeTag(t.name);
          if (selectedTag === t.name) { selectedTag = ''; updateTagSelectorBtn(); }
          renderTagManagePanel(); renderTagDropdown(); renderMonthly();
        }
      });
      row.appendChild(dot); row.appendChild(nm); row.appendChild(up); row.appendChild(dn); row.appendChild(del);
      p.appendChild(row);
    });
    var addRow = document.createElement('div'); addRow.className = 'tag-manage-add-row';
    var inp = document.createElement('input'); inp.type='text'; inp.className='tag-manage-input'; inp.placeholder='输入新标签名'; inp.maxLength=10;
    var addBtn = document.createElement('button'); addBtn.type='button'; addBtn.className='tag-manage-add-btn'; addBtn.textContent='添加';
    function doAdd() {
      var v = inp.value.trim();
      if (v && addTag(v)) { inp.value=''; renderTagManagePanel(); renderTagDropdown(); renderMonthly(); }
    }
    addBtn.addEventListener('click', doAdd);
    inp.addEventListener('keydown', function(e) { if (e.key==='Enter') { e.preventDefault(); doAdd(); } });
    addRow.appendChild(inp); addRow.appendChild(addBtn);
    p.appendChild(addRow);
  }

  function createTaskElement(task, type, completed, isFirst, isLast) {
    var li = document.createElement('li');
    li.className = 'task-item' + (completed ? ' completed' : '');
    li.dataset.taskId = task.id;

    var isEditing = editingState && editingState.type === type && editingState.id === task.id;
    if (isEditing) li.classList.add('editing');

    var checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.setAttribute('aria-label', '完成任务：' + task.name);
    checkbox.setAttribute('aria-pressed', String(completed));
    checkbox.className = 'task-checkbox';
    checkbox.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    checkbox.addEventListener('click', function() {
      if (type === 'daily') { toggleTask(task.id, getTodayKey()); render(); }
      else { var latest = state.monthlyTasks.find(function(t) { return t.id === task.id; }); if (!latest) return; toggleMonthlyTask(task.id, latest.monthKey); render(); }
    });

    var content = document.createElement('div');
    content.className = 'task-content';

    if (isEditing) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'task-name-input';
      input.value = task.name;
      input.maxLength = 50;
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          var val = input.value.trim();
          if (val) {
            if (type === 'daily') renameTask(task.id, val);
            else renameMonthlyTask(task.id, val);
          }
          editingState = null;
          render();
        } else if (e.key === 'Escape') {
          editingState = null;
          render();
        }
      });
      input.addEventListener('blur', function() {
        var val = input.value.trim();
        if (val && val !== task.name) {
          if (type === 'daily') renameTask(task.id, val);
          else renameMonthlyTask(task.id, val);
        }
        editingState = null;
        render();
      });
      content.appendChild(input);
      setTimeout(function() { input.focus(); input.select(); }, 0);
    } else {
      // 自定义标签
      if (type === 'monthly' && task.category) {
        var tagColor = getTagColor(task.category);
        if (tagColor) {
          var badge = document.createElement('span');
          badge.className = 'task-badge custom-tag';
          badge.style.backgroundColor = tagColor + '1A';
          badge.style.color = tagColor;
          badge.style.borderColor = tagColor + '55';
          badge.textContent = task.category;
          content.appendChild(badge);
        }
      }
      // 已过期标签（超过设定日期仍未完成）
      if (type === 'monthly' && currentRoute === 'today') {
        var dateBadge = document.createElement('span');
        dateBadge.className = 'task-badge date-badge';
        var taskDate = parseDateKey(task.date);
        dateBadge.textContent = (taskDate.getMonth() + 1) + '/' + taskDate.getDate();
        dateBadge.title = task.date;
        content.appendChild(dateBadge);
      }
      if (type === 'monthly' && !completed && task.date && task.date < getTodayKey()) {
        var overdueBadge = document.createElement('span');
        overdueBadge.className = 'task-badge overdue';
        overdueBadge.textContent = '已过期';
        content.appendChild(overdueBadge);
      }
      var name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = task.name;
      name.title = '双击编辑名称';
      name.addEventListener('dblclick', function() {
        editingState = { type: type, id: task.id };
        render();
      });
      content.appendChild(name);
    }

    if (!isEditing) {
      var actions = document.createElement('div');
      actions.className = 'task-actions';

      var upBtn = document.createElement('button');
      upBtn.className = 'task-action-btn';
      upBtn.setAttribute('aria-label', '上移');
      upBtn.disabled = isFirst;
      upBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"></polyline></svg>';
      upBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (type === 'daily') { moveTask(task.id, 'up'); render(); }
        else { moveMonthlyTask(task.id, 'up'); render(); }
      });

      var downBtn = document.createElement('button');
      downBtn.className = 'task-action-btn';
      downBtn.setAttribute('aria-label', '下移');
      downBtn.disabled = isLast;
      downBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"></polyline></svg>';
      downBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (type === 'daily') { moveTask(task.id, 'down'); render(); }
        else { moveMonthlyTask(task.id, 'down'); render(); }
      });

      var editBtn = document.createElement('button');
      editBtn.className = 'task-action-btn';
      editBtn.setAttribute('aria-label', '编辑名称');
      editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>';
      editBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        editingState = { type: type, id: task.id };
        render();
      });

      // 每月任务且未完成时显示"移动到"按钮
      if (type === 'monthly' && !completed) {
        var moveBtn = document.createElement('button');
        moveBtn.className = 'task-action-btn';
        moveBtn.setAttribute('aria-label', '移动到其他日期');
        moveBtn.dataset.moveBtn = '1';
        moveBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>';
        moveBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (moveMenuState && moveMenuState.taskId === task.id) {
            moveMenuState = null;
          } else {
            moveMenuState = { taskId: task.id, monthOffset: 0 };
          }
          render();
        });
        actions.appendChild(moveBtn);
      }

      var delBtn = document.createElement('button');
      delBtn.className = 'task-delete';
      delBtn.setAttribute('aria-label', type === 'daily' ? '删除习惯' : '删除任务');
      delBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      delBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (confirm(type === 'daily' ? '从每日列表删除习惯「' + task.name + '」？历史打卡会保留。' : '确定删除任务「' + task.name + '」吗？')) {
          if (type === 'daily') deleteTask(task.id);
          else deleteMonthlyTask(task.id);
          if (editingState && editingState.id === task.id) editingState = null;
          render();
        }
      });

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(editBtn);
      var copyBtn = document.createElement('button');
      copyBtn.type = 'button'; copyBtn.className = 'task-action-btn';
      copyBtn.setAttribute('aria-label', '复制任务'); copyBtn.title = '复制任务';
      copyBtn.innerHTML = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V4H4v12h4"></path></svg>';
      copyBtn.addEventListener('click', function(e) { e.stopPropagation(); openCopyDialog(task, type); });
      actions.appendChild(copyBtn);
      // 作业标签：布置按钮
      if (type === 'monthly' && task.category === '作业') {
        var assignBtn = document.createElement('button');
        assignBtn.type = 'button';
        assignBtn.className = 'task-action-btn assign-btn';
        assignBtn.textContent = '布置';
        assignBtn.title = '布置为"写作业"任务，选择完成日期';
        assignBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (assignMenuState && assignMenuState.taskId === task.id) {
            assignMenuState = null;
          } else {
            moveMenuState = null;
            assignMenuState = { taskId: task.id, monthOffset: 0 };
          }
          render();
        });
        actions.appendChild(assignBtn);
      }
      // 写作业标签：截止日按钮
      if (type === 'monthly' && task.category === '写作业') {
        var deadlineBtn = document.createElement('button');
        deadlineBtn.type = 'button';
        deadlineBtn.className = 'task-action-btn deadline-btn';
        deadlineBtn.textContent = '截止日';
        if (task.deadline) {
          var _dparsed = parseDateKey(task.deadline);
          deadlineBtn.title = '截止日：' + (_dparsed.getMonth()+1) + '月' + _dparsed.getDate() + '日（点击查看）';
        } else {
          deadlineBtn.title = '无截止日';
        }
        deadlineBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (task.deadline) {
            currentDate = task.deadline;
            var _dp = parseDateKey(task.deadline);
            viewMonth = new Date(_dp.getFullYear(), _dp.getMonth(), 1);
            assignMenuState = null;
            moveMenuState = null;
            render();
          }
        });
        actions.appendChild(deadlineBtn);
      }
      actions.appendChild(delBtn);

      li.appendChild(checkbox);
      li.appendChild(content);
      li.appendChild(actions);

      // 渲染移动到菜单（mini 日历）
      if (type === 'monthly' && moveMenuState && moveMenuState.taskId === task.id) {
        var menu = document.createElement('div');
        menu.className = 'move-menu';
        menu.dataset.moveMenu = '1';

        var menuYear = viewMonth.getFullYear();
        var menuMonth = viewMonth.getMonth() + (moveMenuState.monthOffset || 0);
        var menuDate = new Date(menuYear, menuMonth, 1);
        var mY = menuDate.getFullYear();
        var mM = menuDate.getMonth();
        var daysInMonth = getDaysInMonth(mY, mM);
        var firstDay = new Date(mY, mM, 1).getDay();
        var firstDayOffset = firstDay === 0 ? 6 : firstDay - 1;

        var header = document.createElement('div');
        header.className = 'move-menu-header';

        var prevBtn = document.createElement('button');
        prevBtn.className = 'move-menu-nav-btn';
        prevBtn.textContent = '‹';
        prevBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          moveMenuState.monthOffset = (moveMenuState.monthOffset || 0) - 1;
          render();
        });

        var monthLabel = document.createElement('span');
        monthLabel.className = 'move-menu-month';
        monthLabel.textContent = mY + '年' + (mM + 1) + '月';

        var nextBtn = document.createElement('button');
        nextBtn.className = 'move-menu-nav-btn';
        nextBtn.textContent = '›';
        nextBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          moveMenuState.monthOffset = (moveMenuState.monthOffset || 0) + 1;
          render();
        });

        var navDiv = document.createElement('div');
        navDiv.className = 'move-menu-nav';
        navDiv.appendChild(prevBtn);
        navDiv.appendChild(monthLabel);
        navDiv.appendChild(nextBtn);

        var label = document.createElement('span');
        label.className = 'move-menu-label';
        label.textContent = '移到';

        header.appendChild(label);
        header.appendChild(navDiv);
        menu.appendChild(header);

        var grid = document.createElement('div');
        grid.className = 'move-menu-grid';

        // 星期标题
        for (var w = 0; w < 7; w++) {
          var wd = document.createElement('div');
          wd.style.cssText = 'font-size:0.6rem;color:var(--text-muted);text-align:center;padding:2px 0;';
          wd.textContent = WEEKDAY_LABELS[w];
          grid.appendChild(wd);
        }

        // 前置空格（周一开头）
        for (var b = 0; b < firstDayOffset; b++) {
          var blank = document.createElement('div');
          blank.className = 'move-menu-day other-month';
          grid.appendChild(blank);
        }

        // 日期
        for (var dd = 1; dd <= daysInMonth; dd++) {
          (function(dayNum) {
            var dayBtn = document.createElement('button');
            dayBtn.type = 'button';
            dayBtn.className = 'move-menu-day';
            var thisDateKey = mY + '-' + String(mM + 1).padStart(2, '0') + '-' + String(dayNum).padStart(2, '0');
            if (task.date === thisDateKey) dayBtn.classList.add('current');
            dayBtn.textContent = dayNum;
            dayBtn.title = '移动到' + (mM + 1) + '月' + dayNum + '日';
            dayBtn.addEventListener('click', function(e) {
              e.stopPropagation();
              moveMonthlyTaskToDate(task.id, thisDateKey);
              moveMenuState = null;
              currentDate = thisDateKey;
              viewMonth = new Date(mY, mM, 1);
              render();
            });
            grid.appendChild(dayBtn);
          })(dd);
        }

        menu.appendChild(grid);
        li.appendChild(menu);
      }
      // 渲染布置菜单（迷你日历）
      if (type === 'monthly' && assignMenuState && assignMenuState.taskId === task.id) {
        var amenu = document.createElement('div');
        amenu.className = 'move-menu assign-menu';
        amenu.dataset.moveMenu = '1';

        var aBaseYear = viewMonth.getFullYear();
        var aBaseMonth = viewMonth.getMonth() + (assignMenuState.monthOffset || 0);
        var aDate0 = new Date(aBaseYear, aBaseMonth, 1);
        var aY = aDate0.getFullYear();
        var aM = aDate0.getMonth();
        var aDays = getDaysInMonth(aY, aM);
        var aFirst = new Date(aY, aM, 1).getDay();
        var aOff = aFirst === 0 ? 6 : aFirst - 1;

        var aHeader = document.createElement('div');
        aHeader.className = 'move-menu-header';
        var aPrev = document.createElement('button');
        aPrev.className = 'move-menu-nav-btn'; aPrev.textContent = '‹';
        aPrev.addEventListener('click', function(e) {
          e.stopPropagation();
          assignMenuState.monthOffset = (assignMenuState.monthOffset || 0) - 1;
          render();
        });
        var aMLabel = document.createElement('span');
        aMLabel.className = 'move-menu-month';
        aMLabel.textContent = aY + '年' + (aM + 1) + '月';
        var aNext = document.createElement('button');
        aNext.className = 'move-menu-nav-btn'; aNext.textContent = '›';
        aNext.addEventListener('click', function(e) {
          e.stopPropagation();
          assignMenuState.monthOffset = (assignMenuState.monthOffset || 0) + 1;
          render();
        });
        var aNav = document.createElement('div');
        aNav.className = 'move-menu-nav';
        var aTag = document.createElement('span');
        aTag.className = 'move-menu-label'; aTag.textContent = '布置到';
        aNav.appendChild(aPrev); aNav.appendChild(aMLabel); aNav.appendChild(aNext);
        aHeader.appendChild(aTag); aHeader.appendChild(aNav);
        amenu.appendChild(aHeader);

        var aGrid = document.createElement('div');
        aGrid.className = 'move-menu-grid';
        for (var aw = 0; aw < 7; aw++) {
          var awd = document.createElement('div');
          awd.style.cssText = 'font-size:0.6rem;color:var(--text-muted);text-align:center;padding:2px 0;';
          awd.textContent = WEEKDAY_LABELS[aw];
          aGrid.appendChild(awd);
        }
        for (var ab = 0; ab < aOff; ab++) {
          var ablank = document.createElement('div');
          ablank.className = 'move-menu-day other-month';
          aGrid.appendChild(ablank);
        }
        for (var add = 1; add <= aDays; add++) {
          (function(dayNum) {
            var adayBtn = document.createElement('button');
            adayBtn.type = 'button';
            adayBtn.className = 'move-menu-day';
            var aKey = aY + '-' + String(aM+1).padStart(2,'0') + '-' + String(dayNum).padStart(2,'0');
            var already = state.monthlyTasks.some(function(t) {
              return t.date === aKey && t.category === '写作业' && t.name === task.name;
            });
            if (already) adayBtn.classList.add('current');
            if (task.date === aKey) adayBtn.classList.add('deadline-mark');
            adayBtn.textContent = dayNum;
            adayBtn.title = (already ? '已布置 · ' : '布置到 ') + (aM+1) + '月' + dayNum + '日';
            adayBtn.addEventListener('click', function(e) {
              e.stopPropagation();
              if (already) { assignMenuState = null; render(); return; }
              assignHomework(task, aKey);
              assignMenuState = null;
              currentDate = aKey;
              var _nd = parseDateKey(aKey);
              viewMonth = new Date(_nd.getFullYear(), _nd.getMonth(), 1);
              render();
            });
            aGrid.appendChild(adayBtn);
          })(add);
        }
        amenu.appendChild(aGrid);
        li.appendChild(amenu);
      }
    } else {
      li.appendChild(checkbox);
      li.appendChild(content);
      var hint = document.createElement('span');
      hint.className = 'edit-hint';
      hint.textContent = '回车保存';
      li.appendChild(hint);
    }

    return li;
  }

  // ===== 渲染：待办 =====
  function renderToday() {
    var today = new Date(), key = getTodayKey();
    document.getElementById('today-date').textContent = today.getFullYear() + '年' + (today.getMonth()+1) + '月' + today.getDate() + '日';
    document.getElementById('today-weekday').textContent = ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][today.getDay()];
    var temporary = state.monthlyTasks.filter(function(t) { return t.category === TEMPORARY_TAG; });
    var pending = temporary.filter(function(t) { return !isMonthlyTaskCompleted(t.id, t.monthKey); }).sort(function(a,b) { return a.date.localeCompare(b.date); });
    var scheduled = temporary.filter(function(t) { return t.date === key; });
    var overdue = state.monthlyTasks.filter(function(t) { return t.category !== TEMPORARY_TAG && t.date < key && !isMonthlyTaskCompleted(t.id,t.monthKey); }).sort(function(a,b) { return a.date.localeCompare(b.date); });
    function fill(id, tasks, type, empty) {
      var list = document.getElementById(id); list.innerHTML = '';
      if (!tasks.length) { var row = document.createElement('li'); row.className = 'quiet-empty'; row.textContent = empty; list.appendChild(row); }
      tasks.forEach(function(t) {
        var done = isMonthlyTaskCompleted(t.id,t.monthKey);
        var sortable = id !== 'today-overdue-list';
        var group = tasks.filter(function(item) { return item.date === t.date; });
        var index = group.indexOf(t);
        list.appendChild(createTaskElement(t,type,done,!sortable || index === 0,!sortable || index === group.length - 1));
      });
    }
    fill('today-scheduled-list',pending,'monthly','暂无临时任务，临时想到的事可以直接添加。');
    document.getElementById('temporary-task-count').textContent = pending.length + ' 项待办';
    renderPlannedTasks();
    fill('today-overdue-list',overdue,'monthly','没有其他逾期任务。');
    var completed = scheduled.filter(function(t) { return isMonthlyTaskCompleted(t.id,t.monthKey); }).length;
    var total = scheduled.length, percent = total ? Math.round(completed / total * 100) : 0;
    document.getElementById('today-progress-fill').style.width = percent + '%';
    document.getElementById('today-progress-text').textContent = '今日临时任务已完成 ' + completed + ' / ' + total + ' 项 · 共 ' + pending.length + ' 项临时任务待处理';
  }

  // ===== 渲染：每月 =====
  function renderMonthly() {
    document.getElementById('add-date-label').textContent = '添加到 ' + currentDate;
    document.getElementById('add-monthly-input').placeholder = '添加任务到 ' + currentDate;
    document.getElementById('month-label').textContent = '任务日历';

    var todayKey = getTodayKey();
    var weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

    // ===== 渲染连续滚动周历（跨月衔接，周一开头）=====
    var calEl = document.getElementById('calendar-with-weeks');
    var prevScroll = calEl.scrollTop;
    calEl.innerHTML = '';

    // 星期标题（吸顶）
    WEEKDAY_LABELS.forEach(function(w) {
      var wd = document.createElement('div');
      wd.className = 'calendar-weekday-mini';
      wd.textContent = w;
      calEl.appendChild(wd);
    });

    // 默认以今天所在周为基准向前 4 周、向后 14 周；
    // 但渲染范围会自动扩展到所有已记录任务的日期，否则时间一推移，
    // 更早的周就滚出可视区，看起来像“以前日期记录的任务消失了”。
    var todayParsed = parseDateKey(todayKey);
    var thisMonday = startOfWeekMonday(todayParsed);
    var WEEKS_BEFORE = 4, WEEKS_AFTER = 14;

    var firstDate = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() - WEEKS_BEFORE * 7);
    var lastDate = new Date(thisMonday.getFullYear(), thisMonday.getMonth(), thisMonday.getDate() + WEEKS_AFTER * 7 + 6);
    state.monthlyTasks.forEach(function(t) {
      if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return;
      var d = parseDateKey(t.date);
      if (d < firstDate) firstDate = d;
      if (d > lastDate) lastDate = d;
    });

    var startMonday = startOfWeekMonday(firstDate);
    var endMonday = startOfWeekMonday(lastDate);
    var MAX_WEEKS = 530; // 约 10 年，防止异常日期把日历撑爆
    var totalWeeks = Math.round(
      (Date.UTC(endMonday.getFullYear(), endMonday.getMonth(), endMonday.getDate()) -
       Date.UTC(startMonday.getFullYear(), startMonday.getMonth(), startMonday.getDate())) / 604800000
    ) + 1;
    if (totalWeeks > MAX_WEEKS) {
      startMonday = new Date(endMonday.getFullYear(), endMonday.getMonth(), endMonday.getDate() - (MAX_WEEKS - 1) * 7);
      totalWeeks = MAX_WEEKS;
    }

    var lastMonth = -1, lastMonthYear = -1;
    for (var w = 0; w < totalWeeks; w++) {
      var weekMonday = new Date(startMonday.getFullYear(), startMonday.getMonth(), startMonday.getDate() + w * 7);

      // 月份归属：一周跨两个月时，按“多数天”所属的月份归组。
      // 任意连续 7 天里第 4 天一定落在天数更多的那一侧，所以取本周周四来判断。
      var weekAnchor = new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() + 3);
      var anchorMonth = weekAnchor.getMonth();
      var anchorYear = weekAnchor.getFullYear();
      if (anchorMonth !== lastMonth || anchorYear !== lastMonthYear) {
        lastMonth = anchorMonth;
        lastMonthYear = anchorYear;
        var divider = document.createElement('div');
        divider.className = 'calendar-month-divider';
        divider.textContent = anchorYear + '年' + (anchorMonth + 1) + '月';
        calEl.appendChild(divider);
      }

      // 本周7天
      for (var col = 0; col < 7; col++) {
        (function(d) {
          var dateKey = formatDateKey(d);
          var cell = document.createElement('div');
          cell.className = 'calendar-cell-mini';
          if (dateKey === todayKey) cell.classList.add('today');
          if (dateKey === currentDate) cell.classList.add('selected');

          var count = getTaskCountByDate(dateKey);
          var dayTasks = getTasksByDate(dateKey);
          // 作业
          var homeworkTasks = dayTasks.filter(function(t) { return t.category === '作业'; });
          var hasHomework = homeworkTasks.length > 0;
          var homeworkAllDone = hasHomework && homeworkTasks.every(function(t) {
            return isMonthlyTaskCompleted(t.id, t.monthKey);
          });
          // 考试
          var examTasks = dayTasks.filter(function(t) { return t.category === '考试'; });
          var hasExam = examTasks.length > 0;
          var examAllDone = hasExam && examTasks.every(function(t) {
            return isMonthlyTaskCompleted(t.id, t.monthKey);
          });
          // 同日两类任务分别标色：左侧作业，右侧考试。
          if (hasHomework) cell.classList.add(homeworkAllDone ? 'homework-done' : 'homework-pending');
          if (hasExam) cell.classList.add(examAllDone ? 'exam-done' : 'exam-pending');
          if (hasHomework && hasExam) cell.classList.add('split-task-colors');

          cell.innerHTML =
            '<span class="calendar-day-num-mini">' + d.getDate() + '</span>' +
            (count > 0 ? '<span class="calendar-dot-mini"></span>' : '');

          var titleText = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + weekdays[d.getDay()];
          if (hasExam) titleText += examAllDone ? ' · 考试已完成' : ' · 有考试待完成';
          if (hasHomework) titleText += homeworkAllDone ? ' · 作业已完成' : ' · 有作业待完成';
          if (count > 0) titleText += ' · ' + count + '个任务';
          cell.title = titleText;

          cell.dataset.dateKey = dateKey;
          cell.addEventListener('click', function() {
            currentDate = this.dataset.dateKey;
            moveMenuState = null;
            renderMonthly();
          });

          calEl.appendChild(cell);
        })(new Date(weekMonday.getFullYear(), weekMonday.getMonth(), weekMonday.getDate() + col));
      }
    }

    // 恢复滚动位置；首次进入则滚到今天
    calEl.scrollTop = prevScroll;
    if (needScrollToToday) {
      var todayCell = calEl.querySelector('.calendar-cell-mini.today');
      if (todayCell) {
        var cellRect = todayCell.getBoundingClientRect();
        var calRect = calEl.getBoundingClientRect();
        calEl.scrollTop += cellRect.top - calRect.top - calEl.clientHeight / 2 + cellRect.height / 2;
      }
      needScrollToToday = false;
    }
    if (pendingScrollDate) {
      var pendingCell = calEl.querySelector('.calendar-cell-mini[data-date-key="' + pendingScrollDate + '"]');
      if (pendingCell) {
        var pendingRect = pendingCell.getBoundingClientRect();
        var calBox = calEl.getBoundingClientRect();
        calEl.scrollTop += pendingRect.top - calBox.top - calEl.clientHeight / 2 + pendingRect.height / 2;
      }
      pendingScrollDate = null;
    }

    // ===== 渲染待办任务列表（右侧面板：已过期 + 未来7天）=====
    var todayParsed = parseDateKey(getTodayKey());
    var endParsed = new Date(todayParsed.getFullYear(), todayParsed.getMonth(), todayParsed.getDate() + 6);
    document.getElementById('week-panel-title').textContent = '待办任务';
    document.getElementById('week-panel-subtitle').textContent =
      '已过期 + 未来7天（' +
      (todayParsed.getMonth() + 1) + '/' + todayParsed.getDate() + ' - ' +
      (endParsed.getMonth() + 1) + '/' + endParsed.getDate() + '）';

    var weekListEl = document.getElementById('week-task-list');
    weekListEl.innerHTML = '';
    var weekViewTasks = getUpcomingWeekTasks().filter(function(item) { return !item.completed; });

    if (weekViewTasks.length === 0) {
      weekListEl.innerHTML = '<div class="empty-state"><div class="empty-state-text" style="padding:24px 0;">暂无待办任务</div></div>';
    } else {
      weekViewTasks.forEach(function(item) {
        var li = document.createElement('li');
        li.className = 'task-item' + (item.completed ? ' completed' : '');

        var checkbox = document.createElement('div');
        checkbox.className = 'task-checkbox';
        checkbox.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        checkbox.style.cursor = 'pointer';
        checkbox.addEventListener('click', function() {
          toggleMonthlyTask(item.task.id, item.task.monthKey);
          renderMonthly();
        });

        var content = document.createElement('div');
        content.className = 'task-content';
        content.style.display = 'flex';
        content.style.alignItems = 'center';
        content.style.flexWrap = 'wrap';

        if (item.task.category) {
          var tagColor2 = getTagColor(item.task.category);
          if (tagColor2) {
            var badge = document.createElement('span');
            badge.className = 'task-badge custom-tag';
            badge.style.backgroundColor = tagColor2 + '1A';
            badge.style.color = tagColor2;
            badge.style.borderColor = tagColor2 + '55';
            badge.textContent = item.task.category;
            content.appendChild(badge);
          }
        }

        // 已过期标签（超过设定日期仍未完成）
        if (!item.completed && item.dateKey < getTodayKey()) {
          var itemOverdue = document.createElement('span');
          itemOverdue.className = 'task-badge overdue';
          itemOverdue.textContent = '已过期';
          content.appendChild(itemOverdue);
        }

        var dateBadge = document.createElement('span');
        dateBadge.className = 'task-badge date-badge';
        var dayNum = item.dateKey.split('-')[2];
        dateBadge.textContent = parseInt(dayNum, 10) + '日';
        content.appendChild(dateBadge);

        var name = document.createElement('span');
        name.className = 'task-name';
        name.textContent = item.task.name;
        content.appendChild(name);

        li.appendChild(checkbox);
        li.appendChild(content);
        weekListEl.appendChild(li);
      });
    }

    // ===== 渲染某天任务列表（右侧面板）=====
    var selDate = parseDateKey(currentDate);
    document.getElementById('day-panel-title').textContent =
      (selDate.getMonth() + 1) + '月' + selDate.getDate() + '日 任务';
    document.getElementById('day-panel-subtitle').textContent = weekdays[selDate.getDay()];

    var dayListEl = document.getElementById('monthly-task-list');
    dayListEl.innerHTML = '';
    var monthKey = formatMonthKey(selDate);
    // sort same as right panel: incomplete first, then by tag order
    var dayTasks = getTasksByDate(currentDate).slice().sort(function(a, b) {
      var aDone = isMonthlyTaskCompleted(a.id, monthKey) ? 1 : 0;
      var bDone = isMonthlyTaskCompleted(b.id, monthKey) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      var aCat = getTagRank(a.category);
      var bCat = getTagRank(b.category);
      return aCat - bCat;
    });
    var dayCompleted = 0;

    if (dayTasks.length === 0) {
      dayListEl.innerHTML = '<div class="empty-state"><div class="empty-state-text" style="padding:24px 0;">当天还没有任务<br>在下方添加</div></div>';
    } else {
      dayTasks.forEach(function(task, index) {
        var completed = isMonthlyTaskCompleted(task.id, monthKey);
        if (completed) dayCompleted++;
        var group = dayTasks.filter(function(item) { return item.category === task.category && isMonthlyTaskCompleted(item.id, item.monthKey) === completed; });
        var position = group.indexOf(task);
        var li = createTaskElement(task, 'monthly', completed, position === 0, position === group.length - 1);
        dayListEl.appendChild(li);
      });
    }

    var dayTotal = dayTasks.length;
    var dayPercent = dayTotal > 0 ? Math.round((dayCompleted / dayTotal) * 100) : 0;
    if (dayTotal > 0) {
      document.getElementById('day-panel-subtitle').textContent += ' · 完成 ' + dayCompleted + '/' + dayTotal + '（' + dayPercent + '%）';
    }
  }

  // ===== 渲染：签到（只计算每日习惯，不包含每月任务与计划待办） =====
  function renderStats() {
    var year = statsMonth.getFullYear();
    var month = statsMonth.getMonth();
    document.getElementById('stats-month-label').textContent = year + '年' + (month + 1) + '月';

    var daysInMonth = getDaysInMonth(year, month);
    var today = new Date();
    var todayKey = getTodayKey();
    document.getElementById('next-month-stats').disabled = formatMonthKey(statsMonth) >= formatMonthKey(today);
    document.getElementById('history-date-input').max = todayKey;

    var dailyCounts = {};
    var totalCompletions = 0;
    var activeDays = 0;

    for (var day = 1; day <= daysInMonth; day++) {
      var d = new Date(year, month, day);
      var key = formatDateKey(d);
      var count = key <= todayKey ? getHabitsForDate(key).filter(function(task) { return isTaskCompleted(task.id, key); }).length : 0;
      dailyCounts[key] = count;
      totalCompletions += count;
      if (count > 0) activeDays++;
    }

    var overviewEl = document.getElementById('stats-overview');
    var elapsedDays = year === today.getFullYear() && month === today.getMonth() ? today.getDate() : (new Date(year,month,1) > today ? 0 : daysInMonth);
    var activeRate = elapsedDays > 0 ? Math.round((activeDays / elapsedDays) * 100) : 0;
    overviewEl.innerHTML =
      '<div class="stat-card"><div class="stat-value">' + totalCompletions + '</div><div class="stat-label">总完成次数</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + activeDays + '</div><div class="stat-label">打卡天数</div></div>' +
      '<div class="stat-card"><div class="stat-value">' + activeRate + '%</div><div class="stat-label">本月活跃率</div></div>';

    renderHeatmap(year, month, daysInMonth, dailyCounts, todayKey);
    renderHabitChart(year, month, daysInMonth, dailyCounts, todayKey);
    renderHistoryDetail();
    renderTaskStats(year, month, daysInMonth);
    renderHabitManagement();
  }

  function renderHabitManagement() {
    var habits = state.tasks.filter(function(task) { return !task.archivedAt; });
    var list = document.getElementById('task-list');
    list.replaceChildren();
    document.getElementById('habit-manager-count').textContent = habits.length + ' 个习惯';
    if (!habits.length) {
      var empty = document.createElement('li');
      empty.className = 'quiet-empty'; empty.textContent = '添加一个每天坚持的习惯吧。';
      list.appendChild(empty);
    }
    habits.forEach(function(task, index) {
      var row = createTaskElement(task, 'daily', false, index === 0, index === habits.length - 1);
      row.querySelector('.task-checkbox').remove();
      list.appendChild(row);
    });
  }

  function selectCheckinDate(dateKey, focusSelector) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || dateKey > getTodayKey()) return;
    var date = parseDateKey(dateKey);
    if (isNaN(date.getTime()) || formatDateKey(date) !== dateKey) return;
    selectedHistoryDate = dateKey;
    statsMonth = new Date(date.getFullYear(), date.getMonth(), 1);
    renderStats();
    if (focusSelector) {
      var control = document.querySelector(focusSelector + '[data-date-key="' + dateKey + '"]');
      if (control) control.focus({ preventScroll: true });
    }
  }

  function changeStatsMonth(offset) {
    var next = new Date(statsMonth.getFullYear(), statsMonth.getMonth() + offset, 1);
    if (formatMonthKey(next) > formatMonthKey(new Date())) return;
    var day = Math.min(parseDateKey(selectedHistoryDate).getDate(), getDaysInMonth(next.getFullYear(), next.getMonth()));
    var dateKey = formatDateKey(new Date(next.getFullYear(), next.getMonth(), day));
    selectCheckinDate(dateKey > getTodayKey() ? getTodayKey() : dateKey);
  }

  function renderHabitChart(year, month, daysInMonth, dailyCounts, todayKey) {
    var chart = document.getElementById('habit-chart');
    var detail = document.getElementById('habit-chart-detail');
    chart.replaceChildren();
    var maxCount = Math.max.apply(null, Object.keys(dailyCounts).map(function(key) { return dailyCounts[key]; }).concat([0]));
    var ceiling = Math.max(4, Math.ceil(maxCount / 4) * 4);
    var plot = document.createElement('div');
    plot.className = 'habit-chart-plot';
    [0, ceiling / 2, ceiling].forEach(function(value) {
      var line = document.createElement('div');
      line.className = 'habit-chart-gridline';
      line.style.bottom = (value / ceiling * 100) + '%';
      var label = document.createElement('span');
      label.textContent = value;
      line.appendChild(label);
      plot.appendChild(line);
    });
    function describe(key) {
      var date = parseDateKey(key);
      detail.textContent = (date.getMonth() + 1) + '月' + date.getDate() + '日 · 完成 ' + (dailyCounts[key] || 0) + ' 项每日习惯';
    }
    var bars = document.createElement('div');
    bars.className = 'habit-chart-bars';
    bars.style.setProperty('--chart-days', daysInMonth);
    for (var day = 1; day <= daysInMonth; day++) {
      var key = formatDateKey(new Date(year, month, day));
      var count = dailyCounts[key] || 0;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'habit-chart-day' + (key === selectedHistoryDate ? ' selected' : '');
      button.dataset.dateKey = key;
      button.dataset.count = count;
      button.disabled = key > todayKey;
      button.setAttribute('aria-label', key + (button.disabled ? '：未来日期' : '：完成 ' + count + ' 项每日习惯'));
      button.setAttribute('aria-pressed', String(key === selectedHistoryDate));
      button.title = button.getAttribute('aria-label');
      var bar = document.createElement('span');
      bar.className = 'habit-chart-bar';
      bar.style.height = (count / ceiling * 100) + '%';
      button.appendChild(bar);
      button.addEventListener('mouseenter', function() { if (!this.disabled) describe(this.dataset.dateKey); });
      button.addEventListener('focus', function() { describe(this.dataset.dateKey); });
      button.addEventListener('mouseleave', function() { describe(selectedHistoryDate); });
      button.addEventListener('blur', function() { describe(selectedHistoryDate); });
      button.addEventListener('click', function(event) { selectCheckinDate(this.dataset.dateKey, event.detail === 0 ? '.habit-chart-day' : null); });
      bars.appendChild(button);
    }
    plot.appendChild(bars);
    chart.appendChild(plot);
    var axis = document.createElement('div');
    axis.className = 'habit-chart-axis';
    [1, 5, 10, 15, 20, 25, daysInMonth].forEach(function(day) {
      var label = document.createElement('span');
      label.textContent = (month + 1) + '/' + day;
      label.style.left = ((day - 1) / (daysInMonth - 1) * 100) + '%';
      if (day === 5 || day === 15 || day === 25) label.className = 'chart-axis-secondary';
      axis.appendChild(label);
    });
    chart.appendChild(axis);
    describe(selectedHistoryDate);
  }

  function renderHeatmap(year, month, daysInMonth, dailyCounts, todayKey) {
    var grid = document.getElementById('heatmap-grid');
    grid.replaceChildren();
    document.getElementById('heatmap-range').textContent = '1日 — ' + daysInMonth + '日';
    var maxCount = Math.max.apply(null, Object.keys(dailyCounts).map(function(key) { return dailyCounts[key]; }).concat([0]));
    for (var day = 1; day <= daysInMonth; day++) {
      var key = formatDateKey(new Date(year, month, day));
      var count = dailyCounts[key] || 0;
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'heatmap-cell';
      cell.dataset.dateKey = key;
      if (count > 0) cell.classList.add('has-data', 'level-' + getHeatLevel(count, maxCount));
      if (key === todayKey) cell.classList.add('today');
      if (key === selectedHistoryDate) cell.classList.add('selected');
      cell.disabled = key > todayKey;
      if (cell.disabled) cell.classList.add('future');
      cell.title = key + (cell.disabled ? '：未来日期' : '：完成 ' + count + ' 项每日习惯');
      cell.setAttribute('aria-label', cell.title);
      cell.setAttribute('aria-pressed', String(key === selectedHistoryDate));
      cell.addEventListener('click', function(event) { selectCheckinDate(this.dataset.dateKey, event.detail === 0 ? '.heatmap-cell' : null); });
      grid.appendChild(cell);
    }
  }

  function getHeatLevel(count, max) {
    if (count <= 0 || max <= 0) return 0;
    var ratio = count / max;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  function renderHistoryDetail() {
    var dateKey = selectedHistoryDate;
    var d = parseDateKey(dateKey);
    var weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

    document.getElementById('history-date-input').value = dateKey;

    var summaryEl = document.getElementById('history-summary');
    var listEl = document.getElementById('history-task-list');
    listEl.innerHTML = '';

    var historyTasks = getHabitsForDate(dateKey).filter(function(task) { return dateKey !== getTodayKey() || !task.archivedAt; });
    var total = historyTasks.length;

    if (total === 0) {
      summaryEl.textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 没有每日习惯';
      listEl.innerHTML = '<li class="quiet-empty">这一天没有每日习惯，可在下方「管理每日习惯」中添加。</li>';
      return;
    }

    var completedCount = 0;
    var isFutureDate = dateKey > getTodayKey();

    historyTasks.forEach(function(task) {
      var completed = isTaskCompleted(task.id, dateKey);
      if (completed) completedCount++;

      var li = document.createElement('li');
      li.className = 'task-item' + (completed ? ' completed' : '');

      var checkbox = document.createElement('button');
      checkbox.type = 'button';
      checkbox.className = 'task-checkbox';
      checkbox.setAttribute('role', 'checkbox');
      checkbox.setAttribute('aria-checked', String(completed));
      checkbox.setAttribute('aria-label', task.name);
      checkbox.dataset.taskId = task.id;
      checkbox.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>';

      if (isFutureDate) {
        // 未来日期不可标记完成
        checkbox.disabled = true;
        checkbox.title = '未来日期无法标记';
      } else {
        // 点击切换该任务在选定日期的完成状态（可补录历史）
        checkbox.style.cursor = 'pointer';
        checkbox.title = completed ? '点击取消完成' : '点击标记完成';
        checkbox.addEventListener('click', function(event) {
          toggleTask(task.id, dateKey);
          renderStats();
          if (event.detail === 0) {
            var replacement = Array.from(document.querySelectorAll('#history-task-list .task-checkbox')).find(function(button) { return button.dataset.taskId === task.id; });
            if (replacement) replacement.focus({ preventScroll: true });
          }
        });
      }

      var content = document.createElement('div');
      content.className = 'task-content';
      var name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = task.name;
      content.appendChild(name);

      li.appendChild(checkbox);
      li.appendChild(content);
      listEl.appendChild(li);
    });

    var percent = total > 0 ? Math.round((completedCount / total) * 100) : 0;
    summaryEl.innerHTML =
      (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + weekdays[d.getDay()] +
      '：完成 <strong>' + completedCount + '</strong> / ' + total + ' 项（' + percent + '%）';
  }

  function renderTaskStats(year, month, daysInMonth) {
    var listEl = document.getElementById('task-stats-list');
    listEl.innerHTML = '';

    if (state.tasks.length === 0) {
      listEl.innerHTML = '<div class="empty-state"><div class="empty-state-text">还没有任务数据</div></div>';
      return;
    }

    state.tasks.forEach(function(task) {
      var completedDays = 0;
      for (var day = 1; day <= daysInMonth; day++) {
        var d = new Date(year, month, day);
        var key = formatDateKey(d);
        if (isTaskCompleted(task.id, key)) completedDays++;
      }
      var percent = daysInMonth > 0 ? Math.round((completedDays / daysInMonth) * 100) : 0;
      var item = document.createElement('div');
      item.className = 'task-stat-item';
      item.innerHTML =
        '<div class="task-stat-header">' +
          '<span class="task-stat-name">' + escapeHtml(task.name) + '</span>' +
          '<span class="task-stat-count"><strong>' + completedDays + '</strong> / ' + daysInMonth + ' 天 · ' + percent + '%</span>' +
        '</div>' +
        '<div class="task-stat-bar"><div class="task-stat-bar-fill" style="width:' + percent + '%"></div></div>';
      listEl.appendChild(item);
    });
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===== 主渲染 =====
  function render() {
    document.querySelectorAll('.nav-tab').forEach(function(tab) {
      tab.classList.toggle('active', tab.dataset.route === currentRoute);
    });
    document.getElementById('view-today').classList.toggle('active', currentRoute === 'today');
    document.getElementById('view-monthly').classList.toggle('active', currentRoute === 'monthly');
    document.getElementById('view-stats').classList.toggle('active', currentRoute === 'stats');

    if (currentRoute === 'today') renderToday();
    else if (currentRoute === 'monthly') renderMonthly();
    else renderStats();
  }

  // ===== 事件绑定 =====
  function initEvents() {
    document.getElementById('add-temporary-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var input = document.getElementById('add-temporary-input');
      var name = input.value.trim();
      if (name && addMonthlyTask(name, getTodayKey(), TEMPORARY_TAG)) { input.value = ''; renderToday(); input.focus(); }
    });
    document.getElementById('add-planned-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var input = document.getElementById('add-planned-input');
      if (addPlannedTask(input.value)) { input.value = ''; renderPlannedTasks(); input.focus(); }
    });
    var copyDialog = document.getElementById('copy-dialog');
    document.getElementById('copy-cancel').addEventListener('click', function() { copyDialog.close(); });
    copyDialog.addEventListener('close', function() { copySource = null; });
    document.getElementById('copy-form').addEventListener('submit', function(e) {
      e.preventDefault();
      if (!copySource) return;
      var dateKey = document.getElementById('copy-date').value;
      var copy = copyTaskToDate(copySource.id, copySource.type, dateKey);
      if (!copy) {
        document.getElementById('copy-error').textContent = '复制失败，请检查日期和保存状态后重试。';
        return;
      }
      copyDialog.close();
      currentDate = dateKey; viewMonth = parseDateKey(dateKey); needScrollToToday = false;
      pendingScrollDate = dateKey;
      currentRoute = 'monthly'; location.hash = 'monthly'; render();
      showStatus('已复制到 ' + dateKey + ' · 已保存');
    });
    document.getElementById('undo-btn').addEventListener('click', function() {
      if (!undoSnapshot) return; state = JSON.parse(undoSnapshot); undoSnapshot = null;
      this.hidden = true; saveState(); render();
    });
    document.getElementById('calendar-today-btn').addEventListener('click', function() {
      currentDate = getTodayKey(); needScrollToToday = true; renderMonthly();
    });
    document.querySelectorAll('.nav-tab').forEach(function(tab) {
      tab.addEventListener('click', function() { navigate(tab.dataset.route); });
    });

    document.getElementById('add-task-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var input = document.getElementById('add-task-input');
      var name = input.value.trim();
      if (name && addTask(name)) { input.value = ''; selectCheckinDate(getTodayKey()); input.focus(); }
    });

    document.getElementById('add-monthly-form').addEventListener('submit', function(e) {
      e.preventDefault();
      var input = document.getElementById('add-monthly-input');
      var name = input.value.trim();
      if (name && addMonthlyTask(name, currentDate, selectedTag)) {
        input.value = '';
        selectedTag = '';
        updateTagSelectorBtn();
        renderMonthly();
      }
    });

    // 标签选择器下拉
    document.getElementById('tag-selector-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      var dd = document.getElementById('tag-dropdown');
      var mp = document.getElementById('tag-manage-panel');
      mp.style.display = 'none';
      if (dd.style.display === 'block') { dd.style.display = 'none'; }
      else { renderTagDropdown(); dd.style.display = 'block'; }
    });
    // 管理标签面板
    document.getElementById('tag-manage-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      var dd = document.getElementById('tag-dropdown');
      var mp = document.getElementById('tag-manage-panel');
      dd.style.display = 'none';
      if (mp.style.display === 'block') { mp.style.display = 'none'; }
      else { renderTagManagePanel(); mp.style.display = 'block'; }
    });
    // 面板内部点击不冒泡（避免输入框等触发全局关闭）
    document.getElementById('tag-dropdown').addEventListener('click', function(e) { e.stopPropagation(); });
    document.getElementById('tag-manage-panel').addEventListener('click', function(e) { e.stopPropagation(); });
    // 点击外部关闭下拉/面板
    document.addEventListener('click', function() {
      document.getElementById('tag-dropdown').style.display = 'none';
      document.getElementById('tag-manage-panel').style.display = 'none';
    });
    updateTagSelectorBtn();

    // 日历上下翻周 + 标题点击回今天
    function scrollCalendarByWeek(dir) {
      var cal = document.getElementById('calendar-with-weeks');
      var cell = cal.querySelector('.calendar-cell-mini');
      var rowH = cell ? cell.offsetHeight + 4 : 56;
      cal.scrollBy({ top: dir * rowH, behavior: 'smooth' });
    }
    document.getElementById('prev-month-btn').addEventListener('click', function() { scrollCalendarByWeek(-1); });
    document.getElementById('next-month-btn').addEventListener('click', function() { scrollCalendarByWeek(1); });
    document.getElementById('month-label').addEventListener('click', function() {
      needScrollToToday = true;
      renderMonthly();
    });

    // 签到翻页，图表、热力图与右侧日常任务始终对应同一月份
    document.getElementById('prev-month-stats').addEventListener('click', function() {
      changeStatsMonth(-1);
    });
    document.getElementById('next-month-stats').addEventListener('click', function() {
      changeStatsMonth(1);
    });

    // 历史日详情
    document.getElementById('history-date-input').addEventListener('change', function() {
      selectCheckinDate(this.value || getTodayKey());
      this.value = selectedHistoryDate;
    });
    document.getElementById('history-today-btn').addEventListener('click', function() {
      selectCheckinDate(getTodayKey());
    });

    // 点击外部关闭移动菜单
    document.addEventListener('click', function(e) {
      if (moveMenuState && !e.target.closest('[data-move-menu]') && !e.target.closest('[data-move-btn]')) {
        moveMenuState = null;
        if (currentRoute === 'monthly' || currentRoute === 'today') render();
      }
    });

    // 数据管理
    var dataBtn = document.getElementById('data-btn');
    var dataPanel = document.getElementById('data-panel');
    dataBtn.addEventListener('click', function() {
      var isOpen = dataPanel.style.display !== 'none';
      dataPanel.style.display = isOpen ? 'none' : 'block';
      dataBtn.classList.toggle('active', !isOpen);
    });

    document.getElementById('export-btn').addEventListener('click', function() {
      var data = JSON.stringify(state);
      var blob = new Blob([data], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      var now = new Date();
      var stamp = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      a.href = url;
      a.download = 'daily-checkin-backup-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });

    var importFile = document.getElementById('import-file');
    document.getElementById('import-btn').addEventListener('click', function() { importFile.click(); });
    importFile.addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function(ev) {
        if (!window.DailyCloud || !window.DailyCloud.ready) return;
        try {
          var data = JSON.parse(ev.target.result);
          if (!Array.isArray(data.tasks) || !data.records || typeof data.records !== 'object' || Array.isArray(data.records) || (data.monthlyTasks && !Array.isArray(data.monthlyTasks)) || (data.tags && !Array.isArray(data.tags))) { alert('文件格式不正确'); return; }
          if (!validPlannedTasks(data.plannedTasks)) { alert('计划待办数据不正确'); return; }
          var allTasks = data.tasks.concat(data.monthlyTasks || []);
          if (allTasks.some(function(t) { return !t || typeof t.id !== 'string' || typeof t.name !== 'string'; }) || (data.monthlyTasks || []).some(function(t) { return !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || t.monthKey !== t.date.slice(0,7); }) || (data.tags || []).some(function(t) { return !t || typeof t.name !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color); })) { alert('任务或标签数据不正确'); return; }
          if (!confirm('导入将替换当前账号的任务和记录，并同步到其他设备。确定继续吗？')) return;
          var before = state;
          try {
            loadState(data);
            if (!DailySync.validate(state)) throw Error('备份数据未通过检查');
            if (!saveState()) throw Error('保存失败');
          } catch (error) { state = before; alert('导入未完成：' + error.message); return; }
          undoSnapshot = JSON.stringify(before); document.getElementById('undo-btn').hidden = false;
          render();
          alert('备份已导入本机，联网后会自动同步。');
        } catch (err) {
          alert('文件解析失败');
        }
      };
      reader.readAsText(file);
      importFile.value = '';
    });

    document.getElementById('clear-btn').addEventListener('click', function() {
      if (!confirm('确定要清空所有数据吗？建议先导出备份。')) return;
      if (!confirm('再次确认：所有任务和记录将被永久删除，确定吗？')) return;
      rememberUndo();
      var beforeClear = state;
      state = DailySync.empty();
      if (!saveState()) { state = beforeClear; return; }
      render();
      alert('数据已清空，联网后会同步到其他设备；可立即撤销。');
    });

    window.addEventListener('hashchange', handleHashChange);
  }

  // ===== 初始化 =====
  function init() {
    loadState();
    currentDate = getTodayKey();
    viewMonth = new Date();
    initEvents();
    var hash = location.hash.replace('#', '');
    if (hash === 'monthly') currentRoute = 'monthly';
    else if (hash === 'stats') currentRoute = 'stats';
    render();
  }

  window.DailyApp = {
    uiVersion: 2,
    snapshot: function() { return DailySync.clone(state); },
    busy: function() {
      var el = document.activeElement;
      return !!editingState || !!moveMenuState || !!assignMenuState ||
        !!document.querySelector('#daily-app dialog[open]') ||
        !!(el && el.closest('#daily-app') && el.matches('input, textarea, select'));
    },
    apply: function(data) {
      if (!DailySync.validate(data)) throw Error('数据格式不正确');
      state = DailySync.clone(data); editingState = null; moveMenuState = null; assignMenuState = null;
      ensureTemporaryTag();
      undoSnapshot = null; document.getElementById('undo-btn').hidden = true;
      render();
    },
    reset: function() {
      state = DailySync.empty(); ensureTemporaryTag(); editingState = null; moveMenuState = null; assignMenuState = null;
      selectedTag = ''; updateTagSelectorBtn(); currentDate = getTodayKey(); selectedHistoryDate = getTodayKey();
      statsMonth = new Date(); statsMonth.setDate(1);
      undoSnapshot = null; document.getElementById('undo-btn').hidden = true;
      document.querySelectorAll('#daily-app dialog[open]').forEach(function(d) { d.close(); });
      document.querySelectorAll('#daily-app input').forEach(function(el) { el.value = ''; });
      document.querySelectorAll('#daily-app .task-list, #stats-overview, #task-stats-list, #history-summary, #heatmap-grid, #habit-chart, #habit-chart-detail').forEach(function(el) { el.replaceChildren(); });
      ['tag-dropdown', 'tag-manage-panel'].forEach(function(id) { var el = document.getElementById(id); el.replaceChildren(); el.style.display = 'none'; });
      document.getElementById('copy-task-name').textContent = '';
      document.getElementById('data-panel').style.display = 'none';
      render();
    },
    exportBackup: function() { document.getElementById('export-btn').click(); }
  };
  init();
})();
