import { Injectable, type PipeTransform } from '@nestjs/common';

/**
 * Elimina las propiedades `undefined` de los DTO ya transformados.
 *
 * Las clases DTO declaran todos sus campos, así que class-transformer crea
 * propiedades `undefined` para los que no llegaron. Pasadas a `doc.set(dto)`,
 * Mongoose las interpreta como "borrar el campo" y una edición parcial
 * eliminaría datos. Con este pipe, lo que no se envía no se toca.
 */
@Injectable()
export class StripUndefinedPipe implements PipeTransform {
  transform(value: unknown): unknown {
    return strip(value);
  }
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(strip);
  } else if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) delete (value as Record<string, unknown>)[key];
      else strip(child);
    }
  }
  return value;
}
