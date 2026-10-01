import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';

import { Category } from '../../../../../rayfin/data/Category';
import { ServiceContainer } from '../../../../services/ServiceContainer';

export const Route = createFileRoute('/_authed/_admin/admin/categories/')({
  component: CategoriesListComponent,
  loader: async () => {
    const serviceContainer = ServiceContainer.getInstance();
    const categoryService = serviceContainer.categoryService;

    try {
      const categories = await categoryService.getCategories();
      return { categories };
    } catch (error) {
      console.error('Failed to load categories:', error);
      return { categories: [] };
    }
  },
});

function CategoriesListComponent() {
  const { categories: initialCategories } = Route.useLoaderData();
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<
    'all' | 'active' | 'inactive'
  >('all');

  const serviceContainer = ServiceContainer.getInstance();
  const categoryService = serviceContainer.categoryService;

  const filteredCategories = categories.filter((category) => {
    const matchesSearch =
      category.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      category.slug.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && category.isActive) ||
      (statusFilter === 'inactive' && !category.isActive);

    return matchesSearch && matchesStatus;
  });

  const handleDeleteCategory = async (id: string) => {
    if (
      !confirm(
        'Are you sure you want to delete this category? This action cannot be undone.'
      )
    )
      return;

    setLoading(true);
    try {
      await categoryService.deleteCategory(id);
      setCategories(categories.filter((c) => c.id !== id));
    } catch (error) {
      console.error('Failed to delete category:', error);
      alert('Failed to delete category');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleActive = async (category: Category) => {
    setLoading(true);
    try {
      const updatedCategory = await categoryService.updateCategory(
        category.id,
        {
          isActive: !category.isActive,
        }
      );
      setCategories(
        categories.map((c) => (c.id === category.id ? updatedCategory : c))
      );
    } catch (error) {
      console.error('Failed to update category status:', error);
      alert('Failed to update category status');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-900">Categories</h1>
        <Link
          to="/admin/categories/new"
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors"
        >
          Add New Category
        </Link>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-lg shadow mb-6">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search categories by name or slug..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')
              }
              className="px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      </div>

      {/* Categories Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Category
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Slug
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Sort Order
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Created
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredCategories.map((category) => (
                <tr key={category.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      {category.image && (
                        <div className="h-10 w-10 flex-shrink-0 mr-4">
                          <img
                            className="h-10 w-10 rounded-lg object-cover"
                            src={category.image}
                            alt={category.name}
                          />
                        </div>
                      )}
                      <div>
                        <div className="text-sm font-medium text-gray-900">
                          {category.name}
                        </div>
                        {category.description && (
                          <div className="text-sm text-gray-500 truncate max-w-xs">
                            {category.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    <code className="bg-gray-100 px-2 py-1 rounded text-xs">
                      {category.slug}
                    </code>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                    {category.sortOrder}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <button
                      onClick={() => handleToggleActive(category)}
                      disabled={loading}
                      className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        category.isActive
                          ? 'bg-green-100 text-green-800 hover:bg-green-200'
                          : 'bg-red-100 text-red-800 hover:bg-red-200'
                      } transition-colors disabled:opacity-50`}
                    >
                      {category.isActive ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                    {new Date(category.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-sm font-medium">
                    <div className="flex space-x-2">
                      <Link
                        to="/admin/categories/$categorySlug/edit"
                        params={{ categorySlug: category.slug }}
                        className="text-blue-600 hover:text-blue-900 transition-colors"
                      >
                        Edit
                      </Link>
                      <button
                        onClick={() => handleDeleteCategory(category.id)}
                        disabled={loading}
                        className="text-red-600 hover:text-red-900 transition-colors disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {filteredCategories.length === 0 && (
          <div className="text-center py-12">
            <div className="text-gray-500 text-lg">
              {searchTerm || statusFilter !== 'all'
                ? 'No categories found matching your filters.'
                : 'No categories found.'}
            </div>
            {!searchTerm && statusFilter === 'all' && (
              <Link
                to="/admin/categories/new"
                className="mt-4 inline-block bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md font-medium transition-colors"
              >
                Create your first category
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
