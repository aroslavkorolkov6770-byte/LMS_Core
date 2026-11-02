import "server-only";
import fs from "node:fs";
import path from "node:path";
import { validateClientDesign, designHash } from "../../core-client-design-contract.cjs";
import type { PointDocument } from "../components/CorePointDesign";

export function readCorePointDesign() {
  try {
    const file = path.join(process.cwd(), "core-client-design.json");
    if (fs.statSync(file).size > 128 * 1024) throw Error("POINT_DESIGN_TOO_LARGE");
    const design = validateClientDesign(JSON.parse(fs.readFileSync(file, "utf8")));
    if (design.version !== 3 || process.env.CORE_RUNTIME_CLIENT_ID && design.clientId !== process.env.CORE_RUNTIME_CLIENT_ID.toLowerCase() ||
      process.env.CORE_RUNTIME_DESIGN_SHA256 && designHash(design) !== process.env.CORE_RUNTIME_DESIGN_SHA256) throw Error("POINT_DESIGN_MISMATCH");
    // The CJS validator supports legacy documents too; the version/hash guards above narrow the actual file.
    return design as unknown as PointDocument;
  } catch { throw Error("CLIENT_POINT_DESIGN_UNAVAILABLE"); }
}
