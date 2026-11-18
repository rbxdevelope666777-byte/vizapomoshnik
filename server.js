import express from "express";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.set("trust proxy", 1); // реальный IP посетителя за хостингом

// ---------- Защита ключа: лимит запросов к ИИ ----------
// RATE_LIMIT — сколько запросов с одного IP в час (по умолчанию 30)
// DAILY_LIMIT — сколько запросов всего в сутки на весь сайт (по умолчанию 500)
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 30);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 500);
const hits = new Map();
let day = new Date().toDateString(), dayCount = 0;
app.use("/api", (req, res, next) => {
  const now = Date.now();
  if (new Date().toDateString() !== day) { day = new Date().toDateString(); dayCount = 0; }
  if (dayCount >= DAILY_LIMIT) return res.status(429).json({ error: "Сайт исчерпал дневной лимит запросов. Попробуйте завтра." });
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 3600_000);
  if (list.length >= RATE_LIMIT) return res.status(429).json({ error: "Слишком много запросов. Попробуйте через час." });
  list.push(now); hits.set(req.ip, list); dayCount++;
  if (hits.size > 10000) hits.clear();
  next();
});
app.use(express.static(path.join(here, "public")));

// Ключ — OPENAI_API_KEY; адрес сервиса (для посредников) — OPENAI_BASE_URL
// Клиент создаётся при первом запросе, чтобы сайт запускался даже без ключа
let client;
// .trim() убирает случайные пробелы/переносы строки, попавшие при копировании
const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "") || undefined;
const ai = () =>
  (client ??= new OpenAI({
    apiKey: clean(process.env.OPENAI_API_KEY),
    baseURL: clean(process.env.OPENAI_BASE_URL),
  }));
const MODEL = (process.env.OPENAI_MODEL || "gpt-5.4-mini").trim();

const SYSTEM_PROMPT = `Ты — «ВизаПомощник», ИИ-консультант по визам и въездным документам.
Отвечай на русском языке (если пользователь пишет на другом языке — на его языке).
Твоя задача: помогать разобраться с типом визы, списком документов, порядком подачи,
сроками, сборами, записью в визовый центр, заполнением анкет, сопроводительными письмами.

Правила:
- Задавай уточняющие вопросы, если не хватает данных: гражданство, страна проживания,
  страна назначения, цель поездки, сроки, предыдущие визы/отказы.
- Структурируй ответы: короткие заголовки, списки, пошаговые инструкции.
- Требования и сборы меняются. Всегда указывай, что актуальность нужно проверить
  на официальном сайте консульства/визового центра, и называй, где именно искать.
- Не выдумывай точные суммы, адреса и ссылки, если не уверен — так и скажи.
- Никогда не помогай подделывать документы, вводить консульство в заблуждение
  или обходить закон. Если просят — вежливо откажи и предложи законный путь.
- Ты не юрист; в сложных случаях (отказы, депортация, нарушения режима) советуй
  обратиться к иммиграционному юристу.`;

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function streamToClient(res, params) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    let sent = false;
    try {
      const stream = await ai().chat.completions.create({ model: MODEL, stream: true, ...params });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const text = delta?.content || delta?.refusal;
        if (text) { sent = true; sendSSE(res, { type: "text", text }); }
      }
    } catch (err) {
      // Ключ/баланс/модель — сразу показываем ошибку; иначе пробуем без стриминга
      if (sent || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.RateLimitError ||
          err instanceof OpenAI.NotFoundError || /OPENAI_API_KEY/.test(err?.message || "")) throw err;
      console.warn("Стриминг не сработал, пробую обычный запрос:", err?.message);
    }
    if (!sent) {
      const r = await ai().chat.completions.create({ model: MODEL, ...params });
      const m = r.choices?.[0]?.message;
      const text = m?.content || m?.refusal;
      if (!text) throw new Error("ИИ вернул пустой ответ. Попробуйте другую модель (OPENAI_MODEL).");
      sendSSE(res, { type: "text", text });
    }
    sendSSE(res, { type: "done" });
  } catch (err) {
    sendSSE(res, { type: "error", message: describeError(err) });
  } finally {
    res.end();
  }
}

function describeError(err) {
  if (err instanceof OpenAI.AuthenticationError) {
    console.error("Сервис отклонил ключ:", err.status, err.message);
    return "Сервис отклонил API-ключ (OPENAI_API_KEY). Ответ сервиса: " + err.message;
  }
  if (/OPENAI_API_KEY/.test(err?.message || "")) return "API-ключ не задан (OPENAI_API_KEY).";
  if (err instanceof OpenAI.PermissionDeniedError) {
    console.error("Доступ запрещён:", err.status, err.message);
    return "Сервис запретил доступ (возможно, блокирует сервер хостинга). Ответ: " + err.message;
  }
  if (err instanceof OpenAI.RateLimitError) {
    if (err.code === "insufficient_quota") return "На балансе OpenAI нет денег. Пополните его на platform.openai.com → Billing.";
    return "Слишком много запросов. Подождите немного и повторите.";
  }
  if (err instanceof OpenAI.NotFoundError) return `Модель «${MODEL}» недоступна для вашего ключа. Укажите другую в OPENAI_MODEL.`;
  if (err instanceof OpenAI.BadRequestError) return "Некорректный запрос: " + err.message;
  if (err instanceof OpenAI.APIConnectionError) return "Нет связи с OpenAI. Проверьте интернет (или VPN).";
  if (err instanceof OpenAI.APIError) return "Ошибка API: " + err.message;
  console.error(err);
  return "Ошибка: " + (err?.message || String(err));
}

// ---------- 1. Чат-консультант ----------
app.post("/api/chat", async (req, res) => {
  const history = Array.isArray(req.body.messages) ? req.body.messages : [];
  const messages = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-30)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "Последнее сообщение должно быть от пользователя." });
  }

  await streamToClient(res, {
    max_completion_tokens: 16000,
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
  });
});

// ---------- 2. Чек-лист документов (структурированный JSON) ----------
const CHECKLIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["visa_type", "summary", "documents", "steps", "timing", "fees", "tips", "official_sources"],
  properties: {
    visa_type: { type: "string", description: "Рекомендуемый тип/категория визы" },
    summary: { type: "string", description: "Краткое резюме в 2-3 предложения" },
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "details", "required"],
        properties: {
          name: { type: "string" },
          details: { type: "string" },
          required: { type: "boolean", description: "true — обязательный, false — желательный" },
        },
      },
    },
    steps: { type: "array", items: { type: "string" } },
    timing: { type: "string", description: "Сроки рассмотрения и когда подавать" },
    fees: { type: "string", description: "Ориентировочные сборы с оговоркой" },
    tips: { type: "array", items: { type: "string" } },
    official_sources: { type: "array", items: { type: "string" }, description: "Где проверить актуальные требования" },
  },
};

app.post("/api/checklist", async (req, res) => {
  const { citizenship, residence, destination, purpose, duration, notes } = req.body || {};
  if (!citizenship || !destination || !purpose) {
    return res.status(400).json({ error: "Укажите гражданство, страну назначения и цель поездки." });
  }
  const prompt = `Составь персональный чек-лист для получения визы.
Гражданство: ${citizenship}
Страна проживания: ${residence || "та же, что гражданство"}
Страна назначения: ${destination}
Цель поездки: ${purpose}
Длительность: ${duration || "не указана"}
Дополнительно: ${notes || "нет"}

Если виза не нужна (безвизовый режим) — так и укажи в visa_type и summary, а в documents перечисли то, что нужно на границе.`;

  try {
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: String(prompt).slice(0, 6000) },
    ];
    let response;
    try {
      response = await ai().chat.completions.create({
        model: MODEL,
        max_completion_tokens: 16000,
        response_format: {
          type: "json_schema",
          json_schema: { name: "visa_checklist", strict: true, schema: CHECKLIST_SCHEMA },
        },
        messages,
      });
    } catch (err) {
      // Некоторые прокси-сервисы не поддерживают response_format — просим JSON текстом
      if (!(err instanceof OpenAI.BadRequestError)) throw err;
      response = await ai().chat.completions.create({
        model: MODEL,
        max_completion_tokens: 16000,
        messages: [
          ...messages,
          { role: "user", content: "Ответь ТОЛЬКО JSON-объектом (без markdown) по этой JSON-схеме:\n" + JSON.stringify(CHECKLIST_SCHEMA) },
        ],
      });
    }
    const msg = response.choices[0].message;
    if (msg.refusal) return res.status(422).json({ error: msg.refusal });
    const raw = msg.content || "";
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    let data;
    try { data = JSON.parse(json); } catch { return res.status(502).json({ error: "ИИ вернул ответ в неверном формате. Попробуйте ещё раз." }); }
    for (const k of ["documents", "steps", "tips", "official_sources"]) if (!Array.isArray(data[k])) data[k] = [];
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: describeError(err) });
  }
});

// ---------- 3. Сопроводительное письмо ----------
app.post("/api/letter", async (req, res) => {
  const f = req.body || {};
  if (!f.fullName || !f.destination || !f.purpose) {
    return res.status(400).json({ error: "Укажите ФИО, страну назначения и цель поездки." });
  }
  const prompt = `Напиши сопроводительное письмо (cover letter) в консульство для визовой заявки.
Язык письма: ${f.language || "английский"}.
Данные заявителя:
- ФИО: ${f.fullName}
- Гражданство: ${f.citizenship || "-"}
- Страна назначения: ${f.destination}
- Цель поездки: ${f.purpose}
- Даты поездки: ${f.dates || "-"}
- Место работы / должность: ${f.job || "-"}
- Финансирование поездки: ${f.funding || "-"}
- Связи с родиной (семья, недвижимость, работа): ${f.ties || "-"}
- Дополнительно: ${f.extra || "-"}

Требования: официальный деловой стиль, правдиво, только на основе указанных данных,
без выдуманных фактов. Где данных не хватает — оставь плейсхолдер в [квадратных скобках].
Выведи только текст письма, без пояснений.`;

  await streamToClient(res, {
    max_completion_tokens: 8000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: prompt.slice(0, 8000) },
    ],
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ВизаПомощник: http://localhost:${PORT}  (модель: ${MODEL}, сервис: ${process.env.OPENAI_BASE_URL || "api.openai.com"})`);
  const k = clean(process.env.OPENAI_API_KEY);
  if (k) console.log(`Ключ: ${k.slice(0, 5)}…${k.slice(-3)} (длина ${k.length})`);
  if (!k) console.warn("⚠️  OPENAI_API_KEY не задан — запросы к ИИ работать не будут.");
});
