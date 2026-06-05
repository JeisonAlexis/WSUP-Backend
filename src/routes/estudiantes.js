import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const ITEMS_PER_PAGE = 10;

/**
 * NOTA: Se requiere una tabla FTS5 y los siguientes índices para optimizar las consultas.
 * Ejecutar una vez (migración) en la base de datos Turso/SQLite:
 *
 * -- Tabla FTS5 para búsqueda rápida (combina datos del estudiante y nombres de programas)
 * CREATE VIRTUAL TABLE IF NOT EXISTS estudiantes_fts USING fts5(
 *   search_text,
 *   content=estudiantes,
 *   content_rowid=id
 * );
 *
 * -- Poblar inicialmente la tabla FTS (se debe actualizar con triggers o mediante código)
 * INSERT INTO estudiantes_fts(rowid, search_text)
 * SELECT e.id,
 *        lower(
 *          coalesce(e.nombre,'') || ' ' ||
 *          coalesce(e.documento,'') || ' ' ||
 *          coalesce(e.usuario,'') || ' ' ||
 *          coalesce(e.correo,'') || ' ' ||
 *          coalesce(e.telefono,'') || ' ' ||
 *          coalesce(e.sede,'') || ' ' ||
 *          coalesce(e.nombre_institucion,'') || ' ' ||
 *          coalesce(
 *            (SELECT group_concat(p.nombre, ' ')
 *             FROM estudiante_programa ep
 *             JOIN programas p ON p.id = ep.programa_id
 *             WHERE ep.estudiante_id = e.id), '')
 *        )
 * FROM estudiantes e;
 *
 * -- Índices para liquidaciones y relaciones
 * CREATE INDEX IF NOT EXISTS idx_liquidaciones_estudiante_programa ON liquidaciones(estudiante_id, programa_id);
 * CREATE INDEX IF NOT EXISTS idx_liquidaciones_programa_estudiante ON liquidaciones(programa_id, estudiante_id);
 * CREATE INDEX IF NOT EXISTS idx_estudiante_programa_estudiante ON estudiante_programa(estudiante_id);
 * CREATE INDEX IF NOT EXISTS idx_estudiante_programa_programa ON estudiante_programa(programa_id);
 * CREATE INDEX IF NOT EXISTS idx_estudiantes_documento ON estudiantes(documento);
 *
 * -- Mantener FTS sincronizada mediante triggers (opcional, o actualizar desde la app)
 */

// ============================================================
// BÚSQUEDA CON PAGINACIÓN Y LIQUIDACIONES (optimizada con FTS)
// ============================================================
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const page = parseInt(req.query.page || "1", 10);

    if (!q) {
      return res.status(400).json({ error: "Query requerida" });
    }

    // Construir query para FTS5: cada palabra se busca con prefijo (búsqueda parcial)
    const palabras = q.trim().split(/\s+/).filter(Boolean);
    const ftsQuery = palabras.map(p => `"${p}*"`).join(" "); // ej: "juan*" "perez*"

    // 1. Obtener IDs de estudiantes mediante FTS (paginado)
    const idsQuery = `
      SELECT rowid as id
      FROM estudiantes_fts
      WHERE estudiantes_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `;
    const idsRes = await db.execute({
      sql: idsQuery,
      args: [ftsQuery, ITEMS_PER_PAGE, (page - 1) * ITEMS_PER_PAGE],
    });

    const estudianteIds = idsRes.rows.map(row => row.id);

    // Total de resultados sin paginación
    const totalRes = await db.execute({
      sql: `SELECT COUNT(*) as total FROM estudiantes_fts WHERE estudiantes_fts MATCH ?`,
      args: [ftsQuery],
    });
    const total = totalRes.rows[0].total;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

    if (estudianteIds.length === 0) {
      return res.json({
        page,
        totalPages,
        totalResults: total,
        results: [],
      });
    }

    // 2. Obtener datos completos de estudiantes y sus programas en una sola consulta
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
          ep.estudiantePensum, ep.jornada, ep.categoria, ep.situacion
        FROM estudiantes e
        LEFT JOIN estudiante_programa ep ON ep.estudiante_id = e.id
        LEFT JOIN programas p ON p.id = ep.programa_id
        WHERE e.id IN (${placeholders})
        ORDER BY e.id
      `,
      args: estudianteIds,
    });

    // Agrupar programas por estudiante
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
          estudiantePensum: row.estudiantePensum,
          jornada: row.jornada,
          categoria: row.categoria,
          situacion: row.situacion,
        });
      }
    }

    // 3. Obtener todas las liquidaciones de estos estudiantes (una sola consulta)
    //    Usamos IN con subconsulta o con los IDs directamente.
    //    Construimos una lista de (estudiante_id, programa_id) y usamos una consulta con OR compuesta,
    //    pero mejor usar una tabla temporal o una condición con JOIN.
    //    Como los pares no son muchos (máximo estudiantes * programas por página), creamos una condición IN con tuplas simulada:
    //    " (estudiante_id, programa_id) IN (VALUES (?,?), (?,?)... ) " no es soportado en SQLite directamente,
    //    así que usamos ORs pero con índices será rápido si el número de pares es pequeño (< 200).
    const pares = [];
    for (const item of estudiantesMap.values()) {
      for (const prog of item.programas) {
        pares.push([item.estudiante.id, prog.id]);
      }
    }

    const liquidacionesMap = new Map(); // key "estudiante_id|programa_id" -> array
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

    // 4. Armar respuesta final
    const results = [];
    for (const item of estudiantesMap.values()) {
      const programasConLiquidaciones = item.programas.map(prog => {
        const key = `${item.estudiante.id}|${prog.id}`;
        return {
          ...prog,
          liquidaciones: liquidacionesMap.get(key) || [],
        };
      });
      results.push({
        estudiante: item.estudiante,
        programas: programasConLiquidaciones,
      });
    }

    return res.json({
      page,
      totalPages,
      totalResults: total,
      results,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ============================================================
// OBTENER ESTUDIANTE POR DOCUMENTO (con liquidaciones)
// ============================================================
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
      id: est.id,
      documento: est.documento,
      nombre: est.nombre,
      usuario: est.usuario,
      correo: est.correo,
      telefono: est.telefono,
      foto: est.foto,
      sede: est.sede,
      idAspirante: est.id_aspirante,
      tipoSanguineo: est.tipo_sanguineo,
      sexo: est.sexo,
      fechaNacimiento: est.fecha_nacimiento,
      ciudadNacimiento: est.ciudad_nacimiento,
      departamentoNacimiento: est.departamento_nacimiento,
      paisNacimiento: est.pais_nacimiento,
      direccion: est.direccion,
      barrio: est.barrio,
      ciudadResidencia: est.ciudad_residencia,
      departamentoResidencia: est.departamento_residencia,
      paisResidencia: est.pais_residencia,
      nombreInstitucion: est.nombre_institucion,
      fechaTerminacion: est.fecha_terminacion,
      snpIcfes: est.snp_icfes,
    };

    // Programas del estudiante
    const programasRes = await db.execute({
      sql: `
        SELECT 
          p.id, p.nombre,
          ep.estudiantePensum, ep.jornada, ep.categoria, ep.situacion
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
    // Obtener liquidaciones con un solo IN (aprovechando índice compuesto)
    const liquidacionesDB = await db.execute({
      sql: `
        SELECT *
        FROM liquidaciones
        WHERE estudiante_id = ? AND programa_id IN (${programaIds.map(() => '?').join(',')})
        ORDER BY programa_id, anio DESC, periodo DESC
      `,
      args: [estudianteId, ...programaIds],
    });

    const liquidacionesPorPrograma = new Map();
    for (const liq of liquidacionesDB.rows) {
      if (!liquidacionesPorPrograma.has(liq.programa_id)) {
        liquidacionesPorPrograma.set(liq.programa_id, []);
      }
      liquidacionesPorPrograma.get(liq.programa_id).push(liq);
    }

    const resultProgramas = programas.map(prog => ({
      id: prog.id,
      nombre: prog.nombre,
      estudiantePensum: prog.estudiantePensum,
      jornada: prog.jornada,
      categoria: prog.categoria,
      situacion: prog.situacion,
      liquidaciones: liquidacionesPorPrograma.get(prog.id) || [],
    }));

    return res.json({
      estudiante: estudianteRespuesta,
      programas: resultProgramas,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;