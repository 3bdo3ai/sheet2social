import { randomInt } from "node:crypto";

const KEY_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%*+-_";
export const LICENSE_KEY_LENGTH = 24;

export function generateLicenseKey(length = LICENSE_KEY_LENGTH): string {
  let output = "";

  for (let index = 0; index < length; index += 1) {
    output += KEY_CHARSET[randomInt(0, KEY_CHARSET.length)];
  }

  return output;
}

export function isLicenseKeyFormatValid(value: string): boolean {
  return /^[!-~]{24}$/.test(value);
}
