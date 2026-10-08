import { Address } from '../../rayfin/data/Address';

/**
 * Formats an address object into a readable string
 */
export function formatAddress(
  address: Address,
  options?: {
    includePhone?: boolean;
    includeCompany?: boolean;
    singleLine?: boolean;
  }
): string {
  const {
    includePhone = false,
    includeCompany = false,
    singleLine = false,
  } = options || {};

  const parts: string[] = [];

  // Name
  parts.push(`${address.firstName} ${address.lastName}`);

  // Company
  if (includeCompany && address.company) {
    parts.push(address.company);
  }

  // Address lines
  parts.push(address.addressLine1);
  if (address.addressLine2) {
    parts.push(address.addressLine2);
  }

  // City, State, Postal
  parts.push(`${address.city}, ${address.state} ${address.postalCode}`);

  // Country
  parts.push(address.country);

  // Phone
  if (includePhone && address.phone) {
    parts.push(address.phone);
  }

  return singleLine ? parts.join(', ') : parts.join('\n');
}

/**
 * Gets the display label for an address type
 */
export function getAddressTypeLabel(
  type: 'shipping' | 'billing' | 'both'
): string {
  switch (type) {
    case 'both':
      return 'Shipping & Billing';
    case 'shipping':
      return 'Shipping';
    case 'billing':
      return 'Billing';
    default:
      return type;
  }
}

/**
 * Gets the CSS classes for an address type badge
 */
export function getAddressTypeBadgeClasses(
  type: 'shipping' | 'billing' | 'both'
): string {
  switch (type) {
    case 'both':
      return 'bg-green-100 text-green-800';
    case 'shipping':
      return 'bg-blue-100 text-blue-800';
    case 'billing':
      return 'bg-purple-100 text-purple-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

/**
 * Validates address form data
 */
export function validateAddressData(data: {
  firstName: string;
  lastName: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}): { isValid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  if (!data.firstName.trim()) {
    errors.firstName = 'First name is required';
  }

  if (!data.lastName.trim()) {
    errors.lastName = 'Last name is required';
  }

  if (!data.addressLine1.trim()) {
    errors.addressLine1 = 'Address line 1 is required';
  }

  if (!data.city.trim()) {
    errors.city = 'City is required';
  }

  if (!data.state.trim()) {
    errors.state = 'State is required';
  }

  if (!data.postalCode.trim()) {
    errors.postalCode = 'Postal code is required';
  }

  if (!data.country.trim()) {
    errors.country = 'Country/Region is required';
  }

  // Postal code format validation (basic)
  if (data.country === 'US' && data.postalCode) {
    const usZipRegex = /^\d{5}(-\d{4})?$/;
    if (!usZipRegex.test(data.postalCode)) {
      errors.postalCode =
        'Please enter a valid US ZIP code (e.g., 12345 or 12345-6789)';
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
}
