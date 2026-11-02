import "server-only";
import fs from "node:fs";
import path from "node:path";
import { validateClientDesign, designHash } from "../../core-client-design-contract.cjs";
import type { CoreDesign } from "../components/CoreClientDesign";

export function readCoreClientDesign(): CoreDesign | null {
  const file = path.join(process.cwd(), "core-client-design.json");
  if (!fs.existsSync(file) && !process.env.CORE_RUNTIME_DESIGN_SHA256) return null;
  try {
    if (fs.statSync(file).size > 1024 * 1024) throw Error("DESIGN_TOO_LARGE");
    const design = validateClientDesign(JSON.parse(fs.readFileSync(file, "utf8"))) as CoreDesign;
    if (process.env.CORE_RUNTIME_CLIENT_ID && design.clientId !== process.env.CORE_RUNTIME_CLIENT_ID.toLowerCase()) throw Error("DESIGN_CLIENT_MISMATCH");
    if (process.env.CORE_RUNTIME_DESIGN_SHA256 && designHash(design) !== process.env.CORE_RUNTIME_DESIGN_SHA256) throw Error("DESIGN_HASH_MISMATCH");
    return design;
  } catch { throw Error("CLIENT_DESIGN_UNAVAILABLE"); }
}
