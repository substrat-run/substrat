import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SymbolFlags, TypeFlags } from 'typescript/unstable/sync';
import type { Node as TSNode } from 'typescript/unstable/ast';
import {
  isArrowFunction,
  isBindingElement,
  isCallExpression,
  isElementAccessExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectBindingPattern,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSpreadAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is';
import type { Project, Type as TSCompilerType } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PIN_KEYS = ['releases', 'className', 'operations', 'platformOperations'] as const;
type PinKey = (typeof PIN_KEYS)[number];
type PinRead = { file: string; owner: string; key: PinKey };

/** A direct read or a pass-through reader that step 4b must switch with the registry. */
const PIN_READERS: readonly PinRead[] = [
  { file: 'packages/control-plane-api/src/api.ts', owner: 'pinOf', key: 'releases' },
  { file: 'packages/control-plane-api/src/api.ts', owner: 'assertSchemaKept', key: 'releases' },
  { file: 'packages/control-plane-api/src/api.ts', owner: 'GET /store-drivers/:driver', key: 'releases' },
  { file: 'packages/control-plane-api/src/api.ts', owner: 'PUT /store-drivers/:driver/releases', key: 'releases' },
  { file: 'packages/control-plane-api/src/api.ts', owner: 'POST /store-drivers/:driver/releases/:sha256/approvals', key: 'releases' },
  { file: 'packages/control-plane-api/src/deploy.ts', owner: 'scopeStoreUploadPlan', key: 'releases' },
  { file: 'packages/control-plane-api/src/deploy.ts', owner: 'scopeStoreUploadPlan', key: 'className' },
  { file: 'packages/control-plane-api/src/store-script.ts', owner: 'createStoreCanaryEnsurer', key: 'releases' },
  { file: 'packages/control-plane-api/src/store-script.ts', owner: 'createStoreCanaryEnsurer', key: 'className' },
  { file: 'packages/control-plane-api/src/store-releases.ts', owner: 'schemaOf', key: 'releases' },
];

/** Test-only direct reads; 4b updates these tests along with the production readers. */
const TEST_PIN_READERS = [
  'packages/control-plane-api/test/store-script.test.ts',
  'packages/control-plane-api/test/store-releases.test.ts',
  'packages/control-plane-api/test/upload-scope-store-bindings.test.ts',
];

const FIXTURE_TSCONFIG = 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/tsconfig.json';

/**
 * Every workspace member that declares a dependency through which a registration can be typed,
 * read off the committed lockfile's importers: the checked-in member list (`lint:lockfile` keeps
 * builder scratch projects out of it), so a new reader package joins the scan by declaring the dep.
 */
function relevantWorkspaceProjects(): { configs: string[]; roots: string[] } {
  const importers = new Map<string, Set<string>>();
  let section = '';
  let importer: Set<string> | undefined;
  for (const line of readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) section = line;
    if (section !== 'importers:') continue;
    const member = /^ {2}(\S[^:]*):$/.exec(line);
    if (member) importers.set(member[1]!, (importer = new Set()));
    const dep = /^ {6}'?(@substrat-run\/[^':]+)'?:$/.exec(line);
    if (dep) importer?.add(dep[1]!);
  }
  const configs: string[] = [];
  const roots: string[] = [];
  for (const [directory, deps] of importers) {
    // The root importer is the repo's tools, which run nothing in the control plane.
    if (directory === '.') continue;
    // A copy of the scaffold template that `tools/template-sync.mjs` writes at typecheck time (#878):
    // nothing but its package.json is checked in, so a test run may find it empty. It is a vertical,
    // and runs nothing in the control plane either.
    if (directory === 'packages/template-check') continue;
    // contracts declares the type, so it is a reader without depending on itself.
    if (directory !== 'packages/contracts' && !deps.has('@substrat-run/contracts') && !deps.has('@substrat-run/control-plane-api')) continue;
    const tsconfig = join(directory, 'tsconfig.json');
    if (!existsSync(join(ROOT, tsconfig))) throw new Error(`${directory}: package can import store-driver registration but has no production tsconfig.json`);
    configs.push(tsconfig);
    roots.push(join(ROOT, directory));
  }
  return { configs, roots };
}

/**
 * Whether a project scans a file: its own member's source, not a nested member's, never a
 * declaration file (another member's `dist` is that member's to scan, from its source), and no test.
 */
function ownSource(fileName: string, projectRoot: string, roots: readonly string[]): boolean {
  const absolute = resolve(fileName).replaceAll('\\', '/');
  const owner = roots
    .map((root) => resolve(ROOT, root).replaceAll('\\', '/'))
    .filter((root) => absolute.startsWith(`${root}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (owner !== resolve(projectRoot).replaceAll('\\', '/')) return false;
  const relativeFile = absolute.slice(owner.length + 1);
  return !/\.d\.[cm]?ts$/.test(relativeFile) &&
    !relativeFile.split('/').some((part) => ['node_modules', 'test', 'tests', '__tests__', 'fixture', 'fixtures'].includes(part)) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(relativeFile);
}

/**
 * The registration type, resolved once per project where it is declared, so a file that reads a
 * registration without naming its type (`STORE_DRIVERS[0].releases`) is scanned too.
 */
function registrationTypeOf(project: Project): TSCompilerType | undefined {
  for (const fileName of project.program.getSourceFileNames()) {
    if (!/\/(?:packages\/contracts\/(?:src|dist)|store-driver-reader-inventory)\//.test(fileName)) continue;
    const source = project.program.getSourceFile(fileName);
    if (!source || !/\b(?:type|interface)\s+StoreDriverRegistration\b/.test(source.text)) continue;
    const symbol = project.checker.resolveName('StoreDriverRegistration', SymbolFlags.Type, source);
    if (symbol) return project.checker.getDeclaredTypeOfSymbol(symbol);
  }
  return undefined;
}

const MAYBE_REGISTRATION = TypeFlags.Object | TypeFlags.Union | TypeFlags.Intersection | TypeFlags.TypeParameter;

/** Whether a type is, or carries, a registration; memoised per project by type id. */
function registrationBearing(registration: TSCompilerType, project: Project): (type: TSCompilerType | undefined) => boolean {
  const memo = new Map<number, boolean>();
  const bearing = (type: TSCompilerType | undefined): boolean => {
    // `any` is assignable both ways to everything; an untyped read is not a typed pin read.
    if (!type || !(type.flags & MAYBE_REGISTRATION)) return false;
    const known = memo.get(type.id);
    if (known !== undefined) return known;
    memo.set(type.id, false); // a recursive type answers false while it is being judged
    const result =
      (project.checker.isTypeAssignableTo(type, registration) && project.checker.isTypeAssignableTo(registration, type)) ||
      // A projection through a type alias (`Pick<StoreDriverRegistration, 'releases'>`, `Partial<…>`, `Omit<…>`).
      type.getAliasTypeArguments().some(bearing) ||
      ((type.isUnionType() || type.isIntersectionType()) && (type.getTypes() ?? []).some(bearing)) ||
      (type.isTypeParameter() && bearing(type.getConstraint())) ||
      (project.checker.isArrayType(type) && project.checker.getTypeArguments(type).some(bearing));
    memo.set(type.id, result);
    return result;
  };
  return bearing;
}

function keyName(node: TSNode | undefined): string | undefined {
  if (!node) return undefined;
  if (isIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function functionOwner(node: TSNode): string {
  let current: TSNode | undefined = node;
  while (current) {
    if (isFunctionDeclaration(current) || isFunctionExpression(current) || isArrowFunction(current) || isMethodDeclaration(current)) {
      const named = 'name' in current ? current.name : undefined;
      if (named && isIdentifier(named)) return named.text;
      const parent = current.parent;
      if (isVariableDeclaration(parent) && isIdentifier(parent.name)) return parent.name.text;
      if (isPropertyAssignment(parent)) return keyName(parent.name) ?? '<property-function>';
      if (isCallExpression(parent)) {
        const method = parent.expression.getText();
        const route = parent.arguments.find((argument) => isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument));
        if (route && /\.(?:get|post|put|delete|patch)$/.test(method)) return `${method.slice(method.lastIndexOf('.') + 1).toUpperCase()} ${route.text}`;
      }
    }
    current = current.parent;
  }
  return '<module>';
}

/** The node whose type an object binding pattern destructures: a variable's initializer or a parameter. */
function bindingSource(node: TSNode): TSNode | undefined {
  let pattern: TSNode = node.parent;
  while (isObjectBindingPattern(pattern) && isBindingElement(pattern.parent)) pattern = pattern.parent.parent;
  if (isObjectBindingPattern(pattern) && isVariableDeclaration(pattern.parent) && pattern.parent.initializer) return pattern.parent.initializer;
  if (isObjectBindingPattern(pattern) && isParameterDeclaration(pattern.parent)) return pattern.parent;
  return undefined;
}

function isPinKey(key: string | undefined): key is PinKey {
  return PIN_KEYS.includes(key as PinKey);
}

function findPinReads(projects: readonly Project[], roots: readonly string[]): PinRead[] {
  const found = new Map<string, PinRead>();
  for (const project of projects) {
    const registration = registrationTypeOf(project);
    if (!registration) continue;
    // Collected syntactically, then typed in one batched request: one per node is too slow at workspace scale.
    const candidates: { file: string; node: TSNode; at: TSNode; keys: readonly PinKey[] }[] = [];
    const projectRoot = dirname(project.configFileName);
    for (const fileName of project.program.getSourceFileNames().filter((name) => ownSource(name, projectRoot, roots))) {
      const source = project.program.getSourceFile(fileName);
      if (!source) continue;
      const file = relative(ROOT, source.fileName).replaceAll('\\', '/');
      const visit = (node: TSNode): void => {
        if (isPropertyAccessExpression(node) && isPinKey(node.name.text)) {
          candidates.push({ file, node, at: node.expression, keys: [node.name.text] });
        } else if (isElementAccessExpression(node)) {
          const key = keyName(node.argumentExpression);
          if (isPinKey(key)) candidates.push({ file, node, at: node.expression, keys: [key] });
        } else if (isBindingElement(node) && isObjectBindingPattern(node.parent)) {
          const at = bindingSource(node);
          const key = keyName(node.propertyName ?? node.name);
          if (at && node.dotDotDotToken) candidates.push({ file, node, at, keys: PIN_KEYS });
          else if (at && isPinKey(key)) candidates.push({ file, node, at, keys: [key] });
        } else if (isSpreadAssignment(node) || isSpreadElement(node)) {
          candidates.push({ file, node, at: node.expression, keys: PIN_KEYS });
        }
        node.forEachChild(visit);
      };
      source.forEachChild(visit);
    }
    if (candidates.length === 0) continue;
    const bearing = registrationBearing(registration, project);
    const types = project.checker.getTypeAtLocation(candidates.map((candidate) => candidate.at));
    candidates.forEach(({ file, node, keys }, index) => {
      if (!bearing(types[index])) return;
      for (const key of keys) {
        const read = { file, owner: functionOwner(node), key };
        found.set(`${read.file}\0${read.owner}\0${read.key}`, read);
      }
    });
  }
  return [...found.values()].sort((a, b) => `${a.file}\0${a.owner}\0${a.key}`.localeCompare(`${b.file}\0${b.owner}\0${b.key}`));
}

function openProjects() {
  const api = new API({ cwd: ROOT });
  const workspace = relevantWorkspaceProjects();
  const configs = [...workspace.configs.map((path) => resolve(ROOT, path)), resolve(ROOT, FIXTURE_TSCONFIG)];
  const snapshot = api.updateSnapshot({ openProjects: configs });
  return { api, snapshot, projects: snapshot.getProjects(), workspace };
}

function sortedReaders(readers: readonly PinRead[]): PinRead[] {
  return [...readers].sort((a, b) => `${a.file}\0${a.owner}\0${a.key}`.localeCompare(`${b.file}\0${b.owner}\0${b.key}`));
}

describe('store driver release reader inventory (RFC §5 step 4)', () => {
  it('holds every typed production pin read to the explicit 4a baseline and tests known escape forms', () => {
    const { api, snapshot, projects, workspace } = openProjects();
    try {
      const production = projects.filter((project) => workspace.configs.some((path) => resolve(project.configFileName) === resolve(ROOT, path)));
      expect(workspace.configs).toContain('packages/cli/tsconfig.json');
      const actual = findPinReads(production, workspace.roots);
      expect(actual).toEqual(sortedReaders(PIN_READERS));

      const fixtureProject = projects.find((project) => resolve(project.configFileName) === resolve(ROOT, FIXTURE_TSCONFIG));
      expect(fixtureProject).toBeDefined();
      expect(fixtureProject!.program.getSourceFileNames().some((name) => name.endsWith('readers.tsx'))).toBe(true);
      const fixtures = findPinReads([fixtureProject!], ['packages/control-plane-api/test/fixtures/store-driver-reader-inventory']);
      expect(fixtures).toEqual(sortedReaders([
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'arrayElement', key: 'releases' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'computed', key: 'operations' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'destructured', key: 'platformOperations' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'dot', key: 'releases' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'helperParameter', key: 'operations' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'optional', key: 'className' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'pickProjection', key: 'releases' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'spread', key: 'className' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'spread', key: 'operations' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'spread', key: 'platformOperations' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.ts', owner: 'spread', key: 'releases' },
        { file: 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/readers.tsx', owner: 'view', key: 'className' },
      ]));
    } finally {
      snapshot.dispose();
      api.close();
    }
    // Over the node budget by design: it type-checks every member that can hold a registration
    // (about fifty programs): 12–50 s locally on a loaded machine.
  }, 120_000);

  it('keeps the files with test-only pin reads listed for the 4b migration', () => {
    for (const path of TEST_PIN_READERS) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });
});
