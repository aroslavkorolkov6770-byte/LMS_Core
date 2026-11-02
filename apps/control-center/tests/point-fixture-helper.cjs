const { root, dbRequire } = require("./runtime-test-helper.cjs");
const { testDatabase, loadBaseline, fixtureClient, db } = require("./fresh-install-test-helper.cjs");
const { PointDesignController } = require("../../api/dist/modules/deploy-panel/point-design.controller.js");
const { PointDesignService } = require("../dist/point-design.js");

async function pointFixture(t) {
  const database = await testDatabase(t, "lms"), client = { ...fixtureClient(), name: "Point editor fixture", slug: "point-editor-fixture" };
  await db.initializeFreshDatabase(database.databaseUrl, await loadBaseline(), client);
  const orm = dbRequire("drizzle-orm/postgres-js").drizzle(database.sql, { schema: db.schema });
  const controller = new PointDesignController({ db: orm });
  const request = async (clientId, sourceRevision, payload) => payload
    ? controller.save({ clientId, sourceRevision, ...payload })
    : controller.get({ clientId, sourceRevision });
  return { ...database, client, controller, service: new PointDesignService(root, request) };
}
module.exports = { pointFixture };
