import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Error de dominio con código estable para el frontend y mensaje legible.
 * Respuesta: `{ statusCode, code, message, details? }`.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ statusCode: status, code, message, ...(details && { details }) }, status);
  }
}

export const Errors = {
  unauthorized: (message = 'No autenticado') =>
    new AppError(HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', message),
  invalidCredentials: () =>
    new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Email o contraseña incorrectos'),
  forbidden: (message = 'No tienes permiso para realizar esta acción') =>
    new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message),
  wrongContext: () =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'WRONG_CONTEXT',
      'Esta acción no está disponible en tu sesión actual',
    ),
  featureNotInPlan: (feature: string) =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'FEATURE_NOT_IN_PLAN',
      'Tu plan no incluye esta funcionalidad',
      { feature },
    ),
  planLimitReached: (feature: string, limit: number) =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'PLAN_LIMIT_REACHED',
      'Alcanzaste el límite de tu plan',
      { feature, limit },
    ),
  subscriptionReadOnly: () =>
    new AppError(
      HttpStatus.PAYMENT_REQUIRED,
      'SUBSCRIPTION_INACTIVE',
      'Tu suscripción no está activa. Puedes consultar tus datos pero no modificarlos.',
    ),
  organizationSuspended: () =>
    new AppError(HttpStatus.FORBIDDEN, 'ORGANIZATION_SUSPENDED', 'El negocio está suspendido'),
  notFound: (entity: string) =>
    new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${entity} no encontrado`),
  conflict: (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message),
  badRequest: (code: string, message: string, details?: Record<string, unknown>) =>
    new AppError(HttpStatus.BAD_REQUEST, code, message, details),
};
