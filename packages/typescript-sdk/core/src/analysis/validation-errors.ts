/**
 * Validation error aggregation system for schema analysis
 *
 * This module provides types and utilities for collecting validation errors
 * during schema analysis and reporting them together, allowing users to fix
 * multiple issues in one pass.
 */

/** @internal */
export type ValidationSeverity = 'error' | 'warning';

/** @internal */
export interface ValidationError {
  /**
   * The entity name where the error occurred
   */
  entity: string;

  /**
   * The field name where the error occurred (optional for entity-level errors)
   */
  field?: string;

  /**
   * Human-readable error message
   */
  message: string;

  /**
   * Optional hint on how to fix the error
   */
  fix?: string;

  /**
   * Severity of the validation error (default: 'error')
   * - 'error': Blocking error that prevents code generation
   * - 'warning': Non-blocking issue that should be addressed
   */
  severity?: ValidationSeverity;
}

/** @internal */
export class SchemaValidationError extends Error {
  public readonly errors: ValidationError[];
  public readonly warnings: ValidationError[];

  constructor(errors: ValidationError[]) {
    // Separate errors and warnings
    const actualErrors = errors.filter((e) => e.severity !== 'warning');
    const warnings = errors.filter((e) => e.severity === 'warning');

    const errorCount = actualErrors.length;
    const warningCount = warnings.length;

    let summary = '';
    if (errorCount > 0 && warningCount > 0) {
      summary = `Found ${errorCount} schema validation error${errorCount === 1 ? '' : 's'} and ${warningCount} warning${warningCount === 1 ? '' : 's'}`;
    } else if (errorCount > 0) {
      summary =
        errorCount === 1
          ? 'Found 1 schema validation error'
          : `Found ${errorCount} schema validation errors`;
    } else {
      summary =
        warningCount === 1
          ? 'Found 1 schema validation warning'
          : `Found ${warningCount} schema validation warnings`;
    }

    const formattedMessages = errors
      .map((err, idx) => {
        const location = err.field ? `${err.entity}.${err.field}` : err.entity;
        const severityLabel = err.severity === 'warning' ? '⚠️ ' : '';
        let errorMsg = `  ${idx + 1}. ${severityLabel}[${location}] ${err.message}`;
        if (err.fix) {
          errorMsg += `\n     Fix: ${err.fix}`;
        }
        return errorMsg;
      })
      .join('\n');

    super(`${summary}:\n\n${formattedMessages}`);
    this.name = 'SchemaValidationError';
    this.errors = actualErrors;
    this.warnings = warnings;
  }
}

/** @internal */
export class ValidationErrorCollector {
  private errors: ValidationError[] = [];

  /**
   * Add a validation error or warning to the collection
   */
  addError(error: ValidationError): void {
    this.errors.push(error);
  }

  /**
   * Check if any blocking errors have been collected (excludes warnings)
   */
  hasErrors(): boolean {
    return this.errors.some((e) => e.severity !== 'warning');
  }

  /**
   * Check if any issues (errors or warnings) have been collected
   */
  hasIssues(): boolean {
    return this.errors.length > 0;
  }

  /**
   * Get the count of blocking errors collected (excludes warnings)
   */
  getErrorCount(): number {
    return this.errors.filter((e) => e.severity !== 'warning').length;
  }

  /**
   * Get all collected errors and warnings
   */
  getErrors(): ValidationError[] {
    return [...this.errors];
  }

  /**
   * Throw a SchemaValidationError if any blocking errors were collected
   * Warnings alone will not cause this to throw
   */
  throwIfErrors(): void {
    if (this.hasErrors()) {
      throw new SchemaValidationError(this.errors);
    }
  }
}
