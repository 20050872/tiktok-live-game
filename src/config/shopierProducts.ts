type ShopierProductConfig = { productId: string; url: string };

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Product IDs and payment links live here; Render environment variables override these defaults. */
export const SHOPIER_PRODUCTS: {
  testProductId?: string;
  weekly: ShopierProductConfig;
  monthly: ShopierProductConfig;
  lifetime: ShopierProductConfig;
} = {
  testProductId: envValue('SHOPIER_PRODUCT_ID_TEST'),
  weekly: {
    productId: envValue('SHOPIER_PRODUCT_ID_WEEKLY') ?? '53114267',
    url: envValue('SHOPIER_URL_WEEKLY') ?? 'https://shopier.com/53114267',
  },
  monthly: {
    productId: envValue('SHOPIER_PRODUCT_ID_MONTHLY') ?? '53114277',
    url: envValue('SHOPIER_URL_MONTHLY') ?? 'https://shopier.com/53114277',
  },
  lifetime: {
    productId: envValue('SHOPIER_PRODUCT_ID_LIFETIME') ?? '53114295',
    url: envValue('SHOPIER_URL_LIFETIME') ?? 'https://shopier.com/53114295',
  },
};
