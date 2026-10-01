// Вспомогательные функции для интеграции с GetCourse.

// Приводит дату к виду YYYY-MM-DD (понимает также DD.MM.YYYY и DD/MM/YYYY).
function normalizeDate(value) {
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return s;
}

// Приводит время к виду HH:mm (понимает 9:05, 09.05, 09:05:00).
function normalizeTime(value) {
  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{1,2})[:.](\d{2})/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return s;
}

// Записывает значения в дополнительные поля клиента GetCourse (импорт пользователя по API).
// Клиент ищется по email; если такого нет, GetCourse создаст нового.
async function writeFieldsToGetCourse({ email, fields }) {
  const account = process.env.GETCOURSE_ACCOUNT;
  const key = process.env.GETCOURSE_KEY;
  if (!account || !key) return { skipped: true };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""))) throw new Error("GetCourse: некорректный email");
  if (!fields || !Object.keys(fields).length) return { skipped: true };

  const host = process.env.GETCOURSE_HOST || `${account}.getcourse.ru`;
  const params = {
    user: { email, addfields: fields },
    system: { refresh_if_exists: 1 }
  };
  const body = new URLSearchParams({
    action: "add",
    key,
    params: Buffer.from(JSON.stringify(params), "utf8").toString("base64")
  });

  const r = await fetch(`https://${host}/pl/api/users`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(`GetCourse: неожиданный ответ (HTTP ${r.status})`);
  }
  const failed = (v) => v === false || v === "false";
  if (failed(d.success) || failed(d.result?.success) || d.result?.error === true || d.result?.error === "true") {
    throw new Error("GetCourse: " + (d.error || d.result?.error_message || "ошибка импорта"));
  }
  return { ok: true, user_id: d.result?.user_id };
}

module.exports = { normalizeDate, normalizeTime, writeFieldsToGetCourse };
