import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const router = express.Router();

const uploadDir = path.resolve("uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },

  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

router.post("/foto", upload.single("foto"), (req, res) => {
  console.log(req.file);

  if (!req.file) {
    return res.status(400).json({
      error: "No se subió archivo",
    });
  }

  res.json({
    ok: true,
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
  });
});

export default router;