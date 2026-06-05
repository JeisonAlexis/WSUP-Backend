import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const ITEMS_PER_PAGE = 10;

const normalizar = (str = "") =>
  String(str)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// ============================================================
// BÚSQUEDA CON PAGINACIÓN Y LIQUIDACIONES POR ESTUDIANTE
// ============================================================
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const page = parseInt(req.query.page || "1", 10);

    if (!q) {
      return res.status(400).json({ error: "Query requerida" });
    }

    // Normalizar búsqueda
    const searchNormalized = normalizar(q);
    const palabras = searchNormalized.split(/\s+/).filter(Boolean);

    // ------------------------------------------------------------
    // 1. Construir la condición de búsqueda sobre estudiantes+programas
    //    No podemos hacer un OR directo en SQL porque un estudiante
    //    puede tener múltiples programas. Lo más eficiente es:
    //    - Buscar estudiantes cuyo nombre/documento/usuario/etc. coincida
    //    - O que tengan al menos un programa que coincida
    // ------------------------------------------------------------
    // Para simplificar, usamos una subconsulta que devuelve los IDs de estudiante
    // que cumplen con alguna de las condiciones de búsqueda.
    // NOTA: SQLite no tiene soporte nativo para búsqueda full‑text,
    //       así que seguiremos con LIKE sobre los campos normalizados.
    //       Como es una demo/académico, es aceptable.
    
    // Construimos una condición LIKE para cada palabra
    // (en una app real usarías FTS o un índice externo)
    const conditions = palabras.map(() => `(
      LOWER(e.nombre) LIKE ? OR
      LOWER(e.documento) LIKE ? OR
      LOWER(e.usuario) LIKE ? OR
      LOWER(e.correo) LIKE ? OR
      LOWER(e.telefono) LIKE ? OR
      LOWER(e.sede) LIKE ? OR
      LOWER(e.nombre_institucion) LIKE ? OR
      EXISTS (
        SELECT 1 FROM estudiante_programa ep
        JOIN programas p ON p.id = ep.programa_id
        WHERE ep.estudiante_id = e.id AND LOWER(p.nombre) LIKE ?
      )
    )`).join(" AND ");

    // Para cada palabra, generamos 8 placeholders (los 7 de estudiante + 1 del programa)
    const args = [];
    for (const palabra of palabras) {
      const like = `%${palabra}%`;
      for (let i = 0; i < 7; i++) args.push(like);
      args.push(like); // para el nombre del programa
    }

    // Obtener IDs de estudiantes que cumplen con la búsqueda (paginados)
    const estudiantesIdsQuery = `
      SELECT e.id
      FROM estudiantes e
      WHERE ${conditions}
      ORDER BY e.id
      LIMIT ? OFFSET ?
    `;
    const paginationArgs = [...args, ITEMS_PER_PAGE, (page - 1) * ITEMS_PER_PAGE];
    const idsRes = await db.execute({
      sql: estudiantesIdsQuery,
      args: paginationArgs,
    });

    const estudianteIds = idsRes.rows.map(row => row.id);
    const totalRes = await db.execute({
      sql: `SELECT COUNT(*) as total FROM estudiantes e WHERE ${conditions}`,
      args: args,
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

    // ------------------------------------------------------------
    // 2. Obtener los datos completos de esos estudiantes y sus programas
    // ------------------------------------------------------------
    const placeholders = estudianteIds.map(() => "?").join(",");
    const estudiantesData = await db.execute({
      sql: `
        SELECT 
          e.id,
          e.documento,
          e.nombre,
          e.usuario,
          e.correo,
          e.telefono,
          e.foto,
          e.sede,
          e.id_aspirante,
          e.tipo_sanguineo,
          e.sexo,
          e.fecha_nacimiento,
          e.ciudad_nacimiento,
          e.departamento_nacimiento,
          e.pais_nacimiento,
          e.direccion,
          e.barrio,
          e.ciudad_residencia,
          e.departamento_residencia,
          e.pais_residencia,
          e.nombre_institucion,
          e.fecha_terminacion,
          e.snp_icfes,
          p.id AS programa_id,
          p.nombre AS programa_nombre,
          ep.estudiantePensum,
          ep.jornada,
          ep.categoria,
          ep.situacion
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

    // ------------------------------------------------------------
    // 3. Obtener liquidaciones para cada estudiante (solo las suyas)
    // ------------------------------------------------------------
    // Construimos un mapa: clave "estudiante_id|programa_id" -> array de liquidaciones
    const liquidacionesMap = new Map();

    // Necesitamos los pares (estudiante_id, programa_id) de los estudiantes de esta página
    const pares = [];
    for (const item of estudiantesMap.values()) {
      for (const prog of item.programas) {
        pares.push({ estudiante_id: item.estudiante.id, programa_id: prog.id });
      }
    }

    if (pares.length > 0) {
      // Podemos hacer una consulta con OR compuesto, pero para simplificar usamos IN con tupla?
      // SQLite no soporta IN con tuplas de forma directa, así que hacemos un loop con UNION o una tabla temporal.
      // Para rendimiento, construimos una condición con múltiples OR.
      const orConditions = pares.map(() => "(estudiante_id = ? AND programa_id = ?)").join(" OR ");
      const argsLiq = pares.flatMap(p => [p.estudiante_id, p.programa_id]);

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
        if (!liquidacionesMap.has(key)) {
          liquidacionesMap.set(key, []);
        }
        liquidacionesMap.get(key).push(liq);
      }
    }

    // ------------------------------------------------------------
    // 4. Armar respuesta final
    // ------------------------------------------------------------
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
// OBTENER ESTUDIANTE POR DOCUMENTO (con liquidaciones propias)
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

    // Programas del estudiante (con atributos de relación)
    const programasRes = await db.execute({
      sql: `
        SELECT 
          p.id,
          p.nombre,
          ep.estudiantePensum,
          ep.jornada,
          ep.categoria,
          ep.situacion
        FROM estudiante_programa ep
        JOIN programas p ON p.id = ep.programa_id
        WHERE ep.estudiante_id = ?
      `,
      args: [estudianteId],
    });

    const programas = programasRes.rows;

    // Liquidaciones del estudiante (solo las suyas)
    if (programas.length) {
      const programaIds = programas.map(p => p.id);
      // Para cada programa del estudiante, traemos liquidaciones donde estudiante_id = ?
      // Podemos hacer una consulta con OR
      const orConditions = programaIds.map(() => "(programa_id = ? AND estudiante_id = ?)").join(" OR ");
      const argsLiq = programaIds.flatMap(pid => [pid, estudianteId]);

      const liquidacionesDB = await db.execute({
        sql: `
          SELECT *
          FROM liquidaciones
          WHERE ${orConditions}
          ORDER BY programa_id, anio DESC, periodo DESC
        `,
        args: argsLiq,
      });

      // Agrupar por programa_id
      const liquidacionesPorPrograma = new Map();
      for (const liq of liquidacionesDB.rows) {
        if (!liquidacionesPorPrograma.has(liq.programa_id)) {
          liquidacionesPorPrograma.set(liq.programa_id, []);
        }
        liquidacionesPorPrograma.get(liq.programa_id).push(liq);
      }

      const result = programas.map(prog => ({
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
        programas: result,
      });
    } else {
      return res.json({
        estudiante: estudianteRespuesta,
        programas: [],
      });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;