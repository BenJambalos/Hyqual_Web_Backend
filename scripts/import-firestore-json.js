import "../env.js";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { initializeDatabase, pool, withTransaction } from "../db.js";

const allowedCollections = new Set(["farms", "ponds", "devices", "alerts", "approvals", "auditLogs"]);
const allowedParameters = new Set(["temperature", "ph", "do", "ec"]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function userProfile(user) {
  const profile = user.profile && typeof user.profile === "object" && !Array.isArray(user.profile)
    ? { ...user.profile }
    : { ...user };
  for (const field of [
    "id", "uid", "email", "password", "passwordHash", "password_hash",
    "hashedPassword", "hashed_password", "status", "archived", "lastSeen",
  ]) {
    delete profile[field];
  }
  if (user.lastSeen !== undefined) profile.lastSeen = normalizeFirestoreValue(user.lastSeen);
  return normalizeFirestoreValue(profile);
}

function normalizeFirestoreValue(value) {
  if (Array.isArray(value)) return value.map(normalizeFirestoreValue);
  if (!value || typeof value !== "object") return value;
  const seconds = value.seconds ?? value._seconds;
  const nanoseconds = value.nanoseconds ?? value._nanoseconds ?? 0;
  if (Number.isFinite(Number(seconds)) && Object.keys(value).every((key) => (
    ["seconds", "_seconds", "nanoseconds", "_nanoseconds"].includes(key)
  ))) {
    return new Date(Number(seconds) * 1000 + Number(nanoseconds) / 1e6).toISOString();
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    normalizeFirestoreValue(child),
  ]));
}

function timestampToDate(value) {
  if (value && typeof value === "object") {
    const seconds = value.seconds ?? value._seconds;
    const nanoseconds = value.nanoseconds ?? value._nanoseconds ?? 0;
    if (Number.isFinite(Number(seconds))) {
      return new Date(Number(seconds) * 1000 + Number(nanoseconds) / 1e6);
    }
  }
  const timestamp = typeof value === "number" && value > 0 && value < 1e11
    ? value * 1000
    : value;
  return new Date(timestamp);
}

function walkReadings(node, parameter, output) {
  if (Array.isArray(node)) {
    node.forEach((value) => walkReadings(value, parameter, output));
    return;
  }
  if (!node || typeof node !== "object") return;

  if (node.createdAt && node.value !== undefined && Number.isFinite(Number(node.value))) {
    const createdAt = timestampToDate(node.createdAt);
    if (!Number.isNaN(createdAt.getTime())) {
      output.push({
        parameter,
        value: Number(node.value),
        createdAt,
        payload: normalizeFirestoreValue(node),
      });
      return;
    }
  }
  Object.values(node).forEach((value) => walkReadings(value, parameter, output));
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    throw new Error("Pass the path to the prepared Firebase export JSON.");
  }

  const input = requireObject(JSON.parse(await readFile(sourcePath, "utf8")), "Export");
  const collections = requireObject(input.collections || {}, "collections");
  const readings = requireObject(input.readings || {}, "readings");
  const deviceState = requireObject(input.deviceState || {}, "deviceState");
  const users = Array.isArray(input.users) ? input.users : [];

  await initializeDatabase();
  await withTransaction(async (client) => {
    for (const user of users) {
      const id = String(user.id || user.uid || "");
      const email = String(user.email || "").trim().toLowerCase();
      if (!id || !email) throw new Error("Every imported user needs an id (or uid) and email.");
      const parsedLastSeen = user.lastSeen ? timestampToDate(user.lastSeen) : null;
      const lastSeen = parsedLastSeen && !Number.isNaN(parsedLastSeen.getTime())
        ? parsedLastSeen
        : null;
      await client.query(
        `INSERT INTO users (id, email, password_hash, profile, status, archived, last_seen)
         VALUES ($1, $2, NULL, $3, $4, $5, $6)
        ON DUPLICATE KEY UPDATE
          email = VALUES(email),
          profile = VALUES(profile),
          status = VALUES(status),
          archived = VALUES(archived),
          last_seen = VALUES(last_seen)`,
        [
          id,
          email,
          JSON.stringify(userProfile(user)),
          user.status || "Active",
          user.archived === true,
          lastSeen,
        ]
      );
    }

    for (const [collection, records] of Object.entries(collections)) {
      if (!allowedCollections.has(collection) || !Array.isArray(records)) {
        throw new Error(`Unsupported collection or invalid record list: ${collection}.`);
      }
      for (const record of records) {
        const id = String(record.id || "");
        if (!id) throw new Error(`Every ${collection} record needs an id.`);
        const data = { ...record };
        delete data.id;
        await client.query(
          `INSERT INTO records (collection, id, data)
           VALUES ($1, $2, $3)
           ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = now()`,
          [collection, id, JSON.stringify(normalizeFirestoreValue(data))]
        );
      }
    }

    const parsedReadings = [];
    for (const [parameter, tree] of Object.entries(readings)) {
      if (!allowedParameters.has(parameter)) throw new Error(`Unsupported reading parameter: ${parameter}.`);
      walkReadings(tree, parameter, parsedReadings);
    }
    for (const reading of parsedReadings) {
      await client.query(
        `INSERT INTO sensor_readings (device_id, parameter, value, created_at, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [reading.payload.deviceId || null, reading.parameter, reading.value, reading.createdAt, JSON.stringify(reading.payload)]
      );
    }

    for (const [stateKey, value] of Object.entries(deviceState)) {
      await client.query(
        `INSERT INTO device_state (state_key, value)
         VALUES ($1, $2)
        ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = now()`,
        [stateKey, JSON.stringify(normalizeFirestoreValue(value))]
      );
    }
    console.log(`Imported ${users.length} users, ${Object.values(collections).flat().length} records, and ${parsedReadings.length} readings.`);
  });
}

main()
  .catch((error) => {
    console.error("Firebase export import failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
