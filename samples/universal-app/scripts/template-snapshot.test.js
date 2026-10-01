import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertTemplateUnchanged,
  snapshotTemplate,
} from './template-snapshot.js';

function withTemplateFixture(run) {
  const templateDir = mkdtempSync(join(tmpdir(), 'universal-app-template-'));
  try {
    writeFileSync(join(templateDir, 'source.ts'), 'export const value = 1;\n');
    run(templateDir);
  } finally {
    rmSync(templateDir, { recursive: true, force: true });
  }
}

test('generated output creation changes the template snapshot', () => {
  withTemplateFixture((templateDir) => {
    const before = snapshotTemplate(templateDir);
    mkdirSync(join(templateDir, 'dist'));
    writeFileSync(join(templateDir, 'dist', 'bundle.js'), 'generated\n');

    assert.throws(
      () => assertTemplateUnchanged(before, snapshotTemplate(templateDir)),
      (error) => {
        assert.match(error.message, /- dist\n/);
        assert.match(error.message, /- dist\/bundle\.js/);
        return true;
      }
    );
  });
});

test('snapshot keys use slash-separated relative paths', () => {
  withTemplateFixture((templateDir) => {
    mkdirSync(join(templateDir, 'packages', 'frontend'), { recursive: true });
    writeFileSync(
      join(templateDir, 'packages', 'frontend', 'package.json'),
      '{}\n'
    );

    const keys = [...snapshotTemplate(templateDir).keys()];

    assert.ok(keys.includes('packages/frontend'));
    assert.ok(keys.includes('packages/frontend/package.json'));
    assert.ok(keys.every((key) => !key.includes('\\')));
  });
});

test('generated output modification and deletion change the snapshot', () => {
  withTemplateFixture((templateDir) => {
    for (const directory of ['.temp', '.vite', 'coverage']) {
      mkdirSync(join(templateDir, directory));
      writeFileSync(join(templateDir, directory, 'output'), 'before\n');
    }
    const before = snapshotTemplate(templateDir);

    rmSync(join(templateDir, '.temp'), { recursive: true });
    writeFileSync(join(templateDir, '.vite', 'output'), 'after\n');
    unlinkSync(join(templateDir, 'coverage', 'output'));

    assert.throws(
      () => assertTemplateUnchanged(before, snapshotTemplate(templateDir)),
      (error) => {
        assert.match(error.message, /- \.temp/);
        assert.match(error.message, /- \.vite\/output/);
        assert.match(error.message, /- coverage\/output/);
        return true;
      }
    );
  });
});

test('node_modules is the only excluded template directory', () => {
  withTemplateFixture((templateDir) => {
    const before = snapshotTemplate(templateDir);
    mkdirSync(join(templateDir, 'node_modules', 'dependency'), {
      recursive: true,
    });
    writeFileSync(
      join(templateDir, 'node_modules', 'dependency', 'package.json'),
      '{}\n'
    );

    assert.doesNotThrow(() =>
      assertTemplateUnchanged(before, snapshotTemplate(templateDir))
    );
  });
});
