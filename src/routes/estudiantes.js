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
// BÚSQUEDA CON PAGINACIÓN (usa JOIN con estudiante_programa)
// ============================================================
router.get("/search", authMiddleware, async (req, res) => {
  try {
    const { q } = req.query;
    const page = parseInt(req.query.page || "1", 10);

    if (!q) {
      return res.status(400).json({ error: "Query requerida" });
    }

    const palabras = normalizar(q)
      .split(/\s+/)
      .filter(Boolean);

    // 1. Obtener todos los estudiantes con sus programas asociados
    //    (ahora a través de la tabla estudiante_programa)
    const estudiantesDB = await db.execute({
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
      `,
    });

    // 2. Agrupar los programas por estudiante
    const estudiantesMap = new Map();

    for (const row of estudiantesDB.rows) {
      let estudiante = estudiantesMap.get(row.id);

      if (!estudiante) {
        estudiante = {
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
        };

        estudiantesMap.set(row.id, estudiante);
      }

      if (row.programa_id) {
        estudiante.programas.push({
          id: row.programa_id,
          nombre: row.programa_nombre,
          estudiantePensum: row.estudiantePensum,
          jornada: row.jornada,
          categoria: row.categoria,
          situacion: row.situacion,
        });
      }
    }

    // 3. Filtrar por las palabras de búsqueda
    const filtrados = [];

    for (const item of estudiantesMap.values()) {
      const textoBusqueda = normalizar([
        item.estudiante.nombre,
        item.estudiante.documento,
        item.estudiante.usuario,
        item.estudiante.correo,
        item.estudiante.telefono,
        item.estudiante.sede,
        item.estudiante.nombreInstitucion,
        ...item.programas.map((p) => p.nombre),
      ].join(" "));

      const coincide = palabras.every((palabra) =>
        textoBusqueda.includes(palabra)
      );

      if (coincide) {
        filtrados.push(item);
      }
    }

    // 4. Paginación
    const total = filtrados.length;
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    const start = (page - 1) * ITEMS_PER_PAGE;
    const paginaActual = filtrados.slice(start, start + ITEMS_PER_PAGE);

    // 5. Obtener liquidaciones para los programas que aparecen en la página actual
    const programaIds = paginaActual.flatMap((e) =>
      e.programas.map((p) => p.id)
    );

    let liquidacionesMap = new Map();

    if (programaIds.length) {
      const placeholders = programaIds.map(() => "?").join(",");
      const liquidacionesDB = await db.execute({
        sql: `
          SELECT *
          FROM liquidaciones
          WHERE programa_id IN (${placeholders})
          ORDER BY programa_id, anio DESC, periodo DESC
        `,
        args: programaIds,
      });

      liquidacionesMap = liquidacionesDB.rows.reduce((map, liq) => {
        if (!map.has(liq.programa_id)) {
          map.set(liq.programa_id, []);
        }
        map.get(liq.programa_id).push(liq);
        return map;
      }, new Map());
    }

    // 6. Armar respuesta final
    const resultadoFinal = paginaActual.map((item) => ({
      estudiante: item.estudiante,
      programas: item.programas.map((prog) => ({
        ...prog,
        liquidaciones: liquidacionesMap.get(prog.id) || [],
      })),
    }));

    return res.json({
      page,
      totalPages,
      totalResults: total,
      results: resultadoFinal,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ============================================================
// OBTENER ESTUDIANTE POR DOCUMENTO (con sus programas y liquidaciones)
// ============================================================
router.get("/:documento", authMiddleware, async (req, res) => {
  try {
    const { documento } = req.params;

    // 1. Obtener datos del estudiante
    const estudianteRes = await db.execute({
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

    if (!estudianteRes.rows.length) {
      return res.status(404).json({ error: "No encontrado" });
    }

    const est = estudianteRes.rows[0];

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

    // 2. Obtener los programas asociados al estudiante (desde estudiante_programa)
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
      args: [est.id],
    });

    const programas = programasRes.rows;
    const programaIds = programas.map((p) => p.id);

    // 3. Obtener liquidaciones para esos programas
    let liquidacionesMap = new Map();

    if (programaIds.length) {
      const placeholders = programaIds.map(() => "?").join(",");
      const liquidacionesDB = await db.execute({
        sql: `
          SELECT *
          FROM liquidaciones
          WHERE programa_id IN (${placeholders})
          ORDER BY programa_id, anio DESC, periodo DESC
        `,
        args: programaIds,
      });

      liquidacionesMap = liquidacionesDB.rows.reduce((map, liq) => {
        if (!map.has(liq.programa_id)) {
          map.set(liq.programa_id, []);
        }
        map.get(liq.programa_id).push(liq);
        return map;
      }, new Map());
    }

    // 4. Armar respuesta
    const result = programas.map((prog) => ({
      id: prog.id,
      nombre: prog.nombre,
      estudiantePensum: prog.estudiantePensum,
      jornada: prog.jornada,
      categoria: prog.categoria,
      situacion: prog.situacion,
      liquidaciones: liquidacionesMap.get(prog.id) || [],
    }));

    return res.json({
      estudiante: estudianteRespuesta,
      programas: result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;