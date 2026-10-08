import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { utcToZoned } from '../../core/scheduling/zoned-time.js';
import { Appointment } from '../bookings/schemas/appointment.schema.js';
import type { PromotionDto } from './promotion.dto.js';
import { Promotion, type PromotionDocument } from './promotion.schema.js';

const DUPLICATE_KEY = 11000;

export interface AppliedPromotion {
  id: string;
  code: string;
  type: 'percent' | 'amount';
  value: number;
}

function rejected(code: string, message: string): AppError {
  return new AppError(HttpStatus.BAD_REQUEST, code, message);
}

/** Descuento sobre un precio en céntimos (nunca deja el precio negativo). */
export function discountFor(p: Pick<AppliedPromotion, 'type' | 'value'>, price: number): number {
  return Math.min(price, p.type === 'percent' ? Math.round((price * p.value) / 100) : p.value);
}

@Injectable()
export class PromotionsService {
  constructor(
    @InjectModel(Promotion.name) private readonly promotions: Model<Promotion>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const docs = await this.promotions.find().sort({ isActive: -1, createdAt: -1 }).exec();
    const uses = await this.appointments.aggregate<{ _id: unknown; n: number; discount: number }>([
      { $match: { promotionId: { $in: docs.map((d) => d._id) }, status: { $ne: 'cancelled' } } },
      { $group: { _id: '$promotionId', n: { $sum: 1 }, discount: { $sum: { $subtract: ['$listPrice', '$price'] } } } },
    ]);
    return docs.map((d) => {
      const u = uses.find((x) => String(x._id) === d.id);
      return { ...d.toJSON(), uses: u?.n ?? 0, discountGiven: u?.discount ?? 0 };
    });
  }

  async create(dto: PromotionDto): Promise<PromotionDocument> {
    try {
      const promo = await this.promotions.create(this.normalize(dto));
      await this.audit.log({ action: 'promotion.created', entityType: 'Promotion', entityId: promo.id as string });
      return promo;
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) throw Errors.conflict('CODE_TAKEN', 'Ya tienes un cupón con ese código');
      throw error;
    }
  }

  async update(id: string, dto: Partial<PromotionDto>): Promise<PromotionDocument> {
    const promo = await this.promotions.findById(id).exec();
    if (!promo) throw Errors.notFound('Cupón');
    promo.set(this.normalize(dto));
    try {
      await promo.save();
    } catch (error) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) throw Errors.conflict('CODE_TAKEN', 'Ya tienes un cupón con ese código');
      throw error;
    }
    await this.audit.log({ action: 'promotion.updated', entityType: 'Promotion', entityId: id });
    return promo;
  }

  /** Validación previa (página pública): el código existe, está vigente y aplica al servicio. */
  async preview(code: string, serviceId: string) {
    const promo = await this.findUsable(code);
    if (promo.serviceIds.length && !promo.serviceIds.some((s) => s.toString() === serviceId)) {
      throw rejected('PROMO_NOT_APPLICABLE', 'Este cupón no aplica a este servicio');
    }
    return { code: promo.code, description: promo.description, type: promo.type, value: promo.value };
  }

  /** Validación completa al reservar: servicio, fecha, día, hora, cliente y usos. */
  async apply(input: { code: string; serviceId: string; startsAt: Date; timezone: string; clientId: string; isNewClient: boolean }): Promise<AppliedPromotion> {
    const promo = await this.findUsable(input.code);
    const local = utcToZoned(input.startsAt, input.timezone);
    if (promo.serviceIds.length && !promo.serviceIds.some((s) => s.toString() === input.serviceId)) {
      throw rejected('PROMO_NOT_APPLICABLE', 'Este cupón no aplica a este servicio');
    }
    if ((promo.validFrom && local.date < promo.validFrom) || (promo.validTo && local.date > promo.validTo)) {
      throw rejected('PROMO_NOT_APPLICABLE', 'Este cupón no vale para la fecha elegida');
    }
    if (promo.weekdays.length && !promo.weekdays.includes(local.weekday)) {
      throw rejected('PROMO_NOT_APPLICABLE', 'Este cupón no vale para el día elegido');
    }
    if ((promo.fromMinute != null && local.minutes < promo.fromMinute) || (promo.toMinute != null && local.minutes >= promo.toMinute)) {
      throw rejected('PROMO_NOT_APPLICABLE', 'Este cupón no vale para la hora elegida');
    }
    if (promo.newClientsOnly && !input.isNewClient) throw rejected('PROMO_NEW_CLIENTS', 'Este cupón es solo para tu primera visita');
    const active = { promotionId: promo._id, status: { $ne: 'cancelled' as const } };
    if (promo.oncePerClient && (await this.appointments.exists({ ...active, clientId: input.clientId }))) {
      throw rejected('PROMO_USED', 'Ya usaste este cupón');
    }
    if (promo.maxUses != null && (await this.appointments.countDocuments(active)) >= promo.maxUses) {
      throw rejected('PROMO_EXHAUSTED', 'Este cupón ya se agotó');
    }
    return { id: promo.id as string, code: promo.code, type: promo.type, value: promo.value };
  }

  /* ---------- Internos ---------- */

  private async findUsable(code: string): Promise<PromotionDocument> {
    const promo = await this.promotions.findOne({ code: code.trim().toUpperCase(), isActive: true }).exec();
    if (!promo) throw rejected('PROMO_INVALID', 'Cupón no válido');
    return promo;
  }

  private normalize(dto: Partial<PromotionDto>) {
    if (dto.type === 'percent' && dto.value != null && dto.value > 100) throw Errors.badRequest('INVALID_VALUE', 'El porcentaje va de 1 a 100');
    if (dto.validFrom && dto.validTo && dto.validTo < dto.validFrom) throw Errors.badRequest('INVALID_RANGE', 'La fecha final debe ser posterior a la inicial');
    if (dto.fromMinute != null && dto.toMinute != null && dto.toMinute <= dto.fromMinute) throw Errors.badRequest('INVALID_RANGE', 'La hora final debe ser posterior a la inicial');
    return { ...dto, ...(dto.code && { code: dto.code.replace(/\s/g, '').toUpperCase() }) };
  }
}
