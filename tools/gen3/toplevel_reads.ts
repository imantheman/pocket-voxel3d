// Port tooling: list every place a gen3 runtime module touches an IMPORTED
// binding while it loads -- top-level statements, variable initialisers,
// class static fields, computed keys -- but not inside function bodies.
// Inside the gen3 import cycle each of these can throw "Cannot access 'X'
// before initialization" depending on which module loads first
// (docs/firered-runtime-brief.md: no top-level reads of imports).
//   bun tools/gen3/toplevel_reads.ts [path-filter]
import ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "../../voxelmon/game/gen3");
const filter = process.argv[2];
const files: string[] = [];
(function walk(d: string): void {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (n.endsWith(".ts") && (!filter || p.includes(filter))) files.push(p);
  }
})(ROOT);
// leaves that import nothing from the cycle are safe to read at load
const SAFE_SOURCES = /platform\/|lazy_registry|notported|\/import\/gen3\/|constants\/|\/data\/|lua\.ts|luatable\.ts/;

let total = 0;
for (const f of files.sort()) {
  const src = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
  const imported = new Set<string>();
  for (const st of src.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const from = (st.moduleSpecifier as ts.StringLiteral).text;
    if (!from.startsWith(".")) continue;
    // judge the RESOLVED path: platform/, the importer and the data tables import nothing in the cycle
    if (SAFE_SOURCES.test(resolve(dirname(f), from))) continue;
    if (st.importClause.isTypeOnly) continue;
    if (st.importClause.name) imported.add(st.importClause.name.text);
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) imported.add(e.name.text);
    if (nb && ts.isNamespaceImport(nb)) imported.add(nb.name.text);
  }
  if (!imported.size) continue;
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    // code that runs later: function bodies, arrows, methods, accessors, constructors
    if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
        || ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isConstructorDeclaration(n)) return;
    // instance fields are initialised per `new`, not at load
    if (ts.isPropertyDeclaration(n) && !(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Static)) return;
    if (ts.isImportDeclaration(n) || ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
    if (ts.isExportDeclaration(n)) return; // re-exports are bindings, not reads
    if (ts.isIdentifier(n) && imported.has(n.text)) {
      const p = n.parent;
      // a property NAME (obj.X where X is the name) is not a read of X
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || ts.isTypeReferenceNode(p) || ts.isExportSpecifier(p) || ts.isQualifiedName(p);
      // `export default X` and `export { X }` don't read the value at load in a problematic way
      if (!isName && !ts.isExportAssignment(p)) {
        const { line } = src.getLineAndCharacterOfPosition(n.getStart());
        hits.push(`${line + 1}:${n.text}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  for (const st of src.statements) visit(st);
  if (hits.length) {
    total += hits.length;
    console.log(`${relative(ROOT, f)}: ${[...new Set(hits)].slice(0, 12).join(" ")}${hits.length > 12 ? ` (+${hits.length - 12})` : ""}`);
  }
}
console.log(`${total} top-level reads of imports`);
process.exit(total ? 1 : 0);
