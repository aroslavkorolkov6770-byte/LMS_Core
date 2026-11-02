const test = require("node:test");
const assert = require("node:assert/strict");
const { DeployPanelService } = require("../../api/dist/modules/deploy-panel/deploy-panel.service.js");

test("real API client presenter returns the canonical slug used for an automatic installation path", () => {
  // Only the pure presenter is used; no service opens a database connection in this fixture.
  const service = new DeployPanelService({}, {});
  const client = { id: "fixture", name: "Fixture", slug: "client-one", domain: "fixture.invalid", brandName: "Fixture", tariff: "base", industryTemplate: "coffee_retail", isActive: true };
  const card = service.toDeployClientCard(client, null, null);
  assert.equal(card.slug, client.slug);
  assert.equal(card.id, client.id);
  assert.equal(card.name, client.name);
  assert.equal(Object.hasOwn(card, "password"), false);
});
