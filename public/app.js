(() => {
  "use strict";

  // --- Elements ---
  const messagesEl = document.getElementById("messages");
  const chatForm = document.getElementById("chat-form");
  const chatInput = document.getElementById("chat-input");
  const sendBtn = document.getElementById("send-btn");
  const statusIndicator = document.getElementById("status-indicator");
  const permOverlay = document.getElementById("permission-overlay");
  const permDescription = document.getElementById("permission-description");
  const permDetails = document.getElementById("permission-details");
  const permAllow = document.getElementById("perm-allow");
  const permDeny = document.getElementById("perm-deny");
  const authOverlay = document.getElementById("auth-overlay");
  const authForm = document.getElementById("auth-form");
  const authPassword = document.getElementById("auth-password");
  const authError = document.getElementById("auth-error");
  const newSessionBtn = document.getElementById("new-session-btn");

  // --- Device ID (persistent per browser) ---
  function getDeviceId() {
    let id = localStorage.getItem("copilot_acp_device_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("copilot_acp_device_id", id);
    }
    return id;
  }
  const deviceId = getDeviceId();

  // --- State ---
  let ws = null;
  let currentAssistantEl = null;
  let currentAssistantText = "";
  let pendingPermRequestId = null;
  let isPrompting = false;
  let isAuthenticated = false;

  // --- Chat history persistence ---
  const HISTORY_KEY = `copilot_acp_history_${deviceId}`;
  const MAX_HISTORY = 200;

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
    } catch { return []; }
  }

  function saveHistory(history) {
    try {
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch { /* storage full — ignore */ }
  }

  function appendHistory(role, content) {
    const history = loadHistory();
    history.push({ role, content, ts: Date.now() });
    saveHistory(history);
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
  }

  function restoreHistory() {
    const history = loadHistory();
    if (!history.length) return;
    for (const entry of history) {
      if (entry.role === "user") {
        addMessage("user", entry.content);
      } else if (entry.role === "assistant") {
        addMessage("assistant", renderMarkdown(entry.content), true);
      }
    }
  }

  // --- Markdown ---
  if (typeof marked !== "undefined") {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }

  function renderMarkdown(text) {
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      return DOMPurify.sanitize(marked.parse(text));
    }
    // Fallback: escape and convert newlines
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
  }

  // --- UI helpers ---
  function scrollToBottom() {
    const container = document.getElementById("chat-container");
    container.scrollTop = container.scrollHeight;
  }

  function addMessage(role, content, isHtml = false) {
    const el = document.createElement("div");
    el.className = `message ${role}`;
    if (isHtml) {
      el.innerHTML = content;
    } else {
      el.textContent = content;
    }
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function setStatus(state) {
    statusIndicator.className = `status ${state}`;
    statusIndicator.title =
      state === "connected" ? "Connected" :
      state === "connecting" ? "Connecting..." : "Disconnected";
  }

  function setInputEnabled(enabled) {
    chatInput.disabled = !enabled;
    sendBtn.disabled = !enabled;
  }

  // --- Auto-resize textarea ---
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + "px";
  });

  // --- Enter to send (Shift+Enter for newline) ---
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      chatForm.dispatchEvent(new Event("submit"));
    }
  });

  // --- Form submit ---
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN || isPrompting) return;

    addMessage("user", text);
    appendHistory("user", text);
    ws.send(JSON.stringify({ type: "chat", content: text }));

    chatInput.value = "";
    chatInput.style.height = "auto";
    isPrompting = true;
    setInputEnabled(false);

    // Add assistant placeholder with typing indicator
    currentAssistantText = "";
    currentAssistantEl = addMessage(
      "assistant",
      '<div class="typing-indicator"><span></span><span></span><span></span></div>',
      true
    );
  });

  // --- Permission dialog ---
  permAllow.addEventListener("click", () => {
    if (pendingPermRequestId && ws) {
      ws.send(JSON.stringify({
        type: "permission_response",
        requestId: pendingPermRequestId,
        allowed: true,
      }));
    }
    pendingPermRequestId = null;
    permOverlay.classList.add("hidden");
  });

  permDeny.addEventListener("click", () => {
    if (pendingPermRequestId && ws) {
      ws.send(JSON.stringify({
        type: "permission_response",
        requestId: pendingPermRequestId,
        allowed: false,
      }));
    }
    pendingPermRequestId = null;
    permOverlay.classList.add("hidden");
  });

  // --- Auth form ---
  authForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const pwd = authPassword.value;
    if (!pwd || !ws || ws.readyState !== WebSocket.OPEN) return;
    authError.classList.add("hidden");
    localStorage.setItem("copilot_acp_password", pwd);
    ws.send(JSON.stringify({ type: "auth", password: pwd }));
  });

  // --- New session button ---
  newSessionBtn.addEventListener("click", () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || isPrompting) return;
    if (!confirm("Start a new session? Current conversation will be cleared.")) return;
    messagesEl.innerHTML = "";
    clearHistory();
    setInputEnabled(false);
    ws.send(JSON.stringify({ type: "new_session" }));
  });

  // --- WebSocket ---
  function connect() {
    setStatus("connecting");

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.addEventListener("open", () => {
      setStatus("connected");
      addMessage("system", "Connected to server...");
      // Send init with deviceId for session restoration
      ws.send(JSON.stringify({ type: "init", deviceId }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "chunk":
          if (currentAssistantEl) {
            currentAssistantText += msg.content || "";
            currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
            scrollToBottom();
          }
          break;

        case "done":
          if (currentAssistantEl) {
            // If no text was received, remove the placeholder
            if (!currentAssistantText) {
              currentAssistantEl.remove();
            } else {
              // Final render
              currentAssistantEl.innerHTML = renderMarkdown(currentAssistantText);
              appendHistory("assistant", currentAssistantText);
            }
            if (msg.content) {
              addMessage("system", msg.content);
            }
            currentAssistantEl = null;
            currentAssistantText = "";
          }
          isPrompting = false;
          setInputEnabled(true);
          chatInput.focus();
          break;

        case "error":
          if (currentAssistantEl && !currentAssistantText) {
            currentAssistantEl.remove();
            currentAssistantEl = null;
          }
          addMessage("error", msg.content || "Unknown error");
          isPrompting = false;
          setInputEnabled(true);
          break;

        case "status":
          addMessage("system", msg.content || "");
          if (msg.content && msg.content.includes("session ready")) {
            setInputEnabled(true);
          }
          break;

        case "session_restored":
          addMessage("system", msg.content || "Previous session restored");
          setInputEnabled(true);
          break;

        case "permission_request":
          pendingPermRequestId = msg.requestId;
          permDescription.textContent = msg.description || "Copilot requests permission";
          permDetails.textContent = msg.content || "";
          permOverlay.classList.remove("hidden");
          break;

        case "auth_required":
          isAuthenticated = false;
          // Try cached password first
          {
            const cached = localStorage.getItem("copilot_acp_password");
            if (cached && ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "auth", password: cached }));
            } else {
              authOverlay.classList.remove("hidden");
              authPassword.focus();
            }
          }
          break;

        case "auth_ok":
          isAuthenticated = true;
          authOverlay.classList.add("hidden");
          authError.classList.add("hidden");
          authPassword.value = "";
          addMessage("system", "Authentication successful");
          break;

        case "auth_fail":
          localStorage.removeItem("copilot_acp_password");
          authError.textContent = msg.content || "Incorrect password, please try again";
          authError.classList.remove("hidden");
          authOverlay.classList.remove("hidden");
          authPassword.value = "";
          authPassword.focus();
          break;
      }
    });

    ws.addEventListener("close", () => {
      setStatus("disconnected");
      setInputEnabled(false);
      addMessage("system", "Disconnected. Retrying in 5 seconds...");
      isPrompting = false;
      currentAssistantEl = null;
      currentAssistantText = "";
      setTimeout(connect, 5000);
    });

    ws.addEventListener("error", () => {
      // close handler will fire next
    });
  }

  // --- Init ---
  restoreHistory();
  setInputEnabled(false);
  connect();
})();
