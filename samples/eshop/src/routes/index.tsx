import { createFileRoute, Link } from '@tanstack/react-router';

import { ServiceContainer } from '../services/ServiceContainer';

export const Route = createFileRoute('/')({
  component: HomeComponent,
  loader: async () => {
    // Load featured products for the homepage
    const { productService } = ServiceContainer.getInstance();
    try {
      const featuredProducts = await productService.getFeaturedProducts(8);
      return {
        featuredProducts,
      };
    } catch (error) {
      console.error('Failed to load featured products:', error);
      return {
        featuredProducts: [],
      };
    }
  },
});

function HomeComponent() {
  const { featuredProducts } = Route.useLoaderData();

  return (
    <div className="bg-white">
      {/* Hero Section */}
      <div className="relative bg-gradient-to-r from-zava-600 to-zava-800">
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-black opacity-30"></div>
        </div>
        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 lg:py-32">
          <div className="text-center">
            <h1 className="text-4xl md:text-6xl font-bold text-white mb-6">
              Experience the Future of
              <span className="block text-zava-200">Athletic Performance</span>
            </h1>
            <p className="text-xl text-zava-100 mb-8 max-w-3xl mx-auto">
              Discover our revolutionary smart materials technology that adapts
              to your body and enhances your running performance. Premium
              quality meets cutting-edge innovation.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/products/{-$categoryId}"
                className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-medium rounded-md text-zava-600 bg-white hover:bg-gray-50 shadow-lg transition-colors"
              >
                Shop Now
              </Link>
              <Link
                to="."
                hash="technology"
                className="inline-flex items-center justify-center px-8 py-3 border-2 border-white text-base font-medium rounded-md text-white hover:bg-white hover:text-zava-600 transition-colors"
              >
                Learn About Our Technology
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Featured Products Section */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-gray-900 mb-4">
            Featured Products
          </h2>
          <p className="text-gray-600 max-w-2xl mx-auto">
            Discover our latest innovations in running apparel, designed with
            smart materials that enhance your performance.
          </p>
        </div>

        {featuredProducts.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
            {featuredProducts.map((product) => (
              <div key={product.id} className="group">
                <div className="aspect-w-1 aspect-h-1 w-full overflow-hidden rounded-lg bg-gray-200 xl:aspect-w-7 xl:aspect-h-8">
                  <img
                    src={product.imageUrl || '/placeholder-product.jpg'}
                    alt={product.name}
                    className="h-64 w-full object-cover object-center group-hover:opacity-75 transition-opacity"
                  />
                </div>
                <h3 className="mt-4 text-sm text-gray-700">{product.name}</h3>
                <p className="mt-1 text-lg font-medium text-gray-900">
                  ${product.basePrice.toFixed(2)}
                </p>
                {/* {product.isNew && (
                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zava-100 text-zava-800 mt-2">
                    New
                  </span>
                )} */}
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
                  d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              No products available
            </h3>
            <p className="text-gray-500">
              Check back soon for our latest products.
            </p>
          </div>
        )}

        <div className="text-center mt-12">
          <Link
            to="/products/{-$categoryId}"
            className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md text-white bg-zava-600 hover:bg-zava-700 transition-colors"
          >
            View All Products
            <svg
              className="ml-2 -mr-1 h-5 w-5"
              fill="currentColor"
              viewBox="0 0 20 20"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                fillRule="evenodd"
                d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </Link>
        </div>
      </div>

      {/* Technology Section */}
      <div id="technology" className="bg-gray-50 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-gray-900 mb-4">
              Smart Materials Technology
            </h2>
            <p className="text-gray-600 max-w-3xl mx-auto">
              Our revolutionary smart materials adapt to your body temperature,
              moisture levels, and movement patterns to provide optimal comfort
              and performance.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="bg-zava-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-zava-600 text-2xl">🌡️</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Temperature Regulation
              </h3>
              <p className="text-gray-600">
                Advanced fibers that respond to your body temperature, keeping
                you cool when you heat up and warm when you cool down.
              </p>
            </div>

            <div className="text-center">
              <div className="bg-zava-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-zava-600 text-2xl">💧</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Moisture Management
              </h3>
              <p className="text-gray-600">
                Intelligent moisture-wicking technology that channels sweat away
                from your body and accelerates evaporation.
              </p>
            </div>

            <div className="text-center">
              <div className="bg-zava-100 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-zava-600 text-2xl">⚡</span>
              </div>
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                Performance Enhancement
              </h3>
              <p className="text-gray-600">
                Compression zones that adapt to your movement, providing support
                where you need it most during your workout.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Newsletter Section */}
      <div className="bg-zava-600 py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-white mb-4">Stay Updated</h2>
            <p className="text-zava-100 mb-8 max-w-2xl mx-auto">
              Be the first to know about new products, technology updates, and
              exclusive offers from Zava.
            </p>
            <div className="max-w-md mx-auto">
              <div className="flex">
                <input
                  type="email"
                  placeholder="Enter your email"
                  className="flex-1 px-4 py-3 rounded-l-md text-gray-900 focus:outline-none focus:ring-2 focus:ring-white"
                />
                <button
                  type="submit"
                  className="px-6 py-3 bg-gray-900 text-white rounded-r-md hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-white transition-colors"
                >
                  Subscribe
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
