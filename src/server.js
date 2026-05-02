import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import estudiantesRoutes from "./routes/estudiantes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/estudiantes", estudiantesRoutes);

app.listen(3000, () => {
  console.log("Servidor corriendo en http://localhost:3000");
});