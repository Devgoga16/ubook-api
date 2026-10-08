import type { FeatureSet } from './features.catalog.js';

/**
 * Planes iniciales (nombres y precios mensuales del prototipo). Solo se
 * insertan si no existen; después se editan desde el panel de super admin.
 * Montos en céntimos de sol (PEN). El anual cobra 10 meses (2 meses gratis).
 */
export const DEFAULT_PLANS: Array<{
  code: string;
  name: string;
  description: string;
  sortOrder: number;
  price: { monthly: number; yearly: number; currency: string };
  features: FeatureSet;
}> = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'Para profesionales independientes y negocios que empiezan.',
    sortOrder: 1,
    price: { monthly: 4900, yearly: 49000, currency: 'PEN' },
    features: {
      max_branches: 1,
      max_professionals: 2,
      max_bookings_per_month: 150,
      public_booking_page: true,
      email_notifications: true,
      manual_payments: true,
      client_records: true,
      client_portal: false,
      guardians: false,
      resources: false,
      custom_roles: false,
      custom_fields: false,
      advanced_reports: false,
      branch_reports: false,
      audit_log: false,
      branding: true,
      white_label: false,
      whatsapp: true,
    },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Para negocios con equipo que quieren ofrecer una experiencia completa.',
    sortOrder: 2,
    price: { monthly: 7900, yearly: 79000, currency: 'PEN' },
    features: {
      max_branches: 3,
      max_professionals: 10,
      max_bookings_per_month: null,
      public_booking_page: true,
      email_notifications: true,
      manual_payments: true,
      client_records: true,
      client_portal: true,
      guardians: true,
      resources: true,
      custom_roles: true,
      custom_fields: true,
      advanced_reports: true,
      branch_reports: false,
      audit_log: false,
      branding: true,
      white_label: false,
      whatsapp: true,
    },
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Para negocios con varias sucursales y equipos grandes.',
    sortOrder: 3,
    price: { monthly: 12900, yearly: 129000, currency: 'PEN' },
    features: {
      max_branches: 5,
      max_professionals: null,
      max_bookings_per_month: null,
      public_booking_page: true,
      email_notifications: true,
      manual_payments: true,
      client_records: true,
      client_portal: true,
      guardians: true,
      resources: true,
      custom_roles: true,
      custom_fields: true,
      advanced_reports: true,
      branch_reports: true,
      audit_log: true,
      branding: true,
      white_label: true,
      whatsapp: true,
    },
  },
];
