  import "./env.js";
import { readFile } from "node:fs/promises";
import process from "node:process";
import mysql from "mysql2/promise";

const connectionUri = process.env.MYSQL_URL || process.env.MYSQL_PUBLIC_URL;
const connectionConfig = connectionUri
  ? (() => {
      const url = new URL(connectionUri);
      return {
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
        ssl: process.env.MYSQL_SSL === "true" ? { rejectUnauthorized: true } : undefined,
      };
    })()
  : {
      host: process.env.MYSQLHOST,
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      ssl: process.env.MYSQL_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    };

if (!connectionConfig.host || !connectionConfig.user
  || !connectionConfig.password || !connectionConfig.database) {
  throw new Error("Set MYSQL_URL or MYSQLHOST, MYSQLUSER, MYSQLPASSWORD, and MYSQLDATABASE to connect to Railway MySQL.");
}

const connectionPool = mysql.createPool({
  ...connectionConfig,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  timezone: "Z",
  dateStrings: false,
});

connectionPool.on("error", (error) => {
  console.error("Unexpected MySQL connection error:", error);
});

function prepareQuery(sql, values = []) {
  const hasNumberedPlaceholders = /\$\d+/.test(sql);
  const orderedValues = [];
  const statement = sql.replace(/\$(\d+)/g, (_match, index) => {
    orderedValues.push(values[Number(index) - 1]);
    return "?";
  });
  return { statement, values: hasNumberedPlaceholders ? orderedValues : values };
}

function createQueryClient(connection) {
  return {
    async query(sql, values = []) {
      const prepared = prepareQuery(sql, values);
      const [result] = await connection.query(prepared.statement, prepared.values);
      if (Array.isArray(result)) return { rows: result, rowCount: result.length };
      return { rows: [], rowCount: result.affectedRows, insertId: result.insertId };
    },
  };
}

export const pool = {
  query: (...args) => createQueryClient(connectionPool).query(...args),
  end: () => connectionPool.end(),
};

export async function initializeDatabase() {
  const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  // Strip SQL comments before splitting so explanatory semicolons are ignored.
  const executableSql = schema.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const statement of executableSql.split(";").map((part) => part.trim()).filter(Boolean)) {
    await connectionPool.query(statement);
  }
}

export async function withTransaction(callback) {
  const connection = await connectionPool.getConnection();
  const client = createQueryClient(connection);
  try {
    await connection.beginTransaction();
    const result = await callback(client);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
