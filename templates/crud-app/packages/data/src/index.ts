/**
 * Data package - owns Todo and Category entities.
 * Image lives in the shared package to demonstrate
 * cross-package entity distribution in a workspace.
 *
 * The CLI discovers entities by importing this package's exports
 * entry (package.json "exports"), so all entity classes must be
 * re-exported here.
 */
export { Todo } from './Todo.js';
export { Category } from './Category.js';
export { Image } from '@workspace-todo-app/shared';

import { Image } from '@workspace-todo-app/shared';

import { Category } from './Category.js';
import { Todo } from './Todo.js';

/**
 * Combined schema type covering all entities across packages.
 */
export type TodoAppSchema = {
  Todo: Todo;
  Category: Category;
  Image: Image;
};
