# Human Design Server

Express API for calculating Human Design charts and serving a BodyGraph page.

## Local run

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000/bodygraph?date=1990-01-01&time=12:30&timezone=Asia/Bangkok
```

## API

```text
GET /api/chart?date=YYYY-MM-DD&time=HH:mm&timezone=Area/City
GET /api/bodygraph?date=YYYY-MM-DD&time=HH:mm&timezone=Area/City
```

Both endpoints return the chart JSON produced by `free-human-design`.

`/api/bodygraph` is an alias intended for external integrations such as GetCourse.

## Health check

```text
GET /health
```
