export interface ServiceDependencyState {
  dataEnabled: boolean;
  storageEnabled: boolean;
}

export interface ServiceDependencyValidationError {
  code: 'storage-requires-data';
  message: string;
  hint: string;
}

export function validateServiceDependencies(
  state: ServiceDependencyState
): ServiceDependencyValidationError[] {
  if (state.storageEnabled && !state.dataEnabled) {
    return [
      {
        code: 'storage-requires-data',
        message: 'Storage requires the Data service.',
        hint: 'Enable services.data or disable services.storage in rayfin.yml.',
      },
    ];
  }

  return [];
}
