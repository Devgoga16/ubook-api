import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { SchemaTypes, type HydratedDocument, type Types } from 'mongoose';
import { tenantPlugin } from '../../core/database/tenant.plugin.js';

/** Lo que una cita ocupa además del profesional: sillón, sala, camilla, equipo. */
@Schema({ timestamps: true, collection: 'resources' })
export class Resource {
  organizationId: Types.ObjectId;

  @Prop({ type: SchemaTypes.ObjectId, ref: 'Branch', required: true, index: true })
  branchId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  /** Texto libre: "Sala privada", "Equipo", "Sillón de barbería". */
  @Prop({ trim: true, default: '' })
  kind: string;

  /** Citas que puede atender a la vez. */
  @Prop({ default: 1, min: 1, max: 20 })
  capacity: number;

  /** Servicios que lo necesitan. Si un servicio tiene varios recursos, basta uno libre. */
  @Prop({ type: [{ type: SchemaTypes.ObjectId, ref: 'Service' }], default: [] })
  serviceIds: Types.ObjectId[];

  @Prop({ default: true })
  isActive: boolean;

  /** Se incrementa al reservar para serializar reservas simultáneas del mismo recurso. */
  @Prop({ default: 0, select: false })
  bookingVersion: number;
}

export type ResourceDocument = HydratedDocument<Resource>;
export const ResourceSchema = SchemaFactory.createForClass(Resource);
ResourceSchema.plugin(tenantPlugin);
ResourceSchema.index({ organizationId: 1, branchId: 1, serviceIds: 1 });
