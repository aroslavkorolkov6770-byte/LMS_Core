import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export type ContactPatch = { version: 1; files: Array<{ path: string; beforeSha256: string | null; contents: string; sha256: string }> };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const markerPath = "app/lib/core-support-contact-manifest.json";
const originals = ["teacoffee@yandex.ru", "teacoffe@yandex.ru"];

function edit(source: string, changes: Array<{ start: number; end: number; text: string }>) {
  for (const change of changes.sort((a, b) => b.start - a.start)) source = source.slice(0, change.start) + change.text + source.slice(change.end);
  return source;
}
export function adaptSupportSource(source: string, kind: "footer" | "privacy"): string {
  const file = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const changes: Array<{ start: number; end: number; text: string }> = [];
  let contacts = 0, rendered = 0, companyContacts = 0;
  const visit = (node: ts.Node): void => {
    // Newer LMS sources put the email in COMPANY_DETAILS instead of a string literal.
    if (kind === "footer" && ts.isJsxExpression(node) && node.expression && ts.isConditionalExpression(node.expression)) {
      const expression = node.expression, condition = expression.condition;
      if (ts.isCallExpression(condition) && condition.expression.getText(file) === "hasCompanyDetail" && condition.arguments.length === 1 && condition.arguments[0].getText(file) === "COMPANY_DETAILS.supportEmail") {
        const unwrap = (value: ts.Expression): ts.Expression => ts.isParenthesizedExpression(value) ? unwrap(value.expression) : value;
        const yes = unwrap(expression.whenTrue), no = unwrap(expression.whenFalse);
        const hasClass = (value: ts.Expression, tag: string) => ts.isJsxElement(value) && value.openingElement.tagName.getText(file) === tag && value.openingElement.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(file) === "className" && item.initializer && ts.isStringLiteral(item.initializer) && item.initializer.text === "vates-footer-support-email");
        if (!hasClass(yes, "a") || !hasClass(no, "span") || !yes.getText(file).includes("mailto:${COMPANY_DETAILS.supportEmail}") || !no.getText(file).includes("{COMPANY_DETAILS.supportEmail}")) throw Error("SUPPORT_FOOTER_CONTRACT_CHANGED");
        contacts++; changes.push({ start: node.getStart(file), end: node.end, text: '<SupportEmail className="vates-footer-support-email" emptyLabel="" />' }); return;
      }
    }
    if (kind === "footer" && ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === "a" && node.openingElement.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(file) === "href" && item.initializer && ts.isStringLiteral(item.initializer) && originals.some(email => item.initializer!.getText(file).includes(`mailto:${email}`)))) {
      if (!node.openingElement.attributes.properties.some(item => ts.isJsxAttribute(item) && item.name.getText(file) === "className" && item.initializer?.getText(file).includes("vates-footer-support-email"))) throw Error("SUPPORT_FOOTER_CONTRACT_CHANGED");
      contacts++; changes.push({ start: node.getStart(file), end: node.end, text: '<SupportEmail className="vates-footer-support-email" />' }); return;
    }
    if (kind === "privacy" && ts.isStringLiteral(node) && originals.some(email => node.text.includes(email))) {
      contacts++; let text = node.text; for (const email of originals) text = text.split(email).join("__CORE_SUPPORT_EMAIL__");
      changes.push({ start: node.getStart(file), end: node.end, text: JSON.stringify(text) }); return;
    }
    if (kind === "privacy" && ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) if (span.expression.getText(file) === "COMPANY_DETAILS.supportEmail") {
        contacts++; companyContacts++; changes.push({ start: span.expression.getStart(file), end: span.expression.end, text: JSON.stringify("__CORE_SUPPORT_EMAIL__") });
      }
    }
    if (kind === "privacy" && ts.isJsxExpression(node) && node.expression && ["block.text", "block.intro", "item"].includes(node.expression.getText(file)) && ts.isJsxElement(node.parent)) {
      rendered++; changes.push({ start: node.getStart(file), end: node.end, text: `<SupportText text={${node.expression.getText(file)}} />` }); return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  // Empty beta contact fields stay visually empty until the owner configures an address.
  if (companyContacts) for (const change of changes) if (change.text.startsWith("<SupportText ")) change.text = change.text.replace(" />", ' emptyLabel="" />');
  if (kind === "footer" ? contacts !== 1 : contacts !== 3 || rendered !== 3) throw Error("SUPPORT_SOURCE_CONTRACT_CHANGED");
  const firstImport = file.statements.find(ts.isImportDeclaration); if (!firstImport) throw Error("SUPPORT_IMPORT_CONTRACT_CHANGED");
  changes.push({ start: firstImport.getStart(file), end: firstImport.getStart(file), text: `import { ${kind === "footer" ? "SupportEmail" : "SupportText"} } from '@/app/components/CoreSupportContact';\n` });
  const result = edit(source, changes);
  if (originals.some(email => result.includes(email))) throw Error("SUPPORT_CONTACT_NOT_REPLACED");
  return result;
}

export async function prepareSupportPatch(root: string, source: string): Promise<ContactPatch> {
  const files: ContactPatch["files"] = [];
  for (const [relative, kind] of [["app/components/Footer.tsx", "footer"], ["app/privacy/page.tsx", "privacy"]] as const) {
    const original = await readFile(path.join(source, relative), "utf8"), contents = adaptSupportSource(original, kind);
    files.push({ path: relative, beforeSha256: hash(original), contents, sha256: hash(contents) });
  }
  for (const [relative, template] of [["app/components/CoreSupportContact.tsx", "CoreSupportContact.tsx"], ["app/api/core-runtime/support-contact/route.ts", "support-contact-route.ts"]]) {
    const contents = await readFile(path.join(root, "infra/lms-adapter", template), "utf8");
    files.push({ path: relative, beforeSha256: null, contents, sha256: hash(contents) });
  }
  const contents = JSON.stringify({ format: "lms-core-support-contact-v1", files: files.map(({ path, sha256 }) => ({ path, sha256 })) });
  files.push({ path: markerPath, beforeSha256: null, contents, sha256: hash(contents) });
  return { version: 1, files };
}

export async function applySupportPatch(root: string, source: string): Promise<void> {
  const patch = await prepareSupportPatch(root, source);
  for (const file of patch.files) { const destination = path.join(source, file.path); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, file.contents, { flag: file.beforeSha256 ? "w" : "wx" }); }
}
