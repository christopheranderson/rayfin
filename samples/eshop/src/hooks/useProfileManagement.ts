import { useState, useCallback, useEffect } from 'react';

import { Customer } from '../../rayfin/data/Customer';
import { ServiceContainer } from '../services/ServiceContainer';

export interface ProfileFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  dateOfBirth?: Date;
}

export interface UseProfileManagementReturn {
  profile: Customer | null;
  formData: ProfileFormData;
  loading: boolean;
  error: string | null;
  isSaving: boolean;
  setFormData: (data: ProfileFormData) => void;
  updateFormField: (field: keyof ProfileFormData, value: string) => void;
  saveProfile: () => Promise<boolean>;
  refreshProfile: () => Promise<void>;
  clearError: () => void;
  hasChanges: boolean;
}

export function useProfileManagement(): UseProfileManagementReturn {
  const [profile, setProfile] = useState<Customer | null>(null);
  const [formData, setFormData] = useState<ProfileFormData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [originalData, setOriginalData] = useState<ProfileFormData>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const customerService = ServiceContainer.getInstance().customerService;

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const refreshProfile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedProfile = await customerService.getProfile();
      setProfile(fetchedProfile);

      if (fetchedProfile) {
        const profileFormData: ProfileFormData = {
          firstName: fetchedProfile.firstName || '',
          lastName: fetchedProfile.lastName || '',
          email: fetchedProfile.user?.Email || '',
          phone: fetchedProfile.phone || '',
          dateOfBirth: fetchedProfile.dateOfBirth,
        };
        setFormData(profileFormData);
        setOriginalData(profileFormData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch profile');
      console.error('Failed to fetch profile:', err);
    } finally {
      setLoading(false);
    }
  }, [customerService]);

  const updateFormField = useCallback(
    (field: keyof ProfileFormData, value: string) => {
      setFormData((prev) => ({
        ...prev,
        [field]: value,
      }));
    },
    []
  );

  const saveProfile = useCallback(async (): Promise<boolean> => {
    setIsSaving(true);
    setError(null);
    try {
      if (!profile) {
        // For now, we'll only support updating existing profiles
        // Customer profile creation would need to be handled during user registration
        throw new Error(
          'No customer profile found. Please contact support to create your profile.'
        );
      } else {
        // Update existing profile
        const updatedProfile = await customerService.updateProfile({
          firstName: formData.firstName,
          lastName: formData.lastName,
          phone: formData.phone || undefined,
          dateOfBirth: formData.dateOfBirth,
        });
        setProfile(updatedProfile);

        // Update original data to reflect the saved state
        setOriginalData(formData);
        return true;
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Failed to save profile';
      setError(errorMessage);
      console.error('Failed to save profile:', err);
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [customerService, profile, formData]);

  // Check if there are unsaved changes
  const hasChanges = JSON.stringify(formData) !== JSON.stringify(originalData);

  // Load profile on mount
  useEffect(() => {
    refreshProfile();
  }, [refreshProfile]);

  return {
    profile,
    formData,
    loading,
    error,
    isSaving,
    setFormData,
    updateFormField,
    saveProfile,
    refreshProfile,
    clearError,
    hasChanges,
  };
}
