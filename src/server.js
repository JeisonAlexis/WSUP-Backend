import express from "express";
import cors from "cors";

const PORT = process.env.PORT || 3000;

import authRoutes from "./routes/auth.js";
import estudiantesRoutes from "./routes/estudiantes.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/auth", authRoutes);
app.use("/estudiantes", estudiantesRoutes);

app.listen(PORT, () => {
  console.log("Servidor corriendo en puerto", PORT);
});