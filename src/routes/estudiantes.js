import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const ITEMS_PER_PAGE = 10;

// Función para normalizar texto en SQL (eliminar tildes y pasar a minúscula)
const normalizarSQL = (str) => {
  let normalized = str.toLowerCase();
  const acentos = {
    á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u',
    ñ: 'n', Á: 'a', É: 'e', Í: 'i', Ó: 'o', Ú: 'u', Ñ: 'n'
  };
  for (let [acc, sin] of Object.entries(acentos)) {
    normalized = normalized.replace(new RegExp(acc, 'g'), sin);
  }
  return normalized;
};

router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const page = parseInt(req.query.page || "1");

    if (!q) {
      return res.status(400).json({ error: "Query requerida" });
    }

    // Normalizar la búsqueda
    const busqueda = normalizarSQL(q);
    const palabras = busqueda.split(" ").filter(Boolean);

    // Construir condiciones WHERE para búsqueda en múltiples columnas
    let whereConditions = [];
    const args = [];

    // Para cada palabra, agregamos condiciones que busquen en todas las columnas relevantes
    for (let palabra of palabras) {
      const likePattern = `%${palabra}%`;
      whereConditions.push(`
        ( LOWER(e.nombre) LIKE ? OR
          LOWER(e.documento) LIKE ? OR
          LOWER(e.usuario) LIKE ? OR
          LOWER(e.correo) LIKE ? OR
          LOWER(e.telefono) LIKE ? OR
          LOWER(e.sede) LIKE ? OR
          LOWER(e.nombre_institucion) LIKE ? )
      `);
      // Agregamos 7 argumentos por cada palabra (una por cada columna)
      for (let i = 0; i < 7; i++) args.push(likePattern);
    }

    const whereClause = whereConditions.length
      ? `WHERE ${whereConditions.join(" AND ")}`
      : "";

    // 1. Primero contar el total de resultados (sin paginación)
    const countSQL = `
      SELECT COUNT(DISTINCT e.id) as total
      FROM estudiantes e
      LEFT JOIN programas p ON p.estudiante_id = e.id
      ${whereClause}
    `;
    const countResult = await db.execute({ sql: countSQL, args });
    const total = countResult.rows[0]?.total || 0;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const offset = (page - 1) * ITEMS_PER_PAGE;

    if (total === 0) {
      return res.json({
        page,
        totalPages: 0,
        totalResults: 0,
        results: []
      });
    }

    // 2. Obtener los IDs de estudiantes de la página actual
    const idsSQL = `
      SELECT DISTINCT e.id
      FROM estudiantes e
      LEFT JOIN programas p ON p.estudiante_id = e.id
      ${whereClause}
      ORDER BY e.id
      LIMIT ? OFFSET ?
    `;
    const idsResult = await db.execute({ sql: idsSQL, args: [...args, ITEMS_PER_PAGE, offset] });
    const estudianteIds = idsResult.rows.map(row => row.id);
    if (estudianteIds.length === 0) {
      return res.json({ page, totalPages, totalResults: total, results: [] });
    }

    // 3. Obtener todos los estudiantes con sus programas y liquidaciones en pocas consultas
    const placeholders = estudianteIds.map(() => "?").join(",");
    const estudiantesSQL = `
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
        p.id as programa_id,
        p.nombre as programa_nombre,
        p.estudiantePensum,
        p.jornada,
        p.categoria,
        p.situacion
      FROM estudiantes e
      LEFT JOIN programas p ON p.estudiante_id = e.id
      WHERE e.id IN (${placeholders})
      ORDER BY e.id
    `;
    const estudiantesData = await db.execute({ sql: estudiantesSQL, args: estudianteIds });

    // 4. Agrupar estudiantes y programas
    const estudiantesMap = new Map();
    const programaIds = [];

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
          programas: []
        });
      }
      if (row.programa_id) {
        const prog = {
          id: row.programa_id,
          nombre: row.programa_nombre,
          estudiantePensum: row.estudiantePensum,
          jornada: row.jornada,
          categoria: row.categoria,
          situacion: row.situacion,
        };
        estudiantesMap.get(row.id).programas.push(prog);
        programaIds.push(row.programa_id);
      }
    }

    // 5. Obtener todas las liquidaciones de los programas en una sola consulta
    const liquidacionesMap = new Map(); // programa_id -> liquidaciones[]
    if (programaIds.length > 0) {
      const progPlaceholders = programaIds.map(() => "?").join(",");
      const liqSQL = `
        SELECT * FROM liquidaciones
        WHERE programa_id IN (${progPlaceholders})
        ORDER BY anio DESC, periodo DESC
      `;
      const liquidacionesData = await db.execute({ sql: liqSQL, args: programaIds });
      for (const liq of liquidacionesData.rows) {
        if (!liquidacionesMap.has(liq.programa_id)) {
          liquidacionesMap.set(liq.programa_id, []);
        }
        liquidacionesMap.get(liq.programa_id).push(liq);
      }
    }

    // 6. Armar resultado final
    const results = [];
    for (const item of estudiantesMap.values()) {
      const programasConLiq = item.programas.map(prog => ({
        ...prog,
        liquidaciones: liquidacionesMap.get(prog.id) || []
      }));
      results.push({
        estudiante: item.estudiante,
        programas: programasConLiq
      });
    }

    res.json({
      page,
      totalPages,
      totalResults: total,
      results
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/:documento", authMiddleware, async (req, res) => {
  try {
    const { documento } = req.params;

    const estudiante = await db.execute({
      sql: `
        SELECT 
          id,
          documento,
          nombre,
          usuario,
          correo,
          telefono,
          foto,
          sede,
          id_aspirante,
          tipo_sanguineo,
          sexo,
          fecha_nacimiento,
          ciudad_nacimiento,
          departamento_nacimiento,
          pais_nacimiento,
          direccion,
          barrio,
          ciudad_residencia,
          departamento_residencia,
          pais_residencia,
          nombre_institucion,
          fecha_terminacion,
          snp_icfes
        FROM estudiantes
        WHERE documento = ?
      `,
      args: [documento],
    });

    if (!estudiante.rows.length) {
      return res.status(404).json({ error: "No encontrado" });
    }

    const est = estudiante.rows[0];

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

    const programas = await db.execute({
      sql: `SELECT * FROM programas WHERE estudiante_id = ?`,
      args: [est.id],
    });

    const result = [];
    for (const prog of programas.rows) {
      const liquidaciones = await db.execute({
        sql: `SELECT * FROM liquidaciones WHERE programa_id = ? ORDER BY anio DESC, periodo DESC`,
        args: [prog.id],
      });
      result.push({
        ...prog,
        liquidaciones: liquidaciones.rows,
      });
    }

    res.json({
      estudiante: estudianteRespuesta,
      programas: result,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;