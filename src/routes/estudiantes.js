import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();
const ITEMS_PER_PAGE = 10;

// Normalización en JavaScript (para la query)
const normalizar = (str = "") =>
  str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

// Función SQL que normaliza una cadena (elimina tildes y pasa a minúsculas)
// Se usará en cada columna comparada.
const sqlNormalize = (col) => `
  LOWER(
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      ${col},
      'á','a'), 'é','e'), 'í','i'), 'ó','o'), 'ú','u'),
      'Á','A'), 'É','E'), 'Í','I'), 'Ó','O'), 'Ú','U')
  )
`;

router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    let page = parseInt(req.query.page || "1");
    if (isNaN(page)) page = 1;

    if (!q) {
      return res.status(400).json({ error: "Query requerida" });
    }

    const palabras = normalizar(q).split(" ").filter(Boolean);
    if (palabras.length === 0) {
      return res.status(400).json({ error: "Consulta vacía" });
    }

    // Construir condiciones para cada palabra (AND entre palabras)
    // Cada palabra debe cumplir: (estudiante cumple en algún campo) OR (algún programa cumple)
    const whereParts = [];
    const args = [];

    for (const palabra of palabras) {
      const likePattern = `%${palabra}%`;

      // Condición para el estudiante (8 campos)
      const estudianteCond = `
        ( ${sqlNormalize("e.nombre")} LIKE ? OR
          e.documento LIKE ? OR
          ${sqlNormalize("e.usuario")} LIKE ? OR
          ${sqlNormalize("e.correo")} LIKE ? OR
          e.telefono LIKE ? OR
          ${sqlNormalize("e.sede")} LIKE ? OR
          ${sqlNormalize("e.nombre_institucion")} LIKE ? )
      `;
      // Condición para programas (EXISTS)
      const programaCond = `
        EXISTS (
          SELECT 1 FROM programas p
          WHERE p.estudiante_id = e.id
            AND ${sqlNormalize("p.nombre")} LIKE ?
        )
      `;
      whereParts.push(`( ${estudianteCond} OR ${programaCond} )`);
      // Agregar argumentos: 8 para estudiante + 1 para programa = 9 por palabra
      for (let i = 0; i < 8; i++) args.push(likePattern);
      args.push(likePattern);
    }

    const whereClause = `WHERE ${whereParts.join(" AND ")}`;

    // 1. Contar total de estudiantes distintos (para paginación)
    const countSQL = `
      SELECT COUNT(DISTINCT e.id) as total
      FROM estudiantes e
      ${whereClause}
    `;
    const countRes = await db.execute({ sql: countSQL, args });
    const total = countRes.rows[0]?.total || 0;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const offset = (page - 1) * ITEMS_PER_PAGE;

    if (total === 0) {
      return res.json({ page, totalPages: 0, totalResults: 0, results: [] });
    }

    // 2. Obtener los IDs de los estudiantes de la página actual
    const idsSQL = `
      SELECT DISTINCT e.id
      FROM estudiantes e
      ${whereClause}
      ORDER BY e.id
      LIMIT ? OFFSET ?
    `;
    const idsArgs = [...args, ITEMS_PER_PAGE, offset];
    const idsRes = await db.execute({ sql: idsSQL, args: idsArgs });
    const estudianteIds = idsRes.rows.map(row => row.id);

    if (estudianteIds.length === 0) {
      return res.json({ page, totalPages, totalResults: total, results: [] });
    }

    // 3. Obtener TODOS los datos de esos estudiantes y sus programas (sin liquidaciones aún)
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

    // 4. Agrupar estudiantes y guardar lista de programas_ids
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
          programas: [],
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

    // 5. Obtener todas las liquidaciones de esos programas en UNA consulta
    const liquidacionesMap = new Map(); // key: programa_id, value: array de liquidaciones
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

    // 6. Construir la respuesta final (mismo formato que el original)
    const results = [];
    for (const item of estudiantesMap.values()) {
      const programasConLiquidaciones = item.programas.map(prog => ({
        ...prog,
        liquidaciones: liquidacionesMap.get(prog.id) || []
      }));
      results.push({
        estudiante: item.estudiante,
        programas: programasConLiquidaciones,
      });
    }

    res.json({
      page,
      totalPages,
      totalResults: total,
      results,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

router.get("/:documento", authMiddleware, async (req, res) => {
  // Este endpoint ya era eficiente (por índice en documento). Solo se adaptan los nombres de campo.
  try {
    const { documento } = req.params;

    const estudiante = await db.execute({
      sql: `
        SELECT 
          id, documento, nombre, usuario, correo, telefono, foto, sede,
          id_aspirante, tipo_sanguineo, sexo, fecha_nacimiento,
          ciudad_nacimiento, departamento_nacimiento, pais_nacimiento,
          direccion, barrio, ciudad_residencia, departamento_residencia,
          pais_residencia, nombre_institucion, fecha_terminacion, snp_icfes
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
      result.push({ ...prog, liquidaciones: liquidaciones.rows });
    }

    res.json({ estudiante: estudianteRespuesta, programas: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;