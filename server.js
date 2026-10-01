const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { computeChart } = require("free-human-design");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
app.set("trust proxy", 1); // за прокси хостинга (нужно для корректного IP в лимитах)
app.use(cors());
app.use(express.json());

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
  return { date, time, timezone };
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
  res.json({ ok: true });
});

app.get("/api/chart", chartHandler);
// Alias for external integrations such as GetCourse.
app.get("/api/bodygraph", chartHandler);

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
      const url = publicBase
        ? `${publicBase}/${key}`
        : await getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 7 * 24 * 3600 });
      res.json({ url });
    } catch (error) {
      console.error("Save PNG error:", error);
      res.status(500).json({ error: "Не удалось сохранить картинку" });
    }
  }
);

app.get("/bodygraph", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(__dirname + "/bodygraph_server.html");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
