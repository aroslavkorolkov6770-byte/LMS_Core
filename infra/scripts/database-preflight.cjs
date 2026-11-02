"use strict";
const { execFile } = require("node:child_process");
async function checkDatabaseAccess(input) {
  const peer = input?.databaseMode === "local_peer";
  let file = "runuser", args, password;
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PGCONNECT_TIMEOUT: "8" };
  const query = "SELECT CASE WHEN current_database()='postgres' AND (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN 'core-db-admin-ok' ELSE 'core-db-admin-denied' END";
  if (peer) args = ["-u", "postgres", "--", "psql", "-X", "-A", "-t", "-w", "-h", "/var/run/postgresql", "-d", "postgres", "-c", query];
  else {
    try {
      const url = new URL(input.maintenanceUrl);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/postgres") throw Error();
      password = decodeURIComponent(url.password); url.password = ""; env.PGPASSWORD = password;
      file = "psql"; args = ["-X", "-A", "-t", "-w", "--dbname", url.href, "-c", query];
    } catch { return { ready: false, errorCode: "DATABASE_ADMIN_CONFIG_INVALID" }; }
  }
  return new Promise(resolve => {
    execFile(file, args, { env, timeout: 15000, maxBuffer: 4096 }, (error, stdout) => {
      delete env.PGPASSWORD; password = "";
      resolve(error ? { ready: false, errorCode: peer ? "DATABASE_LOCAL_PEER_UNAVAILABLE" : "DATABASE_ADMIN_CONNECTION_FAILED" } : stdout.trim() === "core-db-admin-ok" ? { ready: true, mode: peer ? "local_peer" : "password" } : { ready: false, errorCode: "DATABASE_PROVISION_ADMIN_REQUIRED" });
    });
  });
}
module.exports = { checkDatabaseAccess };
