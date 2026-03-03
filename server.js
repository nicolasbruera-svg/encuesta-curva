const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const ExcelJS = require("exceljs");
const QRCode = require("qrcode");

const app = express();
const db = new sqlite3.Database("./database.db");

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// --- DB setup + pequeña migración (agrega columnas si faltan) ---
function ensureColumns() {
  db.all(`PRAGMA table_info(encuestas)`, (err, cols) => {
    if (err) return;
    const have = new Set(cols.map(c => c.name));
    const add = (sql) => db.run(sql, () => {});

    if (!have.has("precio_calidad")) add(`ALTER TABLE encuestas ADD COLUMN precio_calidad INTEGER`);
    if (!have.has("device_id")) add(`ALTER TABLE encuestas ADD COLUMN device_id TEXT`);
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS encuestas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT,
      nombre TEXT,
      telefono TEXT,

      atencion INTEGER,
      espera INTEGER,
      comida INTEGER,
      limpieza INTEGER,
      precio_calidad INTEGER,

      recomendarias TEXT,
      comentario TEXT,

      premio_tipo TEXT,
      premio_texto TEXT,
      codigo TEXT,

      usado INTEGER DEFAULT 0,
      usado_fecha DATETIME,

      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_encuestas_device_fecha ON encuestas(device_id, fecha)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_encuestas_codigo ON encuestas(codigo)`);

  ensureColumns();
});

// --- premios ---
function generarPremio() {
  // 60% → 10% descuento
  // 20% → 15% descuento
  // 15% → Botella de vino
  // 5%  → 20% descuento
  const r = Math.random();
  if (r < 0.60) return { tipo: "DESCUENTO", texto: "10% de descuento" };
  if (r < 0.80) return { tipo: "DESCUENTO", texto: "15% de descuento" };
  if (r < 0.95) return { tipo: "VINO", texto: "Una botella de vino" };
  return { tipo: "DESCUENTO", texto: "20% de descuento" };
}

function generarCodigo() {
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `CLV-${rand}`;
}

// --- encuesta: check por device_id del día ---
app.get("/check", (req, res) => {
  const device_id = req.query.device_id;
  if (!device_id) return res.json({ found: false });

  db.get(
    `SELECT premio_tipo, premio_texto, codigo
     FROM encuestas
     WHERE device_id = ?
       AND date(fecha,'localtime') = date('now','localtime')
     ORDER BY id DESC
     LIMIT 1`,
    [device_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.json({ found: false });
      return res.json({
        found: true,
        premio_tipo: row.premio_tipo,
        premio_texto: row.premio_texto,
        codigo: row.codigo,
      });
    }
  );
});

// --- guardar encuesta ---
app.post("/guardar", (req, res) => {
  const {
    device_id,
    nombre,
    telefono,
    atencion,
    espera,
    comida,
    limpieza,
    precio_calidad,
    recomendarias,
    comentario,
  } = req.body;

  if (!device_id) return res.status(400).json({ error: "device_id requerido" });

  const nom = String(nombre || "").trim();
  const tel = String(telefono || "").trim();

  if (!nom) return res.status(400).json({ error: "Nombre es obligatorio" });
  if (!tel) return res.status(400).json({ error: "Teléfono es obligatorio" });

  // Teléfono: solo números, 8 a 10 dígitos (tope 10)
  if (!/^\d{8,10}$/.test(tel)) {
    return res.status(400).json({ error: "Teléfono inválido (8 a 10 dígitos, solo números)" });
  }

  const campos = { atencion, espera, comida, limpieza, precio_calidad, recomendarias };
  for (const [k, v] of Object.entries(campos)) {
    if (v === undefined || v === null || v === "") {
      return res.status(400).json({ error: `Falta campo: ${k}` });
    }
  }

  const rec = String(recomendarias);
  if (rec !== "SI" && rec !== "NO") {
    return res.status(400).json({ error: "Recomendarías debe ser SI o NO" });
  }

  // Si ya participó hoy: devolver cupón existente
  db.get(
    `SELECT premio_tipo, premio_texto, codigo
     FROM encuestas
     WHERE device_id = ?
       AND date(fecha,'localtime') = date('now','localtime')
     ORDER BY id DESC
     LIMIT 1`,
    [device_id],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });

      if (row) {
        return res.json({
          already: true,
          premio_tipo: row.premio_tipo,
          premio_texto: row.premio_texto,
          codigo: row.codigo,
        });
      }

      const premio = generarPremio();
      const codigo = generarCodigo();

      db.run(
        `INSERT INTO encuestas
         (device_id,nombre,telefono,atencion,espera,comida,limpieza,precio_calidad,recomendarias,comentario,premio_tipo,premio_texto,codigo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          device_id,
          nom,
          tel,
          Number(atencion),
          Number(espera),
          Number(comida),
          Number(limpieza),
          Number(precio_calidad),
          rec,
          String(comentario || "").trim(),
          premio.tipo,
          premio.texto,
          codigo,
        ],
        (err2) => {
          if (err2) return res.status(500).json({ error: "DB insert error" });
          return res.json({
            already: false,
            premio_tipo: premio.tipo,
            premio_texto: premio.texto,
            codigo,
          });
        }
      );
    }
  );
});

// --- QR ---
app.get("/qr/:codigo", async (req, res) => {
  try {
    const codigo = String(req.params.codigo || "").trim();
    if (!codigo) return res.status(400).send("Código inválido");

    res.setHeader("Content-Type", "image/png");
    const pngBuffer = await QRCode.toBuffer(codigo, { type: "png", margin: 1, scale: 8 });
    res.send(pngBuffer);
  } catch {
    res.status(500).send("Error generando QR");
  }
});

// --- Admin JSON ---
app.get("/admin", (req, res) => {
  db.all("SELECT * FROM encuestas ORDER BY fecha DESC", [], (err, rows) => {
    if (err) return res.status(500).send("Error");
    res.json(rows);
  });
});
app.get("/export", (req, res) => {
  res.redirect("/export.xlsx");
});
// --- Export Excel (incluye device_id) ---
app.get("/export.xlsx", async (req, res) => {
  db.all(
    `SELECT
      fecha,device_id,nombre,telefono,
      atencion,espera,comida,limpieza,precio_calidad,
      recomendarias,comentario,
      premio_texto,codigo,usado,usado_fecha
     FROM encuestas
     ORDER BY fecha DESC`,
    async (err, rows) => {
      if (err) return res.status(500).send("Error");

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Encuestas");

      ws.columns = [
        { header: "Fecha", key: "fecha", width: 22 },
        { header: "Device ID", key: "device_id", width: 36 },

        { header: "Nombre", key: "nombre", width: 22 },
        { header: "Teléfono", key: "telefono", width: 16 },

        { header: "Atención", key: "atencion", width: 10 },
        { header: "Espera", key: "espera", width: 10 },
        { header: "Comida", key: "comida", width: 10 },
        { header: "Limpieza", key: "limpieza", width: 10 },
        { header: "Precio/Calidad", key: "precio_calidad", width: 14 },

        { header: "Recomendarías", key: "recomendarias", width: 14 },
        { header: "¿Qué mejorarías?", key: "comentario", width: 40 },

        { header: "Obsequio", key: "premio_texto", width: 22 },
        { header: "Código", key: "codigo", width: 14 },
        { header: "Usado", key: "usado", width: 8 },
        { header: "Usado fecha", key: "usado_fecha", width: 22 },
      ];

      ws.getRow(1).font = { bold: true };
      rows.forEach((r) => ws.addRow(r));

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", 'attachment; filename="encuestas.xlsx"');

      await wb.xlsx.write(res);
      res.end();
    }
  );
});

// --- CAJA: validar/canjear (sin espera) ---
app.get("/api/validar", (req, res) => {
  const codigo = String(req.query.codigo || "").trim();
  if (!codigo) return res.status(400).json({ error: "Código requerido" });

  db.get(
    `SELECT codigo, premio_texto, usado, usado_fecha
     FROM encuestas
     WHERE codigo = ?
     LIMIT 1`,
    [codigo],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.json({ existe: false });

      return res.json({
        existe: true,
        codigo: row.codigo,
        premio_texto: row.premio_texto,
        usado: !!row.usado,
        usado_fecha: row.usado_fecha || null,
        habilitado: true,
      });
    }
  );
});

app.post("/api/canjear", (req, res) => {
  const codigo = String(req.body.codigo || "").trim();
  if (!codigo) return res.status(400).json({ error: "Código requerido" });

  db.get(
    `SELECT usado, premio_texto
     FROM encuestas
     WHERE codigo = ?
     LIMIT 1`,
    [codigo],
    (err, row) => {
      if (err) return res.status(500).json({ error: "DB error" });
      if (!row) return res.status(404).json({ error: "Código inexistente" });
      if (row.usado) return res.json({ ok: false, estado: "USADO", premio_texto: row.premio_texto });

      db.run(
        `UPDATE encuestas
         SET usado = 1, usado_fecha = datetime('now','localtime')
         WHERE codigo = ?`,
        [codigo],
        (err2) => {
          if (err2) return res.status(500).json({ error: "DB update error" });
          return res.json({ ok: true, estado: "CANJEADO", premio_texto: row.premio_texto });
        }
      );
    }
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor corriendo en puerto " + PORT));