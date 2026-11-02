const test = require("node:test");
const assert = require("node:assert/strict");
const { pointFixture } = require("./point-fixture-helper.cjs");
const { emptyPointDesign } = require("../../../infra/scripts/point-design-contract.cjs");
const { randomUUID } = require("node:crypto");

test("real Core point controller stores isolated revisions atomically, logs saves and refuses stale concurrent writes", { timeout: 45000 }, async (t) => {
  const { sql, controller, client, service } = await pointFixture(t), sourceRevision = "a".repeat(40);
  const original = await controller.get({ clientId: client.id, sourceRevision });
  assert.equal(original.revision, 0); assert.deepEqual(original.document.elements, {});
  const doc = emptyPointDesign(client.id, sourceRevision); doc.elements["login.title"] = { text: "Для клиента", styles: { light: { color: "#234567" } } };
  const saved = await service.save({ clientId: client.id, sourceRevision, revision: 0, document: doc });
  assert.equal(saved.revision, 1);
  const a = structuredClone(saved.document), b = structuredClone(saved.document);
  a.elements["login.title"].text = "Первая правка"; b.elements["login.title"].text = "Вторая правка";
  const concurrent = await Promise.allSettled([a, b].map((document) => controller.save({ clientId: client.id, sourceRevision, expectedRevision: 1, document })));
  assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.find((item) => item.status === "rejected").reason.getStatus(), 409);
  assert.equal((await service.load(client.id, sourceRevision)).revision, 2);
  assert.equal((await service.load(client.id, "b".repeat(40))).revision, 0);
  await assert.rejects(controller.save({ clientId: client.id, sourceRevision, expectedRevision: 2, document: { ...saved.document, clientId: randomUUID() } }), (error) => error.getStatus() === 400);
  assert.equal(Number((await sql`SELECT count(*) AS count FROM audit_log WHERE action='point_design.saved'`)[0].count), 2);
  assert.equal(Number((await sql`SELECT count(*) AS count FROM client_content`)[0].count), 1);
  assert.equal(Number((await sql`SELECT count(*) AS count FROM client_preview_settings`)[0].count), 0);
});
