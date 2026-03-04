
// ===============================
// SGQT-PRINT-3.0 — BACKEND ROUTE
// ===============================

const express = require("express");
const app = express();
const { generatePrintPack } = require("./backend/reports/print_pack");

app.use(express.json({ limit: process.env.VSC_PRINT_JSON_LIMIT || "10mb" }));
app.use(express.urlencoded({ extended: true, limit: process.env.VSC_PRINT_JSON_LIMIT || "10mb" }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({
      ok: false,
      error: "PAYLOAD_TOO_LARGE",
      message: "Envie apenas o ID do atendimento."
    });
  }
  next(err);
});

app.get("/api/atendimentos/print-pack", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: "MISSING_ID" });

    // ADAPTAR PARA SEU PROJETO:
    const atendimento = await global.dbGetAtendimentoById(id);
    const anexosRaw = await global.dbGetAnexosByAtendimentoId(id);

    const anexos = (anexosRaw || []).map(a => ({
      tipo: a.mime?.startsWith("image/") ? "imagem" : "pdf",
      nome: a.nome || a.filename || "anexo",
      data: a.data || a.createdAt || "",
      dataUrl: a.dataUrl || null,
      pdfBuffer: a.buffer || null
    }));

    const { pdf, hash } = await generatePrintPack({ atendimento, anexos });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="PrintPack_${id}.pdf"`);
    res.setHeader("X-SGQT-PRINT", "SGQT-PRINT-3.0");
    res.setHeader("X-SGQT-HASH", hash);

    res.status(200).send(Buffer.from(pdf));

  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "PRINT_PACK_FAILED" });
  }
});

module.exports = app;
