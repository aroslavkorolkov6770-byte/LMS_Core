const test = require("node:test");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const apiRequire = createRequire(require.resolve("../../api/package.json"));
apiRequire("reflect-metadata");
const { validate } = apiRequire("class-validator");
const { UpdateDeployProfileDto } = require("../../api/dist/modules/deploy-panel/dto/update-deploy-profile.dto.js");
const { accessProfilePayload } = require("../dist/client-access-profile.js");
test("native access save conforms to the actual API DTO and never resends internal profile columns", async () => {
  const profile = { id: "internal-row", createdAt: new Date().toISOString(), deploymentBundlePath: "private", hostUrl: "https://192.0.2.11", databaseHost: "192.0.2.20", databasePort: 5432, databaseName: "tenant", databaseUser: "service", storageBucket: "private-fixture", aiProvider: "fixture", aiModel: "fixture", status: "draft" };
  const input = { host: "192.0.2.11", databaseMode: "local_peer", clientAdminName: "Fixture", clientAdminLogin: "admin", clientAdminPassword: "", systemAdminLogin: "sys_admin", systemAdminPassword: "" };
  const body = JSON.parse(JSON.stringify(accessProfilePayload("11111111-1111-4111-8111-111111111111", profile, input)));
  assert.equal((await validate(Object.assign(new UpdateDeployProfileDto(), body), { whitelist: true, forbidNonWhitelisted: true })).length, 0);
  assert.equal(body.databaseHost, "192.0.2.20"); assert.equal(body.hostUrl, profile.hostUrl);
  for (const key of ["id", "createdAt", "deploymentBundlePath", "clientAdminPassword", "systemAdminPassword", "sshPassword", "databasePassword"]) assert.equal(Object.hasOwn(body, key), false);
});
