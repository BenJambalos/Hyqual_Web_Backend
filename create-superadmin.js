import "./env.js";
import process from "node:process";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { initializeDatabase, pool, withTransaction } from "./db.js";

async function main() {
  await initializeDatabase();
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!email || !password || password.length < 6) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (at least 6 characters).");
  }

  await withTransaction(async (client) => {
    const { rows: existing } = await client.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [email]);
    if (existing[0]) {
      if (existing[0].profile.role !== "Superadmin") {
        throw new Error("That email already belongs to a non-superadmin account.");
      }
      const passwordHash = await bcrypt.hash(password, 12);
      await client.query("UPDATE users SET password_hash = $1, status = 'Active', archived = false WHERE id = $2", [
        passwordHash,
        existing[0].id,
      ]);
      console.log("Updated credentials for the existing superadmin account.");
      return;
    }

    const { rows: admins } = await client.query(
      "SELECT id FROM users WHERE JSON_UNQUOTE(JSON_EXTRACT(profile, '$.role')) = 'Superadmin' LIMIT 1 FOR UPDATE"
    );
    if (admins[0]) throw new Error("A superadmin already exists; use its email to reset/bootstrap its password.");

    const profile = {
      firstName: process.env.BOOTSTRAP_ADMIN_FIRST_NAME || "System",
      lastName: process.env.BOOTSTRAP_ADMIN_LAST_NAME || "Administrator",
      role: "Superadmin",
      status: "Active",
      archived: false,
    };
    const passwordHash = await bcrypt.hash(password, 12);
    const id = crypto.randomUUID();
    await client.query(
      `INSERT INTO users (id, email, password_hash, profile, status)
       VALUES ($1, $2, $3, $4, 'Active')`,
      [id, email, passwordHash, JSON.stringify(profile)]
    );
    console.log("Created the initial superadmin account.");
  });
}

main()
  .catch((error) => {
    console.error("Unable to bootstrap superadmin:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
