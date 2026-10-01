import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, useEffect } from 'react';

import { Category } from '../../../../../rayfin/data/Category';
import { Product } from '../../../../../rayfin/data/Product';
import { ServiceContainer } from '../../../../services/ServiceContainer';
import { UpdateProductData } from '../../../../services/interfaces/IProductService';

export const Route = createFileRoute(
  '/_authed/_admin/admin/products/$productId/edit'
)({
  component: EditProductComponent,
  loader: async ({ params }) => {
    const serviceContainer = ServiceContainer.getInstance();
    const productService = serviceContainer.productService;
    const categoryService = serviceContainer.categoryService;

    try {
      const [product, categories] = await Promise.all([
        productService.getProduct(params.productId),
        categoryService.getCategories(),
      ]);

      if (!product) {
        throw new Error('Product not found');
      }

      return { product, categories };
    } catch (error) {
      console.error('Failed to load product:', error);
      throw error;
    }
  },
});

function EditProductComponent() {
  const { product: initialProduct, categories } = Route.useLoaderData();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState<UpdateProductData>({
    name: initialProduct.name,
    description: initialProduct.description,
    shortDescription: initialProduct.shortDescription || '',
    basePrice: initialProduct.basePrice,
    compareAtPrice: initialProduct.compareAtPrice,
    sku: initialProduct.sku,
    stockQuantity: initialProduct.stockQuantity,
    imageUrl: initialProduct.imageUrl,
    materialComposition: initialProduct.materialComposition || '',
    careInstructions: initialProduct.careInstructions || '',
    sizeGuide: initialProduct.sizeGuide || '',
    weight: initialProduct.weight,
    seoTitle: initialProduct.seoTitle || '',
    seoDescription: initialProduct.seoDescription || '',
    isActive: initialProduct.isActive,
    category: initialProduct.category,
  });

  const serviceContainer = ServiceContainer.getInstance();
  const productService = serviceContainer.productService;

  const handleInputChange = (field: keyof UpdateProductData, value: any) => {
    setFormData((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleCategoryChange = (categoryId: string) => {
    const selectedCategory = categories.find((c) => c.id === categoryId);
    if (selectedCategory) {
      handleInputChange('category', selectedCategory);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (
      !formData.name ||
      !formData.description ||
      !formData.sku ||
      !formData.category?.id
    ) {
      alert('Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      await productService.updateProduct(initialProduct.id, formData);
      navigate({ to: '/admin/products' });
    } catch (error) {
      console.error('Failed to update product:', error);
      alert('Failed to update product');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6">
      <div className="flex items-center mb-6">
        <Link
          to="/admin/products"
          className="text-gray-600 hover:text-gray-900 mr-4"
        >
          ← Back to Products
        </Link>
        <h1 className="text-3xl font-bold text-gray-900">Edit Product</h1>
      </div>

      <form onSubmit={handleSubmit} className="max-w-4xl">
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
                Product is active
              </span>
            </label>
          </div>

          {/* Basic Information */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Basic Information
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Product Name *
                </label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => handleInputChange('name', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  SKU *
                </label>
                <input
                  type="text"
                  value={formData.sku}
                  onChange={(e) => handleInputChange('sku', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Category *
                </label>
                <select
                  value={formData.category?.id || ''}
                  onChange={(e) => handleCategoryChange(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                >
                  <option value="">Select a category</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Image URL *
                </label>
                <input
                  type="url"
                  value={formData.imageUrl}
                  onChange={(e) =>
                    handleInputChange('imageUrl', e.target.value)
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
            </div>

            <div className="mt-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Short Description
              </label>
              <input
                type="text"
                value={formData.shortDescription || ''}
                onChange={(e) =>
                  handleInputChange('shortDescription', e.target.value)
                }
                placeholder="Brief description for product cards"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="mt-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Description *
              </label>
              <textarea
                value={formData.description}
                onChange={(e) =>
                  handleInputChange('description', e.target.value)
                }
                rows={4}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                required
              />
            </div>

            {/* Image Preview */}
            {formData.imageUrl && (
              <div className="mt-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Image Preview
                </label>
                <img
                  src={formData.imageUrl}
                  alt={formData.name}
                  className="h-32 w-32 object-cover rounded-lg border border-gray-300"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src =
                      '/placeholder-product.jpg';
                  }}
                />
              </div>
            )}
          </div>

          {/* Pricing & Inventory */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Pricing & Inventory
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Base Price *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.basePrice}
                  onChange={(e) =>
                    handleInputChange(
                      'basePrice',
                      parseFloat(e.target.value) || 0
                    )
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Compare At Price
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.compareAtPrice || ''}
                  onChange={(e) =>
                    handleInputChange(
                      'compareAtPrice',
                      parseFloat(e.target.value) || undefined
                    )
                  }
                  placeholder="Original price for sales"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Stock Quantity *
                </label>
                <input
                  type="number"
                  min="0"
                  value={formData.stockQuantity}
                  onChange={(e) =>
                    handleInputChange(
                      'stockQuantity',
                      parseInt(e.target.value) || 0
                    )
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
            </div>
          </div>

          {/* Product Details */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">
              Product Details
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Material Composition
                </label>
                <textarea
                  value={formData.materialComposition || ''}
                  onChange={(e) =>
                    handleInputChange('materialComposition', e.target.value)
                  }
                  rows={3}
                  placeholder="e.g., 95% Cotton, 5% Elastane"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Care Instructions
                </label>
                <textarea
                  value={formData.careInstructions || ''}
                  onChange={(e) =>
                    handleInputChange('careInstructions', e.target.value)
                  }
                  rows={3}
                  placeholder="Washing and care instructions"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Size Guide
                </label>
                <textarea
                  value={formData.sizeGuide || ''}
                  onChange={(e) =>
                    handleInputChange('sizeGuide', e.target.value)
                  }
                  rows={3}
                  placeholder="Sizing information"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Weight (grams)
                </label>
                <input
                  type="number"
                  min="0"
                  value={formData.weight || ''}
                  onChange={(e) =>
                    handleInputChange(
                      'weight',
                      parseInt(e.target.value) || undefined
                    )
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* SEO */}
          <div>
            <h2 className="text-xl font-semibold text-gray-900 mb-4">SEO</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  SEO Title
                </label>
                <input
                  type="text"
                  value={formData.seoTitle || ''}
                  onChange={(e) =>
                    handleInputChange('seoTitle', e.target.value)
                  }
                  placeholder="Leave empty to use product name"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  SEO Description
                </label>
                <textarea
                  value={formData.seoDescription || ''}
                  onChange={(e) =>
                    handleInputChange('seoDescription', e.target.value)
                  }
                  rows={3}
                  placeholder="Meta description for search engines"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end space-x-4 pt-6 border-t">
            <Link
              to="/admin/products"
              className="px-4 py-2 text-gray-700 bg-gray-200 hover:bg-gray-300 rounded-md transition-colors"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md transition-colors disabled:opacity-50"
            >
              {loading ? 'Updating...' : 'Update Product'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
