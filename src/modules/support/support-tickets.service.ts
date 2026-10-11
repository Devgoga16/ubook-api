import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model, type QueryFilter } from 'mongoose';
import { AuditService } from '../../core/audit/audit.service.js';
import { currentScope } from '../../core/authorization/scope.js';
import { Errors } from '../../core/common/errors.js';
import { MailService } from '../../core/mail/mail.service.js';
import { WhatsAppService } from '../../core/mail/whatsapp.service.js';
import { supportTicketEmail } from '../../core/mail/templates.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { TenantContext, type Actor } from '../../core/tenancy/tenant-context.js';
import { Client, type ClientDocument } from '../clients/schemas/client.schema.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { User } from '../identity/schemas/user.schema.js';
import { SessionsService } from '../identity/sessions.service.js';
import { UsersService } from '../identity/users.service.js';
import { Organization } from '../organization/schemas/organization.schema.js';
import { effectiveStatus } from '../platform/entitlements.service.js';
import { SubscriptionsService } from '../platform/subscriptions.service.js';
import type { ClientTicketDto, CreateTicketDto, ListPlatformTicketsQuery, TicketMessageDto, UpdateTicketDto } from './support.dto.js';
import {
  SupportCounter,
  SupportMessage,
  SupportTicket,
  type SupportMessageDocument,
  type SupportTicketDocument,
  type TicketAudience,
} from './support.schemas.js';

const FIRST_NUMBER = 1000;
const PREVIEW_LENGTH = 140;
/** Las capturas se ven mientras la conversación está abierta en pantalla. */
const ATTACHMENT_URL_TTL_SECONDS = 60 * 60;
const TENANT_LIST_LIMIT = 100;

/** Tickets que el equipo del negocio abre con Unify Tec (no los de sus clientes finales). */
const STAFF_TICKET = { clientId: null } as const;
/** Consultas de clientes finales que atiende el propio negocio. */
const INQUIRY = { audience: 'business' } as const;
/** Lo que ve el equipo de plataforma: tickets de negocios y problemas técnicos de clientes finales. */
const PLATFORM = { audience: 'platform' } as const;

export interface ClientContact {
  id: string;
  name: string;
  phone: string | null;
}

const fullName = (u: { firstName: string; lastName: string }) => `${u.firstName} ${u.lastName}`.trim();
const preview = (body: string) => (body.length > PREVIEW_LENGTH ? `${body.slice(0, PREVIEW_LENGTH)}…` : body);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tickets de soporte. El negocio los abre y conversa desde su panel; el equipo
 * de plataforma los atiende desde el suyo. Los tickets son datos del negocio
 * (llevan organizationId), así que la plataforma los lee con `runAsSystem`.
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    @InjectModel(SupportTicket.name) private readonly tickets: Model<SupportTicket>,
    @InjectModel(SupportMessage.name) private readonly messages: Model<SupportMessage>,
    @InjectModel(SupportCounter.name) private readonly counters: Model<SupportCounter>,
    @InjectModel(Organization.name) private readonly organizations: Model<Organization>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Client.name) private readonly clients: Model<Client>,
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly storage: StorageService,
    private readonly mail: MailService,
    private readonly whatsapp: WhatsAppService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /* ---------- Lado del negocio ---------- */

  /** Quien administra el negocio ve todos sus tickets; el resto, solo los que abrió. */
  private seesAll(): boolean {
    return !!currentScope('organization.manage');
  }

  async listForOrganization(actor: Actor, scope: 'mine' | 'all' = 'all') {
    const all = this.seesAll() && scope === 'all';
    const docs = await this.tickets
      .find(all ? STAFF_TICKET : { ...STAFF_TICKET, createdByUserId: actor.userId })
      .sort({ lastMessageAt: -1 })
      .limit(TENANT_LIST_LIMIT)
      .exec();
    const agents = await this.namesOf(docs.map((d) => d.assignedToUserId));
    return { canSeeAll: this.seesAll(), items: docs.map((d) => this.customerView(d, agents)) };
  }

  /** Para el aviso del menú: respuestas de soporte sin abrir. */
  async unreadCount(actor: Actor): Promise<{ unread: number }> {
    const unread = await this.tickets
      .countDocuments({ ...STAFF_TICKET, customerUnread: true, ...(!this.seesAll() && { createdByUserId: actor.userId }) })
      .exec();
    return { unread };
  }

  uploadAttachment(organizationId: string, buffer: Buffer) {
    return this.storage.putImage(`support/${organizationId}`, buffer).then((key) => ({ key }));
  }

  async create(actor: Actor, dto: CreateTicketDto) {
    const organizationId = TenantContext.requireOrganizationId();
    const author = await this.users.findById(actor.userId);
    if (!author) throw Errors.unauthorized();
    const attachments = this.ownAttachments(organizationId, dto.attachments);

    const now = new Date();
    const ticket = await this.tickets.create({
      number: await this.nextNumber(),
      subject: dto.subject,
      category: dto.category,
      createdByUserId: actor.userId,
      createdByName: fullName(author),
      context: dto.context ?? {},
      lastMessageAt: now,
      lastMessagePreview: preview(dto.body),
      lastMessageFrom: 'customer',
    });
    await this.messages.create({ ticketId: ticket._id, from: 'customer', authorUserId: actor.userId, authorName: fullName(author), body: dto.body, attachments });
    await this.audit.log({ action: 'support.ticket_created', entityType: 'SupportTicket', entityId: ticket.id as string, metadata: { number: ticket.number } });

    const org = await this.organizations.findById(organizationId).select('name').exec();
    await this.notifyAgents(ticket, null, `${org?.name ?? 'Un negocio'} abrió un ticket`, dto.body);
    return this.customerDetail(ticket);
  }

  async getForOrganization(actor: Actor, id: string) {
    const ticket = await this.findOwn(actor, id);
    // Abrirlo lo marca como leído, salvo que quien mira sea un agente en vista de soporte.
    if (ticket.customerUnread && !actor.supportView) {
      ticket.customerUnread = false;
      await ticket.save();
    }
    return this.customerDetail(ticket);
  }

  async reply(actor: Actor, id: string, dto: TicketMessageDto) {
    const ticket = await this.findOwn(actor, id);
    const author = await this.users.findById(actor.userId);
    if (!author) throw Errors.unauthorized();
    const attachments = this.ownAttachments(ticket.organizationId.toString(), dto.attachments);

    await this.messages.create({ ticketId: ticket._id, from: 'customer', authorUserId: actor.userId, authorName: fullName(author), body: dto.body, attachments });
    // Escribir en un ticket resuelto lo reabre.
    ticket.set({
      status: ticket.status === 'in_progress' ? 'in_progress' : 'open',
      resolvedAt: null,
      lastMessageAt: new Date(),
      lastMessagePreview: preview(dto.body),
      lastMessageFrom: 'customer',
      agentUnread: true,
      customerUnread: false,
    });
    await ticket.save();
    await this.notifyAgents(ticket, ticket.assignedToUserId, `${fullName(author)} respondió`, dto.body);
    return this.customerDetail(ticket);
  }

  /** El negocio confirma que su problema quedó resuelto. */
  async resolveByCustomer(actor: Actor, id: string) {
    const ticket = await this.findOwn(actor, id);
    if (ticket.status !== 'resolved') {
      ticket.set({ status: 'resolved', resolvedAt: new Date(), agentUnread: false, customerUnread: false });
      await ticket.save();
    }
    return this.customerDetail(ticket);
  }

  private async findOwn(actor: Actor, id: string): Promise<SupportTicketDocument> {
    const ticket = await this.tickets.findOne({ _id: id, ...STAFF_TICKET, ...(!this.seesAll() && { createdByUserId: actor.userId }) }).exec();
    if (!ticket) throw Errors.notFound('Ticket');
    return ticket;
  }

  private async customerDetail(ticket: SupportTicketDocument) {
    const [messages, agents] = await Promise.all([
      this.messages.find({ ticketId: ticket._id, internal: false }).sort({ createdAt: 1 }).exec(),
      this.namesOf([ticket.assignedToUserId]),
    ]);
    return { ...this.customerView(ticket, agents), messages: await Promise.all(messages.map((m) => this.messageView(m))) };
  }

  private customerView(t: SupportTicketDocument, agents: Map<string, string>) {
    return {
      id: t.id as string,
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      createdBy: { userId: t.createdByUserId?.toString() ?? '', name: t.createdByName },
      /** Solo el nombre de pila de quien atiende. */
      assignedTo: t.assignedToUserId ? (agents.get(t.assignedToUserId.toString())?.split(' ')[0] ?? null) : null,
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: t.lastMessagePreview,
      lastMessageFrom: t.lastMessageFrom,
      unread: t.customerUnread,
      resolvedAt: t.resolvedAt,
      createdAt: t.createdAt,
    };
  }

  /* ---------- Clientes finales (portal del cliente) ---------- */

  /**
   * Consultas del titular y de las personas a su cargo. Se llama dentro del
   * negocio (contexto de tenant activo), con los clientes de la sesión del portal.
   */
  async listForClients(clientIds: Types.ObjectId[]) {
    const docs = await this.tickets.find({ clientId: { $in: clientIds } }).sort({ lastMessageAt: -1 }).limit(TENANT_LIST_LIMIT).exec();
    return { unread: docs.filter((d) => d.customerUnread).length, items: docs.map((d) => this.clientView(d)) };
  }

  /**
   * El cliente escribe desde el portal. Los problemas técnicos de la página van
   * al equipo de Unify Tec; todo lo demás (citas, pagos, el servicio) lo atiende el negocio.
   */
  async createForClient(client: ClientDocument, dto: ClientTicketDto) {
    const organizationId = TenantContext.requireOrganizationId();
    const attachments = this.ownAttachments(organizationId, dto.attachments);
    const audience: TicketAudience = dto.topic === 'technical' ? 'platform' : 'business';
    const name = fullName({ firstName: client.firstName, lastName: client.lastName ?? '' });

    const ticket = await this.tickets.create({
      number: await this.nextNumber(),
      audience,
      subject: dto.subject,
      category: dto.topic === 'technical' ? 'bug' : dto.topic,
      clientId: client._id,
      createdByName: name,
      context: dto.context ?? {},
      lastMessageAt: new Date(),
      lastMessagePreview: preview(dto.body),
      lastMessageFrom: 'customer',
    });
    await this.messages.create({ ticketId: ticket._id, from: 'customer', authorName: name, body: dto.body, attachments });
    await this.notifyAttendants(ticket, null, 'Consulta de un cliente', `${name} · ${dto.subject}`, dto.body);
    return this.clientDetail(ticket);
  }

  async getForClients(clientIds: Types.ObjectId[], id: string) {
    const ticket = await this.findForClients(clientIds, id);
    if (ticket.customerUnread) {
      ticket.customerUnread = false;
      await ticket.save();
    }
    return this.clientDetail(ticket);
  }

  async replyAsClient(clientIds: Types.ObjectId[], id: string, dto: TicketMessageDto) {
    const ticket = await this.findForClients(clientIds, id);
    const attachments = this.ownAttachments(ticket.organizationId.toString(), dto.attachments);
    await this.messages.create({ ticketId: ticket._id, from: 'customer', authorName: ticket.createdByName, body: dto.body, attachments });
    // Escribir en una consulta resuelta la reabre.
    ticket.set({
      status: ticket.status === 'in_progress' ? 'in_progress' : 'open',
      resolvedAt: null,
      lastMessageAt: new Date(),
      lastMessagePreview: preview(dto.body),
      lastMessageFrom: 'customer',
      agentUnread: true,
      customerUnread: false,
    });
    await ticket.save();
    await this.notifyAttendants(ticket, ticket.assignedToUserId, 'Un cliente respondió', `${ticket.createdByName} · ${ticket.subject}`, dto.body);
    return this.clientDetail(ticket);
  }

  async resolveByClient(clientIds: Types.ObjectId[], id: string) {
    const ticket = await this.findForClients(clientIds, id);
    if (ticket.status !== 'resolved') {
      ticket.set({ status: 'resolved', resolvedAt: new Date(), agentUnread: false, customerUnread: false });
      await ticket.save();
    }
    return this.clientDetail(ticket);
  }

  private async findForClients(clientIds: Types.ObjectId[], id: string): Promise<SupportTicketDocument> {
    const ticket = await this.tickets.findOne({ _id: id, clientId: { $in: clientIds } }).exec();
    if (!ticket) throw Errors.notFound('Consulta');
    return ticket;
  }

  private async clientDetail(ticket: SupportTicketDocument) {
    const messages = await this.messages.find({ ticketId: ticket._id, internal: false }).sort({ createdAt: 1 }).exec();
    return { ...this.clientView(ticket), messages: await Promise.all(messages.map((m) => this.messageView(m))) };
  }

  private clientView(t: SupportTicketDocument) {
    return {
      id: t.id as string,
      number: t.number,
      subject: t.subject,
      category: t.category,
      /** Quién responde: el negocio o el soporte técnico de uBook. */
      audience: t.audience,
      status: t.status,
      clientId: t.clientId?.toString() ?? null,
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: t.lastMessagePreview,
      lastMessageFrom: t.lastMessageFrom,
      unread: t.customerUnread,
      resolvedAt: t.resolvedAt,
      createdAt: t.createdAt,
    };
  }

  /* ---------- Consultas de clientes que atiende el negocio ---------- */

  async listInquiries(status?: 'active' | 'resolved') {
    const docs = await this.tickets
      .find({ ...INQUIRY, ...(status === 'active' && { status: { $ne: 'resolved' } }), ...(status === 'resolved' && { status: 'resolved' }) })
      .sort({ lastMessageAt: -1 })
      .limit(TENANT_LIST_LIMIT)
      .exec();
    const clients = await this.clientsOf(docs.map((d) => d.clientId));
    return docs.map((d) => this.inquiryView(d, clients));
  }

  /** Para el aviso del menú: consultas con mensajes de clientes sin abrir. */
  async inquiriesUnread(): Promise<{ unread: number }> {
    return { unread: await this.tickets.countDocuments({ ...INQUIRY, agentUnread: true, status: { $ne: 'resolved' } }).exec() };
  }

  async getInquiry(actor: Actor, id: string) {
    const ticket = await this.findInquiry(id);
    if (ticket.agentUnread && !actor.supportView) {
      ticket.agentUnread = false;
      await ticket.save();
    }
    return this.inquiryDetail(ticket);
  }

  /** El equipo del negocio responde (o deja una nota interna que el cliente no ve). */
  async replyToInquiry(actor: Actor, id: string, dto: TicketMessageDto) {
    const ticket = await this.findInquiry(id);
    const author = await this.users.findById(actor.userId);
    if (!author) throw Errors.unauthorized();
    const internal = dto.internal === true;
    await this.messages.create({
      ticketId: ticket._id,
      from: 'agent',
      authorUserId: actor.userId,
      authorName: fullName(author),
      body: dto.body,
      attachments: this.ownAttachments(ticket.organizationId.toString(), dto.attachments),
      internal,
    });
    if (!internal) {
      ticket.set({
        status: 'waiting_customer',
        resolvedAt: null,
        lastMessageAt: new Date(),
        lastMessagePreview: preview(dto.body),
        lastMessageFrom: 'agent',
        customerUnread: true,
        agentUnread: false,
        ...(!ticket.assignedToUserId && { assignedToUserId: new Types.ObjectId(actor.userId) }),
      });
      await ticket.save();
      await this.notifyRequester(ticket, dto.body);
    }
    return this.inquiryDetail(ticket);
  }

  async setInquiryStatus(id: string, status: 'open' | 'resolved') {
    const ticket = await this.findInquiry(id);
    if (ticket.status !== status) {
      ticket.set({ status, resolvedAt: status === 'resolved' ? new Date() : null, ...(status === 'resolved' && { customerUnread: true, agentUnread: false }) });
      await ticket.save();
    }
    return this.inquiryDetail(ticket);
  }

  private async findInquiry(id: string): Promise<SupportTicketDocument> {
    const ticket = await this.tickets.findOne({ _id: id, ...INQUIRY }).exec();
    if (!ticket) throw Errors.notFound('Consulta');
    return ticket;
  }

  private async inquiryDetail(ticket: SupportTicketDocument) {
    const [messages, clients] = await Promise.all([this.messages.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).exec(), this.clientsOf([ticket.clientId])]);
    return { ...this.inquiryView(ticket, clients), messages: await Promise.all(messages.map((m) => this.messageView(m))) };
  }

  private inquiryView(t: SupportTicketDocument, clients: Map<string, ClientContact>) {
    return {
      id: t.id as string,
      number: t.number,
      subject: t.subject,
      category: t.category,
      status: t.status,
      client: (t.clientId && clients.get(t.clientId.toString())) || { id: t.clientId?.toString() ?? '', name: t.createdByName, phone: null },
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: t.lastMessagePreview,
      lastMessageFrom: t.lastMessageFrom,
      unread: t.agentUnread,
      resolvedAt: t.resolvedAt,
      createdAt: t.createdAt,
    };
  }

  /* ---------- Lado de la plataforma ---------- */

  listForPlatform(actor: Actor, query: ListPlatformTicketsQuery) {
    return TenantContext.runAsSystem(async () => {
      const page = query.page ?? 1;
      const pageSize = query.pageSize ?? 25;
      const filter: QueryFilter<SupportTicket> = { ...PLATFORM };
      if (query.status === 'active') filter.status = { $ne: 'resolved' };
      else if (query.status) filter.status = query.status;
      if (query.priority) filter.priority = query.priority;
      if (query.organizationId) filter.organizationId = new Types.ObjectId(query.organizationId);
      if (query.assignee === 'me') filter.assignedToUserId = new Types.ObjectId(actor.userId);
      else if (query.assignee === 'none') filter.assignedToUserId = null;
      else if (query.assignee && Types.ObjectId.isValid(query.assignee)) filter.assignedToUserId = new Types.ObjectId(query.assignee);
      if (query.search) {
        const number = Number(query.search.replace(/^#/, ''));
        if (Number.isInteger(number) && number > 0) filter.number = number;
        else filter.subject = { $regex: escapeRegex(query.search), $options: 'i' };
      }

      const [docs, total] = await Promise.all([
        this.tickets
          .find(filter)
          .sort({ lastMessageAt: -1 })
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .exec(),
        this.tickets.countDocuments(filter).exec(),
      ]);
      const [orgs, agents] = await Promise.all([this.orgsOf(docs.map((d) => d.organizationId)), this.namesOf(docs.map((d) => d.assignedToUserId))]);
      return { items: docs.map((d) => this.agentView(d, orgs, agents)), total, page, pageSize };
    });
  }

  /** Contadores de la bandeja. */
  summary(actor: Actor) {
    return TenantContext.runAsSystem(async () => {
      const active = { status: { $ne: 'resolved' } } as const;
      const count = (filter: QueryFilter<SupportTicket>) => this.tickets.countDocuments({ ...PLATFORM, ...filter }).exec();
      const [open, unassigned, mine, waitingCustomer, urgent, unread] = await Promise.all([
        count({ status: { $in: ['open', 'in_progress'] } }),
        count({ ...active, assignedToUserId: null }),
        count({ ...active, assignedToUserId: new Types.ObjectId(actor.userId) }),
        count({ status: 'waiting_customer' }),
        count({ ...active, priority: { $in: ['high', 'urgent'] } }),
        count({ ...active, agentUnread: true }),
      ]);
      return { open, unassigned, mine, waitingCustomer, urgent, unread };
    });
  }

  /** Agentes a quienes se puede asignar un ticket. */
  async agents() {
    const users = await this.users.activePlatformUsers();
    return users.map((u) => ({ id: u.id as string, name: fullName(u), platformRole: u.platformRole }));
  }

  getForPlatform(id: string) {
    return TenantContext.runAsSystem(async () => {
      const ticket = await this.findAny(id);
      if (ticket.agentUnread) {
        ticket.agentUnread = false;
        await ticket.save();
      }
      return this.agentDetail(ticket);
    });
  }

  replyAsAgent(actor: Actor, id: string, dto: TicketMessageDto) {
    return TenantContext.runAsSystem(async () => {
      const ticket = await this.findAny(id);
      const author = await this.users.findById(actor.userId);
      if (!author) throw Errors.unauthorized();
      const organizationId = ticket.organizationId.toString();
      const internal = dto.internal === true;

      await this.messages.create({
        organizationId: ticket.organizationId,
        ticketId: ticket._id,
        from: 'agent',
        authorUserId: actor.userId,
        authorName: fullName(author),
        body: dto.body,
        attachments: this.ownAttachments(organizationId, dto.attachments),
        internal,
      });

      if (!internal) {
        ticket.set({
          status: 'waiting_customer',
          resolvedAt: null,
          lastMessageAt: new Date(),
          lastMessagePreview: preview(dto.body),
          lastMessageFrom: 'agent',
          customerUnread: true,
          agentUnread: false,
          // Quien responde primero se queda con el ticket.
          ...(!ticket.assignedToUserId && { assignedToUserId: new Types.ObjectId(actor.userId) }),
        });
        await ticket.save();
        await this.notifyRequester(ticket, dto.body);
      }
      return this.agentDetail(ticket);
    });
  }

  update(actor: Actor, id: string, dto: UpdateTicketDto) {
    return TenantContext.runAsSystem(async () => {
      const ticket = await this.findAny(id);
      if (dto.assignedToUserId) {
        const agent = await this.users.findPlatformUser(dto.assignedToUserId);
        if (!agent?.isActive) throw Errors.badRequest('INVALID_ASSIGNEE', 'Esa persona no está activa en el equipo de soporte');
      }
      if (dto.status && dto.status !== ticket.status) {
        ticket.set({
          status: dto.status,
          resolvedAt: dto.status === 'resolved' ? new Date() : null,
          // Que el negocio vea que su ticket se cerró.
          ...(dto.status === 'resolved' && { customerUnread: true, agentUnread: false }),
        });
      }
      if (dto.priority) ticket.priority = dto.priority;
      if (dto.category) ticket.category = dto.category;
      if (dto.assignedToUserId !== undefined) {
        ticket.assignedToUserId = dto.assignedToUserId ? new Types.ObjectId(dto.assignedToUserId) : null;
      }
      await ticket.save();
      await this.audit.log({
        action: 'support.ticket_updated',
        organizationId: ticket.organizationId.toString(),
        actorUserId: actor.userId,
        entityType: 'SupportTicket',
        entityId: id,
        metadata: { ...dto },
      });
      return this.agentDetail(ticket);
    });
  }

  /** Captura que adjunta el agente: se guarda con los archivos del negocio del ticket. */
  uploadAgentAttachment(id: string, buffer: Buffer) {
    return TenantContext.runAsSystem(async () => {
      const ticket = await this.findAny(id);
      return this.uploadAttachment(ticket.organizationId.toString(), buffer);
    });
  }

  /**
   * Abre la vista de soporte: un access token de solo lectura dentro del negocio.
   * Queda en la auditoría del negocio quién entró y por qué ticket.
   */
  async startSupportView(actor: Actor, organizationId: string, ticketId?: string) {
    const org = await this.organizations.findById(organizationId).select('name').exec();
    if (!org) throw Errors.notFound('Negocio');
    await this.audit.log({
      action: 'support.view_started',
      organizationId,
      actorUserId: actor.userId,
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { ticketId: ticketId ?? null, platformRole: actor.platformRole },
    });
    return this.sessions.issueSupportView(actor.userId, actor.sessionId, organizationId);
  }

  private async findAny(id: string): Promise<SupportTicketDocument> {
    // Las consultas de clientes que atiende el negocio no son visibles para la plataforma.
    const ticket = await this.tickets.findOne({ _id: id, ...PLATFORM }).exec();
    if (!ticket) throw Errors.notFound('Ticket');
    return ticket;
  }

  private async agentDetail(ticket: SupportTicketDocument) {
    const organizationId = ticket.organizationId.toString();
    const [messages, orgs, agents, sub, creator, clients] = await Promise.all([
      this.messages.find({ ticketId: ticket._id }).sort({ createdAt: 1 }).exec(),
      this.orgsOf([ticket.organizationId]),
      this.namesOf([ticket.assignedToUserId]),
      this.subscriptions.findByOrganization(organizationId),
      ticket.createdByUserId ? this.users.findById(ticket.createdByUserId.toString()) : null,
      this.clientsOf([ticket.clientId]),
    ]);
    const client = ticket.clientId ? clients.get(ticket.clientId.toString()) : undefined;
    return {
      ...this.agentView(ticket, orgs, agents),
      context: { path: ticket.context?.path ?? '', userAgent: ticket.context?.userAgent ?? '', viewport: ticket.context?.viewport ?? '' },
      createdBy: { userId: ticket.createdByUserId?.toString() ?? null, name: ticket.createdByName, email: creator?.email ?? null, phone: creator?.phone ?? client?.phone ?? null },
      subscription: sub ? { planCode: sub.planCode, effectiveStatus: effectiveStatus(sub) } : null,
      messages: await Promise.all(messages.map((m) => this.messageView(m))),
    };
  }

  private agentView(t: SupportTicketDocument, orgs: Map<string, { id: string; name: string; slug: string; status: string }>, agents: Map<string, string>) {
    const assignee = t.assignedToUserId?.toString() ?? null;
    return {
      id: t.id as string,
      number: t.number,
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      status: t.status,
      organization: orgs.get(t.organizationId.toString()) ?? null,
      createdBy: { userId: t.createdByUserId?.toString() ?? null, name: t.createdByName },
      /** Lo abrió un cliente final del negocio (no su equipo). */
      fromClient: !!t.clientId,
      assignedTo: assignee ? { userId: assignee, name: agents.get(assignee) ?? 'Agente' } : null,
      lastMessageAt: t.lastMessageAt,
      lastMessagePreview: t.lastMessagePreview,
      lastMessageFrom: t.lastMessageFrom,
      unread: t.agentUnread,
      resolvedAt: t.resolvedAt,
      createdAt: t.createdAt,
    };
  }

  /* ---------- Común ---------- */

  private async messageView(m: SupportMessageDocument) {
    return {
      id: m.id as string,
      from: m.from,
      authorName: m.authorName,
      body: m.body,
      internal: m.internal,
      attachments: await Promise.all(m.attachments.map((key) => this.storage.url(key, ATTACHMENT_URL_TTL_SECONDS))),
      createdAt: m.createdAt,
    };
  }

  /** Solo se adjuntan archivos subidos para este mismo negocio. */
  private ownAttachments(organizationId: string, keys: string[] = []): string[] {
    if (keys.some((k) => !k.startsWith(`support/${organizationId}/`))) {
      throw Errors.badRequest('INVALID_ATTACHMENT', 'No se pudo adjuntar la captura. Súbela de nuevo.');
    }
    return keys;
  }

  private async nextNumber(): Promise<number> {
    const counter = await this.counters
      .findOneAndUpdate({ key: 'ticket' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' })
      .exec();
    return FIRST_NUMBER + counter!.value;
  }

  private async namesOf(ids: Array<Types.ObjectId | null>): Promise<Map<string, string>> {
    const wanted = ids.filter((id): id is Types.ObjectId => !!id);
    if (!wanted.length) return new Map();
    const users = await this.userModel.find({ _id: { $in: wanted } }).select('firstName lastName').exec();
    return new Map(users.map((u) => [u.id as string, fullName(u)]));
  }

  private async orgsOf(ids: Types.ObjectId[]) {
    const orgs = await this.organizations.find({ _id: { $in: ids } }).select('name slug status').exec();
    return new Map(orgs.map((o) => [o.id as string, { id: o.id as string, name: o.name, slug: o.slug, status: o.status as string }]));
  }

  /** Clientes finales de los tickets, con el celular al que se les avisa (el suyo o el de su responsable). */
  private async clientsOf(ids: Array<Types.ObjectId | null>): Promise<Map<string, ClientContact>> {
    const wanted = ids.filter((id): id is Types.ObjectId => !!id);
    if (!wanted.length) return new Map();
    const docs = await this.clients.find({ _id: { $in: wanted } }).select('firstName lastName phone guardianId').exec();
    const guardianIds = docs.filter((c) => !c.phone && c.guardianId).map((c) => c.guardianId!);
    const guardians = guardianIds.length ? await this.clients.find({ _id: { $in: guardianIds } }).select('phone').exec() : [];
    const guardianPhone = new Map(guardians.map((g) => [g.id as string, g.phone ?? null]));
    return new Map(
      docs.map((c) => [
        c.id as string,
        { id: c.id as string, name: fullName({ firstName: c.firstName, lastName: c.lastName ?? '' }), phone: c.phone ?? (c.guardianId ? (guardianPhone.get(c.guardianId.toString()) ?? null) : null) },
      ]),
    );
  }

  /**
   * Avisa a quien abrió el ticket de que le respondieron: por correo al miembro
   * del negocio, o por WhatsApp al cliente final con el enlace a su portal.
   */
  private async notifyRequester(ticket: SupportTicketDocument, excerpt: string): Promise<void> {
    if (ticket.clientId) {
      const [contact, org] = await Promise.all([this.clientsOf([ticket.clientId]), this.organizations.findById(ticket.organizationId).select('name slug').exec()]);
      const phone = contact.get(ticket.clientId.toString())?.phone;
      if (!phone || !org) return;
      const who = ticket.audience === 'business' ? org.name : 'El soporte de uBook';
      const url = this.mail.appUrl(`/reservar/${org.slug}/mi-cuenta?tab=ayuda&c=${ticket.id as string}`);
      await this.whatsapp.send({ to: phone, text: `${who} respondió tu consulta "${ticket.subject}". Léela aquí: ${url}` });
      return;
    }
    const creator = ticket.createdByUserId ? await this.users.findById(ticket.createdByUserId.toString()) : null;
    if (!creator?.isActive) return;
    await this.mail.send(
      supportTicketEmail({
        to: creator.email,
        firstName: creator.firstName,
        number: ticket.number,
        subject: ticket.subject,
        headline: 'Soporte de uBook te respondió',
        excerpt,
        url: this.mail.appUrl(`/soporte/${ticket.id as string}`),
        cta: 'Ver la respuesta',
      }),
    );
  }

  /**
   * Avisa a quien atiende un ticket de un cliente final: al equipo del negocio
   * (campana del panel) o al equipo de plataforma (correo), según el destino.
   */
  private async notifyAttendants(ticket: SupportTicketDocument, assignee: Types.ObjectId | null, title: string, summary: string, excerpt: string): Promise<void> {
    if (ticket.audience === 'business') {
      await this.notifications.notify({ type: 'client_inquiry', title, body: summary });
      return;
    }
    const org = await this.organizations.findById(ticket.organizationId).select('name').exec();
    await this.notifyAgents(ticket, assignee, `${title} de ${org?.name ?? 'un negocio'}: ${ticket.createdByName}`, excerpt);
  }

  /** Avisa por correo al agente a cargo o, si no hay, a todo el equipo de plataforma. */
  private async notifyAgents(ticket: SupportTicketDocument, assignee: Types.ObjectId | null, headline: string, excerpt: string): Promise<void> {
    const team = await this.users.activePlatformUsers();
    const assigned = assignee ? team.filter((u) => u._id.equals(assignee)) : [];
    const recipients = assigned.length ? assigned : team;
    await Promise.all(
      recipients.map((u) =>
        this.mail.send(
          supportTicketEmail({
            to: u.email,
            firstName: u.firstName,
            number: ticket.number,
            subject: ticket.subject,
            headline,
            excerpt,
            url: this.mail.appUrl(`/superadmin/soporte/${ticket.id as string}`),
            cta: 'Abrir el ticket',
          }),
        ),
      ),
    );
  }
}
