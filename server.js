const express = require("express");
const cors = require("cors");
const { computeChart } = require("free-human-design");

const app = express();
app.use(cors());
app.use(express.json());

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

app.get("/bodygraph", (req, res) => {
  res.sendFile(__dirname + "/bodygraph.html");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
