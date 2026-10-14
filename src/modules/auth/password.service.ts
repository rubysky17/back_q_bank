import { Injectable, OnModuleInit } from '@nestjs/common';
import { argon2id, hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';

@Injectable()
export class PasswordService implements OnModuleInit {
  /** Verified against when the email is unknown, so response time does not reveal which accounts exist. */
  private dummyHash = '';

  async onModuleInit() {
    this.dummyHash = await this.hash(randomBytes(16).toString('hex'));
  }

  hash(password: string) {
    return hash(password, { type: argon2id });
  }

  async verify(passwordHash: string, password: string) {
    try {
      return await verify(passwordHash, password);
    } catch {
      return false;
    }
  }

  async burnTime(password: string) {
    await this.verify(this.dummyHash, password);
  }
}
