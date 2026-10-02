const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { computeChart } = require("free-human-design");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { renderSvg, svgToPng, fontCount } = require("./render");
const { normalizeDate, normalizeTime, writeFieldsToGetCourse } = require("./gc");
const { findCity } = require("./geo");

const app = express();
app.set("trust proxy", 1); // за прокси хостинга (нужно для корректного IP в лимитах)
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// GetCourse может прислать тело без нужного Content-Type. Для вебхука разбираем его сами.
app.use("/api/gc", express.text({ type: () => true, limit: "100kb" }), (req, res, next) => {
  if (typeof req.body === "string" && req.body.trim()) {
    const raw = req.body.trim();
    try {
      req.body = JSON.parse(raw);
    } catch {
      req.body = Object.fromEntries(new URLSearchParams(raw));
    }
  }
  next();
});

// ---------- Хранилище S3 (Рег.ру) ----------
// Всё задаётся переменными окружения, ключи в код не вписываем.
const s3 = process.env.S3_BUCKET
  ? new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
      credentials: {
        accessKeyId: process.env.S3_KEY,
        secretAccessKey: process.env.S3_SECRET
      }
    })
  : null;

// Простейший лимит: не более 10 загрузок с одного IP за 10 минут.
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60 * 1000).unref();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 10) return res.status(429).json({ error: "Слишком много запросов, попробуйте позже" });
  list.push(now);
  hits.set(req.ip, list);
  next();
}

function getBirthParams(req) {
  const { date, time, timezone } = req.query;
  if (!date || !time || !timezone) {
    const error = new Error("Необходимо указать date, time и timezone");
    error.status = 400;
    throw error;
  }
  return { date: normalizeDate(date), time: normalizeTime(time), timezone: String(timezone).trim() };
}

function calculateChart({ date, time, timezone }) {
  return computeChart({
    birthdate: date,
    birthtime: time,
    timezone
  });
}

function chartHandler(req, res) {
  try {
    const params = getBirthParams(req);
    const chart = calculateChart(params);
    res.json(chart);
  } catch (error) {
    console.error("Chart error:", error);
    res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : "Ошибка расчёта карты",
      details: error.status === 400 ? undefined : error.message
    });
  }
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Human Design API",
    endpoints: {
      chart: "/api/chart?date=YYYY-MM-DD&time=HH:mm&timezone=Area/City",
      bodygraph: "/bodygraph?date=YYYY-MM-DD&time=HH:mm&timezone=Area/City"
    }
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, fonts: fontCount });
});

app.get("/api/chart", chartHandler);
// Alias for external integrations such as GetCourse.
app.get("/api/bodygraph", chartHandler);

// Загружает PNG в бакет и возвращает ссылку (постоянную или временную на 7 дней).
async function uploadPng(buf) {
  if (!s3) {
    const error = new Error("Хранилище не настроено");
    error.status = 503;
    throw error;
  }
  const key = `bodygraph/${crypto.randomUUID()}-${crypto.randomBytes(8).toString("hex")}.png`;
  const Bucket = process.env.S3_BUCKET;
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: key,
      Body: buf,
      ContentType: "image/png",
      CacheControl: "public, max-age=31536000"
    })
  );
  // Бакет публичный на чтение: ссылка постоянная. Иначе: временная, 7 дней.
  const publicBase = (process.env.S3_PUBLIC_BASE || "").replace(/\/+$/, "");
  return publicBase
    ? `${publicBase}/${key}`
    : await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 7 * 24 * 3600 });
}

// Сохранение PNG в облачное хранилище. Тело запроса: сам файл image/png.
app.post(
  "/api/save-png",
  rateLimit,
  express.raw({ type: "image/png", limit: "2mb" }),
  async (req, res) => {
    try {
      if (!s3) return res.status(503).json({ error: "Хранилище не настроено" });
      const buf = req.body;
      const isPng =
        Buffer.isBuffer(buf) && buf.length > 100 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
      if (!isPng) return res.status(400).json({ error: "Ожидается PNG-файл" });

      const url = await uploadPng(buf);
      res.json({ url });
    } catch (error) {
      console.error("Save PNG error:", error);
      res.status(500).json({ error: "Не удалось сохранить картинку" });
    }
  }
);

// Если передан city, а timezone нет, определяем часовой пояс по городу.
function resolveTimezone(input) {
  if (input.timezone || !input.city) return { place: null };
  const found = findCity(input.city);
  if (!found) {
    const error = new Error(`Город не найден: ${input.city}`);
    error.status = 400;
    throw error;
  }
  input.timezone = found.timezone;
  return { place: `${found.name}, ${found.country} (${found.timezone})` };
}

// Проверка определения города: /api/geo?city=Москва
app.get("/api/geo", rateLimit, (req, res) => {
  try {
    const found = findCity(req.query.city);
    if (!found) return res.status(404).json({ error: "Город не найден" });
    res.json(found);
  } catch (error) {
    console.error("Geo error:", error);
    res.status(500).json({ error: "Справочник городов недоступен" });
  }
});

// PNG бодиграфа, нарисованный на сервере (для проверки и для ссылок в письмах).
app.get("/api/bodygraph.png", rateLimit, (req, res) => {
  try {
    const input = { ...req.query };
    resolveTimezone(input);
    const png = svgToPng(renderSvg(calculateChart(getBirthParams({ query: input }))));
    res.set("Cache-Control", "no-store").type("image/png").send(png);
  } catch (error) {
    console.error("Render PNG error:", error);
    res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : "Не удалось построить картинку"
    });
  }
});

// ---------- Приём данных от GetCourse (процесс -> «Вызвать URL») ----------
// Принимает email, date, time, city (или timezone) и токен. Рисует PNG, кладёт в бакет
// и записывает ссылку в дополнительное поле клиента GetCourse.
function tokenState(req) {
  const expected = process.env.GC_WEBHOOK_TOKEN;
  if (!expected) return null; // интеграция не настроена
  const given = String(req.get("x-token") || req.query.token || (req.body && req.body.token) || "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function processGetCourseJob(input) {
  const email = input.email ? String(input.email).trim() : "";
  const noteField = process.env.GETCOURSE_NOTE_FIELD; // необязательное поле для заметки (место или ошибка)
  const linkField = process.env.GETCOURSE_LINK_FIELD || "Ссылка на BodyGraph";
  try {
    const { place } = resolveTimezone(input);
    const params = getBirthParams({ query: input });
    const png = svgToPng(renderSvg(calculateChart(params)));
    const url = await uploadPng(png);
    const fields = { [linkField]: url };
    if (noteField) fields[noteField] = place ? `Место определено: ${place}` : "Бодиграф построен";
    const getcourse = email ? await writeFieldsToGetCourse({ email, fields }) : { skipped: true };
    return { url, place, getcourse };
  } catch (error) {
    // Чтобы менеджер увидел причину в карточке клиента.
    if (noteField && email) {
      await writeFieldsToGetCourse({ email, fields: { [noteField]: `Ошибка: ${error.message}`.slice(0, 250) } }).catch(() => {});
    }
    throw error;
  }
}

app.all("/api/gc/bodygraph", async (req, res) => {
  const ok = tokenState(req);
  if (ok === null) return res.status(503).json({ error: "Интеграция не настроена" });
  if (!ok) {
    const keys = Object.keys({ ...req.query, ...(typeof req.body === "object" && req.body ? req.body : {}) });
    console.warn(`GC webhook: неверный токен. method=${req.method} content-type=${req.get("content-type") || "-"} получены поля: ${keys.join(", ") || "нет"}`);
    return res.status(403).json({ error: "Неверный токен" });
  }

  const input = { ...req.query, ...(req.body || {}) };
  if (!input.date || !input.time || !(input.timezone || input.city)) {
    // В логах только названия полей и признак «заполнено», без самих значений.
    const state = ["email", "date", "time", "city", "timezone"].map((k) => `${k}=${input[k] ? "есть" : "пусто"}`).join(", ");
    console.warn(`GC webhook: не хватает данных. method=${req.method} content-type=${req.get("content-type") || "-"} ${state}`);
    return res.status(400).json({ error: "Необходимо указать date, time и city (или timezone)" });
  }

  // Для проверки вручную: добавьте sync=1, и сервер дождётся результата.
  if (input.sync === "1") {
    try {
      return res.json({ ok: true, ...(await processGetCourseJob(input)) });
    } catch (error) {
      console.error("GetCourse job error:", error);
      return res.status(error.status || 500).json({ error: "Не удалось обработать запрос", details: error.message });
    }
  }

  // Обычный режим: сразу отвечаем GetCourse, работу делаем в фоне.
  res.status(202).json({ ok: true });
  processGetCourseJob(input)
    .then((r) => console.log("GetCourse job done:", r.url, JSON.stringify(r.getcourse)))
    .catch((error) => console.error("GetCourse job error:", error));
});

app.get("/bodygraph", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(__dirname + "/bodygraph_server.html");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
