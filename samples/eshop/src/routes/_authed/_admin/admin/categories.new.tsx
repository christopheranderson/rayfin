import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { ServiceContainer } from '../../../../services/ServiceContainer';

interface CreateCategoryData {
  name: string;
  slug: string;
  description?: string;
  image?: string;
  isActive: boolean;
  sortOrder: number;
}

export const Route = createFileRoute('/_authed/_admin/admin/categories/new')({
  component: NewCategoryComponent,
});

function NewCategoryComponent() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<CreateCategoryData>({
    name: '',
    slug: '',
    description: '',
    image: '',
    isActive: true,
    sortOrder: 0,
  });

  const serviceContainer = ServiceContainer.getInstance();
  const categoryService = serviceContainer.categoryService;

  const handleInputChange = (field: keyof CreateCategoryData, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  // Auto-generate slug from name
  const handleNameChange = (name: string) => {
    handleInputChange('name', name);
    if (!formData.slug || formData.slug === generateSlug(formData.name)) {
      handleInputChange('slug', generateSlug(name));
    }
  };

  const generateSlug = (text: string): string => {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9 -]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
      .trim();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!formData.name || !formData.slug) {
      alert('Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      await categoryService.createCategory(formData);
      navigate({ to: '/admin/categories' });
    } catch (error) {
      console.error('Failed to create category:', error);
      alert('Failed to create category');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center mb-6">
        <Link
          to="/admin/categories"
          className="text-gray-600 hover:text-gray-900 mr-4"
        >
          ← Back to Categories
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">
          Create New Category
        </h1>
      </div>

      <form onSubmit={handleSubmit} className="max-w-2xl">
        <div className="bg-white rounded-lg shadow p-6 space-y-6">
          {/* Status */}
          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={formData.isActive}
                onChange={(e) =>
                  handleInputChange('isActive', e.target.checked)
                }
                className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-300 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
              />
              <span className="ml-2 text-sm font-medium text-gray-700">
                Category is active
              </span>
            </label>
          </div>

          {/* Basic Information */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Basic Information
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Category Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., Men's Clothing"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Slug *
                </label>
                <input
                  type="text"
                  value={formData.slug}
                  onChange={(e) => handleInputChange('slug', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g., mens-clothing"
                  required
                />
                <p className="text-sm text-gray-500 mt-1">
                  URL-friendly version of the name. Auto-generated from name.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Description
                </label>
                <textarea
                  value={formData.description || ''}
                  onChange={(e) =>
                    handleInputChange('description', e.target.value)
                  }
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Brief description of this category"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Category Image URL
                </label>
                <input
                  type="url"
                  value={formData.image || ''}
                  onChange={(e) => handleInputChange('image', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://example.com/image.jpg"
                />

                {/* Image Preview */}
                {formData.image && (
                  <div className="mt-3">
                    <div className="text-sm font-medium text-gray-700 mb-2">
                      Preview:
                    </div>
                    <img
                      src={formData.image}
                      alt="Category preview"
                      className="h-24 w-24 object-cover rounded-lg border border-gray-300"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          '/placeholder-category.jpg';
                      }}
                    />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Sort Order
                </label>
                <input
                  type="number"
                  min="0"
                  value={formData.sortOrder}
                  onChange={(e) =>
                    handleInputChange(
                      'sortOrder',
                      parseInt(e.target.value) || 0
                    )
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="0"
                />
                <p className="text-sm text-gray-500 mt-1">
                  Lower numbers appear first. Use 0 for default ordering.
                </p>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end space-x-4 pt-6 border-t">
            <Link
              to="/admin/categories"
              className="px-4 py-2 text-gray-700 bg-gray-200 hover:bg-gray-300 rounded-md transition-colors"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Category'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
