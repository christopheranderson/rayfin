import { createFileRoute } from '@tanstack/react-router';
import { Product } from 'rayfin/data/schema';
import { useState } from 'react';

import { Category } from '../../rayfin/data/Category';
import { useCart } from '../contexts/CartContext';
import { ServiceContainer } from '../services/ServiceContainer';

export const Route = createFileRoute('/products/{-$categoryId}')({
  component: ProductsComponent,
  loader: async (context) => {
    const categorySlug = context.params.categoryId; // This will be the category ID if provided, or undefined if not
    const { productService, categoryService } = ServiceContainer.getInstance();

    let categories: Category[] = [];
    let products: Product[] = [];
    let sluggedCategory: Category | undefined;

    try {
      [products, categories] = await Promise.all([
        productService.getProducts(),
        categoryService.getCategories(),
      ]);

      if (categorySlug) {
        sluggedCategory = categories.filter(
          (category) => category.slug === categorySlug
        )[0];
      }

      return {
        products,
        categories,
        sluggedCategory,
      };
    } catch (error) {
      console.error('Failed to load products:', error);
      return {
        products: [],
        categories: [],
        sluggedCategory: undefined,
      };
    }
  },
});

function ProductsComponent() {
  const { products, categories, sluggedCategory } = Route.useLoaderData();
  const [selectedCategory, setSelectedCategory] = useState<string | null>(
    sluggedCategory?.id || null
  );
  const [sortBy, setSortBy] = useState<'name' | 'basePrice' | 'newest'>(
    'newest'
  );
  const [priceRange, setPriceRange] = useState<[number, number]>([0, 1000]);
  const navigate = Route.useNavigate();
  const { addToCart } = useCart();

  // Add cart functionality
  const handleAddToCart = async (product: Product) => {
    try {
      await addToCart(product);
      // TODO: Add success notification/toast
      console.log('Item added to cart successfully');
    } catch (error) {
      console.error('Failed to add item to cart:', error);
      // TODO: Add error notification/toast
    }
  };

  // Filter products based on selected category
  const filteredProducts = selectedCategory
    ? products.filter((product) => product.category.id === selectedCategory)
    : products;

  // Sort products
  const sortedProducts = [...filteredProducts].sort((a, b) => {
    switch (sortBy) {
      case 'basePrice':
        return a.basePrice - b.basePrice;
      case 'newest':
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case 'name':
      default:
        return a.name.localeCompare(b.name);
    }
  });

  // Filter by price range
  const finalProducts = sortedProducts.filter(
    (product) =>
      product.basePrice >= priceRange[0] && product.basePrice <= priceRange[1]
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Products</h1>
        <p className="mt-2 text-gray-600">
          Discover our complete collection of premium running apparel with smart
          materials technology.
        </p>
      </div>

      <div className="lg:grid lg:grid-cols-4 lg:gap-8">
        {/* Filters Sidebar */}
        <div className="lg:col-span-1">
          <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">
              Filters
            </h3>

            {/* Category Filter */}
            <div className="mb-6">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                Category
              </h4>
              <div className="space-y-2">
                <label className="flex items-center">
                  <input
                    type="radio"
                    name="category"
                    checked={selectedCategory === null}
                    onChange={() => {
                      navigate({
                        to: `/products/{-$categoryId}`,
                        params: { categoryId: undefined },
                      });
                      setSelectedCategory(null);
                    }}
                    className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                  />
                  <span className="ml-2 text-sm text-gray-700">
                    All Categories
                  </span>
                </label>
                {categories.map((category) => (
                  <label key={category.id} className="flex items-center">
                    <input
                      type="radio"
                      name="category"
                      checked={selectedCategory === category.id}
                      onChange={() => {
                        navigate({ to: `/products/${category.slug}` });
                        setSelectedCategory(category.id);
                      }}
                      className="h-4 w-4 text-zava-600 focus:ring-zava-500 border-gray-300"
                    />
                    <span className="ml-2 text-sm text-gray-700">
                      {category.name}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Sort Filter */}
            <div className="mb-6">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                Sort By
              </h4>
              <select
                value={sortBy}
                onChange={(e) =>
                  setSortBy(e.target.value as 'name' | 'basePrice' | 'newest')
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-zava-500 focus:border-zava-500"
              >
                <option value="name">Name (A-Z)</option>
                <option value="price">Price (Low to High)</option>
                <option value="newest">Newest First</option>
              </select>
            </div>

            {/* Price Range Filter */}
            <div className="mb-6">
              <h4 className="text-sm font-medium text-gray-900 mb-3">
                Price Range
              </h4>
              <div className="space-y-2">
                <input
                  type="range"
                  min="0"
                  max="1000"
                  value={priceRange[1]}
                  onChange={(e) =>
                    setPriceRange([priceRange[0], parseInt(e.target.value)])
                  }
                  className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                />
                <div className="flex justify-between text-sm text-gray-600">
                  <span>${priceRange[0]}</span>
                  <span>${priceRange[1]}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Products Grid */}
        <div className="lg:col-span-3 mt-6 lg:mt-0">
          {/* Results Summary */}
          <div className="flex items-center justify-between mb-6">
            <p className="text-sm text-gray-600">
              Showing {finalProducts.length} of {products.length} products
            </p>
          </div>

          {finalProducts.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {finalProducts.map((product) => (
                <div key={product.id} className="group">
                  <div className="aspect-w-1 aspect-h-1 w-full overflow-hidden rounded-lg bg-gray-200">
                    <img
                      src={product?.imageUrl || '/placeholder-product.jpg'}
                      alt={product.name}
                      className="h-64 w-full object-cover object-center group-hover:opacity-75 transition-opacity"
                    />
                  </div>
                  <div className="mt-4">
                    <h3 className="text-sm text-gray-700 font-medium">
                      <a
                        href={`/products/${product.id}`}
                        className="hover:text-zava-600"
                      >
                        {product.name}
                      </a>
                    </h3>
                    <p className="mt-1 text-sm text-gray-500">
                      {product.description}
                    </p>
                    <div className="mt-2 flex items-center justify-between">
                      <p className="text-lg font-medium text-gray-900">
                        ${product.basePrice.toFixed(2)}
                      </p>
                      {/* {product.isNew && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zava-100 text-zava-800">
                          New
                        </span>
                      )} */}
                    </div>

                    {/* Quick Actions */}
                    <div className="mt-3 flex space-x-2">
                      <button
                        onClick={() => handleAddToCart(product)}
                        className="flex-1 bg-zava-600 text-white px-3 py-2 rounded-md text-sm font-medium hover:bg-zava-700 transition-colors"
                      >
                        Add to Cart
                      </button>
                      <button className="px-3 py-2 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                        ❤️
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="text-gray-500 mb-4">
                <svg
                  className="mx-auto h-12 w-12"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-2">
                No products found
              </h3>
              <p className="text-gray-500">
                Try adjusting your filters to see more results.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
