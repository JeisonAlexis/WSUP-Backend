import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const ITEMS_PER_PAGE = 10;

// Función para quitar tildes y normalizar minúsculas
function normalizeString(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ñ/g, "n"); // opcional, si quieres también normalizar ñ
}

// Función para construir expresión SQL que normalice un campo (quita tildes y lower)
function normalizeField(field) {
  // Aplicamos múltiples REPLACE para quitar vocales acentuadas, diéresis, etc.
  // Esto es para SQLite, que no tiene función unaccent.
  // Se aplican en orden.
  return `
    LOWER(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      ${field},
      'á', 'a'), 'é', 'e'), 'í', 'i'), 'ó', 'o'), 'ú', 'u'),
      'Á', 'a'), 'É', 'e'), 'Í', 'i'), 'Ó', 'o'), 'Ú', 'u')
    )
  `;
}

// ----------------------------------------------------------------------
// BÚSQUEDA OPTIMIZADA con manejo de tildes y mayúsculas/minúsculas
// ----------------------------------------------------------------------
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const page = parseInt(req.query.page || "1", 10);

    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "Query requerida" });
    }

    const trimmed = q.trim();
    const normalizedQuery = normalizeString(trimmed); // búsqueda normalizada sin tildes

    // Si es solo dígitos, buscar por documento exacto (rápido)
    if (/^\d+$/.test(trimmed)) {
      const docRes = await db.execute({
        sql: `SELECT id FROM estudiantes WHERE documento = ?`,
        args: [trimmed],
      });
      const estudianteIds = docRes.rows.map(row => row.id);
      const total = estudianteIds.length;
      const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
      if (estudianteIds.length === 0) {
        return res.json({ page, totalPages, totalResults: total, results: [] });
      }
      return await enviarResultados(res, estudianteIds, page, total, totalPages);
    }

    // Dividir en palabras
    const palabras = normalizedQuery.split(/\s+/).filter(Boolean);

    // Construir condición AND por cada palabra, normalizando campos
    const condicionesPorPalabra = palabras.map(() => {
      // Normalizamos nombre, documento y programa.nombre
      const nombreNorm = normalizeField("e.nombre");
      const docNorm = normalizeField("e.documento");
      // Para la subconsulta de programas, normalizamos p.nombre
      const progNorm = normalizeField("p.nombre");
      return `(
        ${nombreNorm} LIKE ? OR 
        ${docNorm} LIKE ? OR 
        EXISTS (
          SELECT 1 
          FROM estudiante_programa ep
          JOIN programas p ON p.id = ep.programa_id
          WHERE ep.estudiante_id = e.id AND ${progNorm} LIKE ?
        )
      )`;
    }).join(" AND ");

    // Preparamos los patrones: cada palabra se busca con '%' + palabra + '%'
    const args = palabras.flatMap(p => [`%${p}%`, `%${p}%`, `%${p}%`]);

    // Consulta paginada de IDs
    const idsQuery = `
      SELECT e.id
      FROM estudiantes e
      WHERE ${condicionesPorPalabra}
      ORDER BY e.id
      LIMIT ? OFFSET ?
    `;
    const paginationArgs = [...args, ITEMS_PER_PAGE, (page - 1) * ITEMS_PER_PAGE];
    const idsRes = await db.execute({ sql: idsQuery, args: paginationArgs });
    const estudianteIds = idsRes.rows.map(row => row.id);

    // Total de resultados
    const totalRes = await db.execute({
      sql: `SELECT COUNT(*) as total FROM estudiantes e WHERE ${condicionesPorPalabra}`,
      args: args,
    });
    const total = totalRes.rows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (estudianteIds.length === 0) {
      return res.json({ page, totalPages, totalResults: total, results: [] });
    }

    return await enviarResultados(res, estudianteIds, page, total, totalPages);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ----------------------------------------------------------------------
// Función auxiliar para armar la respuesta (igual que antes, sin cambios)
// ----------------------------------------------------------------------
async function enviarResultados(res, estudianteIds, page, total, totalPages) {
  const placeholders = estudianteIds.map(() => "?").join(",");

  const estudiantesData = await db.execute({
    sql: `
      SELECT 
        e.id, e.documento, e.nombre, e.usuario, e.correo, e.telefono,
        e.foto, e.sede, e.id_aspirante, e.tipo_sanguineo, e.sexo,
        e.fecha_nacimiento, e.ciudad_nacimiento, e.departamento_nacimiento,
        e.pais_nacimiento, e.direccion, e.barrio, e.ciudad_residencia,
        e.departamento_residencia, e.pais_residencia, e.nombre_institucion,
        e.fecha_terminacion, e.snp_icfes,
        p.id AS programa_id, p.nombre AS programa_nombre,
        ep.jornada, ep.categoria, ep.situacion
      FROM estudiantes e
      LEFT JOIN estudiante_programa ep ON ep.estudiante_id = e.id
      LEFT JOIN programas p ON p.id = ep.programa_id
      WHERE e.id IN (${placeholders})
      ORDER BY e.id
    `,
    args: estudianteIds,
  });

  const estudiantesMap = new Map();
  for (const row of estudiantesData.rows) {
    if (!estudiantesMap.has(row.id)) {
      estudiantesMap.set(row.id, {
        estudiante: {
          id: row.id,
          documento: row.documento,
          nombre: row.nombre,
          usuario: row.usuario,
          correo: row.correo,
          telefono: row.telefono,
          foto: row.foto,
          sede: row.sede,
          idAspirante: row.id_aspirante,
          tipoSanguineo: row.tipo_sanguineo,
          sexo: row.sexo,
          fechaNacimiento: row.fecha_nacimiento,
          ciudadNacimiento: row.ciudad_nacimiento,
          departamentoNacimiento: row.departamento_nacimiento,
          paisNacimiento: row.pais_nacimiento,
          direccion: row.direccion,
          barrio: row.barrio,
          ciudadResidencia: row.ciudad_residencia,
          departamentoResidencia: row.departamento_residencia,
          paisResidencia: row.pais_residencia,
          nombreInstitucion: row.nombre_institucion,
          fechaTerminacion: row.fecha_terminacion,
          snpIcfes: row.snp_icfes,
        },
        programas: [],
      });
    }
    if (row.programa_id) {
      estudiantesMap.get(row.id).programas.push({
        id: row.programa_id,
        nombre: row.programa_nombre,
        jornada: row.jornada,
        categoria: row.categoria,
        situacion: row.situacion,
      });
    }
  }

  // Obtener liquidaciones
  const pares = [];
  for (const item of estudiantesMap.values()) {
    for (const prog of item.programas) {
      pares.push([item.estudiante.id, prog.id]);
    }
  }

  const liquidacionesMap = new Map();
  if (pares.length > 0) {
    const orConditions = pares.map(() => "(estudiante_id = ? AND programa_id = ?)").join(" OR ");
    const argsLiq = pares.flat();
    const liquidacionesDB = await db.execute({
      sql: `
        SELECT *
        FROM liquidaciones
        WHERE ${orConditions}
        ORDER BY programa_id, anio DESC, periodo DESC
      `,
      args: argsLiq,
    });
    for (const liq of liquidacionesDB.rows) {
      const key = `${liq.estudiante_id}|${liq.programa_id}`;
      if (!liquidacionesMap.has(key)) liquidacionesMap.set(key, []);
      liquidacionesMap.get(key).push(liq);
    }
  }

  const results = [];
  for (const item of estudiantesMap.values()) {
    const programasConLiquidaciones = item.programas.map(prog => {
      const key = `${item.estudiante.id}|${prog.id}`;
      return { ...prog, liquidaciones: liquidacionesMap.get(key) || [] };
    });
    results.push({ estudiante: item.estudiante, programas: programasConLiquidaciones });
  }

  return res.json({ page, totalPages, totalResults: total, results });
}

// ----------------------------------------------------------------------
// OBTENER ESTUDIANTE POR DOCUMENTO (sin cambios)
// ----------------------------------------------------------------------
router.get("/:documento", authMiddleware, async (req, res) => {
  try {
    const { documento } = req.params;
    const estudianteRes = await db.execute({
      sql: `SELECT * FROM estudiantes WHERE documento = ?`,
      args: [documento],
    });
    if (!estudianteRes.rows.length) {
      return res.status(404).json({ error: "No encontrado" });
    }
    const est = estudianteRes.rows[0];
    const estudianteId = est.id;

    const estudianteRespuesta = {
      id: est.id, documento: est.documento, nombre: est.nombre, usuario: est.usuario,
      correo: est.correo, telefono: est.telefono, foto: est.foto, sede: est.sede,
      idAspirante: est.id_aspirante, tipoSanguineo: est.tipo_sanguineo, sexo: est.sexo,
      fechaNacimiento: est.fecha_nacimiento, ciudadNacimiento: est.ciudad_nacimiento,
      departamentoNacimiento: est.departamento_nacimiento, paisNacimiento: est.pais_nacimiento,
      direccion: est.direccion, barrio: est.barrio, ciudadResidencia: est.ciudad_residencia,
      departamentoResidencia: est.departamento_residencia, paisResidencia: est.pais_residencia,
      nombreInstitucion: est.nombre_institucion, fechaTerminacion: est.fecha_terminacion,
      snpIcfes: est.snp_icfes,
    };

    const programasRes = await db.execute({
      sql: `
        SELECT p.id, p.nombre, ep.jornada, ep.categoria, ep.situacion
        FROM estudiante_programa ep
        JOIN programas p ON p.id = ep.programa_id
        WHERE ep.estudiante_id = ?
      `,
      args: [estudianteId],
    });
    const programas = programasRes.rows;

    if (programas.length === 0) {
      return res.json({ estudiante: estudianteRespuesta, programas: [] });
    }

    const programaIds = programas.map(p => p.id);
    const liquidacionesDB = await db.execute({
      sql: `
        SELECT *
        FROM liquidaciones
        WHERE estudiante_id = ? AND programa_id IN (${programaIds.map(() => "?").join(",")})
        ORDER BY programa_id, anio DESC, periodo DESC
      `,
      args: [estudianteId, ...programaIds],
    });

    const liquidacionesPorPrograma = new Map();
    for (const liq of liquidacionesDB.rows) {
      if (!liquidacionesPorPrograma.has(liq.programa_id)) liquidacionesPorPrograma.set(liq.programa_id, []);
      liquidacionesPorPrograma.get(liq.programa_id).push(liq);
    }

    const resultProgramas = programas.map(prog => ({
      ...prog,
      liquidaciones: liquidacionesPorPrograma.get(prog.id) || [],
    }));

    return res.json({ estudiante: estudianteRespuesta, programas: resultProgramas });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;