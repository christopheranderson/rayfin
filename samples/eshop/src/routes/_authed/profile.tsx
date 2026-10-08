import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Address } from '../../../rayfin/data/Address';

import { useAuth } from '@/contexts/AuthContext';
import { useAddressManagement } from '@/hooks/useAddressManagement';
import { useProfileManagement } from '@/hooks/useProfileManagement';
import { CreateAddressData } from '@/services/interfaces/IAddressService';
import {
  getAddressTypeLabel,
  getAddressTypeBadgeClasses,
  validateAddressData,
} from '@/utils/addressUtils';

export const Route = createFileRoute('/_authed/profile')({
  component: ProfileComponent,
});

function ProfileComponent() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<
    'profile' | 'orders' | 'addresses'
  >('profile');
  const [isEditing, setIsEditing] = useState(false);

  // Profile management
  const {
    profile,
    formData,
    loading: profileLoading,
    error: profileError,
    isSaving,
    updateFormField,
    saveProfile,
    clearError: clearProfileError,
    hasChanges,
  } = useProfileManagement();

  // Address management
  const {
    addresses,
    loading: addressLoading,
    error: addressError,
    isCreating,
    isUpdating,
    isDeleting,
    createAddress,
    updateAddress,
    deleteAddress,
    setAsDefault,
    clearError,
  } = useAddressManagement();

  const [showAddressForm, setShowAddressForm] = useState(false);
  const [editingAddress, setEditingAddress] = useState<Address | null>(null);
  const [addressFormData, setAddressFormData] = useState<CreateAddressData>({
    type: 'both',
    firstName: '',
    lastName: '',
    company: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
    phone: '',
    isDefault: false,
  });
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});

  const handleSave = async () => {
    const success = await saveProfile();
    if (success) {
      setIsEditing(false);
    }
  };

  const handleCancel = () => {
    // Reset form data and exit editing mode
    setIsEditing(false);
  };

  const handleAddressSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate form data
    const validation = validateAddressData(addressFormData);
    if (!validation.isValid) {
      setValidationErrors(validation.errors);
      return;
    }

    // Clear validation errors
    setValidationErrors({});

    if (editingAddress) {
      // Update existing address
      const updated = await updateAddress(editingAddress.id, addressFormData);
      if (updated) {
        setShowAddressForm(false);
        setEditingAddress(null);
        resetAddressForm();
      }
    } else {
      // Create new address
      const created = await createAddress(addressFormData);
      if (created) {
        setShowAddressForm(false);
        resetAddressForm();
      }
    }
  };

  const resetAddressForm = () => {
    setAddressFormData({
      type: 'both',
      firstName: '',
      lastName: '',
      company: '',
      addressLine1: '',
      addressLine2: '',
      city: '',
      state: '',
      postalCode: '',
      country: '',
      phone: '',
      isDefault: false,
    });
    setValidationErrors({});
  };

  const handleEditAddress = (address: Address) => {
    setEditingAddress(address);
    setAddressFormData({
      type: address.type,
      firstName: address.firstName,
      lastName: address.lastName,
      company: address.company || '',
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 || '',
      city: address.city,
      state: address.state,
      postalCode: address.postalCode,
      country: address.country,
      phone: address.phone || '',
      isDefault: address.isDefault,
    });
    setShowAddressForm(true);
  };

  const handleDeleteAddress = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this address?')) {
      await deleteAddress(id);
    }
  };

  const handleSetDefault = async (id: string) => {
    await setAsDefault(id);
  };

  const tabs = [
    { id: 'profile', name: 'Profile', icon: '👤' },
    { id: 'orders', name: 'Orders', icon: '📦' },
    { id: 'addresses', name: 'Addresses', icon: '📍' },
  ];

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="bg-white shadow-sm rounded-lg">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <h1 className="text-2xl font-bold text-gray-900">My Account</h1>
        </div>

        {/* Tab Navigation */}
        <div className="border-b border-gray-200">
          <nav className="-mb-px flex space-x-8 px-6" aria-label="Tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() =>
                  setActiveTab(tab.id as 'profile' | 'orders' | 'addresses')
                }
                className={`${
                  activeTab === tab.id
                    ? 'border-zava-500 text-zava-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center`}
              >
                <span className="mr-2">{tab.icon}</span>
                {tab.name}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab Content */}
        <div className="p-6">
          {activeTab === 'profile' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-medium text-gray-900">
                  Profile Information
                </h2>
                <button
                  onClick={() => setIsEditing(!isEditing)}
                  className="text-sm text-zava-600 hover:text-zava-500"
                >
                  {isEditing ? 'Cancel' : 'Edit'}
                </button>
              </div>

              {/* Profile Error Display */}
              {profileError && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
                  <div className="flex">
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">
                        Error
                      </h3>
                      <div className="mt-2 text-sm text-red-700">
                        {profileError}
                      </div>
                      <div className="mt-3">
                        <button
                          onClick={clearProfileError}
                          className="text-sm text-red-800 hover:text-red-600"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {profileLoading ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
                  <p className="mt-2 text-sm text-gray-500">
                    Loading profile...
                  </p>
                </div>
              ) : isEditing ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        First Name
                      </label>
                      <input
                        type="text"
                        value={formData.firstName}
                        onChange={(e) =>
                          updateFormField('firstName', e.target.value)
                        }
                        className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700">
                        Last Name
                      </label>
                      <input
                        type="text"
                        value={formData.lastName}
                        onChange={(e) =>
                          updateFormField('lastName', e.target.value)
                        }
                        className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Email
                    </label>
                    <input
                      type="email"
                      value={formData.email}
                      onChange={(e) => updateFormField('email', e.target.value)}
                      disabled
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm bg-gray-50 text-gray-500 cursor-not-allowed"
                      title="Email cannot be changed from profile. Please contact support."
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      Email cannot be changed from profile. Please contact
                      support.
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Phone
                    </label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => updateFormField('phone', e.target.value)}
                      className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                    />
                  </div>
                  <div className="flex space-x-3">
                    <button
                      onClick={handleSave}
                      disabled={isSaving || !hasChanges}
                      className="bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
                    >
                      {isSaving ? 'Saving...' : 'Save Changes'}
                    </button>
                    <button
                      onClick={handleCancel}
                      disabled={isSaving}
                      className="bg-gray-200 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-300 disabled:bg-gray-100"
                    >
                      Cancel
                    </button>
                  </div>
                  {hasChanges && (
                    <p className="text-xs text-amber-600">
                      You have unsaved changes.
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <dt className="text-sm font-medium text-gray-500">
                        First Name
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {formData.firstName || 'Not provided'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-sm font-medium text-gray-500">
                        Last Name
                      </dt>
                      <dd className="mt-1 text-sm text-gray-900">
                        {formData.lastName || 'Not provided'}
                      </dd>
                    </div>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Email</dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {formData.email}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm font-medium text-gray-500">Phone</dt>
                    <dd className="mt-1 text-sm text-gray-900">
                      {formData.phone || 'Not provided'}
                    </dd>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'orders' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-medium text-gray-900">
                  Order History
                </h2>
                <Link
                  to="/orders"
                  className="bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700"
                >
                  View All Orders
                </Link>
              </div>
              <div className="text-center py-12 bg-gray-50 rounded-lg">
                <div className="text-gray-400 mb-4">
                  <svg
                    className="mx-auto h-12 w-12"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  View your order history
                </h3>
                <p className="text-gray-600 mb-4">
                  Track your orders, view order details, and manage returns.
                </p>
                <Link
                  to="/orders"
                  className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-zava-600 hover:bg-zava-700"
                >
                  Go to Orders
                </Link>
              </div>
            </div>
          )}

          {activeTab === 'addresses' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-lg font-medium text-gray-900">
                  Saved Addresses
                </h2>
                <button
                  onClick={() => {
                    setEditingAddress(null);
                    resetAddressForm();
                    setShowAddressForm(true);
                  }}
                  disabled={isCreating}
                  className="bg-zava-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-zava-700 disabled:bg-gray-300"
                >
                  {isCreating ? 'Creating...' : 'Add New Address'}
                </button>
              </div>

              {/* Error Display */}
              {addressError && (
                <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
                  <div className="flex">
                    <div className="ml-3">
                      <h3 className="text-sm font-medium text-red-800">
                        Error
                      </h3>
                      <div className="mt-2 text-sm text-red-700">
                        {addressError}
                      </div>
                      <div className="mt-3">
                        <button
                          onClick={clearError}
                          className="text-sm text-red-800 hover:text-red-600"
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Address Form Modal */}
              {showAddressForm && (
                <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4 z-50">
                  <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-screen overflow-y-auto">
                    <div className="px-6 py-4 border-b border-gray-200">
                      <h3 className="text-lg font-medium text-gray-900">
                        {editingAddress ? 'Edit Address' : 'Add New Address'}
                      </h3>
                    </div>

                    <form
                      onSubmit={handleAddressSubmit}
                      className="p-6 space-y-4"
                    >
                      {/* Address Type */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-2">
                          Address Type
                        </label>
                        <select
                          value={addressFormData.type}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              type: e.target.value as
                                | 'shipping'
                                | 'billing'
                                | 'both',
                            })
                          }
                          className="block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                        >
                          <option value="both">Shipping & Billing</option>
                          <option value="shipping">Shipping Only</option>
                          <option value="billing">Billing Only</option>
                        </select>
                      </div>

                      {/* Name Fields */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            First Name *
                          </label>
                          <input
                            type="text"
                            required
                            value={addressFormData.firstName}
                            onChange={(e) =>
                              setAddressFormData({
                                ...addressFormData,
                                firstName: e.target.value,
                              })
                            }
                            className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                              validationErrors.firstName
                                ? 'border-red-300'
                                : 'border-gray-300'
                            }`}
                          />
                          {validationErrors.firstName && (
                            <p className="mt-1 text-sm text-red-600">
                              {validationErrors.firstName}
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Last Name *
                          </label>
                          <input
                            type="text"
                            required
                            value={addressFormData.lastName}
                            onChange={(e) =>
                              setAddressFormData({
                                ...addressFormData,
                                lastName: e.target.value,
                              })
                            }
                            className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                              validationErrors.lastName
                                ? 'border-red-300'
                                : 'border-gray-300'
                            }`}
                          />
                          {validationErrors.lastName && (
                            <p className="mt-1 text-sm text-red-600">
                              {validationErrors.lastName}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Company */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Company (Optional)
                        </label>
                        <input
                          type="text"
                          value={addressFormData.company}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              company: e.target.value,
                            })
                          }
                          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                        />
                      </div>

                      {/* Address Lines */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Address Line 1 *
                        </label>
                        <input
                          type="text"
                          required
                          value={addressFormData.addressLine1}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              addressLine1: e.target.value,
                            })
                          }
                          className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                            validationErrors.addressLine1
                              ? 'border-red-300'
                              : 'border-gray-300'
                          }`}
                        />
                        {validationErrors.addressLine1 && (
                          <p className="mt-1 text-sm text-red-600">
                            {validationErrors.addressLine1}
                          </p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Address Line 2 (Optional)
                        </label>
                        <input
                          type="text"
                          value={addressFormData.addressLine2}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              addressLine2: e.target.value,
                            })
                          }
                          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                        />
                      </div>

                      {/* City, State, Postal Code */}
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            City *
                          </label>
                          <input
                            type="text"
                            required
                            value={addressFormData.city}
                            onChange={(e) =>
                              setAddressFormData({
                                ...addressFormData,
                                city: e.target.value,
                              })
                            }
                            className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                              validationErrors.city
                                ? 'border-red-300'
                                : 'border-gray-300'
                            }`}
                          />
                          {validationErrors.city && (
                            <p className="mt-1 text-sm text-red-600">
                              {validationErrors.city}
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            State *
                          </label>
                          <input
                            type="text"
                            required
                            value={addressFormData.state}
                            onChange={(e) =>
                              setAddressFormData({
                                ...addressFormData,
                                state: e.target.value,
                              })
                            }
                            className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                              validationErrors.state
                                ? 'border-red-300'
                                : 'border-gray-300'
                            }`}
                          />
                          {validationErrors.state && (
                            <p className="mt-1 text-sm text-red-600">
                              {validationErrors.state}
                            </p>
                          )}
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-gray-700">
                            Postal Code *
                          </label>
                          <input
                            type="text"
                            required
                            value={addressFormData.postalCode}
                            onChange={(e) =>
                              setAddressFormData({
                                ...addressFormData,
                                postalCode: e.target.value,
                              })
                            }
                            className={`mt-1 block w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500 ${
                              validationErrors.postalCode
                                ? 'border-red-300'
                                : 'border-gray-300'
                            }`}
                          />
                          {validationErrors.postalCode && (
                            <p className="mt-1 text-sm text-red-600">
                              {validationErrors.postalCode}
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Country */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Country/Region *
                        </label>
                        <input
                          type="text"
                          required
                          value={addressFormData.country}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              country: e.target.value,
                            })
                          }
                          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                        />
                      </div>

                      {/* Phone */}
                      <div>
                        <label className="block text-sm font-medium text-gray-700">
                          Phone (Optional)
                        </label>
                        <input
                          type="tel"
                          value={addressFormData.phone}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              phone: e.target.value,
                            })
                          }
                          className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
                        />
                      </div>

                      {/* Default Address Checkbox */}
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id="isDefault"
                          checked={addressFormData.isDefault}
                          onChange={(e) =>
                            setAddressFormData({
                              ...addressFormData,
                              isDefault: e.target.checked,
                            })
                          }
                          className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300 rounded"
                        />
                        <label
                          htmlFor="isDefault"
                          className="ml-2 block text-sm text-gray-900"
                        >
                          Set as default address
                        </label>
                      </div>

                      {/* Form Actions */}
                      <div className="flex justify-end space-x-3 pt-4 border-t border-gray-200">
                        <button
                          type="button"
                          onClick={() => {
                            setShowAddressForm(false);
                            setEditingAddress(null);
                            resetAddressForm();
                          }}
                          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={isCreating || isUpdating}
                          className="px-4 py-2 text-sm font-medium text-white bg-zava-600 border border-transparent rounded-md hover:bg-zava-700 disabled:bg-gray-300"
                        >
                          {isCreating || isUpdating
                            ? editingAddress
                              ? 'Updating...'
                              : 'Creating...'
                            : editingAddress
                              ? 'Update Address'
                              : 'Create Address'}
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {/* Address List */}
              {addressLoading ? (
                <div className="text-center py-8">
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-zava-600"></div>
                  <p className="mt-2 text-sm text-gray-500">
                    Loading addresses...
                  </p>
                </div>
              ) : addresses.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-gray-500 mb-4">
                    <svg
                      className="mx-auto h-12 w-12"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-medium text-gray-900 mb-2">
                    No addresses saved
                  </h3>
                  <p className="text-gray-500 mb-4">
                    Add your addresses for faster checkout.
                  </p>
                  <button
                    onClick={() => {
                      setEditingAddress(null);
                      resetAddressForm();
                      setShowAddressForm(true);
                    }}
                    className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-zava-600 hover:bg-zava-700"
                  >
                    Add Your First Address
                  </button>
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  {addresses.map((address) => (
                    <div
                      key={address.id}
                      className={`relative p-4 border rounded-lg ${
                        address.isDefault
                          ? 'border-zava-300 bg-zava-50'
                          : 'border-gray-200 bg-white'
                      }`}
                    >
                      {/* Default Badge */}
                      {address.isDefault && (
                        <div className="absolute top-2 right-2">
                          <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-zava-100 text-zava-800">
                            Default
                          </span>
                        </div>
                      )}

                      {/* Address Type */}
                      <div className="mb-2">
                        <span
                          className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${getAddressTypeBadgeClasses(address.type)}`}
                        >
                          {getAddressTypeLabel(address.type)}
                        </span>
                      </div>

                      {/* Address Details */}
                      <div className="text-sm text-gray-900 space-y-1">
                        <div className="font-medium">
                          {address.firstName} {address.lastName}
                        </div>
                        {address.company && (
                          <div className="text-gray-600">{address.company}</div>
                        )}
                        <div>{address.addressLine1}</div>
                        {address.addressLine2 && (
                          <div>{address.addressLine2}</div>
                        )}
                        <div>
                          {address.city}, {address.state} {address.postalCode}
                        </div>
                        <div>{address.country}</div>
                        {address.phone && (
                          <div className="text-gray-600">{address.phone}</div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="mt-4 flex space-x-2">
                        <button
                          onClick={() => handleEditAddress(address)}
                          disabled={isUpdating}
                          className="text-xs text-zava-600 hover:text-zava-500 disabled:text-gray-400"
                        >
                          Edit
                        </button>
                        {!address.isDefault && (
                          <button
                            onClick={() => handleSetDefault(address.id)}
                            disabled={isUpdating}
                            className="text-xs text-zava-600 hover:text-zava-500 disabled:text-gray-400"
                          >
                            Set as Default
                          </button>
                        )}
                        <button
                          onClick={() => handleDeleteAddress(address.id)}
                          disabled={isDeleting}
                          className="text-xs text-red-600 hover:text-red-500 disabled:text-gray-400"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
