import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Organization, OrganizationSchema } from '../organization/schemas/organization.schema.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { EntitlementsService } from './entitlements.service.js';
import { SubscriptionPayment, SubscriptionPaymentSchema } from './schemas/subscription-payment.schema.js';
import { PlansController } from './plans.controller.js';
import { PlansService } from './plans.service.js';
import { Plan, PlanSchema } from './schemas/plan.schema.js';
import { Subscription, SubscriptionSchema } from './schemas/subscription.schema.js';
import { SubscriptionsService } from './subscriptions.service.js';

/** Planes, suscripciones y qué puede usar cada negocio. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Plan.name, schema: PlanSchema },
      { name: Subscription.name, schema: SubscriptionSchema },
      { name: Organization.name, schema: OrganizationSchema },
      { name: SubscriptionPayment.name, schema: SubscriptionPaymentSchema },
    ]),
  ],
  controllers: [PlansController, BillingController],
  providers: [PlansService, SubscriptionsService, EntitlementsService, BillingService],
  exports: [PlansService, SubscriptionsService, EntitlementsService, BillingService],
})
export class PlatformModule {}
