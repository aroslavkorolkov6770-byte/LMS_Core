import ts from "typescript";

// Change only known AST initializers; keep the rest of the selected source byte-for-byte.
export function adaptRuntimeAuth(source: string): string {
  const file = ts.createSourceFile("serverAuth.ts", source, ts.ScriptTarget.Latest, true);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const values: Record<string, string> = {
    getBootstrapUsers: `(): StoredUser[] => { throw new Error("Initialize administrators through the private Core Runtime API"); }`,
    getAuthSecret: `() => {
    const secret = process.env.AUTH_SECRET;
    if (!secret || secret.length < 32) throw new Error("Core Runtime AUTH_SECRET is not configured");
    return secret;
}`,
    AUTH_COOKIE_NAME: `(() => {
    const clientId = process.env.CORE_RUNTIME_CLIENT_ID || "";
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(clientId)) throw new Error("Core Runtime client is not configured");
    return "core_lms_session_" + clientId.replaceAll("-", "").toLowerCase();
})()`
  };
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !Object.hasOwn(values, declaration.name.text)) continue;
      const node = declaration.initializer;
      if (!node || (declaration.name.text !== "AUTH_COOKIE_NAME" && (!ts.isArrowFunction(node) || node.parameters.length !== 0))) throw new Error("Неизвестный контракт серверной авторизации Git-LMS.");
      replacements.push({ start: node.getStart(file), end: node.end, value: values[declaration.name.text] });
    }
  }
  if (replacements.length !== 3) throw new Error("В источнике отсутствует ожидаемый контракт авторизации. Копия не будет развернута.");
  let result = source;
  for (const change of replacements.sort((left, right) => right.start - left.start)) result = result.slice(0, change.start) + change.value + result.slice(change.end);
  if (result.includes("process.env.BOOTSTRAP_ADMIN_PASSWORD") || /hashPassword\s*\(\s*['"`]/.test(result)) throw new Error("В адаптированной авторизации остался статический bootstrap-пароль.");
  return result;
}

export function emptyPilotTrainingDefaults(source: string): string {
  const file = ts.createSourceFile("defaultTrainingTests.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.VariableDeclaration[] = [];
  for (const statement of file.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === "DEFAULT_TRAINING_TESTS" && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) matches.push(declaration);
  }
  if (matches.length !== 1) throw new Error("Неизвестный контракт встроенных учебных материалов. Пустой шаблон не подтвержден.");
  const declaration = matches[0], value = declaration.initializer as ts.ArrayLiteralExpression;
  // Respect an explicit source type, including required fields in newer empty templates.
  if (declaration.type && value.elements.length === 0) return source;
  const empty = declaration.type ? "[]" : "[] as Array<{ id: string; title: string; subtitle?: string; theory?: string; quiz: Array<{ q: string; o: string[]; c: number }> }>";
  return source.slice(0, value.getStart(file)) + empty + source.slice(value.end);
}
