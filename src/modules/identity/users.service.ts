import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import * as argon2 from 'argon2';
import type { ClientSession, Model } from 'mongoose';
import { Errors } from '../../core/common/errors.js';
import type { PlatformRole } from '../../core/tenancy/tenant-context.js';
import { User, type UserDocument } from './schemas/user.schema.js';

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  password: string;
  platformRole?: PlatformRole | null;
}

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  findById(id: string): Promise<UserDocument | null> {
    return this.users.findById(id).exec();
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.users.findOne({ email: email.toLowerCase().trim() }).exec();
  }

  async create(input: CreateUserInput, session?: ClientSession): Promise<UserDocument> {
    if (await this.users.exists({ email: input.email.toLowerCase().trim() }).session(session ?? null)) {
      throw Errors.conflict('EMAIL_TAKEN', 'Ya existe una cuenta con este email. Inicia sesión.');
    }
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const [user] = await this.users.create(
      [
        {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          passwordHash,
          platformRole: input.platformRole ?? null,
        },
      ],
      { session },
    );
    return user;
  }

  /** Devuelve el usuario si email y contraseña son correctos y la cuenta está activa. */
  async verifyCredentials(email: string, password: string): Promise<UserDocument | null> {
    const user = await this.users
      .findOne({ email: email.toLowerCase().trim() })
      .select('+passwordHash')
      .exec();
    if (!user?.passwordHash || !user.isActive) {
      // Mismo costo que una verificación real, para no revelar si el email existe.
      await argon2.hash(password, { type: argon2.argon2id });
      return null;
    }
    return (await argon2.verify(user.passwordHash, password)) ? user : null;
  }

  async setPassword(userId: string, password: string): Promise<void> {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await this.users.updateOne({ _id: userId }, { passwordHash }).exec();
  }

  async touchLogin(userId: string): Promise<void> {
    await this.users.updateOne({ _id: userId }, { lastLoginAt: new Date() }).exec();
  }

  hasSuperAdmin(): Promise<boolean> {
    return this.users.exists({ platformRole: 'super_admin' }).then(Boolean);
  }
}
