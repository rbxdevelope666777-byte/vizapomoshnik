// ---------- Утилиты ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Мини-Markdown: заголовки, списки, жирный/курсив, цитаты, ссылки (безопасно — HTML экранируется)
function inline(t) {
  return t
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function md(src) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(src).split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { close(); const n = Math.min(m[1].length + 2, 5); out.push(`<h${n}>${inline(m[2])}</h${n}>`); }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^&gt;\s?(.*)/))) { close(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (!line.trim()) { close(); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return `<div class="md">${out.join("")}</div>`;
}

// Чтение SSE-потока из POST-запроса
async function streamPost(url, body, onText) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Ошибка ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const part of parts) {
      if (!part.startsWith("data: ")) continue;
      const ev = JSON.parse(part.slice(6));
      if (ev.type === "text") onText(ev.text);
      else if (ev.type === "error") throw new Error(ev.message);
    }
  }
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- Навигация ----------
function go(tab) {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === tab));
  store.set("tab", tab);
  window.scrollTo({ top: 0 });
  if (tab === "chat") setTimeout(() => $("#chat-input").focus(), 50);
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); go(el.dataset.go); }));
go(store.get("tab", "home"));

fetch("/api/status").then((r) => r.json()).then((s) => { if (s.demo) $("#demo-banner").classList.remove("hidden"); }).catch(() => {});

// ---------- Чат ----------
const GREETING = "Здравствуйте! Я помогу разобраться с визой: какой тип нужен, какие документы собрать, как подать заявку.\n\nРасскажите: **ваше гражданство, куда и зачем едете?**";
let history = store.get("chat", []);
const box = $("#messages");
const form = $("#chat-form");
const input = $("#chat-input");

function addMsg(role, text, { error = false } = {}) {
  const div = document.createElement("div");
  div.className = `msg ${role}${error ? " error" : ""}`;
  if (role === "user" || error) div.textContent = text;
  else div.innerHTML = md(text);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function addCopy(div, text) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  const b = document.createElement("button");
  b.className = "ghost";
  b.textContent = "Копировать";
  b.onclick = () => navigator.clipboard.writeText(text).then(() => { b.textContent = "Скопировано ✓"; setTimeout(() => (b.textContent = "Копировать"), 1500); });
  bar.appendChild(b);
  div.appendChild(bar);
}
function renderChat() {
  box.innerHTML = "";
  addMsg("assistant", GREETING);
  for (const m of history) { const d = addMsg(m.role, m.content); if (m.role === "assistant") addCopy(d, m.content); }
  $("#suggestions").classList.toggle("hidden", history.length > 0);
}
renderChat();

async function sendChat(text) {
  history.push({ role: "user", content: text });
  addMsg("user", text);
  $("#suggestions").classList.add("hidden");
  const out = addMsg("assistant", "");
  out.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  const btn = form.querySelector("button");
  btn.disabled = true;
  let answer = "";
  try {
    await streamPost("/api/chat", { messages: history }, (t) => {
      answer += t;
      out.innerHTML = md(answer);
      box.scrollTop = box.scrollHeight;
    });
    if (!answer) throw new Error("Пустой ответ. Попробуйте ещё раз.");
    history.push({ role: "assistant", content: answer });
    store.set("chat", history);
    addCopy(out, answer);
  } catch (e) {
    out.classList.add("error");
    out.textContent = "⚠️ " + e.message;
    history.pop(); // убираем вопрос без ответа
  } finally {
    btn.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || form.querySelector("button").disabled) return;
  input.value = "";
  sendChat(text);
});
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
document.querySelectorAll("#suggestions button").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent)));
$("#new-chat").addEventListener("click", () => { history = []; store.del("chat"); renderChat(); input.focus(); });

// ---------- Чек-лист ----------
const clForm = $("#checklist-form");
const clOut = $("#checklist-result");

function renderChecklist(d) {
  const checked = store.get("checked", {});
  const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  clOut.innerHTML = `<div class="card">
      <div class="result-head">
        <div><h2>${esc(d.visa_type)}</h2><p class="muted">${esc(d.summary)}</p></div>
        <button id="print-cl" class="no-print">🖨️ Распечатать / PDF</button>
      </div>
      <div class="progress"><div class="row"><b>Документы</b><span id="cl-count" class="muted"></span></div><div class="progress-bar"><div id="cl-bar"></div></div></div>
      ${d.documents.map((doc, i) => `<label class="doc${checked[i] ? " done" : ""}"><input type="checkbox" data-i="${i}" ${checked[i] ? "checked" : ""} />
        <div><b>${esc(doc.name)}</b><span class="badge ${doc.required ? "req" : "opt"}">${doc.required ? "обязательно" : "желательно"}</span>
        <div class="muted">${esc(doc.details)}</div></div></label>`).join("")}
    </div>
    <div class="card"><h3 style="margin-top:0">🧭 Порядок действий</h3><ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div>
    <div class="info-grid">
      <div class="card"><h3 style="margin-top:0">⏱️ Сроки</h3><p>${esc(d.timing)}</p></div>
      <div class="card"><h3 style="margin-top:0">💳 Сборы</h3><p>${esc(d.fees)}</p></div>
    </div>
    <div class="card"><h3 style="margin-top:0">💡 Советы</h3>${list(d.tips)}</div>
    <div class="card"><h3 style="margin-top:0">🔗 Где проверить актуальные требования</h3>${list(d.official_sources)}</div>`;

  const update = () => {
    const boxes = [...clOut.querySelectorAll(".doc input")];
    const done = boxes.filter((b) => b.checked).length;
    $("#cl-count").textContent = `собрано ${done} из ${boxes.length}`;
    $("#cl-bar").style.width = boxes.length ? `${(done / boxes.length) * 100}%` : "0";
  };
  clOut.querySelectorAll(".doc input").forEach((cb) => cb.addEventListener("change", () => {
    const c = store.get("checked", {});
    c[cb.dataset.i] = cb.checked;
    store.set("checked", c);
    cb.closest(".doc").classList.toggle("done", cb.checked);
    update();
  }));
  $("#print-cl").addEventListener("click", () => window.print());
  update();
}

const savedCl = store.get("checklist", null);
if (savedCl) renderChecklist(savedCl);

clForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = clForm.querySelector("button");
  btn.disabled = true;
  clOut.innerHTML = '<div class="card loading"><div class="spinner"></div>Анализирую требования… это может занять до минуты.</div>';
  try {
    const res = await fetch("/api/checklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(clForm))),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    store.set("checklist", d);
    store.del("checked");
    renderChecklist(d);
    clOut.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    clOut.innerHTML = `<div class="card msg error" style="max-width:100%">⚠️ ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Письмо ----------
const lForm = $("#letter-form");
const lWrap = $("#letter-wrap");
const lOut = $("#letter-result");

lForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = lForm.querySelector("button");
  btn.disabled = true;
  lWrap.classList.remove("hidden");
  lOut.innerHTML = '<span class="loading"><span class="spinner"></span>Пишу письмо…</span>';
  let text = "";
  try {
    await streamPost("/api/letter", Object.fromEntries(new FormData(lForm)), (t) => { text += t; lOut.textContent = text; });
  } catch (err) {
    lOut.textContent = "⚠️ " + err.message;
  } finally {
    btn.disabled = false;
  }
});
$("#copy-letter").addEventListener("click", (e) => navigator.clipboard.writeText(lOut.textContent).then(() => { e.target.textContent = "Скопировано ✓"; setTimeout(() => (e.target.textContent = "Копировать"), 1500); }));
$("#download-letter").addEventListener("click", () => download("soprovoditelnoe-pismo.txt", lOut.textContent));
