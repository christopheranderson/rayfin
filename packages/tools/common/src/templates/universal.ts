export {
  findTemplateByName,
  generateProjectSlug,
  isValidProjectName,
  PROJECT_NAME_REGEX,
  PROJECT_SLUG_REGEX,
  transformProjectName,
} from './validation.js';

export {
  addBundledTemplateAliases,
  customizeTemplateFiles,
  readTemplatesFromDirectory,
  visibleTemplates,
} from './scaffolding.js';

export type { TemplateFs } from './scaffolding.js';

export type { ProjectNames, TemplateInfo, TemplateMetadata } from './types.js';

export { isGitUrl } from './types.js';
