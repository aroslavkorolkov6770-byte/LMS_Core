import { BadRequestException } from "@nestjs/common";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";

export const RUNTIME_PROTOCOL = "lms-core-runtime-v1";
export const RUNTIME_USERS_KEY = "core_lms_users_v1";
export const MAX_RUNTIME_PAYLOAD = 24 * 1024 * 1024;
const aliases: Record<string, string> = {
  tea_hub_users_v1: RUNTIME_USERS_KEY,
  tea_hub_dynamic_route_v2: "core_lms_route_v1",
  tea_hub_dynamic_tests_v1: "core_lms_tests_v1",
  tea_hub_urgent_files_v1: "core_lms_documents_v1",
  tea_hub_test_results_v1: "core_lms_test_results_v1",
  tea_hub_assortment_matrix_v2: "core_lms_assortment_v1",
  tea_hub_products_v1: "core_lms_products_v1",
  tea_hub_notifications_v1: "core_lms_notifications_v1",
  tea_hub_push_subs_v1: "core_lms_push_subscriptions_v1",
  tea_hub_test_types_v1: "core_lms_test_types_v1",
  tea_hub_onboard_route_v2: "core_lms_onboard_route_v1"
};

export function runtimeKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_.@:-]{0,199}$/i.test(value) || ["constructor", "prototype", "__proto__"].includes(value)) throw new BadRequestException("Invalid runtime storage key");
  const canonical = Object.hasOwn(aliases, value) ? aliases[value] : (value.startsWith("tea_hub_") ? `core_lms_${value.slice(8)}` : value.startsWith("th_ai_history_") ? `core_lms_ai_history_${value.slice(14)}` : value);
  if (canonical.length > 200) throw new BadRequestException("Runtime storage key is too long");
  return canonical;
}

export function serializeRuntimePayload(value: unknown): string {
  let text: string | undefined;
  try { text = JSON.stringify(value); } catch { throw new BadRequestException("Invalid runtime payload"); }
  if (text === undefined || Buffer.byteLength(text) > MAX_RUNTIME_PAYLOAD) throw new BadRequestException("Runtime payload is missing or too large");
  return text;
}

export function validateRuntimeUsers(value: unknown): void {
  if (!Array.isArray(value) || value.length > 10000) throw new BadRequestException("Invalid runtime accounts");
  const logins = new Set<string>();
  const ids = new Set<string>();
  for (const user of value) {
    if (!user || typeof user !== "object" || typeof user.id !== "string" || !user.id || typeof user.login !== "string" || !user.login.trim() ||
        !["admin", "staff"].includes(user.role) || typeof user.passHash !== "string" || !/^scrypt2\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(user.passHash) || Object.hasOwn(user, "pass") || Object.hasOwn(user, "password")) {
      throw new BadRequestException("Runtime accounts must use supported password hashes");
    }
    const login = user.login.trim().toLowerCase();
    if (logins.has(login) || ids.has(user.id)) throw new BadRequestException("Duplicate runtime account");
    logins.add(login); ids.add(user.id);
  }
  const system = (user: Record<string, unknown>) => Boolean(user.systemAccount || user.ghostAccount || user.canSwitchMode);
  if (!value.some((user) => user.role === "admin" && system(user)) || !value.some((user) => user.role === "admin" && !system(user))) {
    throw new BadRequestException("The client and system administrator accounts must be retained");
  }
}

export type RuntimeBootstrap = { clientAdminLogin: string; clientAdminPassword: string; clientAdminName: string; systemAdminLogin: string; systemAdminPassword: string };

export function createRuntimeAccounts(input: RuntimeBootstrap) {
  const login = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9_.@+-]{0,119}$/i.test(value.trim()) ? value.trim() : "";
  const first = login(input.clientAdminLogin);
  const second = login(input.systemAdminLogin);
  const password = (value: unknown) => typeof value === "string" && value.length >= 12 && value.length <= 128;
  if (!first || !second || first.toLowerCase() === second.toLowerCase() || !password(input.clientAdminPassword) || !password(input.systemAdminPassword) ||
      typeof input.clientAdminName !== "string" || !input.clientAdminName.trim() || input.clientAdminName.length > 150) throw new BadRequestException("Distinct administrator logins, names and passwords of 12-128 characters are required");
  const hash = (plain: string) => {
    const salt = randomBytes(16).toString("hex");
    return `scrypt2$${salt}$${scryptSync(plain, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex")}`;
  };
  return [
    { id: randomUUID(), login: first, name: input.clientAdminName.trim(), role: "admin", passHash: hash(input.clientAdminPassword), authVersion: 0, isRegistered: true, registered: true },
    { id: randomUUID(), login: second, name: "Системный администратор", role: "admin", passHash: hash(input.systemAdminPassword), authVersion: 0,
      isRegistered: true, registered: true, systemAccount: true, canSwitchMode: true, hideFromStats: true, profileOwnerOnly: true }
  ];
}
