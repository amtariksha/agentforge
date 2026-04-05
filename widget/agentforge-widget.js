(function () {
  'use strict';

  var WIDGET_VERSION = '1.0.0';

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
    '.af-send:disabled{opacity:.5;cursor:not-allowed}'
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
