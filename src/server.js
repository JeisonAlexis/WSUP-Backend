import express from "express";
import cors from "cors";
import path from "path";

const PORT = process.env.PORT || 3000;

import authRoutes from "./routes/auth.js";
import estudiantesRoutes from "./routes/estudiantes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use(
  "/fotos_contactos",
  express.static(path.resolve("fotos_contactos"))
);

app.use("/auth", authRoutes);
app.use("/estudiantes", estudiantesRoutes);

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});