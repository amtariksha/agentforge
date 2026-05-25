import { registerHandler } from '../registry.js';
import type { GatewayHandler } from '../registry.js';
import { registerLmsTools } from './lms-tools.js';

// Stub handlers — return mock data for Phase 1
// Real DB integration comes in Phase 2

const getUserProfile: GatewayHandler = async (params) => {
  const phone = params.phone as string;
  return {
    success: true,
    data: {
      found: true,
      name: 'Demo Customer',
      phone,
      address: '42 MG Road, Indiranagar, Bangalore 560038',
      activeSubscriptions: [
        { id: 'sub_001', plan: 'A2 Milk Daily', items: ['A2 Cow Milk 500ml'], frequency: 'daily', status: 'active' },
      ],
      joinDate: '2025-06-15',
      totalOrders: 180,
      preferences: { dietary: 'vegetarian', deliveryTime: 'morning' },
    },
    durationMs: 2,
  };
};

const getSubscription: GatewayHandler = async (params) => {
  return {
    success: true,
    data: {
      subscriptions: [
        {
          id: 'sub_001',
          planName: 'A2 Milk Daily',
          items: [{ name: 'A2 Cow Milk 500ml', quantity: 1 }],
          frequency: 'daily',
          status: 'active',
          startDate: '2025-06-15',
          nextDeliveryDate: new Date().toISOString().split('T')[0],
          pricePerDelivery: 45,
        },
      ],
    },
    durationMs: 2,
  };
};

const getDeliverySchedule: GatewayHandler = async (params) => {
  const date = (params.date as string) ?? new Date().toISOString().split('T')[0];
  return {
    success: true,
    data: {
      date,
      deliveries: [
        {
          expectedTimeWindow: '5:30 AM - 7:00 AM',
          items: ['A2 Cow Milk 500ml'],
          deliveryPersonName: 'Raju',
          status: 'delivered',
          actualDeliveryTime: '6:15 AM',
        },
      ],
    },
    durationMs: 2,
  };
};

const searchProducts: GatewayHandler = async (params) => {
  return {
    success: true,
    data: {
      products: [
        { id: 'prod_001', name: 'A2 Desi Cow Milk', price: 45, unit: '500ml', category: 'dairy', available: true, healthBenefits: 'Rich in A2 beta-casein protein, easier to digest' },
        { id: 'prod_002', name: 'A2 Desi Cow Ghee', price: 650, unit: '500ml', category: 'dairy', available: true, healthBenefits: 'Made from A2 milk, rich in omega-3 fatty acids' },
        { id: 'prod_003', name: 'Fresh Paneer', price: 120, unit: '200g', category: 'dairy', available: true, healthBenefits: 'High protein, calcium-rich, preservative-free' },
        { id: 'prod_004', name: 'Raw Honey', price: 350, unit: '500g', category: 'natural', available: true, healthBenefits: 'Unprocessed, enzyme-rich, natural immunity booster' },
      ],
    },
    durationMs: 3,
  };
};

const cancelSubscription: GatewayHandler = async (params) => {
  return {
    success: true,
    data: {
      cancelled: true,
      subscriptionId: params.subscription_id,
      finalDeliveryDate: new Date().toISOString().split('T')[0],
      message: 'Subscription cancelled successfully.',
    },
    durationMs: 5,
  };
};

export function register() {
  // Legacy demo handlers (still used by the seeded 'support'/'sales' agent types)
  registerHandler('swarg-food.getUserProfile', getUserProfile);
  registerHandler('swarg-food.getSubscription', getSubscription);
  registerHandler('swarg-food.getDeliverySchedule', getDeliverySchedule);
  registerHandler('swarg-food.searchProducts', searchProducts);
  registerHandler('swarg-food.cancelSubscription', cancelSubscription);

  // LMS Phase 1 tool handlers (12 wrappers around the admin panel API)
  registerLmsTools();
}
