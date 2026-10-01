import { describe, expect, it } from 'vitest';

import {
  addBundledTemplateAliases,
  readTemplatesFromDirectory,
  visibleTemplates,
  type TemplateFs,
} from '../scaffolding';
import type { TemplateInfo } from '../types';
import { findTemplateByName } from '../validation';

class InMemoryTemplateFs implements TemplateFs {
  constructor(private readonly files: Record<string, string>) {}

  readDir(path: string): string[] {
    const prefix = `${path}/`;
    const entries = new Set<string>();

    for (const filePath of Object.keys(this.files)) {
      if (!filePath.startsWith(prefix)) {
        continue;
      }

      const relativePath = filePath.slice(prefix.length);
      const [entry] = relativePath.split('/');
      if (entry) {
        entries.add(entry);
      }
    }

    return [...entries].sort();
  }

  readFile(path: string): string {
    const content = this.files[path];
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  writeFile(): void {
    throw new Error('Not implemented');
  }

  exists(path: string): boolean {
    return path in this.files;
  }

  isDirectory(path: string): boolean {
    const prefix = `${path}/`;
    return Object.keys(this.files).some((filePath) =>
      filePath.startsWith(prefix)
    );
  }

  joinPath(...segments: string[]): string {
    return segments.join('/');
  }

  copyDir(): void {
    throw new Error('Not implemented');
  }
}

describe('readTemplatesFromDirectory', () => {
  it('skips package directories without template metadata', () => {
    const fs = new InMemoryTemplateFs({
      '/samples/blank-app/package.json': JSON.stringify({
        name: 'blank-app',
        template: {
          name: 'blankapp',
          displayName: 'Blank App',
          description: 'A blank Rayfin app',
        },
      }),
      '/samples/welcome-app/package.json': JSON.stringify({
        name: 'welcome-app-react-basic',
        description: 'A sample that should not be exposed as a template',
      }),
    });

    const templates = readTemplatesFromDirectory('/samples', true, fs);

    expect(templates.map((template) => template.name)).toEqual(['blankapp']);
  });

  it('carries the hidden flag through, defaulting to false', () => {
    const fs = new InMemoryTemplateFs({
      '/samples/blank-app/package.json': JSON.stringify({
        name: 'blank-app',
        template: {
          name: 'blankapp',
          displayName: 'Blank App',
          description: 'A blank Rayfin app',
        },
      }),
      '/samples/universal-app/package.json': JSON.stringify({
        name: 'universal-app',
        template: {
          name: 'universal-app',
          displayName: 'Universal App',
          description: 'Grows into anything',
          hidden: true,
        },
      }),
    });

    const templates = readTemplatesFromDirectory('/samples', true, fs);
    const byName = Object.fromEntries(templates.map((t) => [t.name, t]));

    expect(byName['universal-app'].hidden).toBe(true);
    expect(byName['blankapp'].hidden).toBe(false);
  });
});

describe('visibleTemplates', () => {
  const template = (name: string, hidden?: boolean): TemplateInfo => ({
    name,
    displayName: name,
    description: name,
    hidden,
    path: `/samples/${name}`,
    packageJson: {},
    isLocal: true,
  });

  it('drops hidden templates from a listing', () => {
    const templates = [
      template('blankapp'),
      template('universal-app', true),
      template('dataapp', false),
    ];

    expect(visibleTemplates(templates).map((t) => t.name)).toEqual([
      'blankapp',
      'dataapp',
    ]);
  });

  it('leaves lookup by name alone', () => {
    // The point of hiding is that the template still ships. If resolution ever
    // starts filtering on `hidden`, every caller that was given the name breaks
    // and the flag becomes a delete.
    const templates = [template('blankapp'), template('universal-app', true)];

    expect(findTemplateByName(templates, 'universal-app')?.name).toBe(
      'universal-app'
    );
  });
});

describe('addBundledTemplateAliases', () => {
  const template = (
    name: string,
    path: string,
    hidden?: boolean
  ): TemplateInfo => ({
    name,
    displayName: name,
    description: name,
    hidden,
    path,
    packageJson: {},
    isLocal: false,
  });

  it('aliases the Universal App as blankapp and replaces a shadowing template', () => {
    const templates = addBundledTemplateAliases([
      template('blankapp', '/templates/blank-app'),
      template('universal-app', '/templates/universal-app', true),
    ]);

    expect(templates).toEqual([
      expect.objectContaining({ name: 'universal-app', hidden: true }),
      expect.objectContaining({
        name: 'blankapp',
        hidden: false,
        path: '/templates/universal-app',
      }),
    ]);
  });
});
