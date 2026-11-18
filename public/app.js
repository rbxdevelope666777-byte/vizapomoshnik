// ---------- Вкладки ----------
document.querySelectorAll(".tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab, .panel").forEach((el) => el.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  })
);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

// ---------- Чат ----------
const history = [];
const box = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");

function addMsg(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function sendChat(text) {
  history.push({ role: "user", content: text });
  addMsg("user", text);
  const out = addMsg("assistant", "…");
  const btn = form.querySelector("button");
  btn.disabled = true;
  let answer = "";
  try {
    await streamPost("/api/chat", { messages: history }, (t) => {
      answer += t;
      out.textContent = answer;
      box.scrollTop = box.scrollHeight;
    });
    history.push({ role: "assistant", content: answer });
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
  if (!text) return;
  input.value = "";
  sendChat(text);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
document.querySelectorAll(".suggestions button").forEach((b) => b.addEventListener("click", () => sendChat(b.textContent)));

// ---------- Чек-лист ----------
const clForm = document.getElementById("checklist-form");
const clOut = document.getElementById("checklist-result");

clForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = clForm.querySelector("button");
  btn.disabled = true;
  clOut.innerHTML = '<div class="card spinner">⏳ Анализирую требования... это может занять до минуты.</div>';
  try {
    const res = await fetch("/api/checklist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(clForm))),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    const list = (arr) => `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
    clOut.innerHTML = `<div class="card">
      <h2>${esc(d.visa_type)}</h2>
      <p>${esc(d.summary)}</p>
      <h3>Документы</h3>
      ${d.documents.map((doc) => `<label class="doc"><input type="checkbox" />
        <div><b style="color:var(--text)">${esc(doc.name)}</b>
        <span class="badge ${doc.required ? "req" : "opt"}">${doc.required ? "обязательно" : "желательно"}</span>
        <div class="muted">${esc(doc.details)}</div></div></label>`).join("")}
      <h3>Порядок действий</h3><ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <h3>Сроки</h3><p>${esc(d.timing)}</p>
      <h3>Сборы</h3><p>${esc(d.fees)}</p>
      <h3>Советы</h3>${list(d.tips)}
      <h3>Официальные источники</h3>${list(d.official_sources)}
    </div>`;
  } catch (err) {
    clOut.innerHTML = `<div class="card msg error">⚠️ ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Письмо ----------
const lForm = document.getElementById("letter-form");
const lWrap = document.getElementById("letter-wrap");
const lOut = document.getElementById("letter-result");

lForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = lForm.querySelector("button");
  btn.disabled = true;
  lWrap.classList.remove("hidden");
  lOut.textContent = "⏳ Пишу письмо...";
  let text = "";
  try {
    await streamPost("/api/letter", Object.fromEntries(new FormData(lForm)), (t) => {
      text += t;
      lOut.textContent = text;
    });
  } catch (err) {
    lOut.textContent = "⚠️ " + err.message;
  } finally {
    btn.disabled = false;
  }
});
document.getElementById("copy-letter").addEventListener("click", () => navigator.clipboard.writeText(lOut.textContent));
