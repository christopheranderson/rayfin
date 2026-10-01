import { describe, expectTypeOf, it } from 'vitest';

type Assert<T extends true> = T;
type StorageExport =
  | 'blob'
  | 'StorageObject'
  | 'ContentTypes'
  | 'bytes'
  | 'kb'
  | 'mb'
  | 'gb';
type StableExports = keyof typeof import('../index.js');
type ExperimentalExports = keyof typeof import('../experimental/index.js');

export type StableStorageExportsStayPrivate = Assert<
  Extract<StorageExport, StableExports> extends never ? true : false
>;

export type ExperimentalStorageExportsStayAvailable = Assert<
  StorageExport extends ExperimentalExports ? true : false
>;

describe('experimental export boundaries', () => {
  it('keeps storage exports off the stable entrypoint', () => {
    expectTypeOf<
      Extract<StorageExport, StableExports>
    >().toEqualTypeOf<never>();
  });

  it('keeps storage exports available from the experimental entrypoint', () => {
    expectTypeOf<StorageExport>().toExtend<ExperimentalExports>();
  });
});
