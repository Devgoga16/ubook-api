import { createHash, createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { Env } from '../../config/env.js';
import { AppError, Errors } from '../../core/common/errors.js';
import { WhatsAppService } from '../../core/mail/whatsapp.service.js';
import { TenantContext } from '../../core/tenancy/tenant-context.js';
import { normalizeDocument, normalizePhone } from '../clients/clients.service.js';
import { Client, type ClientDocument } from '../clients/schemas/client.schema.js';
import { Branch } from '../organization/schemas/branch.schema.js';
import { Organization, type OrganizationDocument } from '../organization/schemas/organization.schema.js';
import { Payment } from '../payments/schemas/payment.schemas.js';
import { EntitlementsService } from '../platform/entitlements.service.js';
import { Professional } from '../professionals/schemas/professional.schema.js';
import { SupportTicketsService } from '../support/support-tickets.service.js';
import type { ClientTicketDto, TicketMessageDto } from '../support/support.dto.js';
import { BookingLinksService } from './booking-links.service.js';
import { Appointment } from './schemas/appointment.schema.js';
import { PortalCode } from './schemas/portal-code.schema.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Códigos que se pueden pedir para un mismo celular en un cuarto de hora. */
const MAX_CODES = 3;
const CODES_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 200;
const PAYMENTS_LIMIT = 100;
const MAX_DEPENDENTS = 10;
const DUPLICATE_KEY = 11000;

const unavailable = () => new AppError(HttpStatus.NOT_FOUND, 'PORTAL_UNAVAILABLE', 'Este negocio no tiene portal de clientes por ahora');
const invalidCode = () => new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CODE', 'El código no es correcto o ya venció. Pide uno nuevo.');
const sessionExpired = () => new AppError(HttpStatus.UNAUTHORIZED, 'PORTAL_SESSION_EXPIRED', 'Tu sesión venció. Ingresa de nuevo con tu celular.');

export interface PortalProfileUpdate {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  birthDate?: string | null;
  marketingConsent?: boolean;
  relationship?: string;
}

export interface PortalDependentInput {
  firstName: string;
  lastName?: string;
  birthDate?: string | null;
  documentId?: string;
  relationship?: string;
  /** Titular que responde por la persona, si varios comparten el celular. */
  guardianId?: string;
}

/** Personas que ve una sesión: los titulares del celular y quienes tienen a su cargo. */
interface Household {
  holders: ClientDocument[];
  dependents: ClientDocument[];
  all: ClientDocument[];
}

/**
 * Portal del cliente: la persona entra con su celular y un código que le llega
 * por WhatsApp, y gestiona sus citas y las de las personas a su cargo en ESE
 * negocio. La sesión es un token firmado que solo vale para el negocio del
 * enlace y para ese celular.
 */
@Injectable()
export class ClientPortalService {
  private readonly key: Buffer;

  constructor(
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    @InjectModel(Appointment.name) private readonly appointments: Model<Appointment>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Branch.name) private readonly branches: Model<Branch>,
    @InjectModel(Professional.name) private readonly professionals: Model<Professional>,
    @InjectModel(PortalCode.name) private readonly codes: Model<PortalCode>,
    private readonly entitlements: EntitlementsService,
    private readonly whatsapp: WhatsAppService,
    private readonly links: BookingLinksService,
    private readonly tickets: SupportTicketsService,
    config: ConfigService<Env, true>,
  ) {
    this.key = Buffer.from(hkdfSync('sha256', config.get('JWT_ACCESS_SECRET', { infer: true }), 'ubook', 'client-portal-session', 32));
  }

  /** ¿El negocio ofrece portal? (plan con `client_portal` y suscripción vigente). */
  async isEnabled(organizationId: string): Promise<boolean> {
    const ent = await this.entitlements.get(organizationId);
    return ent.features.client_portal === true && !ent.readOnly && !ent.suspended;
  }

  /* ---------- Entrar ---------- */

  /**
   * Envía el código por WhatsApp si el celular es de un cliente del negocio.
   * Responde igual en ambos casos: no revela quién es cliente de quién.
   */
  requestCode(slug: string, rawPhone: string) {
    return this.open(slug, async (org) => {
      const phone = normalizePhone(rawPhone)!;
      const recent = await this.codes.countDocuments({ phone, createdAt: { $gt: new Date(Date.now() - CODES_WINDOW_MS) } }).exec();
      if (recent >= MAX_CODES) {
        throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_CODES', 'Ya te enviamos varios códigos. Espera unos minutos antes de pedir otro.');
      }
      // Un código nuevo invalida los anteriores.
      await this.codes.updateMany({ phone, usedAt: null }, { usedAt: new Date() }).exec();
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      await this.codes.create({ phone, codeHash: this.hashCode(org.id as string, phone, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) });

      if (await this.clients.exists({ phone })) {
        const sent = await this.whatsapp.send({
          to: phone,
          text: `Tu código para ver tus citas en ${org.name} es ${code}. Vence en 10 minutos. Si no lo pediste, ignora este mensaje.`,
        });
        if (!sent.ok) {
          throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'CODE_NOT_SENT', 'No pudimos enviarte el código por WhatsApp. Intenta de nuevo en unos minutos.');
        }
      }
      return { ok: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    });
  }

  /** Cambia el código por una sesión. */
  verifyCode(slug: string, rawPhone: string, code: string) {
    return this.open(slug, async (org) => {
      const phone = normalizePhone(rawPhone)!;
      const entry = await this.codes.findOne({ phone, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).exec();
      if (!entry || entry.attempts >= MAX_ATTEMPTS) throw invalidCode();

      const expected = Buffer.from(entry.codeHash);
      const given = Buffer.from(this.hashCode(org.id as string, phone, code));
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
        await this.codes.updateOne({ _id: entry._id }, { $inc: { attempts: 1 } }).exec();
        throw invalidCode();
      }
      // Se marca usado primero: el mismo código no abre dos sesiones.
      const claimed = await this.codes.updateOne({ _id: entry._id, usedAt: null }, { usedAt: new Date() }).exec();
      if (!claimed.modifiedCount) throw invalidCode();

      const household = await this.household(phone);
      if (!household.holders.length) throw invalidCode();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      return { token: this.signSession(org.id as string, phone, expiresAt), expiresAt, ...(await this.account(org, phone, household)) };
    });
  }

  /* ---------- Con sesión ---------- */

  me(slug: string, token: string) {
    return this.withSession(slug, token, async (org, phone) => this.account(org, phone, await this.household(phone)));
  }

  /** Citas del titular y de las personas a su cargo, con el enlace para gestionarlas. */
  appointmentsOf(slug: string, token: string) {
    return this.withSession(slug, token, async (_org, phone) => {
      const { all } = await this.household(phone);
      const docs = await this.appointments
        .find({ clientId: { $in: all.map((c) => c._id) } })
        .sort({ startsAt: -1 })
        .limit(HISTORY_LIMIT)
        .exec();
      const [branches, pros] = await Promise.all([
        this.branches.find({ _id: { $in: docs.map((d) => d.branchId) } }).exec(),
        this.professionals.find({ _id: { $in: docs.map((d) => d.professionalId) } }).select('displayName color').exec(),
      ]);
      const branchById = new Map(branches.map((b) => [b.id as string, b]));
      const proById = new Map(pros.map((p) => [p.id as string, p]));
      const now = Date.now();
      const items = docs.map((a) => {
        const pro = proById.get(a.professionalId.toString());
        const branch = branchById.get(a.branchId.toString());
        return {
          /** Enlace firmado de la cita: abre /reserva/:token para cancelar o reprogramar. */
          token: this.links.token(a.id as string),
          clientId: a.clientId.toString(),
          number: a.number,
          status: a.status,
          startsAt: a.startsAt,
          endsAt: a.endsAt,
          serviceId: a.serviceId.toString(),
          serviceName: a.serviceName,
          price: a.price,
          durationMinutes: a.durationMinutes,
          professional: { id: a.professionalId.toString(), displayName: pro?.displayName ?? '', color: pro?.color ?? null },
          branch: { id: a.branchId.toString(), name: branch?.name ?? '', address: branch?.address ?? '', mapsUrl: branch?.mapsUrl ?? '', phone: branch?.phone ?? '' },
          deposit: a.deposit ? { amount: a.deposit.amount, status: a.deposit.status, rejectReason: a.deposit.rejectReason ?? null } : null,
          upcoming: ['pending', 'confirmed'].includes(a.status) && a.startsAt.getTime() > now,
        };
      });
      return {
        // Las próximas, de la más cercana a la más lejana.
        upcoming: items.filter((i) => i.upcoming).reverse(),
        past: items.filter((i) => !i.upcoming),
      };
    });
  }

  /** Lo que el titular y sus beneficiarios pagaron en el negocio. */
  paymentsOf(slug: string, token: string) {
    return this.withSession(slug, token, async (_org, phone) => {
      const { all } = await this.household(phone);
      const docs = await this.payments
        .find({ clientId: { $in: all.map((c) => c._id) }, status: 'paid' })
        .sort({ createdAt: -1 })
        .limit(PAYMENTS_LIMIT)
        .exec();
      const year = new Date().getFullYear().toString();
      const items = docs.map((p) => ({
        id: p.id as string,
        number: p.number,
        clientId: p.clientId.toString(),
        date: p.localDate,
        serviceName: p.serviceName,
        discount: p.discount,
        tip: p.tip,
        total: p.amount + p.tip,
        methods: p.methods.map((m) => ({ method: m.method, amount: m.amount })),
      }));
      return {
        items,
        totalThisYear: items.filter((i) => i.date.startsWith(year)).reduce((sum, i) => sum + i.total, 0),
      };
    });
  }

  updateProfile(slug: string, token: string, clientId: string, dto: PortalProfileUpdate) {
    return this.withSession(slug, token, async (_org, phone) => {
      const household = await this.household(phone);
      const client = this.member(household, clientId);
      if (dto.firstName) client.firstName = dto.firstName;
      if (dto.lastName !== undefined) client.lastName = dto.lastName;
      if (dto.email !== undefined) client.email = dto.email ?? undefined;
      if (dto.birthDate !== undefined) client.birthDate = dto.birthDate ?? undefined;
      if (dto.marketingConsent !== undefined) client.marketingConsent = dto.marketingConsent;
      // El parentesco solo aplica a quien está a cargo de un titular.
      if (dto.relationship !== undefined && household.dependents.includes(client)) client.relationship = dto.relationship;
      await client.save();
      return profileView(client, household);
    });
  }

  /* ---------- Responsables y beneficiarios ---------- */

  /** El titular registra a alguien a su cargo (hijo, padre, pareja…) para reservarle citas. */
  addDependent(slug: string, token: string, dto: PortalDependentInput) {
    return this.withSession(slug, token, async (org, phone) => {
      await this.assertGuardians(org);
      const household = await this.household(phone);
      const guardian = dto.guardianId ? household.holders.find((h) => (h.id as string) === dto.guardianId) : household.holders[0];
      if (!guardian) throw Errors.notFound('Titular');
      if (household.dependents.length >= MAX_DEPENDENTS) {
        throw Errors.badRequest('TOO_MANY_DEPENDENTS', `Puedes tener hasta ${MAX_DEPENDENTS} personas a tu cargo. Si necesitas más, pídeselo al negocio.`);
      }
      const documentId = normalizeDocument(dto.documentId);
      if (documentId && (await this.clients.exists({ documentId }))) throw documentTaken();
      try {
        const created = await this.clients.create({
          firstName: dto.firstName,
          lastName: dto.lastName ?? '',
          birthDate: dto.birthDate ?? undefined,
          documentId,
          guardianId: guardian._id,
          relationship: dto.relationship ?? '',
          source: 'Portal del cliente',
          dataConsentAt: new Date(),
        });
        const next = await this.household(phone);
        return profileView(next.all.find((c) => c._id.equals(created._id))!, next);
      } catch (error) {
        if ((error as { code?: number }).code === DUPLICATE_KEY) throw documentTaken();
        throw error;
      }
    });
  }

  /**
   * El titular deja de gestionar a una persona. Si nunca tuvo citas se borra;
   * si las tuvo, el negocio conserva su historial y solo se quita el vínculo.
   */
  removeDependent(slug: string, token: string, clientId: string) {
    return this.withSession(slug, token, async (_org, phone) => {
      const household = await this.household(phone);
      const dependent = household.dependents.find((d) => (d.id as string) === clientId);
      if (!dependent) throw Errors.notFound('Persona');
      const upcoming = await this.appointments.countDocuments({ clientId: dependent._id, status: { $in: ['pending', 'confirmed'] }, startsAt: { $gt: new Date() } }).exec();
      if (upcoming) {
        throw Errors.conflict('HAS_UPCOMING_APPOINTMENTS', `${dependent.firstName} tiene ${upcoming === 1 ? 'una cita próxima' : `${upcoming} citas próximas`}. Cancélalas antes de quitarle de tu cuenta.`);
      }
      if (await this.appointments.exists({ clientId: dependent._id })) {
        dependent.set({ guardianId: null, relationship: '' });
        await dependent.save();
      } else {
        await this.clients.deleteOne({ _id: dependent._id }).exec();
      }
      return { ok: true };
    });
  }

  /* ---------- Ayuda ---------- */

  /** Consultas del titular y de las personas a su cargo (al negocio o al soporte técnico). */
  helpList(slug: string, token: string) {
    return this.withSession(slug, token, async (_org, phone) => this.tickets.listForClients((await this.household(phone)).all.map((c) => c._id)));
  }

  /** Captura de pantalla para adjuntar a una consulta. */
  helpUpload(slug: string, token: string, buffer: Buffer) {
    return this.withSession(slug, token, (org) => this.tickets.uploadAttachment(org.id as string, buffer));
  }

  /** La consulta queda a nombre del titular de la cuenta. */
  helpCreate(slug: string, token: string, dto: ClientTicketDto) {
    return this.withSession(slug, token, async (_org, phone) => {
      const { holders } = await this.household(phone);
      if (!holders[0]) throw Errors.notFound('Perfil');
      return this.tickets.createForClient(holders[0], dto);
    });
  }

  helpDetail(slug: string, token: string, id: string) {
    return this.withSession(slug, token, async (_org, phone) => this.tickets.getForClients((await this.household(phone)).all.map((c) => c._id), id));
  }

  helpReply(slug: string, token: string, id: string, dto: TicketMessageDto) {
    return this.withSession(slug, token, async (_org, phone) => this.tickets.replyAsClient((await this.household(phone)).all.map((c) => c._id), id, { ...dto, internal: false }));
  }

  helpResolve(slug: string, token: string, id: string) {
    return this.withSession(slug, token, async (_org, phone) => this.tickets.resolveByClient((await this.household(phone)).all.map((c) => c._id), id));
  }

  /**
   * Para reservar con la sesión abierta: la persona elegida (titular o
   * beneficiario). Se llama ya dentro del negocio (contexto de tenant activo).
   */
  async bookingClient(organizationId: string, token: string | undefined, clientId: string): Promise<ClientDocument> {
    const phone = this.verifySession(organizationId, token);
    if (!phone || !(await this.isEnabled(organizationId))) throw sessionExpired();
    return this.member(await this.household(phone), clientId);
  }

  /* ---------- Internos ---------- */

  private async open<T>(slug: string, fn: (org: OrganizationDocument) => Promise<T>): Promise<T> {
    const org = await this.organizations.findOne({ slug: slug.toLowerCase().trim(), status: 'active' }).exec();
    if (!org || !(await this.isEnabled(org.id as string))) throw unavailable();
    return TenantContext.runForOrganization(org.id as string, () => fn(org));
  }

  private withSession<T>(slug: string, token: string | undefined, fn: (org: OrganizationDocument, phone: string) => Promise<T>): Promise<T> {
    return this.open(slug, (org) => {
      const phone = this.verifySession(org.id as string, token);
      if (!phone) throw sessionExpired();
      return fn(org, phone);
    });
  }

  private async account(org: OrganizationDocument, phone: string, household: Household) {
    const ent = await this.entitlements.get(org.id as string);
    return {
      phone,
      /** El plan permite registrar personas a cargo desde el portal. */
      features: { guardians: ent.features.guardians === true },
      profiles: household.all.map((c) => profileView(c, household)),
    };
  }

  private async assertGuardians(org: OrganizationDocument): Promise<void> {
    const ent = await this.entitlements.get(org.id as string);
    if (ent.features.guardians !== true) throw Errors.featureNotInPlan('guardians');
  }

  /**
   * Titulares: clientes registrados con ese celular. Beneficiarios: quienes
   * tienen a un titular como responsable (aunque no compartan el celular).
   */
  private async household(phone: string): Promise<Household> {
    const sameNumber = await this.clients.find({ phone }).sort({ createdAt: 1 }).exec();
    const ids = sameNumber.map((c) => c._id);
    const others = ids.length ? await this.clients.find({ guardianId: { $in: ids }, _id: { $nin: ids } }).sort({ createdAt: 1 }).exec() : [];
    const isDependent = (c: ClientDocument) => !!c.guardianId && ids.some((id) => id.equals(c.guardianId!));
    const holders = sameNumber.filter((c) => !isDependent(c));
    const dependents = [...sameNumber.filter(isDependent), ...others];
    return { holders, dependents, all: [...holders, ...dependents] };
  }

  private member(household: Household, clientId: string): ClientDocument {
    const client = household.all.find((c) => (c.id as string) === clientId);
    if (!client) throw Errors.notFound('Perfil');
    return client;
  }

  private hashCode(organizationId: string, phone: string, code: string): string {
    return createHash('sha256').update(`${organizationId}|${phone}|${code}`).digest('hex');
  }

  /** `<negocio>.<celular>.<vence>.<firma>`: no se guarda nada en el servidor. */
  private signSession(organizationId: string, phone: string, expiresAt: Date): string {
    const payload = `${organizationId}.${phone.replace(/\D/g, '')}.${expiresAt.getTime()}`;
    return `${payload}.${this.sign(payload)}`;
  }

  private verifySession(organizationId: string, token: string | undefined): string | null {
    const [org, digits, exp, signature] = (token ?? '').split('.');
    if (!org || !digits || !exp || !signature) return null;
    const expected = Buffer.from(this.sign(`${org}.${digits}.${exp}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    if (org !== organizationId || Number(exp) < Date.now()) return null;
    return `+${digits}`;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}

const documentTaken = () =>
  Errors.conflict('DOCUMENT_TAKEN', 'Ese documento ya está registrado en este negocio. Pídeles que vinculen a esa persona con tu cuenta.');

function profileView(c: ClientDocument, household: Household) {
  const isHolder = household.holders.includes(c);
  return {
    id: c.id as string,
    firstName: c.firstName,
    lastName: c.lastName ?? '',
    email: c.email ?? '',
    birthDate: c.birthDate ?? '',
    marketingConsent: c.marketingConsent,
    /** Titular de la cuenta (dueño del celular) o persona a su cargo. */
    isHolder,
    guardianId: isHolder ? null : (c.guardianId?.toString() ?? null),
    relationship: isHolder ? '' : c.relationship,
  };
}
