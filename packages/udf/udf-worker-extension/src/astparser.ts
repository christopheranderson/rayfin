import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { extractHandlerAudiences } from './internal/contextAudiences.js';

/**
 * Parsed file metadata used by the AST parser utility.
 *
 * @internal
 */
interface ParsedFile {
  filePath: string;
  sourceFile: ts.SourceFile;
  program: ts.Program;
}

/**
 * Basic function-shape metadata extracted from TypeScript source.
 *
 * @internal
 */
interface FunctionInfo {
  name: string;
  parameters: Array<{
    name: string;
    type?: string;
    optional: boolean;
  }>;
  returnType?: string;
  isAsync: boolean;
  isExported: boolean;
  filePath: string;
}

/**
 * Structural representation of a discovered TypeScript type.
 *
 * @internal
 */
interface TypeStructure {
  name: string;
  properties: Array<{
    name: string;
    type: string;
    optional: boolean;
  }>;
}

/**
 * Parsed delegate-parameter metadata for UDF registrations.
 *
 * @internal
 */
interface ParameterInfo {
  name: string;
  type?: string;
  optional: boolean;
  hasDefault: boolean;
  position: number;
  isFabricParameter: boolean;
  fabricParameterType?: string; // The specific fabric type (e.g., 'FabricContext', 'FabricSqlConnection')
}

/**
 * Classification summary for function parameters.
 *
 * @internal
 */
interface FabricParameterSummary {
  fabricParameters: ParameterInfo[];
  businessParameters: ParameterInfo[];
  totalParameters: number;
}

/**
 * Validation details when comparing delegate parameters with generic input types.
 *
 * @internal
 */
interface ParameterValidationError {
  hasErrors: boolean;
  missingParameters: string[]; // Parameters in generic type but not in function
  extraParameters: string[]; // Parameters in function but not in generic type
  typeMismatches: Array<{
    parameterName: string;
    expectedType: string;
    actualType: string;
  }>;
}

/**
 * Metadata captured from a `FabricUdf.func(...)` registration.
 *
 * @internal
 */
interface FabricUdfFunctionInfo {
  functionName: string;
  genericType?: {
    typeName: string;
    structure?: TypeStructure;
  };
  delegateParameters: ParameterInfo[];
  parameterSummary: FabricParameterSummary;
  returnType?: string;
  returnTypeStructure?: TypeStructure;
  parameterValidation: ParameterValidationError;
  isAsync: boolean;
  filePath: string;
  hasDataConnections: boolean;
  /**
   * Audience types declared on the handler's `RayfinContext` annotation.
   * These become generic `FabricItem` input bindings at registration time.
   */
  genericAudiences: string[];
  sourceText: string;
}

/**
 * Import metadata extracted from TypeScript source files.
 *
 * @internal
 */
interface ImportInfo {
  moduleSpecifier: string;
  namedImports: string[];
  defaultImport?: string;
  namespaceImport?: string;
  filePath: string;
}

/**
 * AST parser utility for extracting UDF metadata from source code.
 *
 * @internal
 */
class TypeScriptProjectParser {
  private rootPath: string;
  private parsedFiles: Map<string, ParsedFile> = new Map();
  private program: ts.Program | null = null;
  private typeChecker: ts.TypeChecker | null = null;

  // Configurable list of Fabric parameter types
  private fabricParameterTypes: Set<string> = new Set([
    'FabricContext',
    'FabricSqlConnection',
    'FabricConnection',
    'DataConnection',
    'FabricUdf',
    'FabricLogger',
    // Add more Fabric types here as needed
  ]);

  constructor(rootPath = './src/functions', customFabricTypes?: string[]) {
    this.rootPath = path.resolve(rootPath);

    // Allow custom fabric types to be added
    if (customFabricTypes) {
      customFabricTypes.forEach((type) => this.fabricParameterTypes.add(type));
    }

    console.log(`Initializing TypeScript parser for: ${this.rootPath}`);
    console.log(
      `Recognized Fabric parameter types: ${Array.from(this.fabricParameterTypes).join(', ')}`
    );
  }

  /**
   * Add a new Fabric parameter type to the recognized types
   */
  public addFabricParameterType(typeName: string): void {
    this.fabricParameterTypes.add(typeName);
  }

  /**
   * Remove a Fabric parameter type from the recognized types
   */
  public removeFabricParameterType(typeName: string): void {
    this.fabricParameterTypes.delete(typeName);
  }

  /**
   * Get all currently recognized Fabric parameter types
   */
  public getFabricParameterTypes(): string[] {
    return Array.from(this.fabricParameterTypes);
  }

  /**
   * Scan and parse all TypeScript files in the root directory
   */
  public scanProject(): void {
    const tsFiles = this.discoverTypeScriptFiles();

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    };

    this.program = ts.createProgram(tsFiles, compilerOptions);
    this.typeChecker = this.program.getTypeChecker();

    for (const filePath of tsFiles) {
      this.parseFile(filePath);
    }
  }

  /**
   * Discover all TypeScript files in the root directory
   */
  private discoverTypeScriptFiles(): string[] {
    const files: string[] = [];

    const scanDirectory = (dir: string): void => {
      const entries = fs.readdirSync(dir);

      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          scanDirectory(fullPath);
        } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
          files.push(fullPath);
        }
      }
    };

    if (fs.existsSync(this.rootPath)) {
      scanDirectory(this.rootPath);
    }

    return files;
  }

  /**
   * Parse a single TypeScript file
   */
  private parseFile(filePath: string): void {
    if (!this.program) {
      throw new Error('Program not initialized. Call scanProject() first.');
    }

    const sourceFile = this.program.getSourceFile(filePath);
    if (!sourceFile) {
      console.warn(`Could not parse file: ${filePath}`);
      return;
    }

    this.parsedFiles.set(filePath, {
      filePath,
      sourceFile,
      program: this.program,
    });

    console.log(`Parsed: ${path.relative(this.rootPath, filePath)}`);
  }

  /**
   * Get all parsed files
   */
  public getParsedFiles(): ParsedFile[] {
    return Array.from(this.parsedFiles.values());
  }

  /**
   * Get source file by path
   */
  public getSourceFile(filePath: string): ts.SourceFile | undefined {
    const parsedFile = this.parsedFiles.get(filePath);
    return parsedFile?.sourceFile;
  }

  /**
   * Extract all FabricUdf.func registrations from all files
   */
  public getAllFabricUdfFunctions(): FabricUdfFunctionInfo[] {
    const udfFunctions: FabricUdfFunctionInfo[] = [];

    for (const parsedFile of this.parsedFiles.values()) {
      const fileUdfFunctions =
        this.extractFabricUdfFunctionsFromFile(parsedFile);
      udfFunctions.push(...fileUdfFunctions);
    }

    return udfFunctions;
  }

  /**
   * Extract FabricUdf.func registrations from a specific file
   */
  private extractFabricUdfFunctionsFromFile(
    parsedFile: ParsedFile
  ): FabricUdfFunctionInfo[] {
    const udfFunctions: FabricUdfFunctionInfo[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const udfInfo = this.extractFabricUdfFunctionInfo(
          node,
          parsedFile.filePath
        );
        if (udfInfo) {
          udfFunctions.push(udfInfo);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsedFile.sourceFile);
    return udfFunctions;
  }

  /**
   * Extract detailed information from a FabricUdf.func call expression
   */
  private extractFabricUdfFunctionInfo(
    node: ts.CallExpression,
    filePath: string
  ): FabricUdfFunctionInfo | null {
    // Check if this is a method call to "func"
    if (
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.getText() !== 'func'
    ) {
      return null;
    }

    // Check if we have at least 2 arguments (function name and delegate)
    if (node.arguments.length < 2) {
      return null;
    }

    // Extract generic type arguments if present
    let genericType:
      | { typeName: string; structure?: TypeStructure }
      | undefined;
    if (node.typeArguments && node.typeArguments.length > 0) {
      const typeArg = node.typeArguments[0];
      const typeName = typeArg.getText();
      const typeStructure = this.resolveTypeStructure(typeName, filePath);

      genericType = {
        typeName,
        structure: typeStructure,
      };
    }

    // Extract function name (first argument should be a string literal)
    const functionNameArg = node.arguments[0];
    if (!ts.isStringLiteral(functionNameArg)) {
      return null;
    }
    const functionName = functionNameArg.text;

    // Extract function delegate (second argument should be a function)
    const delegateArg = node.arguments[1];
    if (
      !ts.isArrowFunction(delegateArg) &&
      !ts.isFunctionExpression(delegateArg)
    ) {
      return null;
    }

    // Extract delegate parameters with position tracking and fabric parameter detection
    const delegateParameters: ParameterInfo[] = delegateArg.parameters.map(
      (param, index) => {
        const name = param.name.getText();
        const type = param.type ? param.type.getText() : undefined;
        const optional = !!param.questionToken;
        const hasDefault = !!param.initializer;
        const isFabricParameter = this.isFabricParameterType(type, name);
        const fabricParameterType = isFabricParameter ? type : undefined;

        return {
          name,
          type,
          optional,
          hasDefault,
          position: index,
          isFabricParameter,
          fabricParameterType,
        };
      }
    );

    // Create parameter summary
    const parameterSummary: FabricParameterSummary = {
      fabricParameters: delegateParameters.filter((p) => p.isFabricParameter),
      businessParameters: delegateParameters.filter(
        (p) => !p.isFabricParameter
      ),
      totalParameters: delegateParameters.length,
    };

    const isAsync = !!delegateArg.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword
    );
    const hasDataConnections = node.arguments.length > 2; // Third argument would be data connections
    const genericAudiences = extractHandlerAudiences(
      delegateArg,
      this.typeChecker ?? undefined
    );
    const sourceText = node.getText();

    // Extract return type from the delegate function
    const returnType = delegateArg.type
      ? delegateArg.type.getText()
      : undefined;

    // Resolve return type structure if return type is specified
    let returnTypeStructure: TypeStructure | undefined;
    if (returnType) {
      // Handle Promise<Type> pattern for async functions
      const asyncReturnTypeMatch = returnType.match(/^Promise<(.+)>$/);
      const actualReturnType = asyncReturnTypeMatch
        ? asyncReturnTypeMatch[1]
        : returnType;

      // Only try to resolve structure for custom types (not primitives)
      if (!this.isPrimitiveType(actualReturnType)) {
        returnTypeStructure = this.resolveTypeStructure(
          actualReturnType,
          filePath
        );
      }
    }

    // Validate parameters against generic type structure
    const parameterValidation = this.validateParameters(
      delegateParameters,
      genericType
    );

    return {
      functionName,
      genericType,
      delegateParameters,
      parameterSummary,
      returnType,
      returnTypeStructure,
      parameterValidation,
      isAsync,
      filePath: path.relative(this.rootPath, filePath),
      hasDataConnections,
      genericAudiences,
      sourceText,
    };
  }

  /**
   * Check if a parameter type or name indicates it's a Fabric parameter
   */
  private isFabricParameterType(type?: string, name?: string): boolean {
    // Check by type first
    if (type && this.fabricParameterTypes.has(type)) {
      return true;
    }

    // Fallback: check by common naming conventions
    if (name) {
      const lowerName = name.toLowerCase();
      if (
        lowerName === 'context' ||
        lowerName.includes('connection') ||
        lowerName.includes('fabric')
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Validate function parameters against generic type structure
   */
  private validateParameters(
    delegateParameters: ParameterInfo[],
    genericType?: { typeName: string; structure?: TypeStructure }
  ): ParameterValidationError {
    const validation: ParameterValidationError = {
      hasErrors: false,
      missingParameters: [],
      extraParameters: [],
      typeMismatches: [],
    };

    // If no generic type is specified, no validation needed
    if (!genericType || !genericType.structure) {
      return validation;
    }

    // Get business parameters (non-fabric parameters)
    const businessParams = delegateParameters.filter(
      (p) => !p.isFabricParameter
    );

    // If there's exactly one business parameter and it matches the generic type name,
    // we expect it to be an object with properties matching the generic type structure
    if (businessParams.length === 1) {
      const businessParam = businessParams[0];
      const paramType = businessParam.type;

      // If the parameter type matches the generic type name, it should contain
      // properties that match the generic type structure
      if (paramType === genericType.typeName) {
        // This is valid - the parameter is typed as the generic type
        return validation;
      }

      // If parameter type doesn't match generic type, it's a mismatch
      if (paramType && paramType !== genericType.typeName) {
        validation.hasErrors = true;
        validation.typeMismatches.push({
          parameterName: businessParam.name,
          expectedType: genericType.typeName,
          actualType: paramType,
        });
      }
    }

    // If there are multiple business parameters, check if they represent
    // individual properties of the generic type structure
    else if (businessParams.length > 1) {
      const genericProperties = new Set(
        genericType.structure.properties.map((p) => p.name)
      );
      const paramNames = new Set(businessParams.map((p) => p.name));

      // Check for missing parameters (in generic type but not in function parameters)
      for (const prop of genericType.structure.properties) {
        if (!prop.optional && !paramNames.has(prop.name)) {
          validation.hasErrors = true;
          validation.missingParameters.push(prop.name);
        }
      }

      // Check for extra parameters (in function parameters but not in generic type)
      for (const param of businessParams) {
        if (!genericProperties.has(param.name)) {
          validation.hasErrors = true;
          validation.extraParameters.push(param.name);
        }
      }

      // Check for type mismatches
      for (const param of businessParams) {
        const genericProp = genericType.structure.properties.find(
          (p) => p.name === param.name
        );
        if (genericProp && param.type && param.type !== genericProp.type) {
          validation.hasErrors = true;
          validation.typeMismatches.push({
            parameterName: param.name,
            expectedType: genericProp.type,
            actualType: param.type,
          });
        }
      }
    }

    // If no business parameters but generic type has required properties, that's an error
    else if (
      businessParams.length === 0 &&
      genericType.structure.properties.some((p) => !p.optional)
    ) {
      validation.hasErrors = true;
      validation.missingParameters = genericType.structure.properties
        .filter((p) => !p.optional)
        .map((p) => p.name);
    }

    return validation;
  }

  /**
   * Check if a type is a primitive TypeScript type
   */
  private isPrimitiveType(typeName: string): boolean {
    const primitiveTypes = [
      'string',
      'number',
      'boolean',
      'object',
      'undefined',
      'null',
      'void',
      'any',
      'unknown',
      'never',
      'bigint',
      'symbol',
      'Date',
      'Array',
      'Map',
      'Set',
      'WeakMap',
      'WeakSet',
      'Error',
      'RegExp',
    ];

    // Check for primitive types
    if (primitiveTypes.includes(typeName)) {
      return true;
    }

    // Check for array types like string[], number[]
    if (typeName.endsWith('[]')) {
      return true;
    }

    // Check for generic built-in types like Array<string>, Promise<number>
    if (typeName.match(/^(Array|Promise|Map|Set)<.+>$/)) {
      return true;
    }

    return false;
  }

  /**
   * Resolve the structure of a type by searching through parsed files
   */
  private resolveTypeStructure(
    typeName: string,
    contextFilePath: string
  ): TypeStructure | undefined {
    // First, try to find the type in the current file's imports and resolve it
    const contextParsedFile = this.parsedFiles.get(contextFilePath);
    if (!contextParsedFile) return undefined;

    // Look for type aliases and interfaces across all parsed files
    for (const parsedFile of this.parsedFiles.values()) {
      const typeStructure = this.extractTypeStructureFromFile(
        typeName,
        parsedFile
      );
      if (typeStructure) {
        return typeStructure;
      }
    }

    // If not found in parsed files, try to resolve through import statements
    const typeFromImports = this.resolveTypeFromImports(
      typeName,
      contextFilePath
    );
    if (typeFromImports) {
      return typeFromImports;
    }

    // If still not found, expand search to project workspace
    const typeFromWorkspace = this.resolveTypeFromWorkspace(typeName);
    if (typeFromWorkspace) {
      return typeFromWorkspace;
    }

    return undefined;
  }

  /**
   * Resolve type by following import statements in the context file
   */
  private resolveTypeFromImports(
    typeName: string,
    contextFilePath: string
  ): TypeStructure | undefined {
    const contextParsedFile = this.parsedFiles.get(contextFilePath);
    if (!contextParsedFile) return undefined;

    // Find import statements that might contain our type
    const imports = this.extractImportsFromFile(contextParsedFile);

    for (const importInfo of imports) {
      // Check if our type is in the named imports
      if (importInfo.namedImports.includes(typeName)) {
        const resolvedPath = this.resolveImportPath(
          importInfo.moduleSpecifier,
          contextFilePath
        );
        if (resolvedPath) {
          this.parseAdditionalTypeFile(resolvedPath);
          const parsedFile = this.parsedFiles.get(resolvedPath);
          if (parsedFile) {
            const typeStructure = this.extractTypeStructureFromFile(
              typeName,
              parsedFile
            );
            if (typeStructure) {
              return typeStructure;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Resolve import path from module specifier
   */
  private resolveImportPath(
    moduleSpecifier: string,
    contextFilePath: string
  ): string | undefined {
    // Handle relative imports
    if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
      const contextDir = path.dirname(contextFilePath);
      const resolvedPath = path.resolve(contextDir, moduleSpecifier);

      // Try with .ts extension
      if (fs.existsSync(resolvedPath + '.ts')) {
        return resolvedPath + '.ts';
      }

      // Try as directory with index.ts
      if (fs.existsSync(path.join(resolvedPath, 'index.ts'))) {
        return path.join(resolvedPath, 'index.ts');
      }

      // Try as-is if it already has an extension
      if (fs.existsSync(resolvedPath)) {
        return resolvedPath;
      }
    }

    // For absolute imports, we'd need more complex resolution
    // For now, return undefined for non-relative imports
    return undefined;
  }

  /**
   * Resolve type by scanning the broader project workspace
   */
  private resolveTypeFromWorkspace(
    typeName: string
  ): TypeStructure | undefined {
    // Find the project root (look for package.json)
    const projectRoot = this.findProjectRoot();
    if (!projectRoot) return undefined;

    // Scan for TypeScript files in the project
    const typeFiles = this.findTypeScriptFilesInProject(projectRoot);

    for (const filePath of typeFiles) {
      if (!this.parsedFiles.has(filePath)) {
        try {
          this.parseAdditionalTypeFile(filePath);
          const parsedFile = this.parsedFiles.get(filePath);
          if (parsedFile) {
            const typeStructure = this.extractTypeStructureFromFile(
              typeName,
              parsedFile
            );
            if (typeStructure) {
              return typeStructure;
            }
          }
        } catch (error) {
          // Silently continue if we can't parse a file
          continue;
        }
      }
    }

    return undefined;
  }

  /**
   * Find the project root by looking for package.json
   */
  private findProjectRoot(): string | undefined {
    let currentDir = this.rootPath;

    // Look upward for package.json
    while (currentDir !== path.dirname(currentDir)) {
      if (fs.existsSync(path.join(currentDir, 'package.json'))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }

    return undefined;
  }

  /**
   * Find TypeScript files in the project (limited search to avoid performance issues)
   */
  private findTypeScriptFilesInProject(projectRoot: string): string[] {
    const files: string[] = [];
    const maxFiles = 50; // Limit to prevent performance issues

    const scanDirectory = (dir: string, depth = 0): void => {
      if (files.length >= maxFiles || depth > 3) return; // Limit depth and file count

      try {
        const entries = fs.readdirSync(dir);

        for (const entry of entries) {
          if (files.length >= maxFiles) break;

          // Skip node_modules and other build directories
          if (
            entry === 'node_modules' ||
            entry === 'dist' ||
            entry === 'build'
          ) {
            continue;
          }

          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            scanDirectory(fullPath, depth + 1);
          } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Skip directories we can't read
        return;
      }
    };

    scanDirectory(projectRoot);
    return files;
  }

  /**
   * Parse an additional TypeScript file for type definitions
   */
  private parseAdditionalTypeFile(filePath: string): void {
    if (!this.program) return;

    try {
      const sourceText = fs.readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.ES2020,
        true
      );

      this.parsedFiles.set(filePath, {
        filePath,
        sourceFile,
        program: this.program,
      });
    } catch (error) {
      console.warn(`Error parsing additional type file: ${filePath}`, error);
    }
  }

  /**
   * Extract type structure from a specific parsed file
   */
  private extractTypeStructureFromFile(
    typeName: string,
    parsedFile: ParsedFile
  ): TypeStructure | undefined {
    let foundStructure: TypeStructure | undefined;

    const visit = (node: ts.Node) => {
      // Handle type aliases: export type SomeDto = { ... }
      if (ts.isTypeAliasDeclaration(node) && node.name.getText() === typeName) {
        foundStructure = this.parseTypeNode(node.type, typeName);
        return;
      }

      // Handle interfaces: export interface SomeDto { ... }
      if (ts.isInterfaceDeclaration(node) && node.name.getText() === typeName) {
        foundStructure = this.parseInterfaceDeclaration(node);
        return;
      }

      if (!foundStructure) {
        ts.forEachChild(node, visit);
      }
    };

    visit(parsedFile.sourceFile);
    return foundStructure;
  }

  /**
   * Parse a TypeScript type node into our structure format
   */
  private parseTypeNode(
    typeNode: ts.TypeNode,
    typeName: string
  ): TypeStructure | undefined {
    if (ts.isTypeLiteralNode(typeNode)) {
      return this.parseTypeLiteral(typeNode, typeName);
    }
    // Add more type node parsing as needed
    return undefined;
  }

  /**
   * Parse an interface declaration
   */
  private parseInterfaceDeclaration(
    node: ts.InterfaceDeclaration
  ): TypeStructure {
    const properties: Array<{ name: string; type: string; optional: boolean }> =
      [];

    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = member.name.getText();
        const type = member.type ? member.type.getText() : 'any';
        const optional = !!member.questionToken;

        properties.push({ name, type, optional });
      }
    }

    return {
      name: node.name.getText(),
      properties,
    };
  }

  /**
   * Parse a type literal node (object type)
   */
  private parseTypeLiteral(
    node: ts.TypeLiteralNode,
    typeName: string
  ): TypeStructure {
    const properties: Array<{ name: string; type: string; optional: boolean }> =
      [];

    for (const member of node.members) {
      if (ts.isPropertySignature(member) && member.name) {
        const name = member.name.getText();
        const type = member.type ? member.type.getText() : 'any';
        const optional = !!member.questionToken;

        properties.push({ name, type, optional });
      }
    }

    return {
      name: typeName,
      properties,
    };
  }

  /**
   * Extract all function declarations from all files
   */
  public getAllFunctions(): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    for (const parsedFile of this.parsedFiles.values()) {
      const fileFunctions = this.extractFunctionsFromFile(parsedFile);
      functions.push(...fileFunctions);
    }

    return functions;
  }

  /**
   * Extract function declarations from a specific file
   */
  private extractFunctionsFromFile(parsedFile: ParsedFile): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const funcInfo = this.extractFunctionInfo(node, parsedFile.filePath);
        if (funcInfo) {
          functions.push(funcInfo);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsedFile.sourceFile);
    return functions;
  }

  /**
   * Extract detailed information from a function node
   */
  private extractFunctionInfo(
    node: ts.FunctionLikeDeclaration,
    filePath: string
  ): FunctionInfo | null {
    const name = this.getFunctionName(node);
    if (!name) return null;

    const parameters = node.parameters.map((param) => ({
      name: param.name.getText(),
      type: param.type ? param.type.getText() : undefined,
      optional: !!param.questionToken,
    }));

    const returnType = node.type ? node.type.getText() : undefined;
    const isAsync = !!node.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.AsyncKeyword
    );
    const isExported = this.isExported(node);

    return {
      name,
      parameters,
      returnType,
      isAsync,
      isExported,
      filePath: path.relative(this.rootPath, filePath),
    };
  }

  /**
   * Get function name from various function node types
   */
  private getFunctionName(node: ts.FunctionLikeDeclaration): string | null {
    if (ts.isFunctionDeclaration(node) && node.name) {
      return node.name.getText();
    }

    // For arrow functions assigned to variables
    if (
      ts.isVariableDeclaration(node.parent) &&
      ts.isIdentifier(node.parent.name)
    ) {
      return node.parent.name.getText();
    }

    return null;
  }

  /**
   * Check if a node is exported
   */
  private isExported(node: ts.Node): boolean {
    return !!(
      ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export
    );
  }

  /**
   * Extract all import statements from all files
   */
  public getAllImports(): ImportInfo[] {
    const imports: ImportInfo[] = [];

    for (const parsedFile of this.parsedFiles.values()) {
      const fileImports = this.extractImportsFromFile(parsedFile);
      imports.push(...fileImports);
    }

    return imports;
  }

  /**
   * Extract import statements from a specific file
   */
  private extractImportsFromFile(parsedFile: ParsedFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const importInfo = this.extractImportInfo(node, parsedFile.filePath);
        if (importInfo) {
          imports.push(importInfo);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(parsedFile.sourceFile);
    return imports;
  }

  /**
   * Extract detailed information from an import declaration
   */
  private extractImportInfo(
    node: ts.ImportDeclaration,
    filePath: string
  ): ImportInfo | null {
    const moduleSpecifier = node.moduleSpecifier.getText().replace(/['"]/g, '');
    const namedImports: string[] = [];
    let defaultImport: string | undefined;
    let namespaceImport: string | undefined;

    if (node.importClause) {
      // Default import
      if (node.importClause.name) {
        defaultImport = node.importClause.name.getText();
      }

      // Named imports
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            namedImports.push(element.name.getText());
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          namespaceImport = node.importClause.namedBindings.name.getText();
        }
      }
    }

    return {
      moduleSpecifier,
      namedImports,
      defaultImport,
      namespaceImport,
      filePath: path.relative(this.rootPath, filePath),
    };
  }

  /**
   * Find nodes by type across all files
   */
  public findNodesByType<T extends ts.Node>(
    syntaxKind: ts.SyntaxKind,
    predicate?: (node: T) => boolean
  ): Array<{ node: T; filePath: string }> {
    const results: Array<{ node: T; filePath: string }> = [];

    for (const parsedFile of this.parsedFiles.values()) {
      const visit = (node: ts.Node) => {
        if (node.kind === syntaxKind) {
          const typedNode = node as T;
          if (!predicate || predicate(typedNode)) {
            results.push({
              node: typedNode,
              filePath: parsedFile.filePath,
            });
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(parsedFile.sourceFile);
    }

    return results;
  }

  /**
   * Search for nodes by text content
   */
  public searchByText(
    searchText: string
  ): Array<{ node: ts.Node; filePath: string; text: string }> {
    const results: Array<{ node: ts.Node; filePath: string; text: string }> =
      [];

    for (const parsedFile of this.parsedFiles.values()) {
      const visit = (node: ts.Node) => {
        const nodeText = node.getText();
        if (nodeText.includes(searchText)) {
          results.push({
            node,
            filePath: parsedFile.filePath,
            text: nodeText,
          });
        }

        ts.forEachChild(node, visit);
      };

      visit(parsedFile.sourceFile);
    }

    return results;
  }

  /**
   * Get type information for a node (requires type checker)
   */
  public getTypeInfo(node: ts.Node): string | undefined {
    if (!this.typeChecker) {
      console.warn('Type checker not available. Call scanProject() first.');
      return undefined;
    }

    const type = this.typeChecker.getTypeAtLocation(node);
    return this.typeChecker.typeToString(type);
  }

  /**
   * Generate a summary report of the parsed project
   */
  public generateSummaryReport(): void {
    console.log('\n=== TypeScript Project Analysis Summary ===');
    console.log(`Root Path: ${this.rootPath}`);
    console.log(`Files Parsed: ${this.parsedFiles.size}`);

    const functions = this.getAllFunctions();
    console.log(`Total Functions: ${functions.length}`);

    const udfFunctions = this.getAllFabricUdfFunctions();
    console.log(`FabricUdf Registered Functions: ${udfFunctions.length}`);

    const imports = this.getAllImports();
    console.log(`Total Imports: ${imports.length}`);

    console.log('\n--- Files Overview ---');
    for (const parsedFile of this.parsedFiles.values()) {
      const fileFunctions = this.extractFunctionsFromFile(parsedFile);
      const fileUdfFunctions =
        this.extractFabricUdfFunctionsFromFile(parsedFile);
      console.log(
        `${path.relative(this.rootPath, parsedFile.filePath)}: ${fileFunctions.length} functions, ${fileUdfFunctions.length} UDF registrations`
      );
    }

    if (udfFunctions.length > 0) {
      console.log('\n--- FabricUdf Function Registrations ---');
      udfFunctions.forEach((func) => {
        console.log(`- "${func.functionName}" (${func.filePath})`);
        console.log(
          `  Async: ${func.isAsync}, Has Data Connections: ${func.hasDataConnections}`
        );

        if (func.genericType) {
          console.log(`  Generic Type: <${func.genericType.typeName}>`);
          if (func.genericType.structure) {
            console.log(`    Type Structure:`);
            func.genericType.structure.properties.forEach((prop) => {
              const optional = prop.optional ? '?' : '';
              console.log(`      ${prop.name}${optional}: ${prop.type}`);
            });
          }
        }

        if (func.returnType) {
          console.log(`  Return Type: ${func.returnType}`);
          if (func.returnTypeStructure) {
            console.log(`    Return Type Structure:`);
            func.returnTypeStructure.properties.forEach((prop) => {
              const optional = prop.optional ? '?' : '';
              console.log(`      ${prop.name}${optional}: ${prop.type}`);
            });
          }
        }

        console.log(`  Parameters:`);
        func.delegateParameters.forEach((param) => {
          const fabricFlag = param.isFabricParameter
            ? ` [FABRIC: ${param.fabricParameterType || 'Unknown'}]`
            : '';
          const optional = param.optional ? '?' : '';
          console.log(
            `    Position ${param.position}: ${param.name}${optional}: ${param.type || 'any'}${fabricFlag}`
          );
        });

        // Show parameter summary
        console.log(`  Parameter Summary:`);
        console.log(
          `    Total Parameters: ${func.parameterSummary.totalParameters}`
        );
        console.log(
          `    Fabric Parameters: ${func.parameterSummary.fabricParameters.length}`
        );
        if (func.parameterSummary.fabricParameters.length > 0) {
          func.parameterSummary.fabricParameters.forEach((param) => {
            console.log(
              `      Position ${param.position}: ${param.name} (${param.fabricParameterType})`
            );
          });
        }
        console.log(
          `    Business Parameters: ${func.parameterSummary.businessParameters.length}`
        );
        if (func.parameterSummary.businessParameters.length > 0) {
          func.parameterSummary.businessParameters.forEach((param) => {
            console.log(
              `      Position ${param.position}: ${param.name}: ${param.type || 'any'}`
            );
          });
        }

        // Show parameter validation errors
        if (func.parameterValidation.hasErrors) {
          console.log(`  ⚠️  Parameter Validation Errors:`);

          if (func.parameterValidation.missingParameters.length > 0) {
            console.log(
              `    Missing required parameters: ${func.parameterValidation.missingParameters.join(', ')}`
            );
          }

          if (func.parameterValidation.extraParameters.length > 0) {
            console.log(
              `    Extra parameters not in generic type: ${func.parameterValidation.extraParameters.join(', ')}`
            );
          }

          if (func.parameterValidation.typeMismatches.length > 0) {
            console.log(`    Type mismatches:`);
            func.parameterValidation.typeMismatches.forEach((mismatch) => {
              console.log(
                `      ${mismatch.parameterName}: expected ${mismatch.expectedType}, got ${mismatch.actualType}`
              );
            });
          }
        } else if (func.genericType) {
          console.log(
            `  ✅ Parameter validation: All parameters match generic type structure`
          );
        }
      });
    }

    console.log('\n--- Standard Function Details ---');
    functions.forEach((func) => {
      console.log(`- ${func.name} (${func.filePath})`);
      console.log(`  Parameters: ${func.parameters.length}`);
      console.log(`  Async: ${func.isAsync}, Exported: ${func.isExported}`);
    });

    console.log('\n--- Import Summary ---');
    const uniqueModules = new Set(imports.map((imp) => imp.moduleSpecifier));
    console.log(`Unique modules imported: ${uniqueModules.size}`);
    uniqueModules.forEach((module) => {
      console.log(`- ${module}`);
    });
  }
}

// Example usage and initialization
/**
 * Create and run the local parser demo workflow.
 *
 * @returns A configured parser instance after scanning.
 *
 * @internal
 */
function initializeParser() {
  console.log('Initializing TypeScript AST Parser...');

  // Create parser instance pointing to src/functions directory
  // You can optionally pass custom fabric parameter types
  const customFabricTypes = ['MyCustomConnection', 'FabricProvider']; // Example custom types
  const parser = new TypeScriptProjectParser(
    './src/functions',
    customFabricTypes
  );

  // You can also add fabric types after initialization
  parser.addFabricParameterType('AnotherCustomType');

  console.log(
    `Currently recognized Fabric types: ${parser.getFabricParameterTypes().join(', ')}`
  );

  try {
    // Scan and parse the project
    parser.scanProject();

    // Generate summary report
    parser.generateSummaryReport();

    // Example: Get all FabricUdf registered functions
    const udfFunctions = parser.getAllFabricUdfFunctions();
    console.log('\n=== FabricUdf Registered Functions ===');
    udfFunctions.forEach((func) => {
      console.log(`Function Registration: "${func.functionName}"`);
      console.log(`  File: ${func.filePath}`);
      console.log(`  Async: ${func.isAsync}`);
      console.log(`  Has Data Connections: ${func.hasDataConnections}`);
      console.log(`  Return Type: ${func.returnType || 'unknown'}`);

      if (func.genericType) {
        console.log(`  Generic Type Argument: <${func.genericType.typeName}>`);
        if (func.genericType.structure) {
          console.log(`  Input Type Structure:`);
          func.genericType.structure.properties.forEach((prop) => {
            const optional = prop.optional ? ' (Optional)' : '';
            console.log(`    - ${prop.name}: ${prop.type}${optional}`);
          });
        } else {
          console.log(
            `  Type structure could not be resolved for: ${func.genericType.typeName}`
          );
        }
      }

      if (func.returnTypeStructure) {
        console.log(`  Return Type Structure:`);
        func.returnTypeStructure.properties.forEach((prop) => {
          const optional = prop.optional ? ' (Optional)' : '';
          console.log(`    - ${prop.name}: ${prop.type}${optional}`);
        });
      }

      console.log(`  Delegate Parameters:`);

      func.delegateParameters.forEach((param, index) => {
        const fabricIndicator = param.isFabricParameter
          ? ` (Fabric: ${param.fabricParameterType})`
          : '';
        const optionalIndicator = param.optional ? ' (Optional)' : '';
        console.log(
          `    ${index + 1}. Position ${param.position} - ${param.name}: ${param.type || 'any'}${fabricIndicator}${optionalIndicator}`
        );
      });

      console.log(`  Parameter Classification:`);
      console.log(
        `    Fabric Parameters (${func.parameterSummary.fabricParameters.length}): ${func.parameterSummary.fabricParameters.map((p) => `${p.name}@${p.position}`).join(', ') || 'None'}`
      );
      console.log(
        `    Business Parameters (${func.parameterSummary.businessParameters.length}): ${func.parameterSummary.businessParameters.map((p) => `${p.name}@${p.position}`).join(', ') || 'None'}`
      );

      // Show non-fabric parameters (the actual business parameters)
      const businessParams = func.delegateParameters.filter(
        (p) => !p.isFabricParameter
      );
      console.log(
        `  Business Parameters: ${businessParams.map((p) => `${p.name}: ${p.type || 'any'}`).join(', ')}`
      );

      // Show parameter validation results
      if (func.parameterValidation.hasErrors) {
        console.log(`  🚨 Parameter Validation ERRORS:`);

        if (func.parameterValidation.missingParameters.length > 0) {
          console.log(
            `    ❌ Missing required parameters: ${func.parameterValidation.missingParameters.join(', ')}`
          );
        }

        if (func.parameterValidation.extraParameters.length > 0) {
          console.log(
            `    ❌ Extra parameters not in generic type: ${func.parameterValidation.extraParameters.join(', ')}`
          );
        }

        if (func.parameterValidation.typeMismatches.length > 0) {
          console.log(`    ❌ Type mismatches:`);
          func.parameterValidation.typeMismatches.forEach((mismatch) => {
            console.log(
              `      - ${mismatch.parameterName}: expected '${mismatch.expectedType}', got '${mismatch.actualType}'`
            );
          });
        }
      } else if (func.genericType) {
        console.log(
          `  ✅ Parameter validation: PASSED - All parameters match generic type structure`
        );
      } else {
        console.log(
          `  ℹ️  Parameter validation: SKIPPED - No generic type specified`
        );
      }

      console.log('  ---');
    });

    // Example: Get all functions
    // const functions = parser.getAllFunctions();
    // console.log("\n=== All Functions Found ===");
    // functions.forEach(func => {
    //     console.log(`Function: ${func.name}`);
    //     console.log(`  File: ${func.filePath}`);
    //     console.log(`  Parameters: ${func.parameters.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type || 'any'}`).join(', ')}`);
    //     console.log(`  Return Type: ${func.returnType || 'unknown'}`);
    //     console.log(`  Async: ${func.isAsync}, Exported: ${func.isExported}`);
    //     console.log('---');
    // });

    // // Example: Get all imports
    // const imports = parser.getAllImports();
    // console.log("\n=== All Imports Found ===");
    // imports.forEach(imp => {
    //     console.log(`Import from: ${imp.moduleSpecifier} (${imp.filePath})`);
    //     if (imp.defaultImport) console.log(`  Default: ${imp.defaultImport}`);
    //     if (imp.namespaceImport) console.log(`  Namespace: ${imp.namespaceImport}`);
    //     if (imp.namedImports.length > 0) console.log(`  Named: ${imp.namedImports.join(', ')}`);
    // });

    // // Example: Find specific nodes (class declarations)
    // const classNodes = parser.findNodesByType(ts.SyntaxKind.ClassDeclaration);
    // console.log(`\n=== Classes Found: ${classNodes.length} ===`);
    // classNodes.forEach(({ node, filePath }) => {
    //     const className = (node as ts.ClassDeclaration).name?.getText() || 'unnamed';
    //     console.log(`Class: ${className} in ${path.relative('./src/functions', filePath)}`);
    // });

    // // Example: Search for specific text
    // const asyncResults = parser.searchByText('async');
    // console.log(`\n=== Nodes containing 'async': ${asyncResults.length} ===`);

    // // Example: Get parsed files for direct AST manipulation
    // const parsedFiles = parser.getParsedFiles();
    // console.log(`\n=== Parsed Files Available for Direct AST Access: ${parsedFiles.length} ===`);
    // parsedFiles.forEach(file => {
    //     console.log(`- ${path.relative('./src/functions', file.filePath)}`);
    // });

    return parser;
  } catch (error) {
    console.error('Error initializing parser:', error);
    throw error;
  }
}

// Additional helper functions for advanced AST manipulation
/**
 * Utility helpers for traversing and querying TypeScript AST nodes.
 *
 * @internal
 */
class ASTNodeVisitor {
  static visitAllNodes(
    sourceFile: ts.SourceFile,
    callback: (node: ts.Node, depth: number) => void,
    depth = 0
  ) {
    callback(sourceFile, depth);

    const visit = (node: ts.Node, currentDepth: number) => {
      callback(node, currentDepth);
      ts.forEachChild(node, (child) => visit(child, currentDepth + 1));
    };

    ts.forEachChild(sourceFile, (child) => visit(child, depth + 1));
  }

  static findNodeAtPosition(
    sourceFile: ts.SourceFile,
    position: number
  ): ts.Node | undefined {
    function find(node: ts.Node): ts.Node | undefined {
      if (position >= node.getStart() && position < node.getEnd()) {
        return ts.forEachChild(node, find) || node;
      }
      return undefined;
    }
    return find(sourceFile);
  }

  static getNodePath(node: ts.Node): ts.Node[] {
    const path: ts.Node[] = [];
    let current = node;

    while (current) {
      path.unshift(current);
      current = current.parent;
    }

    return path;
  }
}

// Export the main parser class and helper utilities
export { TypeScriptProjectParser, ASTNodeVisitor, initializeParser };

export type {
  FunctionInfo,
  ImportInfo,
  ParsedFile,
  FabricUdfFunctionInfo,
  TypeStructure,
  ParameterValidationError,
  ParameterInfo,
  FabricParameterSummary,
};

// Auto-initialize if this file is run directly
const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  initializeParser();
}
