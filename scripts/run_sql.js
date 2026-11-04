import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSqlFile } from "../db.js";

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(backendDirectory, "migrations");
const requestedFile = process.argv[2];

if (!requestedFile) {
  throw new Error("Specify a SQL file from the migrations directory.");
}

const filePath = path.resolve(backendDirectory, requestedFile);
const relativePath = path.relative(migrationsDirectory, filePath);
if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
  throw new Error("SQL files can only be run from the backend migrations directory.");
}

const results = await runSqlFile(filePath);
console.info(`Executed ${path.relative(backendDirectory, filePath)}.`);
for (const rows of results) console.table(rows);
