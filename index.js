import "./env.js";
import process from "node:process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import app from "./app.js";
import { pool, initializeDatabase } from "./db.js";

const port = Number(process.env.PORT || 3000);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

await initializeDatabase();

const distPath = path.join(root, "frontend", "dist");
if (existsSync(distPath)) {
  app.use(express.static(distPath, { index: false, maxAge: "1d" }));
  app.get("*path", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(distPath, "index.html"));
  });
}

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`HyQual API listening on port ${port}`);
});


async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
