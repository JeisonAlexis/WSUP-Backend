import express from "express";
import { db } from "../db.js";
import { authMiddleware } from "../middleware/authMiddleware.js";

const router = express.Router();

const ITEMS_PER_PAGE = 10;

const normalizar = (str = "") =>
  str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

router.get(
  "/search",
  authMiddleware,
  async (req, res) => {
    try {
      const { q } = req.query;
      const page = parseInt(req.query.page || "1");

      if (!q) {
        return res.status(400).json({ error: "Query requerida" });
      }

      const palabras = normalizar(q).split(" ").filter(Boolean);

      // Incluir todos los nuevos campos en la consulta
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

            p.id as programa_id,
            p.nombre as programa_nombre,
            p.estudiantePensum,
            p.jornada,
            p.categoria,
            p.situacion

          FROM estudiantes e
          LEFT JOIN programas p 
            ON p.estudiante_id = e.id
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
              correo: row.correo,
              telefono: row.telefono,
              foto: row.foto,
              sede: row.sede,
              // Nuevos campos (estudiante table)
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
        const correo = normalizar(item.estudiante.correo || "");
        const telefono = normalizar(item.estudiante.telefono || "");
        const sede = normalizar(item.estudiante.sede || "");
        // Opcional: permitir búsqueda también en los nuevos campos (p.ej. nombreInstitucion)
        const nombreInstitucion = normalizar(item.estudiante.nombreInstitucion || "");
        const programas = item.programas.map((p) => normalizar(p.nombre));

        const coincide = palabras.every((palabra) => {
          return (
            nombre.includes(palabra) ||
            documento.includes(palabra) ||
            usuario.includes(palabra) ||
            correo.includes(palabra) ||
            telefono.includes(palabra) ||
            sede.includes(palabra) ||
            nombreInstitucion.includes(palabra) ||
            programas.some((p) => p.includes(palabra))
          );
        });

        if (coincide) {
          filtrados.push(item);
        }
      }

      const total = filtrados.length;
      const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
      const start = (page - 1) * ITEMS_PER_PAGE;
      const end = start + ITEMS_PER_PAGE;
      const paginaActual = filtrados.slice(start, end);

      const resultadoFinal = [];

      for (const item of paginaActual) {
        const programasConLiquidaciones = [];

        for (const prog of item.programas) {
          const liquidaciones = await db.execute({
            sql: `SELECT * FROM liquidaciones WHERE programa_id = ? ORDER BY anio DESC, periodo DESC`,
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

      res.json({
        page,
        totalPages,
        totalResults: total,
        results: resultadoFinal,
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

router.get(
  "/:documento",
  authMiddleware,
  async (req, res) => {
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

      // Mapear a camelCase para la respuesta
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
  }
);

export default router;