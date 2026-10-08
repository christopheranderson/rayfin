import { Faker, en } from '@faker-js/faker';
import { Address } from 'rayfin/data/Address';
import { Category } from 'rayfin/data/Category';
import { Customer } from 'rayfin/data/Customer';
import { OrderItem } from 'rayfin/data/OrderItem';

import { IServiceContainer, ServiceContainer } from './ServiceContainer';
import { getRayfinClient } from './rayfin/RayfinClientService';

const faker = new Faker({ locale: [en] });

/** @returns random 6 character string */
function seed(): string {
  return faker.string.alpha({ length: 6, casing: 'lower' });
}

function getPicsum(): string {
  return `https://picsum.photos/seed/${seed()}/200/300`;
}

export async function initialize(
  serviceContainer: IServiceContainer,
  isAdmin = true,
  addData = true
) {
  const rayfin = getRayfinClient();
  let adminUser;
  try {
    adminUser = await rayfin.auth.signUp({
      email: 'admin2@zava.com',
      password: 'password123',
    });
  } catch (error) {
    console.error('Error creating admin user:', error);
    // return;
  }

  let customerUser;
  try {
    customerUser = await rayfin.auth.signUp({
      email: 'customer@zava.com',
      password: 'password123',
    });
  } catch (error) {
    console.error('Error creating customer user:', error);
    // return;
  }

  if (isAdmin === true) {
    try {
      await rayfin.auth.signIn({
        email: 'admin2@zava.com',
        password: 'password123',
      });
    } catch (error) {
      console.error('Error signing in admin user:', error);
      return;
    }
  } else {
    try {
      await rayfin.auth.signIn({
        email: 'customer@zava.com',
        password: 'password123',
      });
    } catch (error) {
      console.error('Error signing in customer user:', error);
      return;
    }
  }

  let profile: Customer | null;
  let address: Address | null = null;

  try {
    profile = await serviceContainer.customerService.getProfile();

    if (profile) {
      const addresses = (
        await serviceContainer.addressService.getAddresses()
      ).filter((a) => a.customerId === profile?.id);

      if (addresses.length > 0) {
        address = addresses[0];
      } else {
        address = await serviceContainer.addressService.createAddress({
          firstName: faker.person.firstName(),
          lastName: faker.person.lastName(),
          addressLine1: faker.location.streetAddress(),
          city: faker.location.city(),
          country: 'USA',
          postalCode: faker.location.zipCode(),
          state: faker.location.state(),
          type: 'both',
        });
      }
    }
  } catch (error) {
    console.error('Error fetching customer profile:', error);
    return;
  }

  if (!addData) return;

  const materialCategory =
    await serviceContainer.categoryService.createCategory({
      isActive: true,
      name: 'materials',
      slug: 'materials',
      sortOrder: 0,
      description: 'The most advanced smart materials',
      image: getPicsum(),
    });

  const shirtCategory = await serviceContainer.categoryService.createCategory({
    isActive: true,
    name: 'shirts',
    slug: 'shirts',
    sortOrder: 0,
    description: 'Shirts for your body',
    image: getPicsum(),
  });

  const pantsCategory = await serviceContainer.categoryService.createCategory({
    isActive: true,
    name: 'pants',
    slug: 'pants',
    sortOrder: 1,
    description: 'Pants for your legs',
    image: getPicsum(),
  });

  type CategoryTuple = [string, Category];
  const categories: CategoryTuple[] = [
    ['shirt', shirtCategory],
    ['pants', pantsCategory],
    ['smart fabric', materialCategory],
  ];

  const numProductsPerCategory = 15;
  const products = [];
  for (const [name, category] of categories) {
    for (let i = 0; i < numProductsPerCategory; i++) {
      const productName = `${faker.commerce.productMaterial()} ${name}`;
      products.push(
        await serviceContainer.productService.createProduct({
          name: productName,
          description: faker.commerce.productDescription(),
          basePrice: parseInt(
            faker.commerce.price({ min: 10, max: 200, dec: 0 })
          ),
          category: category,
          sku: productName.toLowerCase().replace(/\s+/g, '-') + '-' + seed(),
          stockQuantity: faker.number.int({ min: 0, max: 100 }),
          imageUrl: getPicsum(),
        })
      );
    }
  }

  const numOrders = faker.number.int({ min: 15, max: 30 });
  for (let i = 0; i < numOrders; i++) {
    const numItems = faker.number.int({ min: 3, max: 10 });
    for (let j = 0; j < numItems; j++) {
      const product = faker.helpers.arrayElement(products);
      const quantity = faker.number.int({ min: 1, max: 50 });
      await serviceContainer.cartService.addItem({
        product,
        quantity,
      });
    }
    await serviceContainer.orderService.createOrder({
      billingAddressId: address!.id,
      paymentMethod: 'Credit',
      shippingAddressId: address!.id,
    });

    await serviceContainer.cartService.clearCart();
  }
}
