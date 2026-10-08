import { Injectable, type PipeTransform } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Errors } from './errors.js';

@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isValidObjectId(value) || !/^[a-f0-9]{24}$/i.test(value)) {
      throw Errors.badRequest('INVALID_ID', 'Identificador inválido');
    }
    return value;
  }
}
