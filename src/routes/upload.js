import express from "express";
import multer from "multer";
import path from "path";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    cb(null, "fotos_contactos/");
  },

  filename: (_, file, cb) => {
    cb(null, file.originalname);
  },
});

const upload = multer({ storage });

router.post(
  "/foto",
  upload.single("foto"),
  (req, res) => {
    res.json({
      ok: true,
      archivo: req.file.filename,
    });
  }
);

export default router;