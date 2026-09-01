import bcrypt from "bcryptjs";
import { randomInt } from "crypto";

const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateOTP(length = 6): string {
  const digits = "0123456789";
  let otp = "";
  for (let i = 0; i < length; i++) {
    // crypto.randomInt is CSPRNG-backed; Math.random() is predictable and
    // unsafe for anything used as a security token (password-reset codes).
    otp += digits[randomInt(0, digits.length)];
  }
  return otp;
}
