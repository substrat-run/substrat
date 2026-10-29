import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API, SymbolFlags } from 'typescript/unstable/sync';
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
  { file: 'packages/control-plane-api/src/store-script.ts', owner: 'scriptEnsurer', key: 'releases' },
  { file: 'packages/control-plane-api/src/store-script.ts', owner: 'scriptEnsurer', key: 'className' },
  { file: 'packages/control-plane-api/src/store-releases.ts', owner: 'schemaOf', key: 'releases' },
];

/** Test-only direct reads; 4b updates these tests along with the production readers. */
const TEST_PIN_READERS = [
  'packages/control-plane-api/test/store-script.test.ts',
  'packages/control-plane-api/test/store-releases.test.ts',
  'packages/control-plane-api/test/upload-scope-store-bindings.test.ts',
];

const PRODUCTION_TSCONFIGS = [
  'packages/contracts/tsconfig.json',
  'packages/control-plane-api/tsconfig.json',
  'apps/control-plane/tsconfig.json',
] as const;
const FIXTURE_TSCONFIG = 'packages/control-plane-api/test/fixtures/store-driver-reader-inventory/tsconfig.json';
const PRODUCTION_ROOTS = [
  'packages/contracts/src/',
  'packages/control-plane-api/src/',
  'apps/control-plane/src/',
].map((path) => resolve(ROOT, path));

function inRoots(fileName: string, roots: readonly string[]): boolean {
  const absolute = resolve(fileName);
  return roots.some((root) => absolute.startsWith(`${resolve(ROOT, root)}/`));
}

function namedTypes(project: Project, source: TSNode, names: readonly string[]): TSCompilerType[] {
  return names.flatMap((name) => {
    const symbol = project.checker.resolveName(name, SymbolFlags.Type, source);
    return symbol ? [project.checker.getDeclaredTypeOfSymbol(symbol)] : [];
  });
}

function isReleaseBearingType(type: TSCompilerType | undefined, targets: readonly TSCompilerType[], project: Project): boolean {
  if (!type) return false;
  if (targets.some((target) => project.checker.isTypeAssignableTo(type, target) && project.checker.isTypeAssignableTo(target, type))) return true;
  if (type.isUnionType() || type.isIntersectionType()) return type.getTypes().some((part) => isReleaseBearingType(part, targets, project));
  if (type.isTypeParameter()) return isReleaseBearingType(type.getConstraint(), targets, project);
  if (project.checker.isArrayType(type)) {
    return project.checker.getTypeArguments(type).some((part) => isReleaseBearingType(part, targets, project));
  }
  return false;
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

function bindingSourceType(node: TSNode, project: Project): TSCompilerType | undefined {
  let pattern: TSNode = node.parent;
  while (isObjectBindingPattern(pattern) && isBindingElement(pattern.parent)) pattern = pattern.parent.parent;
  if (isObjectBindingPattern(pattern) && isVariableDeclaration(pattern.parent) && pattern.parent.initializer) {
    return project.checker.getTypeAtLocation(pattern.parent.initializer);
  }
  if (isObjectBindingPattern(pattern) && isParameterDeclaration(pattern.parent)) return project.checker.getTypeAtLocation(pattern.parent);
  return undefined;
}

function findPinReads(projects: readonly Project[], roots: readonly string[], includeDerivedScriptRecords = false): PinRead[] {
  const found = new Map<string, PinRead>();
  for (const project of projects) {
    const sourceNames = project.program.getSourceFileNames().filter((fileName) => inRoots(fileName, roots));
    for (const fileName of sourceNames) {
      const source = project.program.getSourceFile(fileName);
      if (!source) continue;
      const file = relative(ROOT, source.fileName).replaceAll('\\', '/');
      const targets = namedTypes(project, source, includeDerivedScriptRecords ? ['StoreDriverRegistration', 'EnsuredScript'] : ['StoreDriverRegistration']);
      const add = (node: TSNode, key: PinKey) => {
        const read = { file, owner: functionOwner(node), key };
        found.set(`${read.file}\0${read.owner}\0${read.key}`, read);
      };
      const visit = (node: TSNode): void => {
        if (isPropertyAccessExpression(node) && PIN_KEYS.includes(node.name.text as PinKey) && isReleaseBearingType(project.checker.getTypeAtLocation(node.expression), targets, project)) {
          add(node, node.name.text as PinKey);
        } else if (isElementAccessExpression(node) && PIN_KEYS.includes(keyName(node.argumentExpression) as PinKey) && isReleaseBearingType(project.checker.getTypeAtLocation(node.expression), targets, project)) {
          add(node, keyName(node.argumentExpression) as PinKey);
        } else if (isBindingElement(node) && isObjectBindingPattern(node.parent) && isReleaseBearingType(bindingSourceType(node, project), targets, project)) {
          if (node.dotDotDotToken) {
            for (const key of PIN_KEYS) add(node, key);
          } else {
            const key = keyName(node.propertyName ?? node.name);
            if (key && PIN_KEYS.includes(key as PinKey)) add(node, key as PinKey);
          }
        } else if (isSpreadAssignment(node) && isReleaseBearingType(project.checker.getTypeAtLocation(node.expression), targets, project)) {
          for (const key of PIN_KEYS) add(node, key);
        } else if (isSpreadElement(node) && isReleaseBearingType(project.checker.getTypeAtLocation(node.expression), targets, project)) {
          for (const key of PIN_KEYS) add(node, key);
        }
        node.forEachChild(visit);
      };
      source.forEachChild(visit);
    }
  }
  return [...found.values()].sort((a, b) => `${a.file}\0${a.owner}\0${a.key}`.localeCompare(`${b.file}\0${b.owner}\0${b.key}`));
}

function openProjects() {
  const api = new API({ cwd: ROOT });
  const configs = [...PRODUCTION_TSCONFIGS, FIXTURE_TSCONFIG].map((path) => resolve(ROOT, path));
  const snapshot = api.updateSnapshot({ openProjects: configs });
  return { api, snapshot, projects: snapshot.getProjects() };
}

function sortedReaders(readers: readonly PinRead[]): PinRead[] {
  return [...readers].sort((a, b) => `${a.file}\0${a.owner}\0${a.key}`.localeCompare(`${b.file}\0${b.owner}\0${b.key}`));
}

describe('store driver release reader inventory (RFC §5 step 4)', () => {
  it('holds every typed production pin read to the explicit 4a baseline and tests known escape forms', () => {
    const { api, snapshot, projects } = openProjects();
    try {
      const production = projects.filter((project) => PRODUCTION_TSCONFIGS.some((path) => resolve(project.configFileName) === resolve(ROOT, path)));
      const actual = findPinReads(production, ['packages/contracts/src', 'packages/control-plane-api/src', 'apps/control-plane/src'], true);
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
  });

  it('keeps the files with test-only pin reads listed for the 4b migration', () => {
    for (const path of TEST_PIN_READERS) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });
});
