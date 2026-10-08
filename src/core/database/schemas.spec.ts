import type { Schema } from 'mongoose';
import { AuditLogSchema } from '../audit/audit-log.schema.js';
import { ServiceCategorySchema } from '../../modules/catalog/schemas/service-category.schema.js';
import { ServiceSchema } from '../../modules/catalog/schemas/service.schema.js';
import { SessionSchema } from '../../modules/identity/schemas/session.schema.js';
import { UserSchema } from '../../modules/identity/schemas/user.schema.js';
import { BranchSchema } from '../../modules/organization/schemas/branch.schema.js';
import { MembershipSchema } from '../../modules/organization/schemas/membership.schema.js';
import { OrganizationSchema } from '../../modules/organization/schemas/organization.schema.js';
import { RoleSchema } from '../../modules/organization/schemas/role.schema.js';
import { ProfessionalSchema } from '../../modules/professionals/schemas/professional.schema.js';
import { TimeOffSchema } from '../../modules/professionals/schemas/time-off.schema.js';
import { BranchExceptionSchema } from '../../modules/organization/schemas/branch-exception.schema.js';
import { AppointmentSchema } from '../../modules/bookings/schemas/appointment.schema.js';
import { ClientSchema } from '../../modules/clients/schemas/client.schema.js';
import { ClientRecordSchema, RecordTemplateSchema } from '../../modules/records/schemas/record.schemas.js';
import { InvitationSchema } from '../../modules/organization/schemas/invitation.schema.js';
import { CashCloseSchema, CashMovementSchema, PaymentSchema } from '../../modules/payments/schemas/payment.schemas.js';
import { WaitlistEntrySchema } from '../../modules/bookings/schemas/waitlist.schema.js';
import { PromotionSchema } from '../../modules/promotions/promotion.schema.js';
import { ResourceSchema } from '../../modules/resources/resource.schema.js';
import { SubscriptionPaymentSchema } from '../../modules/platform/schemas/subscription-payment.schema.js';
import { AutomationSettingsSchema, NotificationLogSchema } from '../../modules/bookings/automations/automation.schemas.js';
import { PlanSchema } from '../../modules/platform/schemas/plan.schema.js';
import { SubscriptionSchema } from '../../modules/platform/schemas/subscription.schema.js';

const SCHEMAS: Record<string, Schema> = {
  AuditLogSchema,
  ServiceCategorySchema,
  ServiceSchema,
  SessionSchema,
  UserSchema,
  BranchSchema,
  MembershipSchema,
  OrganizationSchema,
  RoleSchema,
  PlanSchema,
  SubscriptionSchema,
  ProfessionalSchema,
  TimeOffSchema,
  BranchExceptionSchema,
  AppointmentSchema,
  ClientSchema,
  ClientRecordSchema,
  RecordTemplateSchema,
  InvitationSchema,
  PaymentSchema,
  CashMovementSchema,
  CashCloseSchema,
  WaitlistEntrySchema,
  PromotionSchema,
  ResourceSchema,
  SubscriptionPaymentSchema,
  AutomationSettingsSchema,
  NotificationLogSchema,
};

/** Referencias que intencionalmente no son ObjectId. */
const NOT_REFERENCES = new Set(['AuditLogSchema.entityId', 'ClientSchema.documentId']);

/**
 * `@Prop({ type: Types.ObjectId })` produce un campo Mixed (se guarda como
 * texto y las consultas con ObjectId no coinciden). Hay que usar SchemaTypes.ObjectId.
 */
describe('Esquemas', () => {
  it('toda referencia (*Id, *Ids, createdBy) es ObjectId', () => {
    const wrong: string[] = [];
    for (const [name, schema] of Object.entries(SCHEMAS)) {
      schema.eachPath((path, type: { instance: string; embeddedSchemaType?: { instance: string } }) => {
        const key = `${name}.${path}`;
        if (path === '_id' || NOT_REFERENCES.has(key) || !/(Id|Ids|By)$/.test(path)) return;
        const instance = type.instance === 'Array' ? type.embeddedSchemaType?.instance : type.instance;
        if (instance !== 'ObjectId') wrong.push(`${key}: ${instance}`);
      });
    }
    expect(wrong).toEqual([]);
  });
});
