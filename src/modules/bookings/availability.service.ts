import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { Errors } from '../../core/common/errors.js';
import { addDays, isValidDate, zonedToUtc } from '../../core/scheduling/zoned-time.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { Service, type ServiceDocument } from '../catalog/schemas/service.schema.js';
import { BranchException } from '../organization/schemas/branch-exception.schema.js';
import { Branch, type BranchDocument } from '../organization/schemas/branch.schema.js';
import { Organization, type BookingRules } from '../organization/schemas/organization.schema.js';
import { Professional, type ProfessionalDocument } from '../professionals/schemas/professional.schema.js';
import { TimeOff } from '../professionals/schemas/time-off.schema.js';
import { blockedRange, daySlots, pickResource, type Interval, type ResourceLoad, type Slot } from './availability.engine.js';
import { Resource } from '../resources/resource.schema.js';
import { Appointment, BLOCKING_STATUSES } from './schemas/appointment.schema.js';

export const SLOT_STEP_MINUTES = 15;
const MAX_RANGE_DAYS = 42;

export interface AvailabilityRequest {
  branchId: string;
  serviceId: string;
  professionalId?: string;
  from: string;
  to: string;
  /** Online: aplica anticipación mínima y ventana de reserva. El equipo puede agendar fuera de ellas. */
  applyRules: boolean;
  excludeAppointmentId?: string;
  session?: ClientSession;
}

export interface ProfessionalAvailability {
  professionalId: string;
  displayName: string;
  color: string;
  price: number;
  durationMinutes: number;
  days: Array<{ date: string; slots: Array<Slot & { resourceId?: string }> }>;
}

export interface AvailabilityResult {
  timezone: string;
  service: ServiceDocument;
  branch: BranchDocument;
  professionals: ProfessionalAvailability[];
}

/** Precio y duración que aplica un profesional a un servicio. */
export function termsFor(p: ProfessionalDocument, s: ServiceDocument): { price: number; durationMinutes: number } {
  const own = p.services.find((x) => x.serviceId.equals(s._id));
  return { price: own?.price ?? s.price, durationMinutes: own?.durationMinutes ?? s.durationMinutes };
}

/** Reúne los datos de la base y los pasa al motor de disponibilidad. */
@Injectable()
export class AvailabilityService {
  constructor(
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(BranchException.name) private readonly exceptions: Model<BranchException>,
    @InjectModel(Service.name) private readonly services: Model<Service>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(TimeOff.name) private readonly timeOff: Model<TimeOff>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(Resource.name) private readonly resources: Model<Resource>,
  ) {}

  async compute(req: AvailabilityRequest): Promise<AvailabilityResult> {
    if (!isValidDate(req.from) || !isValidDate(req.to) || req.to < req.from) {
      throw Errors.badRequest('INVALID_RANGE', 'Rango de fechas inválido');
    }
    const dates: string[] = [];
    for (let d = req.from; d <= req.to; d = addDays(d, 1)) {
      dates.push(d);
      if (dates.length > MAX_RANGE_DAYS) throw Errors.badRequest('INVALID_RANGE', `Máximo ${MAX_RANGE_DAYS} días`);
    }
    const session = req.session ?? null;

    const [branch, service] = await Promise.all([
      this.branches.findById(req.branchId).session(session).exec(),
      this.services.findById(req.serviceId).session(session).exec(),
    ]);
    if (!branch || !branch.isActive) throw Errors.notFound('Sucursal');
    if (!service || service.isArchived) throw Errors.notFound('Servicio');

    const professionals = await this.professionals
      .find({
        isActive: true,
        branchIds: branch._id,
        'services.serviceId': service._id,
        ...(req.professionalId && { _id: req.professionalId }),
      })
      .session(session)
      .exec();
    if (req.professionalId && professionals.length === 0) {
      throw Errors.badRequest('PROFESSIONAL_UNAVAILABLE', 'El profesional no realiza este servicio en esta sede');
    }

    const timezone = branch.timezone;
    const rangeStart = zonedToUtc(req.from, 0, timezone);
    const rangeEnd = zonedToUtc(addDays(req.to, 1), 0, timezone);
    const ids = professionals.map((p) => p._id);

    const [exceptions, timeOff, busy, rules] = await Promise.all([
      this.exceptions.find({ branchId: branch._id, date: { $gte: req.from, $lte: req.to } }).session(session).exec(),
      this.timeOff
        .find({ professionalId: { $in: ids }, status: 'approved', startsAt: { $lt: rangeEnd }, endsAt: { $gt: rangeStart } })
        .session(session)
        .exec(),
      this.appointments
        .find({
          professionalId: { $in: ids },
          status: { $in: BLOCKING_STATUSES },
          blockedFrom: { $lt: rangeEnd },
          blockedUntil: { $gt: rangeStart },
          ...(req.excludeAppointmentId && { _id: { $ne: req.excludeAppointmentId } }),
        })
        .select('professionalId blockedFrom blockedUntil')
        .session(session)
        .exec(),
      req.applyRules ? this.rules(session) : Promise.resolve(null),
    ]);

    // Recursos que necesita el servicio en esta sede (basta uno con espacio).
    const required = await this.resources.find({ branchId: branch._id, isActive: true, serviceIds: service._id }).session(session).exec();
    const resourceBusy = required.length
      ? await this.appointments
          .find({
            resourceId: { $in: required.map((r) => r._id) },
            status: { $in: BLOCKING_STATUSES },
            blockedFrom: { $lt: rangeEnd },
            blockedUntil: { $gt: rangeStart },
            ...(req.excludeAppointmentId && { _id: { $ne: req.excludeAppointmentId } }),
          })
          .select('resourceId blockedFrom blockedUntil')
          .session(session)
          .exec()
      : [];
    const loads: ResourceLoad[] = required.map((r) => ({
      id: r.id as string,
      capacity: r.capacity,
      busy: resourceBusy.filter((a) => a.resourceId?.equals(r._id)).map((a) => ({ start: a.blockedFrom, end: a.blockedUntil })),
    }));

    const now = Date.now();
    const notBefore = rules?.minNoticeMinutes != null ? new Date(now + rules.minNoticeMinutes * 60_000) : undefined;
    const notAfter = rules?.maxAdvanceDays != null ? new Date(now + rules.maxAdvanceDays * 86_400_000) : undefined;
    const ignoreBusy = rules?.allowOverbooking === true;

    return {
      timezone,
      service,
      branch,
      professionals: professionals.map((p) => {
        const terms = termsFor(p, service);
        const days = p.schedules.find((s) => s.branchId.equals(branch._id))?.days ?? [];
        const offs: Interval[] = timeOff
          .filter((t) => t.professionalId.equals(p._id))
          .map((t) => ({ start: t.startsAt, end: t.endsAt }));
        const taken: Interval[] = ignoreBusy
          ? []
          : busy.filter((a) => a.professionalId.equals(p._id)).map((a) => ({ start: a.blockedFrom, end: a.blockedUntil }));
        return {
          professionalId: p.id as string,
          displayName: p.displayName,
          color: p.color,
          ...terms,
          days: dates.map((date) => ({
            date,
            slots: daySlots({
              date,
              timezone,
              branchHours: branch.openingHours,
              exception: exceptions.find((e) => e.date === date) ?? null,
              professionalDays: days,
              timeOff: offs,
              busy: taken,
              durationMinutes: terms.durationMinutes,
              bufferBeforeMinutes: service.bufferBeforeMinutes,
              bufferAfterMinutes: service.bufferAfterMinutes,
              stepMinutes: SLOT_STEP_MINUTES,
              notBefore,
              notAfter,
            }).map((s) => {
              if (!loads.length || !s.available) return s;
              const block = blockedRange(s.start, terms.durationMinutes, service.bufferBeforeMinutes, service.bufferAfterMinutes);
              const resourceId = pickResource(block, loads);
              return resourceId ? { ...s, resourceId } : { ...s, available: false };
            }),
          })),
        };
      }),
    };
  }

  private async rules(session: ClientSession | null): Promise<BookingRules> {
    const org = await this.organizations
      .findById(TenantContext.requireOrganizationId())
      .select('bookingRules')
      .session(session)
      .exec();
    if (!org) throw Errors.notFound('Negocio');
    return org.toObject().bookingRules;
  }
}
