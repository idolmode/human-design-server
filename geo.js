// Определение часового пояса по названию города (офлайн, без внешних сервисов).
// Данные: GeoNames (https://www.geonames.org), лицензия CC BY 4.0.
// Файл data/cities.txt (или data/cities.txt.gz) берётся из cities5000.zip / cities15000.zip с GeoNames.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const COUNTRY_HINTS = {
  россия: "RU", рф: "RU", беларусь: "BY", белоруссия: "BY", украина: "UA", казахстан: "KZ", узбекистан: "UZ",
  грузия: "GE", армения: "AM", азербайджан: "AZ", молдова: "MD", молдавия: "MD", киргизия: "KG", кыргызстан: "KG",
  таджикистан: "TJ", туркменистан: "TM", латвия: "LV", литва: "LT", эстония: "EE", германия: "DE", сша: "US",
  израиль: "IL", таиланд: "TH", тайланд: "TH", турция: "TR", китай: "CN", великобритания: "GB", англия: "GB",
  франция: "FR", италия: "IT", испания: "ES", польша: "PL", чехия: "CZ", болгария: "BG", сербия: "RS",
  канада: "CA", оаэ: "AE", вьетнам: "VN", индия: "IN", индонезия: "ID", кипр: "CY", греция: "GR"
};

const NAME_OK = /^[\p{Script=Latin}\p{Script=Cyrillic}\d\s.'-]+$/u;

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Убирает «г.», «город», «пос.» и т.п. в начале названия.
function stripPrefix(key) {
  return key.replace(/^(г|гор|город|пос|поселок|пгт|с|село|д|деревня|ст|станица|city|town)\s+/, "");
}

let index = null;

function load() {
  if (index) return index;
  const dir = path.join(__dirname, "data");
  let raw;
  if (fs.existsSync(path.join(dir, "cities.txt.gz"))) raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, "cities.txt.gz"))).toString("utf8");
  else if (fs.existsSync(path.join(dir, "cities.txt"))) raw = fs.readFileSync(path.join(dir, "cities.txt"), "utf8");
  else throw new Error("Нет файла data/cities.txt (справочник городов GeoNames)");

  const map = new Map();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const c = line.split("\t");
    if (c.length < 18 || !c[17]) continue;
    const place = {
      name: c[1],
      country: c[8],
      population: Number(c[14]) || 0,
      timezone: c[17]
    };
    const names = new Set([c[1], c[2], ...(c[3] ? c[3].split(",") : [])]);
    for (const n of names) {
      if (!n || !NAME_OK.test(n)) continue;
      const key = norm(n);
      if (!key) continue;
      const list = map.get(key);
      if (list) list.push(place);
      else map.set(key, [place]);
    }
  }
  index = map;
  return index;
}

// Ищет город. Допустимы записи вида «Москва», «г. Москва», «Александровск, Россия», «Paris, FR».
// Если подходящих городов несколько, берётся самый крупный.
function findCity(query) {
  const map = load();
  const parts = String(query || "").replace(/[()]/g, ",").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  const hintRaw = parts.slice(1).map(norm).join(" ");
  let hintCountry = null;
  for (const word of hintRaw.split(" ")) {
    if (COUNTRY_HINTS[word]) hintCountry = COUNTRY_HINTS[word];
    else if (/^[a-z]{2}$/.test(word)) hintCountry = word.toUpperCase();
  }

  const first = norm(parts[0]);
  let list = map.get(first) || map.get(stripPrefix(first));
  if (!list) return null;
  if (hintCountry) {
    const filtered = list.filter((p) => p.country === hintCountry);
    if (filtered.length) list = filtered;
  }
  const best = list.reduce((a, b) => (b.population > a.population ? b : a));
  return { name: best.name, country: best.country, timezone: best.timezone, candidates: list.length };
}

module.exports = { findCity };
