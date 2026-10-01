/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
  addBundledTemplateAliases,
  transformProjectName,
  type TemplateInfo,
  type TemplateMetadata,
} from '@microsoft/rayfin-tools-common/_internal/templates/universal';
import * as vscode from 'vscode';

import { ext } from '../extensionVariables';
import { fileExists, readTextFile, writeTextFile } from '../utils/fs';

/**
 * Manages bundled templates shipped inside the VS Code extension.
 *
 * All file operations use `vscode.workspace.fs` and `vscode.Uri` so the
 * service works in both desktop and web extension hosts without importing
 * Node.js built-ins (`node:fs`, `node:path`).
 *
 * Templates live at `<extensionPath>/templates/<name>/` and are copied there
 * at build time by `scripts/bundle-template.mjs`.
 */
export class TemplateService {
  /**
   * URI of the bundled templates root inside the installed extension.
   */
  private get templatesDirUri(): vscode.Uri {
    return vscode.Uri.joinPath(ext.context.extensionUri, 'templates');
  }

  /**
   * Discover all bundled templates (those with a `"template"` field in their
   * package.json).
   */
  async listBundledTemplates(): Promise<TemplateInfo[]> {
    const dirUri = this.templatesDirUri;

    if (!(await fileExists(dirUri))) {
      return [];
    }

    const entries = await vscode.workspace.fs.readDirectory(dirUri);
    const templates: TemplateInfo[] = [];

    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }

      const templateUri = vscode.Uri.joinPath(dirUri, name);
      const pkgUri = vscode.Uri.joinPath(templateUri, 'package.json');

      if (!(await fileExists(pkgUri))) {
        continue;
      }

      try {
        const pkgJson = JSON.parse(await readTextFile(pkgUri)) as Record<
          string,
          unknown
        >;
        const metadata = (pkgJson.template ?? {}) as Partial<TemplateMetadata>;

        templates.push({
          name: metadata.name ?? name,
          displayName: metadata.displayName ?? name,
          description:
            metadata.description ??
            (pkgJson.description as string) ??
            'No description',
          hidden: metadata.hidden === true,
          path: templateUri.fsPath,
          packageJson: pkgJson,
          isLocal: false,
        });
      } catch {
        // Skip entries with unreadable package.json
      }
    }

    return addBundledTemplateAliases(templates);
  }

  /**
   * Check whether a specific template is bundled in the extension.
   */
  async hasBundledTemplate(templateName: string): Promise<boolean> {
    const templates = await this.listBundledTemplates();
    return templates.some((t) => t.name === templateName);
  }

  /**
   * Scaffold a project from a bundled template.
   *
   * 1. Copies template files into `targetUri`.
   * 2. Applies project-name substitutions (package.json name, README placeholders).
   *
   * Returns the URI of the scaffolded project.
   */
  async scaffoldProject(
    templateName: string,
    targetUri: vscode.Uri,
    projectName: string
  ): Promise<vscode.Uri> {
    const templates = await this.listBundledTemplates();
    const template = templates.find((t) => t.name === templateName);
    if (!template) {
      throw new Error(
        `Bundled template "${templateName}" not found in extension.`
      );
    }

    const sourceUri = vscode.Uri.file(template.path);

    // Copy the entire template tree
    await vscode.workspace.fs.copy(sourceUri, targetUri, { overwrite: false });

    // Apply project-name customizations
    await this.customizeProject(targetUri, projectName);

    return targetUri;
  }

  /**
   * Apply project-name substitutions to package.json and README.md inside a
   * scaffolded project directory using VS Code workspace APIs.
   */
  private async customizeProject(
    targetUri: vscode.Uri,
    projectName: string
  ): Promise<void> {
    const names = transformProjectName(projectName);

    // Update package.json name field
    const pkgUri = vscode.Uri.joinPath(targetUri, 'package.json');
    if (await fileExists(pkgUri)) {
      try {
        const pkgJson = JSON.parse(await readTextFile(pkgUri)) as Record<
          string,
          unknown
        >;
        pkgJson.name = names.kebab;
        await writeTextFile(pkgUri, JSON.stringify(pkgJson, null, 2) + '\n');
      } catch {
        // Non-fatal — leave package.json as-is
      }
    }

    // Replace mustache-style placeholders in README.md
    const readmeUri = vscode.Uri.joinPath(targetUri, 'README.md');
    if (await fileExists(readmeUri)) {
      try {
        let content = await readTextFile(readmeUri);
        content = content.replace(/{{PROJECT_NAME}}/g, names.display);
        content = content.replace(/{{PROJECT_NAME_KEBAB}}/g, names.kebab);
        content = content.replace(/{{PROJECT_NAME_PASCAL}}/g, names.pascal);
        await writeTextFile(readmeUri, content);
      } catch {
        // Non-fatal
      }
    }
  }
}
