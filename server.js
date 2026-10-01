const express = require("express");
const cors = require("cors");

const { computeChart } = require("free-human-design");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Human Design server is working!");
});

app.get("/api/chart", (req, res) => {
  try {
    const {
      date,
      time,
      timezone
    } = req.query;

    if (!date || !time || !timezone) {
      return res.status(400).json({
        error: "Необходимо указать date, time и timezone"
      });
    }

    const chart = computeChart({
      birthdate: date,
      birthtime: time,
      timezone
    });

    res.json(chart);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Ошибка расчёта карты",
      details: error.message
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server started on port ${PORT}`);
});
