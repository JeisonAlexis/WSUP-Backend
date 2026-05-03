import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

// Normalizar texto
const normalizar = (str = "") =>
  str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

router.get("/search", authMiddleware, async (req, res) => {
  const { q } = req.query;

  if (!q) return res.status(400).json({ error: "Query requerida" });

  const palabras = normalizar(q).split(" ").filter(Boolean);

  const estudiantesDB = await db.execute({
    sql: `
      SELECT 
        e.id,
        e.documento,
        e.nombre,
        e.usuario,

        p.id as programa_id,
        p.nombre as programa_nombre,
        p.estudiantePensum,
        p.jornada,
        p.categoria,
        p.situacion

      FROM estudiantes e
      LEFT JOIN programas p ON p.estudiante_id = e.id
    `,
  });

  const mapa = new Map();

  for (const row of estudiantesDB.rows) {
    if (!mapa.has(row.id)) {
      mapa.set(row.id, {
        estudiante: {
          id: row.id,
          documento: row.documento,
          nombre: row.nombre,
          usuario: row.usuario,
        },
        programas: [],
      });
    }

    if (row.programa_id) {
      mapa.get(row.id).programas.push({
        id: row.programa_id,
        nombre: row.programa_nombre,
        estudiantePensum: row.estudiantePensum,
        jornada: row.jornada,
        categoria: row.categoria,
        situacion: row.situacion,
      });
    }
  }

  const filtrados = [];

  for (const item of mapa.values()) {
    const nombre = normalizar(item.estudiante.nombre);
    const documento = item.estudiante.documento;
    const usuario = normalizar(item.estudiante.usuario || "");

    const programas = item.programas.map((p) =>
      normalizar(p.nombre)
    );

    const coincide = palabras.every((palabra) => {
      return (
        nombre.includes(palabra) ||
        documento.includes(palabra) ||
        usuario.includes(palabra) ||
        programas.some((p) => p.includes(palabra))
      );
    });

    if (coincide) filtrados.push(item);
  }

  const resultadoFinal = [];

  for (const item of filtrados) {
    const programasConLiquidaciones = [];

    for (const prog of item.programas) {
      const liquidaciones = await db.execute({
        sql: "SELECT * FROM liquidaciones WHERE programa_id = ?",
        args: [prog.id],
      });

      programasConLiquidaciones.push({
        ...prog,
        liquidaciones: liquidaciones.rows,
      });
    }

    resultadoFinal.push({
      estudiante: item.estudiante,
      programas: programasConLiquidaciones,
    });
  }

  res.json(resultadoFinal);
});

export default router;