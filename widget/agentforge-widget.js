(function () {
  'use strict';

  var WIDGET_VERSION = '2.0.0';

  // Read config from script tag
  var scriptTag = document.currentScript || document.querySelector('script[data-tenant-id]');
  if (!scriptTag) {
    console.error('[AgentForge] Missing script tag with data-tenant-id');
    return;
  }

  var tenantId = scriptTag.getAttribute('data-tenant-id');
  var serverUrl = scriptTag.getAttribute('data-server-url') || window.location.origin;
  var position = scriptTag.getAttribute('data-position') || 'bottom-right';
  var primaryColor = scriptTag.getAttribute('data-color') || '#2563eb';

  if (!tenantId) {
    console.error('[AgentForge] data-tenant-id is required');
    return;
  }

  // Inject styles
  var style = document.createElement('style');
  style.textContent = [
    '.af-widget-container{position:fixed;',
    position === 'bottom-left' ? 'left:20px;' : 'right:20px;',
    'bottom:20px;z-index:99999;font-family:-apple-system,BlinkMacSystemFont,sans-serif}',
    '.af-widget-button{width:56px;height:56px;border-radius:50%;background:' + primaryColor + ';color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;transition:transform .2s}',
    '.af-widget-button:hover{transform:scale(1.05)}',
    '.af-widget-panel{display:none;width:380px;height:520px;background:#fff;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.12);overflow:hidden;flex-direction:column;position:absolute;bottom:70px;',
    position === 'bottom-left' ? 'left:0' : 'right:0',
    '}.af-widget-panel.open{display:flex}',
    '.af-header{background:' + primaryColor + ';color:#fff;padding:16px;display:flex;align-items:center;justify-content:space-between}',
    '.af-header h3{margin:0;font-size:16px;font-weight:600}',
    '.af-close{background:none;border:none;color:#fff;cursor:pointer;font-size:20px;padding:0 4px}',
    '.af-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:8px}',
    '.af-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.4;word-wrap:break-word}',
    '.af-agent{background:#f1f5f9;color:#1e293b;align-self:flex-start;border-bottom-left-radius:4px}',
    '.af-user{background:' + primaryColor + ';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '.af-typing{background:#f1f5f9;align-self:flex-start;border-bottom-left-radius:4px;padding:12px 18px}',
    '.af-dots span{display:inline-block;width:6px;height:6px;border-radius:50%;background:#94a3b8;margin:0 2px;animation:afb 1.4s infinite ease-in-out both}',
    '.af-dots span:nth-child(1){animation-delay:-.32s}.af-dots span:nth-child(2){animation-delay:-.16s}',
    '@keyframes afb{0%,80%,100%{transform:scale(0)}40%{transform:scale(1)}}',
    '.af-input-bar{display:flex;padding:12px;border-top:1px solid #e2e8f0;gap:8px}',
    '.af-input-bar input{flex:1;border:1px solid #e2e8f0;border-radius:24px;padding:10px 16px;font-size:14px;outline:none}',
    '.af-input-bar input:focus{border-color:' + primaryColor + '}',
    '.af-send{width:40px;height:40px;border-radius:50%;background:' + primaryColor + ';color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.af-send:disabled{opacity:.5;cursor:not-allowed}',
    // ---- Generative UI blocks (v2) ----
    '.af-block{align-self:flex-start;max-width:95%;margin:2px 0}',
    '.af-card{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;width:240px}',
    '.af-card img{width:100%;height:130px;object-fit:cover;display:block}',
    '.af-card-body{padding:10px 12px}',
    '.af-card-title{font-weight:600;font-size:14px;margin:0 0 2px}',
    '.af-card-sub{color:#64748b;font-size:12px;margin:0 0 6px}',
    '.af-card-price{font-weight:600;font-size:14px;color:' + primaryColor + '}',
    '.af-carousel{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px}',
    '.af-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
    '.af-btn{border:1px solid ' + primaryColor + ';color:' + primaryColor + ';background:#fff;border-radius:16px;padding:6px 12px;font-size:13px;cursor:pointer}',
    '.af-btn:hover{background:' + primaryColor + ';color:#fff}',
    '.af-table{border-collapse:collapse;font-size:13px;width:100%}',
    '.af-table th,.af-table td{border:1px solid #e2e8f0;padding:5px 8px;text-align:left}',
    '.af-table th{background:#f8fafc;font-weight:600}',
    '.af-kpi{border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;background:#fff;min-width:120px}',
    '.af-kpi-label{color:#64748b;font-size:12px}',
    '.af-kpi-value{font-size:22px;font-weight:700}',
    '.af-kpi-up{color:#16a34a}.af-kpi-down{color:#dc2626}',
    '.af-form{border:1px solid #e2e8f0;border-radius:12px;padding:12px;background:#fff;display:flex;flex-direction:column;gap:8px;width:240px}',
    '.af-form label{font-size:12px;color:#334155;display:flex;flex-direction:column;gap:3px}',
    '.af-form input,.af-form select,.af-form textarea{border:1px solid #e2e8f0;border-radius:8px;padding:6px 8px;font-size:13px}',
    '.af-chart{width:260px;height:140px}'
  ].join('');
  document.head.appendChild(style);

  // Build widget DOM safely (no innerHTML with user data)
  var container = document.createElement('div');
  container.className = 'af-widget-container';

  // Panel
  var panel = document.createElement('div');
  panel.className = 'af-widget-panel';

  // Header
  var header = document.createElement('div');
  header.className = 'af-header';
  var title = document.createElement('h3');
  title.textContent = 'Chat with us';
  var closeBtn = document.createElement('button');
  closeBtn.className = 'af-close';
  closeBtn.textContent = '\u00D7';
  header.appendChild(title);
  header.appendChild(closeBtn);

  // Messages area
  var messagesDiv = document.createElement('div');
  messagesDiv.className = 'af-messages';

  // Input bar
  var inputBar = document.createElement('div');
  inputBar.className = 'af-input-bar';
  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Type a message...';
  input.autocomplete = 'off';
  var sendBtn = document.createElement('button');
  sendBtn.className = 'af-send';
  sendBtn.textContent = '\u27A4';
  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);

  panel.appendChild(header);
  panel.appendChild(messagesDiv);
  panel.appendChild(inputBar);

  // Toggle button
  var toggleBtn = document.createElement('button');
  toggleBtn.className = 'af-widget-button';
  toggleBtn.textContent = '\uD83D\uDCAC';

  container.appendChild(panel);
  container.appendChild(toggleBtn);
  document.body.appendChild(container);

  // State
  var ws = null;
  var isOpen = false;
  var userId = 'web_' + Math.random().toString(36).slice(2, 10);

  // Restore userId from sessionStorage
  var stored = sessionStorage.getItem('af_user_' + tenantId);
  if (stored) userId = stored;
  else sessionStorage.setItem('af_user_' + tenantId, userId);

  function addMessage(text, sender) {
    var msg = document.createElement('div');
    msg.className = 'af-msg ' + (sender === 'user' ? 'af-user' : 'af-agent');
    msg.textContent = text;
    messagesDiv.appendChild(msg);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function showTyping() {
    var existing = document.getElementById('af-typing-indicator');
    if (existing) return;
    var typing = document.createElement('div');
    typing.id = 'af-typing-indicator';
    typing.className = 'af-msg af-typing';
    var dots = document.createElement('div');
    dots.className = 'af-dots';
    for (var i = 0; i < 3; i++) {
      dots.appendChild(document.createElement('span'));
    }
    typing.appendChild(dots);
    messagesDiv.appendChild(typing);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  function hideTyping() {
    var typing = document.getElementById('af-typing-indicator');
    if (typing) typing.remove();
  }

  // ---- Generative UI rendering (v2) — vanilla DOM, no innerHTML ----

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function sendIntent(action) {
    if (action.kind === 'url' && action.url) { window.open(action.url, '_blank', 'noopener'); return; }
    if (action.kind === 'call' && action.url) { window.location.href = action.url; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'action',
      intent: action.intent || 'postback',
      payload: action.payload || '',
      label: action.label,
      userId: userId
    }));
    addMessage(action.label, 'user');
  }

  function actionButton(action) {
    var b = el('button', 'af-btn', action.label);
    b.addEventListener('click', function () { sendIntent(action); });
    return b;
  }

  function actionRow(actions) {
    var row = el('div', 'af-actions');
    (actions || []).forEach(function (a) { row.appendChild(actionButton(a)); });
    return row;
  }

  function renderCard(block) {
    var card = el('div', 'af-card');
    if (block.imageUrl) { var img = document.createElement('img'); img.src = block.imageUrl; img.alt = block.title || ''; card.appendChild(img); }
    var body = el('div', 'af-card-body');
    body.appendChild(el('p', 'af-card-title', block.title));
    if (block.subtitle) body.appendChild(el('p', 'af-card-sub', block.subtitle));
    if (block.price) body.appendChild(el('p', 'af-card-price', (block.price.currency || '') + ' ' + block.price.amount));
    if (block.actions && block.actions.length) body.appendChild(actionRow(block.actions));
    card.appendChild(body);
    return card;
  }

  function renderTable(block) {
    var table = el('table', 'af-table');
    var thead = el('thead'); var htr = el('tr');
    block.columns.forEach(function (c) { htr.appendChild(el('th', null, c.label)); });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = el('tbody');
    (block.rows || []).forEach(function (r) {
      var tr = el('tr');
      block.columns.forEach(function (c) { tr.appendChild(el('td', null, r[c.key] == null ? '' : String(r[c.key]))); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderKpi(block) {
    var k = el('div', 'af-kpi');
    k.appendChild(el('div', 'af-kpi-label', block.label));
    var v = el('div', 'af-kpi-value' + (block.trend === 'up' ? ' af-kpi-up' : block.trend === 'down' ? ' af-kpi-down' : ''), String(block.value));
    k.appendChild(v);
    return k;
  }

  function renderForm(block) {
    var form = el('form', 'af-form');
    (block.fields || []).forEach(function (f) {
      var label = el('label', null, f.label);
      var field;
      if (f.inputType === 'select') {
        field = document.createElement('select');
        (f.options || []).forEach(function (o) { var opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; field.appendChild(opt); });
      } else if (f.inputType === 'textarea') {
        field = document.createElement('textarea');
      } else {
        field = document.createElement('input');
        field.type = (f.inputType === 'number' || f.inputType === 'email' || f.inputType === 'tel' || f.inputType === 'date') ? f.inputType : 'text';
      }
      field.name = f.name;
      if (f.required) field.required = true;
      label.appendChild(field);
      form.appendChild(label);
    });
    var submit = el('button', 'af-btn', block.submitLabel || 'Submit');
    submit.type = 'submit';
    form.appendChild(submit);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var payload = {};
      (block.fields || []).forEach(function (f) { var node = form.elements[f.name]; if (node) payload[f.name] = node.value; });
      sendIntent({ kind: 'postback', label: block.submitLabel || 'Submit', intent: block.submitIntent, payload: JSON.stringify(payload) });
    });
    return form;
  }

  function renderChart(block) {
    if (block.imageUrl) { var img = document.createElement('img'); img.src = block.imageUrl; img.className = 'af-chart'; img.alt = block.fallbackText || 'chart'; return img; }
    // uPlot lazy-load could go here; for the fallback path show the text so the
    // user is never left with an empty box.
    return el('div', 'af-msg af-agent', block.fallbackText);
  }

  function renderBlock(block) {
    if (!block || typeof block !== 'object') return;
    var node;
    switch (block.type) {
      case 'text': addMessage(block.text, 'agent'); return;
      case 'product_card': node = renderCard(block); break;
      case 'carousel':
        node = el('div', 'af-carousel');
        (block.items || []).forEach(function (item) { node.appendChild(renderCard(item)); });
        break;
      case 'quick_replies':
        node = el('div', 'af-block');
        if (block.prompt) node.appendChild(el('div', 'af-msg af-agent', block.prompt));
        node.appendChild(actionRow(block.replies));
        break;
      case 'confirmation':
        node = el('div', 'af-block');
        node.appendChild(el('div', 'af-msg af-agent', block.body || block.title));
        node.appendChild(actionRow([block.confirm].concat(block.cancel ? [block.cancel] : [])));
        break;
      case 'image': { var im = document.createElement('img'); im.src = block.url; im.className = 'af-chart'; im.alt = block.alt || block.caption || ''; node = im; break; }
      case 'table':
      case 'comparison':
      case 'invoice_list': node = renderTable(normalizeTabular(block)); break;
      case 'kpi_card': node = renderKpi(block); break;
      case 'form': node = renderForm(block); break;
      case 'chart': node = renderChart(block); break;
      default:
        // webview, video, timeline and anything unknown → safe text fallback.
        addMessage(block.fallbackText || '', 'agent');
        return;
    }
    var wrap = el('div', 'af-block');
    wrap.appendChild(node);
    messagesDiv.appendChild(wrap);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
  }

  // comparison/invoice_list share the table renderer via a light adapter.
  function normalizeTabular(block) {
    if (block.type === 'table') return block;
    if (block.type === 'comparison') {
      var cols = [{ key: 'feature', label: '' }].concat(block.columns);
      var rows = (block.rows || []).map(function (r) { var row = { feature: r.feature }; block.columns.forEach(function (c) { row[c.key] = r.values[c.key]; }); return row; });
      return { columns: cols, rows: rows };
    }
    // invoice_list
    return {
      columns: [{ key: 'id', label: 'Invoice' }, { key: 'date', label: 'Date' }, { key: 'amount', label: 'Amount' }, { key: 'status', label: 'Status' }],
      rows: (block.invoices || []).map(function (i) { return { id: i.id, date: i.date, amount: (i.amount.currency || '') + ' ' + i.amount.amount, status: i.status }; })
    };
  }

  function connectWs() {
    var protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var wsUrl = serverUrl.replace(/^https?:/, protocol) + '/ws/chat/' + tenantId;

    ws = new WebSocket(wsUrl);

    ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === 'greeting') {
          addMessage(data.text, 'agent');
        } else if (data.type === 'typing') {
          data.isTyping ? showTyping() : hideTyping();
        } else if (data.type === 'message' || data.type === 'response') {
          hideTyping();
          addMessage(data.text, 'agent');
        } else if (data.type === 'ui' && Array.isArray(data.blocks)) {
          hideTyping();
          data.blocks.forEach(function (b) { renderBlock(b); });
        } else if (data.type === 'error') {
          hideTyping();
          addMessage('Sorry, something went wrong. Please try again.', 'agent');
        }
      } catch (e) {
        // ignore parse errors
      }
    };

    ws.onclose = function () {
      setTimeout(function () {
        if (isOpen) connectWs();
      }, 3000);
    };

    // Keepalive ping every 30s
    setInterval(function () {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);
  }

  function sendMessage() {
    var text = input.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    addMessage(text, 'user');
    ws.send(JSON.stringify({ type: 'message', text: text, userId: userId }));
    input.value = '';
  }

  // Event listeners
  toggleBtn.addEventListener('click', function () {
    isOpen = !isOpen;
    panel.classList.toggle('open', isOpen);
    if (isOpen && !ws) connectWs();
    if (isOpen) input.focus();
  });

  closeBtn.addEventListener('click', function () {
    isOpen = false;
    panel.classList.remove('open');
  });

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') sendMessage();
  });
})();
